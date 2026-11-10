import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PoaCreateSchema, PoaReviewSchema, ReasonSchema, type PoaCreateInput } from '@lsg/shared';
import { z } from 'zod';
import { AuditService } from '../../audit/audit.service';
import { AuthzService } from '../../authz/authz.service';
import { Ctx, RequirePermission, TenantScoped, ZodBody, ZodPipe, conflict, notFound, unprocessable, type ReqCtx } from '../../common/http';
import { dbc } from '../../common/scope';
import { DbService, type Q } from '../../db/db.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';

interface PoaRow {
  id: string;
  condominium_id: string;
  grantor_person_id: string;
  attorney_person_id: string;
  scope: 'assembly' | 'general';
  assembly_id: string | null;
  valid_from: Date;
  valid_until: Date | null;
  status: string;
}

/**
 * Procurações: nenhuma procuração é presumida válida. Fluxo: registro (pendente) →
 * conferência documental → aprovação/rejeição fundamentada → (revogação).
 * Conflitos de representação e limites da convenção são verificados na aprovação.
 */
@ApiTags('Procurações')
@ApiBearerAuth()
@TenantScoped()
@Controller()
export class PoaController {
  constructor(
    private readonly db: DbService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly rt: RealtimeGateway,
  ) {}

  @Get('condominiums/:id/poas')
  @RequirePermission('people.view')
  async list(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string, @Query('status') status?: string) {
    this.authz.require(ctx, 'people.view', id);
    return this.db.tx(dbc(ctx), (q) =>
      q.rows(
        `select a.id, a.scope, a.assembly_id, asm.title as assembly_title, a.status, a.valid_from, a.valid_until,
                a.can_vote, a.can_speak, a.restrictions, a.submitted_at, a.reviewed_at, a.review_notes,
                a.revoked_at, a.revoke_reason,
                g.id as grantor_id, g.name as grantor_name, t.id as attorney_id, t.name as attorney_name,
                ru.full_name as reviewed_by_name,
                coalesce((select json_agg(json_build_object('unitId', u.id, 'unit', concat_ws(' - ', b.name, u.identifier)))
                   from poa_units pu join units u on u.id = pu.unit_id left join buildings b on b.id = u.building_id
                  where pu.poa_id = a.id), '[]') as units
           from powers_of_attorney a
           join people g on g.id = a.grantor_person_id
           join people t on t.id = a.attorney_person_id
           left join assemblies asm on asm.id = a.assembly_id
           left join users ru on ru.id = a.reviewed_by
          where a.condominium_id = $1 and ($2::text is null or a.status = $2)
          order by a.submitted_at desc`,
        [id, status ?? null],
      ),
    );
  }

