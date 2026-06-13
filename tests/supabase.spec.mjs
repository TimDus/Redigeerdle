import { test, expect } from "@playwright/test";

// Integration tests for the Supabase-backed paths. app.spec.mjs deliberately
// stubs Supabase to EMPTY (testing the graceful-absent fallback); here we mock
// POPULATED REST responses so loadPuzzle (Supabase branch), loadLeaderboard
// (row rendering) and submitScore (payload + best-score logic) run their real
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
};

test("loads the daily from Supabase (not the bundled fallback)", async ({ page }) => {
  await routeRest(page);
  await routeDaily(page);
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  // status names the puzzle by its Supabase date — proves the Supabase branch ran
  await expect(page.locator("#status")).toContainText("Puzzle 2026-06-10 loaded");
  // title redacted, body has the live-fetched (and redacted) article
  await expect(page.locator("#title .red:not(.shown)").first()).toBeVisible();
  expect(await page.locator("#body .red").count()).toBeGreaterThan(20);
});

test("leaderboard renders ranked rows from scores (sorting display + reveals + name fallback)", async ({ page }) => {
  await routeRest(page);
  await routeDaily(page);
  // leaderboard list query embeds profiles(username); return three pre-sorted rows
  await page.route("**/rest/v1/scores**", r =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([
      { guesses: 3, reveals: 0, user_id: "u1", profiles: { username: "Alice" } },
      { guesses: 5, reveals: 2, user_id: "u2", profiles: { username: "Bob" } },
      { guesses: 7, reveals: 0, user_id: "u3", profiles: { username: null } },  // → "player"
    ]) }));
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  await page.click("#boardBtn");
  await expect(page.locator("#boardmodal")).toHaveClass(/open/);

  const rows = page.locator("#boardList .lrow");
  await expect(rows).toHaveCount(3);
  await expect(page.locator("#boardTitle")).toContainText("2026-06-10");
  // rank 1: Alice, 3 guesses (no reveals → bare number)
  await expect(rows.nth(0).locator(".rank")).toHaveText("1");
  await expect(rows.nth(0).locator(".nm")).toHaveText("Alice");
  await expect(rows.nth(0).locator(".sc")).toHaveText("3");
  // rank 2: Bob, reveals shown as "5 (2r)"
  await expect(rows.nth(1).locator(".sc")).toHaveText("5 (2r)");
  // rank 3: null username falls back to "player"
  await expect(rows.nth(2).locator(".nm")).toHaveText("player");
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
  // the button is offered even though no summary is stored
  await expect(page.locator("#summaryBtn")).toBeEnabled();
  await page.click("#summaryBtn");
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
  await page.click("#summaryBtn");
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
  await expect(cards).toHaveCount(2);
  await expect(page.locator("#feedCards")).toContainText("Harry Potter");
  await expect(page.locator("#feedCards")).toContainText("The Legend of Zelda");
  // the featured (Harry Potter) daily is the one loaded on the home page → highlighted
  await expect(page.locator("#feedCards .feedcard.active")).toContainText("Harry Potter");
  // both cards are playable buttons
  await expect(cards.filter({ hasText: "The Legend of Zelda" })).toHaveJSProperty("tagName", "BUTTON");

  // the filter box is offered (2+ fandoms) and narrows the feed live
  await expect(page.locator("#feedSearch")).toBeVisible();
  await page.fill("#feedSearch", "zelda");
  await expect(cards.filter({ hasText: "The Legend of Zelda" })).toBeVisible();
  await expect(cards.filter({ hasText: "Harry Potter" })).toBeHidden();
  await page.fill("#feedSearch", "");
  await expect(cards.filter({ hasText: "Harry Potter" })).toBeVisible();
});
