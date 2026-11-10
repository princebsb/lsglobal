import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Col, Collapse, Input, Modal, Row, Space, Statistic, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { BallotStatusTag } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDateTimeSec, fmtFraction } from '../../lib/format';
import { QuorumPanel } from './QuorumPanel';
import { TallyView } from './TallyView';
import type { AssemblyDetail, BallotDetail, BallotSummary } from './types';

function BallotControl({ a, b }: { a: AssemblyDetail; b: BallotSummary }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const { message, modal } = App.useApp();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [showVotes, setShowVotes] = useState(false);
  const d = useQuery({ queryKey: ['ballot', b.id], queryFn: () => api<BallotDetail>(`/ballots/${b.id}`) });
  const votes = useQuery({
    queryKey: ['ballot', b.id, 'votes'],
    queryFn: () => api<{ unit: string; voter: string; choices: string[]; version: number; versions: number; cast_at: string; basis: string; hash: string }[]>(`/ballots/${b.id}/votes`),
    enabled: showVotes,
  });
  const inv = () => {
    qc.invalidateQueries({ queryKey: ['ballot', b.id] });
    qc.invalidateQueries({ queryKey: ['assembly', a.id] });
  };
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: object }) => api(`/ballots/${b.id}/${path}`, { method: 'POST', body }),
    onSuccess: (_r, v) => {
      message.success(
        { open: 'Votação aberta', close: 'Votação encerrada', tally: 'Apuração concluída', declare: 'Resultado declarado', cancel: 'Votação cancelada', 'new-round': 'Nova rodada criada' }[v.path] ?? 'OK',
      );
      setCancelOpen(false);
      inv();
    },
    onError: (e) => message.error(errorMessage(e)),
  });
  const confirm = (title: string, path: string, content?: string) => modal.confirm({ title, content, okText: 'Confirmar', onOk: () => act.mutateAsync({ path }) });

  const s = b.status;
  const data = d.data;
  return (
    <Card
      size="small"
      title={
        <Space wrap>
          <span>{b.title}{b.round > 1 ? ` — rodada ${b.round}` : ''}</span>
          <BallotStatusTag status={s} />
          {b.secrecy === 'secret' && <Tag color="purple">sigilosa</Tag>}
        </Space>
      }
      extra={
        <Space wrap>
          {s === 'prepared' && <Button type="primary" disabled={a.status !== 'in_progress'} onClick={() => confirm('Abrir votação?', 'open', 'A base eleitoral será congelada neste momento.')}>Abrir</Button>}
          {s === 'open' && <Button type="primary" danger onClick={() => confirm('Encerrar votação?', 'close', 'Nenhum voto será aceito após o encerramento. A presença será congelada.')}>Encerrar</Button>}
          {(s === 'closed' || s === 'tallied') && <Button onClick={() => act.mutate({ path: 'tally' })} loading={act.isPending}>{s === 'tallied' ? 'Reapurar' : 'Apurar'}</Button>}
          {s === 'tallied' && <Button type="primary" disabled={!data?.result?.declarable} onClick={() => confirm('Declarar resultado?', 'declare', 'A declaração é definitiva e será registrada na linha do tempo.')}>Declarar resultado</Button>}
          {(s === 'prepared' || s === 'open') && <Button danger onClick={() => setCancelOpen(true)}>Cancelar</Button>}
          {s === 'cancelled' && !a.ballots.some((x) => x.agenda_item_id === b.agenda_item_id && x.status !== 'cancelled') && (
            <Button onClick={() => act.mutate({ path: 'new-round' })}>Nova rodada</Button>
          )}
        </Space>
      }
    >
      <Typography.Paragraph>{b.question}</Typography.Paragraph>
      <Typography.Text type="secondary">Regra: {b.approval_rule_code} v{b.approval_rule_version} — {b.approval_rule_name}</Typography.Text>
      {data && s !== 'prepared' && (
        <Row gutter={16} style={{ margin: '12px 0' }}>
          <Col xs={12} md={6}><Statistic title="Base eleitoral" value={data.electorate.units ?? 0} suffix="unid." /></Col>
          <Col xs={12} md={6}><Statistic title="Fração elegível" value={fmtFraction(data.electorate.fraction)} /></Col>
          <Col xs={12} md={6}><Statistic title="Votos recebidos" value={data.votesReceived} /></Col>
          <Col xs={12} md={6}><Statistic title="Convocação" value={data.callNumber ? `${data.callNumber}ª` : '—'} /></Col>
        </Row>
      )}
      {b.cancel_reason && <Alert type="error" showIcon message={`Cancelada: ${b.cancel_reason}`} />}
      {data?.partial && <TallyView tally={data.partial} partial />}
      {data?.result && (
        <TallyView
          tally={data.result.tally}
          hash={data.result.result_hash}
          rule={data.result.rule_snapshot.approval ? `${data.result.rule_snapshot.approval.code} v${data.result.rule_snapshot.approval.version} — ${data.result.rule_snapshot.approval.legalBasis}` : undefined}
        />
      )}
      {b.secrecy === 'nominal' && ['closed', 'tallied', 'declared'].includes(s) && can('votes.view_nominal') && (
        <Collapse
          style={{ marginTop: 12 }}
          onChange={(k) => setShowVotes(k.length > 0)}
          items={[
            {
              key: 'v',
              label: 'Votos nominais (acesso auditado)',
              children: (
                <Table
                  size="small"
                  rowKey="unit"
                  loading={votes.isLoading}
                  dataSource={votes.data}
                  scroll={{ x: true }}
                  columns={[
                    { title: 'Unidade', dataIndex: 'unit' },
                    { title: 'Votante', dataIndex: 'voter' },
                    { title: 'Escolha', dataIndex: 'choices', render: (c: string[]) => c?.join(', ') },
                    { title: 'Fundamento', dataIndex: 'basis' },
                    { title: 'Versão', key: 'v', render: (_: unknown, r: { version: number; versions: number }) => (r.versions > 1 ? `${r.version} (substituído)` : r.version) },
                    { title: 'Registrado', dataIndex: 'cast_at', render: fmtDateTimeSec },
                  ]}
                />
              ),
            },
          ]}
        />
      )}
      <Modal title="Cancelar votação" open={cancelOpen} onCancel={() => setCancelOpen(false)} onOk={() => act.mutate({ path: 'cancel', body: { reason } })} okButtonProps={{ danger: true, disabled: reason.trim().length < 5 }}>
        <Typography.Paragraph>Os votos já registrados são preservados para auditoria e não serão computados. Será possível abrir nova rodada com identificador distinto.</Typography.Paragraph>
        <Input.TextArea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Justificativa (obrigatória)" aria-label="Justificativa" />
      </Modal>
    </Card>
  );
}

export function MesaTab({ a }: { a: AssemblyDetail }) {
  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} xl={9}>
        <QuorumPanel assemblyId={a.id} />
      </Col>
      <Col xs={24} xl={15}>
        <Space direction="vertical" style={{ width: '100%' }}>
          {a.status !== 'in_progress' && <Alert type="info" showIcon message="As votações só podem ser abertas com a sessão em andamento." />}
          {a.ballots.length === 0 && <Alert type="warning" message="Nenhuma votação configurada. Configure na aba Pauta e votações." />}
          {a.ballots.map((b) => (
            <BallotControl key={b.id} a={a} b={b} />
          ))}
        </Space>
      </Col>
    </Row>
  );
}
