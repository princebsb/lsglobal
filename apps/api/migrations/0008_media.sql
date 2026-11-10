-- =====================================================================
-- 0008 — Transmissão (LiveKit): sala por assembleia, pedidos de palavra,
-- gravações (Egress) e registro idempotente dos webhooks do servidor de mídia.
-- =====================================================================

create table media_rooms (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  assembly_id   uuid not null unique,
  room_name     text not null unique,
  livekit_sid   text,
  status        text not null default 'idle' check (status in ('idle','live','ended')),
  started_at    timestamptz,
  ended_at      timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, assembly_id) references assemblies (tenant_id, id)
);
create trigger media_rooms_touch before update on media_rooms for each row execute function touch_updated_at();

-- Fila de palavra ("levantar a mão"). Uma solicitação ativa por pessoa e assembleia.
create table floor_requests (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  assembly_id   uuid not null,
  person_id     uuid not null,
  user_id       uuid not null references users(id),
  status        text not null default 'waiting' check (status in ('waiting','granted','done','denied','cancelled')),
  topic         text check (length(topic) <= 300),
  requested_at  timestamptz not null default clock_timestamp(),
  granted_at    timestamptz,
  granted_by    uuid references users(id),
  max_seconds   int check (max_seconds between 30 and 3600),
  ended_at      timestamptz,
  ended_by      uuid references users(id),
  end_reason    text,
  unique (tenant_id, id),
  foreign key (tenant_id, assembly_id) references assemblies (tenant_id, id),
  foreign key (tenant_id, person_id) references people (tenant_id, id),
  check (status <> 'granted' or granted_at is not null)
);
create unique index floor_requests_one_active on floor_requests (assembly_id, person_id) where status in ('waiting','granted');
create unique index floor_requests_one_speaker on floor_requests (assembly_id) where status = 'granted';
create index floor_requests_assembly on floor_requests (assembly_id, requested_at);

create table recordings (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  assembly_id    uuid not null,
  session_id     uuid,
  egress_id      text not null unique,
  status         text not null default 'starting' check (status in ('starting','active','ending','complete','failed')),
  requested_by   uuid references users(id),
  requested_at   timestamptz not null default clock_timestamp(),
  -- horários informados pelo servidor de mídia (confirmação de início/fim)
  started_at     timestamptz,
  ended_at       timestamptz,
  stop_requested_by uuid references users(id),
  file_path      text,
  file_size      bigint,
  duration_ms    bigint,
  sha256         text,
  error          text,
  updated_at     timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, assembly_id) references assemblies (tenant_id, id)
);
create unique index recordings_one_active on recordings (assembly_id) where status in ('starting','active','ending');
create trigger recordings_touch before update on recordings for each row execute function touch_updated_at();
-- Integridade: depois de concluída, a gravação não muda.
create or replace function recordings_guard() returns trigger language plpgsql as $$
begin
  if old.status in ('complete','failed') then
    raise exception 'gravação finalizada é imutável' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger recordings_guard_trg before update on recordings for each row execute function recordings_guard();
create trigger recordings_no_delete before delete on recordings for each row execute function forbid_mutation();

create table media_webhook_events (
  event_id     text primary key,
  tenant_id    uuid not null,
  assembly_id  uuid not null,
  event        text not null,
  payload      jsonb not null,
  received_at  timestamptz not null default clock_timestamp(),
  foreign key (tenant_id, assembly_id) references assemblies (tenant_id, id)
);
create index media_webhook_events_assembly on media_webhook_events (assembly_id, received_at);
create trigger media_webhook_events_no_update before update or delete on media_webhook_events
  for each row execute function forbid_mutation();

do $$
declare t text;
begin
  foreach t in array array['media_rooms','floor_requests','recordings','media_webhook_events'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())', t);
  end loop;
end $$;

-- Webhook do servidor de mídia chega sem contexto de cliente: resolve sala -> (tenant, assembleia).
create or replace function media_room_lookup(p_room_name text)
returns table (tenant_id uuid, assembly_id uuid)
language sql stable security definer set search_path = public as $$
  select r.tenant_id, r.assembly_id from media_rooms r where r.room_name = p_room_name
$$;
revoke all on function media_room_lookup(text) from public;
grant execute on function media_room_lookup(text) to {{APP_ROLE}};

grant select, insert, update on media_rooms, floor_requests, recordings to {{APP_ROLE}};
grant select, insert on media_webhook_events to {{APP_ROLE}};
