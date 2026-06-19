-- Account deletion with a 7-day grace period (cancelable).
--
-- The client SETS this to now() ("Delete my account") and CLEARS it to null
-- ("Cancel deletion") through the existing owner-only "profiles update own"
-- policy — no new policy needed (RLS is row-scoped, not column-scoped).
--
-- A daily job (scripts/purge-deletions.mjs, run by the daily-puzzle GitHub
-- Action with the service_role key) hard-deletes the auth.users row of any
-- account whose request is older than 7 days. Every user FK cascades from
-- auth.users (profiles ON DELETE CASCADE; scores/follows cascade from profiles;
-- plays references auth.users directly with ON DELETE CASCADE), so deleting the
-- auth user removes ALL of the player's data in one step.
alter table public.profiles
  add column if not exists deletion_requested_at timestamptz;
