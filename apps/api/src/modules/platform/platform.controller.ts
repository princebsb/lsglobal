import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { TenantCreateSchema, type TenantCreateInput } from '@lsg/shared';
import { z } from 'zod';
import { AuditService } from '../../audit/audit.service';
import { CryptoService } from '../../common/crypto.service';
import { Ctx, RequirePermission, ZodBody, ZodPipe, conflict, notFound, type ReqCtx } from '../../common/http';
import { DbService } from '../../db/db.service';

const TenantStatusSchema = z.object({
  status: z.enum(['active', 'suspended', 'closed']),
  reason: z.string().trim().min(5).max(1000),
});

@ApiTags('Plataforma LS Global')
@ApiBearerAuth()
@Controller('platform')
export class PlatformController {
  constructor(
    private readonly db: DbService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  @Get('overview')
  @RequirePermission('platform.dashboard.view')
  async overview(@Ctx() ctx: ReqCtx) {
    return this.db.tx({ userId: ctx.auth.userId, isPlatform: true }, async (q) => {
      const metrics = await q.rows<{ metric: string; value: string }>('select * from platform_overview()');
      return Object.fromEntries(metrics.map((m) => [m.metric, Number(m.value)]));
    });
  }

  @Get('tenants')
  @RequirePermission('platform.tenants.access')
  async listTenants(@Ctx() ctx: ReqCtx, @Query('search') search?: string) {
    return this.db.tx({ userId: ctx.auth.userId }, (q) =>
      q.rows(
        `select t.id, t.name, t.kind, t.document, t.status, t.created_at,
                (select count(*)::int from user_role_assignments a where a.tenant_id = t.id and a.revoked_at is null) as assignments
           from tenants t
          where ($1::text is null or t.name ilike '%' || $1 || '%')
          order by t.name limit 500`,
        [search?.trim() || null],
      ),
    );
  }

  /** Cria o cliente contratante e seu primeiro administrador (perfil tenant_admin). */
  @Post('tenants')
  @RequirePermission('platform.tenants.manage')
  @ZodBody(TenantCreateSchema)
  async createTenant(@Ctx() ctx: ReqCtx, @Body(new ZodPipe(TenantCreateSchema)) body: TenantCreateInput) {
    const passwordHash = await this.crypto.hashPassword(body.admin.password);
    return this.db.tx({ userId: ctx.auth.userId }, async (q) => {
      if (body.document) {
        const dup = await q.maybe('select 1 from tenants where document = $1', [body.document]);
        if (dup) throw conflict('Já existe cliente com este CNPJ');
      }
      const tenant = await q.one<{ id: string }>(
        `insert into tenants (name, kind, document) values ($1, $2, $3) returning id`,
        [body.name, body.kind, body.document ?? null],
      );
      let user = await q.maybe<{ id: string }>('select id from users where email = $1', [body.admin.email]);
      if (!user) {
        user = await q.one<{ id: string }>(
          `insert into users (email, full_name, password_hash) values ($1, $2, $3) returning id`,
          [body.admin.email, body.admin.fullName, passwordHash],
        );
      }
      await q.exec(
        `insert into user_role_assignments (user_id, role_code, tenant_id, granted_by) values ($1, 'tenant_admin', $2, $3)`,
        [user.id, tenant.id, ctx.auth.userId],
      );
      await this.audit.record(q, ctx, {
        tenantId: null,
        action: 'tenant.created',
        resourceType: 'tenant',
        resourceId: tenant.id,
        after: { name: body.name, kind: body.kind, adminUserId: user.id },
      });
      return { id: tenant.id, adminUserId: user.id };
    });
  }

  @Patch('tenants/:id/status')
  @RequirePermission('platform.tenants.manage')
  @ZodBody(TenantStatusSchema)
  async setStatus(
    @Ctx() ctx: ReqCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(TenantStatusSchema)) body: z.infer<typeof TenantStatusSchema>,
  ) {
    return this.db.tx({ userId: ctx.auth.userId }, async (q) => {
      const before = await q.maybe<{ status: string }>('select status from tenants where id = $1 for update', [id]);
      if (!before) throw notFound('Cliente');
      await q.exec('update tenants set status = $2 where id = $1', [id, body.status]);
      await this.audit.record(q, ctx, {
        tenantId: null, action: 'tenant.status_changed', resourceType: 'tenant', resourceId: id,
        before, after: { status: body.status }, metadata: { reason: body.reason },
      });
      return { ok: true };
    });
  }

  @Get('audit')
  @RequirePermission('platform.audit.view')
  async platformAudit(@Ctx() ctx: ReqCtx, @Query('limit') limit?: string) {
    const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
    return this.db.tx({ userId: ctx.auth.userId, isPlatform: true }, (q) =>
      q.rows(
        `select e.id, e.chain_seq, e.tenant_id, e.actor_user_id, u.email as actor_email, e.action, e.resource_type,
                e.resource_id, e.outcome, e.metadata, e.occurred_at, e.hash
           from audit_events e left join users u on u.id = e.actor_user_id
          where e.chain_key = 'platform' order by e.chain_seq desc limit $1`,
        [n],
      ),
    );
  }

  @Get('audit/verify')
  @RequirePermission('platform.audit.view')
  async verifyPlatformChain(@Ctx() ctx: ReqCtx) {
    return this.db.tx({ userId: ctx.auth.userId, isPlatform: true }, (q) =>
      q.one(`select checked::int, valid, first_invalid_seq, head_hash from audit_verify_chain('platform')`),
    );
  }
}
