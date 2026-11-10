import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FLOOR_STATUS_LABELS, RECORDING_STATUS_LABELS } from '@lsg/shared';
import { Alert, App, Button, Card, Col, InputNumber, List, Row, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { MediaJoin, SpeakingTimer, mediaKey, useMediaOverview, type RecordingItem } from '../../components/media/MediaPanel';
import { QueryState } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDateTimeSec } from '../../lib/format';
import type { AssemblyDetail } from './types';

const REC_COLORS: Record<string, string> = { starting: 'gold', active: 'red', ending: 'orange', complete: 'green', failed: 'magenta' };

/** Painel da mesa/operação técnica: palco, gravação, fila de palavra e participantes conectados. */
export function MediaTab({ a }: { a: AssemblyDetail }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const { message, modal } = App.useApp();
  const ov = useMediaOverview(a.id);
  const [maxSeconds, setMaxSeconds] = useState<number | null>(180);
  const inv = () => qc.invalidateQueries({ queryKey: mediaKey(a.id) });
  const onError = (e: unknown) => message.error(errorMessage(e));

  const startRec = useMutation({ mutationFn: () => api(`/assemblies/${a.id}/recordings/start`, { method: 'POST' }), onSuccess: () => { message.info('Gravação solicitada — aguardando confirmação do servidor de mídia'); inv(); }, onError });
  const stopRec = useMutation({ mutationFn: (id: string) => api(`/recordings/${id}/stop`, { method: 'POST' }), onSuccess: inv, onError });
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'grant' | 'deny' | 'end' }) =>
      api<{ appliedToRoom: boolean | null }>(`/floor/${id}/decision`, { method: 'POST', body: { decision, ...(decision === 'grant' && maxSeconds ? { maxSeconds } : {}) } }),
    onSuccess: (r, v) => {
      if (v.decision !== 'deny' && r.appliedToRoom === false) message.warning('Decisão registrada, mas o participante não está conectado à sala no momento.');
      inv();
    },
    onError,
  });

  const d = ov.data;
  const active = d?.recordings.find((r) => ['starting', 'active', 'ending'].includes(r.status));
  const lastFailed = d?.recordings[0]?.status === 'failed' ? d.recordings[0] : undefined;
  const staffState = ['called', 'accreditation', 'in_progress', 'suspended'].includes(a.status);
  const needsRecording = a.modality !== 'presencial' && a.status === 'in_progress' && active?.status !== 'active';
  const conduct = can('assembly.conduct');

  return (
    <QueryState loading={ov.isLoading} error={ov.error}>
      {d && (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {!d.configured && (
            <Alert type="warning" showIcon message="Transmissão não configurada"
              description="Defina LIVEKIT_URL, LIVEKIT_API_KEY e LIVEKIT_API_SECRET no .env da API e reinicie. Veja docs/08-transmissao-livekit.md." />
          )}
          {lastFailed && !active && <Alert type="error" showIcon message="A última gravação FALHOU" description={lastFailed.error ?? 'Sem detalhes'} />}
          {needsRecording && d.configured && (
            <Alert type="error" showIcon message="Sessão em andamento sem gravação confirmada"
              description="Para assembleias virtuais ou híbridas, inicie a gravação integral antes das deliberações." />
          )}
          <Row gutter={[16, 16]}>
            <Col xs={24} xl={15}>
              <MediaJoin assemblyId={a.id} staff disabledReason={!d.configured ? 'Transmissão não configurada.' : !staffState ? 'Sala disponível após a convocação.' : null} />
            </Col>
            <Col xs={24} xl={9}>
              <Space direction="vertical" style={{ width: '100%' }}>
                <Card size="small" title="Gravação integral"
                  extra={active ? (
                    <Button danger size="small" disabled={active.status === 'ending'} loading={stopRec.isPending}
                      onClick={() => modal.confirm({ title: 'Encerrar a gravação?', content: 'O arquivo será finalizado e terá seu SHA-256 registrado.', onOk: () => stopRec.mutateAsync(active.id) })}>
                      Encerrar
                    </Button>
                  ) : (
                    <Button type="primary" size="small" disabled={!d.egressEnabled} loading={startRec.isPending} onClick={() => startRec.mutate()}>Iniciar gravação</Button>
                  )}>
                  {!d.egressEnabled && <Typography.Paragraph type="secondary">Gravação em servidor (Egress) não habilitada neste ambiente.</Typography.Paragraph>}
                  {active && (
                    <Space direction="vertical" size={2}>
                      <Tag color={REC_COLORS[active.status]}>{RECORDING_STATUS_LABELS[active.status]}</Tag>
                      {active.started_at ? <Typography.Text type="secondary">Confirmada pelo servidor às {fmtDateTimeSec(active.started_at)}</Typography.Text>
                        : <Typography.Text type="warning">Ainda não confirmada — não considere a sessão gravada.</Typography.Text>}
                    </Space>
                  )}
                  <List<RecordingItem>
                    size="small"
                    dataSource={d.recordings.filter((r) => r !== active).slice(0, 5)}
                    locale={{ emptyText: 'Nenhuma gravação' }}
                    renderItem={(r) => (
                      <List.Item>
                        <Space direction="vertical" size={0} style={{ width: '100%' }}>
                          <Space wrap><Tag color={REC_COLORS[r.status]}>{RECORDING_STATUS_LABELS[r.status]}</Tag><span>{fmtDateTimeSec(r.started_at ?? r.requested_at)} → {fmtDateTimeSec(r.ended_at)}</span></Space>
                          {r.sha256 && <Typography.Text code copyable style={{ fontSize: 11 }}>{r.sha256}</Typography.Text>}
                          {r.error && <Typography.Text type="danger" style={{ fontSize: 12 }}>{r.error}</Typography.Text>}
                        </Space>
                      </List.Item>
                    )}
                  />
                </Card>
                <Card size="small" title="Fila de palavra" extra={conduct && (
                  <Space size={4}><span style={{ fontSize: 12 }}>Tempo (s)</span><InputNumber size="small" min={30} max={3600} value={maxSeconds} onChange={(v) => setMaxSeconds(v)} style={{ width: 80 }} /></Space>
                )}>
                  <List
                    size="small"
                    dataSource={d.floor.filter((f) => f.status === 'waiting' || f.status === 'granted')}
                    locale={{ emptyText: 'Nenhum pedido' }}
                    renderItem={(f, i) => (
                      <List.Item
                        actions={conduct ? (f.status === 'waiting'
                          ? [<Button key="g" size="small" type="primary" onClick={() => decide.mutate({ id: f.id, decision: 'grant' })}>Conceder</Button>,
                             <Button key="d" size="small" onClick={() => decide.mutate({ id: f.id, decision: 'deny' })}>Negar</Button>]
                          : [<Button key="e" size="small" danger onClick={() => decide.mutate({ id: f.id, decision: 'end' })}>Encerrar</Button>]) : []}
                      >
                        <List.Item.Meta
                          title={<Space wrap><span>{f.status === 'waiting' ? `${i + 1 - d.floor.filter((x) => x.status === 'granted').length}º ` : ''}{f.person_name}</span>
                            {f.status === 'granted' ? (f.granted_at && <SpeakingTimer grantedAt={f.granted_at} maxSeconds={f.max_seconds} />) : <Tag>{FLOOR_STATUS_LABELS[f.status]}</Tag>}</Space>}
                          description={f.topic}
                        />
                      </List.Item>
                    )}
                  />
                </Card>
              </Space>
            </Col>
          </Row>
          {d.participants && (
            <Card size="small" title={`Conectados à sala (${d.participants.length})`}>
              <Table size="small" rowKey="identity" dataSource={d.participants} pagination={{ pageSize: 15, hideOnSinglePage: true }}
                columns={[
                  { title: 'Nome', dataIndex: 'name' },
                  { title: 'Tipo', dataIndex: 'identity', render: (v: string) => (v.startsWith('staff:') ? <Tag color="blue">mesa</Tag> : v.startsWith('obs:') ? <Tag>fiscal</Tag> : <Tag color="green">condômino</Tag>) },
                  { title: 'Entrou', dataIndex: 'joinedAt', render: fmtDateTimeSec },
                  { title: 'Publicando', dataIndex: 'tracks', render: (t: { source: string; muted: boolean }[]) => t.map((x) => <Tag key={x.source} color={x.muted ? 'default' : 'red'}>{x.source}</Tag>) },
                ]} />
            </Card>
          )}
        </Space>
      )}
    </QueryState>
  );
}
