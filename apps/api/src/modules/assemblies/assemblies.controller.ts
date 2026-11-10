import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  AgendaItemCreateSchema,
  AssemblyCreateSchema,
  AssemblyHomologateSchema,
  AssemblyTransitionSchema,
  AssemblyUpdateSchema,
  evaluateThreshold,
  formatFixed,
  parseFixed,
  type AssemblyCreateInput,
  type RuleDefinition,
} from '@lsg/shared';
import { z } from 'zod';
import { AuditService } from '../../audit/audit.service';
import { AuthzService } from '../../authz/authz.service';
import { Ctx, RequirePermission, TenantScoped, ZodBody, ZodPipe, conflict, notFound, unprocessable, type ReqCtx } from '../../common/http';
import { condoFilter, dbc } from '../../common/scope';
import { DbService } from '../../db/db.service';
import { CondominiumsController } from '../condominiums/condominiums.controller';
import { AssembliesService } from './assemblies.service';
import { QuorumService } from './quorum.service';

const EDITABLE = ['draft', 'in_review'];
const AGENDA_EDITABLE = ['draft', 'in_review', 'approved_for_call'];

const TransitionBody = AssemblyTransitionSchema.extend({ callNumber: z.union([z.literal(1), z.literal(2)]).optional() });

@ApiTags('Assembleias')
@ApiBearerAuth()
@TenantScoped()
@Controller('assemblies')
export class AssembliesController {
  constructor(
    private readonly db: DbService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly svc: AssembliesService,
    private readonly quorum: QuorumService,
  ) {}

  @Get()
  @RequirePermission('assembly.view')
  async list(@Ctx() ctx: ReqCtx, @Query('condominiumId') condominiumId?: string, @Query('status') status?: string) {
    const scope = this.authz.condoScope(ctx, 'assembly.view');
    const f = condoFilter(scope, 'a.condominium_id', 3);
    return this.db.tx(dbc(ctx), (q) =>
      q.rows(
        `select a.id, a.code, a.title, a.kind, a.modality, a.status, a.first_call_at, a.second_call_at, a.location,
                a.condominium_id, c.name as condominium_name, a.rules_homologated_at,
                (select count(*)::int from agenda_items i where i.assembly_id = a.id) as agenda_items,
                (select count(*)::int from accreditations x where x.assembly_id = a.id and x.revoked_at is null) as accredited
           from assemblies a join condominiums c on c.id = a.condominium_id
          where ($1::uuid is null or a.condominium_id = $1) and ($2::text is null or a.status = $2) and ${f.sql}
          order by a.first_call_at desc limit 500`,
        [condominiumId ?? null, status ?? null, ...f.params],
      ),
    );
  }

