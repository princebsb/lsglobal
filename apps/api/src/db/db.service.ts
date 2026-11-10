import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { env } from '../config/env';

export interface DbContext {
  tenantId?: string | null;
  userId?: string | null;
  /** Habilita leitura da cadeia de auditoria da plataforma e indicadores globais. */
  isPlatform?: boolean;
}

/** Executor de consultas tipado sobre um cliente em transação. */
export class Q {
  /** Ações executadas somente após COMMIT bem-sucedido (ex.: notificações em tempo real). */
  readonly afterCommitHooks: (() => void)[] = [];

  constructor(readonly client: PoolClient) {}

  afterCommit(fn: () => void): void {
    this.afterCommitHooks.push(fn);
  }

  async rows<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.client.query<T>(sql, params)).rows;
  }

  async maybe<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return (await this.client.query<T>(sql, params)).rows[0];
  }

  async one<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<T> {
    const r = await this.client.query<T>(sql, params);
    if (r.rows.length !== 1) throw new Error(`Esperado 1 registro, obtido ${r.rows.length}`);
    return r.rows[0]!;
  }

  async exec(sql: string, params: unknown[] = []): Promise<number> {
    return (await this.client.query(sql, params)).rowCount ?? 0;
  }
}

/**
 * Acesso ao PostgreSQL com o papel da aplicação (sujeito a RLS).
 * Toda operação roda em transação com o tenant definido via set_config(..., true),
 * de modo que o isolamento é garantido pelo banco mesmo diante de erro na aplicação.
 */
@Injectable()
export class DbService implements OnModuleDestroy {
  readonly pool: Pool;

  constructor() {
    this.pool = new Pool({
      connectionString: env().appDatabaseUrl,
      max: env().DB_POOL_MAX,
      application_name: 'lsg-api',
      statement_timeout: 15_000,
    });
  }

  async tx<T>(
    ctx: DbContext,
    fn: (q: Q) => Promise<T>,
    opts: { isolation?: 'read committed' | 'repeatable read' | 'serializable' } = {},
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(`begin isolation level ${opts.isolation ?? 'read committed'}`);
      await client.query(
        `select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true), set_config('app.is_platform', $3, true)`,
        [ctx.tenantId ?? '', ctx.userId ?? '', ctx.isPlatform ? 'on' : 'off'],
      );
      const q = new Q(client);
      const result = await fn(q);
      await client.query('commit');
      for (const h of q.afterCommitHooks) {
        try {
          h();
        } catch {
          /* notificações não podem afetar a operação já confirmada */
        }
      }
      return result;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async ping(): Promise<boolean> {
    const r = await this.pool.query('select 1 as ok');
    return r.rows[0]?.ok === 1;
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
