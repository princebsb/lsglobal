import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, posix, relative, resolve } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { EgressStatus, type WebhookEvent } from 'livekit-server-sdk';
import { AuditService } from '../../audit/audit.service';
import { AuthzService } from '../../authz/authz.service';
import { conflict, forbidden, notFound, type ReqCtx } from '../../common/http';
import { env } from '../../config/env';
import { DbService, type Q } from '../../db/db.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { AssembliesService, type AssemblyRow } from '../assemblies/assemblies.service';
import { LivekitService, type MediaGrant } from './livekit.service';

/** Estados em que a sala de transmissão pode ser usada. */
const STAFF_STATES = ['called', 'accreditation', 'in_progress', 'suspended'];
const ATTENDEE_STATES = ['accreditation', 'in_progress', 'suspended'];
const RECORDING_STATES = ['accreditation', 'in_progress', 'suspended'];

export const roomNameFor = (assemblyId: string) => `lsg_${assemblyId}`;
export const personIdentity = (personId: string) => `p:${personId}`;
const staffIdentity = (userId: string) => `staff:${userId}`;

export type MediaRole = 'staff' | 'attendee' | 'observer';

@Injectable()
export class MediaService {
  private readonly logger = new Logger('Media');

  constructor(
    private readonly db: DbService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly assemblies: AssembliesService,
    private readonly lk: LivekitService,
    private readonly rt: RealtimeGateway,
  ) {}

  isStaff(ctx: ReqCtx, a: AssemblyRow) {
    return this.authz.has(ctx, 'assembly.conduct', a.condominium_id) || this.authz.has(ctx, 'tech.operate', a.condominium_id);
  }

  async ensureRoom(q: Q, ctx: ReqCtx, a: AssemblyRow): Promise<string> {
    const name = roomNameFor(a.id);
    await q.exec(
      `insert into media_rooms (tenant_id, assembly_id, room_name) values ($1,$2,$3) on conflict (assembly_id) do nothing`,
      [ctx.tenantId, a.id, name],
    );
    return name;
  }

  /** Pessoa vinculada ao usuário com credenciamento ativo nesta assembleia (participante remoto). */
  async accreditedPerson(q: Q, ctx: ReqCtx, assemblyId: string) {
    return q.maybe<{ person_id: string; name: string; units: string[] }>(
      `select p.id as person_id, p.name, array_agg(concat_ws(' - ', b.name, u.identifier) order by u.identifier) as units
         from people p
         join accreditations x on x.person_id = p.id and x.assembly_id = $2 and x.revoked_at is null
         join units u on u.id = x.unit_id left join buildings b on b.id = u.building_id
        where p.user_id = $1 and p.status = 'active'
        group by p.id, p.name`,
      [ctx.auth.userId, assemblyId],
    );
  }

  /** Emite token de acesso à sala conforme o papel do usuário na assembleia. */
  async issueToken(q: Q, ctx: ReqCtx, a: AssemblyRow) {
    let role: MediaRole;
    let identity: string;
    let name: string;
    let grant: MediaGrant;
    let metadata: Record<string, unknown>;
    const user = await q.one<{ full_name: string }>('select full_name from users where id = $1', [ctx.auth.userId]);

    if (this.isStaff(ctx, a)) {
      if (!STAFF_STATES.includes(a.status)) throw conflict('Sala de transmissão indisponível neste estado da assembleia', 'MEDIA_INVALID_STATE');
      role = 'staff';
      identity = staffIdentity(ctx.auth.userId);
      name = `${user.full_name} (mesa)`;
      grant = { canPublish: true, canPublishData: true, sources: ['camera', 'microphone', 'screen_share', 'screen_share_audio'], roomAdmin: this.authz.has(ctx, 'tech.operate', a.condominium_id) };
      metadata = { role };
    } else {
      const person = this.authz.has(ctx, 'assembly.attend', a.condominium_id) ? await this.accreditedPerson(q, ctx, a.id) : undefined;
      if (person) {
        if (!ATTENDEE_STATES.includes(a.status)) throw conflict('A transmissão abre com o credenciamento', 'MEDIA_INVALID_STATE');
        const floor = await q.maybe(`select 1 from floor_requests where assembly_id = $1 and person_id = $2 and status = 'granted'`, [a.id, person.person_id]);
        role = 'attendee';
        identity = personIdentity(person.person_id);
        name = person.name;
        grant = floor ? { canPublish: true, canPublishData: false, sources: ['microphone', 'camera'] } : { canPublish: false, canPublishData: false };
        metadata = { role, units: person.units };
      } else if (this.authz.has(ctx, 'audit.view', a.condominium_id)) {
        if (!ATTENDEE_STATES.includes(a.status)) throw conflict('A transmissão abre com o credenciamento', 'MEDIA_INVALID_STATE');
        role = 'observer';
        identity = `obs:${ctx.auth.userId}`;
        name = `${user.full_name} (fiscal)`;
        grant = { canPublish: false, canPublishData: false };
        metadata = { role };
      } else {
        throw forbidden('O acesso à transmissão exige credenciamento ativo nesta assembleia');
      }
    }
    const room = await this.ensureRoom(q, ctx, a);
    const token = await this.lk.token(room, identity, name, grant, metadata);
    return { url: this.lk.publicUrl(), token, room, identity, role, canPublish: grant.canPublish };
  }

