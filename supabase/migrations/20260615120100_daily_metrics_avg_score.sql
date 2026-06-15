-- ============================================================================
--  daily_metrics(p_puzzle_id): add avg_score — the average golf score (lower is
--  better) over SOLVED plays of this daily, alongside the existing avg_guesses /
--  avg_seconds ("to complete"). Still aggregates only (no raw rows, no wiki), so
--  the owner-only-RLS-on-`plays` invariant is preserved.
--
--  Replaces the function created in 20260614012445_add_daily_metrics_rpc.sql
--  (added a column to the RETURNS TABLE). Postgres won't let CREATE OR REPLACE
--  change a function's OUT params / return type, so DROP it first, then recreate
--  and re-apply the grants.
-- ============================================================================
drop function if exists public.daily_metrics(text);
create or replace function public.daily_metrics(p_puzzle_id text)
returns table (
  players         int,
  solved          int,
  completion_pct  int,
  avg_guesses     numeric,
  avg_seconds     numeric,
  avg_score       numeric
)
language sql
security definer
set search_path = public
stable
as $$
  select
    count(*)::int                                                            as players,
    count(*) filter (where solved)::int                                      as solved,
    case when count(*) > 0
         then round(count(*) filter (where solved)::numeric / count(*) * 100)::int
         else 0 end                                                          as completion_pct,
    round(avg(total_guesses) filter (where solved), 1)                       as avg_guesses,
    round(avg(duration_seconds) filter (where solved and duration_seconds is not null)) as avg_seconds,
    round(avg(score) filter (where solved and score is not null), 1)         as avg_score
  from public.plays
  where puzzle_id = p_puzzle_id;
$$;

revoke execute on function public.daily_metrics(text) from public;
grant  execute on function public.daily_metrics(text) to anon, authenticated, service_role;
