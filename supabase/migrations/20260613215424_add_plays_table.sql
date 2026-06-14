-- ============================================================================
--  plays: a per-player log of every FINISHED game (solved or gave up), across
--  ALL game types — featured/fandom dailies AND random/curated/custom games.
--  This is a private play-log, NOT the leaderboard (that stays in `scores`).
--
--  Why a separate table:
--   - `scores` is unique(user_id, puzzle_date), puzzle_date NOT NULL, and is
--     PUBLICLY readable (it feeds the leaderboard). Random/custom games have no
--     date and no unique identity, and per-fandom dailies share a date — none of
--     that fits `scores` without breaking its constraints / leaderboard query.
--   - `plays` records the `wiki` host for every row, so later fandom-stats
--     aggregates (GROUP BY wiki) can include dailies AND random plays alike.
--
--  Visibility: OWNER-ONLY read (like `follows`). Raw rows stay private — so a
--  row's `wiki` can never leak today's featured-daily source (itself a paid hint)
--  to other players. Public per-fandom aggregates come later via a
--  `security definer` RPC that returns only aggregated numbers, never raw rows.
-- ============================================================================

create table if not exists public.plays (
  id            bigint generated always as identity primary key,
  -- references auth.users (NOT profiles): anonymous guest sessions log plays too, and
  -- they have no profile row. The merge re-parents these rows to a real account on
  -- sign-in (see merge_anon_plays below).
  user_id       uuid not null references auth.users(id) on delete cascade,
  -- stable per-play key the client upserts against, so an in-progress game updates
  -- ONE row (instead of inserting per guess). Dailies use their puzzle_id (so a
  -- resume across reloads keeps the same row); random/custom games use a
  -- client-generated id minted at game start.
  play_id       text not null,
  -- 'featured_daily' | 'fandom_daily' | 'full_random' | 'curated_random'
  -- | 'fandom_random' | 'custom'
  game_type     text not null,
  wiki          text,                 -- source host (null only if unknown)
  puzzle_date   date,                 -- set for dailies, null for random/custom
  puzzle_id     text,                 -- puzzles.id for dailies, null otherwise
  total_guesses int  not null default 0,
  good_guesses  int  not null default 0,   -- typed guesses that revealed >=1 word
  wrong_guesses int  not null default 0,   -- typed guesses that revealed nothing
  reveals       int  not null default 0,   -- paid free-word reveals used
  revealed_pct  int,                        -- % of non-stop words uncovered THROUGH PLAY (not the post-game reveal-all)
  revision_id   bigint,                      -- exact article revision played (a pointer, like puzzles.revision_id; never the answer text)
  summary_used  boolean not null default false,
  source_used   boolean not null default false,
  gave_up       boolean not null default false,
  solved        boolean not null default false,
  started_at    timestamptz,                 -- when the article first loaded (wall-clock; persisted across daily resumes)
  duration_seconds int,                      -- finish minus start, wall-clock (includes idle/away time)
  created_at    timestamptz not null default now(),
  -- one row per (user, play): the client upserts this row on every guess while the
  -- game is in progress (solved=false, gave_up=false) and again at finish. A game
  -- that's started but never finished simply stays as an unfinished row. Dailies
  -- key play_id to their puzzle_id so a resume updates the same row; random/custom
  -- get a fresh play_id per game, so each is its own row.
  unique (user_id, play_id)
);

create index if not exists plays_user_idx       on public.plays (user_id);
create index if not exists plays_wiki_type_idx   on public.plays (wiki, game_type);
-- find a user's still-unfinished games quickly (e.g. "resume / abandoned" views)
create index if not exists plays_unfinished_idx  on public.plays (user_id)
  where not solved and not gave_up;

alter table public.plays enable row level security;

-- plays: a private play-log — you may read/write only your OWN rows.
drop policy if exists "plays read own" on public.plays;
create policy "plays read own" on public.plays
  for select using (auth.uid() = user_id);

drop policy if exists "plays insert own" on public.plays;
create policy "plays insert own" on public.plays
  for insert with check (auth.uid() = user_id);

drop policy if exists "plays update own" on public.plays;
create policy "plays update own" on public.plays
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================================
--  merge_anon_plays: re-parent a guest's plays onto a real account on sign-in.
--  Called ONLY by the `merge-anon` Edge Function via the service_role key (which
--  has already validated that the caller owned both the anon and the real user).
--  SECURITY DEFINER so it bypasses RLS; EXECUTE is revoked from anon/authenticated
--  so a malicious client can't call it directly to steal another guest's data.
--
--  Conflict policy ("best / most complete wins") when the same play_id exists under
--  both users: a finished game beats in-progress, solved beats gave_up, then more
--  total_guesses; an exact tie keeps the EXISTING real row (deterministic).
--  Ranking score: solved → +1e9, else gave_up → +5e8, else 0; plus total_guesses.
-- ============================================================================
create or replace function public.merge_anon_plays(p_anon uuid, p_real uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_anon is null or p_real is null or p_anon = p_real then return; end if;

  -- for play_ids present under BOTH users, drop the loser so the survivor can move.
  -- the real row wins ties (>=), so delete the anon row when real scores >= anon:
  delete from public.plays a
  using public.plays r
  where a.user_id = p_anon and r.user_id = p_real and r.play_id = a.play_id
    and ( (case when r.solved then 1000000000 when r.gave_up then 500000000 else 0 end) + coalesce(r.total_guesses,0) )
     >= ( (case when a.solved then 1000000000 when a.gave_up then 500000000 else 0 end) + coalesce(a.total_guesses,0) );

  -- ...and delete the real row when the anon row scores strictly higher:
  delete from public.plays r
  using public.plays a
  where r.user_id = p_real and a.user_id = p_anon and a.play_id = r.play_id
    and ( (case when a.solved then 1000000000 when a.gave_up then 500000000 else 0 end) + coalesce(a.total_guesses,0) )
      > ( (case when r.solved then 1000000000 when r.gave_up then 500000000 else 0 end) + coalesce(r.total_guesses,0) );

  -- no play_id now collides between the two users → re-parent the rest to the account
  update public.plays set user_id = p_real where user_id = p_anon;
end;
$$;

-- only the Edge Function (service_role) may call this; revoking PUBLIC also drops
-- service_role's implicit grant, so re-grant it explicitly.
revoke execute on function public.merge_anon_plays(uuid, uuid) from public, anon, authenticated;
grant  execute on function public.merge_anon_plays(uuid, uuid) to service_role;
