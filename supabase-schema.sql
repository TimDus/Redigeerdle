-- ============================================================================
--  Redigeerdle — Supabase schema
--  Run this once in your project:  SQL Editor → New query → paste → Run.
--  Safe to re-run: everything is "if not exists" / "drop policy if exists".
-- ============================================================================

-- ---------------------------------------------------------------------------
-- puzzles: one daily puzzle per date. A puzzle is only a POINTER — the wiki
-- host plus a pinned revision id. The article text is NOT stored here; the
-- game fetches it live from the Fandom API at load time (and pinning the
-- revision keeps the puzzle reproducible). RLS allows public read.
-- ---------------------------------------------------------------------------
create table if not exists public.puzzles (
  id          text primary key,             -- e.g. "2026-06-11"
  date        date not null unique,
  wiki        text not null,                -- host, e.g. "harrypotter.fandom.com" (may include a /lang path)
  revision_id bigint not null,              -- pinned oldid so the text never drifts
  summary     text,                         -- optional plaintext hint shown by "Show hint summary"
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- wikis: the pool the automatic daily picker draws from. Edit this in the
-- Table editor to change which wikis are used — no code change or deploy.
-- Toggle `enabled` off to pause a wiki without deleting it. If this table is
-- empty or unreachable, the picker falls back to a baked-in list.
-- ---------------------------------------------------------------------------
create table if not exists public.wikis (
  host       text primary key,            -- e.g. "harrypotter.fandom.com" (may include a /lang path)
  enabled    boolean not null default true,
  added_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- picked: every article the daily picker has already used, so it never repeats
-- one. Stores the title (the answer), so this table is PRIVATE: RLS on with no
-- policy — only the picker's service_role key (which bypasses RLS) reads/writes
-- it. The anon/public client must never see it. The picker deletes rows older
-- than ~200 days (by created_at) so those articles become eligible again.
-- ---------------------------------------------------------------------------
create table if not exists public.picked (
  wiki       text not null,
  title      text not null,
  picked_on  date,
  created_at timestamptz not null default now(),  -- drives the 200-day re-eligibility
  primary key (wiki, title)
);

-- ---------------------------------------------------------------------------
-- profiles: public display name per signed-in user.
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  username   text unique,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- scores: one row per (user, daily date). Lower guesses = better.
-- FK points at profiles so the leaderboard can embed the username in one query.
-- ---------------------------------------------------------------------------
create table if not exists public.scores (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  puzzle_date date not null,
  guesses     int  not null,
  reveals     int  not null default 0,
  solved      boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (user_id, puzzle_date)
);

create index if not exists scores_date_guesses_idx
  on public.scores (puzzle_date, guesses);

-- ============================================================================
--  Row Level Security
-- ============================================================================
alter table public.puzzles  enable row level security;
alter table public.profiles enable row level security;
alter table public.scores   enable row level security;
alter table public.picked   enable row level security;
-- picked: no policy on purpose — it holds answers (titles). Only the daily
-- picker reads/writes it via the service_role key (which bypasses RLS).

alter table public.wikis    enable row level security;
-- wikis: public read — the in-game "random from a fandom" picker lists them.
-- Writes happen only from the daily picker via the service_role key (bypasses RLS).
drop policy if exists "wikis read" on public.wikis;
create policy "wikis read" on public.wikis
  for select using (true);

-- puzzles: anyone (even anonymous) may read; nobody writes from the client.
drop policy if exists "puzzles read" on public.puzzles;
create policy "puzzles read" on public.puzzles
  for select using (true);

-- profiles: anyone may read (leaderboard names); you may write only your own.
drop policy if exists "profiles read" on public.profiles;
create policy "profiles read" on public.profiles
  for select using (true);

drop policy if exists "profiles insert own" on public.profiles;
create policy "profiles insert own" on public.profiles
  for insert with check (auth.uid() = id);

drop policy if exists "profiles update own" on public.profiles;
create policy "profiles update own" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- scores: anyone may read (leaderboard); you may write only your own rows.
drop policy if exists "scores read" on public.scores;
create policy "scores read" on public.scores
  for select using (true);

drop policy if exists "scores insert own" on public.scores;
create policy "scores insert own" on public.scores
  for insert with check (auth.uid() = user_id);

drop policy if exists "scores update own" on public.scores;
create policy "scores update own" on public.scores
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================================
--  Seed one working example puzzle (Golden Snitch on the Harry Potter wiki).
--  Replace / add rows as you curate more days — see "Adding new daily puzzles"
--  in SUPABASE_SETUP.md.
-- ============================================================================
insert into public.puzzles (id, date, wiki, revision_id, summary)
values (
  '2026-06-10',
  '2026-06-10',
  'harrypotter.fandom.com',
  2006074,
  'A small winged ball; catching it ends the match and scores big.'
)
on conflict (id) do nothing;

-- ============================================================================
--  Seed the wiki pool for the automatic daily picker. Add/remove rows or flip
--  `enabled` here or in the Table editor — no code change needed.
-- ============================================================================
insert into public.wikis (host) values
  ('harrypotter.fandom.com'), ('starwars.fandom.com'), ('marvel.fandom.com'), ('dc.fandom.com'),
  ('minecraft.fandom.com'), ('naruto.fandom.com'), ('onepiece.fandom.com'), ('pokemon.fandom.com'),
  ('elderscrolls.fandom.com'), ('fallout.fandom.com'), ('witcher.fandom.com'), ('lotr.fandom.com'),
  ('disney.fandom.com'), ('residentevil.fandom.com'), ('finalfantasy.fandom.com'), ('zelda.fandom.com'),
  ('memory-alpha.fandom.com'), ('avatar.fandom.com'), ('masseffect.fandom.com'), ('dragonage.fandom.com'),
  ('halo.fandom.com'), ('godofwar.fandom.com'), ('kingdomhearts.fandom.com')
on conflict (host) do nothing;
