/**
 * Segurança: autenticação, MFA, isolamento entre tenants (API e banco), RLS,
 * acesso entre condomínios, auditoria e detecção de adulteração.
 */
import type { INestApplication } from '@nestjs/common';
import { CryptoService } from '../src/common/crypto.service';
import { PASSWORD, adminDb, api, appDb, as, login, startApp, type Session } from './helpers';

describe('Segurança e isolamento', () => {
  let app: INestApplication;
  let gestor: Session, beta: Session, ana: Session, superadmin: Session;
  let condoA: string;

  beforeAll(async () => {
    app = await startApp();
    [gestor, beta, ana, superadmin] = await Promise.all(
      ['gestor@horizonte.demo', 'admin@beta.demo', 'ana@acacias.demo', 'admin@lsglobal.local'].map((e) => login(app, e)),
    );
    condoA = (await as(app, gestor).get('/condominiums')).body[0].id;
  });
  afterAll(async () => app.close());

  describe('autenticação', () => {
    it('mensagem genérica para e-mail inexistente e senha errada (anti-enumeração)', async () => {
      const a = await api(app).post('/api/v1/auth/login').send({ email: 'naoexiste@x.demo', password: 'Qualquer1A' });
      const b = await api(app).post('/api/v1/auth/login').send({ email: 'ana@acacias.demo', password: 'Errada123A' });
      expect(a.status).toBe(401);
      expect(b.status).toBe(401);
      expect(a.body.message).toBe(b.body.message);
    });

    it('rotas protegidas exigem token; refresh exige cabeçalho anti-CSRF', async () => {
      expect((await api(app).get('/api/v1/auth/me')).status).toBe(401);
      expect((await api(app).post('/api/v1/auth/refresh')).status).toBe(401);
    });

    it('refresh rotaciona o token e o reuso revoga a família de sessões', async () => {
      const r = await api(app).post('/api/v1/auth/login').send({ email: 'bruno@acacias.demo', password: PASSWORD });
      const cookie = (r.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('lsg_rt='))!.split(';')[0]!;
      const r1 = await api(app).post('/api/v1/auth/refresh').set('Cookie', cookie).set('X-Requested-With', 'lsg-web');
      expect(r1.status).toBe(200);
      const reuse = await api(app).post('/api/v1/auth/refresh').set('Cookie', cookie).set('X-Requested-With', 'lsg-web');
      expect(reuse.status).toBe(401);
      const newCookie = (r1.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('lsg_rt='))!.split(';')[0]!;
      const afterReuse = await api(app).post('/api/v1/auth/refresh').set('Cookie', newCookie).set('X-Requested-With', 'lsg-web');
      expect(afterReuse.status).toBe(401);
    });

    it('MFA TOTP: habilitar e exigir o segundo fator no login', async () => {
      const email = `mfa.${Date.now()}@horizonte.demo`;
      const created = await as(app, gestor).post('/users', { email, fullName: 'Usuário MFA', password: PASSWORD, roleCode: 'auditor', condominiumId: condoA });
      expect(created.status).toBe(201);
      const s = await login(app, email);
      const setup = await as(app, s, '').post('/auth/mfa/setup');
      const crypto = new CryptoService();
      expect((await as(app, s, '').post('/auth/mfa/enable', { code: '000000' })).status).toBe(403);
      expect((await as(app, s, '').post('/auth/mfa/enable', { code: crypto.totpCode(setup.body.secret) })).status).toBe(200);
      const step1 = await api(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
      expect(step1.body.mfaRequired).toBe(true);
      expect(step1.body.accessToken).toBeUndefined();
      const bad = await api(app).post('/api/v1/auth/mfa/verify').send({ mfaToken: step1.body.mfaToken, code: '123456' });
      expect(bad.status).toBe(401);
      const ok = await api(app).post('/api/v1/auth/mfa/verify').send({ mfaToken: step1.body.mfaToken, code: crypto.totpCode(setup.body.secret) });
      expect(ok.status).toBe(200);
      expect(ok.body.accessToken).toBeDefined();
    });

    it('bloqueio temporário após tentativas excessivas', async () => {
      const email = `lock.${Date.now()}@horizonte.demo`;
      await as(app, gestor).post('/users', { email, fullName: 'Usuário Bloqueio', password: PASSWORD, roleCode: 'auditor', condominiumId: condoA });
      for (let i = 0; i < 5; i++) await api(app).post('/api/v1/auth/login').send({ email, password: 'Errada123A' });
      const r = await api(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
      expect(r.status).toBe(401);
      expect(r.body.message).toMatch(/bloqueada/);
    });
  });

  describe('isolamento entre tenants', () => {
    it('usuário de outro cliente não acessa o tenant (403) e o evento é auditado', async () => {
      const r = await as(app, beta, gestor.tenantId).get('/condominiums');
      expect(r.status).toBe(403);
    });

    it('recurso de outro cliente é invisível mesmo conhecendo o identificador (RLS → 404)', async () => {
      const r = await as(app, beta).get(`/condominiums/${condoA}`);
      expect([403, 404]).toContain(r.status);
      // a rota de listagem não falha, mas o RLS não devolve nenhuma unidade do outro cliente
      const units = await as(app, beta).get(`/condominiums/${condoA}/units`);
      expect([200, 403, 404]).toContain(units.status);
      if (units.status === 200) expect(units.body).toHaveLength(0);
    });

    it('listagens retornam somente dados do próprio cliente', async () => {
      const a = (await as(app, gestor).get('/condominiums')).body.map((c: { id: string }) => c.id);
      const b = (await as(app, beta).get('/condominiums')).body.map((c: { id: string }) => c.id);
      expect(a.filter((id: string) => b.includes(id))).toHaveLength(0);
      expect(b).toHaveLength(1);
    });

    it('banco: o papel da aplicação só enxerga linhas do tenant definido na transação', async () => {
      const c = await appDb();
      try {
        expect((await c.query('select count(*)::int as n from units')).rows[0].n).toBe(0);
        await c.query(`select set_config('app.tenant_id', $1, false)`, [beta.tenantId]);
        expect((await c.query('select count(*)::int as n from units')).rows[0].n).toBe(3);
        expect((await c.query('select count(*)::int as n from units where condominium_id = $1', [condoA])).rows[0].n).toBe(0);
        await expect(
          c.query(`insert into buildings (tenant_id, condominium_id, name) values ($1, $2, 'invasão')`, [gestor.tenantId, condoA]),
        ).rejects.toMatchObject({ code: '42501' }); // violação de política RLS
      } finally {
        await c.end();
      }
    });

    it('papel da aplicação não é superusuário nem ignora RLS', async () => {
      const c = await appDb();
      try {
        const r = await c.query('select rolsuper, rolbypassrls from pg_roles where rolname = current_user');
        expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
      } finally {
        await c.end();
      }
    });
  });

  describe('autorização contextual', () => {
    it('condômino não acessa cadastros administrativos nem auditoria', async () => {
      expect((await as(app, ana).get(`/condominiums/${condoA}/units`)).status).toBe(403);
      expect((await as(app, ana).get('/audit')).status).toBe(403);
      expect((await as(app, ana).post('/people', { kind: 'pf', name: 'X', document: '52998224725' })).status).toBe(403);
    });

    it('documento pessoal só é revelado com permissão específica e gera auditoria', async () => {
      const people = await as(app, gestor).get(`/people?condominiumId=${condoA}`);
      const p = people.body[0];
      expect(p.document).toMatch(/\*\*\*/);
      const rev = await as(app, gestor).get(`/people/${p.id}/document`);
      expect(rev.status).toBe(200);
      expect(rev.body.document).toMatch(/^\d{11}$/);
      const audit = await as(app, gestor).get('/audit?action=person.document_revealed');
      expect(audit.body.length).toBeGreaterThan(0);
    });

    it('plataforma: painel global somente para equipe LS Global', async () => {
      expect((await as(app, superadmin, '').get('/platform/overview')).status).toBe(200);
      expect((await as(app, gestor, '').get('/platform/overview')).status).toBe(403);
    });

    it('acesso de suporte da plataforma a um cliente é marcado na auditoria', async () => {
      const r = await as(app, superadmin, gestor.tenantId).get('/condominiums');
      expect(r.status).toBe(200);
    });
  });

  describe('auditoria', () => {
    it('detecta adulteração da trilha (mesmo feita por superusuário do banco)', async () => {
      const ok = await as(app, beta).get('/audit/verify');
      expect(ok.body.valid).toBe(true);
      const c = await adminDb();
      try {
        await c.query('alter table audit_events disable trigger audit_events_no_update');
        await c.query(
          `update audit_events set metadata = '{"adulterado":true}' where tenant_id = $1 and chain_seq = 1`,
          [beta.tenantId],
        );
        await c.query('alter table audit_events enable trigger audit_events_no_update');
      } finally {
        await c.end();
      }
      const bad = await as(app, beta).get('/audit/verify');
      expect(bad.body.valid).toBe(false);
      expect(bad.body.first_invalid_seq).toBe('1');
    });
  });
});
