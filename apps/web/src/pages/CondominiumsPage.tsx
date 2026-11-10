import { PlusOutlined } from '@ant-design/icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Form, Input, Modal, Select, Table, Tag } from 'antd';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router-dom';
import { CONDOMINIUM_TYPES, CondominiumCreateSchema, LEGAL_REGIMES } from '@lsg/shared';
import { z } from 'zod';
import { PageHeader, QueryState } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { CONDO_TYPE_LABELS, REGIME_LABELS, fmtFraction } from '../lib/format';

interface Condo {
  id: string;
  name: string;
  type: string;
  legal_regime: string;
  units: number;
  fraction_sum: string;
  status: string;
}

type CondoForm = z.input<typeof CondominiumCreateSchema>;

export function CondominiumsPage() {
  const { can, tenantId } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { message } = App.useApp();
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ['condos', tenantId], queryFn: () => api<Condo[]>('/condominiums') });
  const { control, handleSubmit, reset, formState } = useForm<CondoForm>({
    resolver: zodResolver(CondominiumCreateSchema),
    defaultValues: { name: '', type: 'residencial_vertical', legalRegime: 'condominio_edilicio', timezone: 'America/Sao_Paulo', address: {}, settings: {} },
  });
  const create = useMutation({
    mutationFn: (v: object) => api<{ id: string }>('/condominiums', { method: 'POST', body: v }),
    onSuccess: (r) => {
      message.success('Condomínio cadastrado');
      setOpen(false);
      reset();
      qc.invalidateQueries({ queryKey: ['condos'] });
      nav(`/condominios/${r.id}`);
    },
    onError: (e) => message.error(errorMessage(e)),
  });
  const err = (k: keyof CondoForm) => (formState.errors[k] ? { validateStatus: 'error' as const, help: String(formState.errors[k]?.message ?? '') } : {});

  return (
    <>
      <PageHeader
        title="Condomínios"
        subtitle="Empreendimentos do cliente selecionado"
        extra={can('condo.manage') && <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>Novo condomínio</Button>}
      />
      <Card>
        <QueryState loading={q.isLoading} error={q.error}>
          <Table
            rowKey="id"
            dataSource={q.data}
            scroll={{ x: true }}
            columns={[
              { title: 'Nome', dataIndex: 'name', render: (n: string, r: Condo) => <Link to={`/condominios/${r.id}`}>{n}</Link> },
              { title: 'Tipo', dataIndex: 'type', render: (t: string) => CONDO_TYPE_LABELS[t] ?? t },
              { title: 'Regime', dataIndex: 'legal_regime', render: (t: string) => REGIME_LABELS[t] ?? t },
              { title: 'Unidades', dataIndex: 'units' },
              {
                title: 'Soma das frações',
                dataIndex: 'fraction_sum',
                render: (f: string) => <Tag color={Math.abs(Number(f) - 1) < 1e-6 ? 'green' : 'orange'}>{fmtFraction(f)}</Tag>,
              },
            ]}
          />
        </QueryState>
      </Card>
      <Modal title="Novo condomínio" open={open} onCancel={() => setOpen(false)} onOk={handleSubmit((v) => create.mutate(v))} okText="Cadastrar" confirmLoading={create.isPending}>
        <Form layout="vertical">
          <Form.Item label="Nome" required {...err('name')}>
            <Controller name="name" control={control} render={({ field }) => <Input {...field} />} />
          </Form.Item>
          <Form.Item label="CNPJ (opcional)" {...err('document')}>
            <Controller name="document" control={control} render={({ field }) => <Input {...field} value={field.value ?? ''} onChange={(e) => field.onChange(e.target.value || undefined)} />} />
          </Form.Item>
          <Form.Item label="Tipo" required>
            <Controller name="type" control={control} render={({ field }) => <Select {...field} options={CONDOMINIUM_TYPES.map((t) => ({ value: t, label: CONDO_TYPE_LABELS[t] }))} />} />
          </Form.Item>
          <Form.Item label="Regime jurídico" required extra="Associações utilizam perfil de regras próprio; regras de condomínio edilício não são aplicadas automaticamente.">
            <Controller name="legalRegime" control={control} render={({ field }) => <Select {...field} options={LEGAL_REGIMES.map((t) => ({ value: t, label: REGIME_LABELS[t] }))} />} />
          </Form.Item>
          <Form.Item label="Fuso horário">
            <Controller name="timezone" control={control} render={({ field }) => <Input {...field} />} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
