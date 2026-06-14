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
  is owner-only. Never expose `wiki` + `revision_id` together for *today's* featured
  daily in any **public** surface — that would leak the source, itself a paid hint.)
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

`loadFromWikiUrl()` reports progress **and errors inside the New game modal**
(`#urlMsg` via `setUrlMsg()`), not just on the `#status` bar — that bar is hidden
behind the open modal, so a bad/malformed link used to look like a silent no-op.
`parseWikiUrl()` throws human-readable messages (invalid URL, no title found, non-http),
which `setUrlMsg(msg, true)` renders in red right under the input. **On mobile** `setUrlMsg`
also `scrollIntoView`s the error (the scrollable modal can push it below the fold), so the
user immediately sees something went wrong — gated by `matchMedia("(max-width:640px)")`.

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
  fallback" paths.
- [tests/supabase.spec.mjs](tests/supabase.spec.mjs) — Supabase happy paths. Mocks
  **POPULATED** REST responses so `loadPuzzle` (Supabase branch), `loadDailyMetrics`
  (the `daily_metrics` RPC aggregate + scores row rendering — the **"Daily metrics"**
  modal, formerly "Leaderboard"; DOM ids are `#metricsBtn`/`#metricsmodal`/`#metricsList`),
  `submitScore` (payload + best-score logic) and `recordPlay` (the `plays`
  log: finished-game payload + an in-progress/unfinished row) run for real. The Supabase
  client is real but every `**/rest/v1/**` call is intercepted; auth is faked by
  assigning `currentUser` via `page.evaluate` (no real login). `routeRest` swallows
  `**/rest/v1/plays**` so the per-guess `recordPlay` upserts stay hermetic; the
  `recordPlay` tests override that route to capture the payload (and poll for the **final
  `solved`** upsert, since one fires per guess).
- [tests/picker.spec.mjs](tests/picker.spec.mjs) — pure-function unit tests for the
  picker. Imports the exported helpers; no browser, no network.

**Conventions:** mock Supabase by routing `**/rest/v1/<table>**`. `.maybeSingle()`
queries: return `[]` for "no row" or `[{...}]` and supabase-js reads element 0.
Differentiate score GETs (best-score check vs leaderboard list) by the `select=`/embed
in the request URL or the method.

## Daily-feed follows (Settings)

The header **Settings** button opens a modal with **two** sections:

**Preferences** (device-local prefs, all in `localStorage`):
- **Dark mode** (`#darkToggle` → `setTheme()`, `redigeerdle:theme`). The palette is a set
  of CSS variables on `:root`; `html.dark` overrides them (`--paper`/`--ink`/`--surface`/
  `--hintbg`/…). A tiny **head script applies the saved theme before first paint** so there's
  no light→dark flash on load. The yellow `--marker` (flash/locate highlights) keeps
  hard-coded dark text in both themes — light text on yellow is unreadable.
- **Jump to a word when you guess it** (`#scrollToggle` → `prefAutoScroll`,
  `redigeerdle:autoscroll`, default on). When on, a correct typed guess scrolls the article
  to that word (via `gotoWord(key, prefAutoScroll)`); when off, it still highlights the word
  but doesn't scroll. `loadPrefs()` reads it at boot, `syncPrefControls()` reflects both
  toggles when the modal opens.

**Daily feed** — a **Homepage daily** picker (`#homeDailySelect`) plus the fandom follow list
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
hamburger stays clickable to toggle the drawer shut. The **top card is always a pinned
"Featured daily"** (`data-pinned`) — the featured general daily, rendered *before* the
follows and **always shown** (never filtered out by the search box). It must **not reveal
its fandom** — the source wiki is itself a paid hint (the **"Source"** button, `#fandomBtn`
→ `showFandom()`/`fandomUsed`; internals keep the historical `fandom` name, the UI label and
share text say **"Source"**) — so it uses a neutral ⭐ icon + the label
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

