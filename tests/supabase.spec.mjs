import { test, expect } from "@playwright/test";

// Integration tests for the Supabase-backed paths. app.spec.mjs deliberately
// stubs Supabase to EMPTY (testing the graceful-absent fallback); here we mock
// POPULATED REST responses so loadPuzzle (Supabase branch), loadDailyMetrics
// (aggregate + row rendering) and submitScore (payload + best-score logic) run their real
// happy paths. The Supabase client is real, but every /rest/v1 call is
// intercepted, so no live data is touched. The article body is still fetched
// live from the pinned Fandom revision (same as app.spec's live tests).

const DAILY = {
  id: "2026-06-10", date: "2026-06-10",
  wiki: "harrypotter.fandom.com", revision_id: 2006074,
  summary: "A small winged ball; catching it ends the match.",
};

// Route the daily puzzle pointer (maybeSingle → supabase-js reads element 0).
const routeDaily = page =>
  page.route("**/rest/v1/puzzles**", r =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([DAILY]) }));

// Keep the rest hermetic: no live hint, fixed wiki list, no real auth.
const routeRest = async page => {
  await page.route("**/functions/v1/**", r =>
    r.fulfill({ status: 200, contentType: "application/json", body: '{"summary":""}' }));
  await page.route("**/rest/v1/wikis**", r =>
    r.fulfill({ status: 200, contentType: "application/json",
      body: '[{"host":"harrypotter.fandom.com"}]' }));
  await page.route("**/auth/v1/**", r =>
    r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  // the private play-log upsert (recordPlay) — swallow it so tests stay hermetic
  await page.route("**/rest/v1/plays**", r =>
    r.fulfill({ status: 201, contentType: "application/json", body: "[]" }));
  // the daily-metrics aggregate RPC — return a fixed aggregate
  await page.route("**/rest/v1/rpc/daily_metrics**", r =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(
      [{ players: 8, solved: 6, completion_pct: 75, avg_guesses: 12.5, avg_seconds: 134, avg_score: 7.5 }]) }));
};

test("loads the daily from Supabase (not the bundled fallback)", async ({ page }) => {
  await routeRest(page);
  await routeDaily(page);
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  // status names the puzzle by its Supabase date — proves the Supabase branch ran.
  // The featured daily must NOT leak its fandom, so the line stays neutral (date only).
  await expect(page.locator("#status")).toContainText("Daily puzzle (2026-06-10) loaded");
  // title redacted, body has the live-fetched (and redacted) article
  await expect(page.locator("#title .red:not(.shown)").first()).toBeVisible();
  expect(await page.locator("#body .red").count()).toBeGreaterThan(20);
});

test("daily metrics render the anonymous aggregate stats (no per-player leaderboard)", async ({ page }) => {
  await routeRest(page);
  await routeDaily(page);
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  await page.click("#metricsBtn");
  await expect(page.locator("#metricsmodal")).toHaveClass(/open/);
  await expect(page.locator("#metricsTitle")).toContainText("2026-06-10");

  // aggregate stat cards from the daily_metrics RPC (players, completion %, avg guesses, avg time)
  const cards = page.locator("#metricsStats .stat");
  await expect(cards).toHaveCount(5);
  await expect(cards.nth(0)).toContainText("8");        // players
  await expect(cards.nth(1)).toContainText("75%");      // completion
  await expect(cards.nth(2)).toContainText("12.5");     // avg guesses
  await expect(cards.nth(3)).toContainText("2m 14s");   // 134s → 2m 14s
  await expect(cards.nth(4)).toContainText("7.5");      // avg score (lower is better)

  // the per-player ranked leaderboard is gone — only the anonymous aggregate remains
  await expect(page.locator("#metricsList .mrow")).toHaveCount(0);
});

