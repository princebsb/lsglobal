import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Input, Modal, Radio, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { ACCREDITATION_OPEN_STATUSES } from '@lsg/shared';
import { api, errorMessage } from '../../lib/api';
import { RELATION_LABELS, fmtDateTime, fmtFraction } from '../../lib/format';
import type { AssemblyDetail } from './types';

interface Candidate {
  unit_id: string;
  unit: string;
  ideal_fraction: string;
  voting_status: string;
  accreditation_id: string | null;
  mode: string | null;
  basis: string | null;
  accredited_person: string | null;
  owners: { personId: string; name: string; document: string; relation: string; isVotingRepresentative: boolean }[];
  attorneys: { poaId: string; personId: string; name: string; document: string }[];
}

export function AccreditationTab({ a }: { a: AssemblyDetail }) {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState<'presencial' | 'remoto'>('presencial');
  const [revoking, setRevoking] = useState<Candidate | null>(null);
  const [reason, setReason] = useState('');
  const open = ACCREDITATION_OPEN_STATUSES.includes(a.status);
  const list = useQuery({
    queryKey: ['assembly', a.id, 'candidates', search],
    queryFn: () => api<Candidate[]>(`/assemblies/${a.id}/accreditation/candidates${search ? `?search=${encodeURIComponent(search)}` : ''}`),
  });
  const inv = () => qc.invalidateQueries({ queryKey: ['assembly', a.id] });

  const accredit = useMutation({
    mutationFn: (v: { unitId: string; personId: string; poaId?: string }) => api(`/assemblies/${a.id}/accreditations`, { method: 'POST', body: { ...v, mode } }),
    onSuccess: () => {
      message.success('Credenciado');
      inv();
    },
    onError: (e) => message.error(errorMessage(e)),
  });
  const revoke = useMutation({
    mutationFn: () => api(`/accreditations/${revoking!.accreditation_id}/revoke`, { method: 'POST', body: { reason } }),
    onSuccess: () => {
      message.success('Credenciamento revogado');
      setRevoking(null);
      setReason('');
      inv();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  return (
    <Card
      title="Credenciamento"
      extra={
        <Space wrap>
          <Radio.Group value={mode} onChange={(e) => setMode(e.target.value)} optionType="button" options={[{ value: 'presencial', label: 'Presencial' }, { value: 'remoto', label: 'Remoto assistido' }]} />
          <Input.Search placeholder="Unidade, bloco ou nome" allowClear onSearch={setSearch} style={{ width: 260 }} aria-label="Buscar unidade ou pessoa" />
        </Space>
      }
    >
      {!open && <Alert style={{ marginBottom: 12 }} type="info" showIcon message="O credenciamento está fechado neste estado da assembleia." />}
      <Typography.Paragraph type="secondary">
        Cada unidade admite um único representante credenciado por vez — evitando contagem duplicada quando há coproprietários ou vários dispositivos. A conferência documental é
        responsabilidade do operador.
      </Typography.Paragraph>
      <Table
        rowKey="unit_id"
        loading={list.isLoading}
        dataSource={list.data}
        scroll={{ x: true }}
        pagination={{ pageSize: 25 }}
        columns={[
          { title: 'Unidade', dataIndex: 'unit' },
          { title: 'Fração', dataIndex: 'ideal_fraction', render: fmtFraction },
          { title: 'Voto', dataIndex: 'voting_status', render: (s: string) => (s === 'eligible' ? <Tag color="green">habilitada</Tag> : <Tag color="red">restrita</Tag>) },
          {
            title: 'Situação',
            key: 's',
            render: (_: unknown, c: Candidate) =>
              c.accreditation_id ? (
                <Space direction="vertical" size={0}>
                  <Tag color="blue">Credenciada — {c.mode}</Tag>
                  <Typography.Text>{c.accredited_person} ({c.basis === 'procuracao' ? 'procuração' : 'titular'})</Typography.Text>
                </Space>
              ) : (
                <Tag>Ausente</Tag>
              ),
          },
          {
            title: 'Representantes possíveis',
            key: 'r',
            render: (_: unknown, c: Candidate) =>
              c.accreditation_id ? (
                <Button size="small" danger onClick={() => setRevoking(c)} disabled={!open}>Revogar / substituir</Button>
              ) : (
                <Space wrap>
                  {c.owners.map((o) => (
                    <Button
                      key={o.personId}
                      size="small"
                      disabled={!open || (c.owners.length > 1 && !o.isVotingRepresentative)}
                      title={c.owners.length > 1 && !o.isVotingRepresentative ? 'Coproprietário não designado como representante' : ''}
                      onClick={() => accredit.mutate({ unitId: c.unit_id, personId: o.personId })}
                    >
                      {o.name} · {RELATION_LABELS[o.relation] ?? o.relation}
                    </Button>
                  ))}
                  {c.attorneys.map((p) => (
                    <Button key={p.poaId} size="small" type="dashed" disabled={!open} onClick={() => accredit.mutate({ unitId: c.unit_id, personId: p.personId, poaId: p.poaId })}>
                      {p.name} · procurador
                    </Button>
                  ))}
                  {c.owners.length === 0 && c.attorneys.length === 0 && <Typography.Text type="secondary">Sem titular cadastrado</Typography.Text>}
                </Space>
              ),
          },
        ]}
      />
      <Modal
        title={`Revogar credenciamento — ${revoking?.unit}`}
        open={!!revoking}
        onCancel={() => setRevoking(null)}
        onOk={() => revoke.mutate()}
        okButtonProps={{ danger: true, disabled: reason.trim().length < 5 }}
        confirmLoading={revoke.isPending}
      >
        <Typography.Paragraph>Votos já registrados por este representante são preservados. Informe o motivo:</Typography.Paragraph>
        <Input.TextArea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Motivo" />
        <Typography.Text type="secondary">Registrado em {fmtDateTime(new Date())}</Typography.Text>
      </Modal>
    </Card>
  );
}
