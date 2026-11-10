import { ArrowLeftOutlined, CheckCircleTwoTone, WifiOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Badge, Button, Card, Col, Empty, Layout, List, Modal, Result, Row, Space, Tag, Typography } from 'antd';
import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { AssemblyStatus } from '@lsg/shared';
import { AttendeeMediaPanel } from '../components/media/MediaPanel';
import { AssemblyStatusTag, BallotStatusTag, OutcomeTag, QueryState } from '../components/ui';
import { ApiError, api, errorMessage, newIdempotencyKey } from '../lib/api';
import { fmtDateTimeSec, fmtFraction } from '../lib/format';
import { useAssemblyRealtime, useOnline } from '../lib/realtime';
import type { BallotDetail } from './assembly/types';

interface MyView {
  person: { id: string; name: string } | null;
  units: {
    unit_id: string;
    unit: string;
    ideal_fraction: string;
    voting_status: string;
    basis: 'titular' | 'procuracao';
    poa_id: string | null;
    is_voting_representative: boolean;
    owners: number;
    accreditation: { id: string; mine: boolean; mode: string } | null;
  }[];
  ballots: {
    id: string;
    title: string;
    question: string;
    ballot_type: string;
    max_choices: number;
    secrecy: string;
    status: 'open' | 'closed' | 'tallied' | 'declared';
    allow_vote_change: boolean;
    round: number;
    options: { id: string; label: string; kind: string }[];
    myVotes: { unit_id: string; receipt_code: string; version: number; cast_at: string }[];
  }[];
}

interface Asm {
  id: string;
  code: string;
  title: string;
  status: AssemblyStatus;
  condominium: { name: string };
}

/**
 * Sala do participante: assistir, credenciar-se remotamente e votar no mesmo ambiente.
 * O voto só é exibido como registrado após a confirmação persistida do servidor.
 */