test("submitScore posts the right payload when a signed-in user solves the daily", async ({ page }) => {
  await routeRest(page);
  await routeDaily(page);
  let posted = null;
  await page.route("**/rest/v1/scores**", r => {
    if (r.request().method() === "POST") {
      posted = JSON.parse(r.request().postData() || "{}");
      return r.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify([posted]) });
    }
    // best-score check (maybeSingle) → no existing row, so submitScore proceeds to upsert
    return r.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });

  // fake a signed-in user (bypass real auth — submitScore only needs currentUser.id)
  await page.evaluate(() => { currentUser = { id: "test-user-id", email: "t@e.st" }; });
  expect(await page.evaluate(() => currentUser?.id)).toBe("test-user-id");

  // solve it → checkWin() fires submitScore() automatically
  await page.fill("#guess", "golden"); await page.press("#guess", "Enter");
  await page.fill("#guess", "snitch"); await page.press("#guess", "Enter");
  await expect(page.locator("#win")).toHaveClass(/show/);

  await expect.poll(() => posted, { timeout: 5_000 }).not.toBeNull();
  // upsert payload may be an object or a single-element array
  const row = Array.isArray(posted) ? posted[0] : posted;
  expect(row).toMatchObject({
    user_id: "test-user-id", puzzle_date: "2026-06-10", guesses: 2, reveals: 0, solved: true,
  });
});

test("submitScore keeps the player's best — no upsert when an existing score is better", async ({ page }) => {
  await routeRest(page);
  await routeDaily(page);
  let postCount = 0, getDone = false;
  await page.route("**/rest/v1/scores**", r => {
    if (r.request().method() === "POST") {
      postCount++;
      return r.fulfill({ status: 201, contentType: "application/json", body: "[]" });
    }
    getDone = true;
    // existing score of 1 guess — better than the 2 we're about to submit
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ guesses: 1 }]) });
  });
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  await page.evaluate(() => { currentUser = { id: "test-user-id" }; });

  await page.fill("#guess", "golden"); await page.press("#guess", "Enter");
  await page.fill("#guess", "snitch"); await page.press("#guess", "Enter");
  await expect(page.locator("#win")).toHaveClass(/show/);

  // wait until the best-score check ran, then confirm no upsert followed
  await expect.poll(() => getDone, { timeout: 5_000 }).toBe(true);
  await page.waitForTimeout(300);
  expect(postCount).toBe(0);
});

