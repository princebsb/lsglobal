/**
 * Prepara o PostgreSQL nativo (sem Docker): cria o papel da aplicação (sem superusuário e
 * sem BYPASSRLS) e os bancos de desenvolvimento e de teste. Idempotente.
 *
 * Uso: npm run db:setup
 */
import { Client } from 'pg';
import { env } from '../config/env';

export async function setupDatabase(): Promise<void> {
  const e = env();
  const admin = new Client({ connectionString: e.adminDatabaseUrlFor('postgres') });
  await admin.connect();
  try {
    const role = await admin.query('select 1 from pg_roles where rolname = $1', [e.DB_APP_USER]);
    const pwd = e.DB_APP_PASSWORD.replace(/'/g, "''");
    if (role.rowCount === 0) {
      await admin.query(
        `create role ${e.DB_APP_USER} login nosuperuser nobypassrls nocreatedb nocreaterole noinherit password '${pwd}'`,
      );
      console.log(`✔ papel ${e.DB_APP_USER} criado`);
    } else {
      await admin.query(
        `alter role ${e.DB_APP_USER} login nosuperuser nobypassrls nocreatedb nocreaterole password '${pwd}'`,
      );
      console.log(`✔ papel ${e.DB_APP_USER} atualizado`);
    }
    for (const db of [e.DB_NAME, e.DB_TEST_NAME]) {
      const exists = await admin.query('select 1 from pg_database where datname = $1', [db]);
      if (exists.rowCount === 0) {
        await admin.query(`create database ${db} encoding 'UTF8' template template0`);
        console.log(`✔ banco ${db} criado`);
      } else {
        console.log(`• banco ${db} já existe`);
      }
      await admin.query(`revoke all on database ${db} from public`);
      await admin.query(`grant connect, temporary on database ${db} to ${e.DB_APP_USER}`);
    }
  } finally {
    await admin.end();
  }
}

if (require.main === module) {
  setupDatabase().catch((err) => {
    console.error('✖ falha no setup do banco:', err.message);
    process.exit(1);
  });
}
