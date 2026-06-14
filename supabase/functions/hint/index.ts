// @ts-nocheck — runs on Deno (Supabase Edge runtime), not the workspace TS server.
// The `Deno` global is provided at runtime; VS Code's default (Node) TS checker
// doesn't know it, so we skip type-checking here. See the Deno-extension note below
// for full IntelliSense instead.
// Supabase Edge Function: "hint"
// Generates a vague, spoiler-free hint for a Redigeerdle puzzle via Groq,
// keeping the Groq API key server-side (never in the browser).
//
// Two modes:
//  - WITHOUT puzzleId (random/custom games): generate a hint, return it, no cache.
//  - WITH puzzleId (the daily / a per-fandom daily): "generate once and cache".
//    The first caller atomically CLAIMS the row (sets summary_generating_at while
//    summary is still null and any prior claim is stale), generates the hint, and
//    writes it to puzzles.summary. Concurrent callers that lose the claim get
//    { status: "pending" } and the client polls until the summary appears. A
//    30-second staleness window lets a crashed generation be retried.
//
// Deploy:  supabase functions deploy hint --no-verify-jwt
//          supabase secrets set GROQ_API_KEY=gsk_...   (and optionally GROQ_MODEL)
//   SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.
// See SUPABASE_SETUP.md.
//
// Request  (POST):  { "title": "<answer>", "text": "<excerpt>", "puzzleId"?: "<id>" }
// Response (JSON):  { "summary": "<hint or empty>", "status": "ready" | "pending" }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GROQ_MODEL = Deno.env.get("GROQ_MODEL") || "llama-3.3-70b-versatile";
const STALE_MS = 30_000;   // a claim older than this is considered abandoned

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (obj: unknown) =>
  new Response(JSON.stringify(obj), { headers: { ...CORS, "Content-Type": "application/json" } });

// service_role client (bypasses RLS) for reading/writing puzzles.summary. Null if
// the env isn't present (e.g. a stripped-down deploy) — then we just don't cache.
function adminClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  return url && key ? createClient(url, key) : null;
}

