import type { DbContext } from '../db/db.service';
import type { ReqCtx } from './http';

export const dbc = (ctx: ReqCtx): DbContext => ({ tenantId: ctx.tenantId, userId: ctx.auth.userId });

/** Gera cláusula SQL "coluna = any($n)" quando o escopo de condomínios é restrito. */
export function condoFilter(
  scope: { all: true } | { all: false; ids: string[] },
  column: string,
  paramIndex: number,
): { sql: string; params: unknown[] } {
  if (scope.all) return { sql: 'true', params: [] };
  return { sql: `${column} = any($${paramIndex}::uuid[])`, params: [scope.ids] };
}
