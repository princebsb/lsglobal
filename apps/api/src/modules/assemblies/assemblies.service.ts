import { Injectable } from '@nestjs/common';
import {
  ACCREDITATION_OPEN_STATUSES,
  ASSEMBLY_STATUS_LABELS,
  canTransitionAssembly,
  type AssemblyStatus,
} from '@lsg/shared';
import { AuditService } from '../../audit/audit.service';
import { AuthzService } from '../../authz/authz.service';
import { conflict, notFound, unprocessable, type ReqCtx } from '../../common/http';
import type { Q } from '../../db/db.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';

export interface AssemblyRow {
  id: string;
  tenant_id: string;
  condominium_id: string;
  code: string;
  title: string;
  kind: string;
  modality: string;
  status: AssemblyStatus;
  timezone: string;
  location: string | null;
  first_call_at: Date;
  second_call_at: Date | null;
  permanent_session: boolean;
  first_call_presence_rule_id: string | null;
  second_call_presence_rule_id: string | null;
  rules_homologated_at: Date | null;
  settings: Record<string, unknown>;
}

/** Transições que pertencem à mesa diretora (condução) e não ao planejamento. */
const CONDUCT_TARGETS: AssemblyStatus[] = ['accreditation', 'in_progress', 'suspended', 'closed', 'in_conference', 'archived'];

@Injectable()
export class AssembliesService {
  constructor(
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly rt: RealtimeGateway,
  ) {}

  async load(q: Q, id: string, lock = false): Promise<AssemblyRow> {
    const a = await q.maybe<AssemblyRow>(`select * from assemblies where id = $1 ${lock ? 'for update' : ''}`, [id]);
    if (!a) throw notFound('Assembleia');
    return a;
  }

  async openSession(q: Q, assemblyId: string) {
    return q.maybe<{ id: string; seq: number; call_number: 1 | 2 }>(
      'select id, seq, call_number from assembly_sessions where assembly_id = $1 and ended_at is null',
      [assemblyId],
    );
  }

  async timeline(q: Q, ctx: ReqCtx, assemblyId: string, kind: string, refId: string | null = null, payload: Record<string, unknown> = {}) {
    const s = await this.openSession(q, assemblyId);
    await q.exec(
      `insert into assembly_timeline_events (tenant_id, assembly_id, session_id, kind, ref_id, payload, actor_id)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [ctx.tenantId, assemblyId, s?.id ?? null, kind, refId, JSON.stringify(payload), ctx.auth.userId],
    );
  }

  ensureAccreditationOpen(a: AssemblyRow) {
    if (!ACCREDITATION_OPEN_STATUSES.includes(a.status)) {
      throw conflict(`Credenciamento indisponível no estado "${ASSEMBLY_STATUS_LABELS[a.status]}"`);
    }
  }

  /**
   * Transição de estado com pré-condições de negócio. Sessões são abertas/encerradas
   * automaticamente ao iniciar, suspender, retomar e encerrar.
   */
  async transition(q: Q, ctx: ReqCtx, id: string, to: AssemblyStatus, reason?: string, callNumber: 1 | 2 = 1) {
    const a = await this.load(q, id, true);
    this.authz.require(ctx, CONDUCT_TARGETS.includes(to) ? 'assembly.conduct' : 'assembly.manage', a.condominium_id);
    if (!canTransitionAssembly(a.status, to)) {
      throw conflict(`Transição inválida: ${ASSEMBLY_STATUS_LABELS[a.status]} → ${ASSEMBLY_STATUS_LABELS[to]}`, 'INVALID_TRANSITION');
    }
    if (to === 'cancelled' && (!reason || reason.length < 5)) throw unprocessable('Cancelamento exige justificativa');
    if (to === 'suspended' && (!reason || reason.length < 5)) throw unprocessable('Suspensão exige justificativa');

    if (to === 'approved_for_call' || to === 'in_progress') {
      if (!a.rules_homologated_at) throw unprocessable('As regras da assembleia precisam ser homologadas', 'RULES_NOT_HOMOLOGATED');
      const items = await q.one<{ n: number }>('select count(*)::int as n from agenda_items where assembly_id = $1', [id]);
      if (items.n === 0) throw unprocessable('A pauta não possui itens');
    }
    if (to === 'called') {
      const pub = await q.maybe(`select 1 from convocations where assembly_id = $1 and status = 'published'`, [id]);
      if (!pub) throw unprocessable('Publique o edital de convocação para marcar a assembleia como convocada', 'NO_CONVOCATION');
    }
    if (to === 'in_progress' && callNumber === 2 && !a.second_call_at) {
      throw unprocessable('Assembleia sem 2ª convocação prevista');
    }
    if (to === 'closed' || to === 'suspended') {
      const open = await q.one<{ n: number }>(`select count(*)::int as n from ballots where assembly_id = $1 and status = 'open'`, [id]);
      if (open.n > 0) throw conflict('Encerre as votações abertas antes de suspender ou encerrar a sessão', 'OPEN_BALLOTS');
    }
    if (to === 'archived') {
      const pend = await q.one<{ n: number }>(
        `select count(*)::int as n from ballots where assembly_id = $1 and status not in ('declared','cancelled')`, [id]);
      if (pend.n > 0) throw conflict('Há votações sem resultado declarado ou cancelamento', 'PENDING_BALLOTS');
    }

    // sessões
    if (to === 'in_progress') {
      const seq = await q.one<{ n: number }>('select coalesce(max(seq), 0)::int + 1 as n from assembly_sessions where assembly_id = $1', [id]);
      await q.exec(
        'insert into assembly_sessions (tenant_id, assembly_id, seq, call_number, started_by) values ($1, $2, $3, $4, $5)',
        [ctx.tenantId, id, seq.n, callNumber, ctx.auth.userId],
      );
    }
    if (to === 'suspended' || to === 'closed') {
      await q.exec(
        'update assembly_sessions set ended_at = clock_timestamp(), ended_by = $2, end_reason = $3 where assembly_id = $1 and ended_at is null',
        [id, ctx.auth.userId, reason ?? to],
      );
    }

    await q.exec('update assemblies set status = $2 where id = $1', [id, to]);
    await q.exec(
      'insert into assembly_status_history (tenant_id, assembly_id, from_status, to_status, actor_id, reason) values ($1,$2,$3,$4,$5,$6)',
      [ctx.tenantId, id, a.status, to, ctx.auth.userId, reason ?? null],
    );
    const kindByTarget: Partial<Record<AssemblyStatus, string>> = {
      in_progress: a.status === 'suspended' ? 'session.resumed' : 'session.opened',
      suspended: 'session.suspended',
      closed: 'assembly.closed',
      accreditation: 'accreditation.opened',
      cancelled: 'assembly.cancelled',
    };
    await this.timeline(q, ctx, id, kindByTarget[to] ?? 'assembly.status', null, { from: a.status, to, reason, callNumber });
    await this.audit.record(q, ctx, {
      action: 'assembly.transition', resourceType: 'assembly', resourceId: id, assemblyId: id,
      before: { status: a.status }, after: { status: to }, metadata: { reason, callNumber },
    });
    q.afterCommit(() => this.rt.emitAssembly(ctx.tenantId!, id, 'assembly.status', { status: to }));
    return { ok: true, status: to };
  }
}
