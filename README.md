# Redigeerdle

A redacted-article word-guessing game, in the spirit of [Redactle](https://www.redactle.net/).

You get a wiki article with every word blacked out — only the word *lengths* show. Guess
words to reveal them throughout the text, and work toward the real goal: the **title**.
Reveal all the title's words and the article is declassified.

The article text and the answer are never stored — the article is fetched live from the
MediaWiki API at a pinned revision, and only words you guess get written into the page.

## How to play

- Type a word and press Enter — every place it appears reveals at once; the counter shows your guess's length.
- Your real goal is the hidden **title** at the top. The `🎯 N/M` pill tracks title words found; a title-word hit flashes to celebrate.
- **Hints** opens a layered, spoiler-free panel — reveal one tier at a time:
  - **Reveal a word** (3×) — click any black bar in the text (title words stay locked).
  - **Category**, **Summary**, **First sentence**, **Letters** (one title letter at a time), **Synonym** (the title's shape in synonyms), **Source** (which wiki).
- **Give up** reveals the answer and ends the game.
- It's **golf — lowest score wins**. Correct guesses are free; wrong guesses, reveals, hints and time each add points. Every button shows what it'll cost, and the running total sits in the **Score** badge.
- **Share** a spoiler-free emoji result when you finish.

## Game modes

- **Daily** — a fresh puzzle every day. Open the **☰ Daily feed** drawer to browse the featured daily, your followed fandoms' dailies, and **Past dailies** (archive). Sign in to save the featured daily to the leaderboard.
- **New game** offers **Curated random**, **Full random**, **Random from a fandom**, and **Custom link** (paste any MediaWiki URL — Fandom, Wikipedia, minecraft.wiki, wiki.guildwars2.com, …).
- **Multiplayer** — **Co-op** (share one board, live) or **Versus** (race your own boards); invite a friend with a link. Needs a (free) account.

## Settings & accessibility

In **Settings**: **Theme** (System / Light / Dark) and **Motion** (System / Normal / Reduced) — both default to *System* and follow your OS — a **Colour-blind friendly** palette, **Jump to a word** on guess, your display name, and a privacy policy. Daily-feed follows + the homepage daily live under **Configure dailies** in the feed drawer.

## Stats

**My stats** is your personal dashboard (streaks, win %, avg score, a contribution heatmap), split into Dailies and Free play, per source. **Daily metrics** shows how everyone did on a given daily.

## Running locally

Serve it over HTTP (not `file://`) — the game fetches `puzzle.json` and the wiki API:

```bash
npm install      # dev dependencies (for the tests)
npm run serve    # http://localhost:5599
```

Or use the VS Code **Live Server** extension. It runs without any backend: the daily falls
back to the bundled `puzzle.json`, and login/leaderboard/hints stay idle until Supabase is set up.

Run the tests with `npm test` (Playwright, headless).

## More

- Backend setup (Supabase, login, daily picker, AI hints): see [`SUPABASE_SETUP.md`](SUPABASE_SETUP.md).
- Working in the codebase: see [`CLAUDE.md`](CLAUDE.md) for the architecture and invariants.
- It's a single static `index.html` — no build step, no framework.
