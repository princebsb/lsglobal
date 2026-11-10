-- =====================================================================
-- 0003 — Regras versionadas, assembleias, pauta, sessões, linha do tempo,
--        credenciamento, presença e motor de votação.
-- =====================================================================

-- Modelos globais (não vigentes) — copiados para o condomínio como rascunho.
create table rule_templates (
  code        text primary key,
  name        text not null,
  legal_basis text not null,
  definition  jsonb not null,
  notes       text,
  updated_at  timestamptz not null default now()
);

create table quorum_rules (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null,
  condominium_id  uuid not null,
  code            text not null,
  version         integer not null check (version >= 1),
  name            text not null,
  purpose         text not null check (purpose in ('presence','approval')),
  legal_basis     text not null,
  definition      jsonb not null,
  status          text not null default 'draft' check (status in ('draft','approved','retired')),
  effective_from  date not null,
  template_code   text references rule_templates(code),
  created_by      uuid references users(id),
  created_at      timestamptz not null default now(),
  approved_by     uuid references users(id),
  approved_at     timestamptz,
  approval_notes  text,
  retired_at      timestamptz,
  unique (tenant_id, id),
  unique (condominium_id, code, version),
  foreign key (tenant_id, condominium_id) references condominiums (tenant_id, id),
  check (status = 'draft' or (approved_by is not null and approved_at is not null and approval_notes is not null))
);

-- Regra homologada é imutável: só pode passar a "retired".
create or replace function quorum_rules_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'Regra homologada não pode ser excluída' using errcode = 'P0001';
    end if;
    return old;
  end if;
  if old.status = 'approved' then
    if new.status <> 'retired'
       or new.definition <> old.definition or new.legal_basis <> old.legal_basis
       or new.version <> old.version or new.code <> old.code or new.purpose <> old.purpose then
      raise exception 'Regra homologada é imutável; crie nova versão' using errcode = 'P0001';
    end if;
  elsif old.status = 'retired' then
    raise exception 'Regra retirada é imutável' using errcode = 'P0001';
  end if;
  return new;
end
$$;
create trigger quorum_rules_guard_trg before update or delete on quorum_rules
  for each row execute function quorum_rules_guard();

-- ---------------------------------------------------------------------
-- Assembleias
-- ---------------------------------------------------------------------
create table assemblies (
  id                            uuid primary key default gen_random_uuid(),
  tenant_id                     uuid not null,
  condominium_id                uuid not null,
  code                          text not null,
  title                         text not null,
  kind                          text not null check (kind in ('AGO','AGE','especial','outra')),
  modality                      text not null check (modality in ('presencial','virtual','hibrida')),
  status                        text not null default 'draft' check (status in ('draft','in_review','approved_for_call','called','accreditation','in_progress','suspended','closed','in_conference','archived','cancelled')),
  timezone                      text not null,
  location                      text,
  first_call_at                 timestamptz not null,
  second_call_at                timestamptz,
  permanent_session             boolean not null default false,
  first_call_presence_rule_id   uuid,
  second_call_presence_rule_id  uuid,
  rules_homologated_at          timestamptz,
  rules_homologated_by          uuid references users(id),
  rules_homologation_notes      text,
  settings                      jsonb not null default '{}'::jsonb,
  created_by                    uuid references users(id),
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  unique (tenant_id, id),
  unique (condominium_id, code),
  foreign key (tenant_id, condominium_id) references condominiums (tenant_id, id),
  foreign key (tenant_id, first_call_presence_rule_id) references quorum_rules (tenant_id, id),
  foreign key (tenant_id, second_call_presence_rule_id) references quorum_rules (tenant_id, id),
  check (second_call_at is null or second_call_at > first_call_at)
);
create index assemblies_condo_idx on assemblies (condominium_id, first_call_at desc);
create index assemblies_tenant_status_idx on assemblies (tenant_id, status);
create trigger assemblies_touch before update on assemblies for each row execute function touch_updated_at();

