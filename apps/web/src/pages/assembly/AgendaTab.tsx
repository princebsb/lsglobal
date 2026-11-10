import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Checkbox, Form, Input, InputNumber, List, Modal, Select, Space, Tag, Typography } from 'antd';
import { useState } from 'react';
import { Controller, useFieldArray, useForm } from 'react-hook-form';
import { BALLOT_TYPES, BallotCreateSchema } from '@lsg/shared';
import { z } from 'zod';
import { BallotStatusTag, OutcomeTag } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { BALLOT_TYPE_LABELS } from '../../lib/format';
import type { AssemblyDetail } from './types';

type BallotForm = z.input<typeof BallotCreateSchema>;

export function AgendaTab({ a }: { a: AssemblyDetail }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const { message, modal } = App.useApp();
  const [itemForm] = Form.useForm();
  const [ballotFor, setBallotFor] = useState<string | null>(null);
  const editableAgenda = ['draft', 'in_review', 'approved_for_call'].includes(a.status) && can('assembly.manage');
  const canCreateBallot = (can('assembly.manage') || can('assembly.conduct')) && !['closed', 'in_conference', 'archived', 'cancelled'].includes(a.status);
  const rules = useQuery({
    queryKey: ['rules', a.condominium_id],
    queryFn: () => api<{ id: string; code: string; version: number; name: string; purpose: string; status: string; description: string }[]>(`/condominiums/${a.condominium_id}/rules`),
    enabled: !!ballotFor,
  });
  const inv = () => qc.invalidateQueries({ queryKey: ['assembly', a.id] });

  const addItem = useMutation({
    mutationFn: (v: object) => api(`/assemblies/${a.id}/agenda`, { method: 'POST', body: v }),
    onSuccess: () => {
      itemForm.resetFields();
      inv();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const { control, handleSubmit, watch, reset, formState } = useForm<BallotForm>({
    resolver: zodResolver(BallotCreateSchema),
    defaultValues: { ballotType: 'yes_no', secrecy: 'nominal', maxChoices: 1, seats: 1, includeAbstention: true, includeBlank: false, includeNull: false, allowVoteChange: false, showPartialResults: false, options: [] },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'options' });
  const type = watch('ballotType');
  const createBallot = useMutation({
    mutationFn: (v: object) => api(`/assemblies/${a.id}/ballots`, { method: 'POST', body: v }),
    onSuccess: () => {
      message.success('Votação preparada');
      setBallotFor(null);
      reset();
      inv();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const openBallot = (itemId: string) => {
    reset({ agendaItemId: itemId, ballotType: 'yes_no', secrecy: 'nominal', maxChoices: 1, seats: 1, includeAbstention: true, includeBlank: false, includeNull: false, allowVoteChange: false, showPartialResults: false, options: [], title: '', question: '' });
    setBallotFor(itemId);
  };

  const approvalRules = (rules.data ?? []).filter((r) => r.purpose === 'approval' && r.status === 'approved');
  const errs = formState.errors;

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Card title="Pauta">
        <List
          dataSource={a.agenda}
          locale={{ emptyText: 'Pauta vazia' }}
          renderItem={(item) => {
            const ballots = a.ballots.filter((b) => b.agenda_item_id === item.id);
            return (
              <List.Item
                actions={[
                  canCreateBallot && item.item_type === 'deliberativo' && !ballots.some((b) => b.status !== 'cancelled') ? (
                    <Button key="b" size="small" onClick={() => openBallot(item.id)}>Configurar votação</Button>
                  ) : null,
                  editableAgenda && ballots.length === 0 ? (
                    <Button
                      key="d"
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      aria-label="Remover item"
                      onClick={() =>
                        modal.confirm({
                          title: 'Remover item da pauta?',
                          onOk: () => api(`/assemblies/${a.id}/agenda/${item.id}`, { method: 'DELETE' }).then(inv).catch((e) => message.error(errorMessage(e))),
                        })
                      }
                    />
                  ) : null,
                ].filter(Boolean)}
              >
                <List.Item.Meta
                  title={
                    <Space wrap>
                      <span>{item.position}. {item.title}</span>
                      <Tag>{item.item_type}</Tag>
                    </Space>
                  }
                  description={
                    <Space direction="vertical" style={{ width: '100%' }}>
                      {item.description && <Typography.Text type="secondary">{item.description}</Typography.Text>}
                      {ballots.map((b) => (
                        <Space key={b.id} wrap>
                          <Typography.Text strong>Votação{b.round > 1 ? ` (rodada ${b.round})` : ''}:</Typography.Text>
                          <span>{b.title}</span>
                          <Tag>{BALLOT_TYPE_LABELS[b.ballot_type]}</Tag>
                          {b.secrecy === 'secret' && <Tag color="purple">sigilosa</Tag>}
                          <Tag>regra {b.approval_rule_code} v{b.approval_rule_version}</Tag>
                          <BallotStatusTag status={b.status} />
                          {b.declared_outcome && <OutcomeTag outcome={b.declared_outcome} />}
                          {b.cancel_reason && <Typography.Text type="danger">Cancelada: {b.cancel_reason}</Typography.Text>}
                        </Space>
                      ))}
                    </Space>
                  }
                />
              </List.Item>
            );
          }}
        />
        {editableAgenda && (
          <Form form={itemForm} layout="inline" onFinish={(v) => addItem.mutate(v)} style={{ marginTop: 16, rowGap: 8 }}>
            <Form.Item name="title" rules={[{ required: true, min: 3 }]}><Input placeholder="Novo item de pauta" style={{ width: 320 }} /></Form.Item>
            <Form.Item name="itemType" initialValue="deliberativo">
              <Select options={[{ value: 'deliberativo', label: 'Deliberativo' }, { value: 'informativo', label: 'Informativo' }]} style={{ width: 150 }} />
            </Form.Item>
            <Form.Item name="description"><Input placeholder="Descrição (opcional)" style={{ width: 280 }} /></Form.Item>
            <Button htmlType="submit" icon={<PlusOutlined />} loading={addItem.isPending}>Adicionar</Button>
          </Form>
        )}
      </Card>

      <Modal title="Configurar votação" open={!!ballotFor} onCancel={() => setBallotFor(null)} onOk={handleSubmit((v) => createBallot.mutate(v))} confirmLoading={createBallot.isPending} width={680} okText="Preparar votação">
        <Form layout="vertical">
          <Form.Item label="Título" required validateStatus={errs.title ? 'error' : ''} help={errs.title?.message}>
            <Controller name="title" control={control} render={({ field }) => <Input {...field} />} />
          </Form.Item>
          <Form.Item label="Texto integral da deliberação" required validateStatus={errs.question ? 'error' : ''} help={errs.question?.message}>
            <Controller name="question" control={control} render={({ field }) => <Input.TextArea rows={3} {...field} />} />
          </Form.Item>
          <Space wrap>
            <Form.Item label="Tipo">
              <Controller name="ballotType" control={control} render={({ field }) => <Select {...field} style={{ width: 200 }} options={BALLOT_TYPES.map((t) => ({ value: t, label: BALLOT_TYPE_LABELS[t] }))} />} />
            </Form.Item>
            <Form.Item label="Sigilo" validateStatus={errs.allowVoteChange ? 'error' : ''} help={errs.allowVoteChange?.message}>
              <Controller name="secrecy" control={control} render={({ field }) => <Select {...field} style={{ width: 160 }} options={[{ value: 'nominal', label: 'Nominal' }, { value: 'secret', label: 'Sigilosa' }]} />} />
            </Form.Item>
            {type === 'multiple_choice' && (
              <Form.Item label="Máx. escolhas">
                <Controller name="maxChoices" control={control} render={({ field }) => <InputNumber min={1} {...field} />} />
              </Form.Item>
            )}
            {type !== 'yes_no' && (
              <Form.Item label="Vagas / vencedores">
                <Controller name="seats" control={control} render={({ field }) => <InputNumber min={1} {...field} />} />
              </Form.Item>
            )}
          </Space>
          <Form.Item label="Regra de aprovação (homologada)" required validateStatus={errs.approvalRuleId ? 'error' : ''} help={errs.approvalRuleId?.message}>
            <Controller
              name="approvalRuleId"
              control={control}
              render={({ field }) => <Select {...field} options={approvalRules.map((r) => ({ value: r.id, label: `${r.code} v${r.version} — ${r.description}` }))} />}
            />
          </Form.Item>
          {type !== 'yes_no' && (
            <Form.Item label="Opções / candidatos / chapas" validateStatus={errs.options ? 'error' : ''} help={errs.options?.message as string | undefined}>
              <Space direction="vertical" style={{ width: '100%' }}>
                {fields.map((f, i) => (
                  <Space.Compact key={f.id} style={{ width: '100%' }}>
                    <Controller name={`options.${i}.label`} control={control} render={({ field }) => <Input {...field} placeholder={`Opção ${i + 1}`} />} />
                    <Button icon={<DeleteOutlined />} onClick={() => remove(i)} aria-label="Remover opção" />
                  </Space.Compact>
                ))}
                <Button icon={<PlusOutlined />} onClick={() => append({ label: '', kind: 'regular' })}>Adicionar opção</Button>
              </Space>
            </Form.Item>
          )}
          <Space wrap>
            <Controller name="includeAbstention" control={control} render={({ field }) => <Checkbox checked={field.value} onChange={(e) => field.onChange(e.target.checked)}>Abstenção</Checkbox>} />
            <Controller name="includeBlank" control={control} render={({ field }) => <Checkbox checked={field.value} onChange={(e) => field.onChange(e.target.checked)}>Voto em branco</Checkbox>} />
            <Controller name="includeNull" control={control} render={({ field }) => <Checkbox checked={field.value} onChange={(e) => field.onChange(e.target.checked)}>Voto nulo</Checkbox>} />
            <Controller name="allowVoteChange" control={control} render={({ field }) => <Checkbox checked={field.value} onChange={(e) => field.onChange(e.target.checked)}>Permitir substituição do voto até o encerramento</Checkbox>} />
            <Controller name="showPartialResults" control={control} render={({ field }) => <Checkbox checked={field.value} onChange={(e) => field.onChange(e.target.checked)}>Exibir parcial aos participantes</Checkbox>} />
          </Space>
        </Form>
      </Modal>
    </Space>
  );
}
