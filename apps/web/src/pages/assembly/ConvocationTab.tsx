import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CONVOCATION_STATUS_LABELS, DELIVERY_STATUS_LABELS } from '@lsg/shared';
import { Alert, App, Button, Card, Checkbox, Col, Empty, Form, Input, Modal, Row, Space, Statistic, Table, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { QueryState } from '../../components/ui';
import { api, download, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDateTime } from '../../lib/format';
import type { AssemblyDetail } from './types';

interface Stats { recipients: number; withoutAddress: number; sent: number; failed: number; pending: number; opened: number }
interface Convocation {
  id: string;
  version: number;
  status: 'draft' | 'published' | 'superseded' | 'cancelled';
  subject: string;
  body: string;
  content_sha256: string | null;
  published_at: string | null;
  published_by_name: string | null;
  rectification_reason: string | null;
  stats: Stats | null;
}
interface ConvList { items: Convocation[]; warnings: string[]; legalNotice: string; canEdit: boolean }
interface Recipient {
  id: string; unit: string; person_name: string; relation: string; channel: string; address_masked: string | null;
  delivery_status: string | null; attempts: number | null; last_error: string | null; sent_at: string | null;
  first_opened_at: string | null; opens: number;
}

const STATUS_COLORS: Record<string, string> = { draft: 'default', published: 'green', superseded: 'orange', cancelled: 'red' };
const DELIVERY_COLORS: Record<string, string> = { queued: 'blue', sending: 'processing', sent: 'green', failed: 'red' };

function Recipients({ c, assemblyId }: { c: Convocation; assemblyId: string }) {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const q = useQuery({ queryKey: ['assembly', assemblyId, 'convocation', c.id, 'recipients'], queryFn: () => api<Recipient[]>(`/convocations/${c.id}/recipients`) });
  const resend = useMutation({
    mutationFn: (rid: string) => api(`/convocations/${c.id}/recipients/${rid}/resend`, { method: 'POST' }),
    onSuccess: () => {
      message.success('Reenvio colocado na fila');
      qc.invalidateQueries({ queryKey: ['assembly', assemblyId] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });
  return (
    <QueryState loading={q.isLoading} error={q.error}>
      <Table<Recipient>
        size="small"
        rowKey="id"
        dataSource={q.data}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        scroll={{ x: 900 }}
        columns={[
          { title: 'Unidade', dataIndex: 'unit', width: 120 },
          { title: 'Destinatário', dataIndex: 'person_name' },
          { title: 'Endereço', dataIndex: 'address_masked', render: (v) => v ?? <Tag color="red">sem e-mail</Tag> },
          {
            title: 'Envio',
            dataIndex: 'delivery_status',
            render: (v: string | null, r) =>
              r.channel === 'none' ? <Tag>{DELIVERY_STATUS_LABELS.none}</Tag> : (
                <Space direction="vertical" size={0}>
                  <Tag color={DELIVERY_COLORS[v ?? ''] ?? 'default'}>{DELIVERY_STATUS_LABELS[v ?? ''] ?? v}</Tag>
                  {r.last_error && <Typography.Text type="danger" style={{ fontSize: 12 }}>{r.last_error}</Typography.Text>}
                </Space>
              ),
          },
          { title: 'Tentativas', dataIndex: 'attempts', width: 90 },
          { title: 'Aceito em', dataIndex: 'sent_at', render: fmtDateTime },
          { title: 'Abertura do link', dataIndex: 'first_opened_at', render: (v, r) => (v ? `${fmtDateTime(v)}${r.opens > 1 ? ` (${r.opens}×)` : ''}` : '—') },
          {
            title: '',
            key: 'act',
            render: (_, r) =>
              c.status === 'published' && r.channel === 'email' && r.delivery_status !== 'queued' && r.delivery_status !== 'sending' ? (
                <Button size="small" onClick={() => resend.mutate(r.id)} loading={resend.isPending && resend.variables === r.id}>Reenviar</Button>
              ) : null,
          },
        ]}
      />
    </QueryState>
  );
}

export function ConvocationTab({ a }: { a: AssemblyDetail }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const { message } = App.useApp();
  const [form] = Form.useForm<{ subject: string; body: string }>();
  const [publishOpen, setPublishOpen] = useState(false);
  const [ack, setAck] = useState(false);
  const [reason, setReason] = useState('');
  const [openRecipients, setOpenRecipients] = useState<string | null>(null);
  const [rectifying, setRectifying] = useState(false);
  const q = useQuery({ queryKey: ['assembly', a.id, 'convocations'], queryFn: () => api<ConvList>(`/assemblies/${a.id}/convocations`) });
  const items = q.data?.items ?? [];
  const draft = items.find((c) => c.status === 'draft');
  const current = items.find((c) => c.status === 'published');
  const canConvene = can('assembly.convene');

  useEffect(() => {
    const base = draft ?? current;
    if (base) form.setFieldsValue({ subject: base.subject, body: base.body });
    else form.setFieldsValue({ subject: `Edital de convocação — ${a.title}`, body: '' });
  }, [draft?.id, current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const inv = () => qc.invalidateQueries({ queryKey: ['assembly', a.id] });
  const save = useMutation({
    mutationFn: (v: { subject: string; body: string }) => api(`/assemblies/${a.id}/convocations/draft`, { method: 'PUT', body: v }),
    onSuccess: () => {
      message.success('Rascunho salvo');
      inv();
    },
    onError: (e) => message.error(errorMessage(e)),
  });
  const publish = useMutation({
    mutationFn: () =>
      api<{ version: number; recipients: number; queued: number; withoutAddress: number }>(`/assemblies/${a.id}/convocations/publish`, {
        method: 'POST',
        body: { acknowledgeLegalNotice: ack, ...(current ? { rectificationReason: reason } : {}) },
      }),
    onSuccess: (r) => {
      message.success(`Edital v${r.version} publicado: ${r.queued} envio(s) na fila, ${r.withoutAddress} sem e-mail`);
      setPublishOpen(false);
      setRectifying(false);
      setAck(false);
      setReason('');
      inv();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const publishable = ['approved_for_call', 'called'].includes(a.status);

  return (
    <QueryState loading={q.isLoading} error={q.error}>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Alert type="warning" showIcon message="Validade jurídica" description={q.data?.legalNotice} />
        {q.data?.warnings.map((w) => <Alert key={w} type="info" showIcon message={w} />)}

        {canConvene && q.data?.canEdit && current && !draft && !rectifying && (
          <Button onClick={() => setRectifying(true)}>Retificar edital (nova versão)</Button>
        )}
        {canConvene && q.data?.canEdit && (!current || draft || rectifying) && (
          <Card
            size="small"
            title={draft ? `Rascunho — versão ${draft.version}` : current ? 'Nova versão (retificação)' : 'Redigir edital'}
            extra={
              <Space wrap>
                <Button onClick={() => form.validateFields().then((v) => save.mutate(v))} loading={save.isPending}>Salvar rascunho</Button>
                <Button type="primary" disabled={!draft || !publishable} onClick={() => setPublishOpen(true)}>
                  {current ? 'Publicar retificação' : 'Publicar e enviar'}
                </Button>
              </Space>
            }
          >
            {!publishable && <Alert style={{ marginBottom: 12 }} type="info" showIcon message="A publicação fica disponível quando a assembleia estiver aprovada para convocação." />}
            <Form form={form} layout="vertical">
              <Form.Item name="subject" label="Assunto do e-mail" rules={[{ required: true, min: 5, max: 200 }]}>
                <Input maxLength={200} />
              </Form.Item>
              <Form.Item
                name="body"
                label="Texto do edital"
                extra="A pauta, as datas de 1ª/2ª convocação, a modalidade e o local são incluídos automaticamente a partir da assembleia."
                rules={[{ required: true, min: 20, message: 'O edital precisa conter o texto da convocação' }]}
              >
                <Input.TextArea rows={8} maxLength={50000} showCount />
              </Form.Item>
            </Form>
          </Card>
        )}

        {items.filter((c) => c.status !== 'draft').length === 0 && <Empty description="Nenhum edital publicado" />}
        {items
          .filter((c) => c.status !== 'draft')
          .map((c) => (
            <Card
              key={c.id}
              size="small"
              title={
                <Space wrap>
                  <span>Edital v{c.version} — {c.subject}</span>
                  <Tag color={STATUS_COLORS[c.status]}>{CONVOCATION_STATUS_LABELS[c.status]}</Tag>
                </Space>
              }
              extra={
                canConvene || can('reports.export') ? (
                  <Space wrap>
                    {canConvene && c.stats && c.stats.recipients > 0 && (
                      <Button size="small" onClick={() => setOpenRecipients(openRecipients === c.id ? null : c.id)}>
                        {openRecipients === c.id ? 'Ocultar destinatários' : 'Destinatários'}
                      </Button>
                    )}
                    {can('reports.export') && (
                      <>
                        <Button size="small" onClick={() => download(`/convocations/${c.id}/reports/receipt?format=csv`, 'convocacao.csv').then((h) => { if (h) message.info(`SHA-256 do arquivo: ${h}`); }).catch((e) => message.error(errorMessage(e)))}>Comprovante CSV</Button>
                        <Button size="small" onClick={() => download(`/convocations/${c.id}/reports/receipt?format=xlsx`, 'convocacao.xlsx').then((h) => { if (h) message.info(`SHA-256 do arquivo: ${h}`); }).catch((e) => message.error(errorMessage(e)))}>XLSX</Button>
                      </>
                    )}
                  </Space>
                ) : null
              }
            >
              <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
                Publicado em {fmtDateTime(c.published_at)}{c.published_by_name ? ` por ${c.published_by_name}` : ''}
                {c.rectification_reason ? ` · Retificação: ${c.rectification_reason}` : ''}
                <br />SHA-256 do conteúdo: <Typography.Text code copyable style={{ fontSize: 12 }}>{c.content_sha256}</Typography.Text>
              </Typography.Paragraph>
              <Typography.Paragraph style={{ whiteSpace: 'pre-wrap' }} ellipsis={{ rows: 3, expandable: true, symbol: 'ver mais' }}>{c.body}</Typography.Paragraph>
              {c.stats && (
                <Row gutter={[16, 8]}>
                  {([
                    ['Destinatários', c.stats.recipients],
                    ['Aceitos pelo provedor', c.stats.sent],
                    ['Na fila', c.stats.pending],
                    ['Falhas', c.stats.failed],
                    ['Sem e-mail', c.stats.withoutAddress],
                    ['Abriram o link', c.stats.opened],
                  ] as const).map(([t, v]) => (
                    <Col key={t} xs={12} sm={8} md={4}>
                      <Statistic title={t} value={v} valueStyle={{ fontSize: 20, color: (t === 'Falhas' || t === 'Sem e-mail') && v > 0 ? '#cf1322' : undefined }} />
                    </Col>
                  ))}
                </Row>
              )}
              {openRecipients === c.id && <div style={{ marginTop: 12 }}><Recipients c={c} assemblyId={a.id} /></div>}
            </Card>
          ))}
      </Space>

      <Modal
        open={publishOpen}
        title={current ? 'Publicar retificação do edital' : 'Publicar edital e enviar convocações'}
        okText="Publicar"
        okButtonProps={{ disabled: !ack || (!!current && reason.trim().length < 5), loading: publish.isPending }}
        onOk={() => publish.mutate()}
        onCancel={() => setPublishOpen(false)}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Paragraph>
            O conteúdo será congelado (hash SHA-256) junto com a pauta e as datas. Os destinatários são todos os titulares com vínculo
            ativo das unidades do condomínio; cada um recebe um link pessoal.
            {a.status === 'approved_for_call' && ' A assembleia passará ao estado “Convocada”.'}
          </Typography.Paragraph>
          {current && (
            <Input.TextArea rows={3} placeholder="Motivo da retificação (obrigatório)" value={reason} onChange={(e) => setReason(e.target.value)} />
          )}
          <Checkbox checked={ack} onChange={(e) => setAck(e.target.checked)}>
            Estou ciente de que o envio eletrônico não substitui o meio de convocação previsto na convenção e de que a validade
            jurídica depende do cumprimento do prazo e da convocação de todos os condôminos.
          </Checkbox>
        </Space>
      </Modal>
    </QueryState>
  );
}
