import { formatFixed, parseFixed, ratioToPercent } from '../fixed';
import type { Comparator, CountingUnit, RuleDefinition } from './rules';

/** Peso de uma unidade/voto: contagem por unidade e fração ideal (ponto fixo 10^10). */
export interface Weight {
  units: number;
  fraction: bigint;
}

export const ZERO_WEIGHT: Weight = Object.freeze({ units: 0, fraction: 0n }) as Weight;

export function addWeight(a: Weight, b: Weight): Weight {
  return { units: a.units + b.units, fraction: a.fraction + b.fraction };
}

export function weightOf(fraction: string | bigint): Weight {
  return { units: 1, fraction: typeof fraction === 'bigint' ? fraction : parseFixed(fraction) };
}

function measure(w: Weight, unit: CountingUnit): bigint {
  return unit === 'unit' ? BigInt(w.units) : w.fraction;
}

function formatMeasure(v: bigint, unit: CountingUnit): string {
  return unit === 'unit' ? v.toString() : formatFixed(v);
}

export interface RuleEvaluation {
  met: boolean;
  countingUnit: CountingUnit;
  comparator: Comparator;
  threshold: { numerator: number; denominator: number };
  /** Valor medido (unidades ou fração ideal). */
  achieved: string;
  /** Valor do denominador. */
  base: string;
  /** Menor valor que satisfaz a regra (na granularidade da unidade de contagem). */
  required: string;
  achievedPercent: string;
  requiredPercent: string;
  minimumUnits?: number;
}

/**
 * Avalia  achieved [>|>=] (num/den) × base  com aritmética inteira exata.
 * Base zero: só é satisfeita quando o limiar é zero e o comparador é ">=".
 */
export function evaluateThreshold(
  rule: Pick<RuleDefinition, 'countingUnit' | 'comparator' | 'threshold' | 'minimumUnits'>,
  achievedW: Weight,
  baseW: Weight,
): RuleEvaluation {
  const unit = rule.countingUnit;
  const achieved = measure(achievedW, unit);
  const base = measure(baseW, unit);
  const num = BigInt(rule.threshold.numerator);
  const den = BigInt(rule.threshold.denominator);

  const lhs = achieved * den;
  const rhs = base * num;
  let met = rule.comparator === 'greater_than' ? lhs > rhs : lhs >= rhs;
  if (base === 0n && num > 0n) met = false;
  if (rule.minimumUnits !== undefined && achievedW.units < rule.minimumUnits) met = false;

  // menor valor inteiro (na escala da unidade de contagem) que satisfaz a regra
  const product = base * num;
  let required: bigint;
  if (rule.comparator === 'greater_or_equal') {
    required = product === 0n ? 0n : (product + den - 1n) / den;
  } else {
    required = product / den + 1n;
  }

  return {
    met,
    countingUnit: unit,
    comparator: rule.comparator,
    threshold: { ...rule.threshold },
    achieved: formatMeasure(achieved, unit),
    base: formatMeasure(base, unit),
    required: formatMeasure(required, unit),
    achievedPercent: ratioToPercent(achieved, base),
    requiredPercent: ratioToPercent(num, den),
    ...(rule.minimumUnits !== undefined ? { minimumUnits: rule.minimumUnits } : {}),
  };
}

// ---------------------------------------------------------------------------
// Apuração
// ---------------------------------------------------------------------------

export const BALLOT_TYPES = ['yes_no', 'single_choice', 'multiple_choice', 'election'] as const;
export type BallotType = (typeof BALLOT_TYPES)[number];

export const OPTION_KINDS = ['regular', 'yes', 'no', 'abstention', 'blank', 'null'] as const;
export type OptionKind = (typeof OPTION_KINDS)[number];

export const NON_VALID_KINDS: readonly OptionKind[] = ['abstention', 'blank', 'null'];

export interface TallyOption {
  id: string;
  label: string;
  kind: OptionKind;
}

export interface TallyVote {
  optionIds: string[];
  weight: Weight;
}

export type IssueSeverity = 'blocking' | 'warning';

export interface TallyIssue {
  code: string;
  severity: IssueSeverity;
  message: string;
}

