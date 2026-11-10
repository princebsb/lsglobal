import { PlusOutlined, UploadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Form, Input, InputNumber, Modal, Select, Space, Table, Tag, Typography, Upload } from 'antd';
import Papa from 'papaparse';
import { useState } from 'react';
import { UNIT_KINDS } from '@lsg/shared';
import { api, errorMessage } from '../../lib/api';
import { RELATION_LABELS, fmtFraction, fmtPercentOfFraction } from '../../lib/format';

interface UnitRow {
  id: string;
  identifier: string;
  kind: string;
  ideal_fraction: string;
  voting_status: 'eligible' | 'restricted';
  voting_restriction_reason: string | null;
  building_name: string | null;
  owners: { ownershipId: string; personId: string; name: string; relation: string; isVotingRepresentative: boolean; document: string }[];
}

interface ImportResult {
  applied: boolean;
  summary: { rows: number; valid: number; errors: number; warnings: number; fractionSum: string; createdPeople?: number };
  issues: { row: number; field?: string; message: string; severity: 'error' | 'warning' }[];
}

export function UnitsTab({ condoId, canManage }: { condoId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const { message, modal } = App.useApp();
  const [unitOpen, setUnitOpen] = useState(false);
  const [importRows, setImportRows] = useState<Record<string, unknown>[] | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [form] = Form.useForm();
  const units = useQuery({ queryKey: ['units', condoId], queryFn: () => api<UnitRow[]>(`/condominiums/${condoId}/units`) });
  const buildings = useQuery({ queryKey: ['buildings', condoId], queryFn: () => api<{ id: string; name: string }[]>(`/condominiums/${condoId}/buildings`) });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['units', condoId] });
    qc.invalidateQueries({ queryKey: ['condo', condoId] });
    qc.invalidateQueries({ queryKey: ['buildings', condoId] });
  };

  const createUnit = useMutation({
    mutationFn: (v: object) => api(`/condominiums/${condoId}/units`, { method: 'POST', body: v }),
    onSuccess: () => {
      message.success('Unidade cadastrada');
      setUnitOpen(false);
      form.resetFields();
      invalidate();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const runImport = async (dryRun: boolean) => {
    try {
      const r = await api<ImportResult>(`/condominiums/${condoId}/units/import`, { method: 'POST', body: { rows: importRows, dryRun } });
      setImportResult(r);
      if (r.applied) {
        message.success(`Importação concluída: ${r.summary.valid} unidade(s)`);
        setImportRows(null);
        invalidate();
      }
    } catch (e) {
      message.error(errorMessage(e));
    }
  };

  const toggleEligibility = (u: UnitRow) => {
    if (u.voting_status === 'restricted') {
      api(`/condominiums/${condoId}/units/${u.id}/eligibility`, { method: 'PATCH', body: { votingStatus: 'eligible' } })
        .then(() => {
          message.success('Direito de voto restabelecido');
          invalidate();
        })
        .catch((e) => message.error(errorMessage(e)));
      return;
    }
    let reason = '';
    modal.confirm({
      title: `Restringir voto da unidade ${u.identifier}`,
      content: (
        <Input.TextArea
          aria-label="Fundamento da restrição"
          placeholder="Fundamento (ex.: art. 1.335, III — inadimplência; previsão da convenção)"
          onChange={(e) => (reason = e.target.value)}
        />
      ),
      okText: 'Restringir',
      okButtonProps: { danger: true },
      onOk: () =>
        api(`/condominiums/${condoId}/units/${u.id}/eligibility`, { method: 'PATCH', body: { votingStatus: 'restricted', reason } })
          .then(() => {
            message.success('Restrição registrada');
            invalidate();
          })
          .catch((e) => {
            message.error(errorMessage(e));
            throw e;
          }),
    });
  };

  return (
    <Card
      title="Unidades"
      extra={
        canManage && (
          <Space wrap>
            <Upload
              accept=".csv"
              showUploadList={false}
              beforeUpload={(file) => {
                Papa.parse<Record<string, unknown>>(file, {
                  header: true,
                  skipEmptyLines: true,
                  complete: (res) => {
                    setImportRows(res.data);
                    setImportResult(null);
                  },
                });
                return false;
              }}
            >
              <Button icon={<UploadOutlined />}>Importar CSV</Button>
            </Upload>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setUnitOpen(true)}>
              Nova unidade
            </Button>
          </Space>
        )
      }
    >
      <Table
        rowKey="id"
        loading={units.isLoading}
        dataSource={units.data}
        size="middle"
        scroll={{ x: true }}
        pagination={{ pageSize: 50 }}
        columns={[
          { title: 'Bloco', dataIndex: 'building_name', render: (b) => b ?? '—' },
          { title: 'Unidade', dataIndex: 'identifier' },
          { title: 'Fração ideal', dataIndex: 'ideal_fraction', render: (f: string) => `${fmtFraction(f)} (${fmtPercentOfFraction(f)})` },
          {
            title: 'Titulares',
            dataIndex: 'owners',
            render: (owners: UnitRow['owners']) =>
              owners.length === 0 ? (
                <Tag color="orange">Sem titular</Tag>
              ) : (
                <Space direction="vertical" size={0}>
                  {owners.map((o) => (
                    <span key={o.ownershipId}>
                      {o.name} <Typography.Text type="secondary">({RELATION_LABELS[o.relation] ?? o.relation})</Typography.Text>{' '}
                      {o.isVotingRepresentative && <Tag color="blue">representante</Tag>}
                    </span>
                  ))}
                </Space>
              ),
          },
          {
            title: 'Direito de voto',
            dataIndex: 'voting_status',
            render: (s: string, u: UnitRow) =>
              s === 'eligible' ? <Tag color="green">Habilitada</Tag> : <Tag color="red" title={u.voting_restriction_reason ?? ''}>Restrita</Tag>,
          },
          ...(canManage
            ? [{ title: 'Ações', key: 'a', render: (_: unknown, u: UnitRow) => <Button size="small" onClick={() => toggleEligibility(u)}>{u.voting_status === 'eligible' ? 'Restringir voto' : 'Restabelecer voto'}</Button> }]
            : []),
        ]}
      />

      <Modal title="Nova unidade" open={unitOpen} onCancel={() => setUnitOpen(false)} onOk={() => form.submit()} confirmLoading={createUnit.isPending}>
        <Form form={form} layout="vertical" onFinish={(v) => createUnit.mutate({ ...v, idealFraction: String(v.idealFraction) })}>
          <Form.Item name="buildingId" label="Bloco/torre">
            <Select allowClear options={buildings.data?.map((b) => ({ value: b.id, label: b.name }))} />
          </Form.Item>
          <Form.Item name="identifier" label="Identificação" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="kind" label="Tipo" initialValue="apartamento">
            <Select options={UNIT_KINDS.map((k) => ({ value: k, label: k }))} />
          </Form.Item>
          <Form.Item name="idealFraction" label="Fração ideal (0 a 1)" rules={[{ required: true }]}>
            <InputNumber min={0.0000000001} max={1} step={0.001} stringMode style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="Importação de unidades e proprietários"
        open={!!importRows}
        width={760}
        onCancel={() => setImportRows(null)}
        footer={[
          <Button key="v" onClick={() => runImport(true)}>Validar</Button>,
          <Button key="a" type="primary" disabled={!importResult || importResult.summary.errors > 0} onClick={() => runImport(false)}>
            Importar
          </Button>,
        ]}
      >
        <Typography.Paragraph>
          Colunas esperadas: <code>bloco, unidade, tipo, fracao_ideal, proprietario_nome, proprietario_documento, proprietario_email</code>. {importRows?.length ?? 0} linha(s) lida(s).
          A gravação só ocorre se não houver erros.
        </Typography.Paragraph>
        {importResult && (
          <>
            <Alert
              type={importResult.summary.errors ? 'error' : 'success'}
              showIcon
              message={`${importResult.summary.valid} válida(s), ${importResult.summary.errors} erro(s), ${importResult.summary.warnings} alerta(s). Soma das frações: ${fmtFraction(importResult.summary.fractionSum)}`}
              style={{ marginBottom: 8 }}
            />
            <Table
              size="small"
              rowKey={(r) => `${r.row}-${r.field}-${r.message}`}
              dataSource={importResult.issues}
              pagination={{ pageSize: 8 }}
              columns={[
                { title: 'Linha', dataIndex: 'row', width: 70 },
                { title: 'Campo', dataIndex: 'field' },
                { title: 'Mensagem', dataIndex: 'message' },
                { title: 'Tipo', dataIndex: 'severity', render: (s: string) => <Tag color={s === 'error' ? 'red' : 'orange'}>{s === 'error' ? 'erro' : 'alerta'}</Tag> },
              ]}
            />
          </>
        )}
      </Modal>
    </Card>
  );
}