test("recordPlay logs a finished daily to plays with game_type + good/wrong/reveal counts", async ({ page }) => {
  await routeRest(page);
  await routeDaily(page);
  await page.route("**/rest/v1/scores**", r =>      // keep submitScore quiet
    r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  let logged = null;
  await page.route("**/rest/v1/plays**", r => {     // overrides routeRest's plays stub
    if (r.request().method() === "POST") logged = JSON.parse(r.request().postData() || "{}");
    return r.fulfill({ status: 201, contentType: "application/json", body: "[]" });
  });
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  await page.evaluate(() => { currentUser = { id: "test-user-id" }; });

  // one wrong guess, then solve → 1 wrong + 2 good, no reveals
  await page.fill("#guess", "zzzzznotaword"); await page.press("#guess", "Enter");
  await page.fill("#guess", "golden"); await page.press("#guess", "Enter");
  await page.fill("#guess", "snitch"); await page.press("#guess", "Enter");
  await expect(page.locator("#win")).toHaveClass(/show/);

  // recordPlay upserts on every guess; wait for the FINAL (solved) upsert, not an
  // earlier in-progress one
  const lastRow = () => (Array.isArray(logged) ? logged[0] : logged);
  await expect.poll(() => !!(lastRow() && lastRow().solved), { timeout: 5_000 }).toBe(true);
  const row = lastRow();
  expect(row).toMatchObject({
    user_id: "test-user-id", play_id: "2026-06-10", game_type: "featured_daily",
    wiki: "harrypotter.fandom.com", puzzle_date: "2026-06-10", puzzle_id: "2026-06-10",
    revision_id: 2006074,                       // the pinned oldid played
    total_guesses: 3, good_guesses: 2, wrong_guesses: 1, reveals: 0,
    summary_used: false, source_used: false, gave_up: false, solved: true,
    score: 1,                                   // 1 wrong guess (+1); good guesses are free
  });
  // duration + completion: derived fields are present and sane
  expect(typeof row.started_at).toBe("string");
  expect(row.duration_seconds).toBeGreaterThanOrEqual(0);
  // revealed_pct reflects words uncovered through play (title solved → > 0, <= 100)
  expect(row.revealed_pct).toBeGreaterThan(0);
  expect(row.revealed_pct).toBeLessThanOrEqual(100);
});

test("recordPlay logs a started-but-unfinished game as an in-progress row", async ({ page }) => {
  await routeRest(page);
  await routeDaily(page);
  await page.route("**/rest/v1/scores**", r =>
    r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  let logged = null;
  await page.route("**/rest/v1/plays**", r => {
    if (r.request().method() === "POST") logged = JSON.parse(r.request().postData() || "{}");
    return r.fulfill({ status: 201, contentType: "application/json", body: "[]" });
  });
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  await page.evaluate(() => { currentUser = { id: "test-user-id" }; });

  // one wrong guess, then stop — the game is neither solved nor given up
  await page.fill("#guess", "zzzzznotaword"); await page.press("#guess", "Enter");

  await expect.poll(() => logged, { timeout: 5_000 }).not.toBeNull();
  const row = Array.isArray(logged) ? logged[0] : logged;
  expect(row).toMatchObject({
    user_id: "test-user-id", play_id: "2026-06-10", game_type: "featured_daily",
    total_guesses: 1, good_guesses: 0, wrong_guesses: 1, reveals: 0,
    solved: false, gave_up: false,              // started, not finished
  });
});

test("My stats splits dailies vs free play, filters by source, keeps featured neutral", async ({ page }) => {
  await routeRest(page);
  await routeDaily(page);
  // dates relative to local "today" so the streak assertion is deterministic
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam" }).format(new Date());
  const minus = n => { const [y, m, d] = today.split("-").map(Number); const dt = new Date(Date.UTC(y, m - 1, d, 12)); dt.setUTCDate(dt.getUTCDate() - n); return dt.toISOString().slice(0, 10); };
  const fixture = [
    { game_type: "featured_daily", wiki: "harrypotter.fandom.com", puzzle_date: today,    total_guesses: 40, reveals: 0, summary_used: false, source_used: false, gave_up: false, solved: true,  duration_seconds: 300, score: 5, coop: true },
    { game_type: "featured_daily", wiki: "harrypotter.fandom.com", puzzle_date: minus(1),  total_guesses: 50, reveals: 2, summary_used: false, source_used: false, gave_up: false, solved: true,  duration_seconds: 600, score: 15 },
    { game_type: "featured_daily", wiki: "harrypotter.fandom.com", puzzle_date: minus(2),  total_guesses: 30, reveals: 0, summary_used: false, source_used: false, gave_up: true,  solved: false, duration_seconds: 120, score: 99 },
    { game_type: "fandom_daily",   wiki: "minecraft.wiki",         puzzle_date: minus(1),  total_guesses: 20, reveals: 0, summary_used: false, source_used: false, gave_up: false, solved: true,  duration_seconds: 200, score: 10 },
    { game_type: "full_random",    wiki: "en.wikipedia.org",       puzzle_date: null,      total_guesses: 10, reveals: 0, summary_used: false, source_used: true,  gave_up: true,  solved: false, duration_seconds: 90, score: 25 },
  ];
  // stats reads its OWN rows with a GET; recordPlay still upserts with POST → split by method
  await page.route("**/rest/v1/plays**", r =>
    r.fulfill({ status: r.request().method() === "GET" ? 200 : 201, contentType: "application/json",
      body: r.request().method() === "GET" ? JSON.stringify(fixture) : "[]" }));
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  await page.evaluate(() => { currentUser = { id: "test-user-id", is_anonymous: true }; });

  // desktop button lives in .controls (default Playwright viewport is desktop-width)
  await page.click("#statsBtn");
  await expect(page.locator("#statsmodal")).toHaveClass(/open/);

  // the two sections, in order
  await expect(page.locator("#statsBody .stats-section-h").nth(0)).toHaveText("Dailies");
  await expect(page.locator("#statsBody .stats-section-h").nth(1)).toHaveText("Free play");

  // source selector: Combined + a neutral "Featured daily" + the two real wikis;
  // it must NEVER name the featured wiki (harrypotter folds into ⭐ Featured daily)
  const opts = page.locator("#statsSource option");
  await expect(opts).toHaveText([/Combined/, /Featured daily/, /minecraft\.wiki/, /en\.wikipedia\.org/]);
  await expect(page.locator("#statsSource")).not.toContainText("harrypotter");

  // ---- Combined ----
  const daily = page.locator("#statsBody .statgrid").nth(0).locator(".stat");
  const free  = page.locator("#statsBody .statgrid").nth(1).locator(".stat");
  await expect(daily).toHaveCount(10);
  await expect(daily.nth(0)).toContainText("4");        // Played (3 featured + 1 fandom daily)
  await expect(daily.nth(1)).toContainText("75%");      // Solved (3/4)
  await expect(daily.nth(2)).toContainText("2");        // Current streak (today + yesterday)
  await expect(daily.nth(4)).toContainText("36.7");     // Avg guesses over solved (40,50,20)
  await expect(daily.nth(6)).toContainText("2");        // Clean solves (today featured + minecraft)
  await expect(daily.nth(7)).toContainText("1");        // Gave up
  await expect(daily.nth(8)).toContainText("10.0");     // Avg score over solved (5,15,10 → 10.0)
  await expect(daily.nth(9)).toContainText("1");        // Co-op (today's featured daily was done co-op)
  await expect(free).toHaveCount(7);                    // no streak tiles for free play
  await expect(free.nth(0)).toContainText("1");         // Played (the wikipedia random)
  await expect(free.nth(1)).toContainText("0%");        // Solved (gave up)
  await expect(free.nth(6)).toContainText("—");         // Avg score (no solved free-play games)
  // heatmap aggregates dailies: 2 solved days, 1 missed. Assert they're actually
  // RENDERED (visible), not just class-present — a class collision with the global
  // `.win{display:none}` banner once hid every solved cell while keeping its green
  // computed style, so check visibility, not just count.
  await expect(page.locator(".statcal .cell.solved")).toHaveCount(2);
  await expect(page.locator(".statcal .cell.solved").first()).toBeVisible();
  await expect(page.locator(".statcal .cell.missed")).toHaveCount(1);

  // ---- filter to the neutral featured source: free play has nothing ----
  await page.selectOption("#statsSource", "__featured__");
  await expect(page.locator("#statsBody .statgrid").nth(0).locator(".stat").nth(0)).toContainText("3");
  await expect(page.locator("#statsBody")).toContainText("No free play games yet.");

  // guest session → invited to sign in for cross-device sync
  await expect(page.locator("#statsBody .stats-note")).toContainText("Sign in");
});

test("anonymous guest logs plays but never the public leaderboard (scores)", async ({ page }) => {
  await routeRest(page);
  await routeDaily(page);
  let scorePost = false, playPost = null;
  await page.route("**/rest/v1/scores**", r => {
    if (r.request().method() === "POST") scorePost = true;
    return r.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  await page.route("**/rest/v1/plays**", r => {
    if (r.request().method() === "POST") playPost = JSON.parse(r.request().postData() || "{}");
    return r.fulfill({ status: 201, contentType: "application/json", body: "[]" });
  });
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  // an anonymous guest session (is_anonymous: true)
  await page.evaluate(() => { currentUser = { id: "guest-id", is_anonymous: true }; });

  await page.fill("#guess", "golden"); await page.press("#guess", "Enter");
  await page.fill("#guess", "snitch"); await page.press("#guess", "Enter");
  await expect(page.locator("#win")).toHaveClass(/show/);

  // plays IS logged for the guest…
  await expect.poll(() => playPost, { timeout: 5_000 }).not.toBeNull();
  expect((Array.isArray(playPost) ? playPost[0] : playPost).user_id).toBe("guest-id");
  // …but the public leaderboard is never written for an anonymous user
  await page.waitForTimeout(300);
  expect(scorePost).toBe(false);
});

test("signing into a real account merges the guest's plays via the merge-anon function", async ({ page }) => {
  await routeRest(page);
  await routeDaily(page);
  let mergeBody = null;
  await page.route("**/functions/v1/merge-anon**", r => {        // overrides routeRest's functions stub
    mergeBody = JSON.parse(r.request().postData() || "{}");
    return r.fulfill({ status: 200, contentType: "application/json", body: '{"merged":true}' });
  });
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });

  // a real account is now signed in, with a pending guest-merge marker from before the swap
  await page.evaluate(() => {
    currentUser = { id: "real-id", is_anonymous: false };
    localStorage.setItem("redigeerdle:anonmerge",
      JSON.stringify({ id: "guest-id", token: "guest-token-xyz" }));
  });
  await page.evaluate(() => maybeMergeAnon());

  await expect.poll(() => mergeBody, { timeout: 5_000 }).not.toBeNull();
  expect(mergeBody.anon_token).toBe("guest-token-xyz");          // the captured guest token is handed over
  // the pending-merge marker is cleared so it doesn't re-fire
  expect(await page.evaluate(() => localStorage.getItem("redigeerdle:anonmerge"))).toBeNull();
});

test("maybeMergeAnon is a no-op when the saved guest id equals the current user", async ({ page }) => {
  await routeRest(page);
  await routeDaily(page);
  let invoked = false;
  await page.route("**/functions/v1/merge-anon**", r => {
    invoked = true;
    return r.fulfill({ status: 200, contentType: "application/json", body: '{"merged":false}' });
  });
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  await page.evaluate(() => {
    currentUser = { id: "same-id", is_anonymous: false };
    localStorage.setItem("redigeerdle:anonmerge", JSON.stringify({ id: "same-id", token: "t" }));
  });
  await page.evaluate(() => maybeMergeAnon());
  await page.waitForTimeout(300);
  expect(invoked).toBe(false);                                   // nothing to merge into itself
  expect(await page.evaluate(() => localStorage.getItem("redigeerdle:anonmerge"))).toBeNull();  // still cleared
});

// ---- replay-blocking: a finished daily can't be replayed for stats ----

test("re-opening a solved daily in the same session keeps it locked (no replay)", async ({ page }) => {
  await routeRest(page);
  await routeDaily(page);
  await page.route("**/rest/v1/scores**", r =>      // keep submitScore quiet
    r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });

  // anonymous guest solves the daily → solved state persists to localStorage
  await page.evaluate(() => { currentUser = { id: "guest-id", is_anonymous: true }; });
  await page.fill("#guess", "golden"); await page.press("#guess", "Enter");
  await page.fill("#guess", "snitch"); await page.press("#guess", "Enter");
  await expect(page.locator("#win")).toHaveClass(/show/);

  // "sign in" (swap to a real account) and re-open the daily WITHOUT a page reload,
  // exactly as the home button / feed would — it must restore as solved, not replayable.
  await page.evaluate(() => { currentUser = { id: "real-id", is_anonymous: false }; });
  await page.evaluate(async () => { await loadPuzzle(); });
  await expect(page.locator("#guess")).toBeDisabled();
  await expect(page.locator("#win")).toHaveClass(/show/);
});

test("a daily already finished on the server re-locks for a signed-in user with no local state", async ({ page }) => {
  await routeRest(page);
  await routeDaily(page);
  await page.route("**/rest/v1/scores**", r =>
    r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  let playPost = null;
  await page.route("**/rest/v1/plays**", r => {     // overrides routeRest's plays stub
    if (r.request().method() === "GET")             // restoreFinishedFromServer's lookup → a solved row
      return r.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify([{ solved: true, gave_up: false }]) });
    playPost = JSON.parse(r.request().postData() || "{}");   // any upsert here = a clobber of the real row
    return r.fulfill({ status: 201, contentType: "application/json", body: "[]" });
  });
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });

  // real signed-in user on a fresh device: no local daily state, but the server has
  // a solved play (e.g. solved on another device, or as a now-merged guest)
  await page.evaluate(() => { currentUser = { id: "real-id", is_anonymous: false }; localStorage.clear(); });
  await page.evaluate(async () => { await loadPuzzle(); });

  // re-locked from the server → can't be replayed
  await expect(page.locator("#guess")).toBeDisabled();
  await expect(page.locator("#win")).toHaveClass(/show/);
  await expect(page.locator("#winText")).toContainText("already completed");
  // and we did NOT push a reconstructed 0-guess row over the authoritative server row
  await page.waitForTimeout(300);
  expect(playPost).toBeNull();
});

