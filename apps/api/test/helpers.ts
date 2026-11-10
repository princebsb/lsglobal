import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';
import { createApp } from '../src/bootstrap';
import { env } from '../src/config/env';
import { DEMO_PASSWORD } from '../src/db/seed';

export const PASSWORD = DEMO_PASSWORD;

export interface Session {
  token: string;
  tenantId: string;
  userId: string;
}

export async function startApp(): Promise<INestApplication> {
  const { app } = await createApp({ logger: false });
  await app.init();
  return app;
}

export function api(app: INestApplication) {
  return request(app.getHttpServer());
}

export async function login(app: INestApplication, email: string, tenantIndex = 0): Promise<Session> {
  const r = await api(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  if (r.status !== 200) throw new Error(`login ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  const me = await api(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${r.body.accessToken}`);
  return { token: r.body.accessToken, tenantId: me.body.tenants[tenantIndex]?.id, userId: me.body.user.id };
}

/** Requisição autenticada com contexto de tenant. */
export function as(app: INestApplication, s: Session, tenantId = s.tenantId) {
  const h = (t: request.Test) => {
    t.set('Authorization', `Bearer ${s.token}`);
    if (tenantId) t.set('X-Tenant-Id', tenantId);
    return t;
  };
  const a = api(app);
  return {
    get: (u: string) => h(a.get(`/api/v1${u}`)),
    post: (u: string, body?: object) => h(a.post(`/api/v1${u}`)).send(body ?? {}),
    patch: (u: string, body?: object) => h(a.patch(`/api/v1${u}`)).send(body ?? {}),
    put: (u: string, body?: object) => h(a.put(`/api/v1${u}`)).send(body ?? {}),
    delete: (u: string, body?: object) => h(a.delete(`/api/v1${u}`)).send(body ?? {}),
  };
}

/** Conexão direta com o papel da APLICAÇÃO (sujeito a RLS), para testes de isolamento. */
export async function appDb(): Promise<Client> {
  const c = new Client({ connectionString: env().appDatabaseUrl });
  await c.connect();
  return c;
}

/** Conexão administrativa (superusuário) — usada apenas para simular adulteração. */
export async function adminDb(): Promise<Client> {
  const c = new Client({ connectionString: env().adminDatabaseUrlFor(env().DB_TEST_NAME) });
  await c.connect();
  return c;
}

let counter = 0;
export const key = (p = 'k') => `${p}-${Date.now()}-${++counter}-${Math.random().toString(36).slice(2, 8)}`;
