import { ForbiddenException, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import {
  formatFixed,
  parseFixed,
  tallyBallot,
  validateChoice,
  type BallotCreateInput,
  type BallotType,
  type OptionKind,
  type TallyResult,
  type TallyVote,
  type VoteCastInput,
} from '@lsg/shared';
import { AuditService } from '../../audit/audit.service';
import { AuthzService } from '../../authz/authz.service';
import { CryptoService } from '../../common/crypto.service';
import { conflict, forbidden, notFound, unprocessable, type ReqCtx } from '../../common/http';
import { dbc } from '../../common/scope';
import { DbService, type Q } from '../../db/db.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { AssembliesService, type AssemblyRow } from '../assemblies/assemblies.service';
import { QuorumService } from '../assemblies/quorum.service';

export interface BallotRow {
  id: string;
  tenant_id: string;
  assembly_id: string;
  agenda_item_id: string;
  round: number;
  title: string;
  question: string;
  ballot_type: BallotType;
  max_choices: number;
  seats: number;
  secrecy: 'nominal' | 'secret';
  approval_rule_id: string;
  presence_rule_id: string | null;
  allow_vote_change: boolean;
  show_partial_results: boolean;
  status: string;
  session_id: string | null;
  call_number: number | null;
  electorate_units: number | null;
  electorate_fraction: string | null;
  closed_present_unit_ids: string[] | null;
  closed_present_units: number | null;
  closed_present_fraction: string | null;
  opened_at: Date | null;
  closed_at: Date | null;
  declared_result_id: string | null;
}

interface OptionRow {
  id: string;
  label: string;
  kind: OptionKind;
  position: number;
}

function receiptCode(): string {
  const hex = randomBytes(6).toString('hex').toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
}

/**
 * Motor de votação. Princípios:
 * - O servidor é a fonte autoritativa; sucesso só após COMMIT.
 * - Votos nunca são sobrescritos (tabelas append-only; substituição = nova versão).
 * - Unicidade por (votação, unidade) garantida por constraint; idempotência por chave do cliente.
 * - Votação sigilosa separa participação (quem) de escolha (o quê).
 */
@Injectable()
export class VotingService {
  constructor(
    private readonly db: DbService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly assemblies: AssembliesService,
    private readonly quorum: QuorumService,
    private readonly rt: RealtimeGateway,
  ) {}

  async loadBallot(q: Q, id: string, lock: '' | 'for update' | 'for share' = ''): Promise<BallotRow> {
    const b = await q.maybe<BallotRow>(
      `select *, electorate_fraction::text as electorate_fraction, closed_present_fraction::text as closed_present_fraction
         from ballots where id = $1 ${lock}`,
      [id],
    );
    if (!b) throw notFound('Votação');
    return b;
  }

  private async options(q: Q, ballotId: string): Promise<OptionRow[]> {
    return q.rows<OptionRow>('select id, label, kind, position from ballot_options where ballot_id = $1 order by position', [ballotId]);
  }

  private emit(q: Q, ctx: ReqCtx, assemblyId: string, event: string, payload: Record<string, unknown>) {
    q.afterCommit(() => this.rt.emitAssembly(ctx.tenantId!, assemblyId, event, payload));
  }

  // ------------------------------------------------------------------ preparação
  async create(ctx: ReqCtx, assemblyId: string, body: BallotCreateInput) {
    return this.db.tx(dbc(ctx), async (q) => {
      const a = await this.assemblies.load(q, assemblyId, true);
      if (!this.authz.has(ctx, 'assembly.manage', a.condominium_id)) this.authz.require(ctx, 'assembly.conduct', a.condominium_id);
      if (['closed', 'in_conference', 'archived', 'cancelled'].includes(a.status)) throw conflict('Assembleia encerrada');
      const item = await q.maybe<{ item_type: string }>('select item_type from agenda_items where id = $1 and assembly_id = $2', [body.agendaItemId, assemblyId]);
      if (!item) throw notFound('Item de pauta');
      if (item.item_type !== 'deliberativo') throw unprocessable('Item informativo não comporta votação');
      await this.checkRule(q, a, body.approvalRuleId, 'approval');
      if (body.presenceRuleId) await this.checkRule(q, a, body.presenceRuleId, 'presence');
      const round = await q.one<{ n: number }>('select coalesce(max(round), 0)::int + 1 as n from ballots where agenda_item_id = $1', [body.agendaItemId]);
      if (round.n > 1) {
        const active = await q.one<{ n: number }>(
          `select count(*)::int as n from ballots where agenda_item_id = $1 and status not in ('cancelled')`, [body.agendaItemId]);
        if (active.n > 0) throw conflict('Já existe votação ativa para este item. Cancele-a para abrir nova rodada.');
      }
      const b = await q.one<{ id: string }>(
        `insert into ballots (tenant_id, assembly_id, agenda_item_id, round, title, question, ballot_type, max_choices, seats, secrecy,
            approval_rule_id, presence_rule_id, allow_vote_change, show_partial_results, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
        [ctx.tenantId, assemblyId, body.agendaItemId, round.n, body.title, body.question, body.ballotType,
          body.ballotType === 'multiple_choice' ? body.maxChoices : 1, body.seats, body.secrecy,
          body.approvalRuleId, body.presenceRuleId ?? null, body.allowVoteChange, body.showPartialResults && body.secrecy === 'nominal', ctx.auth.userId],
      );
      const opts: { label: string; kind: OptionKind }[] =
        body.ballotType === 'yes_no'
          ? [{ label: 'Sim', kind: 'yes' }, { label: 'Não', kind: 'no' }]
          : body.options.filter((o) => o.kind === 'regular');
      if (body.includeAbstention) opts.push({ label: 'Abstenção', kind: 'abstention' });
      if (body.includeBlank) opts.push({ label: 'Voto em branco', kind: 'blank' });
      if (body.includeNull) opts.push({ label: 'Voto nulo', kind: 'null' });
      let pos = 1;
      for (const o of opts) {
        await q.exec('insert into ballot_options (tenant_id, ballot_id, position, label, kind) values ($1,$2,$3,$4,$5)', [ctx.tenantId, b.id, pos++, o.label, o.kind]);
      }
      await this.audit.record(q, ctx, { action: 'ballot.created', resourceType: 'ballot', resourceId: b.id, assemblyId, after: { ...body, round: round.n } });
      this.emit(q, ctx, assemblyId, 'ballot.changed', { ballotId: b.id });
      return { id: b.id, round: round.n };
    });
  }

  private async checkRule(q: Q, a: AssemblyRow, ruleId: string, purpose: 'approval' | 'presence') {
    const r = await q.maybe<{ condominium_id: string; status: string; purpose: string }>(
      'select condominium_id, status, purpose from quorum_rules where id = $1', [ruleId]);
    if (!r || r.condominium_id !== a.condominium_id) throw notFound('Regra');
    if (r.status !== 'approved') throw unprocessable('A regra precisa estar homologada', 'RULE_NOT_APPROVED');
    if (r.purpose !== purpose) throw unprocessable(`A regra informada não é de ${purpose === 'approval' ? 'aprovação' : 'presença'}`);
  }

  // ------------------------------------------------------------------ ciclo de vida
  async open(ctx: ReqCtx, ballotId: string) {
    return this.db.tx(dbc(ctx), async (q) => {
      const b = await this.loadBallot(q, ballotId, 'for update');
      const a = await this.assemblies.load(q, b.assembly_id);
      this.authz.require(ctx, 'assembly.conduct', a.condominium_id);
      if (b.status !== 'prepared') throw conflict('Somente votações preparadas podem ser abertas');
      if (a.status !== 'in_progress') throw conflict('A assembleia precisa estar em andamento', 'ASSEMBLY_NOT_IN_PROGRESS');
      if (!a.rules_homologated_at) throw unprocessable('Regras da assembleia não homologadas', 'RULES_NOT_HOMOLOGATED');
      const session = await this.assemblies.openSession(q, a.id);
      if (!session) throw conflict('Não há sessão aberta');
      const approval = await this.quorum.loadRule(q, b.approval_rule_id);
      if (!approval || !approval.approvedAt) throw unprocessable('Regra de aprovação não homologada');
      const presenceRuleId =
        b.presence_rule_id ?? (session.call_number === 2 ? a.second_call_presence_rule_id : a.first_call_presence_rule_id);

      await q.exec(
        `insert into ballot_electorate (tenant_id, ballot_id, unit_id, ideal_fraction, eligible, ineligibility_reason, present_at_open)
         select u.tenant_id, $1, u.id, u.ideal_fraction, u.voting_status = 'eligible', u.voting_restriction_reason,
                exists (select 1 from accreditations x where x.assembly_id = $2 and x.unit_id = u.id and x.revoked_at is null)
           from units u where u.condominium_id = $3 and u.status = 'active'`,
        [ballotId, a.id, a.condominium_id],
      );
      const el = await q.one<{ units: number; fraction: string }>(
        `select count(*)::int as units, coalesce(sum(ideal_fraction), 0)::text as fraction
           from ballot_electorate where ballot_id = $1 and eligible`, [ballotId]);
      if (el.units === 0) throw unprocessable('Base eleitoral vazia');
      await q.exec(
        `update ballots set status = 'open', opened_at = clock_timestamp(), opened_by = $2, session_id = $3, call_number = $4,
            presence_rule_id = $5, electorate_units = $6, electorate_fraction = $7 where id = $1`,
        [ballotId, ctx.auth.userId, session.id, session.call_number, presenceRuleId, el.units, el.fraction],
      );
      await this.assemblies.timeline(q, ctx, a.id, 'ballot.opened', ballotId, { title: b.title, round: b.round, electorate: el });
      await this.audit.record(q, ctx, {
        action: 'ballot.opened', resourceType: 'ballot', resourceId: ballotId, assemblyId: a.id,
        metadata: { electorate: el, callNumber: session.call_number, presenceRuleId, approvalRule: { code: approval.code, version: approval.version } },
      });
      this.emit(q, ctx, a.id, 'ballot.changed', { ballotId, status: 'open' });
      return { ok: true, electorate: el };
    });
  }

  async close(ctx: ReqCtx, ballotId: string) {
    return this.db.tx(dbc(ctx), async (q) => {
      const b = await this.loadBallot(q, ballotId, 'for update');
      const a = await this.assemblies.load(q, b.assembly_id);
      this.authz.require(ctx, 'assembly.conduct', a.condominium_id);
      if (b.status !== 'open') throw conflict('Votação não está aberta');
      const present = await q.rows<{ unit_id: string; ideal_fraction: string }>(
        `select e.unit_id, e.ideal_fraction::text from ballot_electorate e
          where e.ballot_id = $1 and e.eligible and (
            exists (select 1 from accreditations x where x.assembly_id = $2 and x.unit_id = e.unit_id and x.revoked_at is null)
            or exists (select 1 from votes v where v.ballot_id = $1 and v.unit_id = e.unit_id)
            or exists (select 1 from vote_participations p where p.ballot_id = $1 and p.unit_id = e.unit_id))`,
        [ballotId, a.id],
      );
      const fraction = present.reduce((s, p) => s + parseFixed(p.ideal_fraction), 0n);
      await q.exec(
        `update ballots set status = 'closed', closed_at = clock_timestamp(), closed_by = $2,
            closed_present_unit_ids = $3::uuid[], closed_present_units = $4, closed_present_fraction = $5 where id = $1`,
        [ballotId, ctx.auth.userId, present.map((p) => p.unit_id), present.length, formatFixed(fraction)],
      );
      const voted = await this.votedCount(q, b);
      await this.assemblies.timeline(q, ctx, a.id, 'ballot.closed', ballotId, { title: b.title, votes: voted, present: present.length });
      await this.audit.record(q, ctx, { action: 'ballot.closed', resourceType: 'ballot', resourceId: ballotId, assemblyId: a.id, metadata: { votes: voted, present: present.length } });
      this.emit(q, ctx, a.id, 'ballot.changed', { ballotId, status: 'closed' });
      return { ok: true, votes: voted, present: present.length };
    });
  }

  private async votedCount(q: Q, b: BallotRow): Promise<number> {
    const r = await q.one<{ n: number }>(
      b.secrecy === 'secret'
        ? 'select count(*)::int as n from vote_participations where ballot_id = $1'
        : 'select count(distinct unit_id)::int as n from votes where ballot_id = $1',
      [b.id],
    );
    return r.n;
  }

  /** Computa a apuração a partir do banco (não persiste). */
  async computeTally(q: Q, b: BallotRow, a: AssemblyRow, mode: 'final' | 'partial'): Promise<{ tally: TallyResult; ruleSnapshot: unknown; votesHead: string | null }> {
    const approval = await this.quorum.loadRule(q, b.approval_rule_id);
    const presence = await this.quorum.loadRule(q, b.presence_rule_id);
    const options = await this.options(q, b.id);

    let votes: TallyVote[] = [];
    let votesHead: string | null = null;
    if (b.secrecy === 'secret') {
      const agg = await q.rows<{ option_ids: string[]; ideal_fraction: string; votes: string }>('select * from secret_ballot_tally($1)', [b.id]);
      for (const g of agg) {
        const n = Number(g.votes);
        for (let i = 0; i < n; i++) votes.push({ optionIds: g.option_ids, weight: { units: 1, fraction: parseFixed(g.ideal_fraction) } });
      }
    } else {
      const rows = await q.rows<{ option_ids: string[]; ideal_fraction: string }>(
        `select distinct on (unit_id) option_ids, ideal_fraction::text from votes where ballot_id = $1 order by unit_id, version desc`,
        [b.id],
      );
      votes = rows.map((r) => ({ optionIds: r.option_ids, weight: { units: 1, fraction: parseFixed(r.ideal_fraction) } }));
      votesHead = (await q.maybe<{ hash: string }>('select hash from votes where ballot_id = $1 order by cast_at desc, id desc limit 1', [b.id]))?.hash ?? null;
    }

    let presentIds: string[];
    let present: { units: number; fraction: bigint };
    if (mode === 'final' && b.closed_present_unit_ids) {
      presentIds = b.closed_present_unit_ids;
      present = { units: b.closed_present_units ?? 0, fraction: parseFixed(b.closed_present_fraction ?? '0') };
    } else {
      const rows = await q.rows<{ unit_id: string; ideal_fraction: string }>(
        `select e.unit_id, e.ideal_fraction::text from ballot_electorate e
          where e.ballot_id = $1 and e.eligible and (
            exists (select 1 from accreditations x where x.assembly_id = $2 and x.unit_id = e.unit_id and x.revoked_at is null)
            or exists (select 1 from votes v where v.ballot_id = $1 and v.unit_id = e.unit_id))`,
        [b.id, a.id],
      );
      presentIds = rows.map((r) => r.unit_id);
      present = { units: rows.length, fraction: rows.reduce((s, r) => s + parseFixed(r.ideal_fraction), 0n) };
    }

    const preIssues = await this.quorum.issues(q, a, { countingUnit: approval?.definition.countingUnit, presentUnitIds: presentIds });
    if (approval && !approval.approvedAt) preIssues.push({ code: 'RULE_NOT_APPROVED', severity: 'blocking', message: 'Regra de aprovação não homologada.' });
    if (mode === 'partial') preIssues.push({ code: 'PARTIAL', severity: 'blocking', message: 'Apuração parcial — votação em andamento.' });

    const tally = tallyBallot({
      ballotType: b.ballot_type,
      seats: b.seats,
      options: options.map((o) => ({ id: o.id, label: o.label, kind: o.kind })),
      electorate: { units: b.electorate_units ?? 0, fraction: parseFixed(b.electorate_fraction ?? '0') },
      present,
      votes,
      approvalRule: approval?.definition ?? null,
      presenceRule: presence?.definition ?? null,
      preIssues,
    });
    const ruleSnapshot = {
      approval: approval && { id: approval.id, code: approval.code, version: approval.version, name: approval.name, legalBasis: approval.legalBasis, definition: approval.definition },
      presence: presence && { id: presence.id, code: presence.code, version: presence.version, name: presence.name, legalBasis: presence.legalBasis, definition: presence.definition },
    };
    return { tally, ruleSnapshot, votesHead };
  }

  async tally(ctx: ReqCtx, ballotId: string) {
    return this.db.tx(dbc(ctx), async (q) => {
      const b = await this.loadBallot(q, ballotId, 'for update');
      const a = await this.assemblies.load(q, b.assembly_id);
      this.authz.require(ctx, 'assembly.conduct', a.condominium_id);
      if (!['closed', 'tallied'].includes(b.status)) throw conflict('A votação precisa estar encerrada para apuração');
      const { tally, ruleSnapshot, votesHead } = await this.computeTally(q, b, a, 'final');
      const resultHash = this.crypto.sha256(JSON.stringify({ ballotId, tally, ruleSnapshot, votesHead }));
      const r = await q.one<{ id: string; computed_at: Date }>(
        `insert into ballot_results (tenant_id, ballot_id, computed_by, outcome, declarable, tally, rule_snapshot, votes_head_hash, result_hash)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id, computed_at`,
        [ctx.tenantId, ballotId, ctx.auth.userId, tally.outcome, tally.declarable, JSON.stringify(tally), JSON.stringify(ruleSnapshot), votesHead, resultHash],
      );
      await q.exec(`update ballots set status = 'tallied' where id = $1`, [ballotId]);
      await this.assemblies.timeline(q, ctx, a.id, 'ballot.tallied', ballotId, { outcome: tally.outcome, declarable: tally.declarable });
      await this.audit.record(q, ctx, {
        action: 'ballot.tallied', resourceType: 'ballot', resourceId: ballotId, assemblyId: a.id,
        metadata: { resultId: r.id, outcome: tally.outcome, declarable: tally.declarable, resultHash },
      });
      this.emit(q, ctx, a.id, 'ballot.changed', { ballotId, status: 'tallied' });
      return { resultId: r.id, resultHash, ...tally };
    });
  }

  async declare(ctx: ReqCtx, ballotId: string) {
    return this.db.tx(dbc(ctx), async (q) => {
      const b = await this.loadBallot(q, ballotId, 'for update');
      const a = await this.assemblies.load(q, b.assembly_id);
      this.authz.require(ctx, 'assembly.conduct', a.condominium_id);
      if (b.status !== 'tallied') throw conflict('Apure a votação antes de declarar o resultado');
      const r = await q.one<{ id: string; outcome: string; declarable: boolean; tally: TallyResult; result_hash: string }>(
        'select id, outcome, declarable, tally, result_hash from ballot_results where ballot_id = $1 order by computed_at desc limit 1', [ballotId]);
      if (!r.declarable) {
        throw unprocessable('Resultado com pendências bloqueantes não pode ser declarado', 'NOT_DECLARABLE',
          r.tally.issues.filter((i) => i.severity === 'blocking'));
      }
      await q.exec(
        `update ballots set status = 'declared', declared_result_id = $2, declared_at = clock_timestamp(), declared_by = $3 where id = $1`,
        [ballotId, r.id, ctx.auth.userId],
      );
      await this.assemblies.timeline(q, ctx, a.id, 'ballot.declared', ballotId, { title: b.title, outcome: r.outcome, resultHash: r.result_hash });
      await this.audit.record(q, ctx, { action: 'ballot.declared', resourceType: 'ballot', resourceId: ballotId, assemblyId: a.id, metadata: { resultId: r.id, outcome: r.outcome, resultHash: r.result_hash } });
      this.emit(q, ctx, a.id, 'ballot.changed', { ballotId, status: 'declared' });
      return { ok: true, outcome: r.outcome };
    });
  }

  async cancel(ctx: ReqCtx, ballotId: string, reason: string) {
    return this.db.tx(dbc(ctx), async (q) => {
      const b = await this.loadBallot(q, ballotId, 'for update');
      const a = await this.assemblies.load(q, b.assembly_id);
      this.authz.require(ctx, 'assembly.conduct', a.condominium_id);
      if (!['prepared', 'open'].includes(b.status)) throw conflict('Somente votações preparadas ou abertas podem ser canceladas');
      await q.exec(
        `update ballots set status = 'cancelled', cancelled_at = clock_timestamp(), cancelled_by = $2, cancel_reason = $3 where id = $1`,
        [ballotId, ctx.auth.userId, reason],
      );
      const voted = await this.votedCount(q, b);
      await this.assemblies.timeline(q, ctx, a.id, 'ballot.cancelled', ballotId, { title: b.title, reason, votesPreserved: voted });
      await this.audit.record(q, ctx, { action: 'ballot.cancelled', resourceType: 'ballot', resourceId: ballotId, assemblyId: a.id, metadata: { reason, votesPreserved: voted } });
      this.emit(q, ctx, a.id, 'ballot.changed', { ballotId, status: 'cancelled' });
      return { ok: true, votesPreserved: voted };
    });
  }

  /** Nova rodada (identificador distinto) a partir de votação cancelada. */
  async newRound(ctx: ReqCtx, ballotId: string) {
    return this.db.tx(dbc(ctx), async (q) => {
      const b = await this.loadBallot(q, ballotId);
      const a = await this.assemblies.load(q, b.assembly_id);
      this.authz.require(ctx, 'assembly.conduct', a.condominium_id);
      if (b.status !== 'cancelled') throw conflict('Nova rodada somente a partir de votação cancelada');
      const active = await q.one<{ n: number }>(`select count(*)::int as n from ballots where agenda_item_id = $1 and status <> 'cancelled'`, [b.agenda_item_id]);
      if (active.n > 0) throw conflict('Já existe votação ativa para este item');
      const round = await q.one<{ n: number }>('select max(round)::int + 1 as n from ballots where agenda_item_id = $1', [b.agenda_item_id]);
      const n = await q.one<{ id: string }>(
        `insert into ballots (tenant_id, assembly_id, agenda_item_id, round, title, question, ballot_type, max_choices, seats, secrecy,
            approval_rule_id, presence_rule_id, allow_vote_change, show_partial_results, created_by)
         select tenant_id, assembly_id, agenda_item_id, $2, title, question, ballot_type, max_choices, seats, secrecy,
                approval_rule_id, null, allow_vote_change, show_partial_results, $3
           from ballots where id = $1 returning id`,
        [ballotId, round.n, ctx.auth.userId],
      );
      await q.exec(
        `insert into ballot_options (tenant_id, ballot_id, position, label, kind)
         select tenant_id, $2, position, label, kind from ballot_options where ballot_id = $1`,
        [ballotId, n.id],
      );
      await this.audit.record(q, ctx, { action: 'ballot.new_round', resourceType: 'ballot', resourceId: n.id, assemblyId: a.id, metadata: { from: ballotId, round: round.n } });
      this.emit(q, ctx, a.id, 'ballot.changed', { ballotId: n.id });
      return { id: n.id, round: round.n };
    });
  }

  // ------------------------------------------------------------------ voto
  private async findReplay(q: Q, b: BallotRow, key: string) {
    return q.maybe<{ unit_id: string; receipt_code: string; version: number; cast_at: Date }>(
      b.secrecy === 'secret'
        ? 'select unit_id, receipt_code, 1 as version, cast_at from vote_participations where ballot_id = $1 and idempotency_key = $2'
        : 'select unit_id, receipt_code, version, cast_at from votes where ballot_id = $1 and idempotency_key = $2',
      [b.id, key],
    );
  }

  async cast(ctx: ReqCtx, ballotId: string, body: VoteCastInput) {
    return this.db.tx(dbc(ctx), async (q) => {
      // FOR SHARE: votos concorrentes prosseguem; o encerramento (FOR UPDATE) aguarda os votos em curso.
      const b = await this.loadBallot(q, ballotId, 'for share');
      const a = await this.assemblies.load(q, b.assembly_id);
      this.authz.require(ctx, 'assembly.attend', a.condominium_id);

      const replay = await this.findReplay(q, b, body.idempotencyKey);
      if (replay) {
        if (replay.unit_id !== body.unitId) throw conflict('Chave de idempotência já utilizada para outra unidade', 'IDEMPOTENCY_MISMATCH');
        return { receipt: replay.receipt_code, version: replay.version, castAt: replay.cast_at, unitId: replay.unit_id, replayed: true };
      }
      if (b.status !== 'open') throw conflict('A votação não está aberta', 'BALLOT_NOT_OPEN');
      if (a.status !== 'in_progress') throw conflict('A assembleia não está em andamento', 'ASSEMBLY_NOT_IN_PROGRESS');

      const el = await q.maybe<{ ideal_fraction: string; eligible: boolean; ineligibility_reason: string | null }>(
        'select ideal_fraction::text, eligible, ineligibility_reason from ballot_electorate where ballot_id = $1 and unit_id = $2',
        [ballotId, body.unitId],
      );
      if (!el) throw forbidden('Unidade fora da base eleitoral desta votação');
      if (!el.eligible) throw new ForbiddenException({ message: 'Unidade sem direito de voto nesta deliberação', code: 'UNIT_NOT_ELIGIBLE', reason: el.ineligibility_reason });

      const me = await q.maybe<{ id: string }>(`select id from people where user_id = $1 and status = 'active'`, [ctx.auth.userId]);
      if (!me) throw forbidden('Usuário sem cadastro de condômino vinculado');
      const acc = await q.maybe<{ id: string; basis: 'titular' | 'procuracao'; poa_id: string | null }>(
        `select id, basis, poa_id from accreditations where assembly_id = $1 and unit_id = $2 and person_id = $3 and revoked_at is null`,
        [a.id, body.unitId, me.id],
      );
      if (!acc) throw new ForbiddenException({ message: 'Você não está credenciado como representante desta unidade', code: 'NOT_ACCREDITED' });
      if (acc.basis === 'procuracao') {
        const ok = await q.maybe(
          `select 1 from powers_of_attorney where id = $1 and status = 'approved' and can_vote
              and valid_from <= now() and (valid_until is null or valid_until > now())`, [acc.poa_id]);
        if (!ok) throw new ForbiddenException({ message: 'Procuração não está mais vigente', code: 'POA_NOT_VALID' });
      }

      const options = await this.options(q, ballotId);
      const err = validateChoice({ ballotType: b.ballot_type, maxChoices: b.max_choices, options }, body.optionIds);
      if (err) throw unprocessable(err, 'INVALID_CHOICE');

      const receipt = receiptCode();
      let version = 1;
      let castAt: Date;
      await q.exec('savepoint cast_vote');
      try {
        if (b.secrecy === 'secret') {
          const p = await q.one<{ cast_at: Date }>(
            `insert into vote_participations (tenant_id, ballot_id, unit_id, accreditation_id, cast_by_person_id, cast_by_user_id, idempotency_key, receipt_code)
             values ($1,$2,$3,$4,$5,$6,$7,$8) returning cast_at`,
            [ctx.tenantId, ballotId, body.unitId, acc.id, me.id, ctx.auth.userId, body.idempotencyKey, receipt],
          );
          await q.exec(
            'insert into secret_ballot_entries (tenant_id, ballot_id, option_ids, ideal_fraction) values ($1,$2,$3::uuid[],$4)',
            [ctx.tenantId, ballotId, [...body.optionIds].sort(), el.ideal_fraction],
          );
          castAt = p.cast_at;
        } else {
          const cur = await q.one<{ v: number | null }>('select max(version)::int as v from votes where ballot_id = $1 and unit_id = $2', [ballotId, body.unitId]);
          if (cur.v && !b.allow_vote_change) throw conflict('Esta unidade já votou nesta deliberação', 'ALREADY_VOTED');
          version = (cur.v ?? 0) + 1;
          const v = await q.one<{ cast_at: Date }>(
            `insert into votes (tenant_id, ballot_id, unit_id, version, accreditation_id, cast_by_person_id, cast_by_user_id, basis, poa_id,
                ideal_fraction, option_ids, idempotency_key, receipt_code)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::uuid[],$12,$13) returning cast_at`,
            [ctx.tenantId, ballotId, body.unitId, version, acc.id, me.id, ctx.auth.userId, acc.basis, acc.poa_id,
              el.ideal_fraction, body.optionIds, body.idempotencyKey, receipt],
          );
          castAt = v.cast_at;
        }
      } catch (e) {
        if ((e as { code?: string }).code === '23505') {
          await q.exec('rollback to savepoint cast_vote');
          const again = await this.findReplay(q, b, body.idempotencyKey);
          if (again && again.unit_id === body.unitId) {
            return { receipt: again.receipt_code, version: again.version, castAt: again.cast_at, unitId: again.unit_id, replayed: true };
          }
          throw conflict('Esta unidade já votou nesta deliberação', 'ALREADY_VOTED');
        }
        throw e;
      }
      await this.audit.record(q, ctx, {
        action: version > 1 ? 'vote.replaced' : 'vote.cast', resourceType: 'ballot', resourceId: ballotId, assemblyId: a.id,
        metadata: { unitId: body.unitId, version, basis: acc.basis, secrecy: b.secrecy },
      });
      const voted = await this.votedCount(q, b);
      this.emit(q, ctx, a.id, 'ballot.progress', { ballotId, votes: voted });
      return { receipt, version, castAt, unitId: body.unitId, replayed: false };
    });
  }
}
