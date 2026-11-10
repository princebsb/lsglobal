-- =====================================================================
-- 0006 — A trigger da cadeia de auditoria precisa ler o último elo de
-- QUALQUER cadeia (inclusive a da plataforma), independentemente do RLS
-- de leitura aplicado ao papel da aplicação. Executa como dono da função.
-- A trigger de votos também passa a ignorar o RLS para garantir que o
-- encadeamento considere todos os votos da votação.
-- =====================================================================

alter function audit_events_chain() security definer;
alter function audit_events_chain() set search_path = public;
alter function votes_chain() security definer;
alter function votes_chain() set search_path = public;
revoke all on function audit_events_chain() from public;
revoke all on function votes_chain() from public;