alter table powers_of_attorney
  add constraint poa_assembly_fk foreign key (tenant_id, assembly_id) references assemblies (tenant_id, id);

create table assembly_status_history (
  id           bigserial primary key,
  tenant_id    uuid not null,
  assembly_id  uuid not null,
  from_status  text,
  to_status    text not null,
  actor_id     uuid,
  reason       text,
  at           timestamptz not null default clock_timestamp(),
  foreign key (tenant_id, assembly_id) references assemblies (tenant_id, id)
);
create trigger ash_no_update before update or delete on assembly_status_history
  for each row execute function forbid_mutation();

create table agenda_items (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  assembly_id  uuid not null,
  position     integer not null check (position >= 1),
  title        text not null,
  description  text,
  item_type    text not null default 'deliberativo' check (item_type in ('deliberativo','informativo')),
  created_at   timestamptz not null default now(),
  unique (tenant_id, id),
  unique (assembly_id, position) deferrable initially immediate,
  foreign key (tenant_id, assembly_id) references assemblies (tenant_id, id)
);

create table assembly_sessions (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  assembly_id  uuid not null,
  seq          integer not null,
  call_number  smallint not null check (call_number in (1,2)),
  started_at   timestamptz not null default clock_timestamp(),
  started_by   uuid references users(id),
  ended_at     timestamptz,
  ended_by     uuid references users(id),
  end_reason   text,
  unique (tenant_id, id),
  unique (assembly_id, seq),
  foreign key (tenant_id, assembly_id) references assemblies (tenant_id, id)
);
create unique index sessions_one_open_uq on assembly_sessions (assembly_id) where ended_at is null;

create table assembly_timeline_events (
  id           bigserial primary key,
  tenant_id    uuid not null,
  assembly_id  uuid not null,
  session_id   uuid,
  kind         text not null,
  ref_id       uuid,
  payload      jsonb not null default '{}'::jsonb,
  actor_id     uuid,
  occurred_at  timestamptz not null default clock_timestamp(),
  foreign key (tenant_id, assembly_id) references assemblies (tenant_id, id)
);
create index timeline_assembly_idx on assembly_timeline_events (assembly_id, occurred_at);
create trigger timeline_no_update before update or delete on assembly_timeline_events
  for each row execute function forbid_mutation();

-- ---------------------------------------------------------------------
-- Credenciamento e presença
-- Uma unidade só pode ter UM credenciamento ativo por assembleia,
-- o que impede dupla contagem (coproprietários, vários dispositivos).
-- ---------------------------------------------------------------------
create table accreditations (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null,
  assembly_id     uuid not null,
  unit_id         uuid not null,
  person_id       uuid not null,
  basis           text not null check (basis in ('titular','procuracao')),
  poa_id          uuid,
  mode            text not null check (mode in ('presencial','remoto')),
  accredited_by   uuid references users(id),
  accredited_at   timestamptz not null default clock_timestamp(),
  revoked_at      timestamptz,
  revoked_by      uuid references users(id),
  revoke_reason   text,
  unique (tenant_id, id),
  foreign key (tenant_id, assembly_id) references assemblies (tenant_id, id),
  foreign key (tenant_id, unit_id) references units (tenant_id, id),
  foreign key (tenant_id, person_id) references people (tenant_id, id),
  foreign key (tenant_id, poa_id) references powers_of_attorney (tenant_id, id),
  check (basis = 'titular' or poa_id is not null),
  check (revoked_at is null or revoke_reason is not null)
);
create unique index accreditation_active_uq on accreditations (assembly_id, unit_id) where revoked_at is null;
create index accreditation_person_idx on accreditations (assembly_id, person_id) where revoked_at is null;

create table attendance_events (
  id               bigserial primary key,
  tenant_id        uuid not null,
  assembly_id      uuid not null,
  accreditation_id uuid,
  person_id        uuid,
  user_id          uuid,
  event            text not null check (event in ('accredited','accreditation_revoked','checkin','checkout','connect','disconnect')),
  mode             text,
  at               timestamptz not null default clock_timestamp(),
  foreign key (tenant_id, assembly_id) references assemblies (tenant_id, id)
);
create index attendance_assembly_idx on attendance_events (assembly_id, at);
create trigger attendance_no_update before update or delete on attendance_events
  for each row execute function forbid_mutation();

