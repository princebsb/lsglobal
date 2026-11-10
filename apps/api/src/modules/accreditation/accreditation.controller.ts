import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AccreditSchema, ReasonSchema, SelfAccreditSchema } from '@lsg/shared';
import { z } from 'zod';
import { AuditService } from '../../audit/audit.service';
import { AuthzService } from '../../authz/authz.service';
import { Ctx, RequirePermission, TenantScoped, ZodBody, ZodPipe, conflict, forbidden, notFound, unprocessable, type ReqCtx } from '../../common/http';
import { dbc } from '../../common/scope';
import { DbService, type Q } from '../../db/db.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { AssembliesService, type AssemblyRow } from '../assemblies/assemblies.service';

export interface Representation {
  basis: 'titular' | 'procuracao';
  poaId: string | null;
}

/**
 * Determina se a pessoa pode representar a unidade na assembleia.
 * - Titular: vínculo ativo e (representante designado OU único titular da unidade).
 * - Procurador: procuração APROVADA, vigente, com poder de voto, abrangendo a unidade e a assembleia.
 */
export async function resolveRepresentation(
  q: Q,
  a: AssemblyRow,
  unitId: string,
  personId: string,
  poaId?: string | null,
): Promise<Representation> {
  const unit = await q.maybe<{ condominium_id: string; status: string }>('select condominium_id, status from units where id = $1', [unitId]);
  if (!unit || unit.condominium_id !== a.condominium_id || unit.status !== 'active') throw notFound('Unidade');

  if (poaId) {
    const p = await q.maybe<{ id: string }>(
      `select p.id from powers_of_attorney p join poa_units pu on pu.poa_id = p.id
        where p.id = $1 and pu.unit_id = $2 and p.attorney_person_id = $3 and p.status = 'approved' and p.can_vote
          and p.valid_from <= now() and (p.valid_until is null or p.valid_until > now())
          and (p.scope = 'general' or p.assembly_id = $4)`,
      [poaId, unitId, personId, a.id],
    );
    if (!p) throw unprocessable('Procuração inexistente, não aprovada, fora da validade ou sem poderes para esta unidade/assembleia', 'POA_INVALID');
    return { basis: 'procuracao', poaId };
  }

  const owners = await q.rows<{ person_id: string; is_voting_representative: boolean }>(
    'select person_id, is_voting_representative from unit_ownerships where unit_id = $1 and ended_at is null',
    [unitId],
  );
  const mine = owners.find((o) => o.person_id === personId);
  if (!mine) throw unprocessable('A pessoa não é titular da unidade. Para representá-la é necessária procuração aprovada.', 'NOT_OWNER');
  const designated = owners.find((o) => o.is_voting_representative);
  if (owners.length > 1 && !designated) {
    throw unprocessable('Unidade com coproprietários sem representante designado. Designe o representante antes do credenciamento.', 'COOWNERS_NO_REPRESENTATIVE');
  }
  if (designated && designated.person_id !== personId) {
    throw unprocessable('Outro coproprietário é o representante designado desta unidade.', 'NOT_DESIGNATED');
  }
  return { basis: 'titular', poaId: null };
}

@ApiTags('Credenciamento')
@ApiBearerAuth()
@TenantScoped()
@Controller()
export class AccreditationController {
  constructor(
    private readonly db: DbService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly svc: AssembliesService,
    private readonly rt: RealtimeGateway,
  ) {}

