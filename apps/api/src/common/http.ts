import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ConflictException,
  createParamDecorator,
  ExceptionFilter,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  PipeTransform,
  SetMetadata,
  UnprocessableEntityException,
  applyDecorators,
} from '@nestjs/common';
import { ApiBody } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z, type ZodType } from 'zod';
import type { Permission } from '@lsg/shared';

// ---------------------------------------------------------------------------
// Contexto de requisição
// ---------------------------------------------------------------------------

export interface Assignment {
  roleCode: string;
  tenantId: string | null;
  condominiumId: string | null;
}

export interface AuthUser {
  userId: string;
  email: string;
  fullName: string;
  sessionId: string;
  isPlatformStaff: boolean;
  mfaEnabled: boolean;
  mfaEnrollmentRequired: boolean;
  assignments: Assignment[];
}

export interface ReqCtx {
  auth: AuthUser;
  /** Tenant ativo (cabeçalho X-Tenant-Id validado). */
  tenantId: string | null;
  /** Usuário da plataforma acessando dados de um cliente. */
  platformAccess: boolean;
  requestId: string;
  ip: string;
  userAgent: string;
}

export interface AnonCtx {
  requestId: string;
  ip: string;
  userAgent: string;
}

export type AppRequest = Request & { ctx?: ReqCtx; requestId?: string };

export const Ctx = createParamDecorator((_: unknown, ec: ExecutionContext): ReqCtx => {
  const req = ec.switchToHttp().getRequest<AppRequest>();
  if (!req.ctx) throw new ForbiddenException('Contexto de autenticação ausente');
  return req.ctx;
});

export const Anon = createParamDecorator((_: unknown, ec: ExecutionContext): AnonCtx => {
  const req = ec.switchToHttp().getRequest<AppRequest>();
  return {
    requestId: req.requestId ?? '',
    ip: req.ip ?? '',
    userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300),
  };
});

// ---------------------------------------------------------------------------
// Metadados de autorização
// ---------------------------------------------------------------------------

export const IS_PUBLIC = 'lsg:public';
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ALLOW_PENDING_MFA = 'lsg:allow-pending-mfa';
export const AllowPendingMfa = () => SetMetadata(ALLOW_PENDING_MFA, true);

export const REQUIRE_TENANT = 'lsg:require-tenant';
/** Exige cabeçalho X-Tenant-Id válido. */
export const TenantScoped = () => SetMetadata(REQUIRE_TENANT, true);

export const REQUIRED_PERMISSIONS = 'lsg:permissions';
/** Verificação grosseira (o usuário tem a permissão em algum escopo do tenant). A checagem fina por
 *  condomínio é feita nos serviços via AuthzService.require(). */
export const RequirePermission = (...perms: Permission[]) => SetMetadata(REQUIRED_PERMISSIONS, perms);

// ---------------------------------------------------------------------------
// Validação com Zod (também documenta o corpo no OpenAPI)
// ---------------------------------------------------------------------------

export class ZodPipe<T extends ZodType> implements PipeTransform {
  constructor(private readonly schema: T) {}
  transform(value: unknown): z.infer<T> {
    const r = this.schema.safeParse(value);
    if (!r.success) {
      throw new BadRequestException({
        message: 'Dados inválidos',
        issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return r.data;
  }
}

export function jsonSchemaOf(schema: ZodType): Record<string, unknown> {
  try {
    return z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' }) as Record<string, unknown>;
  } catch {
    return { type: 'object' };
  }
}

export const ZodBody = (schema: ZodType) => applyDecorators(ApiBody({ schema: jsonSchemaOf(schema) as never }));

// ---------------------------------------------------------------------------
// Erros de domínio e filtro global
// ---------------------------------------------------------------------------

export const notFound = (what = 'Registro') => new NotFoundException(`${what} não encontrado(a)`);
export const conflict = (msg: string, code?: string) => new ConflictException({ message: msg, code });
export const unprocessable = (msg: string, code?: string, details?: unknown) =>
  new UnprocessableEntityException({ message: msg, code, details });
export const forbidden = (msg = 'Acesso negado') => new ForbiddenException(msg);

interface PgError {
  code?: string;
  constraint?: string;
  message: string;
  detail?: string;
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<AppRequest>();
    const requestId = req.requestId;

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const payload = typeof body === 'string' ? { message: body } : (body as Record<string, unknown>);
      res.status(status).json({ statusCode: status, requestId, ...payload });
      return;
    }

    const pg = exception as PgError;
    if (pg && typeof pg.code === 'string') {
      const map: Record<string, [number, string]> = {
        '23505': [HttpStatus.CONFLICT, 'Registro duplicado ou conflitante'],
        '23503': [HttpStatus.UNPROCESSABLE_ENTITY, 'Referência inválida'],
        '23514': [HttpStatus.UNPROCESSABLE_ENTITY, 'Regra de integridade violada'],
        '22P02': [HttpStatus.BAD_REQUEST, 'Formato de dado inválido'],
        P0001: [HttpStatus.CONFLICT, pg.message],
        P0002: [HttpStatus.NOT_FOUND, pg.message],
        '42501': [HttpStatus.FORBIDDEN, 'Operação não permitida'],
        '40001': [HttpStatus.CONFLICT, 'Conflito de concorrência; tente novamente'],
      };
      const hit = map[pg.code];
      if (hit) {
        res.status(hit[0]).json({ statusCode: hit[0], requestId, message: hit[1], constraint: pg.constraint });
        return;
      }
    }

    this.logger.error({ err: exception, requestId }, 'Erro não tratado');
    res
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json({ statusCode: 500, requestId, message: 'Erro interno. Informe o identificador ao suporte.' });
  }
}
