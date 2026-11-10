import { z } from 'zod';
import { isValidCnpj, isValidCpf, onlyDigits } from './documents';
import { BALLOT_TYPES, OPTION_KINDS } from './quorum/engine';
import { RuleDefinitionSchema } from './quorum/rules';
import { ASSEMBLY_STATUSES } from './state';

/** Esquemas de entrada compartilhados entre API (validação autoritativa) e Web (UX). */

const uuid = () => z.string().uuid('Identificador inválido');

export const PasswordSchema = z
  .string()
  .min(10, 'Mínimo de 10 caracteres')
  .max(128)
  .regex(/[a-z]/, 'Inclua letra minúscula')
  .regex(/[A-Z]/, 'Inclua letra maiúscula')
  .regex(/\d/, 'Inclua número');

export const EmailSchema = z.string().trim().toLowerCase().email('E-mail inválido').max(254);

export const LoginSchema = z.object({
  email: EmailSchema,
  password: z.string().min(1).max(128),
});
export const MfaVerifySchema = z.object({
  mfaToken: z.string().min(10),
  code: z.string().regex(/^\d{6}$/, 'Código de 6 dígitos'),
});
export const MfaEnableSchema = z.object({ code: z.string().regex(/^\d{6}$/) });

export const TENANT_KINDS = [
  'condominio_independente',
  'administradora',
  'sindico_profissional',
  'associacao',
  'outro',
] as const;

export const CnpjSchema = z
  .string()
  .transform(onlyDigits)
  .refine(isValidCnpj, 'CNPJ inválido');

export const TenantCreateSchema = z.object({
  name: z.string().trim().min(2).max(200),
  kind: z.enum(TENANT_KINDS),
  document: CnpjSchema.optional(),
  admin: z.object({
    email: EmailSchema,
    fullName: z.string().trim().min(2).max(200),
    password: PasswordSchema,
  }),
});

export const CONDOMINIUM_TYPES = [
  'residencial_vertical',
  'residencial_horizontal',
  'comercial',
  'empresarial',
  'misto',
  'clube',
  'multiplas_torres',
  'complexo',
  'associacao',
] as const;
export const LEGAL_REGIMES = ['condominio_edilicio', 'associacao', 'outro'] as const;

export const AddressSchema = z.object({
  street: z.string().max(200).optional(),
  number: z.string().max(20).optional(),
  complement: z.string().max(100).optional(),
  district: z.string().max(100).optional(),
  city: z.string().max(100).optional(),
  state: z.string().length(2).optional(),
  zip: z.string().max(10).optional(),
});

export const CondominiumCreateSchema = z.object({
  name: z.string().trim().min(2).max(200),
  document: CnpjSchema.optional(),
  type: z.enum(CONDOMINIUM_TYPES),
  legalRegime: z.enum(LEGAL_REGIMES),
  address: AddressSchema.default({}),
  timezone: z.string().min(3).max(64).default('America/Sao_Paulo'),
  settings: z
    .object({
      maxUnitsPerAttorney: z.number().int().min(1).max(10000).optional(),
    })
    .default({}),
});
export const CondominiumUpdateSchema = CondominiumCreateSchema.partial();

export const BuildingCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(['torre', 'bloco', 'quadra', 'rua', 'setor', 'outro']).default('bloco'),
});

export const UNIT_KINDS = ['apartamento', 'casa', 'lote', 'sala', 'loja', 'garagem', 'outro'] as const;

export const IdealFractionSchema = z
  .string()
  .trim()
  .regex(/^(0(\.\d{1,10})?|1(\.0{1,10})?)$/, 'Fração ideal entre 0 e 1, até 10 casas decimais')
  .refine((v) => Number(v) > 0, 'Fração ideal deve ser maior que zero');

