import { SafetyCertificateOutlined } from '@ant-design/icons';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, App, Button, Card, Input, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { PageHeader } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { fmtDateTimeSec } from '../lib/format';

interface AuditRow {
  id: string;
  chain_seq: string;
  actor_name: string | null;
  actor_email: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  outcome: 'success' | 'denied' | 'failure';
  metadata: Record<string, unknown>;
  occurred_at: string;
  hash: string;
  ip: string | null;
}

export function AuditPage() {
  const { message } = App.useApp();
  const [action, setAction] = useState('');
  const q = useQuery({ queryKey: ['audit', action], queryFn: () => api<AuditRow[]>(`/audit?limit=300${action ? `&action=${encodeURIComponent(action)}` : ''}`) });
  const verify = useMutation({
    mutationFn: () => api<{ checked: number; valid: boolean; first_invalid_seq: string | null; head_hash: string }>('/audit/verify'),
    onError: (e) => message.error(errorMessage(e)),
  });

  return (
    <>
      <PageHeader
        title="Auditoria"
        subtitle="Trilha append-only, encadeada por hash SHA-256"
        extra={
          <Space wrap>
            <Input.Search placeholder="Filtrar ação (ex.: ballot., vote., poa.)" allowClear onSearch={setAction} style={{ width: 300 }} aria-label="Filtrar por ação" />
            <Button icon={<SafetyCertificateOutlined />} onClick={() => verify.mutate()} loading={verify.isPending}>Verificar integridade</Button>
          </Space>
        }
      />
      {verify.data && (
        <Alert
          style={{ marginBottom: 16 }}
          showIcon
          type={verify.data.valid ? 'success' : 'error'}
          message={verify.data.valid ? `Cadeia íntegra: ${verify.data.checked} evento(s) verificados` : `ADULTERAÇÃO DETECTADA no evento #${verify.data.first_invalid_seq}`}
          description={<span>Hash do último elo: <span className="mono">{verify.data.head_hash}</span></span>}
        />
      )}
      <Card>
        <Table
          rowKey="id"
          loading={q.isLoading}
          dataSource={q.data}
          size="small"
          scroll={{ x: true }}
          pagination={{ pageSize: 50 }}
          expandable={{ expandedRowRender: (r) => <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{JSON.stringify(r.metadata, null, 2)}</pre> }}
          columns={[
            { title: '#', dataIndex: 'chain_seq', width: 70 },
            { title: 'Horário (servidor)', dataIndex: 'occurred_at', render: fmtDateTimeSec },
            { title: 'Autor', key: 'actor', render: (_: unknown, r: AuditRow) => r.actor_name ?? r.actor_email ?? 'sistema' },
            { title: 'Ação', dataIndex: 'action', render: (a: string) => <span className="mono">{a}</span> },
            { title: 'Recurso', key: 'res', render: (_: unknown, r: AuditRow) => `${r.resource_type}${r.resource_id ? ` · ${r.resource_id.slice(0, 8)}` : ''}` },
            {
              title: 'Resultado',
              dataIndex: 'outcome',
              render: (o: string) => <Tag color={o === 'success' ? 'green' : o === 'denied' ? 'orange' : 'red'}>{o === 'success' ? 'sucesso' : o === 'denied' ? 'negado' : 'falha'}</Tag>,
            },
            { title: 'Hash', dataIndex: 'hash', render: (h: string) => <Typography.Text className="mono" copyable={{ text: h }}>{h.slice(0, 12)}…</Typography.Text> },
          ]}
        />
      </Card>
    </>
  );
}
