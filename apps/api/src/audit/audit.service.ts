import { Injectable, Logger } from '@nestjs/common';
import { DbService, type Q } from '../db/db.service';
import type { AnonCtx, ReqCtx } from '../common/http';

export interface AuditEvent {
  action: string;
  resourceType: string;
  resourceId?: string | null;
  assemblyId?: string | null;
  outcome?: 'success' | 'denied' | 'failure';
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
  /** Sobrescreve o tenant do contexto (ex.: criação de tenant pela plataforma). */
  tenantId?: string | null;
  actorUserId?: string | null;
}

type AnyCtx = ReqCtx | (AnonCtx & { auth?: undefined; tenantId?: null });

/**
 * Trilha de auditoria append-only com cadeia de hash (ver migração 0001).
 * record() deve ser chamado dentro da mesma transação da operação auditada,
 * garantindo atomicidade entre a ação e seu registro.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger('Audit');

  constructor(private readonly db: DbService) {}

  async record(q: Q, ctx: AnyCtx, ev: AuditEvent): Promise<void> {
    const tenantId = ev.tenantId !== undefined ? ev.tenantId : (ctx.tenantId ?? null);
    const actor = ev.actorUserId !== undefined ? ev.actorUserId : (ctx.auth?.userId ?? null);
    const metadata = { ...(ev.metadata ?? {}), ...(ctx.auth && 'platformAccess' in ctx && ctx.platformAccess ? { platformAccess: true } : {}) };
    await q.exec(
      `insert into audit_events
        (chain_key, chain_seq, tenant_id, actor_user_id, action, resource_type, resource_id, assembly_id,
         request_id, correlation_id, ip, user_agent, outcome, before_state, after_state, metadata, prev_hash, hash)
       values ('', 0, $1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10, $11, $12, $13, '', '')`,
      [
        tenantId,
        actor,
        ev.action,
        ev.resourceType,
        ev.resourceId ?? null,
        ev.assemblyId ?? null,
        ctx.requestId || null,
        ctx.ip || null,
        ctx.userAgent || null,
        ev.outcome ?? 'success',
        ev.before === undefined ? null : JSON.stringify(ev.before),
        ev.after === undefined ? null : JSON.stringify(ev.after),
        JSON.stringify(metadata),
      ],
    );
  }

  /** Registro fora de transação de negócio (ex.: login negado, acesso negado). Nunca lança. */
  async recordStandalone(ctx: AnyCtx, ev: AuditEvent): Promise<void> {
    try {
      const tenantId = ev.tenantId !== undefined ? ev.tenantId : (ctx.tenantId ?? null);
      await this.db.tx({ tenantId, userId: ctx.auth?.userId ?? null }, (q) => this.record(q, ctx, ev));
    } catch (err) {
      this.logger.error({ err, ev }, 'Falha ao gravar auditoria avulsa');
    }
  }
}