// a daily WITHOUT a stored summary — the picker no longer bakes one in
const DAILY_NO_SUMMARY = { id: "2026-06-10", date: "2026-06-10",
  wiki: "harrypotter.fandom.com", revision_id: 2006074 };

test("daily lazily fetches a hint via the Edge Function when none is stored", async ({ page }) => {
  await routeRest(page);
  await page.route("**/rest/v1/puzzles**", r =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([DAILY_NO_SUMMARY]) }));
  let hintBody = null;
  await page.route("**/functions/v1/**", r => {
    hintBody = JSON.parse(r.request().postData() || "{}");
    return r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ summary: "A vague clue about a sport.", status: "ready" }) });
  });
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  // the Hints button is offered even though no summary is stored
  await expect(page.locator("#hintsBtn")).toBeEnabled();
  await page.click("#hintsBtn");
  await page.click('.hint-tier[data-tier="summary"] .hint-reveal');
  await expect(page.locator("#hintbox")).toContainText("A vague clue about a sport.");
  // the client sent the cache key so the function can store it once for everyone
  expect(hintBody.puzzleId).toBe("2026-06-10");
});

test("daily polls while the hint is pending, then shows it once ready", async ({ page }) => {
  await routeRest(page);
  await page.route("**/rest/v1/puzzles**", r =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([DAILY_NO_SUMMARY]) }));
  let calls = 0;
  await page.route("**/functions/v1/**", r => {
    calls++;
    const body = calls === 1
      ? { summary: "", status: "pending" }       // another player is generating it
      : { summary: "Ready now.", status: "ready" };
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  await page.click("#hintsBtn");
  await page.click('.hint-tier[data-tier="summary"] .hint-reveal');
  await expect(page.locator("#hintbox")).toContainText("Generating hint…");   // pending placeholder
  await expect(page.locator("#hintbox")).toContainText("Ready now.", { timeout: 10_000 });
  expect(calls).toBeGreaterThanOrEqual(2);
});

