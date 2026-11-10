import { PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Form, Input, Modal, Select, Space, Table, Tag } from 'antd';
import { useState } from 'react';
import { PageHeader } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDateTime } from '../lib/format';

interface UserRow {
  id: string;
  email: string;
  full_name: string;
  status: string;
  mfa_enabled: boolean;
  last_login_at: string | null;
  assignments: { id: string; roleCode: string; condominiumId: string | null; condominiumName: string | null }[];
}

export function UsersPage() {
  const { tenantId, me } = useAuth();
  const qc = useQueryClient();
  const { message, modal } = App.useApp();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  const role = Form.useWatch('roleCode', form);
  const condoId = Form.useWatch('condominiumId', form);
  const users = useQuery({ queryKey: ['users', tenantId], queryFn: () => api<UserRow[]>('/users') });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api<{ code: string; name: string; scope: string; requiresMfa: boolean }[]>('/users/roles') });
  const condos = useQuery({ queryKey: ['condos', tenantId], queryFn: () => api<{ id: string; name: string }[]>('/condominiums') });
  const people = useQuery({
    queryKey: ['people', condoId],
    queryFn: () => api<{ id: string; name: string; document: string; has_user: boolean }[]>(`/people?condominiumId=${condoId}`),
    enabled: !!condoId && ['condomino', 'procurador'].includes(role),
  });
  const roleName = (c: string) => roles.data?.find((r) => r.code === c)?.name ?? c;
  const scope = roles.data?.find((r) => r.code === role)?.scope;

  const create = useMutation({
    mutationFn: (v: object) => api('/users', { method: 'POST', body: v }),
    onSuccess: () => {
      message.success('Usuário/perfil registrado');
      setOpen(false);
      form.resetFields();
      qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });
  const revoke = (id: string) =>
    modal.confirm({
      title: 'Remover este perfil do usuário?',
      onOk: () => api(`/users/assignments/${id}`, { method: 'DELETE' }).then(() => qc.invalidateQueries({ queryKey: ['users'] })).catch((e) => message.error(errorMessage(e))),
    });

  return (
    <>
      <PageHeader title="Usuários e perfis" extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>Novo usuário / perfil</Button>} />
      <Card>
        <Table
          rowKey="id"
          loading={users.isLoading}
          dataSource={users.data}
          scroll={{ x: true }}
          columns={[
            { title: 'Nome', dataIndex: 'full_name' },
            { title: 'E-mail', dataIndex: 'email' },
            {
              title: 'Perfis',
              dataIndex: 'assignments',
              render: (as: UserRow['assignments']) => (
                <Space wrap>
                  {as.map((a) => (
                    <Tag key={a.id} closable={!(a.roleCode === 'tenant_admin' && users.data?.find((u) => u.assignments.includes(a))?.id === me?.user.id)} onClose={(e) => { e.preventDefault(); revoke(a.id); }}>
                      {roleName(a.roleCode)}{a.condominiumName ? ` — ${a.condominiumName}` : ''}
                    </Tag>
                  ))}
                </Space>
              ),
            },
            { title: 'MFA', dataIndex: 'mfa_enabled', render: (m: boolean) => (m ? <Tag color="green">ativo</Tag> : <Tag>inativo</Tag>) },
            { title: 'Último acesso', dataIndex: 'last_login_at', render: fmtDateTime },
          ]}
        />
      </Card>
      <Modal title="Novo usuário / atribuição de perfil" open={open} onCancel={() => setOpen(false)} onOk={() => form.submit()} confirmLoading={create.isPending}>
        <Form form={form} layout="vertical" onFinish={(v) => create.mutate(v)}>
          <Form.Item name="email" label="E-mail" rules={[{ required: true, type: 'email' }]} extra="Se o e-mail já existir, apenas o perfil será atribuído."><Input /></Form.Item>
          <Form.Item name="fullName" label="Nome completo" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="password" label="Senha inicial" rules={[{ required: true, min: 10 }]} extra="Mín. 10 caracteres com maiúscula, minúscula e número."><Input.Password /></Form.Item>
          <Form.Item name="roleCode" label="Perfil" rules={[{ required: true }]}>
            <Select options={roles.data?.map((r) => ({ value: r.code, label: `${r.name}${r.requiresMfa ? ' (exige MFA)' : ''}` }))} />
          </Form.Item>
          {scope === 'condominium' && (
            <Form.Item name="condominiumId" label="Condomínio" rules={[{ required: true }]}>
              <Select options={condos.data?.map((c) => ({ value: c.id, label: c.name }))} />
            </Form.Item>
          )}
          {['condomino', 'procurador'].includes(role) && condoId && (
            <Form.Item name="personId" label="Vincular ao cadastro de pessoa" extra="Necessário para credenciar-se e votar.">
              <Select allowClear showSearch optionFilterProp="label" options={people.data?.filter((p) => !p.has_user).map((p) => ({ value: p.id, label: `${p.name} (${p.document})` }))} />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </>
  );
}
