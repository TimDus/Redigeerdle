#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Pick a random, good-enough Fandom article and store it as the daily puzzle.

   A puzzle row is only a pointer: { id, date, wiki, revision_id }. We pin the
   CURRENT revision so the puzzle stays reproducible. The article title (the
   answer) is deliberately NOT stored — puzzles is public-read.

   Usage:
     node scripts/pick-daily.mjs                 # insert for today (Europe/Amsterdam)
     node scripts/pick-daily.mjs --date=2026-06-20
     node scripts/pick-daily.mjs --dry-run       # pick + print, do not write
     node scripts/pick-daily.mjs --force         # overwrite an existing date

   The hint (summary) is NOT generated here — the game lazily generates one,
   once and cached, via the "hint" Edge Function. So this script needs no Groq
   key; the Groq secret lives with the Edge Function instead.

   Env (from GitHub Actions secrets, or a local .env file):
     SUPABASE_URL                 https://YOUR-PROJECT.supabase.co
     SUPABASE_SERVICE_ROLE_KEY    service_role key (server-only — keep secret!)
--------------------------------------------------------------------------- */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Is this file being run directly (CLI), or imported (e.g. by a test)? Only the
// CLI path loads .env, parses argv and runs the picker; importing pulls in the
// pure helpers (badTitle/probe/…) with no side effects.
const isMain = import.meta.url === pathToFileURL(process.argv[1] || "").href;

// load a local .env if present (CI provides these via the environment instead)
if (isMain) {
  try {
    for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* no .env — fine in CI */ }
}

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const FORCE = argv.includes("--force");
const dateArg = (argv.find(a => a.startsWith("--date=")) || "").split("=")[1];
// "today" in Europe/Amsterdam (CEST/CET — DST-aware) as YYYY-MM-DD, so the daily
// rolls over at local midnight rather than UTC midnight.
const localDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam" }).format(new Date());
const DATE = dateArg || localDate();

const UA = "Redigeerdle-daily-picker/1.0 (https://github.com/TimDus/RedacBennar)";
const MIN_CHARS = 1200;    // skip stubs (rendered paragraph text)
const MAX_CHARS = 20000;   // skip monster articles (a wall of redacted words)
const MIN_PARAS = 4;       // skip thin pages
const MIN_BYTES = 1500;    // cheap stub pre-filter on raw wikitext length (before parsing)
const ATTEMPTS = 50;       // random rounds (×10 candidates) per wiki, with early exit on a hit
                           // (easy wikis hit in 1–2; only junk-heavy ones like comic DBs use many)
const RELAX_FROM = 20;     // rounds 0..19 use the strict thresholds above; from round 20 the
                           // quality bar eases linearly toward round ATTEMPTS so a stubborn wiki
                           // still yields *something* before we fall back to reusing an old daily.
const POPULAR_WANT = 1000; // how many most-revised titles to pull (Mostrevisions caps at 1000).
                           // Must comfortably exceed 365 picks/year/wiki so the 365-day no-repeat
                           // window never forces a fallback to random on a content-rich wiki.
const POPULAR_TRIES = 12;  // weight-sampled popular candidates to parse-verify before giving up
                           // on the popularity path and falling back to the random search.

// the quality gate for a given round: strict until RELAX_FROM, then progressively
// looser. We never relax badTitle — a title with digits/parens is an unfair puzzle.
function thresholds(round) {
  const t = Math.max(0, Math.min(1, (round - RELAX_FROM) / (ATTEMPTS - RELAX_FROM)));
  const lerp = (a, b) => Math.round(a + (b - a) * t);
  return {
    minChars: lerp(MIN_CHARS, 400),
    maxChars: lerp(MAX_CHARS, 40000),
    minParas: lerp(MIN_PARAS, 1),
    minBytes: lerp(MIN_BYTES, 500),
  };
}
const EXPIRE_DAYS = 365;   // a picked article becomes eligible again after this many days

