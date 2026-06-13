# Supabase setup for Redigeerdle

Three things only you can do (I can't reach your dashboard). ~10 minutes.

## 1. Create the project & get keys
1. Go to <https://supabase.com> → **New project**. Pick a name, region, and a database password.
2. After it provisions: **Project Settings → API**. Copy:
   - **Project URL** (e.g. `https://abcd1234.supabase.co`)
   - **anon public** key (the long one labelled `anon` / `public`)
3. Paste both into the `CONFIG` block at the top of the `<script>` in `index.html`:
   ```js
   const SUPABASE_URL      = "https://obijqgumdkuzefhggflx.supabase.co";
   const SUPABASE_ANON_KEY = "sb_publishable_OPNydVMEyLfn1T-pzIp2cg_REf0qrfN";
   ```
   The anon key is meant to be public — it's safe in client-side code **because** Row
   Level Security (set up in step 2) controls what it can actually do.

## 2. Create the tables
1. **SQL Editor → New query**.
2. Paste the entire contents of `supabase-schema.sql` and click **Run**.
   This creates `puzzles`, `profiles`, `scores`, turns on RLS, and seeds one
   working example puzzle (Golden Snitch). Safe to re-run.

   A `puzzles` row stores only a **pointer** — the wiki host and a pinned
   revision id — not the article text. The game fetches the text live from the
   Fandom API at load time; pinning the revision keeps the puzzle reproducible.

## 3. Enable login methods
**Authentication → Providers**

### Email + password
- Enable **Email**.
- For local testing, turn **Confirm email** *off* (Authentication → Providers → Email)
  so you can sign in immediately without clicking a confirmation mail. Turn it back
  on for production.

### Google
- Enable **Google**.
- You need a Google OAuth client (Google Cloud Console → APIs & Services →
  Credentials → **Create OAuth client ID** → *Web application*).
  - **Authorized redirect URI**: copy the callback URL Supabase shows on the Google
    provider page — it looks like
    `https://YOUR-PROJECT.supabase.co/auth/v1/callback`.
  - Paste the resulting **Client ID** and **Client secret** back into Supabase's
    Google provider settings and save.

### Redirect URLs (both methods)
**Authentication → URL Configuration → Redirect URLs** — add every origin you open
the game from, e.g.:
- `http://localhost:5500` (or whatever port Live Server uses)
- `http://127.0.0.1:5500`
- your production URL when you deploy

Without this, the OAuth/magic redirect bounces back to the wrong place.

## 4. Test
Open `index.html` via a local server (VS Code **Live Server**, not `file://`).
- The daily puzzle should now load from Supabase (status shows the puzzle id).
- Sign in with Google or email+password.
- Solve the daily → your score is saved → it appears in the leaderboard.

## Automatic daily puzzles (GitHub Actions)
A scheduled workflow picks a fresh random article each day, validates it makes a
decent puzzle (clean word-like title, enough prose, not a stub or a monster),
pins its current revision, and stores the row. No daily manual work. Every chosen
article is recorded in a private `picked` table (RLS-locked — it holds the answer),
so the picker never repeats one.

**One-time setup — add two repository secrets:**
1. GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**.
2. Add:
   - `SUPABASE_URL` = `https://YOUR-PROJECT.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY` = the **service_role** key from Supabase
     **Settings → API** (the secret one, *not* the publishable/anon key).

   The picker needs **no Groq key** — it stores puzzles without a hint. The hint
   is generated lazily by the `hint` Edge Function (see below), so the Groq key
   lives there instead.
3. That's it. The workflow [`.github/workflows/daily-puzzle.yml`](.github/workflows/daily-puzzle.yml)
   runs every day **just after local midnight in Amsterdam** (CET/CEST), and you can trigger it by hand from the repo's
   **Actions** tab (**Run workflow**).

> The service_role key bypasses Row Level Security, so it must stay secret — it
> lives only in GitHub secrets and your local `.env`, never in `index.html`.
> (Scheduled workflows only run from the default branch, so this must be on `main`.)

**Run it locally** (writes a real row): put the two values in a `.env` file
(git-ignored) and run:
```
npm run puzzle:auto              # today (Europe/Amsterdam)
node scripts/pick-daily.mjs --date=2026-06-20
node scripts/pick-daily.mjs --dry-run    # just pick & print, no write
```
### Managing which wikis the picker uses
The pool lives in the **`wikis` table** — edit it in the Supabase **Table editor**
(or via SQL) with no code change or redeploy; the next run picks it up:
- **Add** a wiki: insert a row with the `host` (e.g. `gravityfalls.fandom.com`).
- **Pause** a wiki: set its `enabled` to `false` (keeps the row for later).
- **Remove** a wiki: delete the row.
- **`display_name`** and **`icon`** (optional) drive the fandom picker. `icon` is
  free text: an **image URL** (rendered as an `<img>`) or an **emoji**. The seed
  fills it with each community's favicon. Left blank, the client derives the same
  favicon from the host and shows the stripped host as the name — so a new wiki
  still gets a name + icon without any extra work.

If the table is empty or unreachable (e.g. a local dry run without the
service-role key), the picker falls back to a baked-in list in
`scripts/pick-daily.mjs`. Quality thresholds (length, paragraph count) also live
at the top of that script.

## Hints — the Edge Function (recommended)
Every hint comes from the `hint` Edge Function (`supabase/functions/hint`), which
keeps the Groq key server-side — never in the browser. Until you deploy it, games
simply have no hint (nothing breaks).

- **Daily**: the puzzle is stored without a hint. The first player who clicks
  "Show hint summary" triggers generation; the function **caches** the hint back
  onto `puzzles.summary` (and uses an atomic claim on `summary_generating_at` so
  two simultaneous first-clickers don't both call Groq). Everyone else — and any
  reload — reuses the cached hint. This spreads load across the day and only
  spends Groq on puzzles people actually open.
- **Curated / Full random / Custom link**: the hint is generated on demand and
  not cached (there's no shared puzzle row to cache against).

**Deploy it — via the Supabase CLI:**
```
supabase functions deploy hint --no-verify-jwt
supabase secrets set GROQ_API_KEY=gsk_...        # and optionally GROQ_MODEL
```
**Or via the dashboard:** **Edge Functions → Deploy a new function**, name it
`hint`, paste the contents of `supabase/functions/hint/index.ts`, turn **Verify
JWT off**, deploy. Then add the **`GROQ_API_KEY`** secret under Edge Functions →
secrets.

> `--no-verify-jwt` / "Verify JWT off" makes the function callable with just the
> publishable key (which the browser already has). It only returns a vague hint,
> but to limit Groq-quota abuse you could later add rate limiting. The function
> caps input length and never echoes the answer (leak filter mirrored from
> `scripts/lib/leak-filter.mjs`, the unit-tested reference). It needs no extra
> secrets for caching: Supabase injects `SUPABASE_URL` and
> `SUPABASE_SERVICE_ROLE_KEY` into the function automatically.

## Adding or overriding a puzzle by hand
You can always pin a specific article — for a themed day, or to override the
auto-pick. Each puzzle is a pointer to a wiki article at a **specific revision**:

1. Open the article on any Fandom wiki, e.g.
   `https://harrypotter.fandom.com/wiki/Golden_Snitch`.
2. Find the revision id (`oldid`): click **History** → a revision → the URL shows
   `...?oldid=2006074`. (Pinning a revision means the puzzle text never changes
   even if the article is later edited.)
3. Insert a row (SQL Editor or Table editor):
   ```sql
   insert into public.puzzles (id, date, wiki, revision_id, summary) values
     ('2026-06-12', '2026-06-12', 'harrypotter.fandom.com', 2006074,
      'optional one-line hint');
   ```
   - `wiki` = the host only (e.g. `harrypotter.fandom.com`). For a language path
     wiki, include it (e.g. `harrypotter.fandom.com/de`).
   - `summary` is optional — it's the text shown by the "Show hint summary" button.

The game loads the most recent puzzle with `date <= today`, so just add tomorrow's
row and it switches over automatically. The article title is the answer; it's
fetched live and kept hidden until solved.

> Tip: the wiki must allow anonymous cross-origin (`origin=*`) requests — almost
> all Fandom wikis do. If a daily ever fails to load, the game falls back to the
> bundled `puzzle.json`.