**Boot / resume order** (no special URL): every daily load stamps
`localStorage` (`redigeerdle:lastdaily` = `{ wiki, day: todayLocal() }`) via
`rememberLastDaily()`. On boot we **resume the last-opened daily, but only while it's still
the same local day** (`last.day === todayLocal()`, `loadDailyForWiki(last.wiki)`); once the
dailies roll over at local (Europe/Amsterdam) midnight, `last.day` no longer matches and we
fall through to the **homepage daily** (`homeDailyPref` → `loadDailyForWiki(home)`, or the
featured daily). So: reload mid-day → same puzzle you were on; first visit of a new day →
your configured homepage daily. (`?p=daily` still forces the featured daily regardless;
`?d=` shared links still open that fandom's daily directly.)

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

**Mobile header (done): one tidy row.** A `1fr auto 1fr` grid on `header` puts the
**hamburger** (`#feedBtn`) flush left, the **brand title** (`#homeBtn`) dead-centre, and
**Sign in/out** (`#authToggle`/`#signOutBtn`) flush right — the two `1fr` side columns
balance so the title is screen-centred regardless of the side widths. The title still does
what it does everywhere (`openHomeDaily()` → the configured homepage daily). Hidden here to
make room: **New game** + **How to play** (in `.brand`) and **Settings** + the signed-in
name (`.who`) (in `.controls`). `.controls button` is `white-space:nowrap` so "Sign in/out"
stays on one line down to 320px. The hidden actions move into the **hamburger drawer** on
mobile (see next).

**Scrollable modals (done).** All popups (`.modal` — New game / Settings / How to play /
Sign in / Daily metrics) get `overflow-y:auto` + `overscroll-behavior:contain` on the
overlay, with `align-items:flex-start`, so a card taller than the viewport **scrolls** (the
whole overlay scrolls, top stays reachable) instead of being clipped — important on short
mobile screens. Mobile also trims the overlay padding to `4vh 10px` (from `9vh 16px`) for
more usable height. Applies on all widths, but matters most on mobile.

**Mobile drawer actions (done).** New game / Settings / How to play (hidden from the mobile
header) live at the **bottom of the daily-feed drawer** as `.feed-actions` (`#feedActions`,
buttons `#feedNewBtn`/`#feedSettingsBtn`/`#feedHelpBtn`), in the order **New game →
Settings → How to play**. `.feed-actions` is `display:none` by default (desktop has these in
the header) and `display:flex` only `≤640px`; it's `flex:0 0 auto` so it pins below the
scrollable `.feed-cards`. Each handler **closes the drawer then calls the same action** as
the header button (`openMenu()` / `openSettings()` / open `#helpmodal`). This is the mobile
entry point for dark-mode / homepage-daily / follows (all inside Settings).

**Mobile auto-hide header (done).** On mobile the top bar **hides while scrolling down and
reappears while scrolling up** (the usual mobile pattern), instead of staying pinned. The
`.topbar` is still `position:sticky`; a scroll handler toggles a **`.topbar--hidden`** class
(`transform:translateY(-100%)`, with a `transition`) based on scroll direction — sticky
reserves no gap once you've scrolled past, so the content doesn't jump when it hides. Gated
by `matchMedia("(max-width:640px)")` so **desktop keeps the always-pinned sticky bar**; a
small delta ignores scroll jitter and it never hides within 60px of the top. Leaving mobile
width clears the class. (`--header-h` is unaffected; the left feed drawer still anchors at
`top:var(--header-h)`.)

**Mobile article top: buttons + Summary/Source output (done).** On mobile the top of the
article shows only the **Share** + **Daily metrics** buttons (`.statusbtns`); the status
message (`#status`) is **hidden** (`.statusbar .status { display:none }`). The **Summary**
and **Source** *output* (not their buttons — those stay in the footer) appears right under
those buttons: both `showSummary()` and `showFandom()` append into `#hintbox`, which a JS
`placeHintbox()` **reparents by viewport** — mobile → just after `#statusbar` (in
`#playarea`, styled `#playarea > .hintbox`, capped `38vh` with scroll); desktop → back into
`#controlcol` above `#history` (unchanged). CSS `order` can't move a node across containers,
hence the reparent; it runs at boot and on the `mqMobile` `change` event, and moving the
node keeps any already-rendered text.

**Tools + guesses + guesser → sticky footer (done).** Below **`640px`** the whole
`#controlcol` (not just the guessbar) is **`position:fixed` to the bottom of the viewport**
as a flex column, stacked top→bottom via `order`: the **tool buttons** (`.tools` — Reveal /
Summary / Source / Give up; **always one row** — `flex-wrap:nowrap`, the four buttons share
the width equally (`flex:1 1 0`) and their label scales with the viewport
(`font-size:clamp(.52rem, 2.7vw, .66rem)`) so nothing wraps down to ~300px. The Reveal
button also uses a **compact label on mobile**, `Word (N)` / `Cancel` instead of `Reveal a
word (N left)`, set in `updateRevealBtn()` via a `matchMedia` check), the **guessed-words
list** (`.history`, scrolls), then the
**guesser row** (`.guessbar`). On mobile the guessbar gains a small **↑ back-to-top button**
(`#guessTopBtn`, `.guess-top`) left of the `#guess` input (hidden on desktop via the base
`.guess-top { display:none }`; same `scrollTo top` as the meta-row `#topBtn`), then the input,
then a **smaller** `#go` Guess button. The footer is **capped
at `3/7` of the viewport height** (`max-height:calc(100vh * 3 / 7)`); the history scrolls
inside that cap, and with no guesses yet the footer shrinks to just tools + guesser.
`z-index:30` keeps it **under the modals (`50`) and the feed drawer (`35`/`40`)** so those
still cover it when open. The `.meta` strip (counts / show-lengths / Top) is **hidden** here
(TODO: re-home it); the `.hintbox` (Summary/Source output) is reparented to the article top
(see above), not in the footer. A JS sync publishes `#controlcol`'s live height as
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
  don't blur) and returns `{players, solved, completion_pct, avg_guesses, avg_seconds}`
  — `players` = everyone with a row for that puzzle (the completion-% denominator);
  `avg_guesses`/`avg_seconds` are over **solved** plays only ("to complete"). `EXECUTE`
  is revoked from `public` and re-granted to `anon`/`authenticated` (logged-out players
  see the stats too). Broader per-fandom aggregates (`GROUP BY wiki`) can follow the same
  pattern.
- **`user_id` references `auth.users(id)`, NOT `profiles(id)`** (unlike `scores`/`follows`).
  Anonymous guests log plays and have no profile row — see "Anonymous guests" below.
- **What's logged** (`recordPlay()` in index.html): `game_type` (`featured_daily` /
  `fandom_daily` / `full_random` / `curated_random` / `fandom_random` / `custom`),
  `wiki`, `puzzle_date`/`puzzle_id` (dailies only), `revision_id`, `total_guesses`,
  `good_guesses` (typed, ≥1 hit), `wrong_guesses` (typed, 0 hits), `reveals` (paid
  free-word reveals), `revealed_pct`, `summary_used`, `source_used`, `gave_up`,
  `solved`, `started_at`, `duration_seconds`.
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
- **`play_id` is the upsert key** (`unique(user_id, play_id)`), so repeated calls update
  ONE row. Dailies use `play_id = puzzle_id` (a same-day resume keeps the same row);
  random/custom mint a fresh `play_id` per game (`mintPlayId()`), so each is its own row.
