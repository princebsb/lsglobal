import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Descriptions, List, Result, Spin, Typography } from 'antd';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { MODALITY_LABELS } from '../lib/format';

interface PublicConvocation {
  assemblyId: string;
  assemblyStatus: string;
  status: string;
  version: number;
  currentVersion: number | null;
  subject: string;
  body: string;
  contentSha256: string;
  publishedAt: string;
  snapshot: {
    assembly?: { code: string; title: string; modality: string; timezone: string; location: string | null; firstCallAt: string; secondCallAt: string | null };
    condominium?: { name: string };
    agenda?: { position: number; title: string; description: string | null }[];
  };
}

function fmtTz(iso: string | null | undefined, tz: string) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'full', timeStyle: 'short', timeZone: tz }).format(new Date(iso));
}

/** Página do link pessoal do edital. Pública: exibe o edital e registra a abertura; participar exige login. */
export function ConvocationPublicPage() {
  const { token } = useParams<{ token: string }>();
  const { status } = useAuth();
  const q = useQuery({
    queryKey: ['public-convocation', token],
    queryFn: () => api<PublicConvocation>(`/public/convocations/${token}`, { tenant: false }),
    retry: false,
    staleTime: Infinity,
  });

  if (q.isLoading) return <div style={{ display: 'grid', placeItems: 'center', minHeight: '60vh' }}><Spin size="large" /></div>;
  if (q.error || !q.data) {
    return <Result status="404" title="Link de convocação inválido" subTitle="Confira o endereço recebido por e-mail ou procure a administração do condomínio." />;
  }
  const c = q.data;
  const s = c.snapshot;
  const tz = s.assembly?.timezone ?? 'America/Sao_Paulo';
  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: 16 }}>
      <Card>
        <Typography.Text type="secondary">{s.condominium?.name}</Typography.Text>
        <Typography.Title level={3} style={{ marginTop: 4 }}>{s.assembly?.title ?? c.subject}</Typography.Title>
        {c.status === 'superseded' && (
          <Alert type="warning" showIcon style={{ marginBottom: 16 }}
            message={`Este edital (versão ${c.version}) foi retificado${c.currentVersion ? ` pela versão ${c.currentVersion}` : ''}.`}
            description="Consulte o edital vigente enviado por e-mail ou na área do condômino." />
        )}
        {s.assembly && (
          <Descriptions size="small" column={1} bordered style={{ marginBottom: 16 }}>
            <Descriptions.Item label="1ª convocação">{fmtTz(s.assembly.firstCallAt, tz)}</Descriptions.Item>
            {s.assembly.secondCallAt && <Descriptions.Item label="2ª convocação">{fmtTz(s.assembly.secondCallAt, tz)}</Descriptions.Item>}
            <Descriptions.Item label="Modalidade">{MODALITY_LABELS[s.assembly.modality] ?? s.assembly.modality}</Descriptions.Item>
            {s.assembly.location && <Descriptions.Item label="Local">{s.assembly.location}</Descriptions.Item>}
          </Descriptions>
        )}
        <Typography.Paragraph style={{ whiteSpace: 'pre-wrap' }}>{c.body}</Typography.Paragraph>
        {s.agenda && s.agenda.length > 0 && (
          <>
            <Typography.Title level={5}>Ordem do dia</Typography.Title>
            <List size="small" dataSource={s.agenda} renderItem={(i) => (
              <List.Item><List.Item.Meta title={`${i.position}. ${i.title}`} description={i.description} /></List.Item>
            )} />
          </>
        )}
        <div style={{ marginTop: 24 }}>
          {status === 'authenticated' ? (
            <Link to={`/sala/${c.assemblyId}`}><Button type="primary" size="large">Entrar na sala da assembleia</Button></Link>
          ) : (
            <Link to={`/sala/${c.assemblyId}`}><Button type="primary" size="large">Entrar para participar</Button></Link>
          )}
          <Typography.Paragraph type="secondary" style={{ marginTop: 8, fontSize: 12 }}>
            A participação e o voto exigem login e credenciamento. Edital versão {c.version}, publicado em{' '}
            {new Date(c.publishedAt).toLocaleString('pt-BR')} — SHA-256 <Typography.Text code style={{ fontSize: 11 }}>{c.contentSha256}</Typography.Text>
          </Typography.Paragraph>
        </div>
      </Card>
    </div>
  );
}
