import { PlusOutlined } from '@ant-design/icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, DatePicker, Form, Input, Modal, Select, Switch, Table } from 'antd';
import dayjs from 'dayjs';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router-dom';
import { ASSEMBLY_KINDS, ASSEMBLY_MODALITIES, AssemblyCreateSchema, type AssemblyStatus } from '@lsg/shared';
import { z } from 'zod';
import { AssemblyStatusTag, PageHeader, QueryState } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { KIND_LABELS, MODALITY_LABELS, fmtDateTime } from '../lib/format';

interface AssemblyRow {
  id: string;
  code: string;
  title: string;
  kind: string;
  modality: string;
  status: AssemblyStatus;
  first_call_at: string;
  condominium_name: string;
  accredited: number;
}

type AsmForm = z.input<typeof AssemblyCreateSchema>;

export function AssembliesPage() {
  const { can, tenantId } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { message } = App.useApp();
  const [open, setOpen] = useState(false);
  const list = useQuery({ queryKey: ['assemblies', tenantId], queryFn: () => api<AssemblyRow[]>('/assemblies') });
  const condos = useQuery({ queryKey: ['condos', tenantId], queryFn: () => api<{ id: string; name: string }[]>('/condominiums'), enabled: open });
  const { control, handleSubmit, formState, reset } = useForm<AsmForm>({
    resolver: zodResolver(AssemblyCreateSchema),
    defaultValues: { kind: 'AGE', modality: 'hibrida', permanentSession: false, title: '' },
  });
  const create = useMutation({
    mutationFn: (v: object) => api<{ id: string }>('/assemblies', { method: 'POST', body: v }),
    onSuccess: (r) => {
      message.success('Assembleia criada em rascunho');
      setOpen(false);
      reset();
      qc.invalidateQueries({ queryKey: ['assemblies'] });
      nav(`/assembleias/${r.id}`);
    },
    onError: (e) => message.error(errorMessage(e)),
  });
  const e = (k: keyof AsmForm) => (formState.errors[k] ? { validateStatus: 'error' as const, help: String(formState.errors[k]?.message ?? '') } : {});

  return (
    <>
      <PageHeader
        title="Assembleias"
        extra={can('assembly.manage') && <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>Nova assembleia</Button>}
      />
      <Card>
        <QueryState loading={list.isLoading} error={list.error}>
          <Table
            rowKey="id"
            dataSource={list.data}
            scroll={{ x: true }}
            columns={[
              { title: 'Código', dataIndex: 'code', render: (c: string, r: AssemblyRow) => <Link to={`/assembleias/${r.id}`}>{c}</Link> },
              { title: 'Título', dataIndex: 'title' },
              { title: 'Condomínio', dataIndex: 'condominium_name' },
              { title: 'Tipo', dataIndex: 'kind' },
              { title: 'Modalidade', dataIndex: 'modality', render: (m: string) => MODALITY_LABELS[m] },
              { title: '1ª convocação', dataIndex: 'first_call_at', render: fmtDateTime },
              { title: 'Credenciados', dataIndex: 'accredited' },
              { title: 'Situação', dataIndex: 'status', render: (s: AssemblyStatus) => <AssemblyStatusTag status={s} /> },
              { title: '', key: 'sala', render: (_: unknown, r: AssemblyRow) => <Link to={`/sala/${r.id}`}>Sala</Link> },
            ]}
          />
        </QueryState>
      </Card>
      <Modal title="Nova assembleia" open={open} onCancel={() => setOpen(false)} onOk={handleSubmit((v) => create.mutate(v))} okText="Criar" confirmLoading={create.isPending} width={620}>
        <Form layout="vertical">
          <Form.Item label="Condomínio" required {...e('condominiumId')}>
            <Controller name="condominiumId" control={control} render={({ field }) => <Select {...field} options={condos.data?.map((c) => ({ value: c.id, label: c.name }))} />} />
          </Form.Item>
          <Form.Item label="Título" required {...e('title')}>
            <Controller name="title" control={control} render={({ field }) => <Input {...field} />} />
          </Form.Item>
          <Form.Item label="Tipo">
            <Controller name="kind" control={control} render={({ field }) => <Select {...field} options={ASSEMBLY_KINDS.map((k) => ({ value: k, label: KIND_LABELS[k] }))} />} />
          </Form.Item>
          <Form.Item label="Modalidade">
            <Controller name="modality" control={control} render={({ field }) => <Select {...field} options={ASSEMBLY_MODALITIES.map((k) => ({ value: k, label: MODALITY_LABELS[k] }))} />} />
          </Form.Item>
          <Form.Item label="Local (presencial/híbrida)">
            <Controller name="location" control={control} render={({ field }) => <Input {...field} value={field.value ?? ''} />} />
          </Form.Item>
          <Form.Item label="1ª convocação" required {...e('firstCallAt')}>
            <Controller
              name="firstCallAt"
              control={control}
              render={({ field }) => (
                <DatePicker showTime format="DD/MM/YYYY HH:mm" value={field.value ? dayjs(field.value as Date) : null} onChange={(d) => field.onChange(d?.toDate())} />
              )}
            />
          </Form.Item>
          <Form.Item label="2ª convocação" {...e('secondCallAt')}>
            <Controller
              name="secondCallAt"
              control={control}
              render={({ field }) => (
                <DatePicker showTime format="DD/MM/YYYY HH:mm" value={field.value ? dayjs(field.value as Date) : null} onChange={(d) => field.onChange(d?.toDate())} />
              )}
            />
          </Form.Item>
          <Form.Item label="Sessão permanente (art. 1.353, §§ 1º a 4º — validar aplicabilidade)">
            <Controller name="permanentSession" control={control} render={({ field }) => <Switch checked={!!field.value} onChange={field.onChange} />} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