  @Post('condominiums/:id/poas')
  @RequirePermission('poa.submit')
  @ZodBody(PoaCreateSchema)
  async create(
    @Ctx() ctx: ReqCtx,
    @Param('id', ParseUUIDPipe) condominiumId: string,
    @Body(new ZodPipe(PoaCreateSchema)) body: PoaCreateInput,
  ) {
    this.authz.require(ctx, 'poa.submit', condominiumId);
    return this.db.tx(dbc(ctx), async (q) => {
      // Condômino só registra procuração em que ele próprio é o outorgante.
      if (!this.authz.has(ctx, 'poa.review', condominiumId)) {
        const me = await q.maybe<{ id: string }>('select id from people where user_id = $1', [ctx.auth.userId]);
        if (!me || me.id !== body.grantorPersonId) throw unprocessable('Você só pode registrar procurações como outorgante');
      }
      const units = await q.rows<{ id: string; condominium_id: string }>(
        'select id, condominium_id from units where id = any($1::uuid[])', [body.unitIds],
      );
      if (units.length !== body.unitIds.length || units.some((u) => u.condominium_id !== condominiumId)) {
        throw unprocessable('Unidades inválidas para este condomínio');
      }
      // o outorgante deve ser titular ativo de cada unidade
      const owned = await q.rows<{ unit_id: string }>(
        `select unit_id from unit_ownerships where person_id = $1 and ended_at is null and unit_id = any($2::uuid[])`,
        [body.grantorPersonId, body.unitIds],
      );
      const ownedSet = new Set(owned.map((o) => o.unit_id));
      const notOwned = body.unitIds.filter((u) => !ownedSet.has(u));
      if (notOwned.length > 0) throw unprocessable('O outorgante não é titular de todas as unidades informadas', 'GRANTOR_NOT_OWNER', notOwned);
      if (body.assemblyId) {
        const a = await q.maybe('select 1 from assemblies where id = $1 and condominium_id = $2', [body.assemblyId, condominiumId]);
        if (!a) throw notFound('Assembleia');
      }
      const poa = await q.one<{ id: string }>(
        `insert into powers_of_attorney (tenant_id, condominium_id, grantor_person_id, attorney_person_id, scope, assembly_id,
           can_vote, can_speak, restrictions, valid_from, valid_until, submitted_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
        [ctx.tenantId, condominiumId, body.grantorPersonId, body.attorneyPersonId, body.scope, body.assemblyId ?? null,
          body.canVote, body.canSpeak, body.restrictions ?? null, body.validFrom, body.validUntil ?? null, ctx.auth.userId],
      );
      for (const u of body.unitIds) {
        await q.exec('insert into poa_units (tenant_id, poa_id, unit_id) values ($1, $2, $3)', [ctx.tenantId, poa.id, u]);
      }
      await q.exec(`insert into poa_events (tenant_id, poa_id, event, actor_id) values ($1, $2, 'submitted', $3)`, [ctx.tenantId, poa.id, ctx.auth.userId]);
      await this.audit.record(q, ctx, { action: 'poa.submitted', resourceType: 'poa', resourceId: poa.id, assemblyId: body.assemblyId ?? null, after: body });
      return poa;
    });
  }

  private async load(q: Q, id: string, lock = false): Promise<PoaRow> {
    const p = await q.maybe<PoaRow>(`select * from powers_of_attorney where id = $1 ${lock ? 'for update' : ''}`, [id]);
    if (!p) throw notFound('Procuração');
    return p;
  }

  @Get('poas/:id/history')
  @RequirePermission('people.view')
  async history(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(dbc(ctx), async (q) => {
      const p = await this.load(q, id);
      this.authz.require(ctx, 'people.view', p.condominium_id);
      return q.rows(
        `select e.event, e.notes, e.at, u.full_name as actor from poa_events e left join users u on u.id = e.actor_id
          where e.poa_id = $1 order by e.at`,
        [id],
      );
    });
  }

  @Post('poas/:id/review')
  @RequirePermission('poa.review')
  @ZodBody(PoaReviewSchema)
  async review(
    @Ctx() ctx: ReqCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(PoaReviewSchema)) body: z.infer<typeof PoaReviewSchema>,
  ) {
    return this.db.tx(dbc(ctx), async (q) => {
      const p = await this.load(q, id, true);
      this.authz.require(ctx, 'poa.review', p.condominium_id);
      if (p.status !== 'pending') throw conflict('Somente procurações em análise podem ser decididas');

      if (body.decision === 'approve') {
        if (p.valid_until && p.valid_until < new Date()) throw unprocessable('Procuração com validade expirada');
        // Conflito: mesma unidade já representada por outro procurador em procuração aprovada e vigente
        // que alcance o mesmo escopo (geral ou a mesma assembleia).
        const conflicts = await q.rows<{ unit_id: string; poa_id: string; attorney: string }>(
          `select pu.unit_id, a.id as poa_id, t.name as attorney
             from poa_units pu
             join powers_of_attorney a on a.id = pu.poa_id
             join people t on t.id = a.attorney_person_id
            where pu.unit_id in (select unit_id from poa_units where poa_id = $1)
              and a.id <> $1 and a.status = 'approved' and a.attorney_person_id <> $2
              and (a.valid_until is null or a.valid_until > now())
              and (a.scope = 'general' or $3::text = 'general' or a.assembly_id = $4)`,
          [id, p.attorney_person_id, p.scope, p.assembly_id],
        );
        if (conflicts.length > 0) {
          throw conflict('Representação conflitante: unidade já representada por outro procurador. Revogue a anterior antes de aprovar.', 'POA_CONFLICT');
        }
        const condo = await q.one<{ settings: { maxUnitsPerAttorney?: number } }>('select settings from condominiums where id = $1', [p.condominium_id]);
        const limit = condo.settings?.maxUnitsPerAttorney;
        if (limit) {
          const cnt = await q.one<{ n: number }>(
            `select count(distinct pu.unit_id)::int as n from poa_units pu join powers_of_attorney a on a.id = pu.poa_id
              where a.attorney_person_id = $1 and a.condominium_id = $2
                and (a.status = 'approved' or a.id = $3)
                and (a.valid_until is null or a.valid_until > now())`,
            [p.attorney_person_id, p.condominium_id, id],
          );
          if (cnt.n > limit) {
            throw unprocessable(`Limite da convenção excedido: máximo de ${limit} unidade(s) por procurador`, 'POA_LIMIT');
          }
        }
      }
      const status = body.decision === 'approve' ? 'approved' : 'rejected';
      await q.exec(
        `update powers_of_attorney set status = $2, reviewed_by = $3, reviewed_at = now(), review_notes = $4 where id = $1`,
        [id, status, ctx.auth.userId, body.notes || (status === 'approved' ? 'Conferida e aprovada' : null)],
      );
      await q.exec('insert into poa_events (tenant_id, poa_id, event, actor_id, notes) values ($1, $2, $3, $4, $5)', [
        ctx.tenantId, id, status, ctx.auth.userId, body.notes || null,
      ]);
      await this.audit.record(q, ctx, {
        action: `poa.${status}`, resourceType: 'poa', resourceId: id, assemblyId: p.assembly_id,
        before: { status: p.status }, after: { status, notes: body.notes },
      });
      if (p.assembly_id) q.afterCommit(() => this.rt.emitAssembly(ctx.tenantId!, p.assembly_id!, 'quorum.changed'));
      return { ok: true, status };
    });
  }

  /** Revogação: encerra também credenciamentos ativos baseados na procuração. */
  @Post('poas/:id/revoke')
  @RequirePermission('poa.review')
  @ZodBody(ReasonSchema)
  async revoke(
    @Ctx() ctx: ReqCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(ReasonSchema)) body: z.infer<typeof ReasonSchema>,
  ) {
    return this.db.tx(dbc(ctx), async (q) => {
      const p = await this.load(q, id, true);
      this.authz.require(ctx, 'poa.review', p.condominium_id);
      if (!['approved', 'pending'].includes(p.status)) throw conflict('Procuração não está vigente');
      await q.exec(
        `update powers_of_attorney set status = 'revoked', revoked_by = $2, revoked_at = now(), revoke_reason = $3 where id = $1`,
        [id, ctx.auth.userId, body.reason],
      );
      const accs = await q.rows<{ id: string; assembly_id: string }>(
        `update accreditations set revoked_at = now(), revoked_by = $2, revoke_reason = $3
          where poa_id = $1 and revoked_at is null returning id, assembly_id`,
        [id, ctx.auth.userId, `Procuração revogada: ${body.reason}`],
      );
      for (const a of accs) {
        await q.exec(
          `insert into attendance_events (tenant_id, assembly_id, accreditation_id, event, user_id) values ($1, $2, $3, 'accreditation_revoked', $4)`,
          [ctx.tenantId, a.assembly_id, a.id, ctx.auth.userId],
        );
        q.afterCommit(() => this.rt.emitAssembly(ctx.tenantId!, a.assembly_id, 'quorum.changed'));
      }
      await q.exec(`insert into poa_events (tenant_id, poa_id, event, actor_id, notes) values ($1, $2, 'revoked', $3, $4)`, [
        ctx.tenantId, id, ctx.auth.userId, body.reason,
      ]);
      await this.audit.record(q, ctx, {
        action: 'poa.revoked', resourceType: 'poa', resourceId: id, assemblyId: p.assembly_id,
        metadata: { reason: body.reason, accreditationsRevoked: accs.length },
      });
      return { ok: true, accreditationsRevoked: accs.length };
    });
  }
}
