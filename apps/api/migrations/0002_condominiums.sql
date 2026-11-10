-- =====================================================================
-- 0002 — Condomínios, blocos, unidades, pessoas, vínculos, documentos
--        e procurações. Todas as tabelas carregam tenant_id e usam FKs
--        compostas (tenant_id, id) para impedir referências entre tenants.
-- =====================================================================

create table condominiums (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  name          text not null,
  document      text,
  type          text not null check (type in ('residencial_vertical','residencial_horizontal','comercial','empresarial','misto','clube','multiplas_torres','complexo','associacao')),
  legal_regime  text not null check (legal_regime in ('condominio_edilicio','associacao','outro')),
  address       jsonb not null default '{}'::jsonb,
  timezone      text not null default 'America/Sao_Paulo',
  settings      jsonb not null default '{}'::jsonb,
  branding      jsonb not null default '{}'::jsonb,
  status        text not null default 'active' check (status in ('active','inactive')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, id)
);
create index condominiums_tenant_idx on condominiums (tenant_id);
create unique index condominiums_doc_uq on condominiums (tenant_id, document) where document is not null;
create trigger condominiums_touch before update on condominiums for each row execute function touch_updated_at();

alter table user_role_assignments
  add constraint ura_condominium_fk foreign key (tenant_id, condominium_id) references condominiums (tenant_id, id);

create table buildings (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null,
  condominium_id  uuid not null,
  name            text not null,
  kind            text not null default 'bloco' check (kind in ('torre','bloco','quadra','rua','setor','outro')),
  created_at      timestamptz not null default now(),
  unique (tenant_id, id),
  unique (condominium_id, name),
  foreign key (tenant_id, condominium_id) references condominiums (tenant_id, id)
);

create table units (
  id                        uuid primary key default gen_random_uuid(),
  tenant_id                 uuid not null,
  condominium_id            uuid not null,
  building_id               uuid,
  identifier                text not null,
  kind                      text not null default 'apartamento' check (kind in ('apartamento','casa','lote','sala','loja','garagem','outro')),
  ideal_fraction            numeric(14,10) not null check (ideal_fraction > 0 and ideal_fraction <= 1),
  voting_status             text not null default 'eligible' check (voting_status in ('eligible','restricted')),
  voting_restriction_reason text,
  status                    text not null default 'active' check (status in ('active','inactive')),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, condominium_id) references condominiums (tenant_id, id),
  foreign key (tenant_id, building_id) references buildings (tenant_id, id),
  check (voting_status = 'eligible' or voting_restriction_reason is not null)
);
create unique index units_identifier_uq on units (condominium_id, building_id, identifier) nulls not distinct;
create index units_condo_idx on units (condominium_id);
create trigger units_touch before update on units for each row execute function touch_updated_at();

-- Pessoas físicas e jurídicas. CPF/CNPJ criptografado (AES-256-GCM na aplicação),
-- com índice cego (HMAC) para deduplicação e máscara para exibição.
create table people (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id),
  kind            text not null check (kind in ('pf','pj')),
  name            text not null,
  document_enc    text not null,
  document_hash   text not null,
  document_masked text not null,
  email           citext,
  phone           text,
  user_id         uuid references users(id),
  status          text not null default 'active' check (status in ('active','inactive')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, document_hash)
);
create unique index people_user_uq on people (tenant_id, user_id) where user_id is not null;
create index people_name_idx on people (tenant_id, lower(name));
create trigger people_touch before update on people for each row execute function touch_updated_at();

create table unit_ownerships (
  id                        uuid primary key default gen_random_uuid(),
  tenant_id                 uuid not null,
  unit_id                   uuid not null,
  person_id                 uuid not null,
  relation                  text not null check (relation in ('proprietario','coproprietario','promitente_comprador','usufrutuario','representante_legal')),
  share_percent             numeric(5,2) check (share_percent between 0 and 100),
  is_voting_representative  boolean not null default false,
  valid_from                date not null default current_date,
  ended_at                  timestamptz,
  ended_reason              text,
  created_at                timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, unit_id) references units (tenant_id, id),
  foreign key (tenant_id, person_id) references people (tenant_id, id)
);
create unique index ownership_active_uq on unit_ownerships (unit_id, person_id) where ended_at is null;
create unique index ownership_one_voter_uq on unit_ownerships (unit_id) where ended_at is null and is_voting_representative;
create index ownership_person_idx on unit_ownerships (person_id) where ended_at is null;

create table documents (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id),
  condominium_id  uuid,
  category        text not null,
  file_name       text not null,
  mime_type       text not null,
  size_bytes      bigint not null check (size_bytes >= 0),
  sha256          text not null,
  storage_key     text not null,
  uploaded_by     uuid references users(id),
  created_at      timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, condominium_id) references condominiums (tenant_id, id)
);

create table powers_of_attorney (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null,
  condominium_id      uuid not null,
  grantor_person_id   uuid not null,
  attorney_person_id  uuid not null,
  scope               text not null check (scope in ('assembly','general')),
  assembly_id         uuid,
  can_vote            boolean not null default true,
  can_speak           boolean not null default true,
  restrictions        text,
  valid_from          timestamptz not null,
  valid_until         timestamptz,
  status              text not null default 'pending' check (status in ('pending','approved','rejected','revoked','expired')),
  document_id         uuid,
  submitted_by        uuid references users(id),
  submitted_at        timestamptz not null default now(),
  reviewed_by         uuid references users(id),
  reviewed_at         timestamptz,
  review_notes        text,
  revoked_by          uuid references users(id),
  revoked_at          timestamptz,
  revoke_reason       text,
  unique (tenant_id, id),
  foreign key (tenant_id, condominium_id) references condominiums (tenant_id, id),
  foreign key (tenant_id, grantor_person_id) references people (tenant_id, id),
  foreign key (tenant_id, attorney_person_id) references people (tenant_id, id),
  foreign key (tenant_id, document_id) references documents (tenant_id, id),
  check (grantor_person_id <> attorney_person_id),
  check (scope = 'general' or assembly_id is not null),
  check (valid_until is null or valid_until > valid_from),
  check (status <> 'rejected' or review_notes is not null),
  check (status <> 'revoked' or revoke_reason is not null)
);
create index poa_condo_status_idx on powers_of_attorney (condominium_id, status);
create index poa_attorney_idx on powers_of_attorney (attorney_person_id);

create table poa_units (
  tenant_id  uuid not null,
  poa_id     uuid not null,
  unit_id    uuid not null,
  primary key (poa_id, unit_id),
  foreign key (tenant_id, poa_id) references powers_of_attorney (tenant_id, id) on delete cascade,
  foreign key (tenant_id, unit_id) references units (tenant_id, id)
);
create index poa_units_unit_idx on poa_units (unit_id);

create table poa_events (
  id         bigserial primary key,
  tenant_id  uuid not null,
  poa_id     uuid not null,
  event      text not null,
  actor_id   uuid,
  notes      text,
  at         timestamptz not null default clock_timestamp(),
  foreign key (tenant_id, poa_id) references powers_of_attorney (tenant_id, id)
);
create trigger poa_events_no_update before update or delete on poa_events
  for each row execute function forbid_mutation();
