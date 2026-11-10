-- =====================================================================
-- 0004 — Row-Level Security, funções SECURITY DEFINER controladas e
--        privilégios do papel da aplicação ({{APP_ROLE}}).
--
-- O papel da aplicação NÃO é superusuário e NÃO possui BYPASSRLS.
-- FORCE ROW LEVEL SECURITY garante que até o dono da tabela seja filtrado
-- (superusuários continuam ignorando RLS — por isso a aplicação nunca
-- se conecta como superusuário).
-- =====================================================================

do $$
declare
  t text;
  tenant_tables text[] := array[
    'condominiums','buildings','units','people','unit_ownerships','documents',
    'powers_of_attorney','poa_units','poa_events','quorum_rules','assemblies',
    'assembly_status_history','agenda_items','assembly_sessions','assembly_timeline_events',
    'accreditations','attendance_events','ballots','ballot_options','ballot_electorate',
    'votes','vote_participations','secret_ballot_entries','ballot_results'
  ];
begin
  foreach t in array tenant_tables loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())', t);
  end loop;
end
$$;

-- Auditoria: leitura restrita ao tenant corrente; cadeia da plataforma só com app.is_platform = on.
alter table audit_events enable row level security;
alter table audit_events force row level security;
create policy audit_select on audit_events for select using (
  (tenant_id is not null and tenant_id = app_current_tenant())
  or current_setting('app.is_platform', true) = 'on'
);
create policy audit_insert on audit_events for insert with check (
  tenant_id is null or tenant_id = app_current_tenant()
);

-- ---------------------------------------------------------------------
-- Funções SECURITY DEFINER (escopo mínimo, validação explícita)
-- ---------------------------------------------------------------------

-- Contextos (clientes/condomínios/perfis) do usuário autenticado. Só responde para o próprio usuário.
create or replace function user_contexts(p_user uuid)
returns table (tenant_id uuid, tenant_name text, tenant_kind text, condominium_id uuid, condominium_name text, role_code text)
language sql stable security definer set search_path = public as $$
  select a.tenant_id, t.name, t.kind, a.condominium_id, c.name, a.role_code
    from user_role_assignments a
    left join tenants t on t.id = a.tenant_id
    left join condominiums c on c.id = a.condominium_id
   where a.user_id = p_user
     and a.revoked_at is null
     and p_user = app_current_user()
     and (t.id is null or t.status = 'active')
$$;

-- Indicadores globais — exige contexto de plataforma.
create or replace function platform_overview()
returns table (metric text, value bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if coalesce(current_setting('app.is_platform', true), '') <> 'on' then
    raise exception 'Acesso restrito à plataforma' using errcode = '42501';
  end if;
  return query
    select 'tenants_active', count(*) from tenants where status = 'active'
    union all select 'condominiums', count(*) from condominiums where status = 'active'
    union all select 'units', count(*) from units where status = 'active'
    union all select 'users', count(*) from users where status = 'active'
    union all select 'assemblies_scheduled', count(*) from assemblies where status in ('approved_for_call','called','accreditation')
    union all select 'assemblies_live', count(*) from assemblies where status in ('in_progress','suspended')
    union all select 'assemblies_closed', count(*) from assemblies where status in ('closed','in_conference','archived')
    union all select 'ballots_open', count(*) from ballots where status = 'open';
end
$$;

-- Apuração de votação sigilosa: devolve somente agregados (sem ordem de inserção),
-- apenas após o encerramento e apenas para o tenant corrente.
create or replace function secret_ballot_tally(p_ballot uuid)
returns table (option_ids uuid[], ideal_fraction numeric, votes bigint)
language plpgsql stable security definer set search_path = public as $$
declare st text;
begin
  select b.status into st from ballots b where b.id = p_ballot and b.tenant_id = app_current_tenant();
  if st is null then
    raise exception 'Votação não encontrada' using errcode = 'P0002';
  end if;
  if st not in ('closed','tallied','declared') then
    raise exception 'Apuração sigilosa disponível somente após o encerramento' using errcode = '42501';
  end if;
  return query
    select e.option_ids, e.ideal_fraction, count(*)::bigint
      from secret_ballot_entries e
     where e.ballot_id = p_ballot and e.tenant_id = app_current_tenant()
     group by e.option_ids, e.ideal_fraction
     order by e.option_ids::text, e.ideal_fraction;
end
$$;

revoke all on function user_contexts(uuid) from public;
revoke all on function platform_overview() from public;
revoke all on function secret_ballot_tally(uuid) from public;

-- ---------------------------------------------------------------------
-- Privilégios do papel da aplicação
-- ---------------------------------------------------------------------
grant usage on schema public to {{APP_ROLE}};
grant select, insert, update, delete on all tables in schema public to {{APP_ROLE}};
grant usage, select on all sequences in schema public to {{APP_ROLE}};
grant execute on function user_contexts(uuid), platform_overview(), secret_ballot_tally(uuid),
  audit_verify_chain(text), app_current_tenant(), app_current_user() to {{APP_ROLE}};

-- Tabelas append-only: sem UPDATE/DELETE para a aplicação (além dos triggers).
revoke update, delete, truncate on
  audit_events, poa_events, assembly_status_history, assembly_timeline_events, attendance_events,
  ballot_electorate, votes, vote_participations, secret_ballot_entries, ballot_results
from {{APP_ROLE}};

-- Escolhas sigilosas: a aplicação só insere; leitura somente via função agregadora.
revoke select on secret_ballot_entries from {{APP_ROLE}};

-- Modelos de regra e catálogo de RBAC: somente leitura para a aplicação.
revoke insert, update, delete on rule_templates, roles, permissions, role_permissions from {{APP_ROLE}};

-- Controle de migrações não é acessível pela aplicação.
revoke all on schema_migrations from {{APP_ROLE}};
