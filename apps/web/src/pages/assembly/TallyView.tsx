import { Descriptions, Progress, Space, Table, Typography } from 'antd';
import type { TallyResult } from '@lsg/shared';
import { IssuesList, OutcomeTag } from '../../components/ui';
import { fmtFraction } from '../../lib/format';

/** Exibição de apuração (parcial ou final), com totais, regra aplicada e pendências. */
export function TallyView({ tally, hash, rule, partial = false }: { tally: TallyResult; hash?: string; rule?: string; partial?: boolean }) {
  const unit = tally.countingUnit;
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Space wrap>
        {partial ? <Typography.Text type="warning">Apuração PARCIAL — votação em andamento</Typography.Text> : <OutcomeTag outcome={tally.outcome} />}
        <Typography.Text type="secondary">Contagem por {unit === 'unit' ? 'unidade' : 'fração ideal'}</Typography.Text>
      </Space>
      <Table
        size="small"
        rowKey="id"
        pagination={false}
        dataSource={tally.options}
        columns={[
          { title: 'Opção', dataIndex: 'label', render: (l: string, o) => (tally.winners.includes(o.id) ? <b>{l} ✓</b> : l) },
          { title: 'Unidades', dataIndex: 'units' },
          { title: 'Fração ideal', dataIndex: 'fraction', render: fmtFraction },
          {
            title: '% sobre a base',
            dataIndex: 'percentOfBase',
            render: (p: string) => <Progress percent={Math.min(100, Number(p))} size="small" format={() => `${p}%`} style={{ minWidth: 140 }} />,
          },
        ]}
      />
      <Descriptions size="small" bordered column={{ xs: 1, md: 2 }}>
        <Descriptions.Item label="Base eleitoral">{tally.totals.electorate.units} unid. / {fmtFraction(tally.totals.electorate.fraction)}</Descriptions.Item>
        <Descriptions.Item label="Presentes">{tally.totals.present.units} unid. / {fmtFraction(tally.totals.present.fraction)}</Descriptions.Item>
        <Descriptions.Item label="Votos recebidos">{tally.totals.votesCast.units} unid. / {fmtFraction(tally.totals.votesCast.fraction)}</Descriptions.Item>
        <Descriptions.Item label="Votos válidos">{tally.totals.validVotes.units} unid. / {fmtFraction(tally.totals.validVotes.fraction)}</Descriptions.Item>
        <Descriptions.Item label="Abstenções/brancos/nulos">{tally.totals.nonValid.units} unid. / {fmtFraction(tally.totals.nonValid.fraction)}</Descriptions.Item>
        <Descriptions.Item label="Presentes sem voto">{tally.totals.pending.units} unid.</Descriptions.Item>
        {tally.presence && (
          <Descriptions.Item label="Quórum de presença">
            {tally.presence.met ? 'Atingido' : 'Não atingido'} — exigido {tally.presence.requiredPercent}%, obtido {tally.presence.achievedPercent}%
          </Descriptions.Item>
        )}
        {tally.approval && (
          <Descriptions.Item label="Critério de aprovação">
            exigido {unit === 'unit' ? tally.approval.required : fmtFraction(tally.approval.required)} ({tally.approval.comparator === 'greater_than' ? '>' : '≥'}{' '}
            {tally.approval.threshold.numerator}/{tally.approval.threshold.denominator} de {unit === 'unit' ? tally.approval.base : fmtFraction(tally.approval.base)}), obtido{' '}
            {unit === 'unit' ? tally.approval.achieved : fmtFraction(tally.approval.achieved)}
          </Descriptions.Item>
        )}
        {rule && <Descriptions.Item label="Regra aplicada">{rule}</Descriptions.Item>}
        {hash && <Descriptions.Item label="Hash do resultado"><span className="mono">{hash}</span></Descriptions.Item>}
      </Descriptions>
      {!partial && <IssuesList issues={tally.issues} />}
    </Space>
  );
}
