import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { ROLE_BY_CODE } from '@lsg/shared';
import { AuditService } from '../audit/audit.service';
import { AuthzService } from '../authz/authz.service';
import { CryptoService } from '../common/crypto.service';
import { forbidden, unprocessable, type AnonCtx, type Assignment, type AuthUser, type ReqCtx } from '../common/http';
import { env } from '../config/env';
import { DbService, type Q } from '../db/db.service';

export interface AccessClaims {
  sub: string;
  sid: string;
  typ: 'access';
  enr: boolean;
}

interface MfaClaims {
  sub: string;
  typ: 'mfa';
}

interface UserRow {
  id: string;
  email: string;
  full_name: string;
  password_hash: string;
  is_platform_staff: boolean;
  mfa_enabled: boolean;
  mfa_secret_enc: string | null;
  status: string;
  failed_login_count: number;
  locked_until: Date | null;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  mfaEnrollmentRequired: boolean;
}

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

@Injectable()
export class AuthService {
  /** Hash fictício para equalizar o tempo de resposta quando o e-mail não existe (anti-enumeração). */
  private dummyHash: Promise<string>;

  constructor(
    private readonly db: DbService,
    private readonly jwt: JwtService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly authz: AuthzService,
  ) {
    this.dummyHash = this.crypto.hashPassword(this.crypto.randomToken(16));
  }

  async login(email: string, password: string, anon: AnonCtx) {
    const user = await this.db.tx({}, (q) =>
      q.maybe<UserRow>('select * from users where email = $1', [email]),
    );
    const generic = new UnauthorizedException('E-mail ou senha inválidos');

    if (!user) {
      await this.crypto.verifyPassword(await this.dummyHash, password);
      await this.audit.recordStandalone(anon, {
        action: 'auth.login', resourceType: 'user', outcome: 'denied', metadata: { reason: 'unknown_email' },
      });
      throw generic;
    }
    if (user.locked_until && user.locked_until > new Date()) {
      await this.audit.recordStandalone(anon, {
        action: 'auth.login', resourceType: 'user', resourceId: user.id, actorUserId: user.id, outcome: 'denied',
        metadata: { reason: 'locked' },
      });
      throw new UnauthorizedException('Conta temporariamente bloqueada por tentativas excessivas. Tente mais tarde.');
    }
    const ok = await this.crypto.verifyPassword(user.password_hash, password);
    if (!ok || user.status !== 'active') {
      const failures = user.failed_login_count + 1;
      await this.db.tx({}, (q) =>
        q.exec(
          `update users set
             failed_login_count = case when $2::int >= $3::int then 0 else $2::int end,
             locked_until = case when $2::int >= $3::int then now() + make_interval(mins => $4::int) else locked_until end
           where id = $1`,
          [user.id, failures, MAX_FAILED, LOCK_MINUTES],
        ),
      );
      await this.audit.recordStandalone(anon, {
        action: 'auth.login', resourceType: 'user', resourceId: user.id, actorUserId: user.id, outcome: 'denied',
        metadata: { reason: user.status !== 'active' ? 'disabled' : 'bad_password', failures },
      });
      throw generic;
    }

    if (user.mfa_enabled) {
      const mfaToken = await this.jwt.signAsync({ sub: user.id, typ: 'mfa' } satisfies MfaClaims, { expiresIn: 300 });
      return { mfaRequired: true as const, mfaToken };
    }
    return { mfaRequired: false as const, ...(await this.issueSession(user, anon, 'password')) };
  }

  async verifyMfa(mfaToken: string, code: string, anon: AnonCtx) {
    let claims: MfaClaims;
    try {
      claims = await this.jwt.verifyAsync<MfaClaims>(mfaToken);
    } catch {
      throw new UnauthorizedException('Etapa de MFA expirada. Faça login novamente.');
    }
    if (claims.typ !== 'mfa') throw new UnauthorizedException();
    const user = await this.db.tx({}, (q) => q.one<UserRow>('select * from users where id = $1', [claims.sub]));
    if (!user.mfa_secret_enc || !this.crypto.verifyTotp(this.crypto.decrypt(user.mfa_secret_enc), code)) {
      await this.audit.recordStandalone(anon, {
        action: 'auth.mfa', resourceType: 'user', resourceId: user.id, actorUserId: user.id, outcome: 'denied',
      });
      throw new UnauthorizedException('Código MFA inválido');
    }
    return this.issueSession(user, anon, 'password+totp');
  }

  private async loadAssignments(q: Q, userId: string): Promise<Assignment[]> {
    const rows = await q.rows<{ role_code: string; tenant_id: string | null; condominium_id: string | null }>(
      'select role_code, tenant_id, condominium_id from user_role_assignments where user_id = $1 and revoked_at is null',
      [userId],
    );
    return rows.map((r) => ({ roleCode: r.role_code, tenantId: r.tenant_id, condominiumId: r.condominium_id }));
  }

