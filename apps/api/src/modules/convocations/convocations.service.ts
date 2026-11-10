import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { maskEmail, type AssemblyStatus } from '@lsg/shared';
import { AuditService } from '../../audit/audit.service';
import { conflict, notFound, unprocessable, type ReqCtx } from '../../common/http';
import { CryptoService } from '../../common/crypto.service';
import { env } from '../../config/env';
import { DbService, type Q } from '../../db/db.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { AssembliesService, type AssemblyRow } from '../assemblies/assemblies.service';
import { MailService } from './mail.service';

/** Estados em que o edital pode ser redigido. */
export const CONVOCATION_DRAFT_STATUSES: readonly AssemblyStatus[] = ['draft', 'in_review', 'approved_for_call', 'called'];
/** Estados em que o edital pode ser publicado (1ª publicação ou retificação). */
export const CONVOCATION_PUBLISH_STATUSES: readonly AssemblyStatus[] = ['approved_for_call', 'called'];

export interface ConvocationSnapshot {
  assembly: { code: string; title: string; kind: string; modality: string; timezone: string; location: string | null; firstCallAt: string; secondCallAt: string | null };
  condominium: { name: string };
  agenda: { position: number; title: string; description: string | null; itemType: string }[];
}

const RETRY_DELAYS_S = [60, 300, 900, 3600];

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function fmtDate(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'full', timeStyle: 'short', timeZone: tz }).format(new Date(iso));
}

