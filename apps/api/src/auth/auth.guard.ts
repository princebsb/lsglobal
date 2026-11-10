import { BadRequestException, CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Permission } from '@lsg/shared';
import { AuditService } from '../audit/audit.service';
import { AuthzService } from '../authz/authz.service';
import {
  ALLOW_PENDING_MFA,
  IS_PUBLIC,
  REQUIRE_TENANT,
  REQUIRED_PERMISSIONS,
  type AppRequest,
  type ReqCtx,
} from '../common/http';
import { DbService } from '../db/db.service';
import { AuthService, type AccessClaims } from './auth.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Guard global: autenticação (JWT + sessão ativa), MFA obrigatório para perfis administrativos,
 * contexto de tenant (X-Tenant-Id) e verificação grosseira de permissão.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly auth: AuthService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly db: DbService,
  ) {}

  async canActivate(ec: ExecutionContext): Promise<boolean> {
    if (ec.getType() !== 'http') return true;
    const targets = [ec.getHandler(), ec.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ec.switchToHttp().getRequest<AppRequest>();
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new UnauthorizedException('Autenticação necessária');

    let claims: AccessClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessClaims>(token);
    } catch {
      throw new UnauthorizedException('Token inválido ou expirado');
    }
    if (claims.typ !== 'access') throw new UnauthorizedException('Token inválido');
    const user = await this.auth.loadAuthUser(claims);

    if (user.mfaEnrollmentRequired && !this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_MFA, targets)) {
      throw new ForbiddenException({ message: 'Configure a autenticação em dois fatores para continuar', code: 'MFA_ENROLLMENT_REQUIRED' });
    }

    const ctx: ReqCtx = {
      auth: user,
      tenantId: null,
      platformAccess: false,
      requestId: req.requestId ?? '',
      ip: req.ip ?? '',
      userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300),
    };

    const tenantHeader = req.headers['x-tenant-id'];
    const tenantId = Array.isArray(tenantHeader) ? tenantHeader[0] : tenantHeader;
    if (tenantId) {
      if (!UUID_RE.test(tenantId)) throw new BadRequestException('X-Tenant-Id inválido');
      const member = user.assignments.some((a) => a.tenantId === tenantId);
      const platform = this.authz.permissions(user, null).has('platform.tenants.access');
      if (!member && !platform) {
        await this.audit.recordStandalone({ ...ctx }, {
          action: 'tenant.access', resourceType: 'tenant', resourceId: tenantId, outcome: 'denied',
          metadata: { path: req.path },
        });
        throw new ForbiddenException('Sem acesso a este cliente');
      }
      const active = await this.db.tx({}, (q) =>
        q.maybe<{ status: string }>('select status from tenants where id = $1', [tenantId]),
      );
      if (!active || active.status !== 'active') throw new ForbiddenException('Cliente inexistente ou inativo');
      ctx.tenantId = tenantId;
      ctx.platformAccess = !member;
    }

    if (this.reflector.getAllAndOverride<boolean>(REQUIRE_TENANT, targets) && !ctx.tenantId) {
      throw new BadRequestException('Selecione o cliente (cabeçalho X-Tenant-Id)');
    }

    const perms = this.reflector.getAllAndOverride<Permission[]>(REQUIRED_PERMISSIONS, targets) ?? [];
    if (perms.length > 0) {
      const effective = this.authz.permissions(user, ctx.tenantId);
      const missing = perms.filter((p) => !effective.has(p));
      if (missing.length > 0) {
        await this.audit.recordStandalone(ctx, {
          action: 'authz.denied', resourceType: 'route', resourceId: req.route?.path ?? req.path, outcome: 'denied',
          metadata: { missing, method: req.method },
        });
        throw new ForbiddenException(`Permissão necessária: ${missing.join(', ')}`);
      }
    }

    req.ctx = ctx;
    return true;
  }
}
