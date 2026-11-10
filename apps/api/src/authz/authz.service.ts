import { Injectable } from '@nestjs/common';
import { ROLE_BY_CODE, type Permission } from '@lsg/shared';
import { forbidden, type AuthUser, type ReqCtx } from '../common/http';

export type CondoScope = { all: true } | { all: false; ids: string[] };

/**
 * Autorização contextual: permissão + escopo (plataforma, tenant, condomínio).
 * Perfis de plataforma só valem dentro de um tenant quando há acesso administrativo
 * autorizado (platform.tenants.access) — e nunca concedem direito de voto.
 */
@Injectable()
export class AuthzService {
  /** Permissões efetivas no tenant; se condominiumId for informado, restringe ao condomínio. */
  permissions(auth: AuthUser, tenantId: string | null, condominiumId?: string): Set<Permission> {
    const out = new Set<Permission>();
    for (const a of auth.assignments) {
      const role = ROLE_BY_CODE.get(a.roleCode);
      if (!role) continue;
      let applies = false;
      if (role.scope === 'platform') {
        applies = auth.isPlatformStaff && a.tenantId === null;
      } else if (tenantId && a.tenantId === tenantId) {
        applies = a.condominiumId === null || condominiumId === undefined || a.condominiumId === condominiumId;
      }
      if (applies) role.permissions.forEach((p) => out.add(p));
    }
    return out;
  }

  has(ctx: ReqCtx, perm: Permission, condominiumId?: string): boolean {
    return this.permissions(ctx.auth, ctx.tenantId, condominiumId).has(perm);
  }

  require(ctx: ReqCtx, perm: Permission, condominiumId?: string): void {
    if (!this.has(ctx, perm, condominiumId)) throw forbidden(`Permissão necessária: ${perm}`);
  }

  /** Condomínios em que o usuário possui a permissão (para filtrar listagens). */
  condoScope(ctx: ReqCtx, perm: Permission): CondoScope {
    const ids: string[] = [];
    for (const a of ctx.auth.assignments) {
      const role = ROLE_BY_CODE.get(a.roleCode);
      if (!role || !role.permissions.includes(perm)) continue;
      if (role.scope === 'platform' && ctx.auth.isPlatformStaff && a.tenantId === null) return { all: true };
      if (a.tenantId === ctx.tenantId) {
        if (a.condominiumId === null) return { all: true };
        ids.push(a.condominiumId);
      }
    }
    return { all: false, ids };
  }

  requiresMfa(auth: Pick<AuthUser, 'assignments'>): boolean {
    return auth.assignments.some((a) => ROLE_BY_CODE.get(a.roleCode)?.requiresMfa);
  }
}
