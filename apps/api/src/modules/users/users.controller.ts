import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AssignmentCreateSchema, ROLE_BY_CODE, ROLES, UserCreateSchema } from '@lsg/shared';
import { z } from 'zod';
import { AuditService } from '../../audit/audit.service';
import { CryptoService } from '../../common/crypto.service';
import {
  Ctx, RequirePermission, TenantScoped, ZodBody, ZodPipe, forbidden, notFound, unprocessable, type ReqCtx,
} from '../../common/http';
import { DbService, type Q } from '../../db/db.service';

@ApiTags('Usuários e perfis do cliente')
@ApiBearerAuth()
@TenantScoped()
@Controller('users')
export class UsersController {
  constructor(
    private readonly db: DbService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  @Get('roles')
  @RequirePermission('tenant.users.manage')
  roles() {
    return ROLES.filter((r) => r.scope !== 'platform').map((r) => ({
      code: r.code, name: r.name, scope: r.scope, requiresMfa: r.requiresMfa, permissions: r.permissions,
    }));
  }

  @Get()
  @RequirePermission('tenant.users.manage')
  async list(@Ctx() ctx: ReqCtx) {
    return this.db.tx({ tenantId: ctx.tenantId, userId: ctx.auth.userId }, (q) =>
      q.rows(
        `select u.id, u.email, u.full_name, u.status, u.mfa_enabled, u.last_login_at,
                coalesce(json_agg(json_build_object(
                  'id', a.id, 'roleCode', a.role_code, 'condominiumId', a.condominium_id, 'condominiumName', c.name
                ) order by a.created_at), '[]') as assignments
           from user_role_assignments a
           join users u on u.id = a.user_id
           left join condominiums c on c.id = a.condominium_id
          where a.tenant_id = $1 and a.revoked_at is null
          group by u.id order by u.full_name`,
        [ctx.tenantId],
      ),
    );
  }

  private async validateAssignment(q: Q, roleCode: string, condominiumId?: string) {
    const role = ROLE_BY_CODE.get(roleCode);
    if (!role || role.scope === 'platform') throw unprocessable('Perfil inválido para clientes');
    if (role.scope === 'tenant' && condominiumId) throw unprocessable('Perfil de cliente não é vinculado a condomínio');
    if (role.scope === 'condominium') {
      if (!condominiumId) throw unprocessable('Informe o condomínio do perfil');
      const c = await q.maybe('select 1 from condominiums where id = $1', [condominiumId]);
      if (!c) throw notFound('Condomínio');
    }
  }

  /** Cria (ou reaproveita, pelo e-mail) um usuário e atribui um perfil no cliente. */
  @Post()
  @RequirePermission('tenant.users.manage')
  @ZodBody(UserCreateSchema)
  async create(@Ctx() ctx: ReqCtx, @Body(new ZodPipe(UserCreateSchema)) body: z.infer<typeof UserCreateSchema>) {
    const hash = await this.crypto.hashPassword(body.password);
    return this.db.tx({ tenantId: ctx.tenantId, userId: ctx.auth.userId }, async (q) => {
      await this.validateAssignment(q, body.roleCode, body.condominiumId);
      let user = await q.maybe<{ id: string }>('select id from users where email = $1', [body.email]);
      const created = !user;
      if (!user) {
        user = await q.one<{ id: string }>(
          'insert into users (email, full_name, password_hash) values ($1, $2, $3) returning id',
          [body.email, body.fullName, hash],
        );
      }
      await q.exec(
        `insert into user_role_assignments (user_id, role_code, tenant_id, condominium_id, granted_by)
         values ($1, $2, $3, $4, $5)`,
        [user.id, body.roleCode, ctx.tenantId, body.condominiumId ?? null, ctx.auth.userId],
      );
      if (body.personId) {
        const n = await q.exec('update people set user_id = $2 where id = $1 and user_id is null', [body.personId, user.id]);
        if (n !== 1) throw unprocessable('Pessoa inexistente ou já vinculada a outro usuário');
      }
      await this.audit.record(q, ctx, {
        action: 'user.assigned', resourceType: 'user', resourceId: user.id,
        after: { roleCode: body.roleCode, condominiumId: body.condominiumId ?? null, personId: body.personId ?? null, created },
      });
      return { id: user.id, created };
    });
  }

  @Post('assignments')
  @RequirePermission('tenant.users.manage')
  @ZodBody(AssignmentCreateSchema)
  async assign(@Ctx() ctx: ReqCtx, @Body(new ZodPipe(AssignmentCreateSchema)) body: z.infer<typeof AssignmentCreateSchema>) {
    return this.db.tx({ tenantId: ctx.tenantId, userId: ctx.auth.userId }, async (q) => {
      await this.validateAssignment(q, body.roleCode, body.condominiumId);
      const r = await q.one<{ id: string }>(
        `insert into user_role_assignments (user_id, role_code, tenant_id, condominium_id, granted_by)
         values ($1, $2, $3, $4, $5) returning id`,
        [body.userId, body.roleCode, ctx.tenantId, body.condominiumId ?? null, ctx.auth.userId],
      );
      await this.audit.record(q, ctx, {
        action: 'user.assigned', resourceType: 'user', resourceId: body.userId,
        after: { roleCode: body.roleCode, condominiumId: body.condominiumId ?? null },
      });
      return r;
    });
  }

  @Delete('assignments/:id')
  @RequirePermission('tenant.users.manage')
  async revoke(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx({ tenantId: ctx.tenantId, userId: ctx.auth.userId }, async (q) => {
      const a = await q.maybe<{ user_id: string; role_code: string }>(
        'select user_id, role_code from user_role_assignments where id = $1 and tenant_id = $2 and revoked_at is null',
        [id, ctx.tenantId],
      );
      if (!a) throw notFound('Atribuição');
      if (a.user_id === ctx.auth.userId && a.role_code === 'tenant_admin') {
        throw forbidden('Não é permitido remover o próprio perfil de administrador');
      }
      await q.exec('update user_role_assignments set revoked_at = now(), revoked_by = $2 where id = $1', [id, ctx.auth.userId]);
      await this.audit.record(q, ctx, { action: 'user.unassigned', resourceType: 'user', resourceId: a.user_id, before: a });
      return { ok: true };
    });
  }
}
