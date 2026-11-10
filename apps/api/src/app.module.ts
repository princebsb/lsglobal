import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { GlobalExceptionFilter } from './common/http';
import { env } from './config/env';
import { CoreModule } from './core.module';
import { AccreditationController } from './modules/accreditation/accreditation.controller';
import { AssembliesController } from './modules/assemblies/assemblies.controller';
import { AssembliesService } from './modules/assemblies/assemblies.service';
import { QuorumService } from './modules/assemblies/quorum.service';
import { AuditController } from './modules/audit/audit.controller';
import { ConvocationsController, PublicConvocationsController } from './modules/convocations/convocations.controller';
import { ConvocationsService } from './modules/convocations/convocations.service';
import { MailService } from './modules/convocations/mail.service';
import { CondominiumsController } from './modules/condominiums/condominiums.controller';
import { UnitImportService } from './modules/condominiums/unit-import.service';
import { DashboardController } from './modules/dashboard/dashboard.controller';
import { LivekitService } from './modules/media/livekit.service';
import { MediaController, MediaWebhookController } from './modules/media/media.controller';
import { MediaService } from './modules/media/media.service';
import { PeopleController } from './modules/people/people.controller';
import { PlatformController } from './modules/platform/platform.controller';
import { PoaController } from './modules/poa/poa.controller';
import { ReportsController } from './modules/reports/reports.controller';
import { RulesController } from './modules/rules/rules.controller';
import { UsersController } from './modules/users/users.controller';
import { VotingController } from './modules/voting/voting.controller';
import { VotingService } from './modules/voting/voting.service';

/**
 * Monólito modular: um processo para o domínio de negócio, com fronteiras por módulo.
 * Serviços especializados (mídia/LiveKit, filas, processamento de arquivos) serão processos separados.
 */
@Module({
  imports: [
    CoreModule,
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: 600 }],
      // Testes automatizados disparam muitos logins a partir do mesmo IP.
      skipIf: () => env().NODE_ENV === 'test',
    }),
  ],
  controllers: [
    AuthController,
    DashboardController,
    PlatformController,
    UsersController,
    CondominiumsController,
    PeopleController,
    PoaController,
    RulesController,
    AssembliesController,
    AccreditationController,
    ConvocationsController,
    PublicConvocationsController,
    MediaController,
    MediaWebhookController,
    VotingController,
    ReportsController,
    AuditController,
  ],
  providers: [
    UnitImportService,
    AssembliesService,
    QuorumService,
    VotingService,
    MailService,
    ConvocationsService,
    LivekitService,
    MediaService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
  ],
})
export class AppModule {}