/** Serialização canônica (chaves ordenadas) para hash estável. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

@Injectable()
export class ConvocationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Convocations');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly assemblies: AssembliesService,
    private readonly mail: MailService,
    private readonly rt: RealtimeGateway,
  ) {}

  onModuleInit(): void {
    const e = env();
    if (e.OUTBOX_WORKER && e.NODE_ENV !== 'test') {
      this.timer = setInterval(() => void this.runOnce().catch((err) => this.logger.error(err)), e.OUTBOX_INTERVAL_MS);
      this.timer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async snapshot(q: Q, a: AssemblyRow): Promise<ConvocationSnapshot> {
    const condo = await q.one<{ name: string }>('select name from condominiums where id = $1', [a.condominium_id]);
    const agenda = await q.rows<{ position: number; title: string; description: string | null; item_type: string }>(
      'select position, title, description, item_type from agenda_items where assembly_id = $1 order by position',
      [a.id],
    );
    const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
    return {
      assembly: {
        code: a.code, title: a.title, kind: a.kind, modality: a.modality, timezone: a.timezone, location: a.location ?? null,
        firstCallAt: iso(a.first_call_at)!, secondCallAt: iso(a.second_call_at),
      },
      condominium: { name: condo.name },
      agenda: agenda.map((i) => ({ position: i.position, title: i.title, description: i.description, itemType: i.item_type })),
    };
  }

  /** Alertas não bloqueantes de prazo (o prazo legal depende da convenção). */
  async leadTimeWarnings(q: Q, a: AssemblyRow): Promise<string[]> {
    const c = await q.one<{ settings: Record<string, unknown> }>('select settings from condominiums where id = $1', [a.condominium_id]);
    const minDays = Number(c.settings?.convocationMinDays);
    const daysAhead = (new Date(a.first_call_at).getTime() - Date.now()) / 86_400_000;
    const w: string[] = [];
    if (!Number.isFinite(minDays) || minDays <= 0) {
      w.push('Prazo mínimo de antecedência não parametrizado no condomínio (settings.convocationMinDays). Confira a convenção.');
    } else if (daysAhead < minDays) {
      w.push(`A 1ª convocação ocorre em ${daysAhead.toFixed(1)} dia(s); a convenção parametrizada exige ${minDays} dia(s) de antecedência.`);
    }
    if (daysAhead < 0) w.push('A data da 1ª convocação já passou.');
    return w;
  }

  /**
   * Publica o edital: congela conteúdo + snapshot (hash SHA-256), deriva destinatários dos
   * titulares ativos das unidades e enfileira os envios. Retificação substitui a versão anterior.
   */
  async publish(q: Q, ctx: ReqCtx, a: AssemblyRow, rectificationReason?: string) {
    if (!CONVOCATION_PUBLISH_STATUSES.includes(a.status)) {
      throw conflict('O edital só pode ser publicado com a assembleia aprovada para convocação ou já convocada', 'INVALID_STATE');
    }
    const draft = await q.maybe<{ id: string; version: number; subject: string; body: string }>(
      `select id, version, subject, body from convocations where assembly_id = $1 and status = 'draft' for update`, [a.id]);
    if (!draft) throw unprocessable('Não há rascunho de edital para publicar', 'NO_DRAFT');
    const current = await q.maybe<{ id: string; version: number }>(
      `select id, version from convocations where assembly_id = $1 and status = 'published' for update`, [a.id]);
    if (current && !rectificationReason) {
      throw unprocessable('Já existe edital publicado. Informe o motivo da retificação.', 'RECTIFICATION_REASON_REQUIRED');
    }
    const items = await q.one<{ n: number }>('select count(*)::int as n from agenda_items where assembly_id = $1', [a.id]);
    if (items.n === 0) throw unprocessable('A pauta não possui itens');

    const snapshot = await this.snapshot(q, a);
    const contentSha256 = this.crypto.sha256(canonicalJson({ subject: draft.subject, body: draft.body, snapshot }));
    if (current) {
      await q.exec(`update convocations set status = 'superseded' where id = $1`, [current.id]);
    }
    await q.exec(
      `update convocations set status = 'published', snapshot = $2, content_sha256 = $3, published_at = clock_timestamp(),
              published_by = $4, rectification_reason = $5 where id = $1`,
      [draft.id, JSON.stringify(snapshot), contentSha256, ctx.auth.userId, rectificationReason ?? null],
    );

    // Destinatários: todos os titulares com vínculo ativo de unidades ativas (não só o representante votante).
    const owners = await q.rows<{ unit_id: string; person_id: string; relation: string; email: string | null }>(
      `select o.unit_id, o.person_id, o.relation, p.email::text as email
         from unit_ownerships o join units u on u.id = o.unit_id join people p on p.id = o.person_id
        where u.condominium_id = $1 and u.status = 'active' and o.ended_at is null and p.status = 'active'
        order by u.identifier, p.name`,
      [a.condominium_id],
    );
    let queued = 0;
    let withoutAddress = 0;
    for (const o of owners) {
      const token = this.crypto.randomToken(24);
      const channel = o.email ? 'email' : 'none';
      const r = await q.one<{ id: string }>(
        `insert into convocation_recipients (tenant_id, convocation_id, unit_id, person_id, relation, channel, address, address_masked, link_token_hash, link_token_enc)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
        [ctx.tenantId, draft.id, o.unit_id, o.person_id, o.relation, channel, o.email, o.email ? maskEmail(o.email) : null,
         this.crypto.sha256(token), this.crypto.encrypt(token)],
      );
      if (o.email) {
        await this.enqueue(q, ctx.tenantId!, r.id);
        queued++;
      } else {
        await q.exec(
          `insert into convocation_delivery_events (tenant_id, recipient_id, event) values ($1,$2,'skipped_no_address')`,
          [ctx.tenantId, r.id],
        );
        withoutAddress++;
      }
    }
    if (a.status === 'approved_for_call') {
      await this.assemblies.transition(q, ctx, a.id, 'called', `Edital v${draft.version} publicado`);
    }
    await this.assemblies.timeline(q, ctx, a.id, current ? 'convocation.rectified' : 'convocation.published', draft.id, {
      version: draft.version, contentSha256, recipients: owners.length, queued, withoutAddress, rectificationReason,
    });
    await this.audit.record(q, ctx, {
      action: current ? 'convocation.rectified' : 'convocation.published', resourceType: 'convocation', resourceId: draft.id, assemblyId: a.id,
      after: { version: draft.version, contentSha256, recipients: owners.length, queued, withoutAddress },
      metadata: { rectificationReason, supersedes: current?.id },
    });
    q.afterCommit(() => this.rt.emitAssembly(ctx.tenantId!, a.id, 'convocation.changed'));
    return { id: draft.id, version: draft.version, contentSha256, recipients: owners.length, queued, withoutAddress };
  }

  async enqueue(q: Q, tenantId: string, recipientId: string) {
    const d = await q.one<{ id: string }>(
      `insert into convocation_deliveries (tenant_id, recipient_id, channel) values ($1,$2,'email') returning id`,
      [tenantId, recipientId],
    );
    await q.exec(`insert into convocation_delivery_events (tenant_id, recipient_id, delivery_id, event) values ($1,$2,$3,'queued')`, [tenantId, recipientId, d.id]);
    return d.id;
  }

  /** Reenvio individual do mesmo link pessoal (nova entrega na fila). */
  async resend(q: Q, ctx: ReqCtx, convocationId: string, recipientId: string) {
    const r = await q.maybe<{ id: string; channel: string; status: string; assembly_id: string }>(
      `select r.id, r.channel, c.status, c.assembly_id from convocation_recipients r join convocations c on c.id = r.convocation_id
        where r.id = $1 and r.convocation_id = $2`, [recipientId, convocationId]);
    if (!r) throw notFound('Destinatário');
    if (r.status !== 'published') throw conflict('Só é possível reenviar o edital vigente', 'NOT_CURRENT');
    if (r.channel !== 'email') throw unprocessable('Destinatário sem endereço eletrônico cadastrado', 'NO_ADDRESS');
    const pending = await q.maybe(`select 1 from convocation_deliveries where recipient_id = $1 and status in ('queued','sending')`, [recipientId]);
    if (pending) throw conflict('Já existe envio em andamento para este destinatário', 'DELIVERY_PENDING');
    await q.exec(
      `insert into convocation_delivery_events (tenant_id, recipient_id, event, detail) values ($1,$2,'resend_requested',$3)`,
      [ctx.tenantId, recipientId, JSON.stringify({ by: ctx.auth.userId })],
    );
    const id = await this.enqueue(q, ctx.tenantId!, recipientId);
    await this.audit.record(q, ctx, { action: 'convocation.resend', resourceType: 'convocation_recipient', resourceId: recipientId, assemblyId: r.assembly_id });
    q.afterCommit(() => this.rt.emitAssembly(ctx.tenantId!, r.assembly_id, 'convocation.changed'));
    return { deliveryId: id };
  }

  // -------------------------------------------------------------------------
  // Processamento da fila
  // -------------------------------------------------------------------------

  /** Processa um lote de envios vencidos. Retorna quantos foram tratados. */
  async runOnce(limit = 25): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const claimed = await this.db.tx({}, (q) =>
        q.rows<{ delivery_id: string; tenant_id: string }>('select * from convocation_claim_deliveries($1, $2)', [limit, 120]),
      );
      for (const c of claimed) {
        await this.process(c.tenant_id, c.delivery_id).catch((err) => this.logger.error({ err, delivery: c.delivery_id }, 'Falha ao processar envio'));
      }
      return claimed.length;
    } finally {
      this.running = false;
    }
  }

  private async process(tenantId: string, deliveryId: string) {
    const job = await this.db.tx({ tenantId }, (q) =>
      q.maybe<{
        recipient_id: string; attempts: number; max_attempts: number; link_token_enc: string; address: string;
        person_name: string; unit: string; subject: string; body: string; snapshot: ConvocationSnapshot; conv_status: string;
        version: number; content_sha256: string; assembly_id: string;
      }>(
        `select d.recipient_id, d.attempts, d.max_attempts, r.link_token_enc, r.address, p.name as person_name,
                concat_ws(' - ', b.name, u.identifier) as unit, c.subject, c.body, c.snapshot, c.status as conv_status,
                c.version, c.content_sha256, c.assembly_id
           from convocation_deliveries d
           join convocation_recipients r on r.id = d.recipient_id
           join convocations c on c.id = r.convocation_id
           join people p on p.id = r.person_id
           join units u on u.id = r.unit_id left join buildings b on b.id = u.building_id
          where d.id = $1 and d.status = 'sending'`,
        [deliveryId],
      ),
    );
    if (!job) return;
    const finish = async (status: 'sent' | 'failed' | 'queued', fields: { messageId?: string; error?: string; retryInS?: number }) => {
      await this.db.tx({ tenantId }, async (q) => {
        await q.exec(
          `update convocation_deliveries
              set status = $2, lease_until = null, last_error = $3,
                  provider_message_id = coalesce($4, provider_message_id),
                  sent_at = case when $2 = 'sent' then clock_timestamp() else sent_at end,
                  next_attempt_at = case when $2 = 'queued' then now() + make_interval(secs => $5::int) else next_attempt_at end
            where id = $1`,
          [deliveryId, status, fields.error ?? null, fields.messageId ?? null, fields.retryInS ?? 0],
        );
        const event = status === 'sent' ? 'sent' : status === 'failed' ? 'failed' : 'retry_scheduled';
        await q.exec(
          `insert into convocation_delivery_events (tenant_id, recipient_id, delivery_id, event, detail) values ($1,$2,$3,$4,$5)`,
          [tenantId, job.recipient_id, deliveryId, event, JSON.stringify({ attempt: job.attempts, messageId: fields.messageId, error: fields.error })],
        );
        q.afterCommit(() => this.rt.emitAssembly(tenantId, job.assembly_id, 'convocation.changed'));
      });
    };

    if (job.conv_status !== 'published') {
      return finish('failed', { error: 'Edital substituído ou cancelado antes do envio' });
    }
    let token: string;
    try {
      token = this.crypto.decrypt(job.link_token_enc);
    } catch {
      return finish('failed', { error: 'Falha ao decifrar link individual' });
    }
    const link = `${(env().PUBLIC_WEB_URL ?? env().WEB_ORIGIN.split(',')[0]!.trim()).replace(/\/$/, '')}/c/${token}`;
    const msg = this.render(job, link);
    try {
      const res = await this.mail.send({
        to: job.address,
        subject: job.subject,
        text: msg.text,
        html: msg.html,
        headers: { 'X-LSG-Delivery': deliveryId },
      });
      await finish('sent', { messageId: res.messageId || deliveryId });
    } catch (err) {
      const error = (err as Error).message?.slice(0, 500) ?? 'erro desconhecido';
      if (job.attempts >= job.max_attempts) return finish('failed', { error });
      const delay = RETRY_DELAYS_S[Math.min(job.attempts - 1, RETRY_DELAYS_S.length - 1)]!;
      await finish('queued', { error, retryInS: delay });
    }
  }

  render(job: { person_name: string; unit: string; body: string; snapshot: ConvocationSnapshot; version: number; content_sha256: string }, link: string) {
    const s = job.snapshot;
    const tz = s.assembly.timezone;
    const when = [
      `1ª convocação: ${fmtDate(s.assembly.firstCallAt, tz)}`,
      ...(s.assembly.secondCallAt ? [`2ª convocação: ${fmtDate(s.assembly.secondCallAt, tz)}`] : []),
    ];
    const agenda = s.agenda.map((i) => `${i.position}. ${i.title}${i.description ? ` — ${i.description}` : ''}`);
    const text = [
      `Prezado(a) ${job.person_name} (unidade ${job.unit}),`,
      '',
      `${s.condominium.name} — ${s.assembly.title} (${s.assembly.code})`,
      ...when,
      `Modalidade: ${s.assembly.modality}${s.assembly.location ? ` — Local: ${s.assembly.location}` : ''}`,
      '',
      job.body,
      '',
      'Ordem do dia:',
      ...agenda,
      '',
      `Acesse o edital e participe: ${link}`,
      'Este link é pessoal e intransferível. A participação exige login e credenciamento.',
      '',
      `Edital versão ${job.version} — SHA-256 ${job.content_sha256}`,
    ].join('\n');
    const html = `<!doctype html><html lang="pt-BR"><body style="font-family:Arial,sans-serif;color:#1f1f1f;max-width:640px">
<p>Prezado(a) <strong>${esc(job.person_name)}</strong> (unidade ${esc(job.unit)}),</p>
<h2 style="margin-bottom:4px">${esc(s.assembly.title)}</h2>
<p style="margin-top:0;color:#555">${esc(s.condominium.name)} · ${esc(s.assembly.code)}</p>
<p>${when.map(esc).join('<br>')}<br>Modalidade: ${esc(s.assembly.modality)}${s.assembly.location ? ` — Local: ${esc(s.assembly.location)}` : ''}</p>
<div style="white-space:pre-wrap;border-left:3px solid #1677ff;padding-left:12px">${esc(job.body)}</div>
<h3>Ordem do dia</h3><ol>${s.agenda.map((i) => `<li>${esc(i.title)}${i.description ? ` — ${esc(i.description)}` : ''}</li>`).join('')}</ol>
<p><a href="${esc(link)}" style="background:#1677ff;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Abrir edital e participar</a></p>
<p style="font-size:12px;color:#777">Link pessoal e intransferível. A participação exige login e credenciamento.<br>
Edital versão ${job.version} — SHA-256 <code>${esc(job.content_sha256)}</code></p></body></html>`;
    return { text, html };
  }

  // -------------------------------------------------------------------------
  // Link público
  // -------------------------------------------------------------------------

  async openLink(token: string, meta: { ip: string; userAgent: string }) {
    if (!/^[\w-]{20,100}$/.test(token)) throw notFound('Convocação');
    const hash = this.crypto.sha256(token);
    const ref = await this.db.tx({}, (q) =>
      q.maybe<{ tenant_id: string; recipient_id: string; convocation_id: string }>('select * from convocation_resolve_link($1)', [hash]),
    );
    if (!ref) throw notFound('Convocação');
    return this.db.tx({ tenantId: ref.tenant_id }, async (q) => {
      const c = await q.one<{
        id: string; assembly_id: string; status: string; version: number; subject: string; body: string;
        snapshot: ConvocationSnapshot; content_sha256: string; published_at: Date;
      }>('select id, assembly_id, status, version, subject, body, snapshot, content_sha256, published_at from convocations where id = $1', [ref.convocation_id]);
      const current = await q.maybe<{ version: number }>(
        `select version from convocations where assembly_id = $1 and status = 'published'`, [c.assembly_id]);
      await q.exec(
        `insert into convocation_delivery_events (tenant_id, recipient_id, event, detail) values ($1,$2,'opened',$3)`,
        [ref.tenant_id, ref.recipient_id, JSON.stringify({ ip: meta.ip, userAgent: meta.userAgent })],
      );
      const a = await q.one<{ status: string; condominium_id: string }>('select status, condominium_id from assemblies where id = $1', [c.assembly_id]);
      q.afterCommit(() => this.rt.emitAssembly(ref.tenant_id, c.assembly_id, 'convocation.changed'));
      return {
        assemblyId: c.assembly_id,
        assemblyStatus: a.status,
        status: c.status,
        version: c.version,
        currentVersion: current?.version ?? null,
        subject: c.subject,
        body: c.body,
        snapshot: c.snapshot,
        contentSha256: c.content_sha256,
        publishedAt: c.published_at,
      };
    });
  }
}