  // -------------------------------------------------------------------------
  // Palavra
  // -------------------------------------------------------------------------

  async requestFloor(q: Q, ctx: ReqCtx, a: AssemblyRow, topic?: string) {
    if (a.status !== 'in_progress') throw conflict('Pedidos de palavra só durante a sessão em andamento', 'MEDIA_INVALID_STATE');
    const person = await this.accreditedPerson(q, ctx, a.id);
    if (!person) throw forbidden('Pedir a palavra exige credenciamento ativo nesta assembleia');
    const existing = await q.maybe(`select 1 from floor_requests where assembly_id = $1 and person_id = $2 and status in ('waiting','granted')`, [a.id, person.person_id]);
    if (existing) throw conflict('Você já está na fila ou com a palavra', 'FLOOR_ALREADY_REQUESTED');
    const r = await q.one<{ id: string }>(
      `insert into floor_requests (tenant_id, assembly_id, person_id, user_id, topic) values ($1,$2,$3,$4,$5) returning id`,
      [ctx.tenantId, a.id, person.person_id, ctx.auth.userId, topic ?? null],
    );
    await this.assemblies.timeline(q, ctx, a.id, 'floor.requested', r.id, { person: person.name });
    q.afterCommit(() => this.rt.emitAssembly(ctx.tenantId!, a.id, 'media.changed'));
    return { id: r.id };
  }

  async cancelFloor(q: Q, ctx: ReqCtx, floorId: string) {
    const f = await q.maybe<{ assembly_id: string; user_id: string; status: string }>(
      'select assembly_id, user_id, status from floor_requests where id = $1 for update', [floorId]);
    if (!f || f.user_id !== ctx.auth.userId) throw notFound('Pedido de palavra');
    if (f.status !== 'waiting') throw conflict('Somente pedidos em espera podem ser cancelados');
    await q.exec(`update floor_requests set status = 'cancelled', ended_at = clock_timestamp(), ended_by = $2 where id = $1`, [floorId, ctx.auth.userId]);
    q.afterCommit(() => this.rt.emitAssembly(ctx.tenantId!, f.assembly_id, 'media.changed'));
    return { ok: true };
  }

  /** Decisão da mesa: conceder, negar ou encerrar a palavra. Aplica a permissão de publicação na sala. */
  async decideFloor(q: Q, ctx: ReqCtx, floorId: string, decision: 'grant' | 'deny' | 'end', maxSeconds?: number, reason?: string) {
    const f = await q.maybe<{ assembly_id: string; person_id: string; status: string }>(
      'select assembly_id, person_id, status from floor_requests where id = $1 for update', [floorId]);
    if (!f) throw notFound('Pedido de palavra');
    const a = await this.assemblies.load(q, f.assembly_id);
    this.authz.require(ctx, 'assembly.conduct', a.condominium_id);
    const person = await q.one<{ name: string }>('select name from people where id = $1', [f.person_id]);

    if (decision === 'grant') {
      if (f.status !== 'waiting') throw conflict('O pedido não está em espera');
      if (a.status !== 'in_progress') throw conflict('A sessão não está em andamento', 'MEDIA_INVALID_STATE');
      const speaking = await q.maybe(`select 1 from floor_requests where assembly_id = $1 and status = 'granted'`, [a.id]);
      if (speaking) throw conflict('Há um participante com a palavra. Encerre-a antes de conceder outra.', 'FLOOR_BUSY');
      await q.exec(
        `update floor_requests set status = 'granted', granted_at = clock_timestamp(), granted_by = $2, max_seconds = $3 where id = $1`,
        [floorId, ctx.auth.userId, maxSeconds ?? null],
      );
    } else if (decision === 'deny') {
      if (f.status !== 'waiting') throw conflict('O pedido não está em espera');
      await q.exec(`update floor_requests set status = 'denied', ended_at = clock_timestamp(), ended_by = $2, end_reason = $3 where id = $1`, [floorId, ctx.auth.userId, reason ?? null]);
    } else {
      if (f.status !== 'granted') throw conflict('O participante não está com a palavra');
      await q.exec(`update floor_requests set status = 'done', ended_at = clock_timestamp(), ended_by = $2, end_reason = $3 where id = $1`, [floorId, ctx.auth.userId, reason ?? null]);
    }
    const kind = { grant: 'floor.granted', deny: 'floor.denied', end: 'floor.ended' }[decision];
    await this.assemblies.timeline(q, ctx, a.id, kind, floorId, { person: person.name, maxSeconds, reason });
    await this.audit.record(q, ctx, { action: kind, resourceType: 'floor_request', resourceId: floorId, assemblyId: a.id, metadata: { maxSeconds, reason } });

    // Aplica na sala (melhor esforço; o próximo token emitido já reflete a decisão).
    let applied: boolean | null = null;
    if (decision !== 'deny' && this.lk.configured()) {
      applied = await this.lk.setPublish(roomNameFor(a.id), personIdentity(f.person_id), decision === 'grant');
    }
    q.afterCommit(() => this.rt.emitAssembly(ctx.tenantId!, a.id, 'media.changed', { floorId, decision }));
    return { ok: true, appliedToRoom: applied };
  }