test("Settings: following a fandom saves to the account when signed in", async ({ page }) => {
  await routeRest(page);   // wikis stubbed to a single host: harrypotter.fandom.com
  await routeDaily(page);
  let upserted = null, deletedWiki = null;
  await page.route("**/rest/v1/follows**", r => {
    const method = r.request().method();
    if (method === "POST") {
      upserted = JSON.parse(r.request().postData() || "{}");
      return r.fulfill({ status: 201, contentType: "application/json",
        body: JSON.stringify(Array.isArray(upserted) ? upserted : [upserted]) });
    }
    if (method === "DELETE") {
      deletedWiki = new URL(r.request().url()).searchParams.get("wiki");
      return r.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    }
    return r.fulfill({ status: 200, contentType: "application/json", body: "[]" });  // GET: no follows yet
  });
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  await page.evaluate(() => { currentUser = { id: "test-user-id" }; });

  await page.click("#settingsBtn");
  await expect(page.locator("#settingsNote")).toContainText("account");   // signed-in copy
  const hp = page.locator('#followList input[data-wiki="harrypotter.fandom.com"]');
  await hp.check();
  await expect.poll(() => upserted, { timeout: 5_000 }).not.toBeNull();
  const row = Array.isArray(upserted) ? upserted[0] : upserted;
  expect(row).toMatchObject({ user_id: "test-user-id", wiki: "harrypotter.fandom.com" });

  // unfollow → DELETE for that wiki
  await hp.uncheck();
  await expect.poll(() => deletedWiki, { timeout: 5_000 }).toContain("harrypotter.fandom.com");
});