export interface TallyInput {
  ballotType: BallotType;
  /** Número de vagas/opções vencedoras (eleições e múltipla escolha). */
  seats: number;
  options: TallyOption[];
  electorate: Weight;
  present: Weight;
  votes: TallyVote[];
  approvalRule: RuleDefinition | null;
  presenceRule: RuleDefinition | null;
  /** Pendências já detectadas pelo servidor (regra não homologada, divergência cadastral etc.). */
  preIssues?: TallyIssue[];
}

export type TallyOutcome =
  | 'approved'
  | 'rejected'
  | 'elected'
  | 'no_winner'
  | 'tie'
  | 'quorum_not_met'
  | 'undetermined';

export interface OptionResult {
  id: string;
  label: string;
  kind: OptionKind;
  units: number;
  fraction: string;
  /** Percentual na unidade de contagem da regra de aprovação, sobre a base da regra. */
  percentOfBase: string;
}

export interface TallyResult {
  countingUnit: CountingUnit;
  options: OptionResult[];
  totals: {
    electorate: { units: number; fraction: string };
    present: { units: number; fraction: string };
    votesCast: { units: number; fraction: string };
    validVotes: { units: number; fraction: string };
    nonValid: { units: number; fraction: string };
    pending: { units: number; fraction: string };
  };
  presence: RuleEvaluation | null;
  approval: RuleEvaluation | null;
  winners: string[];
  outcome: TallyOutcome;
  issues: TallyIssue[];
  /** Pode ser declarado pela mesa (não há pendências bloqueantes). */
  declarable: boolean;
}

function w2json(w: Weight) {
  return { units: w.units, fraction: formatFixed(w.fraction) };
}

