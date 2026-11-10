import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  RULE_TEMPLATES,
  ReasonSchema,
  RuleApproveSchema,
  RuleCreateSchema,
  RuleDefinitionSchema,
  RuleFromTemplateSchema,
  describeRule,
  type RuleCreateInput,
} from '@lsg/shared';
import { z } from 'zod';
import { AuditService } from '../../audit/audit.service';
import { AuthzService } from '../../authz/authz.service';
import { Ctx, RequirePermission, TenantScoped, ZodBody, ZodPipe, conflict, notFound, unprocessable, type ReqCtx } from '../../common/http';
import { dbc } from '../../common/scope';
import { DbService, type Q } from '../../db/db.service';
import { CondominiumsController } from '../condominiums/condominiums.controller';

interface RuleRow {
  id: string;
  condominium_id: string;
  code: string;
  version: number;
  name: string;
  purpose: string;
  legal_basis: string;
  definition: unknown;
  status: string;
  effective_from: string;
  template_code: string | null;
}

/**
 * Regras de quórum e aprovação — versionadas e imutáveis após homologação.
 * Modelos legais são apenas pontos de partida, copiados como rascunho.
 */
@ApiTags('Regras de quórum')
@ApiBearerAuth()
@TenantScoped()
@Controller()
export class RulesController {
  constructor(
    private readonly db: DbService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
  ) {}

  @Get('rule-templates')
  @RequirePermission('rules.manage')
  templates() {
    return RULE_TEMPLATES.map((t) => ({ ...t, description: describeRule(t.definition), requiresLegalValidation: true }));
  }

  @Get('condominiums/:id/rules')
  @RequirePermission('condo.view')
  async list(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string) {
    this.authz.require(ctx, 'condo.view', id);
    const rows = await this.db.tx(dbc(ctx), (q) =>
      q.rows<RuleRow & { approved_by_name: string | null; approved_at: Date | null; approval_notes: string | null }>(
        `select r.*, u.full_name as approved_by_name from quorum_rules r left join users u on u.id = r.approved_by
          where r.condominium_id = $1 order by r.code, r.version desc`,
        [id],
      ),
    );
    return rows.map((r) => {
      const def = RuleDefinitionSchema.safeParse(r.definition);
      return { ...r, description: def.success ? describeRule(def.data) : 'Definição inválida' };
    });
  }

  private async nextVersion(q: Q, condominiumId: string, code: string): Promise<number> {
    const r = await q.one<{ v: number }>(
      'select coalesce(max(version), 0)::int + 1 as v from quorum_rules where condominium_id = $1 and code = $2',
      [condominiumId, code],
    );
    return r.v;
  }

