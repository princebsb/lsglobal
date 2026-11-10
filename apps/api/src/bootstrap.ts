import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import express from 'express';
import type { NextFunction, Response } from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { AppModule } from './app.module';
import type { AppRequest } from './common/http';
import { env } from './config/env';

export async function createApp(opts: { logger?: boolean } = {}): Promise<{ app: INestApplication; openapi: OpenAPIObject }> {
  const e = env();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: opts.logger === false ? false : ['error', 'warn', 'log'],
  });
  app.set('trust proxy', 'loopback');
  app.disable('x-powered-by');
  app.use((req: AppRequest, res: Response, next: NextFunction) => {
    const incoming = String(req.headers['x-request-id'] ?? '');
    req.requestId = /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    next();
  });
  if (opts.logger !== false) {
    app.use(
      pinoHttp({
        level: e.LOG_LEVEL,
        genReqId: (req) => (req as AppRequest).requestId ?? randomUUID(),
        redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
        serializers: { req: (r: { id: string; method: string; url: string }) => ({ id: r.id, method: r.method, url: r.url }) },
      }),
    );
  }
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'] },
      },
    }),
  );
  app.use(cookieParser());
  app.enableCors({
    origin: e.WEB_ORIGIN.split(',').map((s) => s.trim()),
    credentials: true,
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Tenant-Id', 'X-Request-Id', 'X-Requested-With', 'Idempotency-Key'],
    exposedHeaders: ['X-Request-Id', 'X-Content-SHA256', 'Content-Disposition'],
  });
  // Webhooks do LiveKit: corpo bruto, necessário para validar a assinatura (SHA-256 do corpo).
  app.use('/api/v1/webhooks/livekit', express.raw({ type: () => true, limit: '1mb' }));
  app.useBodyParser('json', { limit: '5mb' });
  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();

  const config = new DocumentBuilder()
    .setTitle('LS Global Assembleias — API')
    .setDescription(
      'API REST multi-tenant. Autenticação Bearer (JWT) + cabeçalho X-Tenant-Id para rotas do cliente. ' +
        'Erros seguem { statusCode, message, code?, requestId }.',
    )
    .setVersion('1.0.0')
    .addBearerAuth()
    .addGlobalParameters({ name: 'X-Tenant-Id', in: 'header', required: false, schema: { type: 'string', format: 'uuid' } })
    .build();
  const openapi = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, openapi, { jsonDocumentUrl: 'api/docs/openapi.json' });
  return { app, openapi };
}