// Fallback pool, used only when the Supabase `wikis` table is empty/unreachable
// (e.g. a local dry run with no service-role key). Edit the live pool in the
// Supabase Table editor instead — no code change needed.
const FALLBACK_WIKIS = [
  "harrypotter.fandom.com", "starwars.fandom.com", "marvel.fandom.com", "dc.fandom.com",
  "minecraft.wiki", "naruto.fandom.com", "onepiece.fandom.com", "pokemon.fandom.com",
  "elderscrolls.fandom.com", "fallout.fandom.com", "witcher.fandom.com", "lotr.fandom.com",
  "disney.fandom.com", "residentevil.fandom.com", "finalfantasy.fandom.com", "zelda.fandom.com",
  "memory-alpha.fandom.com", "avatar.fandom.com", "masseffect.fandom.com",
  "dragonage.fandom.com", "halo.fandom.com", "godofwar.fandom.com", "kingdomhearts.fandom.com",
];

// Load the enabled wiki pool from Supabase; fall back to the baked-in list.
async function loadWikis() {
  const base = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (base && key) {
    try {
      const url = base + "/rest/v1/wikis?select=host&enabled=eq.true";
      const r = await fetch(url, { headers: { apikey: key, Authorization: "Bearer " + key } });
      if (r.ok) {
        const hosts = (await r.json()).map(x => x.host).filter(Boolean);
        if (hosts.length) return { hosts, source: "Supabase" };
      }
    } catch { /* fall through to the baked-in list */ }
  }
  return { hosts: FALLBACK_WIKIS, source: "fallback" };
}

// MediaWiki puts api.php at different paths (Fandom/minecraft.wiki: /api.php,
// Wikipedia: /w/api.php). Probe candidates once per host and cache the result.
const apiBaseCache = new Map();
async function apiBaseFor(host) {
  if (apiBaseCache.has(host)) return apiBaseCache.get(host);
  for (const cand of [`https://${host}/api.php`, `https://${host}/w/api.php`]) {
    try {
      const r = await fetch(cand + "?action=query&meta=siteinfo&siprop=general&format=json&formatversion=2",
        { headers: { "User-Agent": UA } });
      if (r.ok && (r.headers.get("content-type") || "").includes("json")) {
        const j = await r.json();
        if (j.query?.general) { apiBaseCache.set(host, cand); return cand; }
      }
    } catch { /* try the next candidate */ }
  }
  const def = `https://${host}/api.php`;   // default; let the caller fail visibly
  apiBaseCache.set(host, def);
  return def;
}

async function api(host, params) {
  const url = await apiBaseFor(host) + "?" +
    new URLSearchParams({ ...params, format: "json", formatversion: "2" });
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.info || "api error");
  return j;
}

