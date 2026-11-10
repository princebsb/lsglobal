/**
 * Executor de migrações SQL versionadas (arquivos apps/api/migrations/NNNN_nome.sql).
 * - Cada arquivo roda em transação própria.
 * - Checksum SHA-256 impede alteração silenciosa de migração já aplicada.
 * - Após as migrações, sincroniza o catálogo de perfis/permissões e modelos de regras
 *   a partir do pacote @lsg/shared (fonte única da matriz de permissões).
 *
 * Uso: npm run db:migrate            (banco de desenvolvimento)
 *      NODE_ENV=test npm run db:migrate
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { PERMISSIONS, ROLES, RULE_TEMPLATES } from '@lsg/shared';
import { env } from '../config/env';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

export async function runMigrations(dbName?: string, log: (m: string) => void = console.log): Promise<void> {
  const e = env();
  const client = new Client({ connectionString: e.adminDatabaseUrlFor(dbName ?? e.dbName) });
  await client.connect();
  try {
    await client.query(`create table if not exists schema_migrations (
      version text primary key, checksum text not null, applied_at timestamptz not null default now())`);
    const applied = new Map<string, string>(
      (await client.query('select version, checksum from schema_migrations')).rows.map((r) => [r.version, r.checksum]),
    );
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d{4}_.+\.sql$/.test(f))
      .sort();
    for (const file of files) {
      const raw = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = createHash('sha256').update(raw).digest('hex');
      const version = file.replace(/\.sql$/, '');
      const prev = applied.get(version);
      if (prev) {
        if (prev !== checksum) throw new Error(`Migração ${file} foi alterada após aplicada (checksum divergente)`);
        continue;
      }
      const sql = raw.replace(/\{\{APP_ROLE\}\}/g, e.DB_APP_USER);
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (version, checksum) values ($1, $2)', [version, checksum]);
        await client.query('commit');
        log(`✔ migração aplicada: ${file}`);
      } catch (err) {
        await client.query('rollback');
        throw new Error(`Falha na migração ${file}: ${(err as Error).message}`);
      }
    }
    await syncCatalog(client);
    log('✔ catálogo de perfis, permissões e modelos de regra sincronizado');
  } finally {
    await client.end();
  }
}

async function syncCatalog(client: Client): Promise<void> {
  await client.query('begin');
  try {
    for (const [code, description] of Object.entries(PERMISSIONS)) {
      await client.query(
        `insert into permissions (code, description) values ($1, $2)
         on conflict (code) do update set description = excluded.description`,
        [code, description],
      );
    }
    for (const r of ROLES) {
      await client.query(
        `insert into roles (code, name, scope, requires_mfa) values ($1, $2, $3, $4)
         on conflict (code) do update set name = excluded.name, scope = excluded.scope, requires_mfa = excluded.requires_mfa`,
        [r.code, r.name, r.scope, r.requiresMfa],
      );
      await client.query('delete from role_permissions where role_code = $1', [r.code]);
      for (const p of new Set(r.permissions)) {
        await client.query('insert into role_permissions (role_code, permission_code) values ($1, $2)', [r.code, p]);
      }
    }
    for (const t of RULE_TEMPLATES) {
      await client.query(
        `insert into rule_templates (code, name, legal_basis, definition, notes) values ($1, $2, $3, $4, $5)
         on conflict (code) do update set name = excluded.name, legal_basis = excluded.legal_basis,
           definition = excluded.definition, notes = excluded.notes, updated_at = now()`,
        [t.code, t.name, t.legalBasis, JSON.stringify(t.definition), t.notes],
      );
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  }
}

if (require.main === module) {
  runMigrations().catch((err) => {
    console.error('✖', err.message);
    process.exit(1);
  });
}
