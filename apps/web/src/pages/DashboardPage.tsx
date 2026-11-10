import { useQuery } from '@tanstack/react-query';
import { Card, Col, List, Row, Statistic, Typography } from 'antd';
import { Link } from 'react-router-dom';
import type { AssemblyStatus } from '@lsg/shared';
import { AssemblyStatusTag, PageHeader, QueryState } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { MODALITY_LABELS, fmtDateTime } from '../lib/format';

interface Dash {
  counts: Record<string, number>;
  upcoming: { id: string; code: string; title: string; status: AssemblyStatus; first_call_at: string; modality: string; condominium_name: string }[];
}

export function DashboardPage() {
  const { tenant, can, me } = useAuth();
  const q = useQuery({ queryKey: ['dashboard', tenant?.id], queryFn: () => api<Dash>('/dashboard'), enabled: !!tenant && can('assembly.view') });

  if (!tenant) {
    return (
      <>
        <PageHeader title={`Olá, ${me?.user.fullName}`} subtitle="Nenhum cliente vinculado" />
        {can('platform.dashboard.view') && (
          <Typography.Paragraph>
            Acesse o <Link to="/plataforma">painel da plataforma</Link>.
          </Typography.Paragraph>
        )}
      </>
    );
  }

  const c = q.data?.counts ?? {};
  const isParticipant = !can('assembly.manage') && !can('assembly.conduct') && can('assembly.attend');
  return (
    <>
      <PageHeader title={tenant.name} subtitle={tenant.roles.map((r) => `${r.roleName}${r.condominiumName ? ` — ${r.condominiumName}` : ''}`).join(' · ')} />
      <QueryState loading={q.isLoading} error={q.error}>
        {!isParticipant && (
          <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
            {[
              ['Condomínios', c.condominiums],
              ['Unidades', c.units],
              ['Assembleias ao vivo', c.live],
              ['Agendadas', c.scheduled],
              ['Rascunhos', c.drafts],
              ['Procurações pendentes', c.pending_poas],
            ].map(([t, v]) => (
              <Col xs={12} md={8} xl={4} key={t as string}>
                <Card>
                  <Statistic title={t} value={(v as number) ?? 0} />
                </Card>
              </Col>
            ))}
          </Row>
        )}
        <Card title="Próximas assembleias">
          <List
            dataSource={q.data?.upcoming ?? []}
            locale={{ emptyText: 'Nenhuma assembleia agendada' }}
            renderItem={(a) => (
              <List.Item
                actions={[
                  isParticipant || a.status === 'in_progress' || a.status === 'accreditation' ? (
                    <Link key="sala" to={`/sala/${a.id}`}>Entrar na sala</Link>
                  ) : null,
                  !isParticipant ? <Link key="ver" to={`/assembleias/${a.id}`}>Gerenciar</Link> : null,
                ].filter(Boolean)}
              >
                <List.Item.Meta
                  title={`${a.code} — ${a.title}`}
                  description={`${a.condominium_name} · ${fmtDateTime(a.first_call_at)} · ${MODALITY_LABELS[a.modality]}`}
                />
                <AssemblyStatusTag status={a.status} />
              </List.Item>
            )}
          />
        </Card>
      </QueryState>
    </>
  );
}