  // -------------------------------------------------------------------------
  // Gravação
  // -------------------------------------------------------------------------

  async startRecording(q: Q, ctx: ReqCtx, a: AssemblyRow) {
    if (!RECORDING_STATES.includes(a.status)) throw conflict('Gravação disponível a partir do credenciamento', 'MEDIA_INVALID_STATE');
    const active = await q.maybe(`select 1 from recordings where assembly_id = $1 and status in ('starting','active','ending')`, [a.id]);
    if (active) throw conflict('Já existe gravação em andamento', 'RECORDING_ACTIVE');
    const room = await this.ensureRoom(q, ctx, a);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rel = [ctx.tenantId!, a.id, `${a.code.replace(/[^\w.-]/g, '_')}_${stamp}.mp4`];
    const filepath = join(resolve(env().RECORDINGS_DIR), ...rel);
    // O Egress pode rodar em outro sistema (ex.: WSL2): recebe o caminho como ele o enxerga.
    const egressDir = env().EGRESS_RECORDINGS_DIR;
    const egressPath = egressDir ? posix.join(egressDir, ...rel) : filepath;
    const egressId = await this.lk.startRecording(room, egressPath);
    const session = await this.assemblies.openSession(q, a.id);
    const r = await q.one<{ id: string }>(
      `insert into recordings (tenant_id, assembly_id, session_id, egress_id, requested_by, file_path) values ($1,$2,$3,$4,$5,$6) returning id`,
      [ctx.tenantId, a.id, session?.id ?? null, egressId, ctx.auth.userId, filepath],
    );
    await this.assemblies.timeline(q, ctx, a.id, 'recording.requested', r.id, { egressId });
    await this.audit.record(q, ctx, { action: 'recording.requested', resourceType: 'recording', resourceId: r.id, assemblyId: a.id, metadata: { egressId } });
    q.afterCommit(() => this.rt.emitAssembly(ctx.tenantId!, a.id, 'media.changed'));
    return { id: r.id, egressId, status: 'starting' };
  }

