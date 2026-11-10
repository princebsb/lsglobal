import { DownloadOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { App, Button, Card, Col, Row, Space, Timeline, Typography } from 'antd';
import { api, download, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { TIMELINE_LABELS, fmtDateTimeSec } from '../../lib/format';
import type { AssemblyDetail } from './types';

interface TL {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  occurred_at: string;
  session_seq: number | null;
  actor: string | null;
}

export function TimelineTab({ a }: { a: AssemblyDetail }) {
  const { can } = useAuth();
  const { message } = App.useApp();
  const tl = useQuery({ queryKey: ['assembly', a.id, 'timeline'], queryFn: () => api<TL[]>(`/assemblies/${a.id}/timeline`) });

  const dl = async (path: string, name: string) => {
    try {
      const hash = await download(path, name);
      if (hash) message.success(`Arquivo gerado. SHA-256: ${hash.slice(0, 16)}…`);
    } catch (e) {
      message.error(errorMessage(e));
    }
  };

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={14}>
        <Card title="Linha do tempo oficial">
          <Typography.Paragraph type="secondary">
            Registro append-only com horário do servidor, incluindo pedidos de palavra e início/fim das gravações confirmados pelo servidor de mídia.
          </Typography.Paragraph>
          <Timeline
            items={(tl.data ?? []).map((e) => ({
              color: e.kind.includes('cancel') ? 'red' : e.kind.includes('declared') ? 'green' : 'blue',
              children: (
                <Space direction="vertical" size={0}>
                  <Typography.Text strong>{TIMELINE_LABELS[e.kind] ?? e.kind}</Typography.Text>
                  <Typography.Text type="secondary">
                    {fmtDateTimeSec(e.occurred_at)}{e.session_seq ? ` · sessão ${e.session_seq}` : ''}{e.actor ? ` · ${e.actor}` : ''}
                  </Typography.Text>
                  {typeof e.payload.title === 'string' && <span>{e.payload.title}</span>}
                  {typeof e.payload.outcome === 'string' && <span>Resultado: {String(e.payload.outcome)}</span>}
                  {typeof e.payload.reason === 'string' && <span>Motivo: {String(e.payload.reason)}</span>}
                </Space>
              ),
            }))}
          />
        </Card>
      </Col>
      <Col xs={24} lg={10}>
        <Card title="Relatórios">
          {can('reports.export') ? (
            <Space direction="vertical" style={{ width: '100%' }}>
              <Space wrap>
                <Typography.Text>Lista de presença:</Typography.Text>
                <Button icon={<DownloadOutlined />} onClick={() => dl(`/assemblies/${a.id}/reports/attendance?format=csv`, 'presenca.csv')}>CSV</Button>
                <Button icon={<DownloadOutlined />} onClick={() => dl(`/assemblies/${a.id}/reports/attendance?format=xlsx`, 'presenca.xlsx')}>Excel</Button>
              </Space>
              {a.ballots
                .filter((b) => ['tallied', 'declared'].includes(b.status))
                .map((b) => (
                  <Space wrap key={b.id}>
                    <Typography.Text>Resultado — {b.title}{b.round > 1 ? ` (r${b.round})` : ''}:</Typography.Text>
                    <Button icon={<DownloadOutlined />} onClick={() => dl(`/ballots/${b.id}/reports/result?format=csv`, 'resultado.csv')}>CSV</Button>
                    <Button icon={<DownloadOutlined />} onClick={() => dl(`/ballots/${b.id}/reports/result?format=xlsx`, 'resultado.xlsx')}>Excel</Button>
                  </Space>
                ))}
              <Typography.Text type="secondary">Cada exportação é auditada e acompanha o hash SHA-256 do arquivo.</Typography.Text>
            </Space>
          ) : (
            <Typography.Text type="secondary">Seu perfil não exporta relatórios.</Typography.Text>
          )}
        </Card>
      </Col>
    </Row>
  );
}
