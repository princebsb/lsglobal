-- =====================================================================
-- 0005 — Snapshot de presença no encerramento da votação.
-- A presença considerada na apuração é congelada no momento do
-- encerramento: unidades elegíveis com credenciamento ativo OU com voto.
-- =====================================================================

alter table ballots
  add column closed_present_unit_ids uuid[],
  add column closed_present_units integer,
  add column closed_present_fraction numeric(20,10);

-- Uma vez preenchido, o snapshot não pode ser alterado.
create or replace function ballots_guard() returns trigger
language plpgsql as $$
begin
  if old.closed_present_unit_ids is not null and
     (new.closed_present_unit_ids is distinct from old.closed_present_unit_ids
      or new.closed_present_units is distinct from old.closed_present_units
      or new.closed_present_fraction is distinct from old.closed_present_fraction) then
    raise exception 'Snapshot de presença da votação é imutável' using errcode = 'P0001';
  end if;
  if old.electorate_units is not null and
     (new.electorate_units is distinct from old.electorate_units
      or new.electorate_fraction is distinct from old.electorate_fraction) then
    raise exception 'Base eleitoral da votação é imutável' using errcode = 'P0001';
  end if;
  if old.status in ('declared','cancelled') then
    raise exception 'Votação em estado final não pode ser alterada' using errcode = 'P0001';
  end if;
  if old.status <> 'prepared' and
     (new.approval_rule_id is distinct from old.approval_rule_id
      or new.presence_rule_id is distinct from old.presence_rule_id
      or new.ballot_type is distinct from old.ballot_type
      or new.secrecy is distinct from old.secrecy
      or new.question is distinct from old.question) then
    raise exception 'Configuração da votação não pode mudar após a abertura' using errcode = 'P0001';
  end if;
  return new;
end
$$;
create trigger ballots_guard_trg before update on ballots for each row execute function ballots_guard();
create trigger ballots_no_delete before delete on ballots for each row execute function forbid_mutation();

-- Opções não podem ser alteradas depois que a votação sai de "preparada".
create or replace function ballot_options_guard() returns trigger
language plpgsql as $$
declare st text;
begin
  if tg_op = 'DELETE' then
    select status into st from ballots where id = old.ballot_id;
  else
    select status into st from ballots where id = new.ballot_id;
  end if;
  if st is distinct from 'prepared' then
    raise exception 'Opções só podem ser alteradas com a votação preparada' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$$;
create trigger ballot_options_guard_trg before insert or update or delete on ballot_options
  for each row execute function ballot_options_guard();
