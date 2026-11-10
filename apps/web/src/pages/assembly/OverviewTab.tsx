import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Col, Descriptions, Form, Input, Modal, Radio, Row, Select, Space, Table, Timeline, Typography } from 'antd';
import { useState } from 'react';
import { ASSEMBLY_STATUS_LABELS, ASSEMBLY_TRANSITIONS, type AssemblyStatus } from '@lsg/shared';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDateTime } from '../../lib/format';
import { QuorumPanel } from './QuorumPanel';
import type { AssemblyDetail } from './types';

const CONDUCT: AssemblyStatus[] = ['accreditation', 'in_progress', 'suspended', 'closed', 'in_conference', 'archived'];
const ACTION_LABELS: Partial<Record<AssemblyStatus, string>> = {
  in_review: 'Enviar para revisão',
  draft: 'Voltar para rascunho',
  approved_for_call: 'Aprovar para convocação',
  called: 'Registrar convocação',
  accreditation: 'Abrir credenciamento',
  in_progress: 'Iniciar / retomar sessão',
  suspended: 'Suspender sessão',
  closed: 'Encerrar assembleia',
  in_conference: 'Enviar para conferência',
  archived: 'Arquivar',
  cancelled: 'Cancelar assembleia',
};
const NEEDS_REASON: AssemblyStatus[] = ['suspended', 'cancelled'];

