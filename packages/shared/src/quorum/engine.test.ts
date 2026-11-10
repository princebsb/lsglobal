import { describe, expect, it } from 'vitest';
import { formatFixed, parseFixed } from '../fixed';
import { evaluateThreshold, tallyBallot, validateChoice, type TallyInput, type Weight } from './engine';
import { RuleDefinitionSchema, type RuleDefinition } from './rules';
import { RULE_TEMPLATES } from './templates';

const tpl = (code: string): RuleDefinition => RULE_TEMPLATES.find((t) => t.code === code)!.definition;
const w = (units: number, fraction: string): Weight => ({ units, fraction: parseFixed(fraction) });

const yesNo = [
  { id: 'Y', label: 'Sim', kind: 'yes' as const },
  { id: 'N', label: 'Não', kind: 'no' as const },
  { id: 'A', label: 'Abstenção', kind: 'abstention' as const },
];

function vote(opt: string, fraction: string) {
  return { optionIds: [opt], weight: w(1, fraction) };
}

describe('aritmética de ponto fixo', () => {
  it('converte e formata sem perda', () => {
    expect(parseFixed('0.0833333333')).toBe(833333333n);
    expect(formatFixed(parseFixed('0.5'))).toBe('0.5');
    expect(formatFixed(parseFixed('1'))).toBe('1');
    expect(() => parseFixed('0.12345678901')).toThrow();
    expect(() => parseFixed('-1')).toThrow();
  });
  it('soma de 3 terços não sofre erro de ponto flutuante', () => {
    const third = parseFixed('0.3333333333');
    expect(formatFixed(third * 3n)).toBe('0.9999999999');
  });
});

describe('templates', () => {
  it('todos os modelos são definições válidas', () => {
    for (const t of RULE_TEMPLATES) expect(RuleDefinitionSchema.safeParse(t.definition).success).toBe(true);
  });
  it('regra de presença com base diferente de electorate é rejeitada', () => {
    const bad = { ...tpl('CC1352-PRESENCA-1A'), base: 'present' };
    expect(RuleDefinitionSchema.safeParse(bad).success).toBe(false);
  });
});

describe('evaluateThreshold', () => {
  const half = { countingUnit: 'unit' as const, threshold: { numerator: 1, denominator: 2 } };
  it('maioria simples ">" exige estritamente mais da metade', () => {
    const r = { ...half, comparator: 'greater_than' as const };
    expect(evaluateThreshold(r, w(5, '0'), w(10, '0')).met).toBe(false);
    expect(evaluateThreshold(r, w(6, '0'), w(10, '0')).met).toBe(true);
    expect(evaluateThreshold(r, w(5, '0'), w(10, '0')).required).toBe('6');
    expect(evaluateThreshold(r, w(5, '0'), w(9, '0')).required).toBe('5');
  });
  it('">=" metade é satisfeito exatamente na metade', () => {
    const r = { ...half, comparator: 'greater_or_equal' as const };
    expect(evaluateThreshold(r, w(5, '0'), w(10, '0')).met).toBe(true);
    expect(evaluateThreshold(r, w(4, '0'), w(9, '0')).met).toBe(false);
    expect(evaluateThreshold(r, w(4, '0'), w(9, '0')).required).toBe('5');
  });
  it('2/3 por fração ideal — fronteira exata', () => {
    const r = {
      countingUnit: 'ideal_fraction' as const,
      comparator: 'greater_or_equal' as const,
      threshold: { numerator: 2, denominator: 3 },
    };
    expect(evaluateThreshold(r, w(2, '0.6666666666'), w(3, '0.9999999999')).met).toBe(true);
    expect(evaluateThreshold(r, w(2, '0.6666666665'), w(3, '0.9999999999')).met).toBe(false);
  });
  it('base zero não satisfaz limiar positivo', () => {
    const r = { ...half, comparator: 'greater_or_equal' as const };
    expect(evaluateThreshold(r, w(0, '0'), w(0, '0')).met).toBe(false);
  });
  it('limiar zero (2ª convocação) é sempre satisfeito', () => {
    expect(evaluateThreshold(tpl('CC1353-PRESENCA-2A'), w(0, '0'), w(10, '1')).met).toBe(true);
  });
  it('mínimo absoluto de unidades', () => {
    const r = { ...half, comparator: 'greater_than' as const, minimumUnits: 3 };
    expect(evaluateThreshold(r, w(2, '0'), w(2, '0')).met).toBe(false);
  });
});

