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

   Env (from GitHub Actions secrets, or a local .env file):
     SUPABASE_URL                 https://YOUR-PROJECT.supabase.co
     SUPABASE_SERVICE_ROLE_KEY    service_role key (server-only — keep secret!)
     GROQ_API_KEY                 optional — enables a vague AI hint (summary); omit for none
     GROQ_MODEL                   optional — defaults to llama-3.3-70b-versatile
--------------------------------------------------------------------------- */
import { readFileSync } from "node:fs";

// load a local .env if present (CI provides these via the environment instead)
try {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { /* no .env — fine in CI */ }

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const FORCE = argv.includes("--force");
const dateArg = (argv.find(a => a.startsWith("--date=")) || "").split("=")[1];
// "today" in Europe/Amsterdam (CEST/CET — DST-aware) as YYYY-MM-DD, so the daily
// rolls over at local midnight rather than UTC midnight.
const localDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam" }).format(new Date());
const DATE = dateArg || localDate();

const UA = "Redigeerdle-daily-picker/1.0 (https://github.com/TimDus/RedacBennar)";
const MIN_CHARS = 1200;    // skip stubs
const MAX_CHARS = 20000;   // skip monster articles (a wall of redacted words)
const MIN_PARAS = 4;       // skip thin pages
const ATTEMPTS = 14;       // wikis/articles to try before giving up
const EXPIRE_DAYS = 365;   // a picked article becomes eligible again after this many days

// Fallback pool, used only when the Supabase `wikis` table is empty/unreachable
// (e.g. a local dry run with no service-role key). Edit the live pool in the
// Supabase Table editor instead — no code change needed.
const FALLBACK_WIKIS = [
  "harrypotter.fandom.com", "starwars.fandom.com", "marvel.fandom.com", "dc.fandom.com",
  "minecraft.fandom.com", "naruto.fandom.com", "onepiece.fandom.com", "pokemon.fandom.com",
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

async function api(host, params) {
  const url = `https://${host}/api.php?` +
    new URLSearchParams({ ...params, format: "json", formatversion: "2" });
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.info || "api error");
  return j;
}

const stripTags = s => s
  .replace(/<[^>]+>/g, " ").replace(/\[\d+\]/g, "")
  .replace(/&[a-z]+;|&#\d+;/gi, " ").replace(/\s+/g, " ").trim();

// rough quality probe from the parsed HTML (paragraph text only)
function probe(html) {
  const ps = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map(m => stripTags(m[1])).filter(Boolean);
  const text = ps.join("\n\n");
  return { chars: text.length, paras: ps.filter(t => t.length > 40).length, text };
}

// the title is the answer, so it must make a fair word-guessing target:
// clean words only (letters/spaces/hyphen/apostrophe — so no digits, parens,
// commas, "v.", colons…), not a "List of"/generic numbered page, not too long.
const badTitle = t =>
  !/^[A-Za-z][A-Za-z '-]*$/.test(t) ||
  /^list of /i.test(t) ||
  /^(chapter|episode|issue|volume|season|part|book|act|page|file|gallery)\b/i.test(t) ||
  t.length > 50 ||
  t.split(/\s+/).length > 6;

const pickedKey = (wiki, title) => wiki + " " + String(title).toLowerCase();

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

async function pick(seen, wikis) {
  for (let i = 0; i < ATTEMPTS; i++) {
    const wiki = wikis[Math.floor(Math.random() * wikis.length)];
    try {
      const rnd = await api(wiki, { action: "query", list: "random", rnnamespace: "0", rnlimit: "6" });
      for (const { title } of (rnd.query?.random || [])) {
        if (badTitle(title)) continue;
        try {
          const parsed = await api(wiki, { action: "parse", page: title, prop: "text|revid", redirects: "1" });
          const realTitle = parsed.parse.title;
          const revid = parsed.parse.revid;
          if (badTitle(realTitle) || seen.has(pickedKey(wiki, realTitle))) continue;
          const html = typeof parsed.parse.text === "string" ? parsed.parse.text : parsed.parse.text["*"];
          const { chars, paras, text } = probe(html);
          if (chars < MIN_CHARS || chars > MAX_CHARS || paras < MIN_PARAS) continue;
          return { wiki, revision_id: revid, title: realTitle, chars, paras, text };
        } catch { /* try next title */ }
      }
    } catch { /* try next wiki */ }
  }
  return null;
}

// Generate a vague, spoiler-free hint via Groq (OpenAI-compatible API).
// Optional: with no GROQ_API_KEY the puzzle simply has no summary.
// Model is overridable with GROQ_MODEL (model IDs change — see console.groq.com/docs/models).
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

async function summarize(title, articleText) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return "";
  const sys = "You write a single vague, spoiler-free hint for a word-guessing game where the player "
    + "must guess the article title. The player must NOT be able to read the answer from your hint. "
    + "Rules: exactly one sentence, max 18 words; describe the subject only in general terms; "
    + "NEVER write the title or any of its words, names, or close variants; avoid proper nouns; "
    + "evocative but not identifying. Output ONLY the hint sentence, nothing else.";
  const user = `Title (the answer — never mention it or its words): "${title}"\n\n`
    + `Article excerpt:\n${articleText.slice(0, 1500)}\n\nWrite the vague hint.`;
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
    if (!r.ok) { console.error(`Groq ${r.status}: ${(await r.text()).slice(0, 200)} — no summary.`); return ""; }
    const j = await r.json();
    let hint = (j.choices?.[0]?.message?.content || "").trim().replace(/^["']+|["']+$/g, "").trim();
    // leak filter: drop the hint if it contains any significant word from the title
    const titleWords = (title.toLowerCase().match(/[a-z]{3,}/g) || []);
    const low = hint.toLowerCase();
    if (titleWords.some(w => low.includes(w))) { console.error("Summary leaked the title — dropped it."); return ""; }
    if (hint.length < 8 || hint.length > 200) return "";
    return hint;
  } catch (e) { console.error("Summary failed: " + e.message + " — continuing without one."); return ""; }
}

async function upsert(row) {
  const base = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  const r = await fetch(base + "/rest/v1/puzzles", {
    method: "POST",
    headers: {
      apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json",
      Prefer: (FORCE ? "resolution=merge-duplicates" : "resolution=ignore-duplicates") + ",return=representation",
    },
    body: JSON.stringify([row]),
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return await r.json();
}

(async () => {
  if (!DRY) {
    const pruned = await prunePicked();
    if (pruned) console.log(`Released ${pruned} pick(s) older than ${EXPIRE_DAYS} days.`);
  }
  const seen = await loadPickedKeys();
  const { hosts, source } = await loadWikis();
  console.log(`Wiki pool: ${hosts.length} hosts (${source}). Already used: ${seen.size}.`);
  const found = await pick(seen, hosts);
  if (!found) { console.error("Could not find a good article after", ATTEMPTS, "attempts."); process.exit(1); }

  console.log(`Picked: "${found.title}" — ${found.wiki} @${found.revision_id} (${found.chars} chars, ${found.paras} paragraphs)`);

  const summary = await summarize(found.title, found.text);
  if (summary) console.log(`Summary: ${summary}`);

  const row = { id: DATE, date: DATE, wiki: found.wiki, revision_id: found.revision_id };
  if (summary) row.summary = summary;

  if (DRY) { console.log("Dry run — nothing written. Row would be:", JSON.stringify(row)); return; }

  const res = await upsert(row);
  if (Array.isArray(res) && res.length === 0) {
    console.log(`A puzzle for ${DATE} already exists — left it untouched (use --force to overwrite).`);
  } else {
    await recordPicked(found.wiki, found.title, DATE);   // remember it so it never repeats
    console.log(`Stored daily puzzle for ${DATE}.`);
  }
})().catch(e => { console.error("Error:", e.message); process.exit(1); });
