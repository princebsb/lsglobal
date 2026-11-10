import { Body, Controller, Get, HttpCode, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { LoginSchema, MfaEnableSchema, MfaVerifySchema } from '@lsg/shared';
import { z } from 'zod';
import { AllowPendingMfa, Anon, Ctx, Public, ZodBody, ZodPipe, type AnonCtx, type AppRequest, type ReqCtx } from '../common/http';
import { env } from '../config/env';
import { AuthService, type IssuedTokens } from './auth.service';

const REFRESH_COOKIE = 'lsg_rt';

function setRefreshCookie(res: Response, token: string) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: env().NODE_ENV === 'production' || env().NODE_ENV === 'staging',
    path: '/api/v1/auth',
    maxAge: env().REFRESH_TTL_DAYS * 86400_000,
  });
}

function publicTokens(t: IssuedTokens) {
  return { accessToken: t.accessToken, expiresIn: t.expiresIn, mfaEnrollmentRequired: t.mfaEnrollmentRequired };
}

@ApiTags('Autenticação')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  @ZodBody(LoginSchema)
  async login(
    @Body(new ZodPipe(LoginSchema)) body: z.infer<typeof LoginSchema>,
    @Anon() anon: AnonCtx,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.auth.login(body.email, body.password, anon);
    if (r.mfaRequired) return { mfaRequired: true, mfaToken: r.mfaToken };
    setRefreshCookie(res, r.refreshToken);
    return { mfaRequired: false, ...publicTokens(r) };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('mfa/verify')
  @HttpCode(200)
  @ZodBody(MfaVerifySchema)
  async verifyMfa(
    @Body(new ZodPipe(MfaVerifySchema)) body: z.infer<typeof MfaVerifySchema>,
    @Anon() anon: AnonCtx,
    @Res({ passthrough: true }) res: Response,
  ) {
    const t = await this.auth.verifyMfa(body.mfaToken, body.code, anon);
    setRefreshCookie(res, t.refreshToken);
    return publicTokens(t);
  }

  /** O refresh token trafega somente em cookie httpOnly + SameSite=Strict (proteção CSRF);
   *  exige também o cabeçalho X-Requested-With para bloquear envios de formulários cruzados. */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: AppRequest, @Anon() anon: AnonCtx, @Res({ passthrough: true }) res: Response) {
    if (req.headers['x-requested-with'] !== 'lsg-web') throw new UnauthorizedException('Cabeçalho obrigatório ausente');
    const token = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (!token) throw new UnauthorizedException('Sessão ausente');
    const t = await this.auth.refresh(token, anon);
    setRefreshCookie(res, t.refreshToken);
    return publicTokens(t);
  }

  @ApiBearerAuth()
  @AllowPendingMfa()
  @Post('logout')
  @HttpCode(200)
  async logout(@Ctx() ctx: ReqCtx, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(ctx.auth.sessionId, ctx);
    res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
    return { ok: true };
  }

  @ApiBearerAuth()
  @AllowPendingMfa()
  @Get('me')
  me(@Ctx() ctx: ReqCtx) {
    return this.auth.me(ctx);
  }

  @ApiBearerAuth()
  @AllowPendingMfa()
  @Post('mfa/setup')
  @HttpCode(200)
  mfaSetup(@Ctx() ctx: ReqCtx) {
    return this.auth.mfaSetup(ctx);
  }

  @ApiBearerAuth()
  @AllowPendingMfa()
  @Post('mfa/enable')
  @HttpCode(200)
  @ZodBody(MfaEnableSchema)
  mfaEnable(@Ctx() ctx: ReqCtx, @Body(new ZodPipe(MfaEnableSchema)) body: z.infer<typeof MfaEnableSchema>) {
    return this.auth.mfaEnable(ctx, body.code);
  }
}