  @Post('condominiums/:id/rules')
  @RequirePermission('rules.manage')
  @ZodBody(RuleCreateSchema)
  async create(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(RuleCreateSchema)) body: RuleCreateInput) {
    this.authz.require(ctx, 'rules.manage', id);
    return this.db.tx(dbc(ctx), async (q) => {
      await CondominiumsController.loadCondo(q, id);
      const version = await this.nextVersion(q, id, body.code);
      const r = await q.one<{ id: string }>(
        `insert into quorum_rules (tenant_id, condominium_id, code, version, name, purpose, legal_basis, definition, effective_from, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
        [ctx.tenantId, id, body.code, version, body.name, body.definition.purpose, body.legalBasis,
          JSON.stringify(body.definition), body.effectiveFrom, ctx.auth.userId],
      );
      await this.audit.record(q, ctx, { action: 'rule.created', resourceType: 'quorum_rule', resourceId: r.id, after: { ...body, version } });
      return { id: r.id, version };
    });
  }

  @Post('condominiums/:id/rules/from-template')
  @RequirePermission('rules.manage')
  @ZodBody(RuleFromTemplateSchema)
  async fromTemplate(
    @Ctx() ctx: ReqCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(RuleFromTemplateSchema)) body: z.infer<typeof RuleFromTemplateSchema>,
  ) {
    this.authz.require(ctx, 'rules.manage', id);
    const t = RULE_TEMPLATES.find((x) => x.code === body.templateCode);
    if (!t) throw notFound('Modelo de regra');
    return this.db.tx(dbc(ctx), async (q) => {
      const condo = await CondominiumsController.loadCondo(q, id);
      if (condo.legal_regime === 'associacao' && !t.code.startsWith('ASSOC-')) {
        throw unprocessable('Modelos de condomínio edilício não se aplicam automaticamente a associações');
      }
      const version = await this.nextVersion(q, id, t.code);
      const r = await q.one<{ id: string }>(
        `insert into quorum_rules (tenant_id, condominium_id, code, version, name, purpose, legal_basis, definition,
           effective_from, template_code, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,current_date,$9,$10) returning id`,
        [ctx.tenantId, id, t.code, version, t.name, t.definition.purpose, t.legalBasis, JSON.stringify(t.definition), t.code, ctx.auth.userId],
      );
      await this.audit.record(q, ctx, { action: 'rule.created_from_template', resourceType: 'quorum_rule', resourceId: r.id, metadata: { template: t.code, version } });
      return { id: r.id, version };
    });
  }

  private async load(q: Q, id: string, lock = false): Promise<RuleRow> {
    const r = await q.maybe<RuleRow>(`select * from quorum_rules where id = $1 ${lock ? 'for update' : ''}`, [id]);
    if (!r) throw notFound('Regra');
    return r;
  }

  /** Homologação: torna a regra vigente e imutável. Exige fundamento registrado. */
  @Post('rules/:id/approve')
  @RequirePermission('rules.approve')
  @ZodBody(RuleApproveSchema)
  async approve(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(RuleApproveSchema)) body: z.infer<typeof RuleApproveSchema>) {
    return this.db.tx(dbc(ctx), async (q) => {
      const r = await this.load(q, id, true);
      this.authz.require(ctx, 'rules.approve', r.condominium_id);
      if (r.status !== 'draft') throw conflict('Somente regras em rascunho podem ser homologadas');
      const def = RuleDefinitionSchema.safeParse(r.definition);
      if (!def.success) throw unprocessable('Definição da regra inválida');
      await q.exec(
        `update quorum_rules set status = 'approved', approved_by = $2, approved_at = now(), approval_notes = $3 where id = $1`,
        [id, ctx.auth.userId, body.notes],
      );
      await this.audit.record(q, ctx, {
        action: 'rule.approved', resourceType: 'quorum_rule', resourceId: id,
        after: { code: r.code, version: r.version, definition: r.definition, legalBasis: r.legal_basis, notes: body.notes },
      });
      return { ok: true };
    });
  }

  @Post('rules/:id/retire')
  @RequirePermission('rules.approve')
  @ZodBody(ReasonSchema)
  async retire(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ReasonSchema)) body: z.infer<typeof ReasonSchema>) {
    return this.db.tx(dbc(ctx), async (q) => {
      const r = await this.load(q, id, true);
      this.authz.require(ctx, 'rules.approve', r.condominium_id);
      if (r.status === 'draft') {
        await q.exec('delete from quorum_rules where id = $1', [id]);
      } else if (r.status === 'approved') {
        await q.exec(`update quorum_rules set status = 'retired', retired_at = now() where id = $1`, [id]);
      } else throw conflict('Regra já retirada');
      await this.audit.record(q, ctx, { action: 'rule.retired', resourceType: 'quorum_rule', resourceId: id, metadata: { reason: body.reason, wasDraft: r.status === 'draft' } });
      return { ok: true };
    });
  }

  /** Nova versão (rascunho) a partir de uma regra existente, com definição opcionalmente alterada. */
  @Post('rules/:id/new-version')
  @RequirePermission('rules.manage')
  async newVersion(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string, @Body() raw: unknown) {
    const Body2 = z.object({ definition: RuleDefinitionSchema.optional(), legalBasis: z.string().min(3).max(1000).optional() });
    const body = new ZodPipe(Body2).transform(raw ?? {});
    return this.db.tx(dbc(ctx), async (q) => {
      const r = await this.load(q, id);
      this.authz.require(ctx, 'rules.manage', r.condominium_id);
      const version = await this.nextVersion(q, r.condominium_id, r.code);
      const def = body.definition ?? r.definition;
      const n = await q.one<{ id: string }>(
        `insert into quorum_rules (tenant_id, condominium_id, code, version, name, purpose, legal_basis, definition,
           effective_from, template_code, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,current_date,$9,$10) returning id`,
        [ctx.tenantId, r.condominium_id, r.code, version, r.name, (def as { purpose: string }).purpose,
          body.legalBasis ?? r.legal_basis, JSON.stringify(def), r.template_code, ctx.auth.userId],
      );
      await this.audit.record(q, ctx, { action: 'rule.new_version', resourceType: 'quorum_rule', resourceId: n.id, metadata: { from: id, version } });
      return { id: n.id, version };
    });
  }
}
