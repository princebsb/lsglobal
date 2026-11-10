import { z } from 'zod';

/**
 * Definição parametrizável de regra de quórum/aprovação.
 *
 * Uma regra NUNCA é presumida: cada condomínio precisa ter suas regras cadastradas,
 * versionadas e homologadas por responsável autorizado antes da assembleia.
 *
 * Fórmula geral:  medida(alvo)  [>|>=]  (numerador / denominador) × medida(base)
 *
 * - countingUnit: o que é medido — "unit" (1 por unidade) ou "ideal_fraction" (fração ideal).
 * - base (denominador):
 *     electorate   → todas as unidades elegíveis da base eleitoral (snapshot);
 *     present      → unidades credenciadas/presentes elegíveis;
 *     votes_cast   → todos os votos recebidos, incluindo abstenção, branco e nulo;
 *     valid_votes  → votos recebidos excluindo abstenção, branco e nulo.
 * - Regras de presença ("presence") medem as unidades presentes contra a base eleitoral.
 * - Regras de aprovação ("approval") medem os votos na opção vencedora/“Sim” contra a base.
 */
export const RULE_PURPOSES = ['presence', 'approval'] as const;
export type RulePurpose = (typeof RULE_PURPOSES)[number];

export const COUNTING_UNITS = ['unit', 'ideal_fraction'] as const;
export type CountingUnit = (typeof COUNTING_UNITS)[number];

export const RULE_BASES = ['electorate', 'present', 'votes_cast', 'valid_votes'] as const;
export type RuleBase = (typeof RULE_BASES)[number];

export const COMPARATORS = ['greater_than', 'greater_or_equal'] as const;
export type Comparator = (typeof COMPARATORS)[number];

export const ThresholdSchema = z
  .object({
    numerator: z.number().int().min(0).max(1000),
    denominator: z.number().int().min(1).max(1000),
  })
  .refine((t) => t.numerator <= t.denominator, {
    message: 'O numerador não pode ser maior que o denominador',
  });

export const RuleDefinitionSchema = z
  .object({
    purpose: z.enum(RULE_PURPOSES),
    countingUnit: z.enum(COUNTING_UNITS),
    base: z.enum(RULE_BASES),
    threshold: ThresholdSchema,
    comparator: z.enum(COMPARATORS),
    /** Mínimo absoluto de unidades (opcional) além da proporção. */
    minimumUnits: z.number().int().min(0).optional(),
    /** Texto livre explicando a fórmula em linguagem natural. */
    explanation: z.string().max(1000).optional(),
  })
  .superRefine((r, ctx) => {
    if (r.purpose === 'presence' && r.base !== 'electorate') {
      ctx.addIssue({
        code: 'custom',
        path: ['base'],
        message: 'Regras de presença devem usar a base eleitoral (electorate) como denominador',
      });
    }
  });

export type RuleDefinition = z.infer<typeof RuleDefinitionSchema>;

/** Descrição legível da fórmula, usada em relatórios e na tela de homologação. */
export function describeRule(r: RuleDefinition): string {
  const unit = r.countingUnit === 'ideal_fraction' ? 'das frações ideais' : 'das unidades';
  const baseText: Record<RuleBase, string> = {
    electorate: 'da base eleitoral total',
    present: 'dos presentes',
    votes_cast: 'dos votos recebidos (incluindo abstenções, brancos e nulos)',
    valid_votes: 'dos votos válidos (excluindo abstenções, brancos e nulos)',
  };
  const cmp = r.comparator === 'greater_than' ? 'mais de' : 'pelo menos';
  const frac =
    r.threshold.numerator === 0
      ? 'qualquer quantidade'
      : r.threshold.numerator === r.threshold.denominator
        ? 'a totalidade'
        : `${r.threshold.numerator}/${r.threshold.denominator}`;
  const target = r.purpose === 'presence' ? 'Presença de' : 'Votos favoráveis/vencedores com';
  const min = r.minimumUnits ? `; mínimo de ${r.minimumUnits} unidade(s)` : '';
  return `${target} ${cmp} ${frac} ${unit} ${baseText[r.base]}${min}.`;
}