export const stripTags = s => s
  .replace(/<[^>]+>/g, " ").replace(/\[\d+\]/g, "")
  .replace(/&[a-z]+;|&#\d+;/gi, " ").replace(/\s+/g, " ").trim();

// rough quality probe from the parsed HTML (paragraph text only)
export function probe(html) {
  const ps = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map(m => stripTags(m[1])).filter(Boolean);
  const text = ps.join("\n\n");
  return { chars: text.length, paras: ps.filter(t => t.length > 40).length, text };
}

// the title is the answer, so it must make a fair word-guessing target:
// clean words only (letters/spaces/hyphen/apostrophe — so no digits, parens,
// commas, "v.", colons…), not a "List of"/generic numbered page, not too long.
export const badTitle = t =>
  !/^[A-Za-z][A-Za-z '-]*$/.test(t) ||
  /^list of /i.test(t) ||
  /^(chapter|episode|issue|volume|season|part|book|act|page|file|gallery)\b/i.test(t) ||
  t.length > 50 ||
  t.split(/\s+/).length > 6;

export const pickedKey = (wiki, title) => wiki + " " + String(title).toLowerCase();

// drop picks older than EXPIRE_DAYS (by created_at) so those articles can be chosen again
async function prunePicked() {
  const base = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return 0;
  const cutoff = new Date(Date.now() - EXPIRE_DAYS * 86400000).toISOString();
  try {
    const r = await fetch(base + "/rest/v1/picked?created_at=lt." + encodeURIComponent(cutoff), {
      method: "DELETE",
      headers: { apikey: key, Authorization: "Bearer " + key, Prefer: "return=representation" },
    });
    if (!r.ok) return 0;
    const removed = await r.json();
    return Array.isArray(removed) ? removed.length : 0;
  } catch { return 0; }
}

// every article the picker has already used (private `picked` table), so it never repeats one
async function loadPickedKeys() {
  const base = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return new Set();
  try {
    const r = await fetch(base + "/rest/v1/picked?select=wiki,title",
      { headers: { apikey: key, Authorization: "Bearer " + key } });
    if (!r.ok) return new Set();
    return new Set((await r.json()).map(x => pickedKey(x.wiki, x.title)));
  } catch { return new Set(); }
}

// remember a chosen article so it won't be picked again
async function recordPicked(wiki, title, date) {
  const base = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return;
  try {
    await fetch(base + "/rest/v1/picked", {
      method: "POST",
      headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json",
        Prefer: "resolution=ignore-duplicates" },
      body: JSON.stringify([{ wiki, title, picked_on: date }]),
    });
  } catch { /* non-fatal — dedup just won't include this one next time */ }
}

// Keep only clean main-namespace (ns=0) titles from a Mostrevisions result set —
// drops talk/template/user pages and unfair titles (digits/parens/lists/…). Pure,
// so it's unit-tested. The list comes back most-edited-first; we preserve that order.
export function cleanPopularTitles(results) {
  return (results || [])
    .filter(r => r && r.ns === 0 && r.title && !badTitle(r.title))
    .map(r => r.title);
}

// The most-revised articles on a wiki ≈ its most popular/iconic pages — a far better
// daily than a uniformly random page. Mostrevisions is a cached, pre-ranked QueryPage
// available on Fandom + generic MediaWiki (Wikipedia too); PageViewInfo/HitCounters
// (real view counts) are NOT enabled on Fandom, so edit count is our portable
// cross-wiki popularity proxy. Returns clean ns=0 titles (most-edited first), paging
// up to POPULAR_WANT; [] if the wiki lacks the query so the caller falls back to the
// random search.
async function popularTitles(wiki, want = POPULAR_WANT) {
  const titles = [];
  let offset = 0;
  try {
    while (titles.length < want) {
      const res = await api(wiki, {
        action: "query", list: "querypage", qppage: "Mostrevisions",
        qplimit: "500", qpoffset: String(offset),
      });
      const rows = res.query?.querypage?.results || [];
      if (!rows.length) break;
      titles.push(...cleanPopularTitles(rows));
      const next = res.continue?.qpoffset;
      if (next == null) break;
      offset = next;
    }
  } catch { /* Mostrevisions unavailable/disabled — caller falls back to random */ }
  return titles;
}

// Pick an index biased toward the front (0 = most edited). Quadratic bias gives the
// famous top ~25% roughly half the picks, but enough spread that we don't always serve
// the same handful — and, combined with the dedup `seen` set, that the picker naturally
// works deeper into the list over the year as the most-famous pages get consumed.
export const biasedIndex = n => Math.floor(Math.pow(Math.random(), 2) * n);

// Parse + quality-check one candidate title. Returns the puzzle pointer
// ({wiki, revision_id, title, chars, paras}) or null if it's unsuitable (bad/duplicate
// resolved title, too short/long/thin, or the parse failed).
async function tryArticle(wiki, title, th, seen) {
  // Whole body in the try: a transient API error OR a malformed response (no `parse`
  // object, odd `text` shape) must yield null, never an uncaught throw — pickForWiki and
  // the main loop don't guard this, so a throw here would abort the entire run.
  try {
    const parsed = await api(wiki, { action: "parse", page: title, prop: "text|revid", redirects: "1" });
    const realTitle = parsed.parse.title;
    const revid = parsed.parse.revid;
    if (badTitle(realTitle) || seen.has(pickedKey(wiki, realTitle))) return null;
    const html = typeof parsed.parse.text === "string" ? parsed.parse.text : parsed.parse.text["*"];
    const { chars, paras } = probe(html);
    if (chars < th.minChars || chars > th.maxChars || paras < th.minParas) return null;
    return { wiki, revision_id: revid, title: realTitle, chars, paras };
  } catch { return null; }
}

// Find one good article on a SINGLE wiki (used once per fandom per day).
// Stage 1 — popularity-first: weight-sample the most-revised (≈ most popular) articles,
//   skipping any already used within the 365-day window, so the daily lands on a
//   recognizable page and never repeats. (A content-rich wiki has far more than 365
//   clean popular titles, so this never runs dry; as the famous ones get consumed the
//   bias naturally works deeper into the list.)
// Stage 2 — fallback: the original generator=random search. Uses prop=info so each
//   candidate's wikitext length + redirect status come back UP FRONT (reject bad
//   titles, redirects and stubs cheaply, parse only promising pages). Reached when the
//   wiki has no Mostrevisions, or its popular titles are exhausted/unsuitable — i.e.
//   small/junk-heavy wikis (comic-issue databases), which is what this stage was for.
async function pickForWiki(wiki, seen, rounds = ATTEMPTS) {
  // Stage 1: popular articles (most-revised), weight-sampled toward the top.
  const popular = (await popularTitles(wiki)).filter(t => !seen.has(pickedKey(wiki, t)));
  for (let n = 0; n < POPULAR_TRIES && popular.length; n++) {
    const title = popular.splice(biasedIndex(popular.length), 1)[0];   // take it out so we don't retry it
    const f = await tryArticle(wiki, title, thresholds(0), seen);      // strict bar — popular pages are substantial
    if (f) return { ...f, popular: true };
  }
  // Stage 2: random search (loosening past RELAX_FROM).
  for (let i = 0; i < rounds; i++) {
    const th = thresholds(i);   // strict early, looser past RELAX_FROM
    let res;
    try {
      res = await api(wiki, {
        action: "query", generator: "random",
        grnnamespace: "0", grnlimit: "10", grnfilterredir: "nonredirects",
        prop: "info",
      });
    } catch { continue; }   // transient API error — try another round
    // cheap pre-filter: clean title + not an obvious stub, BEFORE any parse.
    // Longest-first so we try the most article-like candidates earliest.
    const candidates = (res.query?.pages || [])
      .filter(p => p.title && !badTitle(p.title)
        && typeof p.length === "number" && p.length >= th.minBytes
        && !seen.has(pickedKey(wiki, p.title)))
      .sort((a, b) => b.length - a.length);
    for (const c of candidates) {
      const f = await tryArticle(wiki, c.title, th, seen);
      if (f) return { ...f, round: i, relaxed: i >= RELAX_FROM };
    }
  }
  return null;
}

// Have we already generated the dailies for this date? The picker is scheduled
// TWICE (22:00 & 23:00 UTC, straddling the CET/CEST local midnight); the run that
// fires on the wrong side of midnight would otherwise re-pick and needlessly burn
// fresh articles from the pool (recordPicked marks them used even though they're
// never shown). So the second run of a given local day exits early instead.
async function alreadyPicked(date) {
  const base = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return false;
  try {
    const r = await fetch(base + "/rest/v1/puzzles?select=id&date=eq." + encodeURIComponent(date) + "&limit=1",
      { headers: { apikey: key, Authorization: "Bearer " + key } });
    if (!r.ok) return false;
    const rows = await r.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch { return false; }
}

// Last resort: reuse one of this wiki's earlier dailies so the feed never has a gap.
// Picks at random among the most recent ones so it isn't always the same repeat.
async function pastDailyFor(wiki) {
  const base = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return null;
  try {
    const r = await fetch(base + "/rest/v1/puzzles?select=revision_id&wiki=eq." +
      encodeURIComponent(wiki) + "&order=date.desc&limit=30",
      { headers: { apikey: key, Authorization: "Bearer " + key } });
    if (!r.ok) return null;
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return null;
    return rows[Math.floor(Math.random() * rows.length)].revision_id;
  } catch { return null; }
}

// NOTE: hints are no longer generated here. The puzzle is stored without a
// `summary`; the game lazily generates one (once, cached) via the "hint" Edge
// Function the first time a player asks for it. See supabase/functions/hint.

async function upsert(rows) {
  const base = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  // Resolve the upsert against the (wiki, date) unique constraint — the real "one
  // daily per fandom per day" key — not the primary key (id). Without on_conflict,
  // PostgREST dedups on the id PK, so a row with the same (wiki, date) but a
  // different id (e.g. a legacy bare-date daily vs the new "<date>:<wiki>" id) slips
  // past ignore/merge and hard-errors with a 23505 on puzzles_wiki_date_key.
  const r = await fetch(base + "/rest/v1/puzzles?on_conflict=wiki,date", {
    method: "POST",
    headers: {
      apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json",
      Prefer: (FORCE ? "resolution=merge-duplicates" : "resolution=ignore-duplicates") + ",return=representation",
    },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return await r.json();
}

if (isMain) (async () => {
  // the second scheduled run of the local day (see the two crons in the workflow)
  // would re-pick and waste pool articles — skip it once today's dailies exist.
  if (!DRY && !FORCE && await alreadyPicked(DATE)) {
    console.log(`Dailies for ${DATE} already exist — nothing to do (use --force to re-pick).`);
    return;
  }
  if (!DRY) {
    const pruned = await prunePicked();
    if (pruned) console.log(`Released ${pruned} pick(s) older than ${EXPIRE_DAYS} days.`);
  }
  const seen = await loadPickedKeys();
  const { hosts, source } = await loadWikis();
  console.log(`Wiki pool: ${hosts.length} hosts (${source}). Already used: ${seen.size}.`);

  // One daily per fandom: pick a good article on each enabled wiki. If even the
  // relaxed search fails, reuse an earlier daily so the feed never has a gap.
  const found = [];
  let relaxedN = 0, carriedN = 0, popularN = 0;
  for (const host of hosts) {
    const f = await pickForWiki(host, seen);
    if (f) {
      seen.add(pickedKey(host, f.title));      // avoid re-picking within this run
      found.push(f);
      if (f.popular) popularN++;
      if (f.relaxed) relaxedN++;
      console.log(`  ${host}: "${f.title}" @${f.revision_id} (${f.chars} chars, ${f.paras} paras)` +
        (f.popular ? " [popular]" : f.relaxed ? ` [relaxed @round ${f.round + 1}]` : ""));
      continue;
    }
    const revid = await pastDailyFor(host);
    if (revid != null) {
      found.push({ wiki: host, revision_id: revid, carried: true });
      carriedN++;
      console.error(`  ${host}: no fresh article after ${ATTEMPTS} rounds — reused an earlier daily (@${revid}).`);
    } else {
      console.error(`  ${host}: no fresh article AND no past daily to reuse — skipped.`);
    }
  }
  if (!found.length) { console.error("Could not generate any dailies."); process.exit(1); }

  // Feature a FRESH pick on the home page if there is one (avoid featuring a repeat).
  const freshIdx = found.map((f, i) => (f.carried ? -1 : i)).filter(i => i >= 0);
  const featuredIdx = (freshIdx.length ? freshIdx : found.map((_, i) => i))[
    Math.floor(Math.random() * (freshIdx.length || found.length))];
  // No summary here — the hint is generated lazily (and cached) by the Edge Function.
  const rows = found.map((f, i) => ({
    id: `${DATE}:${f.wiki}`, date: DATE, wiki: f.wiki, revision_id: f.revision_id,
    is_featured: i === featuredIdx,
  }));
  console.log(`Generated ${rows.length}/${hosts.length} dailies for ${DATE} ` +
    `(${popularN} popular, ${relaxedN} relaxed, ${carriedN} reused); featured: ${found[featuredIdx].wiki}.`);

  if (DRY) { console.log("Dry run — nothing written. Rows:", JSON.stringify(rows)); return; }

  const res = await upsert(rows);
  const stored = Array.isArray(res) ? res.length : 0;
  for (const f of found) if (f.title) await recordPicked(f.wiki, f.title, DATE);   // only fresh picks
  console.log(`Stored ${stored} new daily row(s) for ${DATE}` +
    (stored < rows.length ? ` (${rows.length - stored} already existed — use --force to overwrite).` : "."));
})().catch(e => { console.error("Error:", e.message); process.exit(1); });
