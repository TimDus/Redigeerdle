// @ts-nocheck — runs on Deno (Supabase Edge runtime), not the workspace TS server.
// The `Deno` global is provided at runtime; VS Code's default (Node) TS checker
// doesn't know it, so we skip type-checking here. See the Deno-extension note below
// for full IntelliSense instead.
// Supabase Edge Function: "hint"
// Generates a vague, spoiler-free hint for a Redigeerdle puzzle via an LLM, keeping the API
// key server-side (never in the browser). Providers are tried IN ORDER: Gemini (Google AI
// Studio) first, Groq as fallback — both via their OpenAI-compatible chat/completions API,
// so only the endpoint/key/model differ (see LLM_PROVIDERS / generate()).
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
//          supabase secrets set GEMINI_API_KEY=...      (primary; optionally GEMINI_MODEL)
//          supabase secrets set GROQ_API_KEY=gsk_...     (fallback; optionally GROQ_MODEL)
//   Either key alone works — the other provider is just skipped. SUPABASE_URL and
//   SUPABASE_SERVICE_ROLE_KEY are injected automatically. See SUPABASE_SETUP.md.
//
// Request  (POST):  { "title": "<answer>", "text": "<excerpt>", "categories"?: ["<wiki category>", …], "puzzleId"?: "<id>" }
//   `categories` are the page's visible wiki categories (the "in:" bar) — Groq bases the
//   `category` tier on them when present (else it infers from the article).
// Response (JSON):  { "summary": "<packet or empty>", "status": "ready" | "pending" }
//   `summary` carries a JSON STRING of the layered hint packet
//   {"category","summary","synonyms","first_letter"} (or "" when no usable hint), where
//   `synonyms` is a PER-WORD array (one close synonym per title word, in order; "" for a
//   proper name / function word). It's stored verbatim in puzzles.summary and parsed by the
//   client (parseHintPacket). Legacy rows / puzzle.json may hold a plain sentence, a packet
//   with a single combined `synonym` string, or one without any synonym field — the client
//   copes with all of these.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GROQ_MODEL = Deno.env.get("GROQ_MODEL") || "llama-3.3-70b-versatile";
const STALE_MS = 30_000;   // a claim older than this is considered abandoned
const EXCERPT_CHARS = 6000; // server-side cap on the article excerpt (matches the client; bounds prompt size + caller bloat)

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

// Re-derive an article's AUTHORITATIVE identity — its real title AND its stable page_id —
// from a pinned revision (wiki + revision_id), reading it straight from MediaWiki. The
// answer is never stored server-side, so for any path that writes to a SHARED cache we
// resolve the title here instead of trusting the caller's `title` — otherwise anyone could
// POST a bogus title/excerpt and poison puzzles.summary / hint_cache for every player. The
// page_id is the stable hint_cache key (survives renames/edits). One query returns both
// (query.pages[].title + .pageid). Returns null if it can't be fetched (callers then fall
// back to the supplied title and skip caching, so the feature degrades gracefully).
async function fetchPageInfo(wiki: string, revisionId: number | string): Promise<{ title: string; pageId: number } | null> {
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
      const p = Array.isArray(pages) ? pages[0] : (pages && Object.values(pages)[0]);
      if (p?.title) return { title: String(p.title), pageId: Number(p.pageid) };
    } catch { /* try the next candidate endpoint */ }
  }
  return null;
}

// ---- hint_cache: long-lived, cross-puzzle hint store keyed by (wiki_host, page_id) ----
// The page_id is the article's STABLE identity (survives renames/edits/moves), so a hint
// generated once is reused forever — across dailies on different dates, archived replays
// and (popular) random games for the same page — saving the rate-limited LLM call. The
// stored `packet` is the same leak-filtered JSON string as puzzles.summary (no title).
const CACHE_STALE_MS = 180 * 24 * 60 * 60 * 1000;   // fallback only (no revision info): packets older than this → regenerate

