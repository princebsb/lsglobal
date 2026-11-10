/**
 * Recria o banco de TESTE do zero (esquema public), aplica as migrações e a seed.
 * Nunca toca o banco de desenvolvimento.
 */
export default async function globalSetup(): Promise<void> {
  process.env.NODE_ENV = 'test';
  const { env } = await import('../src/config/env');
  const { Client } = await import('pg');
  const { setupDatabase } = await import('../src/db/setup');
  const { runMigrations } = await import('../src/db/migrate');
  const { seed } = await import('../src/db/seed');
  const e = env();
  if (e.dbName !== e.DB_TEST_NAME) throw new Error('Testes só podem rodar no banco de teste');
  await setupDatabase();
  const c = new Client({ connectionString: e.adminDatabaseUrlFor(e.DB_TEST_NAME) });
  await c.connect();
  await c.query('drop schema public cascade');
  await c.query('create schema public');
  await c.end();
  const quiet = () => undefined;
  await runMigrations(e.DB_TEST_NAME, quiet);
  await seed(e.DB_TEST_NAME, quiet);
}
