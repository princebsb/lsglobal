import { Injectable } from '@nestjs/common';
import {
  FIXED_SCALE,
  RuleDefinitionSchema,
  describeRule,
  evaluateThreshold,
  formatFixed,
  parseFixed,
  type RuleDefinition,
  type TallyIssue,
  type Weight,
} from '@lsg/shared';
import type { Q } from '../../db/db.service';
import type { AssemblyRow } from './assemblies.service';

export interface LoadedRule {
  id: string;
  code: string;
  version: number;
  name: string;
  status: string;
  legalBasis: string;
  approvedAt: Date | null;
  definition: RuleDefinition;
}

/** Tolerância para soma de frações (dízimas): 0,000001. */
const FRACTION_TOLERANCE = 10_000n;

/**
 * Cálculo de quórum a partir da fonte autoritativa (banco). Distingue:
 * unidades elegíveis, presentes (credenciadas), restritas e pendências cadastrais/jurídicas.
 */
@Injectable()
export class QuorumService {
  async loadRule(q: Q, id: string | null): Promise<LoadedRule | null> {
    if (!id) return null;
    const r = await q.maybe<{
      id: string; code: string; version: number; name: string; status: string; legal_basis: string;
      approved_at: Date | null; definition: unknown;
    }>('select id, code, version, name, status, legal_basis, approved_at, definition from quorum_rules where id = $1', [id]);
    if (!r) return null;
    const def = RuleDefinitionSchema.parse(r.definition);
    return {
      id: r.id, code: r.code, version: r.version, name: r.name, status: r.status, legalBasis: r.legal_basis,
      approvedAt: r.approved_at, definition: def,
    };
  }

  async electorate(q: Q, condominiumId: string) {
    const r = await q.one<{ eligible_units: number; eligible_fraction: string; total_units: number; total_fraction: string; restricted_units: number }>(
      `select count(*) filter (where voting_status = 'eligible')::int as eligible_units,
              coalesce(sum(ideal_fraction) filter (where voting_status = 'eligible'), 0)::text as eligible_fraction,
              count(*)::int as total_units,
              coalesce(sum(ideal_fraction), 0)::text as total_fraction,
              count(*) filter (where voting_status = 'restricted')::int as restricted_units
         from units where condominium_id = $1 and status = 'active'`,
      [condominiumId],
    );
    return {
      eligible: { units: r.eligible_units, fraction: parseFixed(r.eligible_fraction) } as Weight,
      total: { units: r.total_units, fraction: parseFixed(r.total_fraction) } as Weight,
      restrictedUnits: r.restricted_units,
    };
  }

  async present(q: Q, assemblyId: string) {
    const r = await q.one<{ units: number; fraction: string; presencial: number; remoto: number; by_poa: number }>(
      `select count(*)::int as units, coalesce(sum(u.ideal_fraction), 0)::text as fraction,
              count(*) filter (where a.mode = 'presencial')::int as presencial,
              count(*) filter (where a.mode = 'remoto')::int as remoto,
              count(*) filter (where a.basis = 'procuracao')::int as by_poa
         from accreditations a join units u on u.id = a.unit_id
        where a.assembly_id = $1 and a.revoked_at is null and u.voting_status = 'eligible' and u.status = 'active'`,
      [assemblyId],
    );
    return {
      weight: { units: r.units, fraction: parseFixed(r.fraction) } as Weight,
      presencial: r.presencial,
      remoto: r.remoto,
      byPoa: r.by_poa,
    };
  }

