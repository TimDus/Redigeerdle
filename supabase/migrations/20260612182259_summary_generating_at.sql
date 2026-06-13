-- ============================================================================
--  Lazy hint generation: a "claim" marker so concurrent first-clickers don't
--  both call Groq for the same puzzle. The hint Edge Function atomically claims
--  a row (sets summary_generating_at = now() WHERE summary IS NULL AND the claim
--  is free/stale), generates the summary, and writes it back. A loser sees the
--  claim and returns "pending"; the client polls until summary is set. The
--  30-second staleness window lets a crashed generation be retried.
--  No policy needed: only the Edge Function's service_role touches this column.
-- ============================================================================
alter table public.puzzles
  add column if not exists summary_generating_at timestamptz;