test("Settings shows each fandom's display name and icon (emoji + image URL)", async ({ page }) => {
  await routeDaily(page);
  await page.route("**/functions/v1/**", r =>
    r.fulfill({ status: 200, contentType: "application/json", body: '{"summary":""}' }));
  await page.route("**/auth/v1/**", r => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.route("**/rest/v1/follows**", r =>
    r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  // an emoji icon and an image-URL icon
  await page.route("**/rest/v1/wikis**", r =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([
      { host: "harrypotter.fandom.com", display_name: "Harry Potter", icon: "🧙" },
      { host: "zelda.fandom.com", display_name: "The Legend of Zelda", icon: "https://example.com/zelda.png" },
    ]) }));
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  await page.click("#settingsBtn");

  const hp = page.locator('#followList .followrow', { hasText: "Harry Potter" });
  await expect(hp.locator(".fname")).toHaveText("Harry Potter");       // display name, not the host
  await expect(hp.locator("span.ficon")).toHaveText("🧙");              // emoji rendered as text
  const zelda = page.locator('#followList .followrow', { hasText: "The Legend of Zelda" });
  await expect(zelda.locator("img.ficon")).toHaveAttribute("src", "https://example.com/zelda.png");  // URL → <img>
});

test("daily feed lists the followed fandoms' dailies and highlights the loaded one", async ({ page }) => {
  // logged out: follows live in localStorage
  await page.addInitScript(() => localStorage.setItem("redigeerdle:follows",
    JSON.stringify(["harrypotter.fandom.com", "zelda.fandom.com"])));
  await page.route("**/functions/v1/**", r =>
    r.fulfill({ status: 200, contentType: "application/json", body: '{"summary":""}' }));
  await page.route("**/auth/v1/**", r => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.route("**/rest/v1/follows**", r => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route("**/rest/v1/wikis**", r =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([
      { host: "harrypotter.fandom.com", display_name: "Harry Potter", icon: "🧙" },
      { host: "zelda.fandom.com", display_name: "The Legend of Zelda", icon: "🛡️" },
    ]) }));
  const featured = { id: "2026-06-12:harrypotter.fandom.com", date: "2026-06-12",
    wiki: "harrypotter.fandom.com", revision_id: 2006074, is_featured: true };
  await page.route("**/rest/v1/puzzles**", r => {
    if (r.request().url().includes("is_featured")) {           // home query → the featured daily
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([featured]) });
    }
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([   // feed query
      featured,
      { id: "2026-06-12:zelda.fandom.com", date: "2026-06-12", wiki: "zelda.fandom.com", revision_id: 1004112, is_featured: false },
    ]) });
  });
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  // open the daily-feed dropdown from the header
  await page.click("#feedBtn");
  await expect(page.locator("#feed")).toHaveClass(/open/);

  const cards = page.locator("#feedCards .feedcard");
  // pinned "Featured daily" (the featured general daily) + the 2 followed fandoms
  await expect(cards).toHaveCount(3);
  // the general daily is always pinned at the very top
  await expect(cards.first()).toContainText("Featured daily");
  await expect(page.locator("#feedCards")).toContainText("Harry Potter");
  await expect(page.locator("#feedCards")).toContainText("The Legend of Zelda");
  // the featured daily is the one loaded on the home page → the pinned card is highlighted
  await expect(cards.first()).toHaveClass(/active/);
  // followed cards are playable buttons
  await expect(cards.filter({ hasText: "The Legend of Zelda" })).toHaveJSProperty("tagName", "BUTTON");

  // the filter box is offered (2+ fandoms) and narrows the feed live; the pinned
  // "Featured daily" stays visible regardless of the filter
  await expect(page.locator("#feedSearch")).toBeVisible();
  await page.fill("#feedSearch", "zelda");
  await expect(cards.filter({ hasText: "The Legend of Zelda" })).toBeVisible();
  await expect(cards.filter({ hasText: "Harry Potter" })).toBeHidden();
  await expect(cards.filter({ hasText: "Featured daily" })).toBeVisible();
  await page.fill("#feedSearch", "");
  await expect(cards.filter({ hasText: "Harry Potter" })).toBeVisible();
});