export const UnitCreateSchema = z.object({
  buildingId: uuid().nullable().optional(),
  identifier: z.string().trim().min(1).max(50),
  kind: z.enum(UNIT_KINDS).default('apartamento'),
  idealFraction: IdealFractionSchema,
});
export const UnitEligibilitySchema = z
  .object({
    votingStatus: z.enum(['eligible', 'restricted']),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.votingStatus === 'eligible' || (v.reason && v.reason.length >= 5), {
    message: 'Informe o fundamento da restrição (mín. 5 caracteres)',
    path: ['reason'],
  });

export const PersonDocumentSchema = z
  .string()
  .transform(onlyDigits)
  .refine((d) => (d.length === 11 ? isValidCpf(d) : d.length === 14 ? isValidCnpj(d) : false), 'CPF/CNPJ inválido');

export const PersonCreateSchema = z.object({
  kind: z.enum(['pf', 'pj']),
  name: z.string().trim().min(2).max(200),
  document: PersonDocumentSchema,
  email: EmailSchema.optional(),
  phone: z.string().trim().max(30).optional(),
});

export const OWNERSHIP_RELATIONS = [
  'proprietario',
  'coproprietario',
  'promitente_comprador',
  'usufrutuario',
  'representante_legal',
] as const;

export const OwnershipCreateSchema = z.object({
  unitId: uuid(),
  personId: uuid(),
  relation: z.enum(OWNERSHIP_RELATIONS),
  sharePercent: z.number().min(0).max(100).optional(),
  isVotingRepresentative: z.boolean().default(false),
});

export const UnitImportRowSchema = z.object({
  bloco: z.string().trim().max(100).optional().default(''),
  unidade: z.string().trim().min(1).max(50),
  tipo: z.enum(UNIT_KINDS).optional().default('apartamento'),
  fracao_ideal: IdealFractionSchema,
  proprietario_nome: z.string().trim().max(200).optional().default(''),
  proprietario_documento: z.string().trim().max(30).optional().default(''),
  proprietario_email: z.string().trim().max(254).optional().default(''),
});
export const UnitImportSchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())).min(1).max(5000),
  dryRun: z.boolean().default(true),
});

export const PoaCreateSchema = z
  .object({
    grantorPersonId: uuid(),
    attorneyPersonId: uuid(),
    unitIds: z.array(uuid()).min(1).max(1000),
    scope: z.enum(['assembly', 'general']),
    assemblyId: uuid().optional(),
    validFrom: z.coerce.date(),
    validUntil: z.coerce.date().optional(),
    canVote: z.boolean().default(true),
    canSpeak: z.boolean().default(true),
    restrictions: z.string().max(2000).optional(),
  })
  .refine((v) => v.grantorPersonId !== v.attorneyPersonId, {
    message: 'Outorgante e procurador devem ser pessoas distintas',
    path: ['attorneyPersonId'],
  })
  .refine((v) => v.scope === 'general' || !!v.assemblyId, {
    message: 'Informe a assembleia para procurações específicas',
    path: ['assemblyId'],
  })
  .refine((v) => !v.validUntil || v.validUntil > v.validFrom, {
    message: 'Validade final deve ser posterior à inicial',
    path: ['validUntil'],
  });

export const PoaReviewSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    notes: z.string().trim().max(2000).default(''),
  })
  .refine((v) => v.decision === 'approve' || v.notes.length >= 5, {
    message: 'Rejeição exige fundamentação (mín. 5 caracteres)',
    path: ['notes'],
  });

export const ReasonSchema = z.object({ reason: z.string().trim().min(5, 'Justificativa obrigatória').max(2000) });

export const RuleCreateSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(60)
    .regex(/^[A-Z0-9._-]+$/, 'Use letras maiúsculas, números, ponto, hífen ou sublinhado'),
  name: z.string().trim().min(3).max(200),
  legalBasis: z.string().trim().min(3).max(1000),
  definition: RuleDefinitionSchema,
  effectiveFrom: z.coerce.date(),
});
export const RuleFromTemplateSchema = z.object({ templateCode: z.string().min(2) });
export const RuleApproveSchema = z.object({ notes: z.string().trim().min(5, 'Registre o fundamento da homologação').max(2000) });

export const ASSEMBLY_KINDS = ['AGO', 'AGE', 'especial', 'outra'] as const;
export const ASSEMBLY_MODALITIES = ['presencial', 'virtual', 'hibrida'] as const;

export const AssemblyBaseSchema = z.object({
  condominiumId: uuid(),
  title: z.string().trim().min(3).max(300),
  kind: z.enum(ASSEMBLY_KINDS),
  modality: z.enum(ASSEMBLY_MODALITIES),
  location: z.string().trim().max(500).optional(),
  firstCallAt: z.coerce.date(),
  secondCallAt: z.coerce.date().optional(),
  permanentSession: z.boolean().default(false),
});

export const AssemblyCreateSchema = AssemblyBaseSchema.refine(
  (v) => !v.secondCallAt || v.secondCallAt > v.firstCallAt,
  { message: 'A 2ª convocação deve ser posterior à 1ª', path: ['secondCallAt'] },
);

export const AssemblyUpdateSchema = z.object({
  title: z.string().trim().min(3).max(300).optional(),
  kind: z.enum(ASSEMBLY_KINDS).optional(),
  modality: z.enum(ASSEMBLY_MODALITIES).optional(),
  location: z.string().trim().max(500).optional(),
  firstCallAt: z.coerce.date().optional(),
  secondCallAt: z.coerce.date().optional(),
  permanentSession: z.boolean().optional(),
});

export const AssemblyTransitionSchema = z.object({
  to: z.enum(ASSEMBLY_STATUSES),
  reason: z.string().trim().max(2000).optional(),
});

