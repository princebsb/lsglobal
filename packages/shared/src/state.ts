/** Máquinas de estado de assembleia e de votação. Toda transição é validada no servidor. */

export const ASSEMBLY_STATUSES = [
  'draft',
  'in_review',
  'approved_for_call',
  'called',
  'accreditation',
  'in_progress',
  'suspended',
  'closed',
  'in_conference',
  'archived',
  'cancelled',
] as const;
export type AssemblyStatus = (typeof ASSEMBLY_STATUSES)[number];

export const ASSEMBLY_STATUS_LABELS: Record<AssemblyStatus, string> = {
  draft: 'Rascunho',
  in_review: 'Em revisão',
  approved_for_call: 'Aprovada para convocação',
  called: 'Convocada',
  accreditation: 'Credenciamento',
  in_progress: 'Em andamento',
  suspended: 'Suspensa / sessão subsequente',
  closed: 'Encerrada',
  in_conference: 'Em conferência',
  archived: 'Arquivada',
  cancelled: 'Cancelada',
};

export const ASSEMBLY_TRANSITIONS: Record<AssemblyStatus, readonly AssemblyStatus[]> = {
  draft: ['in_review', 'cancelled'],
  in_review: ['draft', 'approved_for_call', 'cancelled'],
  approved_for_call: ['in_review', 'called', 'cancelled'],
  called: ['accreditation', 'cancelled'],
  accreditation: ['in_progress', 'cancelled'],
  in_progress: ['suspended', 'closed'],
  suspended: ['in_progress', 'closed'],
  closed: ['in_conference'],
  in_conference: ['archived'],
  archived: [],
  cancelled: [],
};

export function canTransitionAssembly(from: AssemblyStatus, to: AssemblyStatus): boolean {
  return ASSEMBLY_TRANSITIONS[from].includes(to);
}

/** Estados em que o credenciamento é permitido. */
export const ACCREDITATION_OPEN_STATUSES: readonly AssemblyStatus[] = ['accreditation', 'in_progress', 'suspended'];

export const BALLOT_STATUSES = ['prepared', 'open', 'closed', 'tallied', 'declared', 'cancelled'] as const;
export type BallotStatus = (typeof BALLOT_STATUSES)[number];

export const BALLOT_STATUS_LABELS: Record<BallotStatus, string> = {
  prepared: 'Preparada',
  open: 'Aberta',
  closed: 'Encerrada',
  tallied: 'Apurada',
  declared: 'Resultado declarado',
  cancelled: 'Cancelada',
};

export const BALLOT_TRANSITIONS: Record<BallotStatus, readonly BallotStatus[]> = {
  prepared: ['open', 'cancelled'],
  open: ['closed', 'cancelled'],
  closed: ['tallied'],
  tallied: ['tallied', 'declared'],
  declared: [],
  cancelled: [],
};

export function canTransitionBallot(from: BallotStatus, to: BallotStatus): boolean {
  return BALLOT_TRANSITIONS[from].includes(to);
}

export const POA_STATUSES = ['pending', 'approved', 'rejected', 'revoked', 'expired'] as const;
export type PoaStatus = (typeof POA_STATUSES)[number];

export const POA_STATUS_LABELS: Record<PoaStatus, string> = {
  pending: 'Em análise',
  approved: 'Aprovada',
  rejected: 'Rejeitada',
  revoked: 'Revogada',
  expired: 'Expirada',
};

export const OUTCOME_LABELS: Record<string, string> = {
  approved: 'Aprovada',
  rejected: 'Rejeitada',
  elected: 'Eleito(s)',
  no_winner: 'Nenhuma opção atingiu o quórum',
  tie: 'Empate',
  quorum_not_met: 'Quórum de presença não atingido',
  undetermined: 'Indeterminado (pendências bloqueantes)',
};

export const CONVOCATION_STATUS_LABELS: Record<string, string> = {
  draft: 'Rascunho',
  published: 'Publicada',
  superseded: 'Substituída (retificada)',
  cancelled: 'Cancelada',
};

export const DELIVERY_STATUS_LABELS: Record<string, string> = {
  queued: 'Na fila',
  sending: 'Enviando',
  sent: 'Enviado ao provedor',
  failed: 'Falhou',
  none: 'Sem endereço',
};

export const RECORDING_STATUS_LABELS: Record<string, string> = {
  starting: 'Iniciando (aguardando confirmação)',
  active: 'Gravando',
  ending: 'Finalizando',
  complete: 'Concluída',
  failed: 'Falhou',
};

export const FLOOR_STATUS_LABELS: Record<string, string> = {
  waiting: 'Aguardando',
  granted: 'Com a palavra',
  done: 'Encerrada',
  denied: 'Negada',
  cancelled: 'Cancelada',
};

/** Aviso exibido em toda convocação eletrônica. */
export const CONVOCATION_LEGAL_NOTICE =
  'O registro de envio, entrega ou abertura comprova apenas o processamento técnico da mensagem. ' +
  'A validade jurídica da convocação depende do cumprimento da convenção, do prazo de antecedência, ' +
  'do meio de comunicação previsto e da convocação de todos os condôminos (CC art. 1.354).';
