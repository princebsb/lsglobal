import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { getAccessToken, getTenant } from './api';

export type ConnState = 'connecting' | 'online' | 'offline';

/**
 * Assina eventos da assembleia. Eventos apenas invalidam consultas: os dados exibidos
 * vêm sempre da API (fonte autoritativa). Há também reconciliação periódica.
 */
export function useAssemblyRealtime(assemblyId: string | undefined, reconcileMs = 15000): ConnState {
  const qc = useQueryClient();
  const [state, setState] = useState<ConnState>('connecting');

  useEffect(() => {
    if (!assemblyId) return;
    const socket: Socket = io('/rt', {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      auth: (cb) => cb({ token: getAccessToken(), tenantId: getTenant() }),
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 8000,
    });
    const invalidate = () => {
      qc.invalidateQueries({ queryKey: ['assembly', assemblyId] });
      qc.invalidateQueries({ queryKey: ['ballot'] });
    };
    socket.on('connect', () => {
      setState('online');
      socket.emit('join', { assemblyId });
      invalidate(); // reconciliação ao reconectar
    });
    socket.on('disconnect', () => setState('offline'));
    socket.on('connect_error', () => setState('offline'));
    for (const ev of ['assembly.status', 'ballot.changed', 'ballot.progress', 'quorum.changed', 'convocation.changed', 'media.changed']) {
      socket.on(ev, invalidate);
    }
    const timer = setInterval(invalidate, reconcileMs);
    return () => {
      clearInterval(timer);
      socket.emit('leave', { assemblyId });
      socket.disconnect();
    };
  }, [assemblyId, qc, reconcileMs]);

  return state;
}

/** Estado de conectividade do navegador. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}