function baseInput(over: Partial<TallyInput>): TallyInput {
  return {
    ballotType: 'yes_no',
    seats: 1,
    options: yesNo,
    electorate: w(4, '1'),
    present: w(4, '1'),
    votes: [],
    approvalRule: tpl('CC1352-MAIORIA-PRESENTES-FRACAO'),
    presenceRule: tpl('CC1352-PRESENCA-1A'),
    ...over,
  };
}

describe('tallyBallot — Sim/Não ponderado por fração ideal', () => {
  it('fração ideal pode inverter o resultado por cabeça', () => {
    const r = tallyBallot(
      baseInput({
        votes: [vote('Y', '0.4'), vote('N', '0.2'), vote('N', '0.2'), vote('N', '0.2')],
      }),
    );
    expect(r.outcome).toBe('rejected');
    // por fração: Sim 0.4 de 1.0 válidos → não supera 1/2
    expect(r.options.find((o) => o.id === 'Y')!.fraction).toBe('0.4');

    const byUnit = tallyBallot(
      baseInput({
        approvalRule: tpl('CC1352-MAIORIA-PRESENTES-UNIDADE'),
        votes: [vote('Y', '0.4'), vote('Y', '0.2'), vote('Y', '0.2'), vote('N', '0.2')],
      }),
    );
    expect(byUnit.outcome).toBe('approved');
  });

  it('abstenção fora da base (valid_votes)', () => {
    const r = tallyBallot(
      baseInput({ votes: [vote('Y', '0.3'), vote('N', '0.2'), vote('A', '0.5')] }),
    );
    expect(r.totals.validVotes.fraction).toBe('0.5');
    expect(r.totals.nonValid.fraction).toBe('0.5');
    expect(r.outcome).toBe('approved'); // 0.3 > 0.25
  });

  it('abstenção na base (votes_cast) muda o resultado', () => {
    const rule: RuleDefinition = { ...tpl('CC1352-MAIORIA-PRESENTES-FRACAO'), base: 'votes_cast' };
    const r = tallyBallot(
      baseInput({ approvalRule: rule, votes: [vote('Y', '0.3'), vote('N', '0.2'), vote('A', '0.5')] }),
    );
    expect(r.outcome).toBe('rejected'); // 0.3 não é > 0.5
  });

  it('quórum de presença de 1ª convocação não atingido', () => {
    const r = tallyBallot(baseInput({ present: w(1, '0.4'), votes: [vote('Y', '0.4')] }));
    expect(r.presence?.met).toBe(false);
    expect(r.outcome).toBe('quorum_not_met');
    expect(r.declarable).toBe(true);
  });

  it('2/3 da totalidade (quórum especial) usa a base eleitoral, não os presentes', () => {
    const r = tallyBallot(
      baseInput({
        approvalRule: tpl('CC1351-DOIS-TERCOS'),
        present: w(3, '0.7'),
        votes: [vote('Y', '0.3'), vote('Y', '0.3'), vote('N', '0.1')],
      }),
    );
    expect(r.outcome).toBe('rejected'); // 0.6 < 2/3 de 1.0
    expect(r.approval?.base).toBe('1');
  });

  it('sem regra de aprovação → indeterminado e não declarável', () => {
    const r = tallyBallot(baseInput({ approvalRule: null, votes: [vote('Y', '0.5')] }));
    expect(r.outcome).toBe('undetermined');
    expect(r.declarable).toBe(false);
  });

  it('pendência bloqueante externa impede declaração', () => {
    const r = tallyBallot(
      baseInput({
        votes: [vote('Y', '0.9')],
        preIssues: [{ code: 'POA_PENDING', severity: 'blocking', message: 'Procuração pendente' }],
      }),
    );
    expect(r.declarable).toBe(false);
    expect(r.outcome).toBe('undetermined');
    expect(r.winners).toEqual([]);
  });

  it('mais votos que presentes é inconsistência bloqueante', () => {
    const r = tallyBallot(baseInput({ present: w(1, '0.6'), votes: [vote('Y', '0.3'), vote('Y', '0.3')] }));
    expect(r.issues.some((i) => i.code === 'VOTES_EXCEED_PRESENT')).toBe(true);
    expect(r.declarable).toBe(false);
  });
});

