import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { BallotCreateSchema, ReasonSchema, VoteCastSchema, type BallotCreateInput, type VoteCastInput } from '@lsg/shared';
import { z } from 'zod';
import { AuthzService } from '../../authz/authz.service';
import { Ctx, RequirePermission, TenantScoped, ZodBody, ZodPipe, forbidden, type ReqCtx } from '../../common/http';
import { dbc } from '../../common/scope';
import { DbService } from '../../db/db.service';
import { AssembliesService } from '../assemblies/assemblies.service';
import { VotingService } from './voting.service';

@ApiTags('Votações')
@ApiBearerAuth()
@TenantScoped()
@Controller()
export class VotingController {
  constructor(
    private readonly db: DbService,
    private readonly authz: AuthzService,
    private readonly voting: VotingService,
    private readonly assemblies: AssembliesService,
  ) {}

  @Post('assemblies/:id/ballots')
  @RequirePermission('assembly.view')
  @ZodBody(BallotCreateSchema)
  create(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(BallotCreateSchema)) body: BallotCreateInput) {
    return this.voting.create(ctx, id, body);
  }

  @Post('ballots/:id/open')
  @HttpCode(200)
  @RequirePermission('assembly.conduct')
  open(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string) {
    return this.voting.open(ctx, id);
  }

  @Post('ballots/:id/close')
  @HttpCode(200)
  @RequirePermission('assembly.conduct')
  close(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string) {
    return this.voting.close(ctx, id);
  }

  @Post('ballots/:id/tally')
  @HttpCode(200)
  @RequirePermission('assembly.conduct')
  tally(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string) {
    return this.voting.tally(ctx, id);
  }

  @Post('ballots/:id/declare')
  @HttpCode(200)
  @RequirePermission('assembly.conduct')
  declare(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string) {
    return this.voting.declare(ctx, id);
  }

  @Post('ballots/:id/cancel')
  @HttpCode(200)
  @RequirePermission('assembly.conduct')
  @ZodBody(ReasonSchema)
  cancel(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ReasonSchema)) body: z.infer<typeof ReasonSchema>) {
    return this.voting.cancel(ctx, id, body.reason);
  }

  @Post('ballots/:id/new-round')
  @RequirePermission('assembly.conduct')
  newRound(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string) {
    return this.voting.newRound(ctx, id);
  }

  /** Registro de voto. Retorna sucesso somente após persistência confirmada. */
  @Post('ballots/:id/votes')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @RequirePermission('assembly.attend')
  @ZodBody(VoteCastSchema)
  cast(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(VoteCastSchema)) body: VoteCastInput) {
    return this.voting.cast(ctx, id, body);
  }

  /** Detalhe da votação com contadores e, quando permitido, a apuração. */
  @Get('ballots/:id')
  @RequirePermission('assembly.view')
  async detail(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(dbc(ctx), async (q) => {
      const b = await this.voting.loadBallot(q, id);
      const a = await this.assemblies.load(q, b.assembly_id);
      this.authz.require(ctx, 'assembly.view', a.condominium_id);
      const conduct = this.authz.has(ctx, 'assembly.conduct', a.condominium_id);
      const options = await q.rows('select id, label, kind, position from ballot_options where ballot_id = $1 order by position', [id]);
      const votes = await q.one<{ n: number }>(
        b.secrecy === 'secret'
          ? 'select count(*)::int as n from vote_participations where ballot_id = $1'
          : 'select count(distinct unit_id)::int as n from votes where ballot_id = $1',
        [id],
      );
      let result: unknown = null;
      let partial: unknown = null;
      if (['tallied', 'declared'].includes(b.status) && (conduct || (b.status === 'declared' && this.authz.has(ctx, 'results.view', a.condominium_id)))) {
        result = await q.maybe(
          `select id, computed_at, outcome, declarable, tally, rule_snapshot, result_hash, votes_head_hash
             from ballot_results where ballot_id = $1 ${b.status === 'declared' ? 'and id = $2' : 'order by computed_at desc limit 1'}`,
          b.status === 'declared' ? [id, b.declared_result_id] : [id],
        );
      } else if (b.status === 'open' && b.secrecy === 'nominal' && (b.show_partial_results || conduct)) {
        partial = (await this.voting.computeTally(q, b, a, 'partial')).tally;
      }
      return {
        id: b.id, assemblyId: b.assembly_id, agendaItemId: b.agenda_item_id, round: b.round, title: b.title, question: b.question,
        ballotType: b.ballot_type, maxChoices: b.max_choices, seats: b.seats, secrecy: b.secrecy, status: b.status,
        allowVoteChange: b.allow_vote_change, showPartialResults: b.show_partial_results,
        openedAt: b.opened_at, closedAt: b.closed_at, callNumber: b.call_number,
        electorate: { units: b.electorate_units, fraction: b.electorate_fraction },
        votesReceived: votes.n, options, result, partial,
      };
    });
  }

  /** Votos nominais individuais — somente votações não sigilosas, após o encerramento. */
  @Get('ballots/:id/votes')
  @RequirePermission('votes.view_nominal')
  async nominal(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(dbc(ctx), async (q) => {
      const b = await this.voting.loadBallot(q, id);
      const a = await this.assemblies.load(q, b.assembly_id);
      this.authz.require(ctx, 'votes.view_nominal', a.condominium_id);
      if (b.secrecy === 'secret') throw forbidden('Votação sigilosa: votos individuais não são acessíveis');
      if (!['closed', 'tallied', 'declared'].includes(b.status)) throw forbidden('Votos individuais disponíveis somente após o encerramento');
      return q.rows(
        `select v.unit_id, concat_ws(' - ', bd.name, u.identifier) as unit, v.ideal_fraction::text as ideal_fraction,
                p.name as voter, v.basis, v.version, v.cast_at, v.hash,
                (select array_agg(o.label order by o.position) from ballot_options o where o.id = any(v.option_ids)) as choices,
                (select count(*)::int from votes v2 where v2.ballot_id = v.ballot_id and v2.unit_id = v.unit_id) as versions
           from (select distinct on (unit_id) * from votes where ballot_id = $1 order by unit_id, version desc) v
           join units u on u.id = v.unit_id left join buildings bd on bd.id = u.building_id
           join people p on p.id = v.cast_by_person_id
          order by bd.name nulls first, u.identifier`,
        [id],
      );
    });
  }

  /** Conferência de comprovante de voto pelo próprio votante ou pela mesa. */
  @Get('ballots/:id/receipts/:code')
  @RequirePermission('assembly.view')
  async receipt(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string, @Param('code') code: string) {
    return this.db.tx(dbc(ctx), async (q) => {
      const b = await this.voting.loadBallot(q, id);
      const a = await this.assemblies.load(q, b.assembly_id);
      this.authz.require(ctx, 'assembly.view', a.condominium_id);
      const row = await q.maybe<{ cast_by_user_id: string; unit_id: string; cast_at: Date; version: number; latest: number }>(
        b.secrecy === 'secret'
          ? `select cast_by_user_id, unit_id, cast_at, 1 as version, 1 as latest from vote_participations where ballot_id = $1 and receipt_code = $2`
          : `select cast_by_user_id, unit_id, cast_at, version,
                    (select max(version) from votes v2 where v2.ballot_id = v.ballot_id and v2.unit_id = v.unit_id) as latest
               from votes v where ballot_id = $1 and receipt_code = $2`,
        [id, code.toUpperCase()],
      );
      if (!row || (row.cast_by_user_id !== ctx.auth.userId && !this.authz.has(ctx, 'assembly.conduct', a.condominium_id))) {
        return { valid: false };
      }
      return { valid: true, unitId: row.unit_id, castAt: row.cast_at, version: row.version, superseded: row.version < row.latest };
    });
  }

  /** Visão do participante: unidades que pode representar, credenciamentos e votações. */
  @Get('assemblies/:id/my')
  @RequirePermission('assembly.view')
  async my(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(dbc(ctx), async (q) => {
      const a = await this.assemblies.load(q, id);
      this.authz.require(ctx, 'assembly.view', a.condominium_id);
      const me = await q.maybe<{ id: string; name: string }>(`select id, name from people where user_id = $1`, [ctx.auth.userId]);
      if (!me) return { person: null, units: [], ballots: [] };
      const units = await q.rows(
        `select u.id as unit_id, concat_ws(' - ', b.name, u.identifier) as unit, u.ideal_fraction::text as ideal_fraction,
                u.voting_status, 'titular' as basis, null::uuid as poa_id, o.is_voting_representative,
                (select count(*)::int from unit_ownerships o2 where o2.unit_id = u.id and o2.ended_at is null) as owners
           from unit_ownerships o join units u on u.id = o.unit_id left join buildings b on b.id = u.building_id
          where o.person_id = $1 and o.ended_at is null and u.condominium_id = $2 and u.status = 'active'
         union all
         select u.id, concat_ws(' - ', b.name, u.identifier), u.ideal_fraction::text, u.voting_status, 'procuracao', p.id, false, 0
           from powers_of_attorney p join poa_units pu on pu.poa_id = p.id join units u on u.id = pu.unit_id
           left join buildings b on b.id = u.building_id
          where p.attorney_person_id = $1 and p.condominium_id = $2 and p.status = 'approved' and p.can_vote
            and p.valid_from <= now() and (p.valid_until is null or p.valid_until > now())
            and (p.scope = 'general' or p.assembly_id = $3)`,
        [me.id, a.condominium_id, id],
      );
      const accs = await q.rows<{ id: string; unit_id: string; person_id: string; mode: string; basis: string }>(
        'select id, unit_id, person_id, mode, basis from accreditations where assembly_id = $1 and revoked_at is null and unit_id = any($2::uuid[])',
        [id, units.map((u) => (u as { unit_id: string }).unit_id)],
      );
      const ballots = await q.rows<{ id: string; secrecy: string }>(
        `select b.id, b.title, b.question, b.ballot_type, b.max_choices, b.secrecy, b.status, b.allow_vote_change, b.round,
                coalesce((select json_agg(json_build_object('id', o.id, 'label', o.label, 'kind', o.kind) order by o.position)
                   from ballot_options o where o.ballot_id = b.id), '[]') as options
           from ballots b where b.assembly_id = $1 and b.status in ('open','closed','tallied','declared')
          order by b.opened_at desc nulls last`,
        [id],
      );
      const out = [];
      for (const b of ballots) {
        const mine = await q.rows(
          b.secrecy === 'secret'
            ? `select unit_id, receipt_code, 1 as version, cast_at from vote_participations where ballot_id = $1 and cast_by_user_id = $2`
            : `select distinct on (unit_id) unit_id, receipt_code, version, cast_at from votes where ballot_id = $1 and cast_by_user_id = $2 order by unit_id, version desc`,
          [b.id, ctx.auth.userId],
        );
        out.push({ ...b, myVotes: mine });
      }
      return {
        person: me,
        units: units.map((u) => {
          const uu = u as { unit_id: string };
          const acc = accs.find((x) => x.unit_id === uu.unit_id);
          return { ...u, accreditation: acc ? { id: acc.id, mine: acc.person_id === me.id, mode: acc.mode, basis: acc.basis } : null };
        }),
        ballots: out,
      };
    });
  }
}