  /** Lista unidades com possíveis representantes e situação do credenciamento (busca por nome/unidade). */
  @Get('assemblies/:id/accreditation/candidates')
  @RequirePermission('assembly.accredit')
  async candidates(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string, @Query('search') search?: string) {
    return this.db.tx(dbc(ctx), async (q) => {
      const a = await this.svc.load(q, id);
      this.authz.require(ctx, 'assembly.accredit', a.condominium_id);
      return q.rows(
        `select u.id as unit_id, concat_ws(' - ', b.name, u.identifier) as unit, u.ideal_fraction::text as ideal_fraction, u.voting_status,
                acc.id as accreditation_id, acc.mode, acc.basis, acc.accredited_at, ap.name as accredited_person,
                coalesce((select json_agg(json_build_object('personId', p.id, 'name', p.name, 'document', p.document_masked,
                    'relation', o.relation, 'isVotingRepresentative', o.is_voting_representative))
                   from unit_ownerships o join people p on p.id = o.person_id
                  where o.unit_id = u.id and o.ended_at is null), '[]') as owners,
                coalesce((select json_agg(json_build_object('poaId', pa.id, 'personId', t.id, 'name', t.name, 'document', t.document_masked))
                   from powers_of_attorney pa join poa_units pu on pu.poa_id = pa.id join people t on t.id = pa.attorney_person_id
                  where pu.unit_id = u.id and pa.status = 'approved' and pa.can_vote
                    and pa.valid_from <= now() and (pa.valid_until is null or pa.valid_until > now())
                    and (pa.scope = 'general' or pa.assembly_id = $1)), '[]') as attorneys
           from units u
           left join buildings b on b.id = u.building_id
           left join accreditations acc on acc.unit_id = u.id and acc.assembly_id = $1 and acc.revoked_at is null
           left join people ap on ap.id = acc.person_id
          where u.condominium_id = $2 and u.status = 'active'
            and ($3::text is null or u.identifier ilike '%' || $3 || '%' or b.name ilike '%' || $3 || '%'
                 or exists (select 1 from unit_ownerships o join people p on p.id = o.person_id
                             where o.unit_id = u.id and o.ended_at is null and p.name ilike '%' || $3 || '%'))
          order by b.name nulls first, u.identifier`,
        [id, a.condominium_id, search?.trim() || null],
      );
    });
  }

  @Get('assemblies/:id/accreditations')
  @RequirePermission('assembly.view')
  async list(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(dbc(ctx), async (q) => {
      const a = await this.svc.load(q, id);
      this.authz.require(ctx, 'assembly.view', a.condominium_id);
      const canSeeNames = this.authz.has(ctx, 'assembly.accredit', a.condominium_id) || this.authz.has(ctx, 'assembly.conduct', a.condominium_id);
      return q.rows(
        `select x.id, x.unit_id, concat_ws(' - ', b.name, u.identifier) as unit, u.ideal_fraction::text as ideal_fraction,
                ${canSeeNames ? 'p.name' : `left(p.name, 1) || '***'`} as person_name, x.basis, x.mode, x.accredited_at,
                x.revoked_at, x.revoke_reason, ub.full_name as accredited_by_name
           from accreditations x join units u on u.id = x.unit_id left join buildings b on b.id = u.building_id
           join people p on p.id = x.person_id left join users ub on ub.id = x.accredited_by
          where x.assembly_id = $1 order by x.accredited_at desc`,
        [id],
      );
    });
  }

