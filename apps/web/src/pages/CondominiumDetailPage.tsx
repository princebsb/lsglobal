import { useQuery } from '@tanstack/react-query';
import { Card, Descriptions, Tabs, Tag } from 'antd';
import { useParams } from 'react-router-dom';
import { PageHeader, QueryState } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { CONDO_TYPE_LABELS, REGIME_LABELS, fmtFraction } from '../lib/format';
import { PeopleTab } from './condo/PeopleTab';
import { PoaTab } from './condo/PoaTab';
import { RulesTab } from './condo/RulesTab';
import { UnitsTab } from './condo/UnitsTab';

export interface CondoDetail {
  id: string;
  name: string;
  document: string | null;
  type: string;
  legal_regime: string;
  timezone: string;
  units: number;
  restricted_units: number;
  fraction_sum: string;
  pending_poas: number;
  settings: { maxUnitsPerAttorney?: number };
}

export function CondominiumDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['condo', id], queryFn: () => api<CondoDetail>(`/condominiums/${id}`) });
  const c = q.data;
  const fractionOk = c && Math.abs(Number(c.fraction_sum) - 1) < 1e-6;

  return (
    <QueryState loading={q.isLoading} error={q.error}>
      {c && (
        <>
          <PageHeader title={c.name} subtitle={`${CONDO_TYPE_LABELS[c.type] ?? c.type} · ${REGIME_LABELS[c.legal_regime] ?? c.legal_regime}`} />
          <Card style={{ marginBottom: 16 }}>
            <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 4 }}>
              <Descriptions.Item label="Unidades ativas">{c.units}</Descriptions.Item>
              <Descriptions.Item label="Soma das frações">
                <Tag color={fractionOk ? 'green' : 'orange'}>{fmtFraction(c.fraction_sum)}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="Unidades com voto restrito">{c.restricted_units}</Descriptions.Item>
              <Descriptions.Item label="Procurações pendentes">{c.pending_poas}</Descriptions.Item>
              <Descriptions.Item label="Limite de unidades por procurador">{c.settings?.maxUnitsPerAttorney ?? 'Sem limite configurado'}</Descriptions.Item>
              <Descriptions.Item label="Fuso horário">{c.timezone}</Descriptions.Item>
            </Descriptions>
          </Card>
          <Tabs
            destroyInactiveTabPane
            items={[
              { key: 'units', label: 'Unidades', children: <UnitsTab condoId={c.id} canManage={can('condo.manage')} /> },
              { key: 'people', label: 'Condôminos', children: <PeopleTab condoId={c.id} /> },
              { key: 'poa', label: 'Procurações', children: <PoaTab condoId={c.id} /> },
              { key: 'rules', label: 'Regras de quórum', children: <RulesTab condoId={c.id} legalRegime={c.legal_regime} /> },
            ]}
          />
        </>
      )}
    </QueryState>
  );
}
