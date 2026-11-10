import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  OwnershipCreateSchema,
  PersonCreateSchema,
  ReasonSchema,
  maskDocument,
  type OwnershipCreateInput,
  type PersonCreateInput,
} from '@lsg/shared';
import { z } from 'zod';
import { AuditService } from '../../audit/audit.service';
import { AuthzService } from '../../authz/authz.service';
import { CryptoService } from '../../common/crypto.service';
import { Ctx, RequirePermission, TenantScoped, ZodBody, ZodPipe, conflict, notFound, type ReqCtx } from '../../common/http';
import { dbc } from '../../common/scope';
import { DbService } from '../../db/db.service';

/**
 * Pessoas físicas/jurídicas e vínculos com unidades.
 * Documentos são armazenados criptografados; listagens exibem somente a máscara.
 * A revelação do documento completo exige permissão específica e é auditada.
 */
@ApiTags('Condôminos e vínculos')
@ApiBearerAuth()
@TenantScoped()
@Controller('people')
export class PeopleController {
  constructor(
    private readonly db: DbService,
    private readonly crypto: CryptoService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('people.view')
  async list(@Ctx() ctx: ReqCtx, @Query('condominiumId') condominiumId?: string, @Query('search') search?: string) {
    if (condominiumId) this.authz.require(ctx, 'people.view', condominiumId);
    else if (!this.authz.condoScope(ctx, 'people.view').all) this.authz.require(ctx, 'tenant.settings.manage');
    return this.db.tx(dbc(ctx), (q) =>
      q.rows(
        `select p.id, p.kind, p.name, p.document_masked as document, p.email, p.phone, p.status, p.user_id is not null as has_user,
                coalesce((select json_agg(json_build_object(
                   'ownershipId', o.id, 'unitId', u.id, 'unit', concat_ws(' - ', b.name, u.identifier),
                   'relation', o.relation, 'isVotingRepresentative', o.is_voting_representative,
                   'condominiumId', u.condominium_id))
                  from unit_ownerships o join units u on u.id = o.unit_id left join buildings b on b.id = u.building_id
                  where o.person_id = p.id and o.ended_at is null), '[]') as units
           from people p
          where ($1::uuid is null or exists (
                   select 1 from unit_ownerships o join units u on u.id = o.unit_id
                    where o.person_id = p.id and o.ended_at is null and u.condominium_id = $1)
                 or exists (select 1 from powers_of_attorney a where a.attorney_person_id = p.id and a.condominium_id = $1)
                 -- pessoas recém-cadastradas, ainda sem qualquer vínculo, ficam visíveis para vinculação
                 or (not exists (select 1 from unit_ownerships o where o.person_id = p.id and o.ended_at is null)
                     and not exists (select 1 from powers_of_attorney a where a.attorney_person_id = p.id or a.grantor_person_id = p.id)))
            and ($2::text is null or p.name ilike '%' || $2 || '%' or p.document_hash = $3)
          order by p.name limit 1000`,
        [condominiumId ?? null, search?.trim() || null, search ? this.crypto.blindIndex(search.replace(/\D+/g, '')) : null],
      ),
    );
  }

  @Post()
  @RequirePermission('people.manage')
  @ZodBody(PersonCreateSchema)
  async create(@Ctx() ctx: ReqCtx, @Body(new ZodPipe(PersonCreateSchema)) body: PersonCreateInput) {
    const hash = this.crypto.blindIndex(body.document);
    return this.db.tx(dbc(ctx), async (q) => {
      const dup = await q.maybe<{ id: string }>('select id from people where document_hash = $1', [hash]);
      if (dup) throw conflict('Já existe pessoa cadastrada com este documento', 'PERSON_DUPLICATE');
      if ((body.kind === 'pf') !== (body.document.length === 11)) throw conflict('Tipo de pessoa incompatível com o documento');
      const r = await q.one<{ id: string }>(
        `insert into people (tenant_id, kind, name, document_enc, document_hash, document_masked, email, phone)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [ctx.tenantId, body.kind, body.name, this.crypto.encrypt(body.document), hash, maskDocument(body.document),
          body.email ?? null, body.phone ?? null],
      );
      await this.audit.record(q, ctx, {
        action: 'person.created', resourceType: 'person', resourceId: r.id,
        after: { kind: body.kind, name: body.name, document: maskDocument(body.document) },
      });
      return r;
    });
  }

  @Get(':id/document')
  @RequirePermission('people.view_sensitive')
  async revealDocument(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(dbc(ctx), async (q) => {
      const p = await q.maybe<{ document_enc: string }>('select document_enc from people where id = $1', [id]);
      if (!p) throw notFound('Pessoa');
      await this.audit.record(q, ctx, { action: 'person.document_revealed', resourceType: 'person', resourceId: id });
      return { document: this.crypto.decrypt(p.document_enc) };
    });
  }

  @Post('ownerships')
  @RequirePermission('people.manage')
  @ZodBody(OwnershipCreateSchema)
  async addOwnership(@Ctx() ctx: ReqCtx, @Body(new ZodPipe(OwnershipCreateSchema)) body: OwnershipCreateInput) {
    return this.db.tx(dbc(ctx), async (q) => {
      const unit = await q.maybe<{ condominium_id: string }>('select condominium_id from units where id = $1', [body.unitId]);
      if (!unit) throw notFound('Unidade');
      this.authz.require(ctx, 'people.manage', unit.condominium_id);
      const person = await q.maybe('select 1 from people where id = $1', [body.personId]);
      if (!person) throw notFound('Pessoa');
      if (body.isVotingRepresentative) {
        // apenas um representante votante por unidade: o anterior deixa de sê-lo (com auditoria)
        const prev = await q.rows<{ id: string }>(
          `select id from unit_ownerships where unit_id = $1 and ended_at is null and is_voting_representative`,
          [body.unitId],
        );
        if (prev.length > 0) {
          await q.exec(`update unit_ownerships set is_voting_representative = false where id = any($1::uuid[])`, [prev.map((p) => p.id)]);
        }
      }
      const r = await q.one<{ id: string }>(
        `insert into unit_ownerships (tenant_id, unit_id, person_id, relation, share_percent, is_voting_representative)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [ctx.tenantId, body.unitId, body.personId, body.relation, body.sharePercent ?? null, body.isVotingRepresentative],
      );
      await this.audit.record(q, ctx, { action: 'ownership.created', resourceType: 'unit', resourceId: body.unitId, after: body });
      return r;
    });
  }

  @Post('ownerships/:id/voting-representative')
  @RequirePermission('people.manage')
  async designate(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(dbc(ctx), async (q) => {
      const o = await q.maybe<{ unit_id: string; condominium_id: string }>(
        `select o.unit_id, u.condominium_id from unit_ownerships o join units u on u.id = o.unit_id
          where o.id = $1 and o.ended_at is null for update of o`,
        [id],
      );
      if (!o) throw notFound('Vínculo');
      this.authz.require(ctx, 'people.manage', o.condominium_id);
      await q.exec('update unit_ownerships set is_voting_representative = false where unit_id = $1 and ended_at is null', [o.unit_id]);
      await q.exec('update unit_ownerships set is_voting_representative = true where id = $1', [id]);
      await this.audit.record(q, ctx, { action: 'ownership.voting_representative', resourceType: 'unit', resourceId: o.unit_id, after: { ownershipId: id } });
      return { ok: true };
    });
  }

  @Delete('ownerships/:id')
  @RequirePermission('people.manage')
  @ZodBody(ReasonSchema)
  async endOwnership(
    @Ctx() ctx: ReqCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(ReasonSchema)) body: z.infer<typeof ReasonSchema>,
  ) {
    return this.db.tx(dbc(ctx), async (q) => {
      const o = await q.maybe<{ unit_id: string; condominium_id: string }>(
        `select o.unit_id, u.condominium_id from unit_ownerships o join units u on u.id = o.unit_id where o.id = $1 and o.ended_at is null`,
        [id],
      );
      if (!o) throw notFound('Vínculo');
      this.authz.require(ctx, 'people.manage', o.condominium_id);
      await q.exec('update unit_ownerships set ended_at = now(), ended_reason = $2, is_voting_representative = false where id = $1', [id, body.reason]);
      await this.audit.record(q, ctx, { action: 'ownership.ended', resourceType: 'unit', resourceId: o.unit_id, metadata: { ownershipId: id, reason: body.reason } });
      return { ok: true };
    });
  }
}
