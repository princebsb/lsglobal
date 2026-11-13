import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthzService } from '../../authz/authz.service';
import { Ctx, RequirePermission, TenantScoped, type ReqCtx } from '../../common/http';
import { condoFilter, dbc } from '../../common/scope';
import { DbService } from '../../db/db.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Condomínio a que um evento se refere: pela assembleia ou, na falta dela, pelo recurso afetado.
 * Usado apenas quando o escopo do usuário é restrito a condomínios (síndico, fiscal).
 * Eventos sem vínculo com condomínio (login, pessoas, usuários) ficam visíveis só para quem tem escopo no tenant inteiro.
 */
const EVENT_CONDOMINIUM = `coalesce(
  (select x.condominium_id from assemblies x where x.id = e.assembly_id),
  case e.resource_type
    when 'condominium' then (select x.id from condominiums x where x.id::text = e.resource_id)
    when 'unit' then (select x.condominium_id from units x where x.id::text = e.resource_id)
    when 'building' then (select x.condominium_id from buildings x where x.id::text = e.resource_id)
    when 'quorum_rule' then (select x.condominium_id from quorum_rules x where x.id::text = e.resource_id)
    when 'poa' then (select x.condominium_id from powers_of_attorney x where x.id::text = e.resource_id)
  end)`;

/**
 * Trilha de auditoria do cliente (cadeia de hash do tenant: chain_key = tenant_id, ver migração 0001).
 * Leitura sujeita ao RLS de audit_events (tenant corrente).
 */
@ApiTags('Auditoria')
@ApiBearerAuth()
@TenantScoped()
@Controller('audit')
export class AuditController {
  constructor(
    private readonly db: DbService,
    private readonly authz: AuthzService,
  ) {}

  /** Eventos mais recentes primeiro; paginação por chain_seq (beforeSeq). action filtra por prefixo (ex.: "ballot."). */
  @Get()
  @RequirePermission('audit.view')
  async list(
    @Ctx() ctx: ReqCtx,
    @Query('assemblyId') assemblyId?: string,
    @Query('action') action?: string,
    @Query('beforeSeq') beforeSeq?: string,
    @Query('limit') limit?: string,
  ) {
    const asm = assemblyId?.trim() || null;
    if (asm && !UUID_RE.test(asm)) throw new BadRequestException('assemblyId inválido');
    const before = beforeSeq?.trim() || null;
    if (before && !/^\d{1,18}$/.test(before)) throw new BadRequestException('beforeSeq inválido');
    const act = action?.trim().slice(0, 100) || null;
    const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const scope = this.authz.condoScope(ctx, 'audit.view');
    const f = condoFilter(scope, EVENT_CONDOMINIUM, 6);
    return this.db.tx(dbc(ctx), (q) =>
      q.rows(
        `select e.id, e.chain_seq, e.actor_user_id, u.full_name as actor_name, u.email as actor_email, e.action,
                e.resource_type, e.resource_id, e.assembly_id, e.outcome, e.metadata, e.occurred_at, e.hash, e.ip
           from audit_events e left join users u on u.id = e.actor_user_id
          where e.chain_key = $1
            and ($2::uuid is null or e.assembly_id = $2)
            and ($3::text is null or starts_with(e.action, $3))
            and ($4::bigint is null or e.chain_seq < $4)
            and ${f.sql}
          order by e.chain_seq desc
          limit $5`,
        [ctx.tenantId, asm, act, before, n, ...f.params],
      ),
    );
  }

  /** Verifica a integridade da cadeia do tenant (mesmo formato de /platform/audit/verify). */
  @Get('verify')
  @RequirePermission('audit.view')
  async verify(@Ctx() ctx: ReqCtx) {
    return this.db.tx(dbc(ctx), (q) =>
      q.one(`select checked::int, valid, first_invalid_seq, head_hash from audit_verify_chain($1)`, [ctx.tenantId]),
    );
  }
}
