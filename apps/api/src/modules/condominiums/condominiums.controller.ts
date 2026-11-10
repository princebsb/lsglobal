import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  BuildingCreateSchema,
  CondominiumCreateSchema,
  CondominiumUpdateSchema,
  UnitCreateSchema,
  UnitEligibilitySchema,
  UnitImportSchema,
  type CondominiumCreateInput,
  type UnitCreateInput,
} from '@lsg/shared';
import { z } from 'zod';
import { AuditService } from '../../audit/audit.service';
import { AuthzService } from '../../authz/authz.service';
import { Ctx, RequirePermission, TenantScoped, ZodBody, ZodPipe, notFound, type ReqCtx } from '../../common/http';
import { condoFilter, dbc } from '../../common/scope';
import { DbService, type Q } from '../../db/db.service';
import { UnitImportService } from './unit-import.service';

@ApiTags('Condomínios, blocos e unidades')
@ApiBearerAuth()
@TenantScoped()
@Controller('condominiums')
export class CondominiumsController {
  constructor(
    private readonly db: DbService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly importer: UnitImportService,
  ) {}

  static async loadCondo(q: Q, id: string) {
    const c = await q.maybe<{ id: string; legal_regime: string; settings: Record<string, unknown>; name: string }>(
      'select id, name, legal_regime, settings from condominiums where id = $1',
      [id],
    );
    if (!c) throw notFound('Condomínio');
    return c;
  }

  @Get()
  @RequirePermission('condo.view')
  async list(@Ctx() ctx: ReqCtx) {
    const scope = this.authz.condoScope(ctx, 'condo.view');
    const f = condoFilter(scope, 'c.id', 1);
    return this.db.tx(dbc(ctx), (q) =>
      q.rows(
        `select c.id, c.name, c.document, c.type, c.legal_regime, c.timezone, c.status, c.address,
                (select count(*)::int from units u where u.condominium_id = c.id and u.status = 'active') as units,
                (select coalesce(sum(u.ideal_fraction), 0)::text from units u where u.condominium_id = c.id and u.status = 'active') as fraction_sum
           from condominiums c where ${f.sql} order by c.name`,
        f.params,
      ),
    );
  }