  /** Pendências que impedem ou alertam a declaração de resultados. presentUnitIds: unidades presentes/votantes. */
  async issues(q: Q, a: AssemblyRow, opts: { countingUnit?: 'unit' | 'ideal_fraction'; presentUnitIds?: string[] } = {}): Promise<TallyIssue[]> {
    const out: TallyIssue[] = [];
    if (!a.rules_homologated_at) {
      out.push({ code: 'RULES_NOT_HOMOLOGATED', severity: 'blocking', message: 'Regras da assembleia não homologadas.' });
    }
    const el = await this.electorate(q, a.condominium_id);
    const diff = el.total.fraction > FIXED_SCALE ? el.total.fraction - FIXED_SCALE : FIXED_SCALE - el.total.fraction;
    if (diff > FRACTION_TOLERANCE) {
      out.push({
        code: 'FRACTION_SUM_MISMATCH',
        severity: opts.countingUnit === 'ideal_fraction' ? 'blocking' : 'warning',
        message: `Soma das frações ideais cadastradas é ${formatFixed(el.total.fraction)} (esperado 1). Divergência cadastral.`,
      });
    } else if (diff > 0n) {
      out.push({ code: 'FRACTION_SUM_ROUNDING', severity: 'warning', message: `Soma das frações: ${formatFixed(el.total.fraction)} (arredondamento).` });
    }
    if (el.restrictedUnits > 0) {
      out.push({ code: 'UNITS_RESTRICTED', severity: 'warning', message: `${el.restrictedUnits} unidade(s) com direito de voto restrito.` });
    }
    const pending = await q.rows<{ unit_id: string }>(
      `select distinct pu.unit_id from powers_of_attorney p join poa_units pu on pu.poa_id = p.id
        where p.condominium_id = $1 and p.status = 'pending'
          and (p.scope = 'general' or p.assembly_id = $2)`,
      [a.condominium_id, a.id],
    );
    if (pending.length > 0) {
      const present = new Set(opts.presentUnitIds ?? []);
      const absentPending = pending.filter((p) => !present.has(p.unit_id)).length;
      if (absentPending > 0) {
        out.push({
          code: 'POA_PENDING',
          severity: 'blocking',
          message: `${absentPending} unidade(s) ausente(s) com procuração pendente de análise — o procurador pode ter sido impedido de votar.`,
        });
      } else {
        out.push({ code: 'POA_PENDING_PRESENT', severity: 'warning', message: 'Há procurações pendentes de unidades que estão presentes.' });
      }
    }
    const noRep = await q.one<{ n: number }>(
      `select count(*)::int as n from units u
        where u.condominium_id = $1 and u.status = 'active'
          and (select count(*) from unit_ownerships o where o.unit_id = u.id and o.ended_at is null) > 1
          and not exists (select 1 from unit_ownerships o where o.unit_id = u.id and o.ended_at is null and o.is_voting_representative)`,
      [a.condominium_id],
    );
    if (noRep.n > 0) {
      out.push({ code: 'COOWNERS_NO_REPRESENTATIVE', severity: 'warning', message: `${noRep.n} unidade(s) com coproprietários sem representante designado.` });
    }
    const noOwner = await q.one<{ n: number }>(
      `select count(*)::int as n from units u where u.condominium_id = $1 and u.status = 'active'
          and not exists (select 1 from unit_ownerships o where o.unit_id = u.id and o.ended_at is null)`,
      [a.condominium_id],
    );
    if (noOwner.n > 0) out.push({ code: 'UNITS_WITHOUT_OWNER', severity: 'warning', message: `${noOwner.n} unidade(s) sem titular cadastrado.` });
    return out;
  }

  /** Quórum de presença em tempo real para as duas convocações. */
  async live(q: Q, a: AssemblyRow) {
    const el = await this.electorate(q, a.condominium_id);
    const pr = await this.present(q, a.id);
    const r1 = await this.loadRule(q, a.first_call_presence_rule_id);
    const r2 = await this.loadRule(q, a.second_call_presence_rule_id);
    const evalRule = (r: LoadedRule | null) =>
      r
        ? {
            rule: { id: r.id, code: r.code, version: r.version, name: r.name, status: r.status, description: describeRule(r.definition) },
            evaluation: evaluateThreshold(r.definition, pr.weight, el.eligible),
          }
        : null;
    const presentIds = (await q.rows<{ unit_id: string }>(
      'select unit_id from accreditations where assembly_id = $1 and revoked_at is null', [a.id],
    )).map((r) => r.unit_id);
    return {
      electorate: { units: el.eligible.units, fraction: formatFixed(el.eligible.fraction) },
      totalUnits: el.total.units,
      totalFraction: formatFixed(el.total.fraction),
      restrictedUnits: el.restrictedUnits,
      present: {
        units: pr.weight.units,
        fraction: formatFixed(pr.weight.fraction),
        presencial: pr.presencial,
        remoto: pr.remoto,
        byPoa: pr.byPoa,
      },
      firstCall: evalRule(r1),
      secondCall: evalRule(r2),
      issues: await this.issues(q, a, { presentUnitIds: presentIds }),
      computedAt: new Date().toISOString(),
    };
  }
}