  private async issueSession(user: UserRow, anon: AnonCtx, method: string, familyId?: string): Promise<IssuedTokens> {
    const e = env();
    const refreshToken = this.crypto.randomToken(32);
    const sessionId = randomUUID();
    const result = await this.db.tx({ userId: user.id }, async (q) => {
      const assignments = await this.loadAssignments(q, user.id);
      const enrollment = e.MFA_ENFORCE_ADMIN && !user.mfa_enabled && this.authz.requiresMfa({ assignments });
      await q.exec(
        `insert into auth_sessions (id, user_id, family_id, refresh_token_hash, expires_at, ip, user_agent)
         values ($1, $2, $3, $4, now() + make_interval(days => $5), $6, $7)`,
        [sessionId, user.id, familyId ?? randomUUID(), this.crypto.sha256(refreshToken), e.REFRESH_TTL_DAYS, anon.ip, anon.userAgent],
      );
      if (!familyId) {
        await q.exec('update users set failed_login_count = 0, locked_until = null, last_login_at = now() where id = $1', [user.id]);
        await this.audit.record(q, anon, {
          action: 'auth.login', resourceType: 'user', resourceId: user.id, actorUserId: user.id,
          metadata: { method, sessionId },
        });
      }
      return { enrollment };
    });
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, sid: sessionId, typ: 'access', enr: result.enrollment } satisfies AccessClaims,
      { expiresIn: e.JWT_ACCESS_TTL_SECONDS },
    );
    return { accessToken, refreshToken, expiresIn: e.JWT_ACCESS_TTL_SECONDS, mfaEnrollmentRequired: result.enrollment };
  }

  /** Rotação de refresh token com detecção de reuso (revoga toda a família). */
  async refresh(refreshToken: string, anon: AnonCtx): Promise<IssuedTokens> {
    const hash = this.crypto.sha256(refreshToken);
    const session = await this.db.tx({}, (q) =>
      q.maybe<{ id: string; user_id: string; family_id: string; revoked_at: Date | null; expires_at: Date }>(
        'select id, user_id, family_id, revoked_at, expires_at from auth_sessions where refresh_token_hash = $1',
        [hash],
      ),
    );
    if (!session) throw new UnauthorizedException('Sessão inválida');
    if (session.revoked_at) {
      await this.db.tx({}, (q) =>
        q.exec('update auth_sessions set revoked_at = coalesce(revoked_at, now()) where family_id = $1', [session.family_id]),
      );
      await this.audit.recordStandalone(anon, {
        action: 'auth.refresh_reuse', resourceType: 'session', resourceId: session.id, actorUserId: session.user_id,
        outcome: 'denied', metadata: { familyRevoked: session.family_id },
      });
      throw new UnauthorizedException('Sessão encerrada por segurança. Faça login novamente.');
    }
    if (session.expires_at < new Date()) throw new UnauthorizedException('Sessão expirada');
    const revoked = await this.db.tx({}, (q) =>
      q.exec('update auth_sessions set revoked_at = now(), rotated_at = now() where id = $1 and revoked_at is null', [session.id]),
    );
    if (revoked !== 1) throw new UnauthorizedException('Sessão inválida');
    const user = await this.db.tx({}, (q) => q.one<UserRow>('select * from users where id = $1', [session.user_id]));
    if (user.status !== 'active') throw new UnauthorizedException('Usuário desativado');
    return this.issueSession(user, anon, 'refresh', session.family_id);
  }

  async logout(sessionId: string, ctx: ReqCtx): Promise<void> {
    await this.db.tx({ userId: ctx.auth.userId }, async (q) => {
      const fam = await q.maybe<{ family_id: string }>('select family_id from auth_sessions where id = $1', [sessionId]);
      if (fam) await q.exec('update auth_sessions set revoked_at = coalesce(revoked_at, now()) where family_id = $1', [fam.family_id]);
      await this.audit.record(q, { ...ctx, tenantId: null }, { action: 'auth.logout', resourceType: 'session', resourceId: sessionId });
    });
  }

  /** Carrega o usuário autenticado (usado pelo guard em cada requisição). */
  async loadAuthUser(claims: AccessClaims): Promise<AuthUser> {
    return this.db.tx({ userId: claims.sub }, async (q) => {
      const row = await q.maybe<{
        id: string; email: string; full_name: string; is_platform_staff: boolean; mfa_enabled: boolean; status: string;
        revoked_at: Date | null; expires_at: Date;
      }>(
        `select u.id, u.email, u.full_name, u.is_platform_staff, u.mfa_enabled, u.status, s.revoked_at, s.expires_at
           from users u join auth_sessions s on s.user_id = u.id
          where u.id = $1 and s.id = $2`,
        [claims.sub, claims.sid],
      );
      // A sessão do access token pode ter sido rotacionada (revoked_at) — o access token continua
      // válido até expirar, exceto se a família inteira foi revogada (logout/reuso).
      if (!row || row.status !== 'active') throw new UnauthorizedException('Sessão inválida');
      const familyRevoked = await q.maybe<{ n: number }>(
        `select 1 as n from auth_sessions s
          where s.family_id = (select family_id from auth_sessions where id = $1)
            and s.revoked_at is null limit 1`,
        [claims.sid],
      );
      if (row.revoked_at && !familyRevoked) throw new UnauthorizedException('Sessão encerrada');
      const assignments = await this.loadAssignments(q, row.id);
      return {
        userId: row.id,
        email: row.email,
        fullName: row.full_name,
        sessionId: claims.sid,
        isPlatformStaff: row.is_platform_staff,
        mfaEnabled: row.mfa_enabled,
        mfaEnrollmentRequired: claims.enr,
        assignments,
      };
    });
  }

  async me(ctx: ReqCtx) {
    const rows = await this.db.tx({ userId: ctx.auth.userId }, (q) =>
      q.rows<{
        tenant_id: string | null; tenant_name: string | null; tenant_kind: string | null;
        condominium_id: string | null; condominium_name: string | null; role_code: string;
      }>('select * from user_contexts($1)', [ctx.auth.userId]),
    );
    const tenants = new Map<string, { id: string; name: string; kind: string; roles: { roleCode: string; roleName: string; condominiumId: string | null; condominiumName: string | null }[]; permissions: string[] }>();
    for (const r of rows) {
      if (!r.tenant_id) continue;
      const t = tenants.get(r.tenant_id) ?? { id: r.tenant_id, name: r.tenant_name ?? '', kind: r.tenant_kind ?? '', roles: [], permissions: [] };
      t.roles.push({ roleCode: r.role_code, roleName: ROLE_BY_CODE.get(r.role_code)?.name ?? r.role_code, condominiumId: r.condominium_id, condominiumName: r.condominium_name });
      tenants.set(r.tenant_id, t);
    }
    for (const t of tenants.values()) t.permissions = [...this.authz.permissions(ctx.auth, t.id)];
    const platformRoles = ctx.auth.assignments.filter((a) => a.tenantId === null).map((a) => ({
      roleCode: a.roleCode, roleName: ROLE_BY_CODE.get(a.roleCode)?.name ?? a.roleCode,
    }));
    return {
      user: {
        id: ctx.auth.userId,
        email: ctx.auth.email,
        fullName: ctx.auth.fullName,
        isPlatformStaff: ctx.auth.isPlatformStaff,
        mfaEnabled: ctx.auth.mfaEnabled,
        mfaEnrollmentRequired: ctx.auth.mfaEnrollmentRequired,
      },
      platform: { roles: platformRoles, permissions: [...this.authz.permissions(ctx.auth, null)] },
      tenants: [...tenants.values()],
    };
  }

  async mfaSetup(ctx: ReqCtx) {
    if (ctx.auth.mfaEnabled) throw unprocessable('MFA já está habilitado');
    const secret = this.crypto.generateTotpSecret();
    await this.db.tx({ userId: ctx.auth.userId }, (q) =>
      q.exec('update users set mfa_secret_enc = $2 where id = $1 and mfa_enabled = false', [ctx.auth.userId, this.crypto.encrypt(secret)]),
    );
    return { secret, otpauthUri: this.crypto.totpUri(secret, ctx.auth.email) };
  }

  async mfaEnable(ctx: ReqCtx, code: string) {
    await this.db.tx({ userId: ctx.auth.userId }, async (q) => {
      const u = await q.one<{ mfa_secret_enc: string | null; mfa_enabled: boolean }>(
        'select mfa_secret_enc, mfa_enabled from users where id = $1 for update', [ctx.auth.userId]);
      if (u.mfa_enabled) throw unprocessable('MFA já está habilitado');
      if (!u.mfa_secret_enc) throw unprocessable('Inicie a configuração do MFA primeiro');
      if (!this.crypto.verifyTotp(this.crypto.decrypt(u.mfa_secret_enc), code)) throw forbidden('Código inválido');
      await q.exec('update users set mfa_enabled = true where id = $1', [ctx.auth.userId]);
      // encerra as demais sessões — novo login exigirá TOTP
      await q.exec('update auth_sessions set revoked_at = coalesce(revoked_at, now()) where user_id = $1', [ctx.auth.userId]);
      await this.audit.record(q, { ...ctx, tenantId: null }, { action: 'auth.mfa_enabled', resourceType: 'user', resourceId: ctx.auth.userId });
    });
    return { ok: true, message: 'MFA habilitado. Faça login novamente.' };
  }
}
