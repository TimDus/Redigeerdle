# CLAUDE.md

Guidance for working in this repo. Read before making changes.

## What this is

**Redigeerdle** — a redacted-article word-guessing game (Redactle-style). You get a
Fandom wiki article with every word blacked out (only word *lengths* show); guess words
to reveal them and work toward the real goal: the **title**.

It is a **single static `index.html`** — no build step, no framework, no bundler. The
whole app (HTML + CSS + one classic `<script>`) lives in [index.html](index.html).
Supabase (auth, daily puzzles, leaderboard) is a CDN script + REST; the daily picker is
a standalone Node script run by GitHub Actions.

## Core invariants — do not break these

- **A puzzle is only a POINTER**: `{ id, wiki, revision_id, date, is_featured, summary? }`.
  The article text and the **title (the answer) are never stored**. The game fetches the article
  live from the Fandom API at a *pinned revision* (so it never drifts), and only words
  the player guesses get written into the DOM. Anything that would persist the answer
  server-side is a regression. (The `plays` log stores a `revision_id` — that's a
  *pointer*, like `puzzles.revision_id`, not the answer text; it's safe because `plays`
  is owner-only.)
  - **The featured daily's source (`wiki` + `revision_id`) is a SOFT/UI concealment, not a
    hard secret — and that's by design, not a bug.** The **Source** hint tier hides which
    wiki the article came from (the feed's pinned card shows a neutral "⭐ Featured daily",
    `attribution()` stays generic until you finish, the status text never names it). But the
    `puzzles` table is **public-read** (`using (true)`) and the *anon browser client must read
    `wiki`+`revision_id` itself* to fetch the article live at the pinned revision — that's the
    core "puzzle is only a pointer, article fetched client-side" invariant. So today's featured
    `wiki`+`rev` is necessarily reachable by anyone with the anon key (a direct
    `GET puzzles?select=wiki,revision_id&is_featured=eq.true&date=eq.<today>`, or just devtools
    while playing). A `security definer` RPC would **not** close this — it'd return the same
    pointer to the same anon caller; the only true hard-hide is server-side article proxying,
    which would break the pointer-only invariant. This is acceptable because the source is a
    *hint*, never the **answer**: the title itself is still never stored (re-derived from the
    revision client-side and server-side). So: keep the source out of the UI/share/feed surfaces
    (a casual player shouldn't be handed it), but don't pretend it's cryptographically secret.
- **The `picked` table is private**: it holds titles (answers), so it has RLS enabled
  with **no policy** — only the picker's `service_role` key (which bypasses RLS)
  touches it. The anon/browser client must never read it.
- **"Today" is `Europe/Amsterdam`** (DST-aware), not UTC — so the daily rolls over at
  local midnight. This is computed identically in the picker
  ([scripts/pick-daily.mjs](scripts/pick-daily.mjs)) and the client (`loadPuzzle` in
  index.html). Keep them in sync.
- **The anon Supabase key is safe in client code**; RLS is what protects data. The
  `service_role` key is server-only (GitHub Actions secret / local `.env`) — never ship
  it to the browser.
- **Hints are a layered packet, generated lazily (once) and cached.** A single LLM
  call returns **all hint tiers at once** as a JSON object — `{category, summary,
  synonyms, first_letter}` — so revealing tiers never costs extra API calls (important
  against the free per-minute limits; the whole call is ~1K tokens). **Provider order:
  Gemini (Google AI Studio) first, Groq as fallback** — both via their OpenAI-compatible
  `chat/completions` API, so only the endpoint/key/model differ (`LLM_PROVIDERS` +
  `generate()` in [supabase/functions/hint/index.ts](supabase/functions/hint/index.ts)). A
  provider is **skipped** when its key (`GEMINI_API_KEY` / `GROQ_API_KEY`) is unset and
  **fallen through** on any error/timeout/non-200 or an unusable (all-blank) result; either
  key alone works. Gemini's free tier is request-bound (no daily-token cap, ~1M TPM) which
  is why it's primary; Groq's free tier is the tighter 12K TPM / 100K TPD (so it was the
  binding constraint before — see the limits discussion). The article excerpt is capped at
  **`HINT_EXCERPT_CHARS` = 6000 chars** (client; re-capped server-side to `EXCERPT_CHARS`) —
  bumped from 1500 once Gemini became primary, since more context yields better
  category/summary/synonym fits and Gemini's 1M TPM makes the size free. The
  model writes `category` + `summary` + `synonyms` (`response_format: json_object`);
  **`category` is grounded in the page's wiki categories** — the client sends the article's
  visible categories (the Fandom "in:" bar, fetched inline via `prop=text|revid|categories`,
  hidden/maintenance cats dropped) in the request `categories` field, and the prompt tells Groq
  to base `category` on them (generalise the kind-of-subject ones, ignore proper-noun/setting
  names and anything resembling the title); with no categories it infers from the article as
  before. Categories are caller-supplied (capped 12×60 chars server-side) — like `text` they can
  mislead the hint but never leak the answer, since the output still runs the per-field leak
  filter against the server-derived real title.
  **`first_letter` is computed server-side** from the authoritative title (never trusted
  to the model), and is the one tier the per-field leak filter skips. (The server's
  `firstLetterOf` matches a Unicode letter/number so an accented/non-Latin title reports
  its real first character. The packet's `first_letter` field is now **unused client-side**
  — the client's **Letters** tier derives letters locally via `lettersHint`, same Unicode
  matching; the server still computes the field, harmlessly.) The model is given the
  article's **first sentence** (the start of the excerpt) and bases the **`summary`** on it
  (generalised, no proper nouns). **`synonyms` is a PER-WORD array** — one close 1-3 word
  synonym per title word, **in title order** — the **strongest** AI tier (costs **+50**, see
  **Score**). A common word gets a close synonym (*Hold → "fortress"*); a **proper name** is
  decoded **only from real-word parts in its OWN spelling** (*Triwizard → "three magician"*,
  *Blackwater → "dark river"*), NEVER from what the article says it means (so *Gulan ↛ "gold"* even
  though Anbennar lore translates it that way — too close); a name with no real-word parts and any
  function word get an **empty string `""`**. Each entry goes through the per-field leak filter
  independently (blank only the leaking entry; it also bars a synonym that embeds a title word as a
  substring, e.g. "stronghold" for "Hold"), so a synonym can be close yet never contains the answer.
  **The client renders it as the TITLE's SHAPE** (`buildSynonymValue()`): each word replaced by its
  synonym, function/stop words left literal (already revealed in the title), and an undecoded name
  shown as an **italic "Name"**. A **stop word is rendered literally FIRST** (checked before the
  array entry), so a stray/misaligned array value at its slot can never turn *of* into *Name* —
  e.g. *"Hold of Verkal Gulan"* → *fortress of Name Name*, never *fortress Name Name Name*; *"Triwizard
  Tournament"* → *three magician contest*. It **never prints a hidden title word**. The JSON string is
  stored verbatim in **`puzzles.summary`** (still a `text` column — no migration) and
  parsed client-side (`parseHintPacket`, which also copes with **legacy plain-sentence**
  summaries — the [puzzle.json](puzzle.json) fallback — by treating the whole string as the
  `summary` tier, AND a **pre-`synonyms` packet** carrying a single combined **`synonym`
  string** (dailies cached before the per-word change): the client falls back to rendering that
  string, or shows a placeholder when both synonym fields are empty; freshly-generated
  dailies and all random/custom games include the per-word `synonyms`). The first player to
  reveal an AI tier triggers the `hint` Edge Function, which generates via the LLM
  (Gemini→Groq, above) and writes the result back to `puzzles.summary`. Concurrent first-clickers are de-duped by
  an **atomic claim** on `puzzles.summary_generating_at` (`UPDATE … WHERE summary IS NULL
  AND the claim is free/stale`); the loser gets `status:"pending"` and the client polls.
  Random/custom games call the same function with no `puzzleId`; for these
  the packet is fetched **in the background** at article load (`fetchAndApplyHint`, tracked as the
  `hintFetch` promise).
  - **Cross-puzzle hint cache — `hint_cache`, keyed by `(wiki_host, page_id)`.** A
    MediaWiki **`page_id`** is the article's *stable* identity: it survives renames, moves and
    heavy edits (only delete+recreate mints a new one) — unlike `revision_id` (changes every
    edit; still the **content pin**) or the title (the answer + changes on rename). So the LLM
    packet for an article is generated **once and reused forever after** — across dailies on
    different dates, archived-daily replays, and (popular/curated) random games for the same
    page — instead of re-hitting the rate-limited LLM. The Edge Function (`readCache`/
    `writeCache`, [supabase/functions/hint/index.ts](supabase/functions/hint/index.ts)) checks
    `hint_cache` before generating and seeds it after, on **both** paths. **`puzzles.summary`
    still fronts it per-puzzle** — a daily that already generated never looks here again; the
    cache only pays off on the *first* generation for each article. **Staleness guard:** a
    cached packet older than `CACHE_STALE_MS` (**180d**) is treated as a miss and regenerated,
    so a substantially-rewritten page eventually refreshes. **Anti-poisoning:** because dailies
    read this shared cache too, the packet is always generated from the **server-derived**
    authoritative title (`fetchPageInfo(wiki, revisionId)` — one query yielding `{title,
    pageId}`) and stored under the **server-derived** `page_id`, never the caller's. The
    caller-supplied `pageId` is used **only as a fast read-probe** (harmless if wrong: packets
    are leak-filtered, a bad key just misses). The client sends `wiki`+`revisionId`+`pageId`
    (from `parse.pageid`) on the no-`puzzleId` path; the daily path derives everything from the
    puzzle row. If the derive fails (network), the fn still generates from the caller title but
    **skips caching** (degrade without poisoning). The table is **RLS-on, no-policy** (like
    `picked`): only the fn's `service_role` touches it; the browser always gets hints *through*
    the fn. Migration
    [20260618120000_add_hint_cache.sql](supabase/migrations/20260618120000_add_hint_cache.sql) —
    **push before deploying the updated function/client** (both degrade gracefully if it's
    missing, but cache benefit waits on it). If the player reveals an AI tier **while that fetch is still in flight**
  (Gemini can take several seconds), `revealTier` shows the **"Generating hint…"** state and
  **awaits `hintFetch`** rather than flashing the "(no … for this puzzle)" placeholder — the
  placeholder only appears once the packet has genuinely landed empty. (`haveTierData(key)` is the
  "do we already have this tier" check used both to reveal instantly and after the await; it knows
  the synonym tier lives in the `synonyms` array, not `hints.synonym`.)
  **UI** ([index.html](index.html)): a single **"Hints"** button (`#hintsBtn`) **TOGGLES**
  the `#hintbox` panel (`showHints()` — open/render if collapsed, hide if open; on mobile it
  opens/closes the `#hintsmodal` popup). The panel is rebuilt by **`renderHints()`** — a
  **Reveal a word** row first, then one row per tier, least→most revealing: **Reveal a word
  → Category → Summary → First sentence → Letters → Synonym → Source**. Each tier has its
  own **Reveal** button (`revealTier(key)`) whose label shows the next purchase cost
  (`nextRevealCost(key)`). `category`/`summary`/`synonym`
  come from the AI packet (revealed instantly if already fetched, else lazily generated);
  **First sentence** and **Letters** are **derived locally from the article + title** (no
  Groq, no leak filter — see below); **Source** folds in the old `showFandom`
  (`revealSource()` / `fandomUsed`).
  - **Reveal a word** (`reveal_word`, the free-word reveal) is **no longer a toolbar button**
    — it's the FIRST row of this panel. Its button calls `toggleArm()` to arm the pick-a-word
    mode; the player then clicks a non-title body word to reveal it (**+5**, up to `hintsLeft`
    = 3). On **mobile**, arming closes the Hints popup so the article underneath is tappable.
    `renderHints()` builds the row live from `hintsLeft`/`revealArmed`/game-over; `updateRevealBtn()`
    is now just "re-render the panel if it's open" (the standalone `#revealBtn` and its mobile
    `Word (N)` compact label are gone). The desktop tools row is now only **Hints + Give up**,
    and the mobile footer tools row likewise (Reveal lives in the Hints modal there).
  - **First sentence** (`first_sentence`, `revealFirstSentenceHint`): reveals the article's
    lead sentence **in place** — its non-title words un-redact in the body
    (`paintFirstSentenceTokens` reveals the *specific token objects*, not by key, so the
    same words elsewhere stay hidden) and the panel mirrors it as text (`firstSentenceText`,
    for mobile where the modal covers the article). **TITLE words stay blacked** so it's a
    strong clue, never a giveaway. `firstSentenceSlice` cuts at the first `.`/`!`/`?`
    followed by space/end with a preceding word ≥3 chars (so "J. K." doesn't cut early).
    One-shot; cost is **`+3` per still-hidden word it would uncover** (`firstSentencePer`, no
    base), so it scales with how much is left to reveal and is **locked at purchase**
    (`firstSentenceWords`). The live price is **dynamic in the panel** — guessing a word that
    sits in the lead sentence un-redacts it, so the displayed Reveal cost ticks down by 3 (the
    post-guess `applyGuess` re-renders the open Hints panel when the guess hit a first-sentence
    non-title word; `nextRevealCost` reads the live `firstSentenceHiddenCount`).
  - **Letters** (`first_letter`, **repeatable**, `revealNextLetter`): each click reveals the
    next title letter. It **un-redacts the letters in the ACTUAL title `#title` at the top**
    (not just a panel mask): a partly-lit title word renders its revealed prefix as text
    (`.letterlit`, a subtle marker underline so it reads as a hint, not a guess) and boxes only
    the still-hidden remainder (`buildPartialTitleSpan`). The panel still mirrors it as a
    hangman mask (`lettersHint`, e.g. `Title: Gol___ ______`) for mobile where the modal covers
    the article. **Reveals are PINNED per word, NOT a flowing count**: each title word token
    carries its own locked `t.lit` count, and a buy lights the first *still-hidden* word that
    isn't fully lit (`nextLitTarget()` — stop/guessed words are skipped, so it naturally moves
    to the next word once one is fully lit or guessed). Crucially, a letter does **not re-flow**:
    if you then guess the word it sat in, that word shows fully but its bought letters do **not**
    jump to the next word and hand you a free letter there — you'd pay again for that one (the
    earlier bug). The cost still escalates monotonically off **`lettersRevealed`** (the *purchase
    count*, first letter +20, letter *n* = `letterBase + (n-1)*letterStep`), which only ever goes
    up — so a guess never refunds or resets the price (`lettersRevealed` and the visible
    per-word lit can diverge: a letter "wasted" on a then-guessed word still counts toward cost).
    The per-word lit is persisted/synced separately as **`letterLits`** (`letterLitsSnapshot()` /
    `applyLetterLits()`; a pre-`letterLits` save/sync falls back to `distributeLettersFallback`).
    `applyGuess` only refreshes the open panel mask on a title-word guess (the title span is
    handled by `revealKey`; nothing re-flows). **Spelling a word's LAST letter promotes it to a
    real guessed word**: `revealNextLetter` detects `t.lit >= revealableCount(t.word)` and calls
    `applyGuess(t.key, t.word, false)` (guessed-guarded, idempotent), so the word counts toward
    the solve, shows in the history, reveals its body occurrences, and — in co-op — broadcasts as
    a normal `guess` so every teammate's board registers it the same way. This is **score-neutral**
    (a correct guess is `+0`; the letters were already charged via `letterCost(lettersRevealed)`)
    and doesn't make a clean solve (buying any letter already flips `summaryUsed`). Completing the
    final title word this way therefore wins the game (worst score, since the whole title was
    bought letter-by-letter — self-balancing). A partly-lit word stays purely visual until its
    last letter lands. Replaces the old single first-letter tier. All local from the title.

  Which tiers were shown is tracked in **`hintTiers`** (persisted in the daily localStorage
  state and restored into the panel) — the per-word-priced counters `lettersRevealed` /
  `letterLits` / `firstSentenceUsed` / `firstSentenceWords` / **`synonymWords`** are persisted
  **alongside** it and restored (`paintFirstSentenceTokens` re-reveals the sentence body on resume;
  `applyLetterLits` re-pins the per-word reveals — or `distributeLettersFallback` for a
  pre-`letterLits` save; `synonymWords` falls back to the live `synonymHiddenCount()` for a
  pre-`synonymWords` save that already revealed the tier;
  back-compat: a pre-counter save with `first_letter` in `hintTiers` → `lettersRevealed = 1`).
  `summaryUsed` stays the rollup boolean (any AI/derived tier used) for the `plays`
  `summary_used` column, `fandomUsed`/`source_used` for **Source**. **The leak filter now runs per field** (blank only the
  leaking tier, keep the rest) in the Edge Function — still mirrored against
  `scripts/lib/leak-filter.mjs`.
  **Anti-poisoning**: the cached daily path does **not** trust the caller-supplied
  `title` (anyone could POST a real `puzzleId` with a bogus title to pollute the shared
  `summary` — the answer is never stored, so it can't be validated against the row).
  Instead, the *generating* caller re-derives the real title from the puzzle's pinned
  `wiki`+`revision_id` via MediaWiki (`fetchTitleAtRevision`) and generates from that,
  falling back to the supplied title only if the fetch fails. The function also requires
  a **valid Supabase session** (a silent anonymous guest counts) so it isn't an open,
  unauthenticated LLM proxy — it's deployed `--no-verify-jwt` and checks the JWT in code.
  The auth gate **fails closed**: if there's no service-role key to validate the JWT *with*
  (stripped/misconfigured deploy), it refuses to generate rather than becoming an open
  proxy. (Per-user rate-limiting is still a deploy-level concern — Supabase's anon-signin
  limit + the provider dashboard caps.) Both the LLM and MediaWiki fetches use an
  `AbortSignal.timeout`, and the daily generate-path **releases its claim**
  (`summary_generating_at`) on any failure — so a slow/hung/failed generation can't strand
  the row in `pending` for the whole 30s stale window.
- The leak filter (reject an AI hint that contains a title word) lives in
  [scripts/lib/leak-filter.mjs](scripts/lib/leak-filter.mjs) (the unit-tested reference)
  and is **mirrored** in the `hint` Edge Function
  ([supabase/functions/hint/index.ts](supabase/functions/hint/index.ts)), which runs on
  Deno and is deployed separately. Change one → change the other. It **folds diacritics**
  (NFKD, strip combining marks) and matches **Unicode** letters/numbers
  (`/[\p{L}\p{N}]{3,}/u`), NOT ASCII `[a-z]` — the app supports any-language MediaWiki, and
  ASCII-only matching produced **zero guard words** for accented/non-Latin titles
  (Pokémon, Cyrillic, CJK), silently letting the answer leak. Covered in
  [tests/picker.spec.mjs](tests/picker.spec.mjs).

## Share text (Wordle-style)

The **Share** button copies a spoiler-free, emoji result via `buildShareText()` +
`buildShareUrl()` (clipboard only — deliberately **not** `navigator.share()`, which lets
the target rewrite the text). Three lines under the headline:
- a **proportional 10-block accuracy bar** (`accuracyBar(good, bad)`) — 🟩 for hit
  guesses vs ⬛ for misses, rounded to 10 blocks (each side keeps ≥1 block when it has
  any guesses). Omitted when there are no typed guesses yet (reveals/hints only).
- the exact counts line: `✅ N good  ❌ N bad  💡 N reveal(s)`.
- a **per-tier hint breakdown** — one icon+label per hint actually used, in the same
  least→most order as the Hints panel: **📂 category · 📄 summary · 📖 first sentence ·
  🔤 N letters · 🔁 synonym · 🏷️ source** (`SHARE_ICON` + `HINT_TIERS`, gated on
  `hintTiers` / `fandomUsed`). The Letters entry shows the **live count** (`🔤 3 letters`),
  not a generic label. This replaced the old single generic `📄 hints` marker — when you add a
  hint tier, add its icon to `SHARE_ICON` so it shows here too.

- a **score line** — `🎯 Score N (lower is better)` (see **Score** below).

Nothing leaked: no word lengths, no title, no fandom name — only outcomes. Keep it that
way (the source wiki is itself a paid hint). Covered by the two share tests in
[tests/app.spec.mjs](tests/app.spec.mjs) (the accuracy-bar regex + the exact tier label).

## Score (lower is better)

A golf-style score: **the goal is the lowest total**. A correct typed guess is free
(`+0`); every bit of help — **and time** — adds points: **`+1` for every full 10 seconds
of active play** (`SCORE.per10s`), **wrong guess `+1`, free word reveal `+5`, the
**source** / **summary** / **category** hint tiers `+10` each. **Three** tiers cost
dynamically, all on the same "per still-hidden word, locked at purchase" model:
- the **synonym** tier (the most revealing AI tier) is `SCORE.synonymPer` (`+25`) **× the
  number of STILL-HIDDEN non-stop title words** (`synonymHiddenCount()`) — it reconstructs the
  title's *shape*, but a synonym for a word you've **already guessed reveals nothing**, so those
  don't count. The displayed Reveal price is **live** (drops by `synonymPer` each time you guess
  a title word — `applyGuess` re-renders the open panel), and the count is **locked at purchase**
  into `synonymWords` (so a later title-word guess can't retroactively cheapen a hint you already
  got). A 2-word title with none guessed ≈ the old flat `+50`. Locked in `addTier` (and in the
  co-op `_applyRemoteHint`/`_applySync` from the sender's value, so every teammate pays the same).
  **An undecodable NAME is free**: a word whose synonym entry is empty (`""`, rendered as italic
  "Name") reveals nothing, so it must not add to the charge. The two counts deliberately
  **diverge**: the **displayed buy-price** keeps using `synonymHiddenCount()` (ALL still-hidden
  non-stop words) so the price **can't betray which/how many words are names** (a leak in itself);
  the **locked/charged** `synonymWords` uses `synonymChargeCount()`, which excludes the empty-entry
  names (same alignment + emptiness test as `buildSynonymValue`). So the score can go up by less
  than the button quoted — fine, since once revealed the player can see the "Name" slots anyway.
  (Legacy/combined-synonym packets have no per-word names → `synonymChargeCount` falls back to the
  full `synonymHiddenCount`.)
- the **first-sentence** tier is `firstSentencePer` (`+3`)
  **per still-hidden word it uncovers** (`firstSentenceBase` is `0`), locked at purchase in
  `firstSentenceWords` (its live panel price drops by 3 as you guess words in the sentence).
- the **Letters** tier escalates — letter *n* costs `letterBase + (n-1)*letterStep`
  (`+20, +25, +30, …`), so `letterCost(k)` sums the first `k` (the first letter still costs
  `+20`). The point values live in the `SCORE` map and `computeScore()` derives the total
**purely from the same play state the share line uses** (`guesses` → bad/reveal counts,
`hintTiers`, `fandomUsed`, `lettersRevealed`, `firstSentenceUsed`/`firstSentenceWords`,
plus `playActiveMs`) — so the live pill, the share text and the win/give-up banner can
never disagree (no separately-tracked counter to drift). `computeScore()` is defined next
to `buildShareText()`. NB `first_letter`/`first_sentence`/`synonym` are **skipped** in the
flat `hintTiers` cost loop — they're costed from their own counters (`letterCost`,
`firstSentenceWords`, `synonymWords`).

