// @ts-nocheck — runs on Deno (Supabase Edge runtime), not the workspace TS server.
// The `Deno` global is provided at runtime; VS Code's default (Node) TS checker
// doesn't know it, so we skip type-checking here.
// Supabase Edge Function: "merge-anon"
//
// When a player who has been playing as an ANONYMOUS guest signs into a real account
// (new or existing), this re-parents the guest's `plays` rows onto the real account so
// a week of guest play isn't lost. It then deletes the now-empty guest user.
//
// Authorization (two proofs, both required):
//  - The caller's own JWT (the REAL account) arrives in the Authorization header
//    (sent automatically by supabase-js `functions.invoke`). Deploy with JWT
//    verification ON so only authenticated callers reach this function.
//  - The guest's access token arrives in the body as `anon_token`; the client
//    captured it from the guest session right before swapping to the real account.
//    Validating it proves the caller genuinely owned that anonymous account, so
//    nobody can merge a stranger's guest data into their own account.
//
// The actual re-parent + conflict resolution lives in the SECURITY DEFINER SQL
// function public.merge_anon_plays (see the migration), called here via service_role.
//
// Deploy:  supabase functions deploy merge-anon          (JWT verification ON — no --no-verify-jwt)
//   SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.
// See SUPABASE_SETUP.md.
//
// Request  (POST):  { "anon_token": "<guest access token>" }
// Response (JSON):  { "merged": true } | { "merged": false, "reason": "<why>" }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ merged: false, reason: "method" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return json({ merged: false, reason: "server-misconfigured" }, 500);
  const admin = createClient(url, serviceKey);

  // 1) the real (calling) account — from the verified Authorization header
  const authHeader = req.headers.get("Authorization") || "";
  const realJwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!realJwt) return json({ merged: false, reason: "no-auth" }, 401);
  const { data: realData, error: realErr } = await admin.auth.getUser(realJwt);
  const real = realData?.user;
  if (realErr || !real) return json({ merged: false, reason: "bad-auth" }, 401);
  if (real.is_anonymous) return json({ merged: false, reason: "caller-anonymous" }, 403);

  // 2) the guest account — proven by the token captured before the swap
  let anonToken = "";
  try { anonToken = (await req.json())?.anon_token || ""; } catch { /* no body */ }
  if (!anonToken) return json({ merged: false, reason: "no-anon-token" }, 400);
  const { data: anonData, error: anonErr } = await admin.auth.getUser(anonToken);
  const anon = anonData?.user;
  if (anonErr || !anon) return json({ merged: false, reason: "bad-anon-token" }, 400);
  if (!anon.is_anonymous) return json({ merged: false, reason: "not-anonymous" }, 400);
  if (anon.id === real.id) return json({ merged: false, reason: "same-user" }, 200);

  // 3) re-parent the guest's plays (conflict policy lives in the SQL function)
  const { error: mergeErr } = await admin.rpc("merge_anon_plays", { p_anon: anon.id, p_real: real.id });
  if (mergeErr) return json({ merged: false, reason: "merge-failed" }, 500);

  // 4) delete the now-empty guest user (best-effort — the merge already succeeded)
  try { await admin.auth.admin.deleteUser(anon.id); } catch { /* leave the empty guest if delete fails */ }

  return json({ merged: true }, 200);
});
