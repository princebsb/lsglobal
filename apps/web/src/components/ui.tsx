import { Alert, Empty, Result, Skeleton, Space, Tag, Typography } from 'antd';
import type { ReactNode } from 'react';
import {
  ASSEMBLY_STATUS_LABELS,
  BALLOT_STATUS_LABELS,
  OUTCOME_LABELS,
  POA_STATUS_LABELS,
  type AssemblyStatus,
  type BallotStatus,
  type PoaStatus,
  type TallyIssue,
} from '@lsg/shared';
import { errorMessage } from '../lib/api';

export function PageHeader({ title, subtitle, extra }: { title: ReactNode; subtitle?: ReactNode; extra?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <Typography.Title level={3} style={{ margin: 0 }}>
          {title}
        </Typography.Title>
        {subtitle && <Typography.Text type="secondary">{subtitle}</Typography.Text>}
      </div>
      {extra && <Space wrap>{extra}</Space>}
    </div>
  );
}

/** Estados padronizados de carregamento, erro e vazio. */
export function QueryState({
  loading,
  error,
  empty,
  emptyText = 'Nenhum registro',
  children,
}: {
  loading?: boolean;
  error?: unknown;
  empty?: boolean;
  emptyText?: string;
  children: ReactNode;
}) {
  if (loading) return <Skeleton active />;
  if (error) {
    return <Result status="error" title="Não foi possível carregar" subTitle={errorMessage(error)} />;
  }
  if (empty) return <Empty description={emptyText} />;
  return <>{children}</>;
}

const ASSEMBLY_COLORS: Partial<Record<AssemblyStatus, string>> = {
  draft: 'default',
  in_review: 'gold',
  approved_for_call: 'cyan',
  called: 'blue',
  accreditation: 'geekblue',
  in_progress: 'green',
  suspended: 'orange',
  closed: 'purple',
  in_conference: 'magenta',
  archived: 'default',
  cancelled: 'red',
};

export const AssemblyStatusTag = ({ status }: { status: AssemblyStatus }) => (
  <Tag color={ASSEMBLY_COLORS[status]}>{ASSEMBLY_STATUS_LABELS[status] ?? status}</Tag>
);

const BALLOT_COLORS: Record<BallotStatus, string> = {
  prepared: 'default',
  open: 'green',
  closed: 'orange',
  tallied: 'blue',
  declared: 'purple',
  cancelled: 'red',
};
export const BallotStatusTag = ({ status }: { status: BallotStatus }) => (
  <Tag color={BALLOT_COLORS[status]}>{BALLOT_STATUS_LABELS[status] ?? status}</Tag>
);

const POA_COLORS: Record<PoaStatus, string> = { pending: 'gold', approved: 'green', rejected: 'red', revoked: 'default', expired: 'default' };
export const PoaStatusTag = ({ status }: { status: PoaStatus }) => <Tag color={POA_COLORS[status]}>{POA_STATUS_LABELS[status] ?? status}</Tag>;

const OUTCOME_COLORS: Record<string, string> = {
  approved: 'green',
  elected: 'green',
  rejected: 'red',
  no_winner: 'orange',
  tie: 'orange',
  quorum_not_met: 'volcano',
  undetermined: 'default',
};
export const OutcomeTag = ({ outcome }: { outcome: string }) => (
  <Tag color={OUTCOME_COLORS[outcome] ?? 'default'} style={{ fontSize: 14, padding: '2px 10px' }}>
    {OUTCOME_LABELS[outcome] ?? outcome}
  </Tag>
);

export function IssuesList({ issues }: { issues: TallyIssue[] }) {
  if (!issues?.length) return null;
  return (
    <Space direction="vertical" style={{ width: '100%' }} size={4}>
      {issues.map((i) => (
        <Alert
          key={i.code + i.message}
          type={i.severity === 'blocking' ? 'error' : 'warning'}
          showIcon
          message={i.severity === 'blocking' ? `Pendência bloqueante: ${i.message}` : i.message}
        />
      ))}
    </Space>
  );
}

export function LegalNotice() {
  return (
    <Alert
      type="info"
      showIcon
      message="Regras jurídicas parametrizáveis"
      description="Modelos de regra são pontos de partida e exigem validação por profissional habilitado, à luz da convenção e da legislação vigente. A plataforma não presume regras: somente regras homologadas podem ser usadas."
    />
  );
}
