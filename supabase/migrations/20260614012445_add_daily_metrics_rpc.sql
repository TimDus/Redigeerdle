-- ============================================================================
--  daily_metrics(p_puzzle_id): public aggregate over the private `plays` log for
--  ONE daily puzzle — avg guesses, avg time-to-complete, completion %.
--
--  `plays` has owner-only RLS (raw rows are private — a row's `wiki` could leak
--  today's featured source). This is the planned "public stats come via a
--  security definer RPC that returns only aggregated numbers, never raw rows"
--  path: it bypasses RLS but exposes nothing but counts/averages for the puzzle
--  the caller already knows (no `wiki`, no per-row data), so the invariant holds.
--
--  Stats are keyed by `puzzle_id` (the exact daily — featured or per-fandom), so
--  fandoms that share a date don't blur together. "players" = everyone who has a
--  row for this puzzle (recordPlay only writes after real interaction). Averages
--  are over SOLVED plays only — "to complete" — while completion % uses every
--  player as the denominator.
-- ============================================================================
create or replace function public.daily_metrics(p_puzzle_id text)
returns table (
  players         int,
  solved          int,
  completion_pct  int,
  avg_guesses     numeric,
  avg_seconds     numeric
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
    round(avg(duration_seconds) filter (where solved and duration_seconds is not null)) as avg_seconds
  from public.plays
  where puzzle_id = p_puzzle_id;
$$;

-- only return aggregates to clients; the function reads `plays` as its definer.
revoke execute on function public.daily_metrics(text) from public;
grant  execute on function public.daily_metrics(text) to anon, authenticated, service_role;
