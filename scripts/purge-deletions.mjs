#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Hard-delete accounts whose deletion was requested more than GRACE_DAYS ago.

   The client schedules a deletion by setting profiles.deletion_requested_at =
   now() (and cancels by clearing it) through the owner-only RLS policy. This
   job — run daily by the daily-puzzle GitHub Action — deletes the auth.users
   row of anyone past the grace period. Every per-user FK cascades from
   auth.users (profiles ON DELETE CASCADE → scores/follows; plays references
   auth.users directly), so one admin delete removes ALL of the player's data.

   Cancelable: a user who clears the flag before this runs is simply not in the
   query result, so nothing happens to them.

   Usage:
     node scripts/purge-deletions.mjs              # delete expired accounts
     node scripts/purge-deletions.mjs --dry-run    # list them, delete nothing
     node scripts/purge-deletions.mjs --self-check  # offline sanity check, no network

   Env (GitHub Actions secrets, or a local .env):
     SUPABASE_URL                 https://YOUR-PROJECT.supabase.co
     SUPABASE_SERVICE_ROLE_KEY    service_role key (server-only — bypasses RLS;
                                  the only key allowed to call the admin delete API)
--------------------------------------------------------------------------- */
import { readFileSync } from "node:fs";

const GRACE_DAYS = 7;
const DRY = process.argv.includes("--dry-run");
const cutoff = new Date(Date.now() - GRACE_DAYS * 86400000).toISOString();

// ponytail: the only non-trivial bit is the cutoff math + the delete loop. The
// --self-check verifies the cutoff offline (no creds/network) so CI/devs can run it.
if (process.argv.includes("--self-check")) {
  const days = (Date.now() - new Date(cutoff).getTime()) / 86400000;
  if (Math.abs(days - GRACE_DAYS) > 0.001) throw new Error(`cutoff math wrong: ${days}d, want ${GRACE_DAYS}`);
  console.log(`self-check ok: cutoff is ${GRACE_DAYS} days ago (${cutoff})`);
  process.exit(0);
}

// load a local .env if present (CI provides these via the environment instead)
try {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { /* no .env — fine in CI */ }

const BASE = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!BASE || !KEY) { console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

const q = `${BASE}/rest/v1/profiles?select=id,username,deletion_requested_at&deletion_requested_at=lt.${encodeURIComponent(cutoff)}`;
const res = await fetch(q, { headers: H });
if (!res.ok) { console.error("profiles query failed:", res.status, await res.text()); process.exit(1); }
const rows = await res.json();
console.log(`${rows.length} account(s) past the ${GRACE_DAYS}-day grace period (cutoff ${cutoff}).`);

let deleted = 0;
for (const r of rows) {
  if (DRY) { console.log(`[dry-run] would delete ${r.id} (${r.username || "?"}), requested ${r.deletion_requested_at}`); continue; }
  // hard delete (GoTrue admin delete defaults to should_soft_delete=false) → cascades
  const d = await fetch(`${BASE}/auth/v1/admin/users/${r.id}`, { method: "DELETE", headers: H });
  if (d.ok) { deleted++; console.log(`deleted ${r.id}`); }
  else console.error(`FAILED to delete ${r.id}:`, d.status, await d.text());
}
console.log(DRY ? "(dry-run — nothing deleted)" : `done — deleted ${deleted}/${rows.length}.`);