test("Settings: the homepage-daily picker lists 'Featured daily' + followed fandoms and persists the choice", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("redigeerdle:follows",
    JSON.stringify(["harrypotter.fandom.com", "zelda.fandom.com"])));
  await page.route("**/functions/v1/**", r =>
    r.fulfill({ status: 200, contentType: "application/json", body: '{"summary":""}' }));
  await page.route("**/auth/v1/**", r => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.route("**/rest/v1/follows**", r => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route("**/rest/v1/wikis**", r =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([
      { host: "harrypotter.fandom.com", display_name: "Harry Potter", icon: "🧙" },
      { host: "zelda.fandom.com", display_name: "The Legend of Zelda", icon: "🛡️" },
    ]) }));
  // no homepage-daily pref → the home page loads the featured Harry Potter daily (live, known-good)
  const featured = { id: "2026-06-12:harrypotter.fandom.com", date: "2026-06-12",
    wiki: "harrypotter.fandom.com", revision_id: 2006074, is_featured: true };
  await page.route("**/rest/v1/puzzles**", r =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([featured]) }));
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });

  // open Settings → the homepage-daily picker
  await page.click("#settingsBtn");
  const sel = page.locator("#homeDailySelect");
  await expect(sel.locator("option")).toHaveCount(3);          // "Featured daily" + the 2 followed fandoms
  await expect(sel.locator("option").first()).toHaveText("Featured daily");
  await expect(sel).toContainText("Harry Potter");
  await expect(sel).toContainText("The Legend of Zelda");
  await expect(sel).toHaveValue("");                           // default: the featured general daily

  // picking a fandom persists it device-local…
  await sel.selectOption("zelda.fandom.com");
  expect(await page.evaluate(() => localStorage.getItem("redigeerdle:homedaily"))).toBe("zelda.fandom.com");
  // …and re-opening Settings reflects the saved choice
  await page.click("#settingsClose");
  await page.click("#settingsBtn");
  await expect(page.locator("#homeDailySelect")).toHaveValue("zelda.fandom.com");

  // switching back to the general daily clears the stored pref
  await page.locator("#homeDailySelect").selectOption("");
  expect(await page.evaluate(() => localStorage.getItem("redigeerdle:homedaily"))).toBeNull();
});

