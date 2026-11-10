import { AudioOutlined, VideoCameraOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FLOOR_STATUS_LABELS } from '@lsg/shared';
import { Alert, App, Button, Input, Space, Spin, Tag, Typography } from 'antd';
import { Suspense, lazy, useEffect, useState } from 'react';
import { api, errorMessage } from '../../lib/api';

const MediaStage = lazy(() => import('./MediaStage'));

export interface FloorItem {
  id: string;
  status: 'waiting' | 'granted' | 'done' | 'denied' | 'cancelled';
  topic: string | null;
  requested_at: string;
  granted_at: string | null;
  max_seconds: number | null;
  ended_at: string | null;
  person_name: string;
  person_id?: string;
  mine: boolean;
}
export interface RecordingItem {
  id: string;
  status: 'starting' | 'active' | 'ending' | 'complete' | 'failed';
  requested_at: string;
  started_at: string | null;
  ended_at: string | null;
  file_size: string | null;
  duration_ms: string | null;
  sha256: string | null;
  error: string | null;
  requested_by_name: string | null;
}
export interface MediaOverview {
  configured: boolean;
  egressEnabled: boolean;
  room: { room_name: string; status: string; started_at: string | null } | null;
  floor: FloorItem[];
  recordings: RecordingItem[];
  participants: { identity: string; name: string; joinedAt: string | null; tracks: { source: string; muted: boolean }[]; canPublish: boolean }[] | null;
  isStaff: boolean;
}

export const mediaKey = (assemblyId: string) => ['assembly', assemblyId, 'media'];

export function useMediaOverview(assemblyId: string) {
  return useQuery({ queryKey: mediaKey(assemblyId), queryFn: () => api<MediaOverview>(`/assemblies/${assemblyId}/media`) });
}

/** Contagem regressiva do tempo de fala. */
export function SpeakingTimer({ grantedAt, maxSeconds }: { grantedAt: string; maxSeconds: number | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const elapsed = Math.max(0, Math.floor((now - new Date(grantedAt).getTime()) / 1000));
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  if (!maxSeconds) return <Tag>{fmt(elapsed)}</Tag>;
  const left = maxSeconds - elapsed;
  return <Tag color={left < 0 ? 'red' : left < 30 ? 'orange' : 'green'}>{left < 0 ? `excedido ${fmt(-left)}` : `restam ${fmt(left)}`}</Tag>;
}

/** Vídeo da assembleia + entrada na sala. Usado pela sala do participante e pela mesa. */
export function MediaJoin({ assemblyId, staff, disabledReason }: { assemblyId: string; staff: boolean; disabledReason?: string | null }) {
  const { message } = App.useApp();
  const [session, setSession] = useState<{ url: string; token: string } | null>(null);
  const join = useMutation({
    mutationFn: () => api<{ url: string; token: string; role: string }>(`/assemblies/${assemblyId}/media/token`, { method: 'POST' }),
    onSuccess: (r) => setSession({ url: r.url, token: r.token }),
    onError: (e) => message.error(errorMessage(e)),
  });
  if (session) {
    return (
      <Suspense fallback={<div className="video-placeholder"><Spin /></div>}>
        <MediaStage url={session.url} token={session.token} staff={staff} onLeave={() => setSession(null)} />
      </Suspense>
    );
  }
  return (
    <div className="video-placeholder" role="region" aria-label="Transmissão ao vivo">
      <Space direction="vertical" align="center">
        <VideoCameraOutlined style={{ fontSize: 40 }} />
        {disabledReason ? (
          <Typography.Text style={{ color: 'inherit' }}>{disabledReason}</Typography.Text>
        ) : (
          <Button type="primary" size="large" onClick={() => join.mutate()} loading={join.isPending}>
            {staff ? 'Entrar na sala (mesa)' : 'Assistir à transmissão'}
          </Button>
        )}
      </Space>
    </div>
  );
}

/** Painel do participante: transmissão + pedido de palavra. */
export function AttendeeMediaPanel({ assemblyId, assemblyStatus, accredited }: { assemblyId: string; assemblyStatus: string; accredited: boolean }) {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const ov = useMediaOverview(assemblyId);
  const [topic, setTopic] = useState('');
  const mine = ov.data?.floor.find((f) => f.mine && (f.status === 'waiting' || f.status === 'granted'));
  const inv = () => qc.invalidateQueries({ queryKey: mediaKey(assemblyId) });
  const request = useMutation({
    mutationFn: () => api(`/assemblies/${assemblyId}/floor`, { method: 'POST', body: topic.trim() ? { topic: topic.trim() } : {} }),
    onSuccess: () => {
      message.success('Pedido de palavra registrado');
      setTopic('');
      inv();
    },
    onError: (e) => message.error(errorMessage(e)),
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api(`/floor/${id}/cancel`, { method: 'POST' }),
    onSuccess: inv,
    onError: (e) => message.error(errorMessage(e)),
  });

  const live = ['accreditation', 'in_progress', 'suspended'].includes(assemblyStatus);
  const reason = !ov.data
    ? null
    : !ov.data.configured
      ? 'Transmissão não configurada neste ambiente. Acompanhe pelo canal informado no edital.'
      : !live
        ? 'A transmissão abre junto com o credenciamento.'
        : !accredited
          ? 'Confirme sua presença (credenciamento) para assistir e participar.'
          : null;

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <MediaJoin assemblyId={assemblyId} staff={false} disabledReason={reason} />
      {ov.data?.configured && accredited && assemblyStatus === 'in_progress' && (
        mine ? (
          <Alert
            type={mine.status === 'granted' ? 'success' : 'info'}
            showIcon
            icon={<AudioOutlined />}
            message={mine.status === 'granted' ? 'Você está com a palavra — ative o microfone na barra do vídeo.' : 'Pedido de palavra na fila'}
            description={
              mine.status === 'granted' && mine.granted_at ? <SpeakingTimer grantedAt={mine.granted_at} maxSeconds={mine.max_seconds} /> : `Aguarde a mesa conceder a palavra. ${FLOOR_STATUS_LABELS[mine.status]}.`
            }
            action={mine.status === 'waiting' ? <Button size="small" onClick={() => cancel.mutate(mine.id)}>Cancelar pedido</Button> : undefined}
          />
        ) : (
          <Space.Compact style={{ width: '100%' }}>
            <Input placeholder="Assunto (opcional)" value={topic} maxLength={300} onChange={(e) => setTopic(e.target.value)} />
            <Button icon={<AudioOutlined />} onClick={() => request.mutate()} loading={request.isPending}>Pedir a palavra</Button>
          </Space.Compact>
        )
      )}
    </Space>
  );
}
