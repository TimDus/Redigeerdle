-- ============================================================================
--  follows: the fandoms a signed-in user wants in their daily feed (one row per
--  user+wiki). Private to each user via RLS. Logged-out users keep their picks
--  in localStorage instead; the client merges those into the account on login.
--  The future per-fandom picker reads this (via service_role, bypassing RLS) to
--  decide which fandoms have followers worth generating a daily for.
-- ============================================================================
create table if not exists public.follows (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  wiki       text not null,                 -- host, matches wikis.host / puzzles.wiki
  created_at timestamptz not null default now(),
  primary key (user_id, wiki)
);

alter table public.follows enable row level security;

-- own-only: a user reads/writes only their own follow rows.
drop policy if exists "follows read own" on public.follows;
create policy "follows read own" on public.follows
  for select using (auth.uid() = user_id);

drop policy if exists "follows insert own" on public.follows;
create policy "follows insert own" on public.follows
  for insert with check (auth.uid() = user_id);

drop policy if exists "follows delete own" on public.follows;
create policy "follows delete own" on public.follows
  for delete using (auth.uid() = user_id);