-- ---------------------------------------------------------------------
-- Votações
-- ---------------------------------------------------------------------
create table ballots (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null,
  assembly_id           uuid not null,
  agenda_item_id        uuid not null,
  round                 integer not null default 1 check (round >= 1),
  title                 text not null,
  question              text not null,
  ballot_type           text not null check (ballot_type in ('yes_no','single_choice','multiple_choice','election')),
  max_choices           integer not null default 1 check (max_choices >= 1),
  seats                 integer not null default 1 check (seats >= 1),
  secrecy               text not null default 'nominal' check (secrecy in ('nominal','secret')),
  approval_rule_id      uuid not null,
  presence_rule_id      uuid,
  allow_vote_change     boolean not null default false,
  show_partial_results  boolean not null default false,
  status                text not null default 'prepared' check (status in ('prepared','open','closed','tallied','declared','cancelled')),
  session_id            uuid,
  call_number           smallint check (call_number in (1,2)),
  electorate_units      integer,
  electorate_fraction   numeric(20,10),
  opened_at             timestamptz,
  opened_by             uuid references users(id),
  closed_at             timestamptz,
  closed_by             uuid references users(id),
  cancelled_at          timestamptz,
  cancelled_by          uuid references users(id),
  cancel_reason         text,
  declared_result_id    uuid,
  declared_at           timestamptz,
  declared_by           uuid references users(id),
  created_by            uuid references users(id),
  created_at            timestamptz not null default now(),
  unique (tenant_id, id),
  unique (agenda_item_id, round),
  foreign key (tenant_id, assembly_id) references assemblies (tenant_id, id),
  foreign key (tenant_id, agenda_item_id) references agenda_items (tenant_id, id),
  foreign key (tenant_id, approval_rule_id) references quorum_rules (tenant_id, id),
  foreign key (tenant_id, presence_rule_id) references quorum_rules (tenant_id, id),
  foreign key (tenant_id, session_id) references assembly_sessions (tenant_id, id),
  check (not (secrecy = 'secret' and allow_vote_change)),
  check (status <> 'cancelled' or cancel_reason is not null)
);
create index ballots_assembly_idx on ballots (assembly_id, status);

create table ballot_options (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null,
  ballot_id  uuid not null,
  position   integer not null,
  label      text not null,
  kind       text not null default 'regular' check (kind in ('regular','yes','no','abstention','blank','null')),
  unique (tenant_id, id),
  unique (ballot_id, position),
  foreign key (tenant_id, ballot_id) references ballots (tenant_id, id)
);

-- Snapshot da base eleitoral no momento da abertura (preserva o contexto histórico).
create table ballot_electorate (
  tenant_id             uuid not null,
  ballot_id             uuid not null,
  unit_id               uuid not null,
  ideal_fraction        numeric(14,10) not null,
  eligible              boolean not null,
  ineligibility_reason  text,
  present_at_open       boolean not null default false,
  primary key (ballot_id, unit_id),
  foreign key (tenant_id, ballot_id) references ballots (tenant_id, id),
  foreign key (tenant_id, unit_id) references units (tenant_id, id)
);
create trigger electorate_no_update before update or delete on ballot_electorate
  for each row execute function forbid_mutation();

