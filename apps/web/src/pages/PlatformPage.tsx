import { PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Col, Form, Input, Modal, Row, Select, Statistic, Table, Tag } from 'antd';
import { useState } from 'react';
import { TENANT_KINDS } from '@lsg/shared';
import { PageHeader, QueryState } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { TENANT_KIND_LABELS, fmtDate } from '../lib/format';

const METRICS: [string, string][] = [
  ['tenants_active', 'Clientes ativos'],
  ['condominiums', 'Condomínios'],
  ['units', 'Unidades'],
  ['users', 'Usuários'],
  ['assemblies_scheduled', 'Assembleias agendadas'],
  ['assemblies_live', 'Assembleias em andamento'],
  ['assemblies_closed', 'Assembleias encerradas'],
  ['ballots_open', 'Votações abertas'],
];

export function PlatformPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const { message } = App.useApp();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  const overview = useQuery({ queryKey: ['platform', 'overview'], queryFn: () => api<Record<string, number>>('/platform/overview', { tenant: false }) });
  const tenants = useQuery({
    queryKey: ['platform', 'tenants'],
    queryFn: () => api<{ id: string; name: string; kind: string; status: string; created_at: string; assignments: number }[]>('/platform/tenants', { tenant: false }),
    enabled: can('platform.tenants.access'),
  });
  const create = useMutation({
    mutationFn: (v: object) => api('/platform/tenants', { method: 'POST', body: v, tenant: false }),
    onSuccess: () => {
      message.success('Cliente criado');
      setOpen(false);
      form.resetFields();
      qc.invalidateQueries({ queryKey: ['platform'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  return (
    <>
      <PageHeader
        title="Plataforma LS Global"
        subtitle="Visão consolidada de clientes e operações"
        extra={can('platform.tenants.manage') && <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>Novo cliente</Button>}
      />
      <QueryState loading={overview.isLoading} error={overview.error}>
        <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
          {METRICS.map(([k, label]) => (
            <Col xs={12} md={6} key={k}>
              <Card>
                <Statistic title={label} value={overview.data?.[k] ?? 0} />
              </Card>
            </Col>
          ))}
        </Row>
      </QueryState>
      <Card title="Clientes contratantes">
        <Table
          rowKey="id"
          loading={tenants.isLoading}
          dataSource={tenants.data}
          scroll={{ x: true }}
          columns={[
            { title: 'Cliente', dataIndex: 'name' },
            { title: 'Tipo', dataIndex: 'kind', render: (k: string) => TENANT_KIND_LABELS[k] ?? k },
            { title: 'Situação', dataIndex: 'status', render: (s: string) => <Tag color={s === 'active' ? 'green' : 'red'}>{s}</Tag> },
            { title: 'Perfis atribuídos', dataIndex: 'assignments' },
            { title: 'Criado em', dataIndex: 'created_at', render: fmtDate },
          ]}
        />
      </Card>
      <Modal title="Novo cliente contratante" open={open} onCancel={() => setOpen(false)} onOk={() => form.submit()} confirmLoading={create.isPending} okText="Criar">
        <Form form={form} layout="vertical" onFinish={(v) => create.mutate({ ...v, document: v.document || undefined })}>
          <Form.Item name="name" label="Razão social / nome" rules={[{ required: true, min: 2 }]}>
            <Input />
          </Form.Item>
          <Form.Item name="kind" label="Tipo" rules={[{ required: true }]}>
            <Select options={TENANT_KINDS.map((k) => ({ value: k, label: TENANT_KIND_LABELS[k] }))} />
          </Form.Item>
          <Form.Item name="document" label="CNPJ (opcional)">
            <Input />
          </Form.Item>
          <Form.Item name={['admin', 'fullName']} label="Administrador — nome" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name={['admin', 'email']} label="Administrador — e-mail" rules={[{ required: true, type: 'email' }]}>
            <Input />
          </Form.Item>
          <Form.Item name={['admin', 'password']} label="Senha inicial" extra="Mínimo 10 caracteres, com maiúscula, minúscula e número." rules={[{ required: true, min: 10 }]}>
            <Input.Password />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
