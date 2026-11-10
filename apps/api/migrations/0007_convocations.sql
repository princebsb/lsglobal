-- =====================================================================
-- 0007 — Convocações: edital versionado, destinatários derivados das
-- unidades, fila de envio (outbox) e eventos de entrega append-only.
--
-- Registro de entrega/abertura NÃO implica validade jurídica da
-- convocação (que depende da convenção, do prazo e do meio previsto).
-- =====================================================================

create table convocations (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  assembly_id      uuid not null,
  version          int  not null,
  status           text not null default 'draft' check (status in ('draft','published','superseded','cancelled')),
  subject          text not null check (length(subject) between 5 and 200),
  body             text not null check (length(body) between 20 and 50000),
  -- Snapshot do que foi publicado (pauta, datas e local) e seu hash SHA-256.
  snapshot         jsonb,
  content_sha256   text,
  rectification_reason text,
  published_at     timestamptz,
  published_by     uuid references users(id),
  cancelled_at     timestamptz,
  cancel_reason    text,
  created_by       uuid references users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, id),
  unique (assembly_id, version),
  foreign key (tenant_id, assembly_id) references assemblies (tenant_id, id),
  check (status = 'draft' or (published_at is not null and content_sha256 is not null and snapshot is not null)),
  check (status <> 'cancelled' or cancel_reason is not null)
);
-- No máximo uma convocação vigente por assembleia.
create unique index convocations_one_published on convocations (assembly_id) where status = 'published';
create unique index convocations_one_draft on convocations (assembly_id) where status = 'draft';
create trigger convocations_touch before update on convocations for each row execute function touch_updated_at();

-- Após publicada, o conteúdo é imutável; só se permite marcar como substituída ou cancelada.
create or replace function convocations_guard() returns trigger language plpgsql as $$
begin
  if old.status = 'draft' then
    return new;
  end if;
  if new.subject is distinct from old.subject or new.body is distinct from old.body
     or new.snapshot is distinct from old.snapshot or new.content_sha256 is distinct from old.content_sha256
     or new.published_at is distinct from old.published_at or new.version is distinct from old.version
     or new.assembly_id is distinct from old.assembly_id then
    raise exception 'convocação publicada é imutável' using errcode = '42501';
  end if;
  if old.status = 'published' and new.status in ('superseded','cancelled','published') then
    return new;
  end if;
  if new.status = old.status then
    return new;
  end if;
  raise exception 'transição de convocação inválida: % -> %', old.status, new.status using errcode = '42501';
end $$;
create trigger convocations_guard_trg before update on convocations for each row execute function convocations_guard();
create trigger convocations_no_delete before delete on convocations for each row
  when (old.status <> 'draft') execute function forbid_mutation();

-- Destinatários: snapshot no momento da publicação (quem, qual unidade, para onde).
create table convocation_recipients (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  convocation_id   uuid not null,
  unit_id          uuid not null,
  person_id        uuid not null,
  relation         text not null,
  channel          text not null check (channel in ('email','whatsapp','none')),
  address          text,
  address_masked   text,
  -- Link pessoal: hash para localização + token cifrado (AES-256-GCM) para reenvio do mesmo link.
  link_token_hash  text not null unique,
  link_token_enc   text not null,
  created_at       timestamptz not null default clock_timestamp(),
  unique (tenant_id, id),
  unique (convocation_id, unit_id, person_id, channel),
  foreign key (tenant_id, convocation_id) references convocations (tenant_id, id),
  foreign key (tenant_id, unit_id) references units (tenant_id, id),
  foreign key (tenant_id, person_id) references people (tenant_id, id),
  check ((channel = 'none') = (address is null))
);
create index convocation_recipients_conv on convocation_recipients (convocation_id);
create trigger convocation_recipients_no_update before update or delete on convocation_recipients
  for each row execute function forbid_mutation();

-- Fila de envio (outbox). Estado mutável; o histórico fica em convocation_delivery_events.
create table convocation_deliveries (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null,
  recipient_id        uuid not null,
  channel             text not null check (channel in ('email','whatsapp')),
  status              text not null default 'queued' check (status in ('queued','sending','sent','failed')),
  attempts            int not null default 0,
  max_attempts        int not null default 5,
  next_attempt_at     timestamptz not null default now(),
  lease_until         timestamptz,
  last_error          text,
  provider_message_id text,
  sent_at             timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, recipient_id) references convocation_recipients (tenant_id, id)
);
create index convocation_deliveries_due on convocation_deliveries (next_attempt_at) where status in ('queued','sending');
create index convocation_deliveries_recipient on convocation_deliveries (recipient_id);
create trigger convocation_deliveries_touch before update on convocation_deliveries for each row execute function touch_updated_at();

create table convocation_delivery_events (
  id            bigserial primary key,
  tenant_id     uuid not null,
  recipient_id  uuid not null,
  delivery_id   uuid,
  event         text not null check (event in ('queued','sent','failed','retry_scheduled','skipped_no_address','opened','resend_requested')),
  detail        jsonb not null default '{}'::jsonb,
  occurred_at   timestamptz not null default clock_timestamp(),
  foreign key (tenant_id, recipient_id) references convocation_recipients (tenant_id, id)
);
create index convocation_delivery_events_recipient on convocation_delivery_events (recipient_id, occurred_at);
create trigger convocation_delivery_events_no_update before update or delete on convocation_delivery_events
  for each row execute function forbid_mutation();

-- RLS
do $$
declare t text;
begin
  foreach t in array array['convocations','convocation_recipients','convocation_deliveries','convocation_delivery_events'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Funções SECURITY DEFINER de escopo mínimo
-- ---------------------------------------------------------------------

-- O processador da fila atende todos os clientes: reserva (lease) lotes de envios
-- vencidos e devolve apenas identificadores. O processamento ocorre depois
-- em transação com o tenant do envio (sujeito ao RLS).
create or replace function convocation_claim_deliveries(p_limit int, p_lease_seconds int)
returns table (delivery_id uuid, tenant_id uuid)
language plpgsql volatile security definer set search_path = public as $$
begin
  if p_limit < 1 or p_limit > 200 or p_lease_seconds < 5 or p_lease_seconds > 600 then
    raise exception 'parâmetros inválidos';
  end if;
  return query
  with due as (
    select d.id from convocation_deliveries d
     where (d.status = 'queued' and d.next_attempt_at <= now())
        or (d.status = 'sending' and d.lease_until < now())
     order by d.next_attempt_at
     limit p_limit
     for update skip locked
  )
  update convocation_deliveries d
     set status = 'sending', attempts = d.attempts + 1, lease_until = now() + make_interval(secs => p_lease_seconds)
    from due where d.id = due.id
  returning d.id, d.tenant_id;
end $$;

-- Link individual: resolve o token (hash) para o tenant/destinatário. Sem dados pessoais.
create or replace function convocation_resolve_link(p_token_hash text)
returns table (tenant_id uuid, recipient_id uuid, convocation_id uuid)
language sql stable security definer set search_path = public as $$
  select r.tenant_id, r.id, r.convocation_id from convocation_recipients r where r.link_token_hash = p_token_hash
$$;

revoke all on function convocation_claim_deliveries(int, int) from public;
revoke all on function convocation_resolve_link(text) from public;
grant execute on function convocation_claim_deliveries(int, int), convocation_resolve_link(text) to {{APP_ROLE}};

grant select, insert, update, delete on convocations, convocation_deliveries to {{APP_ROLE}};
grant select, insert on convocation_recipients, convocation_delivery_events to {{APP_ROLE}};
grant usage, select on sequence convocation_delivery_events_id_seq to {{APP_ROLE}};
