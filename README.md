# Redigeerdle

A redacted-article word-guessing game, in the spirit of [Redactle](https://www.redactle.net/).

You get a Fandom wiki article with every word blacked out — only the word *lengths* show.
Guess words to reveal them throughout the text, and work toward the real goal: the
**title**. Reveal all the title's words and the article is declassified.

The article text is never stored — it's fetched live from the Fandom API at a pinned
revision, and only words you guess get written into the page.

## How to play

- Type a word and press Enter — every matching word reveals at once; the counter shows your guess's length.
- **Reveal a word** (3×): click a black bar (title words and their plurals are locked).
- **Show hint summary** / **Reveal fandom**: optional nudges.
- **Give up** to reveal the answer and end the game.
- Crack the **title** to win. Share your result — solved, in progress, or gave up.

## Game modes

- **Daily** — click the **Redigeerdle** title; one puzzle a day, same for everyone. Sign in to save scores to the leaderboard.
- The **New game** menu offers:
  - **Curated random** — a quality-checked random article.
  - **Full random** — anything from the wiki pool.
  - **Random from a fandom** — pick a wiki, get a random page from it.
  - **Custom link** — paste any MediaWiki article URL (Fandom, Wikipedia, minecraft.wiki, wiki.guildwars2.com, …).

## Running locally

Serve it over HTTP (not `file://`) — the game fetches `puzzle.json` and the Fandom API:

```bash
npm install      # dev dependencies (for the tests)
npm run serve    # http://localhost:5599
```

Or use the VS Code **Live Server** extension. It runs without any backend: the daily falls
back to the bundled `puzzle.json`, and login/leaderboard stay idle until Supabase is set up.

Run the tests with `npm test` (Playwright, headless).

## More

- Backend setup (Supabase, login, daily picker, AI hints): see
  [`SUPABASE_SETUP.md`](SUPABASE_SETUP.md).
- It's a single static `index.html` — no build step, no framework.
