import { useQuery } from '@tanstack/react-query';
import { Card, Col, Progress, Row, Statistic, Tag, Typography } from 'antd';
import { IssuesList } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDateTimeSec, fmtFraction } from '../../lib/format';
import type { LiveQuorum } from './types';

export function QuorumPanel({ assemblyId, compact = false }: { assemblyId: string; compact?: boolean }) {
  const q = useQuery({ queryKey: ['assembly', assemblyId, 'quorum'], queryFn: () => api<LiveQuorum>(`/assemblies/${assemblyId}/quorum`) });
  const d = q.data;
  if (!d) return <Card loading title="Quórum" />;
  const pct = d.electorate.units ? Math.round((Number(d.present.fraction) / Number(d.electorate.fraction || 1)) * 1000) / 10 : 0;
  const callRow = (label: string, c: LiveQuorum['firstCall']) =>
    c && (
      <div style={{ marginTop: 8 }}>
        <Typography.Text strong>{label}: </Typography.Text>
        <Tag color={c.evaluation.met ? 'green' : 'red'}>{c.evaluation.met ? 'Atingido' : 'Não atingido'}</Tag>
        <Typography.Text type="secondary">
          {c.rule.code} v{c.rule.version} — exigido {c.evaluation.countingUnit === 'unit' ? c.evaluation.required + ' unid.' : fmtFraction(c.evaluation.required)} ({c.evaluation.requiredPercent}%), obtido{' '}
          {c.evaluation.achievedPercent}%
        </Typography.Text>
      </div>
    );
  return (
    <Card title="Quórum em tempo real" extra={<Typography.Text type="secondary">Atualizado {fmtDateTimeSec(d.computedAt)}</Typography.Text>} size={compact ? 'small' : 'default'}>
      <Row gutter={[16, 8]}>
        <Col xs={12} md={6}><Statistic title="Unidades elegíveis" value={d.electorate.units} suffix={`/ ${d.totalUnits}`} /></Col>
        <Col xs={12} md={6}><Statistic title="Unidades presentes" value={d.present.units} /></Col>
        <Col xs={12} md={6}><Statistic title="Fração presente" value={fmtFraction(d.present.fraction)} /></Col>
        <Col xs={12} md={6}><Statistic title="Presencial / remoto / procuração" value={`${d.present.presencial} / ${d.present.remoto} / ${d.present.byPoa}`} /></Col>
      </Row>
      <Progress percent={pct} status={d.firstCall?.evaluation.met ? 'success' : 'active'} aria-label="Fração ideal presente" />
      {callRow('1ª convocação', d.firstCall)}
      {callRow('2ª convocação', d.secondCall)}
      {!compact && d.issues.length > 0 && <div style={{ marginTop: 12 }}><IssuesList issues={d.issues} /></div>}
    </Card>
  );
}
