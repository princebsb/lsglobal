import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

function findUp(file: string, start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, file);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const envFile = findUp('.env', __dirname);
if (envFile) loadDotenv({ path: envFile, quiet: true });

const b64key = z
  .string()
  .refine((v) => Buffer.from(v, 'base64').length === 32, 'deve ser uma chave de 32 bytes em base64');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production', 'staging']).default('development'),
  API_PORT: z.coerce.number().int().default(3000),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  DATABASE_ADMIN_URL: z.string().min(10),
  DB_NAME: z.string().regex(/^[a-z0-9_]+$/),
  DB_TEST_NAME: z.string().regex(/^[a-z0-9_]+$/),
  DB_APP_USER: z.string().regex(/^[a-z0-9_]+$/),
  DB_APP_PASSWORD: z.string().min(12),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
  JWT_SECRET: z.string().min(32),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(60).default(7),
  DATA_ENCRYPTION_KEY: b64key,
  DATA_HMAC_KEY: b64key,
  MFA_ENFORCE_ADMIN: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  STORAGE_DRIVER: z.enum(['local']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./storage'),
  // Convocações / e-mail
  PUBLIC_WEB_URL: z.string().url().optional(),
  MAIL_DRIVER: z.enum(['file', 'smtp']).default('file'),
  MAIL_FROM: z.string().default('LS Global Assembleias <nao-responda@lsglobal.local>'),
  SMTP_URL: z.string().optional(),
  MAIL_OUTBOX_DIR: z.string().default('./storage/outbox'),
  OUTBOX_WORKER: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  OUTBOX_INTERVAL_MS: z.coerce.number().int().min(500).max(600_000).default(5000),
  // Transmissão (LiveKit). Sem estas variáveis a transmissão fica indisponível (503).
  LIVEKIT_URL: z.string().optional(),
  LIVEKIT_PUBLIC_URL: z.string().optional(),
  LIVEKIT_API_KEY: z.string().optional(),
  LIVEKIT_API_SECRET: z.string().optional(),
  LIVEKIT_EGRESS_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  RECORDINGS_DIR: z.string().default('./storage/recordings'),
  /** Mesmo diretório visto pelo Egress quando ele roda em outro sistema (ex.: /mnt/d/... no WSL2). */
  EGRESS_RECORDINGS_DIR: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Env = z.infer<typeof EnvSchema> & {
  /** Nome do banco efetivamente usado (teste usa DB_TEST_NAME). */
  dbName: string;
  appDatabaseUrl: string;
  adminDatabaseUrlFor: (db: string) => string;
};

function build(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuração inválida (.env):\n${msg}`);
  }
  const e = parsed.data;
  if (e.NODE_ENV === 'production' && !e.MFA_ENFORCE_ADMIN) {
    throw new Error('MFA_ENFORCE_ADMIN deve ser true em produção');
  }
  if (e.MAIL_DRIVER === 'smtp' && !e.SMTP_URL) throw new Error('MAIL_DRIVER=smtp exige SMTP_URL');
  if (e.LIVEKIT_URL && (!e.LIVEKIT_API_KEY || !e.LIVEKIT_API_SECRET || e.LIVEKIT_API_SECRET.length < 32)) {
    throw new Error('LIVEKIT_URL exige LIVEKIT_API_KEY e LIVEKIT_API_SECRET (mínimo 32 caracteres)');
  }
  const dbName = e.NODE_ENV === 'test' ? e.DB_TEST_NAME : e.DB_NAME;
  const adminDatabaseUrlFor = (db: string) => {
    const u = new URL(e.DATABASE_ADMIN_URL);
    u.pathname = `/${db}`;
    return u.toString();
  };
  const appUrl = new URL(e.DATABASE_ADMIN_URL);
  appUrl.username = e.DB_APP_USER;
  appUrl.password = encodeURIComponent(e.DB_APP_PASSWORD);
  appUrl.pathname = `/${dbName}`;
  return { ...e, dbName, appDatabaseUrl: appUrl.toString(), adminDatabaseUrlFor };
}

let cached: Env | undefined;
export function env(): Env {
  cached ??= build();
  return cached;
}

/** Usado pelos testes para trocar NODE_ENV antes da primeira leitura. */
export function resetEnvCache(): void {
  cached = undefined;
}