**The Source tier is FREE when the player chose the fandom.** When a game starts with the
source already revealed because the player explicitly picked that fandom — a feed
follow-card daily (`fandom_daily`) or **Random from a fandom** (`fandom_random`), both
loaded with `revealFandom:true` → `revealSource(true)` — the source isn't a hint they
spent, so it must NOT add `SCORE.source`. The auto-reveal sets a `sourceFree` flag
(distinct from `fandomUsed`, which only means "the source is shown"); **`sourceCharged()`
= `fandomUsed && !sourceFree`** is the single predicate for "source counted as a paid
hint" and is used **everywhere** the source is a spent hint: `computeScore()` (the `+10`),
the share breakdown's 🏷️ marker + its no-activity early-return, and `recordPlay`'s
`source_used` (so a chosen-fandom solve can still be a **clean solve**). It is reset in
`initGame`, **persisted in the saved state** (so a same-day reload keeps it free — important
because the resume path `loadDailyForWiki`/`loadFromRevision` doesn't re-pass `revealFandom`),
and **synced in co-op** (`_sendSync`/`_applySync` carry `sourceFree` so a joiner inherits
the host's free source). A *manual* panel reveal — `revealTier("source")` → `revealSource()`
with no arg — stays a paid `+10` (featured/full/curated games where the source was hidden).

**The time component counts ACTIVE play, not wall-clock.** It's `floor(playActiveMs /
10000) * SCORE.per10s` (currently `+1` per 10s), where `playActiveMs` accrues **only while the game is live AND the tab is
visible** (`accruePlayTime()` / `playClockRunning()`). This is deliberately NOT the same as
the play-log's `duration_seconds` (which is honest wall-clock, idle included) — a daily you
leave open for hours must **not** explode the score. So: each tick folds in the elapsed
slice **capped at 2s** (a system-sleep / throttled-timer gap can't dump a huge chunk), a
`visibilitychange` listener pauses/resumes the marker, and the value **freezes at the
finish** (`accruePlayTime()` is flushed in `checkWin`/`giveUp` right before `gameFinishedAt`
is stamped; once finished `playClockRunning()` is false so it stops). `playActiveMs` is
**persisted in the daily localStorage state** and restored by `restoreDailyState`, so a
same-day resume continues where it left off **without** re-adding the away time. It resets
in `initGame`, and again at the **versus** match start (`startMatch` / `_applyStart`) so the
versus time-score begins at **Play**, not at article load. **In versus** the time-score is
per-player (each races their own active clock); **in co-op** each client accrues its own
active time (guess-based points are identical across the shared board, the time component
may differ slightly per player).

Shown **live** in a `#scorePill` (`Score: <b id="scoreVal">`) in the `.statusbar` — visible
on both desktop and mobile (the status *message* is hidden on mobile, but the pill stays).
`updateScore()` repaints it and is called from **`refreshMeta()`** (every guess/reveal),
**`renderHints()`** (every hint-tier reveal), and a **1-second score clock** (`setInterval`,
near `placeHintbox`) that **early-returns when `playClockRunning()` is false** (not started /
finished / tab hidden / versus pre-start — the score is frozen, so it skips the recompute),
else accrues the time slice, repaints **only when the displayed score
changed**, and — **in versus** — re-broadcasts progress so opponents' standings tick up live.
It also lands in the **share text** (`buildShareText`) and the **win / give-up banner**
(`checkWin`/`giveUp`). When you add a new hint tier or paid action, add its cost to `SCORE`.

**Title-progress pill** (`#titleProgress`, next to `#scorePill` in the `.statusbar`, so it's
visible on **both** desktop and mobile). It shows **`🎯 N/M`** — non-stop title words found /
total (`titleKeyWords`) — surfacing the *actual win condition* (the masked title shows shape
but didn't say "you're 1 of 2 there"). Updated in `refreshMeta()`; gets a `.complete` class
(green) once all title words are found. It **leaks nothing** — the count is already inferable
from the masked title's boxes. Reinforced by feedback in `applyGuess`: a typed guess that hits
a title word flashes **green** (`flashKey` → `.flash-title`, vs the yellow `.flash` for an
ordinary hit) and sets a celebratory `#status` ("🎯 Title word! N of M — keep going."; the
status line is hidden on mobile, so the pill + green flash carry the signal there).

**Persisted for stats**: `recordPlay()` writes `computeScore()` into the **`plays.score`**
column (migration `20260615120000_add_plays_score.sql`, nullable — pre-column rows just
have no score and the aggregates ignore NULLs). It surfaces in two stats places:
**My stats** shows an **"Avg score"** tile (over *solved* games) in both the Dailies and
Free play sections — with the source selector this gives **avg score per fandom**; and the
**Daily metrics** modal shows an **"Avg score"** card via `daily_metrics`, which gained an
`avg_score` return column (migration `20260615120100_daily_metrics_avg_score.sql` — note it
must **`drop function` then recreate**, since Postgres won't `CREATE OR REPLACE` a changed
return type). Avg-score is over solved plays only, mirroring `avg_guesses` ("to complete").
**Deploy ordering**: the client references `plays.score`, so the migrations must be pushed
**before** the updated `index.html` ships — otherwise every `plays` upsert (and the My-stats
query) fails on the unknown column.

## UX feedback & accessibility details

A cluster of small in-game feedback/affordance touches (all in [index.html](index.html)):

- **Wrong-guess ring.** `submitGuess` calls `applyGuess` and, when it returns **0 hits**,
  `flashMiss(#guess)` adds a `.miss` class for 600ms — a coloured `box-shadow` ring (NOT a
  shake). It uses **`var(--bad)`** so it's red normally / cb-safe orange in colour-blind mode,
  and is a `box-shadow` (not `outline`) so it coexists with the yellow `:focus` outline. Its
  *appearance* is the signal, so it reads even where hue is ambiguous.
- **Article loading overlay.** `loadArticle` is a thin wrapper that adds `#article.loading`
  and `finally`-removes it around the real `loadArticleImpl` — so it shows on success AND
  failure (the random-search retry loop throws per rejected candidate; the overlay rides each
  try). `initGame` also drops it the moment the new article is drawn. The `.article-loading`
  child (a CSS `.spinner` + "Loading article…") covers `#article` while the live wiki fetch
  runs — **visible on mobile too**, where `#status` is `display:none`. The spinner animation
  is disabled under `html.reduce-motion`.
- **Screen-reader status.** `#status` is `display:none` on mobile (a hidden `aria-live` won't
  announce), so there's an **always-present visually-hidden `#srLive`** (`.sr-only`,
  `role=status aria-live=polite`) that `setStatus()` mirrors every message into — so loading /
  copied / wrong-guess / win messages are announced on all platforms.
- **Win/give-up retention.** Under the banner, `.win-cta` shows **Share result** (`#winShareBtn`
  → `doShare`) + **Play another** (`#winNewBtn` → `openMenu`), and — **dailies only**
  (`currentShare.kind==="daily"`) — a live **`⏭ Next daily in HH:MM:SS`** countdown
  (`#nextDaily`). `msToNextDaily()` is ms to the next **Europe/Amsterdam** midnight (matches
  `todayLocal`); `updateNextDailyCountdown()` is called in `checkWin`/`giveUp` and ticked by
  the **1s score-clock interval** (added *before* its `playClockRunning()` early-return, so it
  keeps ticking even though the time-score is frozen at the finish).
- **Autofocus.** `initGame` focuses `#guess` **only on desktop** (`!mqMobile.matches`) — on
  mobile autofocus would pop the keyboard and shove the layout on every load.
- **"Also visit"** (`#alsoBtn` in the header `.controls`, hidden ≤640px like `#statsBtn`;
  `#optAlsoBtn` in the mobile **Options** menu) opens the static `#alsomodal` — a short
  Jaardle blurb + an external link to `https://jaardle.nl` (hardcoded/trusted, plain `<a
  target=_blank rel=noopener>`). Same `.modal` pattern (✕ / backdrop / Esc).

## Custom link & shared links — any MediaWiki

The "Custom link" game and shared `?wiki=&rev=` links work against **any MediaWiki
site**, not just Fandom. `parseWikiUrl()` extracts the title from `/wiki/Title`,
`/w/Title`, or `?title=Title` (plus an optional Fandom `/<lang>` prefix), and
`resolveApiBase()` probes candidate endpoints (`/api.php`, `/w/api.php`) to find the
right one — Fandom/minecraft.wiki/guildwars2 use `/api.php`, Wikipedia uses `/w/api.php`.
`apiGet()` sends `origin=*` for anonymous CORS (all these sites return `ACAO: *`). The
**daily/feed/random** paths (`loadPuzzlePointer`, `loadRandomArticle`) and the **picker**
(`apiBaseFor()` in pick-daily.mjs) all resolve the api endpoint the same way and cache it
per host — so the pool can mix Fandom, minecraft.wiki, Wikipedia (`en.wikipedia.org`,
`/w/api.php`) and `wiki.guildwars2.com`. Note: random Wikipedia titles are often very
obscure (poor guessing targets) — disable `en.wikipedia.org` in the `wikis` table if its
dailies feel unfair.

`loadFromWikiUrl()` reports progress **and errors inside the New game modal**
(`#urlMsg` via `setUrlMsg()`), not just on the `#status` bar — that bar is hidden
behind the open modal, so a bad/malformed link used to look like a silent no-op.
`parseWikiUrl()` throws human-readable messages (invalid URL, no title found, non-http),
which `setUrlMsg(msg, true)` renders in red right under the input. **On mobile** `setUrlMsg`
also `scrollIntoView`s the error (the scrollable modal can push it below the fold), so the
user immediately sees something went wrong — gated by `matchMedia("(max-width:640px)")`.

**Because the source wiki is untrusted** (any MediaWiki), its API-returned title, host,
revision url and `rightsinfo` license name/url are **attacker-controlled on a custom or
shared `?wiki=&rev=` link**. So none of it is ever put into the DOM via `innerHTML`:
`attribution()` builds the source line with `createElement`/`textContent`, and any url that
becomes an `href` goes through `safeHttpUrl()` (only `http(s):` — no `javascript:`/`data:`).
The article body is already safe (parsed with `DOMParser`, which doesn't run scripts, and
emitted as `textContent` tokens). Keep new wiki-derived text out of `innerHTML`.

## Multiplayer — co-op & versus (`mp`)

Two realtime modes, both built on the **`mp`** module in [index.html](index.html) (a single
`const mp = {…}` object just above the `boot()` IIFE) over **Supabase Realtime** (broadcast +
presence — already bundled in `supabase-js@2`, otherwise unused). **Requires a real
(non-anonymous) account** — gated on `isRealUser()`; guests are nudged to sign in.

- **Co-op (samen):** everyone shares **one board**. A local typed guess broadcasts a `guess`
  event (in `applyGuess`, guarded by `mp.active && mp.mode==="coop" && !remote && !isHint`); a
  free-word reveal broadcasts `reveal` (in `handleBodyClick`); a revealed hint tier broadcasts
  `hint {tier, packet}` (in `addTier`/`revealSource`). Incoming events are applied with
  `applyGuess(…, /*remote*/true)` so they **never re-broadcast** (no echo loop). The hint
  **packet travels verbatim**, so a teammate revealing a tier costs **no extra Groq call**
  (respects the per-minute limit). The two **locally-derived** tiers ride the same `hint`
  event: **Letters** carries both its `letters` purchase count AND the `litMask` (the PINNED
  per-word reveals, `letterLitsSnapshot()`); `_applyRemoteHint` catches `lettersRevealed` up via
  `max`, `applyLetterLits(litMask, /*mergeMax*/true)`, then `drawTitle()`s so the exact same
  letters light up in the receiver's title (and stay pinned there too — no re-flow on either
  side). **First sentence** carries only the tier name — the receiver re-runs
  `paintFirstSentenceTokens` on its shared board (same article → same reveal). A late joiner's
  `sync` also carries `lettersRevealed`/`letterLits`/`firstSentenceUsed` (`_applySync` applies
  the mask + `drawTitle()`s). Because the per-word lit is shared verbatim (not re-derived), the
  Letters tier is consistent across clients; a title-word guess — local or remote — runs
  through `applyGuess` (which refreshes the open panel mask), and pinned letters never move.
  **Every** co-op guess is credited via `g.by` (your own name
  for local guesses — `mpName()` — the sender's for remote ones via `mp._incomingBy`); the
  history row groups the hit-count + name in a right-aligned `.rmeta` span (name last) so the
  count never floats in the middle, all via `textContent` (never `innerHTML`). A late joiner
  asks the host for the current board with `sync-req` → host replays `sync`. **Give-up is shared:**
  `giveUp()` broadcasts `giveup` (co-op) so a teammate's give-up ends the game for everyone
  (`_applyRemoteGiveUp` → `giveUp()` with `_remoteGiveUp` set to suppress the echo). A solve is
  already shared — the winning guess is a broadcast `guess`, so every client's `checkWin` fires.
- **Versus (tegen elkaar):** under **New game**. The **host** creates the room and presses
  **Play** (`mp.startMatch()` → broadcasts `start {startAt}` and sets `gameStartedAt = now`, so
  **the timer only begins at Play**, not at article load). Everyone else waits behind the
  **`#mpWaiting`** overlay (input disabled) until `start`, then adopts the shared `startAt` as
  `gameStartedAt` (fair clock). The host's invite **Copy** button lives inside that overlay
  (`#mpWaitCopyBtn`) — the overlay covers `#mpPanel`, so the panel's button is unreachable while
  waiting. Each player has their **own** board; live progress flows through **presence**
  (`mp.publishProgress()` re-`track()`s `{pct,guesses,score,solved,gaveUp}` on every `refreshMeta`),
  rendered as a **standings** list (`#mpStandings`, sorted by solved then score), first solver
  flagged 🏁. Logged-but-not-yet on a leaderboard. **Keeping standings live:** `_connect` listens
  to presence **`sync` AND `join`/`leave`** (a peer's re-`track()` can surface as join/leave, not
  only sync — listening to all three is what stops opponents' stats freezing after join);
  `_enterRoom` re-`track()`s once the article's loaded; and `publishProgress` repaints your OWN
  row too (presence echoes don't return to the sender). **`publishProgress` must fire on
  EVERY scoring action, not just guesses:** `refreshMeta` calls it (guess/reveal), but a
  **hint reveal** goes through `renderHints` (not `refreshMeta`), so `addTier`/`revealSource`
  **also** call `mp.publishProgress()` — otherwise an opponent kept your stale score until
  your next guess (the `+10`/`+20` from a hint didn't show). The **1-second score clock** (see
  **Score**) likewise re-broadcasts in versus so the **time penalty** ticks up on opponents'
  standings live.

The in-game HUD (`#mpPanel`, docked at the top of `#controlcol`) shows a **"Copy invite link"**
button (`#mpCopyBtn` — **no raw link text** anywhere, per user pref; the URL goes to the clipboard
via `mp.inviteUrl()`) plus the roster/standings. The versus waiting overlay (`#mpWaiting`) has its
own `#mpWaitCopyBtn`. Verified in-game on desktop+mobile with screenshots (the footer-capped mobile
layout stays readable with the slim copy button). **Layout note:** the desktop `#playarea` grid
uses `grid-template-rows:min-content 1fr` — the controls column spans both rows, so a tall controls
column (hints open + standings) over a short article would otherwise stretch the status row and
leave a big gap under the status bar; pinning the status row and letting the article row (1fr)
absorb the slack keeps the article flush under the status bar.

**Core invariant:** a room persists **nothing** server-side — no tables, no RLS, no migration.
Only the article **pointer** (`wiki`+`rev`, exactly what `?g=` carries) + gameplay events ride
the ephemeral channel, so "the answer/article text is never stored" still holds.

**Protocol/transport.** One channel per room: `supa.channel("room:"+roomId, {broadcast:{self:
false}, presence:{key:userId}})`. **Two Supabase Realtime limits shaped this design** (Free *and*
Pro — see [[supabase-realtime-limits]]):
- **Broadcast `{event:"*"}` is unreliable** in supabase-js (the wildcard often never fires). So
  every event is bound **per name** from `MP_EVENTS` (`ch.on("broadcast",{event:ev},…)`). Using
  `"*"` is what left guests stuck — the host's reply never reached them.
- **Presence `track()` is capped at 5 calls / 30s per client.** So presence carries **membership
  only** (`_presenceMeta` = `{userId,name,role}`, + the host's `cfg:{mode,wiki,rev,started,
  startAt}`), tracked sparingly (subscribe, enter, startMatch). **Live versus progress goes over
  BROADCAST** (`progress` event, `publishProgress` on every `refreshMeta`; broadcast allows 100
  msg/s) — NOT presence. Publishing progress via presence per-guess (the old approach) blew the
  5/30s cap and silently froze opponents' stats. `_applyProgress` merges a peer's broadcast
  progress onto their presence membership in `mp.peers`.

A joiner learns the mode + article via an **explicit broadcast handshake**: on subscribe the guest
sends `hello` (retried ~every 1.5s until entered, `_startHello`), the host replies `config` (→
`_enterRoom`); the host also re-sends `config` when a new peer appears in presence (backstop).
Presence-cfg is a secondary fallback. Until the config lands the guest's mode is unknown, so the
HUD shows **"Joining…"** (not a "Co-op" mislabel), and `mpLivePct()`/`_selfMeta()` tolerate
uninitialised `tokens`/`guesses` (no article yet). A `CHANNEL_ERROR`/`TIMED_OUT` subscribe status
(Realtime unreachable/disabled) is surfaced to the user instead of a forever "Joining…".
Transport is behind `mp.send(event,payload)` / `mp._recv(event,payload)` / `mp._recvPresence(
roster)` so it's **test-injectable**: `window.__MP_FAKE_TX = true` skips the real channel, the
page acts as the local peer, and tests simulate the *remote* peer by calling `mp._recv` /
`mp._recvPresence` (and assert outgoing events in `mp._sent`).

**Event role-gating (anti-griefing).** Broadcast events carry no verified sender, so host→guest
events are gated by the *receiver's* role: `_applyStart` and `_applySync` early-return when
`role === "host"` (a peer can't spoof a `start` to force-begin the host's clock, or push a `sync`
to overwrite the host's authoritative board); `config` is already `guest && !entered`-gated and
`cancel` is host-returns-early. `guess`/`reveal`/`hint`/`giveup` (co-op shared board) and
`progress` (versus, own stats) stay open to any participant by design. This is defence-in-depth
for an invited-friends room, **not** cryptographic auth — a determined peer with the link can't be
fully stopped without a server referee.

**Entry points / routing.** New game modal has **Co-op** / **Versus** cards (`#coopBtn`/
`#versusBtn` → `chooseMpMode()` sets `pendingMpMode`); after the chosen article loads,
`loadArticle` calls `mp.createRoom(pendingMpMode)`. An **"Invite (co-op)"** button (`#inviteBtn`,
next to Share) is shown to a real user whenever **any** article is loaded and you're not already
in a room (`updateInviteBtn` derives the rev from `currentShare.rev || META.source.revision_id`,
so it works on a daily too); it `createRoom("coop")`s around the **current** article, keeping your
progress. `createRoom` normalises `currentShare` to a plain custom pointer (clears `dailyPuzzleId`/
`dailyFeatured`/`dailyDate`) so converting a daily isn't scored/replay-blocked. **Versus host can
cancel** before starting (`#mpCancelBtn` → `cancelMatch()` broadcasts `cancel` then `leaveRoom`;
guests get `_applyCancel` → released to solo). A **`?room=<id>`** link joins: `boot()` detects it, gates behind sign-in
(`needSignIn()` + `#authJoinNote`) when not a real user, and `consumePendingRoom()` (from `onAuth`)
joins once signed in. **Stats:** finished co-op/versus games log to `plays` with new
`game_type`s **`coop`/`versus`** (no migration — `game_type` is free `text`; `currentShare.
gameType` is set by `createRoom`/`_enterRoom`); they surface in My stats as **Free play** rows. **Converting a DAILY to co-op is different**: it must stay in
*daily* stats, so `createRoom` keeps its daily identity (game_type `featured_daily`/`fandom_daily`,
same `puzzle_id`, replay-block) and instead flags **`plays.coop = true`** (migration
[20260615130000_add_plays_coop.sql](supabase/migrations/20260615130000_add_plays_coop.sql) — a
nullable-safe `boolean default false`; **push before shipping the client**, like `plays.score`). The
co-op flag is sticky via `mpCoopPlay` (reset in `initGame`, set in `createRoom`/`_enterRoom`,
**persisted in the daily localStorage state** so a same-day reload keeps it after the ephemeral room
is gone). A co-op solve is **not** submitted to the competitive `scores` leaderboard
(`submitScore` early-returns on `mpCoopPlay`) — it still counts in personal daily stats + the
`daily_metrics` completion aggregate. My stats → Dailies shows a **"Co-op"** tile (10 tiles now);
`aggregate()` returns `coopCount`. A random/custom co-op game needs no flag — it's already isolated
by `game_type='coop'`.

**Tests:** [tests/multiplayer.spec.mjs](tests/multiplayer.spec.mjs) — the sign-in gate, co-op
guess/hint/reveal propagation (+ the `by` tag), the versus waiting→start gate, presence standings,
the `coop` `game_type` log, and the invite URL. Fully hermetic via `window.__MP_FAKE_TX`. **Not**
covered (no live Realtime in CI): the true cross-client socket path — smoke-test that in two
signed-in browser windows after deploy, and confirm Realtime is enabled in the Supabase dashboard
(broadcast/presence are on by default; no Postgres CDC / publication needed — we use no tables).

## Key files

- [index.html](index.html) — the entire app. Top-level `let`/`function` declarations
  are global lexical bindings (classic script), which is why tests can read/assign them
  via `page.evaluate`.
- [scripts/pick-daily.mjs](scripts/pick-daily.mjs) — the daily picker. Pure helpers
  (`badTitle`, `probe`, `pickedKey`, `leaksTitle`, `stripTags`) are **exported** for unit
  tests; the CLI body runs only when executed directly (`isMain` guard). Run:
  `node scripts/pick-daily.mjs --dry-run` (also `--date=`, `--force`).
- [supabase/functions/hint/index.ts](supabase/functions/hint/index.ts) — Deno Edge
  Function that generates a spoiler-free hint via an LLM — **Gemini first, Groq fallback**
  (`LLM_PROVIDERS`/`generate()`), keeping the API keys server-side.
- [supabase/functions/merge-anon/index.ts](supabase/functions/merge-anon/index.ts) — Deno
  Edge Function that re-parents an anonymous guest's `plays` onto a real account on
  sign-in (see "Anonymous guests & account merge").
- [.github/workflows/daily-puzzle.yml](.github/workflows/daily-puzzle.yml) — runs the
  picker daily. GitHub cron is UTC-only with no DST, so to roll over at **local
  (Amsterdam) midnight** year-round it fires at **both 22:00 and 23:00 UTC** (00:00
  CEST and 00:00 CET respectively); whichever hits local midnight does the work and
  the other is a no-op. The picker **exits early when that local date's dailies
  already exist** (`alreadyPicked()`, unless `--force`), so the redundant run never
  re-picks and burns fresh pool articles. (GitHub may still delay a scheduled run by
  minutes-to-an-hour under load — that lag is outside our control.)
- [puzzle.json](puzzle.json) — the bundled fallback pointer, used when Supabase is
  absent/empty (e.g. local dev without keys).

## Database & migrations

The schema lives in **`supabase/migrations/`** and is managed with the Supabase CLI via
`npx` (no global install). **The migrations are the single source of truth** for the
current schema — read them (not `supabase-schema.sql`) to know prod's shape.
[supabase-schema.sql](supabase-schema.sql) is **only a baseline snapshot** (a
human-readable, run-once-in-the-SQL-editor bootstrap that mirrors the baseline migration);
it is deliberately **not** kept in sync with later migrations, so don't treat it as
current. It's outside the `db push` pipeline, so its staleness never affects prod.

The CLI runs **without `link`/`login`/access-token** — it connects straight to prod via
`--db-url`, read from the gitignored `.env` (`SUPABASE_DB_URL`, a full Postgres
connection string). Pass it without echoing the secret:
```bash
export SUPABASE_DB_URL="$(grep -E '^SUPABASE_DB_URL=' .env | head -1 | cut -d= -f2-)"
```

Workflow for a schema change:
```bash
npx supabase migration new <name>                       # creates supabase/migrations/<ts>_<name>.sql
# ...write the ALTER/CREATE SQL...
npx supabase db push --dry-run --db-url "$SUPABASE_DB_URL"   # preview
npx supabase db push --db-url "$SUPABASE_DB_URL"            # apply to PROD
```
- **Never edit the baseline migration** (`20260612171038_baseline.sql`) — it mirrors prod
  at the point migrations were introduced and is already marked `applied` in the remote
  history (via `migration repair`), so it is never re-run. New changes = new files.
- The project is **not linked** and there is **no local Supabase stack** (deliberate). All
  CLI migration commands therefore need `--db-url "$SUPABASE_DB_URL"`.
- **`db push` writes to PROD** (there is no staging). Always `--dry-run` first and confirm
  with the user before the real push.
- **RLS isn't covered by the Playwright suite** (no local Supabase), but you CAN verify it
  ad-hoc with `psql "$SUPABASE_DB_URL"` inside a `BEGIN … ROLLBACK` transaction (zero
  residue): load the migration, seed rows as the owner (owner bypasses RLS), then
  `set local role authenticated; set local request.jwt.claims = '{"sub":"<uuid>",...}'`
  and assert who can read/write. Also `has_function_privilege('anon'/'authenticated'/
  'service_role', 'fn(args)', 'execute')` for grants, and `set local role anon` +
  `select … from picked` to confirm the answers table stays private. This is how the
  `plays` owner-only policy, the `merge_anon_plays` grants, and the `picked`-is-private
  invariant were checked — re-run that pattern after touching any policy/grant. (Running
  the whole migration in a rolled-back txn also validates the DDL applies cleanly —
  stronger than `db push --dry-run`, which doesn't execute it.)

## Tests

`npm test` runs Playwright (headless Chromium). Some tests hit the live Fandom API (they
load a pinned Harry Potter revision) — they need network.

**Eyeballing layout changes:** [scripts/dev-screenshot.mjs](scripts/dev-screenshot.mjs)
renders the header in headless Chromium at given viewport widths and saves PNGs to
`.tmp/shots/` (gitignored) — use it to *see* CSS/layout edits instead of guessing. Start
the static server first, then run it:
```bash
node tests/static-server.mjs &                 # serves index.html on :5599
node scripts/dev-screenshot.mjs 1920 1440 1280 # default widths if none given
```
Note the **≥1600px vs <1600px header split** (see the `.topbar`/`header` CSS): above
1600px the hamburger + controls hug the screen edges while the brand is centred to the
1500px content column (so it aligns above the article); below 1600px the article column
reaches the screen edge, so everything collapses into the centred `.wrap` column to avoid
overlapping the title. Always screenshot **both** sides of that breakpoint after touching
the header.

- [tests/app.spec.mjs](tests/app.spec.mjs) — game UI. Stubs Supabase to **EMPTY**
  (`puzzles` → `[]`), so it exercises the graceful "Supabase absent → puzzle.json
  fallback" paths. Includes the hint-tier tests: the **Letters** escalating-cost reveal,
  the **First sentence** lead-sentence reveal (title words stay masked), and that both
  survive a reload (against the deterministic Golden Snitch fallback).
- [tests/supabase.spec.mjs](tests/supabase.spec.mjs) — Supabase happy paths. Mocks
  **POPULATED** REST responses so `loadPuzzle` (Supabase branch), `loadDailyMetrics`
  (the `daily_metrics` RPC anonymous aggregate **only** — the **"Daily metrics"** modal,
  formerly "Leaderboard"; the per-player ranked list from `scores` has been removed, so
  the modal shows just the aggregate stat cards; DOM ids are
  `#metricsBtn`/`#metricsmodal`/`#metricsList`),
  `submitScore` (payload + best-score logic) and `recordPlay` (the `plays`
  log: finished-game payload + an in-progress/unfinished row) run for real. The Supabase
  client is real but every `**/rest/v1/**` call is intercepted; auth is faked by
  assigning `currentUser` via `page.evaluate` (no real login). `routeRest` swallows
  `**/rest/v1/plays**` so the per-guess `recordPlay` upserts stay hermetic; the
  `recordPlay` tests override that route to capture the payload (and poll for the **final
  `solved`** upsert, since one fires per guess). Two **replay-blocking** tests also live
  here: a same-session re-open of a solved daily stays locked, and a **cross-device**
  re-open re-locks from the server (`plays` GET → a finished row) **without** pushing a
  0-guess clobber (asserts no `plays` POST fires — the `serverFinished` guard).
- [tests/picker.spec.mjs](tests/picker.spec.mjs) — pure-function unit tests for the
  picker. Imports the exported helpers; no browser, no network.
- [tests/multiplayer.spec.mjs](tests/multiplayer.spec.mjs) — co-op + versus (`mp`). Drives the
  real DOM as the local peer and simulates the remote peer via `mp._recv`/`mp._recvPresence`
  (`window.__MP_FAKE_TX` skips the live channel). See **Multiplayer** above.

**Conventions:** mock Supabase by routing `**/rest/v1/<table>**`. `.maybeSingle()`
queries: return `[]` for "no row" or `[{...}]` and supabase-js reads element 0.
Differentiate score GETs (best-score check vs leaderboard list) by the `select=`/embed
in the request URL or the method.

## Daily-feed follows (Settings + "Configure dailies")

The header **Settings** button opens a modal with a **Profile** section (real accounts
only) plus **Preferences** (and a Privacy-policy button). **The Daily-feed config lives in
the feed drawer, NOT Settings** — see **Configure dailies** below.

**Profile** (`#profileSec`, `hidden` unless `isRealUser()`) — a display-name editor:
`#displayNameInput` + `#saveNameBtn`. `saveDisplayName()` writes `profiles.username`
(`update … eq(id)`, own-row RLS, 24-char cap), surfaces a `#nameMsg` status (`.ok`/`.err`),
and on success updates `currentProfile` + calls `renderAuth()` to refresh the "Signed in
as …" label. `username` is **`text unique`**, so a clash returns Postgres `23505` →
"That name is taken." Guests have no profile row, so the section is hidden for them
(`syncProfileControls()`, called by `syncPrefControls()` and again from `onAuth` if the
modal is open so it appears/disappears on sign-in/out). No migration — `profiles` and its
update policy already exist.

**Preferences** (device-local prefs, all in `localStorage`):
- **Theme** — a **3-state `<select>` `#themeSelect`** (System / Light / Dark) →
  `setTheme(mode)`/`themePref()`/`applyTheme()`, `redigeerdle:theme`. The palette is a set
  of CSS variables on `:root`; `html.dark` overrides them (`--paper`/`--ink`/`--surface`/
  `--hintbg`/…). **`"system"` is the default and stores NO key** (`themePref()` falls back to
  `"system"`); `"light"`/`"dark"` store that literal. The **head script applies the resolved
  theme before first paint** (no flash): `dark` when the pref is `dark`, or `system`/unset AND
  `prefers-color-scheme: dark`. In `"system"` mode it's kept **live** by a
  `matchMedia("(prefers-color-scheme: dark)")` `change` listener (added in `loadPrefs`) —
  explicit Light/Dark ignore the OS (guarded by `themePref()==="system"`). The yellow
  `--marker` (flash/locate highlights) keeps hard-coded dark text in both themes — light text
  on yellow is unreadable.
- **Motion** — a **3-state `<select>` `#motionSelect`** (System / Normal / Reduced) →
  `setMotion(mode)`/`motionPref()`/`applyMotion()`, `redigeerdle:motion`, toggling the
  **`html.reduce-motion`** class. CSS `html.reduce-motion` kills the `.topbar`/`.feedpanel`
  slide transitions + sets `scroll-behavior:auto`; the JS scrolls (`gotoWord`, the ↑/Top
  buttons) read the **same class** via `scrollMotion()` → `"auto"`. **`"system"` is the
  default (no key)** and mirrors `prefers-reduced-motion` (head script pre-paint + a live
  `matchMedia` listener); `"reduced"`/`"normal"` force it on/off, ignoring the OS. Colour-fade
  `.flash` transitions are **kept** (not motion, and `flashKey` relies on the fade-out to clear
  the highlight). Replaced the old toggle-less `@media (prefers-reduced-motion)` block.
- **Colour-blind friendly colours** (`#cbToggle` → `setColorblind()`/`isCb()`,
  `redigeerdle:cb`, `html.cb`, applied pre-paint by the same head script). The meaning-carrying
  green/red signals (title-word `.flash-title`, `#titleProgress.complete`, heatmap
  `.cell.solved`/`.cell.missed` + its legend, `#nameMsg.ok`) read **semantic `--good`/`--bad`
  vars** (default green `#1f9d55` / themed `--classified` red); `html.cb` swaps them to an
  **Okabe-Ito-safe blue `#0072b2` / orange `#e8730c`** pair (distinguishable for all common
  CVD). The ordinary-hit `.flash` stays yellow (`--marker`) — yellow-vs-blue is unambiguous in
  cb mode. When adding a new colour that distinguishes success/failure, use `--good`/`--bad`,
  not a hard-coded green/red, or the cb toggle won't cover it.
- **Jump to a word when you guess it** (`#scrollToggle` → `prefAutoScroll`,
  `redigeerdle:autoscroll`, default on). When on, a correct typed guess scrolls the article
  to that word (via `gotoWord(key, prefAutoScroll)`); when off, it still highlights the word
  but doesn't scroll. `loadPrefs()` reads it at boot, `syncPrefControls()` reflects both
  toggles when the modal opens.

**Privacy policy** — a **`Privacy policy`** button (`#privacyBtn`) at the very bottom of
the Settings modal opens the `#privacymodal` (same `.modal` pattern as How to play:
✕ / backdrop / Esc, styled via `.privacy-body`). It discloses what the game stores (account
e-mail/name, anonymous guest id, the `plays`/`scores`/`follows` data, device-local
`localStorage`) and the processors (Supabase, Google OAuth, GitHub Pages, the source wikis,
the Gemini/Groq hint providers, **Cloudflare Web Analytics** — the cookieless page-view
beacon in `index.html`'s `<head>`/before `</body>`). The **contact e-mail** is
`fryingpanpotato@gmail.com`. There is **also a standalone public page
[privacy.html](privacy.html)** (same text) — this is the URL to give Google's OAuth consent
screen as the privacy-policy link (the modal isn't a URL). **Keep `privacy.html` in sync with
the modal text** when the policy changes (two copies, rarely-changing legal text).

**GDPR data rights (account export + deletion).** The privacy modal has a **Your data**
section (shown only for `isRealUser()`; guests get a "sign in" note):
- **Download my data** (`exportMyData`) — reads the caller's own `plays`/`scores`/`follows`/
  `profiles` rows (owner-only RLS scopes them) and triggers a client-side JSON download
  (`redigeerdle-mydata.json`). No server/edge function — pure client.
- **Delete my account** (`requestAccountDeletion`) — `confirm()`s, then stamps
  **`profiles.deletion_requested_at = now()`** (migration
  [20260618130000_add_account_deletion.sql](supabase/migrations/20260618130000_add_account_deletion.sql);
  written via the existing owner-only `profiles update own` policy — no new policy, RLS is
  row- not column-scoped). The UI then shows "scheduled for deletion on <date+7d>" and a
  **Cancel deletion** (`cancelAccountDeletion`, clears the column back to null). `syncDataRights()`
  (called when the modal opens) re-reads the flag via `refreshDeletionState()` and toggles the
  scheduled/cancel UI. **CSS gotcha:** `.data-actions`/`.data-pending` use `:not([hidden])` so the
  `hidden` attribute still wins (a bare `.x{display:flex}` overrides `[hidden]`).
- **The actual deletion** is done by **[scripts/purge-deletions.mjs](scripts/purge-deletions.mjs)**,
  run daily by the **daily-puzzle GitHub Action** (extra step, same `SUPABASE_URL` +
  `SUPABASE_SERVICE_ROLE_KEY` secrets — no new secret). It selects profiles with
  `deletion_requested_at` older than **7 days** and hard-deletes each `auth.users` row via the
  admin API (`DELETE /auth/v1/admin/users/{id}`, service_role). **Every per-user FK cascades from
  `auth.users`** (`profiles` ON DELETE CASCADE → `scores`/`follows`; `plays` references
  `auth.users` directly) so one admin delete removes ALL the player's data. Cancelable: a user
  who clears the flag before the job runs simply isn't in the query. `--dry-run` lists without
  deleting; `--self-check` verifies the cutoff math offline. **Deploy ordering:** push the
  migration **before** shipping the client (the client reads/writes `deletion_requested_at`) and
  before the workflow step can work — the `--dry-run` 400s with "column does not exist" until then.
  The admin-delete path isn't testable in CI (no prod) — smoke-test once after deploy (schedule a
  throwaway account, run `--dry-run`, then a real run).

**Configure dailies** — the daily-feed config (**Homepage daily** picker `#homeDailySelect`
+ the fandom follow list, searchable via `#followSearch` / `filterFollowList()`) **moved out
of Settings into the feed drawer**: it's a native `<details id="feedConfig" class="feed-config">`
**at the very top of the `#feed` drawer** (above the cards) whose `<summary>` is the
**"Configure dailies"** button — clicking it *unfolds* the config inline (a 2nd menu in the
drawer). It renders **lazily on the `toggle` event** (`renderFollowList()` when it opens —
`openSettings()` no longer calls it); **collapsing it `renderFeed()`s** so a freshly-followed
fandom shows up in the cards. `onAuth` re-renders the list only if `#feedConfig.open`. The
`#settingsNote` ("saved to your account" / "on this device") moved into this panel. Storage
follows the rule:
**signed in → the `follows` table** (own-only RLS);
**logged out → `localStorage` (`redigeerdle:follows`)**. On sign-in, local picks are
merged into the account (`mergeLocalFollowsToAccount`, idempotent upsert). The wiki list
comes from `getWikiList()` (the `wikis` table — `{host, display_name, icon}`, cached;
falls back to the baked-in pool). `wikis.icon` is free text: an **image URL** (rendered
as `<img>`) or an **emoji** (rendered as a `<span>`) — see `wikiIconNode()`. The seed
fills `icon` with each community's favicon via Google's favicon service (square PNG;
Fandom 403s direct `/favicon.ico` hotlinks). When `icon` is null the client derives that
same favicon from the host (`faviconFor()`), and `wikiLabel()` falls back to the stripped
host when `display_name` is null — so a newly-added wiki still shows a name and an icon.
The **daily feed** (`renderFeed()`) is a **left slide-in drawer** (`#feed`, a `.feedpanel`
fixed to the left edge below the header, opened by the header **hamburger** button,
`#feedBtn`) — mutually exclusive with the auth panel; closes on Esc / card-click / the
drawer's **×** (`#feedClose`) / clicking the dimmed backdrop (`#feedBackdrop`). The drawer
starts at `top:var(--header-h)` and the `.topbar` sits above it (`z-index:45`) so the
hamburger stays clickable to toggle the drawer shut. The **top card is always a pinned
"Featured daily"** (`data-pinned`) — the featured general daily, rendered *before* the
follows and **always shown** (never filtered out by the search box). It must **not reveal
its fandom** — the source wiki is itself a paid hint (the **Source** tier inside the
**"Hints"** panel, `revealSource()`/`fandomUsed`; internals keep the historical `fandom`
name, the UI label and share text say **"Source"**) — so it uses a neutral ⭐ icon + the label
"Featured daily", not the underlying wiki's name/favicon; clicking it calls `loadPuzzle()`
(the featured home daily). Below it the drawer reads `follows` and shows today's daily per
followed fandom as a scrollable vertical list (icon, name, status ✓/✗/…/—).
`renderFeed()` only populates content — open/close is owned by `#feedBtn` / `closeFeed()`,
not by `renderFeed`. Clicking a follow card loads that fandom's daily; a search box
(`#feedSearch`, shown at 2+ fandoms) narrows the rows live via `filterFeedCards()`.

**Homepage daily** (`#homeDailySelect`, populated by `populateHomeDailySelect()` inside
`renderFollowList`): the daily the player wants to land on **after the dailies reset** —
either the featured **"Featured daily"** (value `""`, the default) or one of your
**followed fandoms**. Stored device-local in `localStorage` (`redigeerdle:homedaily`), like
the dark-mode / auto-scroll prefs (`homeDailyPref()` / `setHomeDailyPref()`). A
previously-chosen fandom that's since been unfollowed stays selectable (labelled "(not
followed)") so the saved choice isn't silently lost.

**Boot / resume order** (no special URL): **every** game load — a daily OR a solo
random/custom game — stamps `localStorage` (`redigeerdle:lastgame`) via
`rememberLastGame()`, called once in `loadArticle` (after `currentShare` is set, so it
covers both branches). For a daily it stores `{ kind:"daily", wiki, day:todayLocal() }`; for
a solo game it also stores the pinned `{ rev }` so `loadFromRevision` can reproduce the
article. On boot we **resume the EXACT last-opened game — daily or solo — but only while
it's still the same local day** (`last.day === todayLocal()`): solo →
`loadFromRevision(last.wiki, last.rev)`, daily → `loadDailyForWiki(last.wiki)` (each falls
back to `openHomeDaily()` if the load fails — `loadFromRevision` now returns a success
boolean for this). Once the dailies roll over at local (Europe/Amsterdam) midnight,
`last.day` no longer matches and we fall through to the **homepage daily** (`homeDailyPref`
→ `loadDailyForWiki(home)`, or the featured daily). So: **reload mid-game → right back on the
same article *with your progress*** (a random game stays a random game); **first visit of a
new day → your configured homepage daily**. (`?p=daily` still forces the featured daily
regardless; `?d=`/`?g=`/`?wiki=&rev=` shared links still open their target directly — and a
`?g=` reload also resumes solo progress, since it routes through `loadFromRevision` too.)
`lastGame()` reads the new key and **falls back to the legacy `redigeerdle:lastdaily`** so a
player mid-daily across the upgrade still resumes.

**Solo-game progress persistence.** Dailies persist progress per-puzzle
(`redigeerdle:daily:<id>`, replayed by `restoreDailyState`); solo (random/custom) games now
persist to **one** slot, `redigeerdle:sologame` (`SOLO_STATE_KEY`). There's only ever one
"current" solo game, so a single slot is bounded (no growth) and naturally resumes only the
most recent one. The saved blob carries `id` (`wiki@revision`, via `soloId()`) plus `playId`
+ `gameType`, so a resume **keeps the same `plays` row and `game_type`** (no duplicate
play-log row). `saveDailyState()` is now generalized: it picks the key via `currentSaveKey()`
(daily → per-puzzle, solo → `SOLO_STATE_KEY`) and writes for both. The replay logic is shared
in **`replaySavedState(saved)`** — called by `restoreDailyState` (after its daily-only
finished-marker / `restoreFinishedFromServer` checks) and by **`restoreSoloState()`**.
`restoreSoloState` (called at the end of `loadArticle`'s custom branch) replays **only when
`saved.id === soloId()`** — i.e. the slot holds THIS exact article — so a fresh game with a
different revision falls through untouched; it has **no server path** (solo games aren't on
the leaderboard, so there's nothing to re-lock). `pruneOldDailyState()` only touches
date-prefixed `redigeerdle:daily:<id>` keys, so it leaves `redigeerdle:sologame` /
`redigeerdle:lastgame` alone.

Header layout: three groups — the **hamburger** (`#feedBtn`, opens the daily-feed drawer)
at the far left, the **brand** (`.brand` — title + **New game** + **How to play**) above
the article, and **Settings** + **Sign in/out** (`.controls`) at the far right. The header
lives in a **sticky `.topbar`** (`position:sticky; top:0; z-index:45`) that stays pinned as
you scroll (the daily-feed drawer is a separate fixed element below the header, not inside
`.topbar`). The `.topbar` lives **outside `.wrap`** (a direct `<body>` child) so its
**background** spans the **full viewport width**.

**Sign in** opens the `#authmodal` **popup** (a `.modal`, same pattern as How to play /
Settings / New game — backdrop, ✕, Esc-to-close), *not* a dropdown in the bar. The login
form (`#authpanel`: Google + e-mail/password) lives inside that modal-card; `renderAuth()`
closes the modal on successful sign-in.

The placement of the three groups is **width-dependent** (see the `@media (max-width:1599px)`
block):
- **≥1600px:** `header` is full-width and `position:relative`; the hamburger and controls
  are **`position:absolute`** pinned to the screen edges (`left/right:20px`), while the
  `.brand` is **centred to a 1500px column** (matching `.wrap`) so the title lines up
  exactly above the article's left edge.
- **<1600px:** the article column reaches the screen edge — so pinning the brand there
  would collide with the hamburger. Everything collapses into the centred `.topbar-inner`
  (max-width 1500/760, like `.wrap`): hamburger at the column's left, controls pushed
  right (`margin-left:auto`), brand just after the hamburger. A dedicated narrow/mobile
  layout is in progress (see **Mobile layout** below).

Verify both sides of that breakpoint with `scripts/dev-screenshot.mjs` (see **Tests**).
A small boot script keeps
`--header-h` in sync with the **`.topbar`'s full rendered height** (measured off the
`.topbar` element itself — padding + border, margin excluded — not the inner header plus a
magic offset, so it stays exact as the header wraps to two rows when narrow); the sticky
guessbar / controls column (`#controlcol`) pin **directly below it** at `top:var(--header-h)`
(no extra offset, and the `.topbar` has **no `margin-bottom`**), so the controls column
borders the header with **no gap and no drift** as you scroll. The feed drawer / backdrop
anchor at the same `top:var(--header-h)`.

## Mobile layout

A dedicated mobile layout is being built incrementally (separate from the
`880px`/`1600px` desktop breakpoints above), all under one **`@media (max-width:640px)`**
block.

**No sideways scroll — `.red { max-width:100% }`.** A redaction box's width tracks the word
length (`buildSpan`: `word.length * 0.55em`, no cap), so a very long word/name would render a
box **wider than the viewport** and cause horizontal scroll on **any** width. `.red` is capped
at `max-width:100%` so an over-long box clamps to the column width (length tag still shows);
normal words are untouched, so nothing extra wraps. Don't remove the cap.

**Status row fits to ~320px.** The `.statusbar` row (score/title-progress pills + the
**Social** + **Daily metrics** buttons) overflowed at 320px (the "Daily metrics" button ran
off-screen). The mobile block shrinks `.statusbtns button` (`padding:6px 7px; font-size:.6rem`)
and tightens the gaps so it stays on **one line** down to 320px — no wrapping (space is
precious on mobile). Verified at 320×478.

**Mobile header (done): one tidy row.** A `1fr auto 1fr` grid on `header` puts the
**hamburger** (`#feedBtn`) flush left, the **brand title** (`#homeBtn`) dead-centre, and a
generic **Options** menu (`#optionsBtn`) flush right — the two `1fr` side columns balance so
the title is screen-centred regardless of the side widths. The title still does what it does
everywhere (`openHomeDaily()` → the configured homepage daily). Hidden here to make room:
**New game** + **How to play** (in `.brand`) and **My stats** / **Also visit** / **Settings**
/ **Sign in/out** + the signed-in name (`.who`) (in `.controls`) — they're collapsed behind
the **Options** menu (see next). `#optionsBtn` is `display:none` by default and shown only
`≤640px`; the `≤640px` `.controls` rule hides `#authToggle`/`#signOutBtn` and shows it.

**Mobile Options menu (done).** On mobile the header's right button is **Options**
(`#optionsBtn`) which opens the **`#optionsmodal`** popup (standard `.modal` pattern — ✕ /
backdrop / Esc), a vertical `.optmenu` of: **How to play · My stats · Settings · Also visit ·
Sign in/out**. Each button **closes the popup then delegates to the existing handler**
(`openStats()` / `openSettings()` / open `#helpmodal` / `#alsomodal`; Sign-in clicks the
hidden `#authToggle`, Sign-out calls `signOut()`). The **`#optSignIn`/`#optSignOut`** pair is
toggled by **`renderAuth()`** alongside the header's own `#authToggle`/`#signOutBtn`, so it
tracks the auth state. This consolidates the utility/account actions that used to crowd the
feed drawer, freeing it for daily selection (see next).

**Scrollable modals (done).** All popups (`.modal` — New game / Settings / How to play /
Sign in / Daily metrics) get `overflow-y:auto` + `overscroll-behavior:contain` on the
overlay, with `align-items:flex-start`, so a card taller than the viewport **scrolls** (the
whole overlay scrolls, top stays reachable) instead of being clipped — important on short
mobile screens. Mobile also trims the overlay padding to `4vh 10px` (from `9vh 16px`) for
more usable height. Applies on all widths, but matters most on mobile.

**Mobile drawer actions (done).** The daily-feed drawer's bottom bar `.feed-actions`
(`#feedActions`) now holds **only New game** (`#feedNewBtn`) — Settings / How to play / My
stats / Also visit **moved into the header Options menu** (above), so the drawer has room for
daily selection (the user's ask: selecting a daily was cramped). `.feed-actions` is
`display:none` by default (desktop has New game in `.brand`) and `display:flex` only
`≤640px`; it's `flex:0 0 auto` so it pins below the scrollable `.feed-cards`. `#feedNewBtn`
**closes the drawer then `openMenu()`s**. The follow/homepage-daily config lives in the
drawer's own **Configure dailies** `<details>`, not Settings. **`closeSettings()` just
`renderFeed()`s** (refreshes the feed content in case the drawer is open behind Settings) and
does **not** navigate the player into the drawer — Settings now opens from the Options menu
(mobile) / `.controls` (desktop), not from the feed, and the follow config isn't in Settings,
so the old mobile `openFeed()`-on-close was obsolete (it dumped you into the feed after ✕).
`openFeed()` is the shared open-and-render helper (the `#feedBtn` toggle calls it).

**Mobile auto-hide header (done).** On mobile the top bar **hides while scrolling down and
reappears while scrolling up** (the usual mobile pattern), instead of staying pinned. The
`.topbar` is still `position:sticky`; a scroll handler toggles a **`.topbar--hidden`** class
(`transform:translateY(-100%)`, with a `transition`) based on scroll direction — sticky
reserves no gap once you've scrolled past, so the content doesn't jump when it hides. Gated
by `matchMedia("(max-width:640px)")` so **desktop keeps the always-pinned sticky bar**; a
small delta ignores scroll jitter and it never hides within 60px of the top. Leaving mobile
width clears the class. (`--header-h` is unaffected; the left feed drawer still anchors at
`top:var(--header-h)`.) **The bar stays pinned while the feed drawer is open** —
`onScrollHeader` early-returns (removing `.topbar--hidden`) when `#feed.open`, and `openFeed()`
clears the class — otherwise hiding the bar leaves an empty strip above the drawer (which
anchors at `--header-h`).

**Mobile article top + Hints popup (done).** On mobile the top of the
article shows only a **Social** + **Daily metrics** button (`.statusbtns`); the status
message (`#status`) is **hidden** (`.statusbar .status { display:none }`).
**Social popup:** on **every width** the **Share** + **Invite (co-op)** buttons collapse behind one
**Social** button (`#socialBtn`, always shown) that opens the `#socialmodal` popup — desktop and
mobile behave identically now (the old desktop-inline layout is gone). `placeSocial()` reparents
the SAME `#shareBtn`/`#inviteBtn` nodes into `#socialModalBody` (a one-time move; runs at boot and
on the mobile-breakpoint change), so `updateInviteBtn` keeps toggling the one `#inviteBtn` node
there — including **hiding Invite once the game is solved/given up** (`!solved && !gaveUp` in
`updateInviteBtn`, unchanged by the relocation). Clicking Share/Invite inside the
popup closes it; ✕ / backdrop / Esc also close it. The **Hints**
panel (`#hintbox`, built by `renderHints()`) is shown **in a popup**, not above the
article: the footer **Hints** button (`showHints()`) opens the `#hintsmodal` modal (same
`.modal`/`.modal-card` pattern as How to play / Settings — ✕, backdrop-click, Esc). A JS
`placeHintbox()` **reparents `#hintbox` by viewport** — mobile → into `#hintsModalBody`
(inside the modal); desktop → back into `#controlcol` **just above the word guesser
(`.guessbar`)** (rendered inline, no modal). CSS `order` can't move a node across containers,
hence the reparent; it runs at
boot and on the `mqMobile` `change` event (which also closes the popup when leaving
mobile), and moving the node keeps any already-rendered tiers. `showHints()` **toggles**:
on mobile it opens/closes the `#hintsmodal`; on desktop it renders the panel if collapsed
and hides it (`display:none`) if already open.

**Tools + guesses + guesser → sticky footer (done).** Below **`640px`** the whole
`#controlcol` (not just the guessbar) is **`position:fixed` to the bottom of the viewport**
as a flex column, stacked top→bottom via `order`: the **tool buttons** (`.tools` — now just
**Hints / Give up**; Reveal-a-word moved into the Hints panel, so the footer has two tools,
not three; **always one row** — `flex-wrap:nowrap`, the buttons share
the width equally (`flex:1 1 0`) and their label scales with the viewport
(`font-size:clamp(.52rem, 2.7vw, .66rem)`) so nothing wraps down to ~300px; the buttons
also carry `overflow:hidden; text-overflow:ellipsis` as a safety net so no label can ever
spill out of the fixed footer. (The free-word reveal is now the first row of the Hints
modal — `revealTier`/`toggleArm`; arming it closes the modal so the article is tappable.)
Then the
**guessed-words list** (`.history`, scrolls), then the
**guesser row** (`.guessbar`). On mobile the guessbar gains a small **↑ back-to-top button**
(`#guessTopBtn`, `.guess-top`) left of the `#guess` input (hidden on desktop via the base
`.guess-top { display:none }`; same `scrollTo top` as the meta-row `#topBtn`), then the input,
then a **smaller** `#go` Guess button. The footer is **capped
at `3/7` of the viewport height** (`max-height:calc(100vh * 3 / 7)`); the history scrolls
inside that cap, and with no guesses yet the footer shrinks to just tools + guesser.
`z-index:30` keeps it **under the modals (`50`) and the feed drawer (`35`/`40`)** so those
still cover it when open. The `.meta` strip (Guesses / Revealed% / show-lengths) is
**re-homed into the footer** here as a slim single row (`order:2`, between the tools and the
history) — it used to be hidden on mobile; the redundant **Top** button is dropped (`#topBtn`
hidden ≤640px) since the guessbar already carries its own ↑ (`#guessTopBtn`), and the
win-progress is covered by the `#titleProgress` pill in the status bar. The `.hintbox` (the
Hints panel output) opens in the `#hintsmodal`
popup (see above), not in the footer. A JS sync publishes `#controlcol`'s live height as
**`--footer-h`** (a `ResizeObserver`,
mirroring the `--header-h` one) so `.wrap`'s `padding-bottom` tracks the footer as it
grows/shrinks and the article's tail always clears it. Note `dev-screenshot.mjs` only
captures `.topbar`, so to eyeball the footer take a full-viewport shot (e.g. a throwaway
Playwright `page.screenshot` at `390×844`).

`getWikiList()` is resilient to the `display_name`/`icon` columns not existing yet: it
retries with `select("host")` so the list **always comes from the DB** (not the baked-in
`RANDOM_WIKIS` fallback) even before that migration is applied — only the names/icons wait.

## Per-fandom dailies

`puzzles` holds **one daily per `(wiki, date)`** (unique constraint), not one per date.
Going-forward id convention is `"<date>:<wiki>"`; older rows keep a bare-date id. Exactly
one row per date has **`is_featured = true`** — the home-page / anonymous puzzle (the
`loadPuzzle` query is "latest `is_featured` on or before today"). The nightly picker
([scripts/pick-daily.mjs](scripts/pick-daily.mjs)) loops **all enabled wikis**, picks one
good article each (no AI — cheap), and flags one as featured.

`pickForWiki` is **two-stage**:

1. **Popularity-first (the usual path).** It pulls the wiki's **most-revised articles**
   (`list=querypage&qppage=Mostrevisions`, paged up to `POPULAR_WANT` = 1000) and
   weight-samples one toward the top (`biasedIndex` — quadratic bias, so the famous top
   gets most picks but with enough spread). **Edit count is our portable popularity
   proxy**: Fandom does **not** expose real view counts (PageViewInfo's `list=mostviewed`/
   `prop=pageviews` are unrecognized, and `Popularpages`/HitCounters was removed from
   MediaWiki core), and there's **no cross-wiki "vital/featured articles" standard**
   (e.g. `Category:Featured articles` exists on minecraft.wiki but not harrypotter, and
   Wookieepedia uses a non-flat nomination system) — but `Mostrevisions` is a cached,
   pre-ranked QueryPage available on Fandom + generic MediaWiki + Wikipedia, and its top
   is reliably the iconic pages (Harry Potter → "Triwizard Tournament", DC → "Green
   Lantern Ring"…). Candidates already used (in the 365-day `picked` window) are filtered
   out, so the daily **never repeats** and the bias naturally works deeper into the list
   over the year. **Window sizing matters:** the picker consumes ~365 picks/year/wiki and
   won't repeat within `EXPIRE_DAYS` (365), so the popular window MUST exceed 365 — that's
   why we pull up to 1000 (a top-300 would force a random fallback for ~65 days/year).
2. **Random fallback** (the original method): **`generator=random` + `prop=info`** so each
   candidate's wikitext `length`/redirect status come back up front — bad titles,
   redirects and stubs are rejected cheaply (no parse), and only promising pages
   (longest-first) get a `parse` call. It samples up to `ATTEMPTS` (50) rounds × 10 with
   early exit. **Reached when** a wiki has no `Mostrevisions` (e.g. Wikipedia often falls
   through), or its popular titles are all unsuitable/exhausted — i.e. small/junk-heavy
   wikis (comic-issue DBs like marvel/dc, which fail ~74% with naive `list=random`).

Both stages share `tryArticle()` (parse → `badTitle`/dedup/`probe` quality gate) and the
`thresholds(round)` ladder (strict until `RELAX_FROM`, then easing). Picks are logged
`[popular]` vs `[relaxed @round N]`, and the run summary counts both. Not a hard 100%; if
a wiki still misses a day the feed shows "—" for it and it retries next run.

The **client "Curated random"** (`loadCuratedArticle` in index.html) mirrors this exactly:
a popularity-first stage (its own `popularTitles(apiBase)` + `biasedIndex`, single
`qplimit=500` fetch since it's a one-shot with no `picked` dedup) then the original
random-rounds search as fallback. The two helpers are duplicated client↔picker (like
`badTitle`/the leak filter) — change one, change the other. The picker's `cleanPopularTitles`
+ `biasedIndex` are **exported** and unit-tested in [tests/picker.spec.mjs](tests/picker.spec.mjs).

- **Daily progress / state** is keyed by **puzzle id** (`stateKey(dailyPuzzleId)`), not
  date — fandoms share a date, so date-keying would collide.
- **Replay-blocking is two-layered.** Same device: `restoreDailyState` replays the
  `localStorage` state and re-locks a solved/given-up daily. But that state is
  **device-local**, so a real signed-in user on another device (or after clearing
  storage, or a now-merged guest) had no local block — the merge moves `plays` to the
  account but nothing consulted the server. So when there's **no usable local state**,
  `restoreDailyState` calls **`restoreFinishedFromServer()`**: for a **real** signed-in
  user it queries the owner-only `plays` log for a finished (`solved` OR `gave_up`) row
  with `play_id = dailyPuzzleId` and, if found, calls **`showFinishedDaily()`** to reveal
  + lock the board (banner: "you already completed/gave up on this daily") and drops a
  **minimal local marker** (`guesses:[]` + the outcome) so the next load needs no server
  round-trip. Because that reconstructed end-state has **no real guess list**, it sets a
  module-level **`serverFinished`** flag that **short-circuits `recordPlay` and
  `submitScore`** — otherwise the 0-guess snapshot would clobber the authoritative
  server row / push a bogus leaderboard entry. `restoreDailyState` is now **async**
  (`loadPuzzlePointer` awaits it). Guests get no server re-lock (a fresh device = a new
  anon id with no matching `plays`); that's fine — the merge is a real-account feature.
  (Known minor gap, out of scope: a featured daily solved **as a guest** then opened on
  a new device isn't back-filled into `scores` — guests never scored, and the
  reconstruction has no guess count to submit.)
- **Scoring**: only the **featured** daily is scored for now (`submitScore` guards on
  `dailyFeatured`); per-fandom feed dailies are playable + shareable but not yet on a
  leaderboard. Per-fandom leaderboards (repointing `scores` to `(user, wiki, date)`) are
  the next step if wanted. The richer per-game stats (all types, incl. random) live in
  the separate **`plays`** log — see below; `scores` stays the leaderboard.
- Bootstrap: the feed is only populated once the new picker has run for today (the
  per-fandom rows must exist). Run `node scripts/pick-daily.mjs` once after deploy.

## Play-log & per-game stats (`plays`)

The **`plays`** table (migration `20260613215424_add_plays_table.sql`) is a **private,
per-player log of every game** — across **all** game types, not just the scored daily.
It is **separate from `scores`** (the public leaderboard): `scores` is `unique(user_id,
puzzle_date)`, `puzzle_date NOT NULL`, and **publicly readable**, which fits neither
random/custom games (no date/identity) nor per-fandom dailies (shared date). `plays`
solves that and also records `wiki` on every row, so later **per-fandom aggregates**
(`GROUP BY wiki`) include dailies AND random plays alike.

- **RLS is owner-only** (read/insert/update `auth.uid() = user_id`, modelled on
  `follows`) — raw rows stay private, so a row's `wiki` can never leak today's featured
  source to other players. **Public stats are exposed only via `security definer` RPCs**
  that return aggregated numbers (never raw rows) — don't loosen the read policy to
  `using (true)`. The first such RPC is **`daily_metrics(p_puzzle_id)`**
  ([migration](supabase/migrations/20260614012445_add_daily_metrics_rpc.sql)): it
  aggregates `plays` for **one daily** (keyed by `puzzle_id`, so date-sharing fandoms
  don't blur) and returns `{players, solved, completion_pct, avg_guesses, avg_seconds,
  avg_score}` — `players` = everyone with a row for that puzzle (the completion-%
  denominator); `avg_guesses`/`avg_seconds`/`avg_score` are over **solved** plays only
  ("to complete"; `avg_score` added in
  [migration](supabase/migrations/20260615120100_daily_metrics_avg_score.sql)). `EXECUTE`
  is revoked from `public` and re-granted to `anon`/`authenticated` (logged-out players
  see the stats too). Broader per-fandom aggregates (`GROUP BY wiki`) can follow the same
  pattern.
- **`user_id` references `auth.users(id)`, NOT `profiles(id)`** (unlike `scores`/`follows`).
  Anonymous guests log plays and have no profile row — see "Anonymous guests" below.
- **What's logged** (`recordPlay()` in index.html): `game_type` (`featured_daily` /
  `fandom_daily` / `full_random` / `curated_random` / `fandom_random` / `custom`),
  `wiki`, `puzzle_date`/`puzzle_id` (dailies only), `revision_id`, `total_guesses`,
  `good_guesses` (typed, ≥1 hit), `wrong_guesses` (typed, 0 hits), `reveals` (paid
  free-word reveals), `score` (the golf score — see **Score** above), `revealed_pct`,
  `summary_used`, `source_used`, `gave_up`, `solved`, `started_at`, `duration_seconds`.
- **`game_type`** comes from `currentShare.gameType`, set in `loadArticle` (dailies:
  `opts.featured ? featured_daily : fandom_daily`; the random/curated callers pass
  `full_random`/`curated_random`/`fandom_random`; everything else = `custom`).
- **In-progress AND finished**: `recordPlay()` upserts the *current snapshot* on **every
  state change** (it's hooked into `saveDailyState()`, which already fires on every
  guess/reveal/summary/source/finish for all types), not just at the end. A game
  **started but never finished** simply stays as a row with `solved=false &
  gave_up=false`. Guards: needs a session (a **guest/anonymous session counts** — see
  below), skip during restore-replay (`restoring`), and skip a freshly-loaded game with
  no interaction. Best-effort — a failure never blocks
  gameplay. `checkWin`/`giveUp` no longer call `recordPlay` directly (the trailing
  `saveDailyState()` covers them); `onAuth` and the tail of `restoreDailyState()` sync
  the current snapshot on sign-in / resume.
- **`recordPlay()` is DEBOUNCED** (the public name is the scheduler; the worker is
  `recordPlayNow()`). It coalesces the per-guess upserts into **one trailing write
  ~1.5s after the last change** (`RECORD_PLAY_DEBOUNCE`) instead of a network round-trip
  on every keystroke-guess. A **FINISHED game flushes immediately** (`solved || gaveUp` →
  `recordPlayFlush()`), so the terminal row is never delayed/lost; a **tab-hide
  (`visibilitychange`) and `pagehide`** also `recordPlayFlush()` so an in-progress row
  survives a quick close within the debounce window. (The Playwright `plays` tests poll
  with a multi-second timeout, so the debounce is transparent to them.)
- **`play_id` is the upsert key** (`unique(user_id, play_id)`), so repeated calls update
  ONE row. Dailies use `play_id = puzzle_id` (a same-day resume keeps the same row);
  random/custom mint a fresh `play_id` per game (`mintPlayId()`), so each is its own row —
  **but a same-day reload resume keeps it**: the minted id is persisted in
  `redigeerdle:sologame` (`playId`) and `restoreSoloState` restores it into `currentPlayId`,
  so a resumed solo game updates its existing row instead of logging a duplicate.
- **`revealed_pct`** is derived from the **guesses** (sum of hits ÷ non-stop word count),
  NOT the token state — because `checkWin`/`giveUp` reveal every token, the live token
  state would always read 100%. So it honestly reflects how much the player uncovered
  *through play* (meaningful for give-ups too).
- **`started_at`/`duration_seconds`** use `gameStartedAt` (set in `initGame`), which is
  **persisted in the daily localStorage state** (`startedAt`) and restored by
  `restoreDailyState`, so a same-day resume reports an honest duration. It's wall-clock
  (includes idle/away time). **The clock freezes at the finish**: `checkWin`/`giveUp`
  stamp `gameFinishedAt` (also persisted as `finishedAt` and restored before `checkWin`
  re-runs on resume), and `recordPlay` computes `duration_seconds` as
  `(gameFinishedAt || Date.now()) - gameStartedAt` — so a solved/given-up daily reopened
  later in the day (or a post-finish Hints reveal → `saveDailyState` →
  `recordPlay`) does **not** keep the duration ticking past the solve moment. Cadence is
  the **debounced** write described above (was one-upsert-per-guess).

**Per-guess performance (the hot path).** A guess touches only the tokens for that word, not
the whole article: `initGame` builds a **`tokensByKey` Map** (`key → token[]`, document order)
and caches **`nonStopTotal`** (the revealed-% denominator), so `recordGuess`/`revealKey`/
`flashKey`/`gotoWord` are O(hits) not O(all tokens). The **`#history` list is append-only** —
`refreshMeta` prepends just the one new row (via `guessRow(g)`, tracked by `historyRendered`)
instead of `innerHTML=""`-rebuilding the whole list every guess; it self-heals with a full
rebuild if the list ever shrinks (only `initGame` resets `guesses`). Rows are immutable once
built (hits + co-op `by` are set before render), which is what makes append-only safe.

## My stats (personal aggregate over `plays`)

The **"My stats"** button opens the `#statsmodal` popup — a Wordle/Jaardle-style
**personal** dashboard. It is the per-player counterpart to **Daily metrics**: where Daily
metrics aggregates *everyone* for *one* puzzle via the `daily_metrics` RPC, My stats
aggregates the *caller's* *own* games across *all* time and types. It **reads the raw
`plays` rows directly** (`loadMyStats()` → `supa.from("plays").select(...).eq("user_id",
currentUser.id)`) — no RPC needed because the **owner-only RLS already scopes the query to
`auth.uid()`**, so it can only ever return your own rows. **No DB migration** — pure client
aggregation over data that already exists. Works for a **guest session too** (this device's
anonymous account); the modal shows a "Sign in to keep your stats across devices" note when
`!isRealUser()`.

**Button placement** (two entry points, never both visible):
- **Desktop**: `#statsBtn` in the header `.controls`, just left of **Settings**. Hidden
  `≤640px` (same rule that hides `#settingsBtn`/`.who`).
- **Mobile**: `#optStatsBtn` in the header **Options** menu (`#optionsmodal`) — closes the
  popup then calls `openStats()`.

**Layout — a source selector on top, then two split sections:**
- **Source selector** (`#statsSource`, built in JS so option labels use the wiki helpers
  via `textContent`): **Combined** (everything) or one source. A "source" is the wiki host
  (`sourceKeyOf`), **EXCEPT featured dailies, which fold into a neutral "⭐ Featured daily"
  pseudo-source** — the modal **never names a featured wiki** (the source is itself a paid
  hint, same invariant as the feed's pinned card). Changing it re-renders from the cached
  `statsRows` (no refetch). `statsSource` persists across opens; resets to Combined if the
  saved source vanishes from the data.
- **Dailies** (`featured_daily` + `fandom_daily`, `DAILY_TYPES`/`isDailyRow`): 9 tiles —
  Played, Solved %, Current/Best streak, Avg guesses (over **solved**), Avg time, Clean
  solves (solved with **no reveals, no summary, no source** — our analogue of Jaardle's
  "perfect"), Gave up, **Avg score** (over **solved**, lower is better) — plus the heatmap.
- **Free play** (`full_random` / `curated_random` / `fandom_random` / `custom`): the same
  tiles **minus the two streak tiles** (streaks are a daily concept), no heatmap.
- Each section shows "No daily/free play games yet." when the scoped set is empty (e.g. the
  "Featured daily" source has no free play).

**Shared helpers:** `aggregate(rows)` → played/solved/winPct/gaveUp/clean/avgGuesses/
avgSeconds/avgScore (avgScore over **solved** rows that have a `score`) for either section;
`dailyStreaks(dailyRows)` → consecutive calendar days with a
**solved daily** (current counts back from today, or yesterday if today isn't solved yet so
an unplayed today doesn't break it; best is the longest run); `heatmapHTML(dailyRows)` → a
119-day (17-week) contribution grid (green `.cell.solved` = solved a daily that day, red
`.cell.missed` = played but solved none, gray = none; today's cell carries a `.today` yellow
ring so the player can locate it; oldest-left, weekday-aligned via `mondayIndex()` padding).
**The cell classes are `solved`/`missed`, NOT `win`/`loss`** — `.win` is the global
"DECLASSIFIED" banner class (`display:none` until `.show`), so a heatmap cell with class
`win` was silently hidden (0×0, but with a green *computed* style, so class-count/
`getComputedStyle` checks falsely passed — assert `toBeVisible()` instead). Likewise avoid
`done` (feed-card class). Keep new heatmap classes scoped/unique. It keys each daily
by its **`puzzle_date`** (the puzzle's own date), NOT the calendar day it was played — so
today's cell only greens when you solve the daily *dated* today; if the nightly picker
hasn't produced today's featured daily yet, `latestPointer` serves an earlier-dated one and
the green lands on that day, today staying gray. All date math is `ymdMinus()` (DST-safe,
noon-UTC anchored) against `todayLocal()`.
**Combined** scopes nothing, so the streak/heatmap count a day if **any** source's daily was
solved that day.

- **Live refresh**: like the metrics modal, an open stats modal re-renders after each
  `recordPlay()` upsert and on `onAuth` (sign-in swaps whose stats these are).
- Covered in `tests/supabase.spec.mjs` ("My stats splits dailies vs free play…"): routes
  the `plays` **GET** to fixture rows (split from the `recordPlay` POST by method), asserts
  the two sections + tile counts, the neutral source options (no `harrypotter`), the heatmap
  counts, and that filtering to `__featured__` empties the Free play section.

## Anonymous guests & account merge

So logged-out play still reaches `plays` (incl. random games), the app uses **Supabase
anonymous auth**. This needs **"Allow anonymous sign-ins" enabled in the dashboard**
(prod auth isn't in `config.toml` — the project isn't linked; see SUPABASE_SETUP.md).

- **Silent guest session**: `initAuth` calls `signInAnonymously()` when there's no
  session (and `signOut` starts a fresh one after). It's **invisible to the player** — no
  prompt, no UI. `startGuestSession()` swallows failures (anon disabled / rate-limited →
  play just stays local). Default rate limit is 30 anon sign-ins/hour/IP; **no CAPTCHA**
  yet (add Turnstile later if abused). Anonymous users **count toward MAU**.
- **`isRealUser()`** = signed in AND `!is_anonymous`. A guest behaves like **logged-out**
  for the UI (`renderAuth`), the public leaderboard (`submitScore` is gated on
  `isRealUser`), `follows` (localStorage, not the table), and `ensureProfile` (guests get
  **no profile** — that's why `plays.user_id → auth.users`). But `recordPlay` writes for
  guests too — that's the whole point.
- **Merge on sign-in** (handles the "played a week as guest, then sign into an existing
  account" case): before any sign-in, `captureAnonForMerge()` snapshots the guest
  `{id, access_token, at}` into `localStorage` (`redigeerdle:anonmerge`). After `onAuth` sees
  a **real** user with a different saved guest id, `maybeMergeAnon()` invokes the
  **`merge-anon` Edge Function** ([supabase/functions/merge-anon/index.ts](supabase/functions/merge-anon/index.ts)).
  It clears the marker **only on a confirmed merge** (no `{error}` and no throw) — a transient
  failure keeps it so the next sign-in retries (silently dropping a guest's plays is worse than
  one extra best-effort call); the retry is bounded by the snapshot's `at` timestamp (dropped
  once older than ~55 min, since the guest access token has expired by then and a merge can't
  succeed). **One uniform path** for new *and* existing accounts (a brand-new
  account is empty → no conflicts) — so we **don't** use `linkIdentity`/manual-linking.
- **`merge-anon`** validates two proofs — the caller's real JWT (Authorization header;
  deploy with **JWT verification ON**, i.e. *no* `--no-verify-jwt`) and the guest's
  `anon_token` (body) — then calls the `security definer` SQL function
  **`merge_anon_plays(p_anon, p_real)`** (service_role; `EXECUTE` revoked from
  anon/authenticated, re-granted to service_role) to re-parent the guest's `plays`, and
  finally deletes the guest user. **Conflict policy** when the same `play_id` exists under
  both: *best/most-complete wins* — finished > in-progress, solved > gave_up, then more
  `total_guesses`; exact tie keeps the existing real row.
- **Testing**: the client trigger (`maybeMergeAnon` calls the function; a guest logs
  `plays` not `scores`) is covered in `tests/supabase.spec.mjs`. The **`merge_anon_plays`
  SQL + the migration itself** were verified by running the real migration and the five
  conflict scenarios inside a `BEGIN … ROLLBACK` transaction against prod via `psql`
  "$SUPABASE_DB_URL" (zero residue) — re-run that rollback test after touching the merge
  SQL. Still **not** automatically tested (no local stack): the `merge-anon` Edge Function
  wrapper and the true browser end-to-end (anon play → sign-in → merge) — smoke-test those
  in the live app after deploy.

## Game archive (past dailies)

A **"Past dailies"** list lets a player play/replay days they missed. It's a collapsible
native `<details class="feed-archive">` at the bottom of the **feed drawer**, built in
`renderFeed()` → `buildArchiveGroupRow()`. **One row PER FANDOM** (not per daily — that got
unwieldy): the dailies are grouped by source (featured ones fold into the neutral
"⭐ Featured daily" pseudo-source, followed fandoms group by `wiki`), each row showing the
fandom name + its daily count. Clicking a row opens **`openArchiveModal()`** — the
`#archivemodal` popup (standard `.modal` pattern: ✕ / backdrop / Esc) listing that fandom's
dailies as **condensed date chips** (`.archdate` — the date + a small ✓/✗/… status glyph,
wrap-grid). Clicking a date loads it (`loadPuzzlePointer`, closing both popup + drawer).
- **Query**: one `puzzles` read for `date < today AND date >= today-30d AND (is_featured OR
  wiki in <your follows>)`, `order(date desc) limit 150`. The pinned (today/latest) featured
  row is filtered out so it isn't duplicated. Rows sort date-desc, featured-first within a date.
- **Scope = featured + followed.** A followed fandom's archive is just a `puzzles`-by-wiki
  query, **independent of when you followed it** — so following a *new* fandom immediately
  surfaces its earlier dailies (the user's explicit ask).
- **Privacy** (same invariant as the feed's pinned card / My-stats source selector): the
  **featured** group renders NEUTRALLY ("⭐ Featured daily", never its wiki name) — both the row
  and the popup title; a **followed-fandom** group shows its name/icon (you chose it). A date
  chip loads via `loadPuzzlePointer(p, { revealFandom: !p.is_featured, archive: true })`.
- **Scoring/resume — the `archivePlay` flag.** Set in `loadArticle`'s daily branch from
  `opts.archive` (threaded by `loadPuzzlePointer`), reset in `initGame`. It gates two things:
  `submitScore()` early-returns (a back-dated featured solve must **never** hit the competitive
  `scores` leaderboard), and `rememberLastGame()` early-returns (an archive play must not hijack
  the boot resume — you reload back onto your home daily, and the archive game's progress is
  saved per-puzzle so re-opening its card restores it). It **still** counts in personal `plays`
  stats, the heatmap (keyed by `puzzle_date`, so it greens the right day), and the
  `daily_metrics` completion aggregate. Replay-block + `restoreFinishedFromServer` already work
  per-puzzle, so a daily you finished before shows ✓/✗ and re-locks.
- **Completion status (✓/✗/…) is server-backed.** The feed cards AND the archive date chips
  show their status via **`dailyCardStatus(id)`**: for a real signed-in user a daily can be
  finished on **another device** (or its local state pruned by `pruneOldDailyState`, 60d), so
  `readDailyState` alone under-reports. `renderFeed` does **one owner-only `plays` read** for all
  rendered ids (featured + today's follows + archive; `play_id = puzzle id`, finished = `solved OR
  gave_up`) into the module map **`serverFinishedDailies`**; `dailyCardStatus` prefers it for the
  ✓/✗, then falls back to local state for the in-progress "…" (guests have no server rows → local
  only). Best-effort — a failed query just falls back to local.
- **Filter**: `filterFeedCards` selects `#feedCards > .feedcard` (DIRECT children) so the
  archive cards (which live inside the `<details>`) are untouched by the live feed search.
- Covered in [tests/supabase.spec.mjs](tests/supabase.spec.mjs) ("Archive: past dailies list…").

## Roadmap context

Remaining open ideas: **per-fandom leaderboards** (repoint `scores` to `(user, wiki,
date)`); **public fandom-stats aggregates** over `plays` via a `security definer` RPC
(keeps raw rows private); a **`?d=<id>` shareable link to a specific archived daily** (falls
out of the puzzle-id load path for free); and whether the feed should ever require an account.
All deferred.

**Image hint tier** (deferred — next hint idea after First sentence + Letters): a
**progressively-unblurred main image** as a new `#hintbox` tier. Fetch the article's lead
image from MediaWiki (`prop=pageimages|pageprops`, e.g. `original`/`thumbnail` url) and
show it heavily blurred; each click steps the blur down (e.g. 20px → 10px → 4px) at an
escalating cost (like the Letters tier). Design notes for when it's built: **start at heavy
blur** (the image often shows the subject outright — a hard leak), keep it **fully
client-side** (no Groq/edge function, like First sentence + Letters), and treat the image
url as **untrusted** on custom/shared `?wiki=&rev=` links (`safeHttpUrl()`, never
`innerHTML`). Add its icon to `SHARE_ICON`, a cost to `SCORE`, and persist its
blur-step/used state alongside `lettersRevealed`/`firstSentenceUsed`. Some articles have no
lead image → the tier should hide (like First sentence when nothing's left to uncover).
