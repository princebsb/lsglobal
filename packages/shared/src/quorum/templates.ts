import type { RuleDefinition } from './rules';

/**
 * MODELOS de regras — ponto de partida, NÃO regras vigentes.
 *
 * Todos os modelos exigem validação jurídica. Ao ser copiado para um condomínio, o modelo
 * vira uma regra em "rascunho" que só pode ser utilizada após homologação por responsável
 * autorizado, que deve conferir a convenção e a redação legal vigente.
 *
 * Observação para a validação jurídica: a redação do art. 1.351 do Código Civil foi alterada
 * pela Lei nº 14.405/2022 (alteração de convenção e mudança de destinação: 2/3 dos votos).
 * A Lei nº 14.309/2022 incluiu a sessão permanente (art. 1.353, §§) e a assembleia
 * eletrônica (art. 1.354-A). A interpretação de "maioria dos votos dos presentes" quanto ao
 * cômputo de abstenções é controversa e está parametrizada (base votes_cast × valid_votes).
 */
export interface RuleTemplate {
  code: string;
  name: string;
  legalBasis: string;
  definition: RuleDefinition;
  notes: string;
}

export const RULE_TEMPLATES: readonly RuleTemplate[] = [
  {
    code: 'CC1352-PRESENCA-1A',
    name: 'Presença mínima em 1ª convocação (metade das frações ideais)',
    legalBasis: 'Código Civil, art. 1.352, caput',
    definition: {
      purpose: 'presence',
      countingUnit: 'ideal_fraction',
      base: 'electorate',
      threshold: { numerator: 1, denominator: 2 },
      comparator: 'greater_or_equal',
      explanation:
        'Em 1ª convocação, os presentes devem representar pelo menos metade das frações ideais, salvo quórum especial.',
    },
    notes: 'Verificar se a convenção estabelece critério diverso.',
  },
  {
    code: 'CC1353-PRESENCA-2A',
    name: 'Sem presença mínima em 2ª convocação',
    legalBasis: 'Código Civil, art. 1.353, caput',
    definition: {
      purpose: 'presence',
      countingUnit: 'ideal_fraction',
      base: 'electorate',
      threshold: { numerator: 0, denominator: 1 },
      comparator: 'greater_or_equal',
      explanation: 'Em 2ª convocação, delibera-se por maioria dos presentes, salvo quórum especial.',
    },
    notes: 'Não se aplica às matérias com quórum especial.',
  },
  {
    code: 'CC1352-MAIORIA-PRESENTES-FRACAO',
    name: 'Maioria dos votos dos presentes, ponderada por fração ideal (abstenções fora da base)',
    legalBasis: 'Código Civil, arts. 1.352, parágrafo único, e 1.353',
    definition: {
      purpose: 'approval',
      countingUnit: 'ideal_fraction',
      base: 'valid_votes',
      threshold: { numerator: 1, denominator: 2 },
      comparator: 'greater_than',
      explanation:
        'Votos proporcionais às frações ideais, salvo disposição diversa da convenção. Abstenções, brancos e nulos não integram a base.',
    },
    notes: 'Confirmar interpretação sobre abstenções e se a convenção adota voto por unidade.',
  },
  {
    code: 'CC1352-MAIORIA-PRESENTES-UNIDADE',
    name: 'Maioria dos votos dos presentes, uma unidade = um voto',
    legalBasis: 'Convenção condominial (critério diverso do art. 1.352, parágrafo único)',
    definition: {
      purpose: 'approval',
      countingUnit: 'unit',
      base: 'valid_votes',
      threshold: { numerator: 1, denominator: 2 },
      comparator: 'greater_than',
    },
    notes: 'Utilizar somente se a convenção previr voto por unidade.',
  },
  {
    code: 'CC1351-DOIS-TERCOS',
    name: 'Dois terços dos votos dos condôminos (alteração de convenção / destinação)',
    legalBasis: 'Código Civil, art. 1.351 (redação da Lei nº 14.405/2022)',
    definition: {
      purpose: 'approval',
      countingUnit: 'ideal_fraction',
      base: 'electorate',
      threshold: { numerator: 2, denominator: 3 },
      comparator: 'greater_or_equal',
    },
    notes: 'Base: totalidade dos condôminos, não apenas os presentes. Validar redação vigente.',
  },
  {
    code: 'CC1341-VOLUPTUARIAS',
    name: 'Obras voluptuárias — dois terços dos condôminos',
    legalBasis: 'Código Civil, art. 1.341, I',
    definition: {
      purpose: 'approval',
      countingUnit: 'ideal_fraction',
      base: 'electorate',
      threshold: { numerator: 2, denominator: 3 },
      comparator: 'greater_or_equal',
    },
    notes: 'Validar com a convenção.',
  },
  {
    code: 'CC1341-UTEIS',
    name: 'Obras úteis — maioria dos condôminos',
    legalBasis: 'Código Civil, art. 1.341, II',
    definition: {
      purpose: 'approval',
      countingUnit: 'ideal_fraction',
      base: 'electorate',
      threshold: { numerator: 1, denominator: 2 },
      comparator: 'greater_than',
    },
    notes: 'Validar com a convenção.',
  },
  {
    code: 'CC1349-DESTITUICAO-SINDICO',
    name: 'Destituição do síndico — maioria absoluta dos membros',
    legalBasis: 'Código Civil, art. 1.349',
    definition: {
      purpose: 'approval',
      countingUnit: 'ideal_fraction',
      base: 'electorate',
      threshold: { numerator: 1, denominator: 2 },
      comparator: 'greater_than',
    },
    notes: 'Assembleia especialmente convocada. Validar se a contagem é por fração ou por unidade.',
  },
  {
    code: 'UNANIMIDADE',
    name: 'Unanimidade dos condôminos',
    legalBasis: 'Hipóteses legais ou convencionais que exijam unanimidade',
    definition: {
      purpose: 'approval',
      countingUnit: 'unit',
      base: 'electorate',
      threshold: { numerator: 1, denominator: 1 },
      comparator: 'greater_or_equal',
    },
    notes: 'Validar a hipótese legal aplicável.',
  },
  {
    code: 'ASSOC-MAIORIA-SIMPLES',
    name: 'Associação — maioria simples dos presentes (um associado = um voto)',
    legalBasis: 'Estatuto da associação (Código Civil, arts. 53 a 61)',
    definition: {
      purpose: 'approval',
      countingUnit: 'unit',
      base: 'valid_votes',
      threshold: { numerator: 1, denominator: 2 },
      comparator: 'greater_than',
    },
    notes: 'Perfil próprio para organizações associativas. Não aplicar regras de condomínio edilício.',
  },
];
