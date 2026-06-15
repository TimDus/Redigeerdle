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
// Response (JSON):  { "summary": "<packet or empty>", "status": "ready" | "pending" }
//   `summary` carries a JSON STRING of the layered hint packet
//   {"category","summary","first_letter"} (or "" when no usable hint). It's stored
//   verbatim in puzzles.summary and parsed by the client (parseHintPacket). Legacy
//   rows / puzzle.json may hold a plain sentence instead — the client copes with both.

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
      const r = await fetch(base + "?action=query&revids=" + encodeURIComponent(String(revisionId)) + "&formatversion=2&format=json", { signal: AbortSignal.timeout(8000) });
      if (!r.ok || !((r.headers.get("content-type") || "").includes("json"))) continue;
      const j = await r.json();
      const pages = j?.query?.pages;
      const t = Array.isArray(pages) ? pages[0]?.title : (pages && Object.values(pages)[0]?.title);
      if (t) return String(t);
    } catch { /* try the next candidate endpoint */ }
  }
  return null;
}

// The title's first letter — derived in code (NOT trusted to the model) so it's always
// exact. This is the one tier that may legitimately contain a piece of the answer, so it
// bypasses the leak filter below. Match a Unicode letter/number (\p{L}\p{N}), not just
// ASCII, so an accented/non-Latin title ("Élan", "東京") reports its real first character.
function firstLetterOf(title: string): string {
  const m = String(title).match(/[\p{L}\p{N}]/u);
  return m ? m[0].toUpperCase() : "";
}

// Fold accents/diacritics + lowercase, mirroring scripts/lib/leak-filter.mjs (the
// unit-tested reference). Kept in sync by hand — change one, change the other.
function foldText(s: string): string {
  return String(s).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// Ask Groq — in ONE call — for the layered hint packet {category, summary, first_letter}.
// The model writes only `category` + `summary` as JSON; `first_letter` is computed here.
// Returns a JSON STRING of the packet, or "" on any failure / when no tier is usable.
// The per-field leak filter is kept in sync with leaksTitle in
// scripts/lib/leak-filter.mjs (the unit-tested reference).
async function generate(title: string, text: string): Promise<string> {
  const key = Deno.env.get("GROQ_API_KEY");
  if (!key) return "";
  const sys = "You write layered, spoiler-controlled hints for a word-guessing game where the player "
    + "must guess an article title. Return ONLY a JSON object with exactly two string keys:\n"
    + "  \"category\": 3-6 words naming the general KIND of subject (e.g. 'A fictional character', "
    + "'A historical battle', 'A type of food'). No proper nouns.\n"
    + "  \"summary\": one vague sentence, max 18 words, describing the subject in general terms.\n"
    + "Rules for BOTH fields: the player must NOT be able to read the answer from them — "
    + "NEVER write the title or any of its words, names, or close variants; avoid proper nouns; "
    + "evocative but not identifying. Output ONLY the JSON object, nothing else.";
  const user = `Title (the answer — never mention it or its words): "${title}"\n\n`
    + `Article excerpt:\n${String(text).slice(0, 1500)}\n\nReturn the JSON object.`;
  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: "system", content: sys }, { role: "user", content: user }],
        max_tokens: 220, temperature: 0.7,
        response_format: { type: "json_object" },
      }),
      // bound a slow/hung Groq so we don't hold the daily's generation claim (and the
      // request) until the platform wall-clock kill — on timeout this throws, the catch
      // returns "", and the daily path then releases the claim for a later retry.
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return "";
    const j = await r.json();
    const content = (j.choices?.[0]?.message?.content || "").trim();
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(content); } catch { return ""; }
    let category = String(parsed.category || "").trim().replace(/^["']+|["']+$/g, "").trim();
    let summary = String(parsed.summary || "").trim().replace(/^["']+|["']+$/g, "").trim();
    // per-field leak filter: blank ONLY the field that contains a significant title word
    // (keep the other tiers). Mirrors leaksTitle in scripts/lib/leak-filter.mjs — folds
    // diacritics and matches Unicode letters/numbers, so an accented/non-Latin title
    // (Pokémon, Cyrillic, CJK) is actually guarded instead of silently producing 0 words.
    const titleWords = foldText(title).match(/[\p{L}\p{N}]{3,}/gu) || [];
    const leaks = (s: string) => { const low = foldText(s); return titleWords.some((w: string) => low.includes(w)); };
    if (category.length < 3 || category.length > 80 || leaks(category)) category = "";
    if (summary.length < 8 || summary.length > 200 || leaks(summary)) summary = "";
    if (!category && !summary) return "";   // nothing usable from the model
    return JSON.stringify({ category, summary, first_letter: firstLetterOf(title) });
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

    // Auth gate — FAIL CLOSED. This Groq-backed endpoint must never be an open,
    // unauthenticated proxy that any script can hit to burn the server-side Groq quota.
    // We require a valid Supabase session (a silent anonymous guest counts), validated
    // with the service-role client. supabase-js attaches the caller's JWT automatically;
    // we deploy --no-verify-jwt (the platform does NO auth), so this is the ONLY gate.
    // If there's no service key to validate WITH (stripped/misconfigured deploy), we
    // refuse rather than generate — a missing/rotated secret must not silently open the
    // proxy. (Rate-limiting the authenticated surface stays a deploy concern: the Groq
    // dashboard cap + Supabase's anon-signin limit.)
    if (!admin) return json({ summary: "", status: "ready" });
    {
      const authHeader = req.headers.get("Authorization") || "";
      const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
      const { data: who } = jwt ? await admin.auth.getUser(jwt) : { data: null };
      if (!who?.user) return json({ summary: "", status: "ready" });
    }

    // ---- random/custom games: no row to cache against, just generate ----
    if (!puzzleId) {
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
      //    Release the claim on ANY failure (the title fetch, the generation, OR the
      //    write-back rejecting) so a single failed attempt doesn't strand the row in
      //    "pending" for the whole 30s stale window.
      try {
        const authTitle = await fetchTitleAtRevision(row?.wiki, row?.revision_id);
        const hint = await generate(authTitle || title, text);
        if (hint) {
          await admin.from("puzzles").update({ summary: hint }).eq("id", puzzleId);
          return json({ summary: hint, status: "ready" });
        }
        // no usable hint → release the claim so a later click can retry.
        await admin.from("puzzles").update({ summary_generating_at: null }).eq("id", puzzleId);
        return json({ summary: "", status: "ready" });
      } catch (genErr) {
        // generation/write failed after we claimed — free the claim (best-effort), then
        // fall through to the outer degrade path (generate uncached so the caller still
        // gets a hint this time).
        await admin.from("puzzles").update({ summary_generating_at: null }).eq("id", puzzleId).then(() => {}, () => {});
        throw genErr;
      }
    } catch {
      // DB path unavailable (e.g. migration not applied yet) → degrade gracefully:
      // generate without caching, so the feature still works.
      return json({ summary: await generate(title, text), status: "ready" });
    }
  } catch {
    return json({ summary: "", status: "ready" });
  }
});