export function OverviewTab({ a }: { a: AssemblyDetail }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const { message } = App.useApp();
  const [target, setTarget] = useState<AssemblyStatus | null>(null);
  const [reason, setReason] = useState('');
  const [callNumber, setCallNumber] = useState<1 | 2>(1);
  const [homOpen, setHomOpen] = useState(false);
  const [hForm] = Form.useForm();
  const rules = useQuery({
    queryKey: ['rules', a.condominium_id],
    queryFn: () => api<{ id: string; code: string; version: number; name: string; purpose: string; status: string }[]>(`/condominiums/${a.condominium_id}/rules`),
    enabled: homOpen,
  });
  const inv = () => qc.invalidateQueries({ queryKey: ['assembly', a.id] });

  const transition = useMutation({
    mutationFn: () => api(`/assemblies/${a.id}/transition`, { method: 'POST', body: { to: target, reason: reason || undefined, callNumber } }),
    onSuccess: () => {
      message.success(`Situação: ${ASSEMBLY_STATUS_LABELS[target!]}`);
      setTarget(null);
      setReason('');
      inv();
    },
    onError: (e) => message.error(errorMessage(e)),
  });
  const homologate = useMutation({
    mutationFn: (v: object) => api(`/assemblies/${a.id}/homologate`, { method: 'POST', body: v }),
    onSuccess: () => {
      message.success('Regras homologadas para a assembleia');
      setHomOpen(false);
      inv();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const allowed = ASSEMBLY_TRANSITIONS[a.status].filter((t) => (CONDUCT.includes(t) ? can('assembly.conduct') : can('assembly.manage')));
  const presenceRules = (rules.data ?? []).filter((r) => r.purpose === 'presence' && r.status === 'approved');

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} xl={14}>
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <Card title="Condução do fluxo">
            <Space wrap>
              {allowed.length === 0 && <Typography.Text type="secondary">Nenhuma ação disponível para o seu perfil neste estado.</Typography.Text>}
              {allowed.map((t) => (
                <Button key={t} type={t === 'cancelled' ? 'default' : 'primary'} danger={t === 'cancelled'} onClick={() => setTarget(t)}>
                  {ACTION_LABELS[t] ?? t}
                </Button>
              ))}
              {can('assembly.homologate') && ['draft', 'in_review', 'approved_for_call', 'called', 'accreditation'].includes(a.status) && (
                <Button onClick={() => setHomOpen(true)}>Homologar regras</Button>
              )}
            </Space>
          </Card>
          <Card title="Regras homologadas">
            {a.rules_homologated_at ? (
              <Descriptions size="small" column={1}>
                <Descriptions.Item label="Homologadas em">{fmtDateTime(a.rules_homologated_at)}</Descriptions.Item>
                <Descriptions.Item label="Fundamento">{a.rules_homologation_notes}</Descriptions.Item>
                <Descriptions.Item label="Presença 1ª convocação">{a.firstCallRule ? `${a.firstCallRule.code} v${a.firstCallRule.version} — ${a.firstCallRule.name}` : 'Não definida'}</Descriptions.Item>
                <Descriptions.Item label="Presença 2ª convocação">{a.secondCallRule ? `${a.secondCallRule.code} v${a.secondCallRule.version} — ${a.secondCallRule.name}` : 'Não definida'}</Descriptions.Item>
              </Descriptions>
            ) : (
              <Alert type="warning" showIcon message="Regras ainda não homologadas — a assembleia não pode ser convocada nem iniciada." />
            )}
          </Card>
          <Card title="Sessões">
            <Table
              size="small"
              rowKey="id"
              pagination={false}
              dataSource={a.sessions}
              locale={{ emptyText: 'Nenhuma sessão iniciada' }}
              columns={[
                { title: '#', dataIndex: 'seq' },
                { title: 'Convocação', dataIndex: 'call_number', render: (c: number) => `${c}ª` },
                { title: 'Início', dataIndex: 'started_at', render: fmtDateTime },
                { title: 'Término', dataIndex: 'ended_at', render: fmtDateTime },
                { title: 'Motivo', dataIndex: 'end_reason' },
              ]}
            />
          </Card>
        </Space>
      </Col>
      <Col xs={24} xl={10}>
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <QuorumPanel assemblyId={a.id} />
          <Card title="Histórico de estados">
            <Timeline
              items={a.history.map((h) => ({
                children: (
                  <span>
                    {fmtDateTime(h.at)} — {h.from_status ? `${ASSEMBLY_STATUS_LABELS[h.from_status as AssemblyStatus]} → ` : ''}
                    <b>{ASSEMBLY_STATUS_LABELS[h.to_status as AssemblyStatus]}</b>
                    {h.actor ? ` (${h.actor})` : ''}
                    {h.reason ? ` — ${h.reason}` : ''}
                  </span>
                ),
              }))}
            />
          </Card>
        </Space>
      </Col>

      <Modal
        title={target ? ACTION_LABELS[target] : ''}
        open={!!target}
        onCancel={() => setTarget(null)}
        onOk={() => transition.mutate()}
        okText="Confirmar"
        okButtonProps={{ danger: target === 'cancelled' || target === 'closed', disabled: !!target && NEEDS_REASON.includes(target) && reason.trim().length < 5 }}
        confirmLoading={transition.isPending}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          {target === 'in_progress' && (
            <Radio.Group value={callNumber} onChange={(e) => setCallNumber(e.target.value)}>
              <Radio value={1}>1ª convocação</Radio>
              <Radio value={2} disabled={!a.second_call_at}>2ª convocação</Radio>
            </Radio.Group>
          )}
          {(target === 'closed' || target === 'cancelled') && <Alert type="warning" showIcon message="Ação irreversível." />}
          <Input.TextArea rows={3} placeholder={NEEDS_REASON.includes(target!) ? 'Justificativa (obrigatória)' : 'Observação (opcional)'} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Space>
      </Modal>

      <Modal title="Homologar regras da assembleia" open={homOpen} onCancel={() => setHomOpen(false)} onOk={() => hForm.submit()} confirmLoading={homologate.isPending} okText="Homologar">
        <Form
          form={hForm}
          layout="vertical"
          initialValues={{ firstCallPresenceRuleId: a.first_call_presence_rule_id, secondCallPresenceRuleId: a.second_call_presence_rule_id }}
          onFinish={(v) => homologate.mutate({ firstCallPresenceRuleId: v.firstCallPresenceRuleId ?? null, secondCallPresenceRuleId: v.secondCallPresenceRuleId ?? null, notes: v.notes })}
        >
          <Form.Item name="firstCallPresenceRuleId" label="Quórum de presença — 1ª convocação">
            <Select allowClear options={presenceRules.map((r) => ({ value: r.id, label: `${r.code} v${r.version} — ${r.name}` }))} />
          </Form.Item>
          <Form.Item name="secondCallPresenceRuleId" label="Quórum de presença — 2ª convocação">
            <Select allowClear disabled={!a.second_call_at} options={presenceRules.map((r) => ({ value: r.id, label: `${r.code} v${r.version} — ${r.name}` }))} />
          </Form.Item>
          <Form.Item name="notes" label="Fundamento / responsável pela validação" rules={[{ required: true, min: 5 }]}>
            <Input.TextArea rows={3} />
          </Form.Item>
          <Typography.Text type="secondary">Somente regras já homologadas no condomínio podem ser selecionadas. As regras de aprovação são definidas em cada votação.</Typography.Text>
        </Form>
      </Modal>
    </Row>
  );
}
