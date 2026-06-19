-- Add revision_id to hint_cache so staleness is keyed on CONTENT change, not just age.
-- A MediaWiki revision_id bumps on every edit, so it's a precise "did the article change?"
-- signal: if the cached packet's revision matches (or is newer than) the requested one, the
-- content hasn't changed and we keep the packet FOREVER — even past the old 180d guard;
-- only a NEWER requested revision (the page was edited since we cached) forces a regen.
-- Nullable so pre-existing rows degrade to the time-based guard until they next regenerate.
alter table public.hint_cache add column if not exists revision_id bigint;
