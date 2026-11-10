import { CheckCircleOutlined, CopyOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Input, Modal, Select, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { LegalNotice } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDateTime } from '../../lib/format';

interface RuleRow {
  id: string;
  code: string;
  version: number;
  name: string;
  purpose: 'presence' | 'approval';
  legal_basis: string;
  status: 'draft' | 'approved' | 'retired';
  description: string;
  approved_by_name: string | null;
  approved_at: string | null;
  approval_notes: string | null;
}

export function RulesTab({ condoId, legalRegime }: { condoId: string; legalRegime: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const { message } = App.useApp();
  const [tpl, setTpl] = useState<string>();
  const [approveRule, setApproveRule] = useState<RuleRow | null>(null);
  const [notes, setNotes] = useState('');
  const rules = useQuery({ queryKey: ['rules', condoId], queryFn: () => api<RuleRow[]>(`/condominiums/${condoId}/rules`) });
  const templates = useQuery({
    queryKey: ['rule-templates'],
    queryFn: () => api<{ code: string; name: string; description: string; legalBasis: string }[]>('/rule-templates'),
    enabled: can('rules.manage'),
  });
  const inv = () => qc.invalidateQueries({ queryKey: ['rules', condoId] });

  const fromTpl = useMutation({
    mutationFn: (code: string) => api(`/condominiums/${condoId}/rules/from-template`, { method: 'POST', body: { templateCode: code } }),
    onSuccess: () => {
      message.success('Regra criada como rascunho. Revise e homologue.');
      setTpl(undefined);
      inv();
    },
    onError: (e) => message.error(errorMessage(e)),
  });
  const approve = useMutation({
    mutationFn: () => api(`/rules/${approveRule!.id}/approve`, { method: 'POST', body: { notes } }),
    onSuccess: () => {
      message.success('Regra homologada (agora imutável)');
      setApproveRule(null);
      setNotes('');
      inv();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const tplOptions = (templates.data ?? [])
    .filter((t) => (legalRegime === 'associacao' ? t.code.startsWith('ASSOC-') : !t.code.startsWith('ASSOC-')))
    .map((t) => ({ value: t.code, label: `${t.name} — ${t.legalBasis}` }));

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <LegalNotice />
      <Card
        title="Regras de quórum e aprovação (versionadas)"
        extra={
          can('rules.manage') && (
            <Space.Compact>
              <Select placeholder="Copiar de modelo legal…" value={tpl} onChange={setTpl} options={tplOptions} style={{ width: 340 }} aria-label="Modelo de regra" />
              <Button icon={<CopyOutlined />} disabled={!tpl} loading={fromTpl.isPending} onClick={() => tpl && fromTpl.mutate(tpl)}>
                Criar rascunho
              </Button>
            </Space.Compact>
          )
        }
      >
        <Table
          rowKey="id"
          loading={rules.isLoading}
          dataSource={rules.data}
          scroll={{ x: true }}
          expandable={{
            expandedRowRender: (r) => (
              <Space direction="vertical">
                <Typography.Text><b>Fórmula:</b> {r.description}</Typography.Text>
                <Typography.Text><b>Base normativa:</b> {r.legal_basis}</Typography.Text>
                {r.approval_notes && <Typography.Text><b>Homologação:</b> {r.approval_notes} — {r.approved_by_name}, {fmtDateTime(r.approved_at)}</Typography.Text>}
              </Space>
            ),
          }}
          columns={[
            { title: 'Código', dataIndex: 'code', render: (c: string, r: RuleRow) => <span className="mono">{c} v{r.version}</span> },
            { title: 'Nome', dataIndex: 'name' },
            { title: 'Finalidade', dataIndex: 'purpose', render: (p: string) => (p === 'presence' ? 'Presença / instalação' : 'Aprovação') },
            {
              title: 'Situação',
              dataIndex: 'status',
              render: (s: string) => <Tag color={s === 'approved' ? 'green' : s === 'draft' ? 'gold' : 'default'}>{s === 'approved' ? 'Homologada' : s === 'draft' ? 'Rascunho' : 'Retirada'}</Tag>,
            },
            {
              title: 'Ações',
              key: 'a',
              render: (_: unknown, r: RuleRow) =>
                r.status === 'draft' && can('rules.approve') ? (
                  <Button size="small" type="primary" icon={<CheckCircleOutlined />} onClick={() => setApproveRule(r)}>Homologar</Button>
                ) : null,
            },
          ]}
        />
      </Card>
      <Modal
        title={`Homologar ${approveRule?.code} v${approveRule?.version}`}
        open={!!approveRule}
        onCancel={() => setApproveRule(null)}
        onOk={() => approve.mutate()}
        okText="Homologar"
        okButtonProps={{ disabled: notes.trim().length < 5 }}
        confirmLoading={approve.isPending}
      >
        <Typography.Paragraph>{approveRule?.description}</Typography.Paragraph>
        <Typography.Paragraph type="warning">Após homologada, a regra não pode ser alterada — apenas substituída por nova versão.</Typography.Paragraph>
        <Input.TextArea rows={3} placeholder="Fundamento: dispositivo da convenção, parecer jurídico, responsável…" value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="Fundamento da homologação" />
      </Modal>
    </Space>
  );
}