  @Post()
  @RequirePermission('condo.manage')
  @ZodBody(CondominiumCreateSchema)
  async create(@Ctx() ctx: ReqCtx, @Body(new ZodPipe(CondominiumCreateSchema)) body: CondominiumCreateInput) {
    // criar condomínio exige perfil no nível do cliente (não apenas em um condomínio)
    if (!this.authz.condoScope(ctx, 'condo.manage').all) this.authz.require(ctx, 'tenant.settings.manage');
    return this.db.tx(dbc(ctx), async (q) => {
      const r = await q.one<{ id: string }>(
        `insert into condominiums (tenant_id, name, document, type, legal_regime, address, timezone, settings)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [ctx.tenantId, body.name, body.document ?? null, body.type, body.legalRegime, body.address, body.timezone, body.settings],
      );
      await this.audit.record(q, ctx, { action: 'condominium.created', resourceType: 'condominium', resourceId: r.id, after: body });
      return r;
    });
  }

  @Get(':id')
  @RequirePermission('condo.view')
  async get(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string) {
    this.authz.require(ctx, 'condo.view', id);
    return this.db.tx(dbc(ctx), async (q) => {
      const c = await q.maybe(
        `select c.*,
           (select count(*)::int from units u where u.condominium_id = c.id and u.status = 'active') as units,
           (select count(*)::int from units u where u.condominium_id = c.id and u.status = 'active' and u.voting_status = 'restricted') as restricted_units,
           (select coalesce(sum(u.ideal_fraction), 0)::text from units u where u.condominium_id = c.id and u.status = 'active') as fraction_sum,
           (select count(*)::int from powers_of_attorney p where p.condominium_id = c.id and p.status = 'pending') as pending_poas
         from condominiums c where c.id = $1`,
        [id],
      );
      if (!c) throw notFound('Condomínio');
      return c;
    });
  }

  @Patch(':id')
  @RequirePermission('condo.manage')
  @ZodBody(CondominiumUpdateSchema)
  async update(
    @Ctx() ctx: ReqCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(CondominiumUpdateSchema)) body: Partial<CondominiumCreateInput>,
  ) {
    this.authz.require(ctx, 'condo.manage', id);
    return this.db.tx(dbc(ctx), async (q) => {
      const before = await q.maybe('select name, document, type, legal_regime, address, timezone, settings from condominiums where id = $1 for update', [id]);
      if (!before) throw notFound('Condomínio');
      await q.exec(
        `update condominiums set
           name = coalesce($2, name), document = coalesce($3, document), type = coalesce($4, type),
           legal_regime = coalesce($5, legal_regime), address = coalesce($6, address),
           timezone = coalesce($7, timezone), settings = coalesce($8, settings)
         where id = $1`,
        [id, body.name ?? null, body.document ?? null, body.type ?? null, body.legalRegime ?? null,
          body.address ?? null, body.timezone ?? null, body.settings ?? null],
      );
      await this.audit.record(q, ctx, { action: 'condominium.updated', resourceType: 'condominium', resourceId: id, before, after: body });
      return { ok: true };
    });
  }

  // ------------------------------------------------------------------ blocos
  @Get(':id/buildings')
  @RequirePermission('condo.view')
  async buildings(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string) {
    this.authz.require(ctx, 'condo.view', id);
    return this.db.tx(dbc(ctx), (q) =>
      q.rows(
        `select b.*, (select count(*)::int from units u where u.building_id = b.id) as units
           from buildings b where b.condominium_id = $1 order by b.name`,
        [id],
      ),
    );
  }

  @Post(':id/buildings')
  @RequirePermission('condo.manage')
  @ZodBody(BuildingCreateSchema)
  async createBuilding(
    @Ctx() ctx: ReqCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(BuildingCreateSchema)) body: z.infer<typeof BuildingCreateSchema>,
  ) {
    this.authz.require(ctx, 'condo.manage', id);
    return this.db.tx(dbc(ctx), async (q) => {
      await CondominiumsController.loadCondo(q, id);
      const r = await q.one<{ id: string }>(
        'insert into buildings (tenant_id, condominium_id, name, kind) values ($1, $2, $3, $4) returning id',
        [ctx.tenantId, id, body.name, body.kind],
      );
      await this.audit.record(q, ctx, { action: 'building.created', resourceType: 'building', resourceId: r.id, after: body });
      return r;
    });
  }

  // ------------------------------------------------------------------ unidades
  @Get(':id/units')
  @RequirePermission('condo.view')
  async units(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string) {
    this.authz.require(ctx, 'condo.view', id);
    return this.db.tx(dbc(ctx), (q) =>
      q.rows(
        `select u.id, u.identifier, u.kind, u.ideal_fraction::text as ideal_fraction, u.voting_status,
                u.voting_restriction_reason, u.status, u.building_id, b.name as building_name,
                coalesce((select json_agg(json_build_object(
                    'ownershipId', o.id, 'personId', p.id, 'name', p.name, 'relation', o.relation,
                    'isVotingRepresentative', o.is_voting_representative, 'document', p.document_masked
                  ) order by o.is_voting_representative desc, p.name)
                  from unit_ownerships o join people p on p.id = o.person_id
                  where o.unit_id = u.id and o.ended_at is null), '[]') as owners
           from units u left join buildings b on b.id = u.building_id
          where u.condominium_id = $1
          order by b.name nulls first, u.identifier`,
        [id],
      ),
    );
  }

  @Post(':id/units')
  @RequirePermission('condo.manage')
  @ZodBody(UnitCreateSchema)
  async createUnit(
    @Ctx() ctx: ReqCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(UnitCreateSchema)) body: UnitCreateInput,
  ) {
    this.authz.require(ctx, 'condo.manage', id);
    return this.db.tx(dbc(ctx), async (q) => {
      await CondominiumsController.loadCondo(q, id);
      if (body.buildingId) {
        const b = await q.maybe('select 1 from buildings where id = $1 and condominium_id = $2', [body.buildingId, id]);
        if (!b) throw notFound('Bloco');
      }
      const r = await q.one<{ id: string }>(
        `insert into units (tenant_id, condominium_id, building_id, identifier, kind, ideal_fraction)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [ctx.tenantId, id, body.buildingId ?? null, body.identifier, body.kind, body.idealFraction],
      );
      await this.audit.record(q, ctx, { action: 'unit.created', resourceType: 'unit', resourceId: r.id, after: body });
      return r;
    });
  }

  /** Restrição/liberação do direito de voto da unidade (ex.: art. 1.335, III), sempre fundamentada. */
  @Patch(':id/units/:unitId/eligibility')
  @RequirePermission('condo.manage')
  @ZodBody(UnitEligibilitySchema)
  async setEligibility(
    @Ctx() ctx: ReqCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('unitId', ParseUUIDPipe) unitId: string,
    @Body(new ZodPipe(UnitEligibilitySchema)) body: z.infer<typeof UnitEligibilitySchema>,
  ) {
    this.authz.require(ctx, 'condo.manage', id);
    return this.db.tx(dbc(ctx), async (q) => {
      const before = await q.maybe('select voting_status, voting_restriction_reason from units where id = $1 and condominium_id = $2 for update', [unitId, id]);
      if (!before) throw notFound('Unidade');
      await q.exec('update units set voting_status = $2, voting_restriction_reason = $3 where id = $1', [
        unitId, body.votingStatus, body.votingStatus === 'restricted' ? body.reason : null,
      ]);
      await this.audit.record(q, ctx, { action: 'unit.eligibility_changed', resourceType: 'unit', resourceId: unitId, before, after: body });
      return { ok: true };
    });
  }

  /** Importação por planilha (linhas já convertidas pelo cliente). dryRun=true apenas valida. */
  @Post(':id/units/import')
  @RequirePermission('condo.manage', 'people.manage')
  @ZodBody(UnitImportSchema)
  async importUnits(
    @Ctx() ctx: ReqCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(UnitImportSchema)) body: z.infer<typeof UnitImportSchema>,
  ) {
    this.authz.require(ctx, 'condo.manage', id);
    this.authz.require(ctx, 'people.manage', id);
    return this.importer.run(ctx, id, body.rows, body.dryRun);
  }
}
