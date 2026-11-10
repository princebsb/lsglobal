/**
 * Cliente HTTP da API. O access token fica somente em memória (não em localStorage);
 * o refresh token trafega em cookie httpOnly gerenciado pelo servidor.
 */
const BASE = '/api/v1';

let accessToken: string | null = null;
let tenantId: string | null = readTenant();
let onUnauthenticated: (() => void) | null = null;

function readTenant(): string | null {
  try {
    return localStorage.getItem('lsg.tenant');
  } catch {
    return null;
  }
}

export function setAccessToken(t: string | null) {
  accessToken = t;
}
export function getAccessToken() {
  return accessToken;
}
export function setTenant(id: string | null) {
  tenantId = id;
  try {
    if (id) localStorage.setItem('lsg.tenant', id);
    else localStorage.removeItem('lsg.tenant');
  } catch {
    /* armazenamento indisponível: segue apenas em memória */
  }
}
export function getTenant() {
  return tenantId;
}
export function setOnUnauthenticated(fn: () => void) {
  onUnauthenticated = fn;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly issues?: { path: string; message: string }[],
    readonly requestId?: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

let refreshing: Promise<boolean> | null = null;

export async function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const r = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-Requested-With': 'lsg-web' },
      });
      if (!r.ok) return false;
      const body = await r.json();
      accessToken = body.accessToken;
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

export interface RequestOpts {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Enviar X-Tenant-Id (padrão: sim). */
  tenant?: boolean;
  signal?: AbortSignal;
}

async function doFetch(path: string, opts: RequestOpts): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (opts.tenant !== false && tenantId) headers['X-Tenant-Id'] = tenantId;
  return fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    credentials: 'include',
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
}

async function toError(r: Response): Promise<ApiError> {
  let body: Record<string, unknown> = {};
  try {
    body = await r.json();
  } catch {
    /* corpo não JSON */
  }
  const msg = Array.isArray(body.message) ? body.message.join('; ') : String(body.message ?? r.statusText ?? 'Erro');
  return new ApiError(r.status, msg, body.code as string | undefined, body.issues as never, body.requestId as string | undefined, body.details);
}

export async function api<T = unknown>(path: string, opts: RequestOpts = {}): Promise<T> {
  let r = await doFetch(path, opts);
  if (r.status === 401 && !path.startsWith('/auth/login') && !path.startsWith('/auth/mfa/verify')) {
    if (await refreshSession()) r = await doFetch(path, opts);
    else onUnauthenticated?.();
  }
  if (!r.ok) throw await toError(r);
  if (r.status === 204) return undefined as T;
  return (await r.json()) as T;
}

/** Download autenticado (relatórios). Retorna o hash SHA-256 informado pelo servidor. */
export async function download(path: string, fallbackName: string): Promise<string | null> {
  let r = await doFetch(path, {});
  if (r.status === 401 && (await refreshSession())) r = await doFetch(path, {});
  if (!r.ok) throw await toError(r);
  const blob = await r.blob();
  const cd = r.headers.get('Content-Disposition') ?? '';
  const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return r.headers.get('X-Content-SHA256');
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const issues = e.issues?.map((i) => `${i.path ? i.path + ': ' : ''}${i.message}`).join(' • ');
    return issues ? `${e.message}: ${issues}` : e.message;
  }
  if (e instanceof Error) return e.message;
  return 'Erro inesperado';
}

/** Chave de idempotência para operações críticas (votos). */
export function newIdempotencyKey(prefix = 'v'): string {
  const rnd = crypto.getRandomValues(new Uint8Array(12));
  return `${prefix}-${Array.from(rnd, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
