-- hint_cache: a long-lived, cross-puzzle hint store keyed by the article's STABLE
-- identity — (wiki_host, page_id). A MediaWiki page_id survives renames, moves and
-- heavy edits (only delete+recreate mints a new one), unlike revision_id (changes every
-- edit) or the title (the answer + changes on rename). So the LLM hint packet for an
-- article is generated ONCE and reused forever after — across dailies on different dates,
-- archived-daily replays, and (popular/curated) random games for the same page — instead
-- of re-hitting the rate-limited LLM. The `hint` Edge Function reads/writes this; the
-- per-puzzle puzzles.summary cache still fronts it (a daily that already generated never
-- looks here again).
--
-- `packet` holds the same leak-filtered JSON string as puzzles.summary (category/summary/
-- synonyms/first_letter) — it NEVER contains the title. `updated_at` drives the staleness
-- guard: the Edge Function treats a packet older than its CACHE_STALE_MS (180d) as a miss
-- and regenerates, so an article that's been substantially rewritten eventually refreshes.
create table if not exists public.hint_cache (
  wiki_host  text        not null,
  page_id    bigint      not null,
  packet     text        not null,
  updated_at timestamptz not null default now(),
  primary key (wiki_host, page_id)
);

-- RLS on, NO policy — like `picked`. Only the Edge Function's service_role key (which
-- bypasses RLS) reads/writes this; the browser never touches it (the client always gets
-- hints THROUGH the function). Packets are leak-filtered, so this is private-for-tidiness,
-- not because it holds secrets.
alter table public.hint_cache enable row level security;
