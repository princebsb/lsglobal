-- =====================================================================
-- 0001 — Fundação: extensões, funções utilitárias, identidade, RBAC,
--        clientes (tenants) e auditoria append-only com cadeia de hash.
-- =====================================================================

create extension if not exists pgcrypto;
create extension if not exists citext;

-- Tenant corrente da transação (definido pela API com set_config(..., true)).
create or replace function app_current_tenant() returns uuid
language sql stable as $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

create or replace function app_current_user() returns uuid
language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

-- Bloqueia UPDATE/DELETE em tabelas append-only.
create or replace function forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'Tabela % é somente inserção (append-only): operação % não permitida', tg_table_name, tg_op
    using errcode = 'P0001';
end
$$;

create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- ---------------------------------------------------------------------
-- Clientes contratantes (nível 2)
-- ---------------------------------------------------------------------
create table tenants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(name) between 2 and 200),
  kind        text not null check (kind in ('condominio_independente','administradora','sindico_profissional','associacao','outro')),
  document    text,
  status      text not null default 'active' check (status in ('active','suspended','closed')),
  branding    jsonb not null default '{}'::jsonb,
  settings    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index tenants_document_uq on tenants (document) where document is not null;
create trigger tenants_touch before update on tenants for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------
-- Usuários (globais; podem ter vínculos com vários clientes/condomínios)
-- ---------------------------------------------------------------------
create table users (
  id                 uuid primary key default gen_random_uuid(),
  email              citext not null unique,
  full_name          text not null,
  password_hash      text not null,
  is_platform_staff  boolean not null default false,
  mfa_secret_enc     text,
  mfa_enabled        boolean not null default false,
  status             text not null default 'active' check (status in ('active','disabled')),
  failed_login_count integer not null default 0,
  locked_until       timestamptz,
  last_login_at      timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create trigger users_touch before update on users for each row execute function touch_updated_at();

create table auth_sessions (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references users(id) on delete cascade,
  family_id          uuid not null,
  refresh_token_hash text not null unique,
  created_at         timestamptz not null default now(),
  expires_at         timestamptz not null,
  rotated_at         timestamptz,
  revoked_at         timestamptz,
  ip                 text,
  user_agent         text
);
create index auth_sessions_user_idx on auth_sessions (user_id) where revoked_at is null;
create index auth_sessions_family_idx on auth_sessions (family_id);

-- ---------------------------------------------------------------------
-- RBAC
-- ---------------------------------------------------------------------
create table roles (
  code          text primary key,
  name          text not null,
  scope         text not null check (scope in ('platform','tenant','condominium')),
  requires_mfa  boolean not null default false
);

create table permissions (
  code        text primary key,
  description text not null
);

create table role_permissions (
  role_code       text not null references roles(code) on delete cascade,
  permission_code text not null references permissions(code) on delete cascade,
  primary key (role_code, permission_code)
);

-- condominium_id recebe FK após a criação de condominiums (0002).
create table user_role_assignments (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users(id) on delete cascade,
  role_code      text not null references roles(code),
  tenant_id      uuid references tenants(id),
  condominium_id uuid,
  granted_by     uuid references users(id),
  created_at     timestamptz not null default now(),
  revoked_at     timestamptz,
  revoked_by     uuid references users(id),
  check (condominium_id is null or tenant_id is not null)
);
create index ura_user_idx on user_role_assignments (user_id) where revoked_at is null;
create index ura_tenant_idx on user_role_assignments (tenant_id) where revoked_at is null;
create unique index ura_unique_active on user_role_assignments
  (user_id, role_code, coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid),
   coalesce(condominium_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where revoked_at is null;

-- ---------------------------------------------------------------------
-- Auditoria append-only com cadeia de hash por "chain_key"
-- (um encadeamento por tenant e um para a plataforma)
-- ---------------------------------------------------------------------
create table audit_events (
  id             bigserial primary key,
  chain_key      text not null,
  chain_seq      bigint not null,
  tenant_id      uuid references tenants(id),
  actor_user_id  uuid,
  action         text not null,
  resource_type  text not null,
  resource_id    text,
  assembly_id    uuid,
  request_id     text,
  correlation_id text,
  ip             text,
  user_agent     text,
  outcome        text not null check (outcome in ('success','denied','failure')),
  before_state   jsonb,
  after_state    jsonb,
  metadata       jsonb not null default '{}'::jsonb,
  occurred_at    timestamptz not null default clock_timestamp(),
  prev_hash      text not null,
  hash           text not null,
  unique (chain_key, chain_seq)
);
create index audit_tenant_time_idx on audit_events (tenant_id, occurred_at desc);
create index audit_assembly_idx on audit_events (assembly_id) where assembly_id is not null;
create index audit_resource_idx on audit_events (resource_type, resource_id);

create or replace function audit_event_hash(e audit_events) returns text
language sql immutable as $$
  select encode(digest(concat_ws('|',
    e.prev_hash, e.chain_key, e.chain_seq::text,
    coalesce(e.tenant_id::text, ''), coalesce(e.actor_user_id::text, ''),
    e.action, e.resource_type, coalesce(e.resource_id, ''), coalesce(e.assembly_id::text, ''),
    coalesce(e.request_id, ''), e.outcome,
    to_char(e.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    coalesce(e.before_state::text, ''), coalesce(e.after_state::text, ''), e.metadata::text
  ), 'sha256'), 'hex')
$$;

create or replace function audit_events_chain() returns trigger
language plpgsql as $$
declare
  last_hash text;
  last_seq  bigint;
begin
  new.chain_key := coalesce(new.tenant_id::text, 'platform');
  perform pg_advisory_xact_lock(hashtextextended('audit:' || new.chain_key, 0));
  select hash, chain_seq into last_hash, last_seq
    from audit_events where chain_key = new.chain_key
    order by chain_seq desc limit 1;
  new.chain_seq := coalesce(last_seq, 0) + 1;
  new.prev_hash := coalesce(last_hash, repeat('0', 64));
  new.occurred_at := clock_timestamp();
  new.hash := audit_event_hash(new);
  return new;
end
$$;

create trigger audit_events_chain_trg before insert on audit_events
  for each row execute function audit_events_chain();
create trigger audit_events_no_update before update or delete on audit_events
  for each row execute function forbid_mutation();
create trigger audit_events_no_truncate before truncate on audit_events
  for each statement execute function forbid_mutation();

-- Verifica a integridade de uma cadeia; retorna o primeiro elo quebrado (se houver).
create or replace function audit_verify_chain(p_chain_key text)
returns table (checked bigint, valid boolean, first_invalid_seq bigint, head_hash text)
language plpgsql stable as $$
declare
  r audit_events;
  expected_prev text := repeat('0', 64);
  n bigint := 0;
  expected_seq bigint := 1;
begin
  for r in select * from audit_events where chain_key = p_chain_key order by chain_seq loop
    n := n + 1;
    if r.chain_seq <> expected_seq or r.prev_hash <> expected_prev or r.hash <> audit_event_hash(r) then
      checked := n; valid := false; first_invalid_seq := r.chain_seq; head_hash := r.hash;
      return next; return;
    end if;
    expected_prev := r.hash;
    expected_seq := expected_seq + 1;
  end loop;
  checked := n; valid := true; first_invalid_seq := null; head_hash := expected_prev;
  return next;
end
$$;
