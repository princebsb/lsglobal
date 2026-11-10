import { EyeOutlined, LinkOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Checkbox, Form, Input, Modal, Select, Space, Table, Tag } from 'antd';
import { useState } from 'react';
import { OWNERSHIP_RELATIONS } from '@lsg/shared';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { RELATION_LABELS } from '../../lib/format';

interface PersonRow {
  id: string;
  kind: string;
  name: string;
  document: string;
  email: string | null;
  has_user: boolean;
  units: { ownershipId: string; unitId: string; unit: string; relation: string; isVotingRepresentative: boolean; condominiumId: string }[];
}

export function PeopleTab({ condoId }: { condoId: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const { message, modal } = App.useApp();
  const [search, setSearch] = useState('');
  const [personOpen, setPersonOpen] = useState(false);
  const [linkFor, setLinkFor] = useState<PersonRow | null>(null);
  const [pForm] = Form.useForm();
  const [lForm] = Form.useForm();
  const people = useQuery({
    queryKey: ['people', condoId, search],
    queryFn: () => api<PersonRow[]>(`/people?condominiumId=${condoId}${search ? `&search=${encodeURIComponent(search)}` : ''}`),
  });
  const units = useQuery({ queryKey: ['units', condoId], queryFn: () => api<{ id: string; identifier: string; building_name: string | null }[]>(`/condominiums/${condoId}/units`) });
  const inv = () => {
    qc.invalidateQueries({ queryKey: ['people'] });
    qc.invalidateQueries({ queryKey: ['units', condoId] });
  };

  const createPerson = useMutation({
    mutationFn: (v: object) => api<{ id: string }>('/people', { method: 'POST', body: v }),
    onSuccess: () => {
      message.success('Pessoa cadastrada. Vincule-a a uma unidade.');
      setPersonOpen(false);
      pForm.resetFields();
      inv();
    },
    onError: (e) => message.error(errorMessage(e)),
  });
  const link = useMutation({
    mutationFn: (v: object) => api('/people/ownerships', { method: 'POST', body: v }),
    onSuccess: () => {
      message.success('Vínculo registrado');
      setLinkFor(null);
      lForm.resetFields();
      inv();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const reveal = async (p: PersonRow) => {
    try {
      const r = await api<{ document: string }>(`/people/${p.id}/document`);
      modal.info({ title: p.name, content: <span>Documento: <b className="mono">{r.document}</b><br />Esta consulta foi registrada na auditoria.</span> });
    } catch (e) {
      message.error(errorMessage(e));
    }
  };

  return (
    <Card
      title="Condôminos e representantes"
      extra={
        <Space wrap>
          <Input.Search placeholder="Nome ou CPF/CNPJ" allowClear onSearch={setSearch} style={{ width: 240 }} aria-label="Buscar pessoa" />
          {can('people.manage') && <Button type="primary" icon={<PlusOutlined />} onClick={() => setPersonOpen(true)}>Nova pessoa</Button>}
        </Space>
      }
    >
      <Table
        rowKey="id"
        loading={people.isLoading}
        dataSource={people.data}
        scroll={{ x: true }}
        columns={[
          { title: 'Nome', dataIndex: 'name' },
          { title: 'Documento', dataIndex: 'document', render: (d: string) => <span className="mono">{d}</span> },
          { title: 'E-mail', dataIndex: 'email', render: (e) => e ?? '—' },
          {
            title: 'Unidades',
            dataIndex: 'units',
            render: (us: PersonRow['units']) =>
              us.length === 0 ? <Tag>sem vínculo</Tag> : us.filter((u) => u.condominiumId === condoId).map((u) => (
                <Tag key={u.ownershipId} color={u.isVotingRepresentative ? 'blue' : 'default'}>
                  {u.unit} · {RELATION_LABELS[u.relation] ?? u.relation}
                </Tag>
              )),
          },
          { title: 'Acesso', dataIndex: 'has_user', render: (h: boolean) => (h ? <Tag color="green">usuário</Tag> : '—') },
          {
            title: 'Ações',
            key: 'a',
            render: (_: unknown, p: PersonRow) => (
              <Space>
                {can('people.manage') && <Button size="small" icon={<LinkOutlined />} onClick={() => setLinkFor(p)}>Vincular unidade</Button>}
                {can('people.view_sensitive') && <Button size="small" icon={<EyeOutlined />} onClick={() => reveal(p)} aria-label="Revelar documento" />}
              </Space>
            ),
          },
        ]}
      />
      <Modal title="Nova pessoa" open={personOpen} onCancel={() => setPersonOpen(false)} onOk={() => pForm.submit()} confirmLoading={createPerson.isPending}>
        <Form form={pForm} layout="vertical" onFinish={(v) => createPerson.mutate({ ...v, email: v.email || undefined, phone: v.phone || undefined })} initialValues={{ kind: 'pf' }}>
          <Form.Item name="kind" label="Tipo">
            <Select options={[{ value: 'pf', label: 'Pessoa física' }, { value: 'pj', label: 'Pessoa jurídica' }]} />
          </Form.Item>
          <Form.Item name="name" label="Nome / razão social" rules={[{ required: true, min: 2 }]}><Input /></Form.Item>
          <Form.Item name="document" label="CPF / CNPJ" rules={[{ required: true }]} extra="Armazenado criptografado; exibido mascarado."><Input /></Form.Item>
          <Form.Item name="email" label="E-mail"><Input type="email" /></Form.Item>
          <Form.Item name="phone" label="Telefone"><Input /></Form.Item>
        </Form>
      </Modal>
      <Modal title={`Vincular ${linkFor?.name ?? ''} a uma unidade`} open={!!linkFor} onCancel={() => setLinkFor(null)} onOk={() => lForm.submit()} confirmLoading={link.isPending}>
        <Form form={lForm} layout="vertical" onFinish={(v) => link.mutate({ ...v, personId: linkFor?.id })} initialValues={{ relation: 'proprietario', isVotingRepresentative: false }}>
          <Form.Item name="unitId" label="Unidade" rules={[{ required: true }]}>
            <Select showSearch optionFilterProp="label" options={units.data?.map((u) => ({ value: u.id, label: `${u.building_name ? u.building_name + ' - ' : ''}${u.identifier}` }))} />
          </Form.Item>
          <Form.Item name="relation" label="Vínculo">
            <Select options={OWNERSHIP_RELATIONS.map((r) => ({ value: r, label: RELATION_LABELS[r] }))} />
          </Form.Item>
          <Form.Item name="isVotingRepresentative" valuePropName="checked" extra="Em unidades com vários titulares, apenas o representante designado vota pela unidade.">
            <Checkbox>Representante votante da unidade</Checkbox>
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