// Shared scaffolding for the resume/reset boot tests. We record which `puzzles`
// query boot fires: `wiki=eq.<host>` means it resumed the last-opened daily;
// `is_featured` means it fell through to the homepage (featured) daily. The HP
// article (revision 2006074) is known-good so the page settles either way.
const HP = { id: "2026-06-12:harrypotter.fandom.com", date: "2026-06-12",
  wiki: "harrypotter.fandom.com", revision_id: 2006074, is_featured: true };
const routeBoot = async (page, urls) => {
  await page.route("**/functions/v1/**", r =>
    r.fulfill({ status: 200, contentType: "application/json", body: '{"summary":""}' }));
  await page.route("**/auth/v1/**", r => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.route("**/rest/v1/follows**", r => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route("**/rest/v1/wikis**", r =>
    r.fulfill({ status: 200, contentType: "application/json", body: '[{"host":"harrypotter.fandom.com"}]' }));
  await page.route("**/rest/v1/puzzles**", r => {
    urls.push(r.request().url());
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([HP]) });
  });
};

test("boot resumes the last-opened daily on a same-day reload", async ({ page }) => {
  await page.addInitScript(() => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam" }).format(new Date());
    localStorage.setItem("redigeerdle:lastdaily", JSON.stringify({ wiki: "harrypotter.fandom.com", day: today }));
  });
  const urls = [];
  await routeBoot(page, urls);
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  // resumed → it queried that fandom's daily directly, never the featured-home query
  expect(urls.some(u => u.includes("wiki=eq.harrypotter.fandom.com"))).toBe(true);
  expect(urls.some(u => u.includes("is_featured"))).toBe(false);
});

test("boot lands on the homepage daily once the dailies have reset (stale last-opened)", async ({ page }) => {
  await page.addInitScript(() =>            // last opened on an old day → must NOT resume
    localStorage.setItem("redigeerdle:lastdaily", JSON.stringify({ wiki: "harrypotter.fandom.com", day: "2000-01-01" })));
  const urls = [];
  await routeBoot(page, urls);             // no homepage pref → featured general daily
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  // stale → ignored the resume and went to the featured-home query
  expect(urls.some(u => u.includes("is_featured"))).toBe(true);
  expect(urls.some(u => u.includes("wiki=eq.harrypotter.fandom.com"))).toBe(false);
});