  @Post()
  @RequirePermission('assembly.manage')
  @ZodBody(AssemblyCreateSchema)
  async create(@Ctx() ctx: ReqCtx, @Body(new ZodPipe(AssemblyCreateSchema)) body: AssemblyCreateInput) {
    this.authz.require(ctx, 'assembly.manage', body.condominiumId);
    return this.db.tx(dbc(ctx), async (q) => {
      const condo = await CondominiumsController.loadCondo(q, body.condominiumId);
      const tz = await q.one<{ timezone: string }>('select timezone from condominiums where id = $1', [condo.id]);
      const year = body.firstCallAt.getUTCFullYear();
      const seq = await q.one<{ n: number }>(
        `select count(*)::int + 1 as n from assemblies where condominium_id = $1 and code like $2`, [condo.id, `${year}-%`]);
      const code = `${year}-${String(seq.n).padStart(3, '0')}`;
      const r = await q.one<{ id: string }>(
        `insert into assemblies (tenant_id, condominium_id, code, title, kind, modality, timezone, location,
            first_call_at, second_call_at, permanent_session, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
        [ctx.tenantId, condo.id, code, body.title, body.kind, body.modality, tz.timezone, body.location ?? null,
          body.firstCallAt, body.secondCallAt ?? null, body.permanentSession, ctx.auth.userId],
      );
      await q.exec(
        `insert into assembly_status_history (tenant_id, assembly_id, from_status, to_status, actor_id) values ($1, $2, null, 'draft', $3)`,
        [ctx.tenantId, r.id, ctx.auth.userId],
      );
      await this.audit.record(q, ctx, { action: 'assembly.created', resourceType: 'assembly', resourceId: r.id, assemblyId: r.id, after: { ...body, code } });
      return { id: r.id, code };
    });
  }

  @Get(':id')
  @RequirePermission('assembly.view')
  async get(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(dbc(ctx), async (q) => {
      const a = await this.svc.load(q, id);
      this.authz.require(ctx, 'assembly.view', a.condominium_id);
      // consultas sequenciais: um cliente pg não executa consultas em paralelo
      const condo = await q.one('select id, name, legal_regime, timezone, branding from condominiums where id = $1', [a.condominium_id]);
      const agenda = await q.rows('select * from agenda_items where assembly_id = $1 order by position', [id]);
      const sessions = await q.rows(
          `select s.*, u.full_name as started_by_name from assembly_sessions s left join users u on u.id = s.started_by
            where s.assembly_id = $1 order by s.seq`, [id]);
      const history = await q.rows(
          `select h.from_status, h.to_status, h.reason, h.at, u.full_name as actor from assembly_status_history h
             left join users u on u.id = h.actor_id where h.assembly_id = $1 order by h.at`, [id]);
      const ballots = await q.rows(
          `select b.id, b.agenda_item_id, b.round, b.title, b.question, b.ballot_type, b.max_choices, b.seats, b.secrecy, b.status,
                  b.approval_rule_id, b.presence_rule_id, b.allow_vote_change, b.show_partial_results,
                  b.opened_at, b.closed_at, b.cancel_reason, b.declared_at,
                  r.code as approval_rule_code, r.version as approval_rule_version, r.name as approval_rule_name,
                  (select outcome from ballot_results br where br.id = b.declared_result_id) as declared_outcome,
                  coalesce((select json_agg(json_build_object('id', o.id, 'label', o.label, 'kind', o.kind, 'position', o.position) order by o.position)
                     from ballot_options o where o.ballot_id = b.id), '[]') as options
             from ballots b join quorum_rules r on r.id = b.approval_rule_id
            where b.assembly_id = $1 order by b.created_at`, [id]);
      const r1 = await this.quorum.loadRule(q, a.first_call_presence_rule_id);
      const r2 = await this.quorum.loadRule(q, a.second_call_presence_rule_id);
      return { ...a, condominium: condo, agenda, sessions, history, ballots, firstCallRule: r1, secondCallRule: r2 };
    });
  }

  @Patch(':id')
  @RequirePermission('assembly.manage')
  @ZodBody(AssemblyUpdateSchema)
  async update(
    @Ctx() ctx: ReqCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(AssemblyUpdateSchema)) body: z.infer<typeof AssemblyUpdateSchema>,
  ) {
    return this.db.tx(dbc(ctx), async (q) => {
      const a = await this.svc.load(q, id, true);
      this.authz.require(ctx, 'assembly.manage', a.condominium_id);
      if (!EDITABLE.includes(a.status)) throw conflict('Assembleia só pode ser editada em rascunho ou revisão');
      const first = body.firstCallAt ?? a.first_call_at;
      const second = body.secondCallAt ?? a.second_call_at;
      if (second && second <= first) throw unprocessable('A 2ª convocação deve ser posterior à 1ª');
      await q.exec(
        `update assemblies set title = coalesce($2, title), kind = coalesce($3, kind), modality = coalesce($4, modality),
           location = coalesce($5, location), first_call_at = $6, second_call_at = $7, permanent_session = coalesce($8, permanent_session)
         where id = $1`,
        [id, body.title ?? null, body.kind ?? null, body.modality ?? null, body.location ?? null, first, second, body.permanentSession ?? null],
      );
      await this.audit.record(q, ctx, { action: 'assembly.updated', resourceType: 'assembly', resourceId: id, assemblyId: id, after: body });
      return { ok: true };
    });
  }

  @Post(':id/transition')
  @RequirePermission('assembly.view')
  @ZodBody(TransitionBody)
  async transition(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(TransitionBody)) body: z.infer<typeof TransitionBody>) {
    return this.db.tx(dbc(ctx), (q) => this.svc.transition(q, ctx, id, body.to, body.reason, body.callNumber ?? 1));
  }

  /** Homologação das regras aplicáveis: valida que todas estão homologadas e pertencem ao condomínio. */
  @Post(':id/homologate')
  @RequirePermission('assembly.homologate')
  @ZodBody(AssemblyHomologateSchema)
  async homologate(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(AssemblyHomologateSchema)) body: z.infer<typeof AssemblyHomologateSchema>) {
    return this.db.tx(dbc(ctx), async (q) => {
      const a = await this.svc.load(q, id, true);
      this.authz.require(ctx, 'assembly.homologate', a.condominium_id);
      if (!['draft', 'in_review', 'approved_for_call', 'called', 'accreditation'].includes(a.status)) {
        throw conflict('Homologação não permitida neste estado');
      }
      for (const rid of [body.firstCallPresenceRuleId, body.secondCallPresenceRuleId]) {
        if (!rid) continue;
        const r = await q.maybe<{ condominium_id: string; status: string; purpose: string }>(
          'select condominium_id, status, purpose from quorum_rules where id = $1', [rid]);
        if (!r || r.condominium_id !== a.condominium_id) throw notFound('Regra de presença');
        if (r.status !== 'approved') throw unprocessable('Regra de presença não homologada');
        if (r.purpose !== 'presence') throw unprocessable('A regra informada não é de presença');
      }
      if (body.secondCallPresenceRuleId && !a.second_call_at) throw unprocessable('Assembleia sem 2ª convocação');
      const unapproved = await q.one<{ n: number }>(
        `select count(*)::int as n from ballots b join quorum_rules r on r.id = b.approval_rule_id
          where b.assembly_id = $1 and b.status not in ('cancelled') and r.status <> 'approved'`, [id]);
      if (unapproved.n > 0) throw unprocessable('Há votações com regras não homologadas');
      await q.exec(
        `update assemblies set first_call_presence_rule_id = $2, second_call_presence_rule_id = $3,
            rules_homologated_at = now(), rules_homologated_by = $4, rules_homologation_notes = $5 where id = $1`,
        [id, body.firstCallPresenceRuleId, body.secondCallPresenceRuleId, ctx.auth.userId, body.notes],
      );
      await this.svc.timeline(q, ctx, id, 'rules.homologated', null, { ...body });
      await this.audit.record(q, ctx, { action: 'assembly.rules_homologated', resourceType: 'assembly', resourceId: id, assemblyId: id, after: body });
      return { ok: true };
    });
  }

  // ------------------------------------------------------------------ pauta
  @Post(':id/agenda')
  @RequirePermission('assembly.manage')
  @ZodBody(AgendaItemCreateSchema)
  async addAgenda(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(AgendaItemCreateSchema)) body: z.infer<typeof AgendaItemCreateSchema>) {
    return this.db.tx(dbc(ctx), async (q) => {
      const a = await this.svc.load(q, id, true);
      this.authz.require(ctx, 'assembly.manage', a.condominium_id);
      if (!AGENDA_EDITABLE.includes(a.status)) throw conflict('A pauta não pode ser alterada após a convocação');
      const pos = await q.one<{ n: number }>('select coalesce(max(position), 0)::int + 1 as n from agenda_items where assembly_id = $1', [id]);
      const r = await q.one<{ id: string }>(
        `insert into agenda_items (tenant_id, assembly_id, position, title, description, item_type) values ($1,$2,$3,$4,$5,$6) returning id`,
        [ctx.tenantId, id, pos.n, body.title, body.description ?? null, body.itemType],
      );
      await this.audit.record(q, ctx, { action: 'agenda.item_added', resourceType: 'agenda_item', resourceId: r.id, assemblyId: id, after: body });
      return r;
    });
  }

  @Delete(':id/agenda/:itemId')
  @RequirePermission('assembly.manage')
  async removeAgenda(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string, @Param('itemId', ParseUUIDPipe) itemId: string) {
    return this.db.tx(dbc(ctx), async (q) => {
      const a = await this.svc.load(q, id, true);
      this.authz.require(ctx, 'assembly.manage', a.condominium_id);
      if (!AGENDA_EDITABLE.includes(a.status)) throw conflict('A pauta não pode ser alterada após a convocação');
      const b = await q.one<{ n: number }>('select count(*)::int as n from ballots where agenda_item_id = $1', [itemId]);
      if (b.n > 0) throw conflict('Item possui votação vinculada');
      const n = await q.exec('delete from agenda_items where id = $1 and assembly_id = $2', [itemId, id]);
      if (n !== 1) throw notFound('Item de pauta');
      await q.exec('set constraints all deferred');
      await q.exec(
        `update agenda_items i set position = x.rn from (
           select id, row_number() over (order by position) as rn from agenda_items where assembly_id = $1) x
         where i.id = x.id`, [id]);
      await this.audit.record(q, ctx, { action: 'agenda.item_removed', resourceType: 'agenda_item', resourceId: itemId, assemblyId: id });
      return { ok: true };
    });
  }

  // ------------------------------------------------------------------ consultas
  @Get(':id/timeline')
  @RequirePermission('assembly.view')
  async timeline(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(dbc(ctx), async (q) => {
      const a = await this.svc.load(q, id);
      this.authz.require(ctx, 'assembly.view', a.condominium_id);
      return q.rows(
        `select t.id, t.kind, t.ref_id, t.payload, t.occurred_at, s.seq as session_seq, u.full_name as actor
           from assembly_timeline_events t left join assembly_sessions s on s.id = t.session_id
           left join users u on u.id = t.actor_id
          where t.assembly_id = $1 order by t.occurred_at`, [id]);
    });
  }

  @Get(':id/quorum')
  @RequirePermission('assembly.view')
  async liveQuorum(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(dbc(ctx), async (q) => {
      const a = await this.svc.load(q, id);
      this.authz.require(ctx, 'assembly.view', a.condominium_id);
      return this.quorum.live(q, a);
    });
  }

  /** Simulação de quórum antes da assembleia: quanto é necessário para instalar e aprovar. */
  @Get(':id/quorum/simulation')
  @RequirePermission('assembly.view')
  async simulate(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string, @Query('presentPercent') presentPercent?: string) {
    return this.db.tx(dbc(ctx), async (q) => {
      const a = await this.svc.load(q, id);
      this.authz.require(ctx, 'assembly.view', a.condominium_id);
      const live = await this.quorum.live(q, a);
      const rules = await q.rows<{ id: string; code: string; version: number; name: string; purpose: string; definition: unknown; status: string }>(
        `select id, code, version, name, purpose, definition, status from quorum_rules
          where condominium_id = $1 and status = 'approved' order by purpose, code`, [a.condominium_id]);
      const pct = Math.min(Math.max(Number(presentPercent) || 50, 0), 100);
      const elUnits = live.electorate.units;
      const elFrac = parseFixed(live.electorate.fraction);
      const scenarioPresent = { units: Math.round((elUnits * pct) / 100), fraction: (elFrac * BigInt(Math.round(pct * 100))) / 10000n };
      return {
        scenario: { presentPercent: pct, presentUnits: scenarioPresent.units, presentFraction: formatFixed(scenarioPresent.fraction) },
        electorate: live.electorate,
        note: 'Para regras com base em votos (votes_cast/valid_votes), o valor exigido considera que todos os presentes votem validamente.',
        rules: rules.map((r) => {
          const def = r.definition as RuleDefinition;
          const base = def.purpose === 'presence' || def.base === 'electorate' ? { units: elUnits, fraction: elFrac } : scenarioPresent;
          return {
            id: r.id, code: r.code, version: r.version, name: r.name, purpose: r.purpose,
            evaluation: evaluateThreshold(def, def.purpose === 'presence' ? scenarioPresent : { units: 0, fraction: 0n }, base),
          };
        }),
      };
    });
  }
}
