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
  server-side is a regression.
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
- **Hints are generated lazily, once, and cached.** The picker stores puzzles
  **without** a `summary`. The first player to click "Show hint summary" triggers the
  `hint` Edge Function, which generates via Groq and writes the result back to
  `puzzles.summary`. Concurrent first-clickers are de-duped by an **atomic claim** on
  `puzzles.summary_generating_at` (`UPDATE … WHERE summary IS NULL AND the claim is
  free/stale`); the loser gets `status:"pending"` and the client polls. Random/custom
  games call the same function with no `puzzleId` → generate, no cache. The bundled
  [puzzle.json](puzzle.json) fallback keeps a baked-in summary for offline play.
- The leak filter (reject an AI hint that contains a title word) lives in
  [scripts/lib/leak-filter.mjs](scripts/lib/leak-filter.mjs) (the unit-tested reference)
  and is **mirrored** in the `hint` Edge Function
  ([supabase/functions/hint/index.ts](supabase/functions/hint/index.ts)), which runs on
  Deno and is deployed separately. Change one → change the other.

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

## Key files

- [index.html](index.html) — the entire app. Top-level `let`/`function` declarations
  are global lexical bindings (classic script), which is why tests can read/assign them
  via `page.evaluate`.
- [scripts/pick-daily.mjs](scripts/pick-daily.mjs) — the daily picker. Pure helpers
  (`badTitle`, `probe`, `pickedKey`, `leaksTitle`, `stripTags`) are **exported** for unit
  tests; the CLI body runs only when executed directly (`isMain` guard). Run:
  `node scripts/pick-daily.mjs --dry-run` (also `--date=`, `--force`).
- [supabase/functions/hint/index.ts](supabase/functions/hint/index.ts) — Deno Edge
  Function that generates a spoiler-free hint via Groq (keeps the Groq key server-side).
- [.github/workflows/daily-puzzle.yml](.github/workflows/daily-puzzle.yml) — runs the
  picker daily.
- [puzzle.json](puzzle.json) — the bundled fallback pointer, used when Supabase is
  absent/empty (e.g. local dev without keys).

## Database & migrations

The schema lives in **`supabase/migrations/`** and is managed with the Supabase CLI via
`npx` (no global install). [supabase-schema.sql](supabase-schema.sql) is the
human-readable full-state reference and matches the baseline migration; keep it in sync
when you add migrations (or treat migrations as the source of truth).

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
- **RLS cannot be tested automatically here** (no local Supabase). Review RLS policies by
  hand and state that they're unverified by tests.

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
  fallback" paths.
- [tests/supabase.spec.mjs](tests/supabase.spec.mjs) — Supabase happy paths. Mocks
  **POPULATED** REST responses so `loadPuzzle` (Supabase branch), `loadLeaderboard` (row
  rendering) and `submitScore` (payload + best-score logic) run for real. The Supabase
  client is real but every `**/rest/v1/**` call is intercepted; auth is faked by
  assigning `currentUser` via `page.evaluate` (no real login).
- [tests/picker.spec.mjs](tests/picker.spec.mjs) — pure-function unit tests for the
  picker. Imports the exported helpers; no browser, no network.

**Conventions:** mock Supabase by routing `**/rest/v1/<table>**`. `.maybeSingle()`
queries: return `[]` for "no row" or `[{...}]` and supabase-js reads element 0.
Differentiate score GETs (best-score check vs leaderboard list) by the `select=`/embed
in the request URL or the method.

## Daily-feed follows (Settings)

The header **Settings** button opens a modal with one section: **Daily feed** — pick
which fandoms go in your feed
(searchable via `#followSearch` / `filterFollowList()`). Storage follows the rule:
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
hamburger stays clickable to toggle the drawer shut. It reads `follows` and shows today's
daily per followed fandom as a scrollable vertical list (icon, name, status ✓/✗/…/—).
`renderFeed()` only populates content — open/close is owned by `#feedBtn` / `closeFeed()`,
not by `renderFeed`. Clicking a card loads that fandom's daily; a search box
(`#feedSearch`, shown at 2+ fandoms) narrows the rows live via `filterFeedCards()`.

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
  layout is still TODO.

Verify both sides of that breakpoint with `scripts/dev-screenshot.mjs` (see **Tests**).
A small boot script keeps
`--header-h` in sync with the header's rendered height (it wraps to two rows when
narrow); the sticky guessbar / controls column (`#controlcol`) pin just below it via
`calc(var(--header-h) + …)`, which is what keeps the controls column from sliding under
the header while you scroll.

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

`pickForWiki` uses **`generator=random` + `prop=info`** so each candidate's wikitext
`length` and redirect status come back up front — bad titles, redirects and stubs are
rejected cheaply (no parse), and only promising pages (longest-first) get a `parse` call.
That keeps each round cheap, so it samples up to `ATTEMPTS` (40) rounds × 10 with early
exit — enough to reliably find an article even on junk-heavy wikis (comic-issue DBs like
marvel/dc, which fail ~74% of the time with naive `list=random`). Not a hard 100%, but
close; if a wiki still misses a day the feed shows "—" for it and it retries next run.

- **Daily progress / state** is keyed by **puzzle id** (`stateKey(dailyPuzzleId)`), not
  date — fandoms share a date, so date-keying would collide.
- **Scoring**: only the **featured** daily is scored for now (`submitScore` guards on
  `dailyFeatured`); per-fandom feed dailies are playable + shareable but not yet on a
  leaderboard. Per-fandom leaderboards (repointing `scores` to `(user, wiki, date)`) are
  the next step if wanted.
- Bootstrap: the feed is only populated once the new picker has run for today (the
  per-fandom rows must exist). Run `node scripts/pick-daily.mjs` once after deploy.

## Roadmap context

Remaining open ideas: **per-fandom leaderboards** (repoint `scores` to `(user, wiki,
date)`), and whether the feed should ever require an account. Both deferred.
