import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuditService } from './audit/audit.service';
import { AuthService } from './auth/auth.service';
import { AuthzService } from './authz/authz.service';
import { CryptoService } from './common/crypto.service';
import { env } from './config/env';
import { DbService } from './db/db.service';
import { RealtimeGateway } from './realtime/realtime.gateway';

/** Serviços transversais disponíveis para todos os módulos de domínio. */
@Global()
@Module({
  imports: [
    JwtModule.register({
      secret: env().JWT_SECRET,
      signOptions: { algorithm: 'HS256', issuer: 'lsg-api' },
      verifyOptions: { algorithms: ['HS256'], issuer: 'lsg-api' },
    }),
  ],
  providers: [DbService, CryptoService, AuditService, AuthzService, AuthService, RealtimeGateway],
  exports: [JwtModule, DbService, CryptoService, AuditService, AuthzService, AuthService, RealtimeGateway],
})
export class CoreModule {}
