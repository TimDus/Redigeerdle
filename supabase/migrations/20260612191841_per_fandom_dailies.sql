-- ============================================================================
--  Per-fandom dailies: one daily puzzle per (wiki, date) instead of one global
--  puzzle per date. The nightly picker now generates a daily for every enabled
--  wiki and marks ONE as `is_featured` — the puzzle shown on the home page (and
--  to anonymous visitors). The personalised feed shows the dailies for the
--  fandoms a user follows.
--
--  Row id convention going forward: "<date>:<wiki>" (e.g. "2026-06-20:zelda.fandom.com").
--  Older rows keep their bare-date id; the backfill marks them featured so the
--  home page keeps working for those dates.
-- ============================================================================

-- the daily is no longer unique per date — drop that, add per-fandom uniqueness
alter table public.puzzles drop constraint if exists puzzles_date_key;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'puzzles_wiki_date_key') then
    alter table public.puzzles add constraint puzzles_wiki_date_key unique (wiki, date);
  end if;
end $$;

-- which daily is the home-page / anonymous puzzle for its date
alter table public.puzzles add column if not exists is_featured boolean not null default false;

-- existing single dailies were the home puzzle for their date — keep them featured
update public.puzzles set is_featured = true where is_featured = false;

-- the home query is "latest featured puzzle on or before today"
create index if not exists puzzles_featured_date_idx
  on public.puzzles (date desc) where is_featured;