describe('tallyBallot — eleições e múltipla escolha', () => {
  const cand = [
    { id: 'C1', label: 'Chapa 1', kind: 'regular' as const },
    { id: 'C2', label: 'Chapa 2', kind: 'regular' as const },
    { id: 'C3', label: 'Chapa 3', kind: 'regular' as const },
    { id: 'B', label: 'Branco', kind: 'blank' as const },
  ];
  const rule = tpl('CC1352-MAIORIA-PRESENTES-UNIDADE');

  it('eleição com vencedor por maioria', () => {
    const r = tallyBallot(
      baseInput({
        ballotType: 'election',
        options: cand,
        approvalRule: rule,
        votes: [vote('C1', '0.25'), vote('C1', '0.25'), vote('C1', '0.25'), vote('C2', '0.25')],
      }),
    );
    expect(r.outcome).toBe('elected');
    expect(r.winners).toEqual(['C1']);
  });

  it('empate é sinalizado', () => {
    const r = tallyBallot(
      baseInput({
        ballotType: 'election',
        options: cand,
        approvalRule: rule,
        votes: [vote('C1', '0.25'), vote('C1', '0.25'), vote('C2', '0.25'), vote('C2', '0.25')],
      }),
    );
    expect(r.outcome).toBe('tie');
  });

  it('nenhum candidato com maioria → no_winner', () => {
    const r = tallyBallot(
      baseInput({
        ballotType: 'single_choice',
        options: cand,
        approvalRule: rule,
        votes: [vote('C1', '0.25'), vote('C1', '0.25'), vote('C2', '0.25'), vote('C3', '0.25')],
      }),
    );
    // C1 tem 2 de 4 votos válidos — não supera a metade
    expect(r.outcome).toBe('no_winner');
    expect(r.winners).toEqual([]);
  });

  it('múltipla escolha soma o peso a cada opção, mas uma vez na base', () => {
    const r = tallyBallot(
      baseInput({
        ballotType: 'multiple_choice',
        seats: 2,
        options: cand,
        approvalRule: rule,
        votes: [
          { optionIds: ['C1', 'C2'], weight: w(1, '0.25') },
          { optionIds: ['C1', 'C3'], weight: w(1, '0.25') },
          { optionIds: ['C1', 'C2'], weight: w(1, '0.25') },
        ],
      }),
    );
    expect(r.totals.votesCast.units).toBe(3);
    expect(r.options.find((o) => o.id === 'C1')!.units).toBe(3);
    expect(r.winners).toEqual(['C1', 'C2']);
  });
});

describe('validateChoice', () => {
  const ballot = {
    ballotType: 'multiple_choice' as const,
    maxChoices: 2,
    options: [
      { id: 'a', label: 'A', kind: 'regular' as const },
      { id: 'b', label: 'B', kind: 'regular' as const },
      { id: 'c', label: 'C', kind: 'regular' as const },
      { id: 'x', label: 'Abstenção', kind: 'abstention' as const },
    ],
  };
  it('aceita escolhas válidas', () => expect(validateChoice(ballot, ['a', 'b'])).toBeNull());
  it('rejeita excesso', () => expect(validateChoice(ballot, ['a', 'b', 'c'])).not.toBeNull());
  it('rejeita repetição', () => expect(validateChoice(ballot, ['a', 'a'])).not.toBeNull());
  it('rejeita abstenção combinada', () => expect(validateChoice(ballot, ['a', 'x'])).not.toBeNull());
  it('rejeita opção inexistente', () => expect(validateChoice(ballot, ['z'])).not.toBeNull());
  it('Sim/Não aceita uma única opção', () =>
    expect(validateChoice({ ...ballot, ballotType: 'yes_no' }, ['a', 'b'])).not.toBeNull());
});