export function tallyBallot(input: TallyInput): TallyResult {
  const issues: TallyIssue[] = [...(input.preIssues ?? [])];
  const unit: CountingUnit = input.approvalRule?.countingUnit ?? 'unit';

  if (!input.approvalRule) {
    issues.push({
      code: 'APPROVAL_RULE_MISSING',
      severity: 'blocking',
      message: 'Deliberação sem regra de aprovação configurada e homologada.',
    });
  }
  if (unit === 'ideal_fraction' && input.electorate.fraction === 0n) {
    issues.push({
      code: 'ELECTORATE_FRACTION_ZERO',
      severity: 'blocking',
      message: 'Contagem por fração ideal com base eleitoral sem frações cadastradas.',
    });
  }

  const optionById = new Map(input.options.map((o) => [o.id, o]));
  const totals = new Map<string, Weight>(input.options.map((o) => [o.id, { ...ZERO_WEIGHT }]));
  let votesCast: Weight = { ...ZERO_WEIGHT };
  let validVotes: Weight = { ...ZERO_WEIGHT };

  for (const v of input.votes) {
    const opts = v.optionIds.map((id) => optionById.get(id));
    if (opts.some((o) => !o) || opts.length === 0) {
      issues.push({
        code: 'VOTE_UNKNOWN_OPTION',
        severity: 'blocking',
        message: 'Existe voto referenciando opção inexistente. Verificar integridade.',
      });
      continue;
    }
    votesCast = addWeight(votesCast, v.weight);
    const isValid = opts.every((o) => !NON_VALID_KINDS.includes(o!.kind));
    if (isValid) validVotes = addWeight(validVotes, v.weight);
    for (const id of v.optionIds) totals.set(id, addWeight(totals.get(id)!, v.weight));
  }

  const nonValid: Weight = {
    units: votesCast.units - validVotes.units,
    fraction: votesCast.fraction - validVotes.fraction,
  };
  const pending: Weight = {
    units: Math.max(0, input.present.units - votesCast.units),
    fraction: input.present.fraction > votesCast.fraction ? input.present.fraction - votesCast.fraction : 0n,
  };

  if (votesCast.units > input.present.units) {
    issues.push({
      code: 'VOTES_EXCEED_PRESENT',
      severity: 'blocking',
      message: 'Número de votos maior que o de unidades presentes. Verificar credenciamento.',
    });
  }

  const baseFor = (rule: RuleDefinition): Weight => {
    switch (rule.base) {
      case 'electorate':
        return input.electorate;
      case 'present':
        return input.present;
      case 'votes_cast':
        return votesCast;
      case 'valid_votes':
        return validVotes;
    }
  };

  const approvalBase = input.approvalRule ? baseFor(input.approvalRule) : votesCast;
  const options: OptionResult[] = input.options.map((o) => {
    const t = totals.get(o.id)!;
    return {
      id: o.id,
      label: o.label,
      kind: o.kind,
      units: t.units,
      fraction: formatFixed(t.fraction),
      percentOfBase: ratioToPercent(measure(t, unit), measure(approvalBase, unit)),
    };
  });

  const presence = input.presenceRule
    ? evaluateThreshold(input.presenceRule, input.present, input.electorate)
    : null;

  let outcome: TallyOutcome = 'undetermined';
  let approval: RuleEvaluation | null = null;
  let winners: string[] = [];

  if (input.approvalRule) {
    if (presence && !presence.met) {
      outcome = 'quorum_not_met';
    } else if (input.ballotType === 'yes_no') {
      const yes = input.options.find((o) => o.kind === 'yes');
      if (!yes) {
        issues.push({
          code: 'YES_OPTION_MISSING',
          severity: 'blocking',
          message: 'Votação Sim/Não sem opção "Sim" definida.',
        });
      } else {
        approval = evaluateThreshold(input.approvalRule, totals.get(yes.id)!, approvalBase);
        outcome = approval.met ? 'approved' : 'rejected';
        if (approval.met) winners = [yes.id];
      }
    } else {
      const seats = Math.max(1, input.seats);
      const ranked = input.options
        .filter((o) => o.kind === 'regular')
        .map((o) => ({ o, m: measure(totals.get(o.id)!, unit) }))
        .sort((a, b) => (a.m === b.m ? 0 : a.m > b.m ? -1 : 1));
      const cut = ranked[seats - 1];
      const next = ranked[seats];
      if (ranked.length === 0) {
        issues.push({ code: 'NO_OPTIONS', severity: 'blocking', message: 'Sem opções concorrentes.' });
      } else if (cut && next && cut.m === next.m && cut.m > 0n) {
        outcome = 'tie';
        issues.push({
          code: 'TIE',
          severity: 'warning',
          message: 'Empate na última posição vencedora. A mesa deve aplicar o critério de desempate previsto.',
        });
      } else {
        const top = ranked.slice(0, seats).filter((r) => r.m > 0n);
        const evals = top.map((r) => ({
          r,
          e: evaluateThreshold(input.approvalRule!, totals.get(r.o.id)!, approvalBase),
        }));
        approval = evals[0]?.e ?? evaluateThreshold(input.approvalRule, ZERO_WEIGHT, approvalBase);
        winners = evals.filter((x) => x.e.met).map((x) => x.r.o.id);
        outcome = winners.length > 0 ? 'elected' : 'no_winner';
      }
    }
  }

  const declarable = !issues.some((i) => i.severity === 'blocking');
  if (!declarable) outcome = 'undetermined';

  return {
    countingUnit: unit,
    options,
    totals: {
      electorate: w2json(input.electorate),
      present: w2json(input.present),
      votesCast: w2json(votesCast),
      validVotes: w2json(validVotes),
      nonValid: w2json(nonValid),
      pending: w2json(pending),
    },
    presence,
    approval,
    winners: declarable ? winners : [],
    outcome,
    issues,
    declarable,
  };
}

// ---------------------------------------------------------------------------
// Validação de escolha do eleitor
// ---------------------------------------------------------------------------

export interface ChoiceValidationBallot {
  ballotType: BallotType;
  maxChoices: number;
  options: TallyOption[];
}

/** Retorna mensagem de erro ou null se a escolha é válida. */
export function validateChoice(ballot: ChoiceValidationBallot, optionIds: string[]): string | null {
  if (optionIds.length === 0) return 'Selecione ao menos uma opção.';
  if (new Set(optionIds).size !== optionIds.length) return 'Opção repetida.';
  const byId = new Map(ballot.options.map((o) => [o.id, o]));
  const chosen = optionIds.map((id) => byId.get(id));
  if (chosen.some((o) => !o)) return 'Opção inexistente para esta votação.';
  const special = chosen.filter((o) => o!.kind !== 'regular' && o!.kind !== 'yes' && o!.kind !== 'no');
  if (special.length > 0 && chosen.length > 1) {
    return 'Abstenção, voto em branco ou nulo não podem ser combinados com outras opções.';
  }
  const limit = ballot.ballotType === 'multiple_choice' ? ballot.maxChoices : 1;
  if (chosen.length > limit) return `Máximo de ${limit} opção(ões).`;
  return null;
}