export function VoterRoomPage() {
  const { id } = useParams<{ id: string }>();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const online = useOnline();
  const conn = useAssemblyRealtime(id, 10000);
  const asm = useQuery({ queryKey: ['assembly', id], queryFn: () => api<Asm>(`/assemblies/${id}`) });
  const my = useQuery({ queryKey: ['assembly', id, 'my'], queryFn: () => api<MyView>(`/assemblies/${id}/my`) });
  const [voting, setVoting] = useState<{ ballotId: string; unitId: string; unit: string } | null>(null);
  const [choice, setChoice] = useState<string[]>([]);
  const [receipt, setReceipt] = useState<{ receipt: string; castAt: string; unit: string } | null>(null);
  const pendingKey = useRef<string | null>(null);

  const accredit = useMutation({
    mutationFn: (u: MyView['units'][number]) =>
      api(`/assemblies/${id}/accreditations/self`, { method: 'POST', body: { unitId: u.unit_id, poaId: u.poa_id ?? undefined } }),
    onSuccess: () => {
      message.success('Presença confirmada');
      qc.invalidateQueries({ queryKey: ['assembly', id] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const cast = useMutation({
    mutationFn: () => {
      // a mesma chave é reutilizada em novas tentativas → o servidor nunca registra duas vezes
      pendingKey.current ??= newIdempotencyKey();
      return api<{ receipt: string; castAt: string; replayed: boolean }>(`/ballots/${voting!.ballotId}/votes`, {
        method: 'POST',
        body: { unitId: voting!.unitId, optionIds: choice, idempotencyKey: pendingKey.current },
      });
    },
    onSuccess: (r) => {
      pendingKey.current = null;
      setReceipt({ receipt: r.receipt, castAt: r.castAt, unit: voting!.unit });
      setVoting(null);
      setChoice([]);
      qc.invalidateQueries({ queryKey: ['assembly', id] });
    },
    onError: (e) => {
      // falha de rede: mantém a chave para reenvio seguro; erro definitivo: descarta
      if (e instanceof ApiError) pendingKey.current = null;
      message.error(e instanceof ApiError ? errorMessage(e) : 'Falha de conexão. O voto NÃO foi confirmado. Tente novamente — não haverá voto duplicado.');
    },
  });

  const m = my.data;
  const a = asm.data;
  const openBallots = m?.ballots.filter((b) => b.status === 'open') ?? [];
  const finished = m?.ballots.filter((b) => b.status === 'declared') ?? [];
  const myAccredited = m?.units.filter((u) => u.accreditation?.mine) ?? [];
  const currentBallot = voting ? m?.ballots.find((b) => b.id === voting.ballotId) : undefined;
  const canAccredit = a && ['accreditation', 'in_progress', 'suspended'].includes(a.status);

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Header className="app-header">
        <Space>
          <Link to="/" aria-label="Voltar"><ArrowLeftOutlined /></Link>
          <Typography.Text strong>{a?.condominium.name}</Typography.Text>
        </Space>
        <Space>
          <Badge status={conn === 'online' && online ? 'success' : 'error'} text={conn === 'online' && online ? 'Conectado' : 'Reconectando…'} />
        </Space>
      </Layout.Header>
      {(!online || conn === 'offline') && (
        <Alert banner type="error" icon={<WifiOutlined />} message="Conexão interrompida. Votos só são aceitos com confirmação do servidor; sua tela será atualizada ao reconectar." />
      )}
      <Layout.Content id="conteudo" className="app-content">
        <QueryState loading={asm.isLoading || my.isLoading} error={asm.error || my.error}>
          {a && m && (
            <Row gutter={[16, 16]}>
              <Col xs={24}>
                <Space wrap>
                  <Typography.Title level={4} style={{ margin: 0 }}>{a.code} — {a.title}</Typography.Title>
                  <AssemblyStatusTag status={a.status} />
                </Space>
                {m.person && <Typography.Paragraph type="secondary">Participante: {m.person.name}</Typography.Paragraph>}
              </Col>
              <Col xs={24} lg={14}>
                <Space direction="vertical" style={{ width: '100%' }} size="middle">
                  <AttendeeMediaPanel assemblyId={a.id} assemblyStatus={a.status} accredited={myAccredited.length > 0} />
                  <Card title="Votações abertas">
                    {openBallots.length === 0 ? (
                      <Empty description="Nenhuma votação aberta no momento" />
                    ) : (
                      openBallots.map((b) => (
                        <Card key={b.id} type="inner" title={b.title} style={{ marginBottom: 12 }} extra={b.secrecy === 'secret' && <Tag color="purple">sigilosa</Tag>}>
                          <Typography.Paragraph>{b.question}</Typography.Paragraph>
                          {myAccredited.length === 0 && <Alert type="warning" showIcon message="Confirme sua presença (credenciamento) para votar." />}
                          <Space direction="vertical" style={{ width: '100%' }}>
                            {myAccredited.map((u) => {
                              const v = b.myVotes.find((x) => x.unit_id === u.unit_id);
                              return (
                                <Space key={u.unit_id} wrap style={{ justifyContent: 'space-between', width: '100%' }}>
                                  <span>Unidade <b>{u.unit}</b>{u.basis === 'procuracao' ? ' (procuração)' : ''}</span>
                                  {v ? (
                                    <Space>
                                      <CheckCircleTwoTone twoToneColor="#52c41a" />
                                      <span>Voto registrado · comprovante <span className="mono">{v.receipt_code}</span></span>
                                      {b.allow_vote_change && <Button size="small" onClick={() => setVoting({ ballotId: b.id, unitId: u.unit_id, unit: u.unit })}>Substituir</Button>}
                                    </Space>
                                  ) : (
                                    <Button type="primary" size="large" onClick={() => setVoting({ ballotId: b.id, unitId: u.unit_id, unit: u.unit })}>
                                      Votar
                                    </Button>
                                  )}
                                </Space>
                              );
                            })}
                          </Space>
                        </Card>
                      ))
                    )}
                  </Card>
                  {finished.length > 0 && (
                    <Card title="Resultados declarados">
                      {finished.map((b) => (
                        <DeclaredResult key={b.id} ballotId={b.id} />
                      ))}
                    </Card>
                  )}
                </Space>
              </Col>
              <Col xs={24} lg={10}>
                <Card title="Minhas unidades e presença">
                  {m.units.length === 0 ? (
                    <Empty description={m.person ? 'Nenhuma unidade vinculada' : 'Usuário sem cadastro de condômino'} />
                  ) : (
                    <List
                      dataSource={m.units}
                      renderItem={(u) => (
                        <List.Item
                          actions={[
                            u.accreditation?.mine ? (
                              <Tag key="ok" color="green">Presente ({u.accreditation.mode})</Tag>
                            ) : u.accreditation ? (
                              <Tag key="other" color="orange">Representada por outra pessoa</Tag>
                            ) : (
                              <Button key="acc" disabled={!canAccredit || u.voting_status !== 'eligible'} loading={accredit.isPending} onClick={() => accredit.mutate(u)}>
                                Confirmar presença
                              </Button>
                            ),
                          ]}
                        >
                          <List.Item.Meta
                            title={`${u.unit}${u.basis === 'procuracao' ? ' · procuração' : ''}`}
                            description={
                              <span>
                                Fração {fmtFraction(u.ideal_fraction)}
                                {u.voting_status !== 'eligible' && <Tag color="red" style={{ marginLeft: 8 }}>voto restrito</Tag>}
                                {u.owners > 1 && !u.is_voting_representative && <Tag style={{ marginLeft: 8 }}>coproprietário não designado</Tag>}
                              </span>
                            }
                          />
                        </List.Item>
                      )}
                    />
                  )}
                </Card>
              </Col>
            </Row>
          )}
        </QueryState>
      </Layout.Content>

      <Modal
        open={!!voting}
        title={currentBallot ? `${currentBallot.title} — unidade ${voting?.unit}` : ''}
        onCancel={() => !cast.isPending && setVoting(null)}
        footer={[
          <Button key="c" onClick={() => setVoting(null)} disabled={cast.isPending}>Voltar</Button>,
          <Button key="ok" type="primary" size="large" disabled={choice.length === 0 || !online} loading={cast.isPending} onClick={() => cast.mutate()}>
            Confirmar voto
          </Button>,
        ]}
      >
        {currentBallot && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Typography.Paragraph>{currentBallot.question}</Typography.Paragraph>
            {currentBallot.ballot_type === 'multiple_choice' && <Typography.Text type="secondary">Escolha até {currentBallot.max_choices} opção(ões).</Typography.Text>}
            <div role={currentBallot.ballot_type === 'multiple_choice' ? 'group' : 'radiogroup'} aria-label="Opções de voto" style={{ display: 'grid', gap: 8 }}>
              {currentBallot.options.map((o) => {
                const selected = choice.includes(o.id);
                return (
                  <Button
                    key={o.id}
                    className="vote-option"
                    type={selected ? 'primary' : 'default'}
                    role={currentBallot.ballot_type === 'multiple_choice' ? 'checkbox' : 'radio'}
                    aria-checked={selected}
                    onClick={() => {
                      if (currentBallot.ballot_type !== 'multiple_choice' || ['abstention', 'blank', 'null'].includes(o.kind)) setChoice([o.id]);
                      else {
                        const base = choice.filter((c) => currentBallot.options.find((x) => x.id === c)?.kind === 'regular');
                        setChoice(selected ? base.filter((c) => c !== o.id) : base.length < currentBallot.max_choices ? [...base, o.id] : base);
                      }
                    }}
                  >
                    {o.label}
                  </Button>
                );
              })}
            </div>
            <Alert type="info" showIcon message="Confira sua escolha. O voto é registrado somente após a confirmação do servidor." />
          </Space>
        )}
      </Modal>

      <Modal open={!!receipt} footer={<Button type="primary" onClick={() => setReceipt(null)}>Fechar</Button>} onCancel={() => setReceipt(null)} closable>
        <Result
          status="success"
          title="Voto registrado"
          subTitle={
            <Space direction="vertical">
              <span>Unidade {receipt?.unit} · {fmtDateTimeSec(receipt?.castAt)}</span>
              <span>Comprovante: <b className="mono" style={{ fontSize: 18 }}>{receipt?.receipt}</b></span>
              <span>Guarde este código para conferência.</span>
            </Space>
          }
        />
      </Modal>
    </Layout>
  );
}

function DeclaredResult({ ballotId }: { ballotId: string }) {
  const d = useQuery({ queryKey: ['ballot', ballotId], queryFn: () => api<BallotDetail>(`/ballots/${ballotId}`) });
  if (!d.data) return null;
  return (
    <Space direction="vertical" style={{ width: '100%', marginBottom: 12 }}>
      <Space wrap>
        <Typography.Text strong>{d.data.title}</Typography.Text>
        <BallotStatusTag status={d.data.status} />
        {d.data.result && <OutcomeTag outcome={d.data.result.outcome} />}
      </Space>
      {d.data.result?.tally.options.map((o) => (
        <Typography.Text key={o.id} type="secondary">
          {o.label}: {o.units} unid. ({fmtFraction(o.fraction)})
        </Typography.Text>
      ))}
    </Space>
  );
}
