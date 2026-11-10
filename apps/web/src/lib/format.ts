import dayjs from 'dayjs';
import 'dayjs/locale/pt-br';

dayjs.locale('pt-br');

export const fmtDateTime = (v?: string | Date | null) => (v ? dayjs(v).format('DD/MM/YYYY HH:mm') : '—');
export const fmtDateTimeSec = (v?: string | Date | null) => (v ? dayjs(v).format('DD/MM/YYYY HH:mm:ss') : '—');
export const fmtDate = (v?: string | Date | null) => (v ? dayjs(v).format('DD/MM/YYYY') : '—');

/** Fração ideal "0.0750000000" → "0,075" e percentual. */
export function fmtFraction(v?: string | null): string {
  if (v == null) return '—';
  const [i, f = ''] = v.split('.');
  const frac = f.replace(/0+$/, '');
  return frac ? `${i},${frac}` : `${i}`;
}
export function fmtPercentOfFraction(v?: string | null): string {
  if (v == null) return '—';
  return `${(Number(v) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 4 })}%`;
}

export const KIND_LABELS: Record<string, string> = {
  AGO: 'Assembleia Geral Ordinária',
  AGE: 'Assembleia Geral Extraordinária',
  especial: 'Assembleia Especial',
  outra: 'Outra',
};
export const MODALITY_LABELS: Record<string, string> = { presencial: 'Presencial', virtual: 'Virtual', hibrida: 'Híbrida' };
export const BALLOT_TYPE_LABELS: Record<string, string> = {
  yes_no: 'Sim / Não',
  single_choice: 'Escolha única',
  multiple_choice: 'Múltipla escolha',
  election: 'Eleição',
};
export const CONDO_TYPE_LABELS: Record<string, string> = {
  residencial_vertical: 'Residencial vertical',
  residencial_horizontal: 'Residencial horizontal',
  comercial: 'Comercial',
  empresarial: 'Empresarial',
  misto: 'Misto',
  clube: 'Condomínio-clube',
  multiplas_torres: 'Múltiplas torres/blocos',
  complexo: 'Complexo condominial',
  associacao: 'Associação de moradores',
};
export const REGIME_LABELS: Record<string, string> = {
  condominio_edilicio: 'Condomínio edilício',
  associacao: 'Associação',
  outro: 'Outro',
};
export const TENANT_KIND_LABELS: Record<string, string> = {
  condominio_independente: 'Condomínio independente',
  administradora: 'Administradora',
  sindico_profissional: 'Síndico profissional',
  associacao: 'Associação',
  outro: 'Outro',
};
export const RELATION_LABELS: Record<string, string> = {
  proprietario: 'Proprietário',
  coproprietario: 'Coproprietário',
  promitente_comprador: 'Promitente comprador',
  usufrutuario: 'Usufrutuário',
  representante_legal: 'Representante legal',
};
export const TIMELINE_LABELS: Record<string, string> = {
  'rules.homologated': 'Regras homologadas',
  'accreditation.opened': 'Credenciamento aberto',
  'session.opened': 'Sessão aberta',
  'session.resumed': 'Sessão retomada',
  'session.suspended': 'Sessão suspensa',
  'ballot.opened': 'Votação aberta',
  'ballot.closed': 'Votação encerrada',
  'ballot.tallied': 'Votação apurada',
  'ballot.declared': 'Resultado declarado',
  'ballot.cancelled': 'Votação cancelada',
  'assembly.closed': 'Assembleia encerrada',
  'assembly.cancelled': 'Assembleia cancelada',
  'assembly.status': 'Mudança de estado',
  'convocation.published': 'Edital publicado',
  'convocation.rectified': 'Edital retificado',
  'floor.requested': 'Pedido de palavra',
  'floor.granted': 'Palavra concedida',
  'floor.ended': 'Palavra encerrada',
  'floor.denied': 'Pedido de palavra negado',
  'recording.requested': 'Gravação solicitada',
  'recording.started': 'Gravação iniciada (confirmada pelo servidor de mídia)',
  'recording.ended': 'Gravação finalizada',
  'recording.failed': 'FALHA na gravação',
  'media.room_started': 'Sala de transmissão iniciada',
  'media.room_finished': 'Sala de transmissão encerrada',
};
