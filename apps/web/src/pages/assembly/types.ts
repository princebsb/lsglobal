import type { AssemblyStatus, BallotStatus, TallyResult } from '@lsg/shared';

export interface BallotSummary {
  id: string;
  agenda_item_id: string;
  round: number;
  title: string;
  question: string;
  ballot_type: string;
  secrecy: 'nominal' | 'secret';
  status: BallotStatus;
  approval_rule_code: string;
  approval_rule_version: number;
  approval_rule_name: string;
  allow_vote_change: boolean;
  show_partial_results: boolean;
  cancel_reason: string | null;
  declared_outcome: string | null;
  options: { id: string; label: string; kind: string; position: number }[];
}

export interface AssemblyDetail {
  id: string;
  code: string;
  title: string;
  kind: string;
  modality: string;
  status: AssemblyStatus;
  condominium_id: string;
  condominium: { id: string; name: string; timezone: string };
  location: string | null;
  first_call_at: string;
  second_call_at: string | null;
  permanent_session: boolean;
  rules_homologated_at: string | null;
  rules_homologation_notes: string | null;
  first_call_presence_rule_id: string | null;
  second_call_presence_rule_id: string | null;
  firstCallRule: { code: string; version: number; name: string } | null;
  secondCallRule: { code: string; version: number; name: string } | null;
  agenda: { id: string; position: number; title: string; description: string | null; item_type: string }[];
  sessions: { id: string; seq: number; call_number: number; started_at: string; ended_at: string | null; end_reason: string | null; started_by_name: string }[];
  history: { from_status: string | null; to_status: string; reason: string | null; at: string; actor: string | null }[];
  ballots: BallotSummary[];
}

export interface BallotDetail {
  id: string;
  title: string;
  question: string;
  ballotType: string;
  secrecy: 'nominal' | 'secret';
  status: BallotStatus;
  round: number;
  callNumber: number | null;
  electorate: { units: number | null; fraction: string | null };
  votesReceived: number;
  options: { id: string; label: string; kind: string }[];
  result: { id: string; outcome: string; declarable: boolean; tally: TallyResult; result_hash: string; computed_at: string; rule_snapshot: { approval?: { code: string; version: number; legalBasis: string } } } | null;
  partial: TallyResult | null;
}

export interface LiveQuorum {
  electorate: { units: number; fraction: string };
  totalUnits: number;
  restrictedUnits: number;
  present: { units: number; fraction: string; presencial: number; remoto: number; byPoa: number };
  firstCall: { rule: { code: string; version: number; name: string; description: string }; evaluation: { met: boolean; achieved: string; required: string; achievedPercent: string; requiredPercent: string; countingUnit: string } } | null;
  secondCall: LiveQuorum['firstCall'];
  issues: { code: string; severity: 'blocking' | 'warning'; message: string }[];
  computedAt: string;
}
