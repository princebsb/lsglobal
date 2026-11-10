import { PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, DatePicker, Form, Input, Modal, Radio, Segmented, Select, Space, Switch, Table, Tag, Timeline } from 'antd';
import dayjs from 'dayjs';
import { useState } from 'react';
import type { PoaStatus } from '@lsg/shared';
import { PoaStatusTag } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDateTime } from '../../lib/format';

interface PoaRow {
  id: string;
  scope: 'assembly' | 'general';
  assembly_title: string | null;
  status: PoaStatus;
  valid_from: string;
  valid_until: string | null;
  grantor_name: string;
  attorney_name: string;
  units: { unitId: string; unit: string }[];
  review_notes: string | null;
  revoke_reason: string | null;
  reviewed_by_name: string | null;
  submitted_at: string;
}

export function PoaTab({ condoId }: { condoId: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const { message } = App.useApp();
  const [status, setStatus] = useState<string>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [review, setReview] = useState<{ poa: PoaRow; mode: 'review' | 'revoke' } | null>(null);
  const [history, setHistory] = useState<PoaRow | null>(null);
  const [form] = Form.useForm();
  const [rForm] = Form.useForm();
  const grantorId = Form.useWatch('grantorPersonId', form);

  const poas = useQuery({
    queryKey: ['poas', condoId, status],
    queryFn: () => api<PoaRow[]>(`/condominiums/${condoId}/poas${status !== 'all' ? `?status=${status}` : ''}`),
  });
  const people = useQuery({
    queryKey: ['people', condoId, 'poa'],
    queryFn: () =>
      api<{ id: string; name: string; document: string; units: { unitId: string; unit: string; condominiumId: string }[] }[]>(`/people?condominiumId=${condoId}`),
    enabled: createOpen,
  });
  const assemblies = useQuery({
    queryKey: ['assemblies', condoId],
    queryFn: () => api<{ id: string; code: string; title: string }[]>(`/assemblies?condominiumId=${condoId}`),
    enabled: createOpen,
  });
  const hist = useQuery({
    queryKey: ['poa-history', history?.id],
    queryFn: () => api<{ event: string; notes: string | null; at: string; actor: string | null }[]>(`/poas/${history!.id}/history`),
    enabled: !!history,
  });
  const grantorUnits = people.data?.find((p) => p.id === grantorId)?.units.filter((u) => u.condominiumId === condoId) ?? [];
  const inv = () => qc.invalidateQueries({ queryKey: ['poas', condoId] });

  const create = useMutation({
    mutationFn: (v: object) => api(`/condominiums/${condoId}/poas`, { method: 'POST', body: v }),
    onSuccess: () => {
      message.success('Procuração registrada para análise');
      setCreateOpen(false);
      form.resetFields();
      inv();
    },
    onError: (e) => message.error(errorMessage(e)),
  });
  const decide = useMutation({
    mutationFn: ({ id, path, body }: { id: string; path: string; body: object }) => api(`/poas/${id}/${path}`, { method: 'POST', body }),
    onSuccess: () => {
      message.success('Decisão registrada');
      setReview(null);
      rForm.resetFields();
      inv();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  return (
    <Card
      title="Procurações"
      extra={
        <Space wrap>
          <Segmented
            value={status}
            onChange={(v) => setStatus(String(v))}
            options={[
              { value: 'all', label: 'Todas' },
              { value: 'pending', label: 'Em análise' },
              { value: 'approved', label: 'Aprovadas' },
              { value: 'rejected', label: 'Rejeitadas' },
              { value: 'revoked', label: 'Revogadas' },
            ]}
          />
          {can('poa.submit') && <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>Registrar</Button>}
        </Space>
      }
    >
      <Table
        rowKey="id"
        loading={poas.isLoading}
        dataSource={poas.data}
        scroll={{ x: true }}
        columns={[
          { title: 'Outorgante', dataIndex: 'grantor_name' },
          { title: 'Procurador', dataIndex: 'attorney_name' },
          { title: 'Unidades', dataIndex: 'units', render: (us: PoaRow['units']) => us.map((u) => <Tag key={u.unitId}>{u.unit}</Tag>) },
          { title: 'Escopo', key: 'scope', render: (_: unknown, p: PoaRow) => (p.scope === 'general' ? 'Geral' : `Assembleia: ${p.assembly_title}`) },
          { title: 'Validade', key: 'v', render: (_: unknown, p: PoaRow) => `${fmtDateTime(p.valid_from)} → ${p.valid_until ? fmtDateTime(p.valid_until) : 'indeterminada'}` },
          { title: 'Situação', dataIndex: 'status', render: (s: PoaStatus) => <PoaStatusTag status={s} /> },
          {
            title: 'Ações',
            key: 'a',
            render: (_: unknown, p: PoaRow) => (
              <Space wrap>
                {can('poa.review') && p.status === 'pending' && <Button size="small" type="primary" onClick={() => setReview({ poa: p, mode: 'review' })}>Analisar</Button>}
                {can('poa.review') && ['pending', 'approved'].includes(p.status) && <Button size="small" danger onClick={() => setReview({ poa: p, mode: 'revoke' })}>Revogar</Button>}
                <Button size="small" onClick={() => setHistory(p)}>Histórico</Button>
              </Space>
            ),
          },
        ]}
      />

      <Modal title="Registrar procuração" open={createOpen} onCancel={() => setCreateOpen(false)} onOk={() => form.submit()} confirmLoading={create.isPending} width={640}>
        <Form
          form={form}
          layout="vertical"
          initialValues={{ scope: 'assembly', canVote: true, canSpeak: true, validFrom: dayjs() }}
          onFinish={(v) => create.mutate({ ...v, validFrom: v.validFrom.toISOString(), validUntil: v.validUntil?.toISOString() })}
        >
          <Form.Item name="grantorPersonId" label="Outorgante (titular)" rules={[{ required: true }]}>
            <Select showSearch optionFilterProp="label" options={people.data?.filter((p) => p.units.some((u) => u.condominiumId === condoId)).map((p) => ({ value: p.id, label: `${p.name} (${p.document})` }))} />
          </Form.Item>
          <Form.Item name="unitIds" label="Unidades abrangidas" rules={[{ required: true }]}>
            <Select mode="multiple" options={grantorUnits.map((u) => ({ value: u.unitId, label: u.unit }))} placeholder="Selecione o outorgante primeiro" />
          </Form.Item>
          <Form.Item name="attorneyPersonId" label="Procurador" rules={[{ required: true }]} extra="O procurador precisa estar cadastrado como pessoa.">
            <Select showSearch optionFilterProp="label" options={people.data?.map((p) => ({ value: p.id, label: `${p.name} (${p.document})` }))} />
          </Form.Item>
          <Form.Item name="scope" label="Escopo">
            <Radio.Group options={[{ value: 'assembly', label: 'Assembleia específica' }, { value: 'general', label: 'Geral (todas as assembleias no período)' }]} />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(a, b) => a.scope !== b.scope}>
            {({ getFieldValue }) =>
              getFieldValue('scope') === 'assembly' && (
                <Form.Item name="assemblyId" label="Assembleia" rules={[{ required: true }]}>
                  <Select options={assemblies.data?.map((a) => ({ value: a.id, label: `${a.code} — ${a.title}` }))} />
                </Form.Item>
              )
            }
          </Form.Item>
          <Space wrap>
            <Form.Item name="validFrom" label="Válida a partir de" rules={[{ required: true }]}><DatePicker showTime format="DD/MM/YYYY HH:mm" /></Form.Item>
            <Form.Item name="validUntil" label="Válida até"><DatePicker showTime format="DD/MM/YYYY HH:mm" /></Form.Item>
          </Space>
          <Space>
            <Form.Item name="canVote" label="Poderes de voto" valuePropName="checked"><Switch /></Form.Item>
            <Form.Item name="canSpeak" label="Poderes de palavra" valuePropName="checked"><Switch /></Form.Item>
          </Space>
          <Form.Item name="restrictions" label="Restrições / observações"><Input.TextArea rows={2} /></Form.Item>
        </Form>
      </Modal>

      <Modal
        title={review?.mode === 'revoke' ? 'Revogar procuração' : 'Análise documental da procuração'}
        open={!!review}
        onCancel={() => setReview(null)}
        footer={null}
      >
        <Form
          form={rForm}
          layout="vertical"
          onFinish={(v) =>
            review &&
            decide.mutate(
              review.mode === 'revoke'
                ? { id: review.poa.id, path: 'revoke', body: { reason: v.notes } }
                : { id: review.poa.id, path: 'review', body: { decision: v.decision, notes: v.notes ?? '' } },
            )
          }
        >
          <p>
            <b>{review?.poa.grantor_name}</b> → <b>{review?.poa.attorney_name}</b> ({review?.poa.units.map((u) => u.unit).join(', ')})
          </p>
          {review?.mode === 'review' && (
            <Form.Item name="decision" label="Decisão" rules={[{ required: true }]}>
              <Radio.Group options={[{ value: 'approve', label: 'Aprovar' }, { value: 'reject', label: 'Rejeitar' }]} />
            </Form.Item>
          )}
          <Form.Item name="notes" label={review?.mode === 'revoke' ? 'Motivo da revogação' : 'Fundamentação'} rules={review?.mode === 'revoke' ? [{ required: true, min: 5 }] : []}>
            <Input.TextArea rows={3} />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={decide.isPending} danger={review?.mode === 'revoke'} block>
            Confirmar
          </Button>
        </Form>
      </Modal>

      <Modal title="Histórico da procuração" open={!!history} onCancel={() => setHistory(null)} footer={null}>
        <Timeline items={(hist.data ?? []).map((h) => ({ children: `${fmtDateTime(h.at)} — ${h.event}${h.actor ? ` por ${h.actor}` : ''}${h.notes ? `: ${h.notes}` : ''}` }))} />
      </Modal>
    </Card>
  );
}