// Re-derive a daily's REAL title from its pinned revision (wiki + revision_id), reading
// it straight from MediaWiki. The answer is never stored server-side, so for the cached
// daily path we read it authoritatively here instead of trusting the caller's `title` —
// otherwise anyone could POST a real puzzleId with a bogus title/excerpt and poison the
// shared `puzzles.summary` for every player. Returns null if it can't be fetched (we then
// fall back to the caller's title, so the feature still degrades gracefully).
async function fetchTitleAtRevision(wiki: string, revisionId: number | string): Promise<string | null> {
  if (!wiki || !revisionId) return null;
  const host = String(wiki).replace(/^https?:\/\//, "");
  const slash = host.indexOf("/");
  const root = "https://" + (slash >= 0 ? host.slice(0, slash) : host);
  const withPath = "https://" + host;                       // keeps a Fandom /<lang> prefix
  const cands = [...new Set([withPath + "/api.php", root + "/w/api.php", root + "/api.php"])];
  for (const base of cands) {
    try {
      const r = await fetch(base + "?action=query&revids=" + encodeURIComponent(String(revisionId)) + "&formatversion=2&format=json");
      if (!r.ok || !((r.headers.get("content-type") || "").includes("json"))) continue;
      const j = await r.json();
      const pages = j?.query?.pages;
      const t = Array.isArray(pages) ? pages[0]?.title : (pages && Object.values(pages)[0]?.title);
      if (t) return String(t);
    } catch { /* try the next candidate endpoint */ }
  }
  return null;
}

// Ask Groq for a vague, spoiler-free hint. Returns "" on any failure, a leak, or
// an out-of-bounds length. Keep this leak filter in sync with leaksTitle in
// scripts/lib/leak-filter.mjs (the unit-tested reference).
async function generate(title: string, text: string): Promise<string> {
  const key = Deno.env.get("GROQ_API_KEY");
  if (!key) return "";
  const sys = "You write a single vague, spoiler-free hint for a word-guessing game where the player "
    + "must guess the article title. The player must NOT be able to read the answer from your hint. "
    + "Rules: exactly one sentence, max 18 words; describe the subject only in general terms; "
    + "NEVER write the title or any of its words, names, or close variants; avoid proper nouns; "
    + "evocative but not identifying. Output ONLY the hint sentence, nothing else.";
  const user = `Title (the answer — never mention it or its words): "${title}"\n\n`
    + `Article excerpt:\n${String(text).slice(0, 1500)}\n\nWrite the vague hint.`;
  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: "system", content: sys }, { role: "user", content: user }],
        max_tokens: 60, temperature: 0.7,
      }),
    });
    if (!r.ok) return "";
    const j = await r.json();
    let hint = (j.choices?.[0]?.message?.content || "").trim().replace(/^["']+|["']+$/g, "").trim();
    // leak filter: drop the hint if it contains any significant word from the title
    const titleWords = String(title).toLowerCase().match(/[a-z]{3,}/g) || [];
    const low = hint.toLowerCase();
    if (titleWords.some((w: string) => low.includes(w))) hint = "";
    if (hint.length < 8 || hint.length > 200) hint = "";
    return hint;
  } catch {
    return "";
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const { title, text, puzzleId } = await req.json().catch(() => ({}));
    if (!title || !text) return json({ summary: "", status: "ready" });

    const admin = adminClient();

    // Require a valid Supabase session (a silent anonymous guest counts) so this
    // Groq-backed endpoint isn't an open, unauthenticated proxy that any script can hit
    // to burn the server-side Groq quota. supabase-js attaches the caller's JWT
    // automatically; we deploy with --no-verify-jwt and check it here so the no-DB
    // degrade path still works. Skipped only when we have no service key to validate with.
    if (admin) {
      const authHeader = req.headers.get("Authorization") || "";
      const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
      const { data: who } = jwt ? await admin.auth.getUser(jwt) : { data: null };
      if (!who?.user) return json({ summary: "", status: "ready" });
    }

    // ---- random/custom games: no row to cache against, just generate ----
    if (!puzzleId || !admin) {
      return json({ summary: await generate(title, text), status: "ready" });
    }

    // ---- daily: generate once and cache, race-safe via an atomic claim ----
    try {
      // 1) already cached? return it without touching Groq. (Also read the pinned
      //    revision so the generating caller can re-derive the real title — see step 3.)
      const { data: row } = await admin.from("puzzles").select("summary, wiki, revision_id").eq("id", puzzleId).maybeSingle();
      if (row?.summary) return json({ summary: row.summary, status: "ready" });

      // 2) atomically claim: succeeds for exactly one caller. Under READ COMMITTED
      //    a concurrent UPDATE re-checks this WHERE against the freshly-claimed row
      //    (summary_generating_at = now()), so it matches 0 rows and loses.
      const cutoff = new Date(Date.now() - STALE_MS).toISOString();
      const { data: claimed, error: claimErr } = await admin.from("puzzles")
        .update({ summary_generating_at: new Date().toISOString() })
        .eq("id", puzzleId)
        .is("summary", null)
        .or(`summary_generating_at.is.null,summary_generating_at.lt.${cutoff}`)
        .select("id");
      if (claimErr) throw claimErr;   // column missing / DB error → degrade below

      if (!claimed || claimed.length === 0) {
        // lost the claim → someone else is generating (or it just landed). Re-read.
        const { data: again } = await admin.from("puzzles").select("summary").eq("id", puzzleId).maybeSingle();
        if (again?.summary) return json({ summary: again.summary, status: "ready" });
        return json({ summary: "", status: "pending" });
      }

      // 3) we own the claim → generate and write back. Re-derive the title from the
      //    pinned revision so a caller-supplied (possibly poisoned) title can't pollute
      //    the shared cache; fall back to the supplied title only if the fetch fails.
      const authTitle = await fetchTitleAtRevision(row?.wiki, row?.revision_id);
      const hint = await generate(authTitle || title, text);
      if (hint) {
        await admin.from("puzzles").update({ summary: hint }).eq("id", puzzleId);
        return json({ summary: hint, status: "ready" });
      }
      // no usable hint → release the claim so a later click can retry.
      await admin.from("puzzles").update({ summary_generating_at: null }).eq("id", puzzleId);
      return json({ summary: "", status: "ready" });
    } catch {
      // DB path unavailable (e.g. migration not applied yet) → degrade gracefully:
      // generate without caching, so the feature still works.
      return json({ summary: await generate(title, text), status: "ready" });
    }
  } catch {
    return json({ summary: "", status: "ready" });
  }
});