  private async accredit(q: Q, ctx: ReqCtx, a: AssemblyRow, unitId: string, personId: string, mode: 'presencial' | 'remoto', poaId?: string | null) {
    this.svc.ensureAccreditationOpen(a);
    const rep = await resolveRepresentation(q, a, unitId, personId, poaId);
    const existing = await q.maybe<{ id: string; person_id: string }>(
      'select id, person_id from accreditations where assembly_id = $1 and unit_id = $2 and revoked_at is null for update',
      [a.id, unitId],
    );
    if (existing) {
      if (existing.person_id === personId) throw conflict('Unidade já credenciada por esta pessoa', 'ALREADY_ACCREDITED');
      throw conflict('Unidade já credenciada por outro representante. Revogue o credenciamento anterior para substituí-lo.', 'UNIT_ALREADY_ACCREDITED');
    }
    const r = await q.one<{ id: string }>(
      `insert into accreditations (tenant_id, assembly_id, unit_id, person_id, basis, poa_id, mode, accredited_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [ctx.tenantId, a.id, unitId, personId, rep.basis, rep.poaId, mode, ctx.auth.userId],
    );
    await q.exec(
      `insert into attendance_events (tenant_id, assembly_id, accreditation_id, person_id, user_id, event, mode) values ($1,$2,$3,$4,$5,'accredited',$6)`,
      [ctx.tenantId, a.id, r.id, personId, ctx.auth.userId, mode],
    );
    await this.audit.record(q, ctx, {
      action: 'accreditation.created', resourceType: 'accreditation', resourceId: r.id, assemblyId: a.id,
      after: { unitId, personId, mode, basis: rep.basis, poaId: rep.poaId },
    });
    q.afterCommit(() => this.rt.emitAssembly(ctx.tenantId!, a.id, 'quorum.changed'));
    return { id: r.id, ...rep };
  }

  /** Credenciamento por operador (presencial ou remoto assistido). */
  @Post('assemblies/:id/accreditations')
  @RequirePermission('assembly.accredit')
  @ZodBody(AccreditSchema)
  async create(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(AccreditSchema)) body: z.infer<typeof AccreditSchema>) {
    return this.db.tx(dbc(ctx), async (q) => {
      const a = await this.svc.load(q, id);
      this.authz.require(ctx, 'assembly.accredit', a.condominium_id);
      return this.accredit(q, ctx, a, body.unitId, body.personId, body.mode, body.poaId);
    });
  }

  /** Autocredenciamento remoto do condômino/procurador logado. */
  @Post('assemblies/:id/accreditations/self')
  @RequirePermission('assembly.attend')
  @ZodBody(SelfAccreditSchema)
  async self(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(SelfAccreditSchema)) body: z.infer<typeof SelfAccreditSchema>) {
    return this.db.tx(dbc(ctx), async (q) => {
      const a = await this.svc.load(q, id);
      this.authz.require(ctx, 'assembly.attend', a.condominium_id);
      const me = await q.maybe<{ id: string }>('select id from people where user_id = $1 and status = $2', [ctx.auth.userId, 'active']);
      if (!me) throw forbidden('Seu usuário não está vinculado a um cadastro de condômino neste cliente');
      return this.accredit(q, ctx, a, body.unitId, me.id, 'remoto', body.poaId);
    });
  }

  @Post('accreditations/:accId/revoke')
  @RequirePermission('assembly.accredit')
  @ZodBody(ReasonSchema)
  async revoke(@Ctx() ctx: ReqCtx, @Param('accId', ParseUUIDPipe) accId: string, @Body(new ZodPipe(ReasonSchema)) body: z.infer<typeof ReasonSchema>) {
    return this.db.tx(dbc(ctx), async (q) => {
      const acc = await q.maybe<{ assembly_id: string; person_id: string }>(
        'select assembly_id, person_id from accreditations where id = $1 and revoked_at is null for update', [accId]);
      if (!acc) throw notFound('Credenciamento ativo');
      const a = await this.svc.load(q, acc.assembly_id);
      this.authz.require(ctx, 'assembly.accredit', a.condominium_id);
      await q.exec('update accreditations set revoked_at = clock_timestamp(), revoked_by = $2, revoke_reason = $3 where id = $1', [accId, ctx.auth.userId, body.reason]);
      await q.exec(
        `insert into attendance_events (tenant_id, assembly_id, accreditation_id, person_id, user_id, event) values ($1,$2,$3,$4,$5,'accreditation_revoked')`,
        [ctx.tenantId, a.id, accId, acc.person_id, ctx.auth.userId],
      );
      await this.audit.record(q, ctx, { action: 'accreditation.revoked', resourceType: 'accreditation', resourceId: accId, assemblyId: a.id, metadata: { reason: body.reason } });
      q.afterCommit(() => this.rt.emitAssembly(ctx.tenantId!, a.id, 'quorum.changed'));
      return { ok: true };
    });
  }
}
