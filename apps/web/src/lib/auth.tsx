import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Permission } from '@lsg/shared';
import { api, getTenant, refreshSession, setAccessToken, setOnUnauthenticated, setTenant } from './api';

export interface MeTenant {
  id: string;
  name: string;
  kind: string;
  roles: { roleCode: string; roleName: string; condominiumId: string | null; condominiumName: string | null }[];
  permissions: Permission[];
}

export interface Me {
  user: { id: string; email: string; fullName: string; isPlatformStaff: boolean; mfaEnabled: boolean; mfaEnrollmentRequired: boolean };
  platform: { roles: { roleCode: string; roleName: string }[]; permissions: Permission[] };
  tenants: MeTenant[];
}

interface AuthState {
  status: 'loading' | 'anonymous' | 'authenticated';
  me: Me | null;
  tenant: MeTenant | null;
  tenantId: string | null;
  selectTenant: (id: string | null) => void;
  can: (p: Permission) => boolean;
  completeLogin: (accessToken: string) => Promise<void>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<AuthState['status']>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [tenantId, setTenantId] = useState<string | null>(getTenant());

  const loadMe = useCallback(async () => {
    const m = await api<Me>('/auth/me', { tenant: false });
    setMe(m);
    const current = getTenant();
    const valid = m.tenants.some((t) => t.id === current);
    const next = valid ? current : (m.tenants[0]?.id ?? null);
    setTenant(next);
    setTenantId(next);
    setStatus('authenticated');
  }, []);

  useEffect(() => {
    setOnUnauthenticated(() => {
      setAccessToken(null);
      setMe(null);
      setStatus('anonymous');
    });
    (async () => {
      if (await refreshSession()) {
        try {
          await loadMe();
          return;
        } catch {
          /* sessão inválida */
        }
      }
      setStatus('anonymous');
    })();
  }, [loadMe]);

  const value = useMemo<AuthState>(() => {
    const tenant = me?.tenants.find((t) => t.id === tenantId) ?? null;
    const perms = new Set<Permission>([...(tenant?.permissions ?? []), ...(me?.platform.permissions ?? [])]);
    return {
      status,
      me,
      tenant,
      tenantId,
      can: (p) => perms.has(p),
      selectTenant: (id) => {
        setTenant(id);
        setTenantId(id);
        qc.clear();
      },
      completeLogin: async (token) => {
        setAccessToken(token);
        await loadMe();
      },
      logout: async () => {
        try {
          await api('/auth/logout', { method: 'POST', tenant: false });
        } finally {
          setAccessToken(null);
          setMe(null);
          qc.clear();
          setStatus('anonymous');
        }
      },
      reload: loadMe,
    };
  }, [status, me, tenantId, qc, loadMe]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth fora do AuthProvider');
  return v;
}