-- Votos nominais: append-only e versionados. O voto vigente é a maior versão.
create table votes (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  ballot_id         uuid not null,
  unit_id           uuid not null,
  version           integer not null check (version >= 1),
  accreditation_id  uuid not null,
  cast_by_person_id uuid not null,
  cast_by_user_id   uuid not null,
  basis             text not null check (basis in ('titular','procuracao')),
  poa_id            uuid,
  ideal_fraction    numeric(14,10) not null,
  option_ids        uuid[] not null check (cardinality(option_ids) >= 1),
  idempotency_key   text not null,
  receipt_code      text not null,
  cast_at           timestamptz not null default clock_timestamp(),
  prev_hash         text,
  hash              text,
  unique (tenant_id, id),
  unique (ballot_id, unit_id, version),
  unique (ballot_id, idempotency_key),
  foreign key (tenant_id, ballot_id) references ballots (tenant_id, id),
  foreign key (tenant_id, unit_id) references units (tenant_id, id),
  foreign key (tenant_id, accreditation_id) references accreditations (tenant_id, id),
  foreign key (tenant_id, cast_by_person_id) references people (tenant_id, id)
);
create index votes_ballot_idx on votes (ballot_id, unit_id, version desc);

create or replace function votes_chain() returns trigger
language plpgsql as $$
declare last_hash text;
begin
  perform pg_advisory_xact_lock(hashtextextended('votes:' || new.ballot_id::text, 0));
  select hash into last_hash from votes where ballot_id = new.ballot_id order by cast_at desc, id desc limit 1;
  new.cast_at := clock_timestamp();
  new.prev_hash := coalesce(last_hash, repeat('0', 64));
  new.hash := encode(digest(concat_ws('|', new.prev_hash, new.id::text, new.ballot_id::text, new.unit_id::text,
      new.version::text, array_to_string(new.option_ids, ','), new.ideal_fraction::text,
      new.cast_by_person_id::text, new.receipt_code,
      to_char(new.cast_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')), 'sha256'), 'hex');
  return new;
end
$$;
create trigger votes_chain_trg before insert on votes for each row execute function votes_chain();
create trigger votes_no_update before update or delete on votes for each row execute function forbid_mutation();
create trigger votes_no_truncate before truncate on votes for each statement execute function forbid_mutation();

-- Votação sigilosa: participação (quem votou) separada da escolha (o que votou).
create table vote_participations (
  tenant_id         uuid not null,
  ballot_id         uuid not null,
  unit_id           uuid not null,
  accreditation_id  uuid not null,
  cast_by_person_id uuid not null,
  cast_by_user_id   uuid not null,
  idempotency_key   text not null,
  receipt_code      text not null,
  cast_at           timestamptz not null default clock_timestamp(),
  primary key (ballot_id, unit_id),
  unique (ballot_id, idempotency_key),
  foreign key (tenant_id, ballot_id) references ballots (tenant_id, id),
  foreign key (tenant_id, unit_id) references units (tenant_id, id),
  foreign key (tenant_id, accreditation_id) references accreditations (tenant_id, id)
);
create trigger vp_no_update before update or delete on vote_participations
  for each row execute function forbid_mutation();

-- Sem unidade, pessoa ou horário. Leitura direta é revogada do papel da aplicação;
-- a apuração usa a função agregadora secret_ballot_tally().
create table secret_ballot_entries (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null,
  ballot_id       uuid not null,
  option_ids      uuid[] not null check (cardinality(option_ids) >= 1),
  ideal_fraction  numeric(14,10) not null,
  foreign key (tenant_id, ballot_id) references ballots (tenant_id, id)
);
create trigger sbe_no_update before update or delete on secret_ballot_entries
  for each row execute function forbid_mutation();

-- Resultados de apuração (append-only; cada reapuração gera novo registro).
create table ballot_results (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  ballot_id        uuid not null,
  computed_at      timestamptz not null default clock_timestamp(),
  computed_by      uuid references users(id),
  outcome          text not null,
  declarable       boolean not null,
  tally            jsonb not null,
  rule_snapshot    jsonb not null,
  votes_head_hash  text,
  result_hash      text not null,
  unique (tenant_id, id),
  foreign key (tenant_id, ballot_id) references ballots (tenant_id, id)
);
create index results_ballot_idx on ballot_results (ballot_id, computed_at desc);
create trigger results_no_update before update or delete on ballot_results
  for each row execute function forbid_mutation();

alter table ballots
  add constraint ballots_declared_result_fk foreign key (tenant_id, declared_result_id) references ballot_results (tenant_id, id);