// A cache entry is fresh as long as the article hasn't been edited since we cached it.
// revision_id bumps on EVERY edit, so when we know both the cached and the requested
// revision we ignore age entirely: only a NEWER requested revision (the page changed)
// is a miss. We fall back to the 180d age guard only when a revision is missing on either
// side (pre-migration rows, or a caller that didn't send one).
async function readCache(admin, wikiHost: string, pageId: number, revisionId?: number | string): Promise<string | null> {
  if (!admin || !wikiHost || pageId == null || Number.isNaN(pageId)) return null;
  try {
    const { data } = await admin.from("hint_cache").select("packet, updated_at, revision_id")
      .eq("wiki_host", wikiHost).eq("page_id", pageId).maybeSingle();
    if (!data?.packet) return null;
    const cur = Number(revisionId), cached = Number(data.revision_id);
    if (cur && cached) return cur > cached ? null : data.packet;   // newer content → miss; same/older → hit (any age)
    if (Date.now() - new Date(data.updated_at).getTime() > CACHE_STALE_MS) return null;   // no revision info → age guard
    return data.packet;
  } catch { return null; }   // table missing / DB error → just a cache miss
}

async function writeCache(admin, wikiHost: string, pageId: number, packet: string, revisionId?: number | string): Promise<void> {
  if (!admin || !wikiHost || pageId == null || Number.isNaN(pageId) || !packet) return;
  const rev = Number(revisionId);
  // best-effort — a cache write must never break the response
  await admin.from("hint_cache")
    .upsert({ wiki_host: wikiHost, page_id: pageId, packet, revision_id: rev || null, updated_at: new Date().toISOString() })
    .then(() => {}, () => {});
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

// Ask an LLM — in ONE call — for the layered hint packet {category, summary, synonyms,
// first_letter}. Tries providers IN ORDER: Gemini (Google AI Studio) first, Groq as fallback.
// Both speak the OpenAI chat/completions shape, so only the endpoint/key/model differ; a
// provider is SKIPPED when its key is unset and FALLEN THROUGH on any error/timeout/non-200
// or an unusable (all-blank) result. The model writes `category` + `summary` + `synonyms` (a
// PER-WORD array) as JSON; `first_letter` is computed here. ONE batched call (not one per
// tier) keeps us well under the free per-minute limits — see CLAUDE.md. The model gets the
// article's first sentence so it bases the summary on it AND judges, per title word, whether
// the word is a proper name (→ no synonym). The per-field leak filter mirrors leaksTitle in
// scripts/lib/leak-filter.mjs (the unit-tested reference).
const LLM_PROVIDERS = [
  { name: "gemini", url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    keyEnv: "GEMINI_API_KEY", model: () => Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash" },
  { name: "groq", url: "https://api.groq.com/openai/v1/chat/completions",
    keyEnv: "GROQ_API_KEY", model: () => GROQ_MODEL },
];

async function generate(title: string, text: string, categories: string[] = []): Promise<string> {
  // the page's wiki categories (the "in:" bar), caller-supplied — cap count/length so a
  // poisoned/huge list can't bloat the prompt. They GROUND the `category` tier; the output
  // still goes through the leak filter against the (server-derived) real title, so a bad
  // category list can mislead the hint but never leak the answer.
  const cats = (Array.isArray(categories) ? categories : [])
    .filter((c) => typeof c === "string" && c.trim()).map((c) => c.trim().slice(0, 60)).slice(0, 12);
  const sys =
      "You write layered, spoiler-controlled hints for a word-guessing game. The player sees an "
    + "article with its TITLE blacked out and must guess that title. You produce three hint tiers, "
    + "ordered from VAGUEST to MOST revealing: \"category\" (vaguest) -> \"summary\" -> \"synonyms\" "
    + "(most revealing). You are given the exact title (the answer), the page's wiki categories, and "
    + "the article's opening text. Return ONLY a JSON object with exactly these three keys — no "
    + "markdown, no commentary, nothing else.\n\n"

    + "GOLDEN RULE (applies to EVERY field): never write the title, any word of the title, a name "
    + "from the title, or an obvious variant/inflection of a title word. A title word counts as used "
    + "even when it appears only INSIDE a longer word — if the title contains \"Hold\" you may NOT "
    + "output \"stronghold\", \"household\" or \"holding\" (each contains \"hold\"); pick a different "
    + "word such as \"fortress\" or \"keep\". Avoid proper nouns everywhere unless a field explicitly "
    + "allows them. When unsure, be vaguer.\n\n"

    + "\"category\" (string): 3-6 words naming the general KIND of thing the subject is — e.g. "
    + "\"A fictional character\", \"A historical battle\", \"A type of food\", \"A fortified "
    + "settlement\". No proper nouns. If the user message lists WIKI CATEGORIES, BASE this on them: "
    + "keep the ones that describe the kind of subject, generalise them into ONE natural phrase, and "
    + "IGNORE category names that are proper nouns, setting/franchise names, or that resemble the "
    + "title. If none are useful, infer the kind from the article text.\n\n"

    + "\"summary\" (string): ONE sentence, at most 18 words, describing the subject in general, "
    + "NON-identifying terms. Base it on the article's FIRST sentence plus the title, but generalise: "
    + "no proper nouns, no title words, nothing that lets the player name the exact subject outright. "
    + "It should be informative, not a giveaway.\n\n"

    + "\"synonyms\" (array of strings): the STRONGEST, most revealing tier — its job is to get the "
    + "player very close to each word, so make it count. Split the title into words on spaces. The "
    + "array MUST contain EXACTLY one entry per title word, in the SAME left-to-right order (a 3-word "
    + "title -> a length-3 array). Count the words carefully. For each word give a close 1-3 word "
    + "synonym or paraphrase of THAT word, as literal as the GOLDEN RULE allows. TRY HARD TO FILL "
    + "EVERY ENTRY. For a COMMON word, give a close, strong synonym (Hold -> fortress, Tournament -> "
    + "contest). For a PROPER NAME, give only a WEAK, oblique link, and build it ONLY from real "
    + "words/morphemes VISIBLE IN THE NAME'S OWN SPELLING — split the name into parts that are real "
    + "words and hint at those. E.g. \"Triwizard\" -> \"three magician\" (tri + wizard); \"Blackwater\" "
    + "-> \"dark river\" (black + water); \"Stormwind\" -> \"tempest gust\" (storm + wind). "
    + "CRUCIAL: do NOT translate a name by what the ARTICLE says it MEANS or is famous for — that "
    + "gives the answer away. E.g. for an invented name like \"Gulan\" do NOT answer \"gold\"/"
    + "\"golden\" just because the article describes a golden city — \"Gulan\" has no real-word parts "
    + "in its spelling, so it gets \"\". Use an EMPTY STRING \"\" for: a name with no real-word parts "
    + "in its own spelling (and no decent weak link), or a pure function word (the, of, a, an, and, "
    + "in, to, ...). Don't reuse the title word's own letters; keep the GOLDEN RULE (no title word "
    + "appears inside any synonym).\n\n"

    + "Worked examples (title -> synonyms):\n"
    + "  \"Triwizard Tournament\" -> [\"three magician\", \"contest\"]   (name split by SPELLING: "
    + "tri+wizard; Tournament -> contest)\n"
    + "  \"Blackwater\" -> [\"dark river\"]   (one name fully decoded from its spelling: black+water "
    + "-> dark river)\n"
    + "  \"Black Hole\" -> [\"dark\", \"void\"]   (both common words)\n"
    + "  \"Hold of Verkal Gulan\" -> [\"fortress\", \"\", \"\", \"\"]   (Hold -> fortress, NOT "
    + "\"stronghold\"; of = function word; Verkal & Gulan = invented names with no real-word parts in "
    + "their spelling -> \"\"  — do NOT use \"gold\"/\"golden\" from the article's gold theme)\n"
    + "  \"Excalibur\" -> [\"\"]   (an invented name, no real-word parts -> \"\")\n\n"

    + "Output ONLY the JSON object.";
  const user = `Title (the answer — never mention it or its words): "${title}"\n\n`
    + (cats.length ? `Wiki categories for this page (base "category" on these): ${cats.join(", ")}\n\n` : "")
    + `Article first sentence(s) / excerpt:\n${String(text).slice(0, EXCERPT_CHARS)}\n\nReturn the JSON object.`;
  // leak filter + cleaner are title-dependent only (provider-independent) — build once.
  // Folds diacritics + matches Unicode letters/numbers so an accented/non-Latin title
  // (Pokémon, Cyrillic, CJK) is actually guarded, not a silent no-op.
  const titleWords = foldText(title).match(/[\p{L}\p{N}]{3,}/gu) || [];
  const leaks = (s: string) => { const low = foldText(s); return titleWords.some((w: string) => low.includes(w)); };
  const clean = (s: unknown) => String(s || "").trim().replace(/^["']+|["']+$/g, "").trim();

  for (const p of LLM_PROVIDERS) {
    const key = Deno.env.get(p.keyEnv);
    if (!key) continue;   // provider not configured → try the next one
    try {
      const r = await fetch(p.url, {
        method: "POST",
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: p.model(),
          messages: [{ role: "system", content: sys }, { role: "user", content: user }],
          // Gemini 2.5 Flash is a THINKING model — it spends output tokens on internal reasoning
          // BEFORE the JSON, and the synonym tier now asks it to creatively DECODE names (more
          // thinking). A tight cap (the old 320) starved the answer and returned EMPTY, so give it
          // plenty: 8192 leaves ample room to think (the name-decoding rules need careful
          // reasoning) + emit the small JSON. It's only a CEILING — the model stops when done, so
          // this doesn't force longer thinking. Free on Gemini (1M TPM); Groq (no thinking) only
          // ever emits ~50 completion tokens regardless, so harmless there.
          max_tokens: 8192, temperature: 0.7,   // category + summary + per-word synonyms; first_letter is computed here
          response_format: { type: "json_object" },
        }),
        // bound a slow/hung provider so we can fall through (and the daily path can release
        // its claim) instead of holding the request until the platform wall-clock kill.
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) continue;   // 4xx/5xx/429 → fall back to the next provider
      const j = await r.json();
      const content = (j.choices?.[0]?.message?.content || "").trim();
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(content); } catch { continue; }   // non-JSON → next provider
      let category = clean(parsed.category);
      let summary = clean(parsed.summary);
      // synonyms: a per-word array of strings ("" for names). Non-string entries from a
      // drifted model degrade to "" → blanked below. Harmless.
      const rawSyn = Array.isArray(parsed.synonyms) ? parsed.synonyms : [];
      let synonyms = rawSyn.map((e: unknown) => clean(typeof e === "string" ? e : ""));
      // per-field leak filter: blank ONLY a field/entry containing a significant title word.
      if (category.length < 3 || category.length > 80 || leaks(category)) category = "";
      if (summary.length < 8 || summary.length > 200 || leaks(summary)) summary = "";
      synonyms = synonyms.map((s: string) => (s.length >= 2 && s.length <= 60 && !leaks(s)) ? s : "");
      if (!category && !summary && !synonyms.some(Boolean)) continue;   // unusable → fall back to the next provider
      return JSON.stringify({ category, summary, synonyms, first_letter: firstLetterOf(title) });
    } catch { continue; }   // network error / timeout → next provider
  }
  return "";   // every configured provider failed / had nothing usable
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const { title, text, categories, puzzleId, wiki, revisionId, pageId } = await req.json().catch(() => ({}));
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

    // ---- random/custom games: no puzzle row, but still share the cross-puzzle cache ----
    if (!puzzleId) {
      // fast read-probe with the caller's pageId. Harmless if it's wrong/bogus: packets are
      // leak-filtered (no title), and a bad key just misses. On a hit we touch neither
      // MediaWiki nor the LLM — the whole point of the cache.
      const cached = await readCache(admin, wiki, Number(pageId), revisionId);
      if (cached) return json({ summary: cached, status: "ready" });
      // miss → derive the AUTHORITATIVE identity from (wiki, revisionId) so a poisoned caller
      // title can't pollute the shared cache (a daily later reads it too). Generate from the
      // derived title and cache under the real page_id + this revision. If the derive fails
      // (network), still generate from the caller title but DON'T cache — degrade without poisoning.
      const info = await fetchPageInfo(wiki, revisionId);
      const hint = await generate(info?.title || title, text, categories);
      if (hint && info) await writeCache(admin, wiki, info.pageId, hint, revisionId);
      return json({ summary: hint, status: "ready" });
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
        // authoritative title + stable page_id from the pinned revision (also the cache key).
        const info = await fetchPageInfo(row?.wiki, row?.revision_id);
        // cross-puzzle cache: a DIFFERENT daily (another date) or a random game for the SAME
        // article may already have generated this packet — reuse it, no LLM call.
        let hint = info ? await readCache(admin, row?.wiki, info.pageId, row?.revision_id) : null;
        if (!hint) hint = await generate(info?.title || title, text, categories);
        if (hint) {
          await admin.from("puzzles").update({ summary: hint }).eq("id", puzzleId);
          if (info) await writeCache(admin, row?.wiki, info.pageId, hint, row?.revision_id);   // seed the shared cache for future puzzles
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
      return json({ summary: await generate(title, text, categories), status: "ready" });
    }
  } catch {
    return json({ summary: "", status: "ready" });
  }
});