export const AssemblyHomologateSchema = z.object({
  firstCallPresenceRuleId: uuid().nullable(),
  secondCallPresenceRuleId: uuid().nullable(),
  notes: z.string().trim().min(5, 'Registre o fundamento da homologação').max(2000),
});

export const AgendaItemCreateSchema = z.object({
  title: z.string().trim().min(3).max(300),
  description: z.string().trim().max(10000).optional(),
  itemType: z.enum(['deliberativo', 'informativo']).default('deliberativo'),
});

export const BallotOptionInputSchema = z.object({
  label: z.string().trim().min(1).max(300),
  kind: z.enum(OPTION_KINDS).default('regular'),
});

export const BallotCreateSchema = z
  .object({
    agendaItemId: uuid(),
    title: z.string().trim().min(3).max(300),
    question: z.string().trim().min(3).max(5000),
    ballotType: z.enum(BALLOT_TYPES),
    maxChoices: z.number().int().min(1).max(100).default(1),
    seats: z.number().int().min(1).max(100).default(1),
    secrecy: z.enum(['nominal', 'secret']).default('nominal'),
    approvalRuleId: uuid(),
    presenceRuleId: uuid().nullable().optional(),
    allowVoteChange: z.boolean().default(false),
    showPartialResults: z.boolean().default(false),
    includeAbstention: z.boolean().default(true),
    includeBlank: z.boolean().default(false),
    includeNull: z.boolean().default(false),
    options: z.array(BallotOptionInputSchema).max(100).default([]),
  })
  .refine((v) => v.ballotType === 'yes_no' || v.options.filter((o) => o.kind === 'regular').length >= 2, {
    message: 'Informe ao menos duas opções',
    path: ['options'],
  })
  .refine((v) => !(v.secrecy === 'secret' && v.allowVoteChange), {
    message: 'Votação sigilosa não permite substituição de voto (impediria a desvinculação identidade/escolha)',
    path: ['allowVoteChange'],
  });

export const VoteCastSchema = z.object({
  unitId: uuid(),
  optionIds: z.array(uuid()).min(1).max(100),
  idempotencyKey: z.string().min(8).max(100),
});

export const SessionStartSchema = z.object({ callNumber: z.union([z.literal(1), z.literal(2)]) });

export const AccreditSchema = z.object({
  unitId: uuid(),
  personId: uuid(),
  mode: z.enum(['presencial', 'remoto']),
  poaId: uuid().optional(),
});
export const SelfAccreditSchema = z.object({ unitId: uuid(), poaId: uuid().optional() });

export const UserCreateSchema = z.object({
  email: EmailSchema,
  fullName: z.string().trim().min(2).max(200),
  password: PasswordSchema,
  roleCode: z.string().min(2),
  condominiumId: uuid().optional(),
  personId: uuid().optional(),
});
export const AssignmentCreateSchema = z.object({
  userId: uuid(),
  roleCode: z.string().min(2),
  condominiumId: uuid().optional(),
});

export type LoginInput = z.infer<typeof LoginSchema>;
export type TenantCreateInput = z.infer<typeof TenantCreateSchema>;
export type CondominiumCreateInput = z.infer<typeof CondominiumCreateSchema>;
export type UnitCreateInput = z.infer<typeof UnitCreateSchema>;
export type PersonCreateInput = z.infer<typeof PersonCreateSchema>;
export type OwnershipCreateInput = z.infer<typeof OwnershipCreateSchema>;
export type PoaCreateInput = z.infer<typeof PoaCreateSchema>;
export type RuleCreateInput = z.infer<typeof RuleCreateSchema>;
export type AssemblyCreateInput = z.infer<typeof AssemblyCreateSchema>;
export type BallotCreateInput = z.infer<typeof BallotCreateSchema>;
export type VoteCastInput = z.infer<typeof VoteCastSchema>;

// ---------------------------------------------------------------------------
// Convocação
// ---------------------------------------------------------------------------
export const ConvocationDraftSchema = z.object({
  subject: z.string().trim().min(5, 'Assunto muito curto').max(200),
  body: z.string().trim().min(20, 'O edital precisa conter o texto da convocação').max(50000),
});

export const ConvocationPublishSchema = z.object({
  /** Obrigatório quando já existe edital publicado (retificação). */
  rectificationReason: z.string().trim().min(5).max(2000).optional(),
  /** Confirmação explícita de que o envio eletrônico não substitui o meio previsto na convenção. */
  acknowledgeLegalNotice: z.literal(true, { error: 'Confirme a ciência do aviso sobre validade jurídica' }),
});

// ---------------------------------------------------------------------------
// Transmissão (LiveKit)
// ---------------------------------------------------------------------------
export const FloorDecisionSchema = z.object({
  decision: z.enum(['grant', 'deny', 'end']),
  maxSeconds: z.number().int().min(30).max(3600).optional(),
  reason: z.string().trim().max(500).optional(),
});
