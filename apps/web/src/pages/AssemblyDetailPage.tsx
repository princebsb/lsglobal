import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Space, Tabs, Typography } from 'antd';
import { Link, useParams } from 'react-router-dom';
import { AssemblyStatusTag, PageHeader, QueryState } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { KIND_LABELS, MODALITY_LABELS, fmtDateTime } from '../lib/format';
import { useAssemblyRealtime } from '../lib/realtime';
import { AccreditationTab } from './assembly/AccreditationTab';
import { AgendaTab } from './assembly/AgendaTab';
import { ConvocationTab } from './assembly/ConvocationTab';
import { MediaTab } from './assembly/MediaTab';
import { MesaTab } from './assembly/MesaTab';
import { OverviewTab } from './assembly/OverviewTab';
import { TimelineTab } from './assembly/TimelineTab';
import type { AssemblyDetail } from './assembly/types';

export function AssemblyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const conn = useAssemblyRealtime(id);
  const q = useQuery({ queryKey: ['assembly', id], queryFn: () => api<AssemblyDetail>(`/assemblies/${id}`) });
  const a = q.data;

  return (
    <QueryState loading={q.isLoading} error={q.error}>
      {a && (
        <>
          <PageHeader
            title={
              <Space wrap>
                <span>{a.code} — {a.title}</span>
                <AssemblyStatusTag status={a.status} />
              </Space>
            }
            subtitle={`${a.condominium.name} · ${KIND_LABELS[a.kind] ?? a.kind} · ${MODALITY_LABELS[a.modality]} · 1ª convocação ${fmtDateTime(a.first_call_at)}${a.second_call_at ? ` · 2ª ${fmtDateTime(a.second_call_at)}` : ''}`}
            extra={
              <>
                <Badge status={conn === 'online' ? 'success' : conn === 'connecting' ? 'processing' : 'error'} text={<Typography.Text type="secondary">Tempo real {conn === 'online' ? 'conectado' : conn === 'connecting' ? 'conectando' : 'desconectado'}</Typography.Text>} />
                <Link to={`/sala/${a.id}`}><Button>Abrir sala do participante</Button></Link>
              </>
            }
          />
          <Tabs
            items={[
              { key: 'overview', label: 'Visão geral', children: <OverviewTab a={a} /> },
              { key: 'agenda', label: 'Pauta e votações', children: <AgendaTab a={a} /> },
              { key: 'convocation', label: 'Convocação', children: <ConvocationTab a={a} /> },
              ...(can('assembly.accredit') ? [{ key: 'accr', label: 'Credenciamento', children: <AccreditationTab a={a} /> }] : []),
              ...(can('assembly.conduct') ? [{ key: 'mesa', label: 'Mesa diretora', children: <MesaTab a={a} /> }] : []),
              ...(can('assembly.conduct') || can('tech.operate') ? [{ key: 'media', label: 'Transmissão', children: <MediaTab a={a} /> }] : []),
              { key: 'timeline', label: 'Linha do tempo e relatórios', children: <TimelineTab a={a} /> },
            ]}
          />
        </>
      )}
    </QueryState>
  );
}