  async stopRecording(q: Q, ctx: ReqCtx, recordingId: string) {
    const r = await q.maybe<{ assembly_id: string; egress_id: string; status: string }>(
      'select assembly_id, egress_id, status from recordings where id = $1 for update', [recordingId]);
    if (!r) throw notFound('Gravação');
    const a = await this.assemblies.load(q, r.assembly_id);
    if (!this.isStaff(ctx, a)) throw forbidden();
    if (!['starting', 'active'].includes(r.status)) throw conflict('A gravação não está em andamento');
    await this.lk.stopRecording(r.egress_id);
    await q.exec(`update recordings set status = 'ending', stop_requested_by = $2 where id = $1`, [recordingId, ctx.auth.userId]);
    await this.audit.record(q, ctx, { action: 'recording.stop_requested', resourceType: 'recording', resourceId: recordingId, assemblyId: a.id });
    q.afterCommit(() => this.rt.emitAssembly(ctx.tenantId!, a.id, 'media.changed'));
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Webhooks do LiveKit
  // -------------------------------------------------------------------------

  async handleWebhook(ev: WebhookEvent): Promise<{ ok: boolean; ignored?: string }> {
    const roomName = ev.room?.name ?? ev.egressInfo?.roomName ?? '';
    if (!ev.id || !roomName.startsWith('lsg_')) return { ok: true, ignored: 'sala desconhecida' };
    const ref = await this.db.tx({}, (q) => q.maybe<{ tenant_id: string; assembly_id: string }>('select * from media_room_lookup($1)', [roomName]));
    if (!ref) return { ok: true, ignored: 'sala não registrada' };
    const sysCtx = { tenantId: ref.tenant_id, userId: null };

    const result = await this.db.tx(sysCtx, async (q) => {
      const ins = await q.exec(
        `insert into media_webhook_events (event_id, tenant_id, assembly_id, event, payload) values ($1,$2,$3,$4,$5) on conflict (event_id) do nothing`,
        [ev.id, ref.tenant_id, ref.assembly_id, ev.event, JSON.stringify(this.safePayload(ev))],
      );
      if (ins === 0) return { ok: true, ignored: 'evento duplicado' };
      const tl = (kind: string, refId: string | null, payload: Record<string, unknown>) =>
        q.exec(
          `insert into assembly_timeline_events (tenant_id, assembly_id, session_id, kind, ref_id, payload)
           values ($1,$2,(select id from assembly_sessions where assembly_id = $2 and ended_at is null),$3,$4,$5)`,
          [ref.tenant_id, ref.assembly_id, kind, refId, JSON.stringify(payload)],
        );

      switch (ev.event) {
        case 'room_started':
          await q.exec(`update media_rooms set status = 'live', livekit_sid = $2, started_at = clock_timestamp(), ended_at = null where assembly_id = $1`, [ref.assembly_id, ev.room?.sid ?? null]);
          await tl('media.room_started', null, {});
          break;
        case 'room_finished':
          await q.exec(`update media_rooms set status = 'ended', ended_at = clock_timestamp() where assembly_id = $1`, [ref.assembly_id]);
          await tl('media.room_finished', null, {});
          break;
        case 'participant_joined':
        case 'participant_left': {
          const identity = ev.participant?.identity ?? '';
          if (identity.startsWith('p:')) {
            await q.exec(
              `insert into attendance_events (tenant_id, assembly_id, person_id, event, mode) values ($1,$2,$3,$4,'remoto')`,
              [ref.tenant_id, ref.assembly_id, identity.slice(2), ev.event === 'participant_joined' ? 'connect' : 'disconnect'],
            );
          }
          break;
        }
        case 'egress_started':
        case 'egress_updated':
        case 'egress_ended':
          return this.onEgress(q, ref, ev, tl);
      }
      return { ok: true };
    });
    this.rt.emitAssembly(ref.tenant_id, ref.assembly_id, 'media.changed');
    return result;
  }

  private async onEgress(q: Q, ref: { tenant_id: string; assembly_id: string }, ev: WebhookEvent, tl: (k: string, id: string | null, p: Record<string, unknown>) => Promise<number>) {
    const info = ev.egressInfo!;
    const rec = await q.maybe<{ id: string; status: string; file_path: string | null }>(
      'select id, status, file_path from recordings where egress_id = $1 for update', [info.egressId]);
    if (!rec || ['complete', 'failed'].includes(rec.status)) return { ok: true, ignored: 'gravação desconhecida ou finalizada' };
    const startedAt = info.startedAt ? new Date(Number(info.startedAt / 1_000_000n)) : null;
    const endedAt = info.endedAt ? new Date(Number(info.endedAt / 1_000_000n)) : null;

    if (info.status === EgressStatus.EGRESS_ACTIVE && rec.status === 'starting') {
      await q.exec(`update recordings set status = 'active', started_at = coalesce($2, clock_timestamp()) where id = $1`, [rec.id, startedAt]);
      await tl('recording.started', rec.id, { egressId: info.egressId, serverStartedAt: startedAt?.toISOString() });
      return { ok: true };
    }
    if (info.status === EgressStatus.EGRESS_COMPLETE) {
      const file = info.fileResults?.[0];
      const path = this.toLocalPath(file?.filename) || rec.file_path;
      const integrity = path ? await this.hashLocalFile(path) : null;
      await q.exec(
        `update recordings set status = 'complete', ended_at = coalesce($2, clock_timestamp()), started_at = coalesce(started_at, $3),
                file_path = $4, file_size = $5, duration_ms = $6, sha256 = $7, error = $8 where id = $1`,
        [rec.id, endedAt, startedAt, path, file?.size ? Number(file.size) : integrity?.size ?? null,
         file?.duration ? Number(file.duration / 1_000_000n) : null, integrity?.sha256 ?? null,
         integrity ? null : 'Arquivo não acessível pela API para cálculo do SHA-256'],
      );
      await tl('recording.ended', rec.id, { egressId: info.egressId, sha256: integrity?.sha256 ?? null });
      return { ok: true };
    }
    if ([EgressStatus.EGRESS_FAILED, EgressStatus.EGRESS_ABORTED, EgressStatus.EGRESS_LIMIT_REACHED].includes(info.status)) {
      await q.exec(`update recordings set status = 'failed', ended_at = coalesce($2, clock_timestamp()), error = $3 where id = $1`,
        [rec.id, endedAt, info.error || EgressStatus[info.status]]);
      await tl('recording.failed', rec.id, { egressId: info.egressId, error: info.error || EgressStatus[info.status] });
      this.rt.emitAssembly(ref.tenant_id, ref.assembly_id, 'media.alert', { kind: 'recording.failed', message: 'A gravação falhou. Inicie uma nova gravação.' });
      return { ok: true };
    }
    return { ok: true };
  }

  /** Converte o caminho informado pelo Egress (ex.: /mnt/d/...) para o caminho local da API. */
  toLocalPath(egressPath?: string | null): string | null {
    if (!egressPath) return null;
    const egressDir = env().EGRESS_RECORDINGS_DIR;
    if (!egressDir || !egressPath.startsWith(egressDir)) return egressPath;
    const rel = egressPath.slice(egressDir.length).split('/').filter(Boolean);
    return join(resolve(env().RECORDINGS_DIR), ...rel);
  }

  /** SHA-256 do arquivo gravado, somente se estiver dentro de RECORDINGS_DIR. */
  async hashLocalFile(path: string): Promise<{ sha256: string; size: number } | null> {
    const base = resolve(env().RECORDINGS_DIR);
    const full = resolve(path);
    const rel = relative(base, full);
    if (rel.startsWith('..') || isAbsolute(rel) || !existsSync(full)) return null;
    const size = (await stat(full)).size;
    const sha256 = await new Promise<string>((ok, fail) => {
      const h = createHash('sha256');
      createReadStream(full).on('data', (c) => h.update(c)).on('end', () => ok(h.digest('hex'))).on('error', fail);
    });
    return { sha256, size };
  }

  private safePayload(ev: WebhookEvent) {
    return {
      event: ev.event,
      createdAt: ev.createdAt ? Number(ev.createdAt) : null,
      room: ev.room ? { sid: ev.room.sid, name: ev.room.name, numParticipants: ev.room.numParticipants } : undefined,
      participant: ev.participant ? { identity: ev.participant.identity, sid: ev.participant.sid } : undefined,
      egress: ev.egressInfo ? { egressId: ev.egressInfo.egressId, status: EgressStatus[ev.egressInfo.status], error: ev.egressInfo.error || undefined } : undefined,
    };
  }

  // -------------------------------------------------------------------------
  // Consulta
  // -------------------------------------------------------------------------

  async overview(q: Q, ctx: ReqCtx, a: AssemblyRow) {
    const staff = this.isStaff(ctx, a);
    const room = await q.maybe('select room_name, status, started_at, ended_at from media_rooms where assembly_id = $1', [a.id]);
    const queue = await q.rows(
      `select f.id, f.status, f.topic, f.requested_at, f.granted_at, f.max_seconds, f.ended_at, p.name as person_name, f.person_id,
              (f.user_id = $2) as mine
         from floor_requests f join people p on p.id = f.person_id
        where f.assembly_id = $1 and (f.status in ('waiting','granted') or f.ended_at > now() - interval '30 minutes')
        order by case f.status when 'granted' then 0 when 'waiting' then 1 else 2 end, f.requested_at`,
      [a.id, ctx.auth.userId],
    );
    const recordings = staff || this.authz.has(ctx, 'audit.view', a.condominium_id)
      ? await q.rows(
          `select r.id, r.status, r.requested_at, r.started_at, r.ended_at, r.file_size, r.duration_ms, r.sha256, r.error, u.full_name as requested_by_name
             from recordings r left join users u on u.id = r.requested_by where r.assembly_id = $1 order by r.requested_at desc`,
          [a.id])
      : [];
    const participants = staff && this.lk.configured() && room ? await this.lk.listParticipants(roomNameFor(a.id)) : null;
    return {
      configured: this.lk.configured(),
      egressEnabled: this.lk.egressEnabled(),
      room: room ?? null,
      // participantes só veem a própria posição; a mesa vê a fila completa
      floor: staff ? queue : queue.filter((x) => x.mine || x.status === 'granted').map((x) => (x.mine ? x : { ...x, person_id: undefined })),
      recordings,
      participants,
      isStaff: staff,
    };
  }
}
