import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AssemblyStatus } from '@lsg/shared';
import { AuthzService } from '../../authz/authz.service';
import { Ctx, Public, RequirePermission, TenantScoped, type ReqCtx } from '../../common/http';
import { condoFilter, dbc } from '../../common/scope';
import { DbService } from '../../db/db.service';

/** Assembleias em curso (credenciamento ou sessão aberta/suspensa). */
const LIVE: AssemblyStatus[] = ['accreditation', 'in_progress', 'suspended'];
/** Assembleias agendadas: aprovadas para convocação ou já convocadas. */
const SCHEDULED: AssemblyStatus[] = ['approved_for_call', 'called'];
/** Assembleias em preparação. */
const DRAFTS: AssemblyStatus[] = ['draft', 'in_review'];

@ApiTags('Painéis')
@Controller()
export class DashboardController {
  constructor(
    private readonly db: DbService,
    private readonly authz: AuthzService,
  ) {}

  /** Verificação de disponibilidade (balanceador/monitoramento). Não expõe dados. */
  @Public()
  @Get('health')
  async health() {
    const db = await this.db.ping().catch(() => false);
    if (!db) throw new ServiceUnavailableException({ status: 'error', db: false });
    return { status: 'ok', db: true, time: new Date().toISOString() };
  }

  /** Painel do cliente: indicadores e próximas assembleias, restritos aos condomínios visíveis ao usuário. */
  @Get('dashboard')
  @ApiBearerAuth()
  @TenantScoped()
  @RequirePermission('assembly.view')
  async dashboard(@Ctx() ctx: ReqCtx) {
    const scope = this.authz.condoScope(ctx, 'assembly.view');
    // $1..$3: listas de estados; $4: condomínios do escopo (quando restrito), compartilhado pelas subconsultas.
    const f = (column: string, idx = 4) => condoFilter(scope, column, idx).sql;
    const scopeParams = condoFilter(scope, 'x', 4).params;
    return this.db.tx(dbc(ctx), async (q) => {
      const counts = await q.one<Record<string, number>>(
        `select
           (select count(*)::int from condominiums c where c.status = 'active' and ${f('c.id')}) as condominiums,
           (select count(*)::int from units u join condominiums c on c.id = u.condominium_id
             where u.status = 'active' and c.status = 'active' and ${f('u.condominium_id')}) as units,
           (select count(*)::int from assemblies a where a.status = any($1::text[]) and ${f('a.condominium_id')}) as live,
           (select count(*)::int from assemblies a where a.status = any($2::text[]) and ${f('a.condominium_id')}) as scheduled,
           (select count(*)::int from assemblies a where a.status = any($3::text[]) and ${f('a.condominium_id')}) as drafts,
           (select count(*)::int from powers_of_attorney p where p.status = 'pending' and ${f('p.condominium_id')}) as pending_poas`,
        [LIVE, SCHEDULED, DRAFTS, ...scopeParams],
      );
      // Em curso primeiro; agendadas a partir de ontem (cobre a 2ª convocação do mesmo dia).
      const upcoming = await q.rows(
        `select a.id, a.code, a.title, a.status, a.first_call_at, a.modality, c.name as condominium_name
           from assemblies a join condominiums c on c.id = a.condominium_id
          where (a.status = any($1::text[])
                 or (a.status = any($2::text[]) and coalesce(a.second_call_at, a.first_call_at) >= now() - interval '1 day'))
            and ${f('a.condominium_id', 3)}
          order by (a.status = any($1::text[])) desc, a.first_call_at
          limit 10`,
        [LIVE, SCHEDULED, ...scopeParams],
      );
      return { counts, upcoming };
    });
  }
}