- **`revealed_pct`** is derived from the **guesses** (sum of hits ÷ non-stop word count),
  NOT the token state — because `checkWin`/`giveUp` reveal every token, the live token
  state would always read 100%. So it honestly reflects how much the player uncovered
  *through play* (meaningful for give-ups too).
- **`started_at`/`duration_seconds`** use `gameStartedAt` (set in `initGame`), which is
  **persisted in the daily localStorage state** (`startedAt`) and restored by
  `restoreDailyState`, so a same-day resume reports an honest duration. It's wall-clock
  (includes idle/away time). Cadence is **one upsert per guess** (chosen tradeoff);
  debounce if write volume ever matters.

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
- **Mobile**: `#feedStatsBtn` at the **bottom of the hamburger drawer** `.feed-actions`
  (after New game / Settings / How to play), like the other drawer actions — closes the
  drawer then calls `openStats()`.

**Layout — a source selector on top, then two split sections:**
- **Source selector** (`#statsSource`, built in JS so option labels use the wiki helpers
  via `textContent`): **Combined** (everything) or one source. A "source" is the wiki host
  (`sourceKeyOf`), **EXCEPT featured dailies, which fold into a neutral "⭐ Featured daily"
  pseudo-source** — the modal **never names a featured wiki** (the source is itself a paid
  hint, same invariant as the feed's pinned card). Changing it re-renders from the cached
  `statsRows` (no refetch). `statsSource` persists across opens; resets to Combined if the
  saved source vanishes from the data.
- **Dailies** (`featured_daily` + `fandom_daily`, `DAILY_TYPES`/`isDailyRow`): 8 tiles —
  Played, Solved %, Current/Best streak, Avg guesses (over **solved**), Avg time, Clean
  solves (solved with **no reveals, no summary, no source** — our analogue of Jaardle's
  "perfect"), Gave up — plus the heatmap.
- **Free play** (`full_random` / `curated_random` / `fandom_random` / `custom`): the same
  tiles **minus the two streak tiles** (streaks are a daily concept), no heatmap.
- Each section shows "No daily/free play games yet." when the scoped set is empty (e.g. the
  "Featured daily" source has no free play).

**Shared helpers:** `aggregate(rows)` → played/solved/winPct/gaveUp/clean/avgGuesses/
avgSeconds for either section; `dailyStreaks(dailyRows)` → consecutive calendar days with a
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
  `{id, access_token}` into `localStorage` (`redigeerdle:anonmerge`). After `onAuth` sees
  a **real** user with a different saved guest id, `maybeMergeAnon()` invokes the
  **`merge-anon` Edge Function** ([supabase/functions/merge-anon/index.ts](supabase/functions/merge-anon/index.ts)),
  then clears the marker. **One uniform path** for new *and* existing accounts (a brand-new
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

## Roadmap context

Remaining open ideas: **per-fandom leaderboards** (repoint `scores` to `(user, wiki,
date)`); **public fandom-stats aggregates** over `plays` via a `security definer` RPC
(keeps raw rows private); and whether the feed should ever require an account. All
deferred.
