import { test, expect } from "@playwright/test";

// These run against the puzzle.json fallback (no Supabase keys configured),
// so they verify the game UI and the graceful "Supabase not configured" paths.

// The daily/fallback both point at a pinned revision (Golden Snitch) and the
// text is fetched live, so the loaded content is deterministic.
test.beforeEach(async ({ page }) => {
  // Decouple from the live Supabase daily (which changes every day): stub the
  // puzzles query to empty so loadPuzzle() falls back to the bundled puzzle.json
  // pointer (Golden Snitch) — a fixed, deterministic daily for the assertions.
  await page.route("**/rest/v1/puzzles**", route =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  // don't hit the real "hint" Edge Function during tests
  await page.route("**/functions/v1/**", route =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"summary":""}' }));
  // fixed wiki list for the "random from a fandom" autocomplete
  await page.route("**/rest/v1/wikis**", route =>
    route.fulfill({ status: 200, contentType: "application/json",
      body: '[{"host":"harrypotter.fandom.com"},{"host":"zelda.fandom.com"}]' }));
  await page.goto("/");
  // wait until the puzzle has loaded (live fetch) and the guess box is enabled
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
});

test("loads the daily puzzle with the title redacted", async ({ page }) => {
  await expect(page.locator("#status")).toContainText("loaded");
  // the title is present in the DOM but hidden (redacted span, not revealed)
  await expect(page.locator("#title .red:not(.shown)").first()).toBeVisible();
  // no winner yet
  await expect(page.locator("#win")).not.toHaveClass(/show/);
});

test("the source line hides the wiki and title until solved", async ({ page }) => {
  const footer = page.locator("#attribution");
  await expect(footer).not.toContainText("harrypotter");   // wiki hidden
  await expect(footer).not.toContainText("Golden Snitch");  // title hidden
  await page.fill("#guess", "golden"); await page.press("#guess", "Enter");
  await page.fill("#guess", "snitch"); await page.press("#guess", "Enter");
  await expect(page.locator("#win")).toHaveClass(/show/);
  await expect(footer).toContainText("harrypotter.fandom.com");  // revealed after solving
  await expect(footer).toContainText("Golden Snitch");
});

test("a correct guess reveals the word and bumps the counter", async ({ page }) => {
  await page.fill("#guess", "snitch");
  await page.press("#guess", "Enter");
  // the word becomes shown (the title word "Snitch" at least)
  await expect(page.locator('.red.shown:has-text("Snitch")').first()).toBeVisible();
  await expect(page.locator("#count")).toHaveText("1");
  await expect(page.locator("#history .row")).toHaveCount(1);
});

test("guessing the title words solves the game", async ({ page }) => {
  await page.fill("#guess", "golden");
  await page.press("#guess", "Enter");
  await page.fill("#guess", "snitch");
  await page.press("#guess", "Enter");
  await expect(page.locator("#win")).toHaveClass(/show/);
  await expect(page.locator("#winText")).toContainText("Golden Snitch");
});

test("Give up ends the game, locks all controls, and shows in the share", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  page.on("dialog", d => d.accept());                         // accept the confirm
  await page.fill("#guess", "snitch"); await page.press("#guess", "Enter");
  await page.click("#giveUpBtn");
  await expect(page.locator("#win")).toHaveClass(/show/);
  await expect(page.locator("#winHead")).toHaveText("GAVE UP");
  await expect(page.locator("#winText")).toContainText("Golden Snitch");  // answer revealed
  // play + every hint control is locked
  for (const id of ["#guess", "#go", "#revealBtn", "#summaryBtn", "#fandomBtn", "#giveUpBtn"]) {
    await expect(page.locator(id)).toBeDisabled();
  }
  await page.click("#shareBtn");
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain("gave up");
});

test("a given-up daily stays ended after reload", async ({ page }) => {
  page.on("dialog", d => d.accept());
  await page.click("#giveUpBtn");
  await expect(page.locator("#winHead")).toHaveText("GAVE UP");
  await page.reload();
  await expect(page.locator("#winHead")).toHaveText("GAVE UP", { timeout: 20_000 });
  await expect(page.locator("#guess")).toBeDisabled();
  await expect(page.locator("#revealBtn")).toBeDisabled();   // stays locked after reload
});

test("a title word's plural can't be free-revealed", async ({ page }) => {
  // the Golden Snitch article contains "Snitches"; its singular "Snitch" is a
  // title word, so the plural must be locked from the free reveal too.
  const snitches = page.locator('#body .red[data-key="snitches"]').first();
  await expect(snitches).toBeAttached();                 // the word is in the article
  await expect(snitches).not.toHaveClass(/revealable/);  // but not free-revealable
});

test("daily progress survives a page reload", async ({ page }) => {
  await page.fill("#guess", "snitch");
  await page.press("#guess", "Enter");
  await expect(page.locator("#count")).toHaveText("1");
  await page.reload();
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  // the guess and its reveal came back
  await expect(page.locator("#count")).toHaveText("1");
  await expect(page.locator("#history .row")).toHaveCount(1);
  await expect(page.locator('.red.shown:has-text("Snitch")').first()).toBeVisible();
});

test("a solved daily stays solved after reload", async ({ page }) => {
  await page.fill("#guess", "golden"); await page.press("#guess", "Enter");
  await page.fill("#guess", "snitch"); await page.press("#guess", "Enter");
  await expect(page.locator("#win")).toHaveClass(/show/);
  await page.reload();
  // restores as solved: win shown and input locked, so it can't be re-played
  await expect(page.locator("#win")).toHaveClass(/show/, { timeout: 20_000 });
  await expect(page.locator("#guess")).toBeDisabled();
  await expect(page.locator("#revealBtn")).toBeDisabled();   // hint controls stay locked too
});

test("the guess field shows a live letter count", async ({ page }) => {
  await expect(page.locator("#guesscount")).toHaveText(""); // empty to start
  await page.fill("#guess", "snitch");
  await expect(page.locator("#guesscount")).toHaveText("6");
  await page.fill("#guess", "golden snitch".slice(0, 4)); // "gold"
  await expect(page.locator("#guesscount")).toHaveText("4");
  await page.press("#guess", "Enter");
  await expect(page.locator("#guesscount")).toHaveText(""); // clears after submit
});

test("Share copies the custom text to the clipboard (no native share sheet)", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.click("#shareBtn");
  await expect(page.locator("#status")).toContainText("Copied to clipboard");
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain("Redigeerdle");      // our custom message survived
  expect(clip).toContain("?p=daily");         // ...and the share link
});

test("share text breaks down good/bad guesses, reveals and help used", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.fill("#guess", "snitch"); await page.press("#guess", "Enter");   // good (hits the text)
  await page.fill("#guess", "zzzzzz"); await page.press("#guess", "Enter");   // bad (no match)
  await page.click("#revealBtn");                                             // arm a reveal
  await page.locator("#body .red.revealable").first().click();               // use 1 reveal 💡
  await page.click("#summaryBtn");                                            // use the summary hint
  await page.click("#shareBtn");
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain("✅ 1 good");
  expect(clip).toContain("❌ 1 bad");
  expect(clip).toContain("💡 1 reveal");
  expect(clip).not.toContain("💡 1 reveals");   // singular when exactly one
  expect(clip).toContain("📄 summary");
});

test("used hints survive a reload (summary comes back, reflected in share)", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.click("#summaryBtn");
  await expect(page.locator("#hintbox")).toBeVisible();
  await page.reload();
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  await expect(page.locator("#hintbox")).toBeVisible();          // hint re-shown
  await page.click("#shareBtn");
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain("📄 summary");
});

test("sign-up rejects a password shorter than 6 characters", async ({ page }) => {
  await page.click("#authToggle");
  await page.fill("#authEmail", "tester@example.com");
  await page.fill("#authPass", "12345");          // 5 chars — too short
  await page.click("#signUpBtn");
  await expect(page.locator("#authMsg")).toContainText("at least 6 characters");
});

test("sign-in panel opens with both login methods", async ({ page }) => {
  // logged out to start: the Sign in button is offered
  await expect(page.locator("#authToggle")).toBeVisible();
  await page.click("#authToggle");
  await expect(page.locator("#authpanel")).toHaveClass(/open/);
  // both login methods are present
  await expect(page.locator("#googleBtn")).toBeVisible();
  await expect(page.locator("#authEmail")).toBeVisible();
  await expect(page.locator("#signInBtn")).toBeVisible();
  await expect(page.locator("#signUpBtn")).toBeVisible();
});

test("top controls: clickable title loads the daily; no Daily button or subtitle", async ({ page }) => {
  await expect(page.locator("#newBtn")).toBeVisible();
  await expect(page.locator("#authToggle")).toBeVisible();   // Sign in
  await expect(page.locator("#dailyBtn")).toHaveCount(0);     // Daily button removed
  await expect(page.locator(".sub")).toHaveCount(0);          // subtitle removed
  // the title acts as the "back to daily" button
  await expect(page.locator("#homeBtn")).toBeVisible();
  await page.click("#homeBtn");
  await expect(page.locator("#status")).toContainText("loaded", { timeout: 20_000 });
});

test("New game opens a modal with three options and closes", async ({ page }) => {
  await page.click("#newBtn");
  await expect(page.locator("#newmodal")).toHaveClass(/open/);
  await expect(page.locator("#curatedBtn")).toBeVisible();
  await expect(page.locator("#fullRandomBtn")).toBeVisible();
  await expect(page.locator("#ownBtn")).toBeVisible();
  // "Custom link" reveals the URL field
  await expect(page.locator("#ownrow")).not.toHaveClass(/show/);
  await page.click("#ownBtn");
  await expect(page.locator("#ownrow")).toHaveClass(/show/);
  await expect(page.locator("#url")).toBeVisible();
  // clicking the dimmed backdrop closes it
  await page.locator("#newmodal").click({ position: { x: 5, y: 5 } });
  await expect(page.locator("#newmodal")).not.toHaveClass(/open/);
});

test("New game: 'Random from a fandom' reveals an autocomplete of wikis", async ({ page }) => {
  await page.click("#newBtn");
  await page.click("#fandomRandomBtn");
  await expect(page.locator("#fandomrow")).toHaveClass(/show/);
  await expect(page.locator("#fandomSearch")).toBeVisible();
  // datalist populated from the wikis table
  await expect(page.locator("#fandomList option")).toHaveCount(2);
  await expect(page.locator('#fandomList option[value="harrypotter.fandom.com"]')).toHaveCount(1);
});

test("leaderboard panel toggles open", async ({ page }) => {
  await page.click("#boardBtn");
  await expect(page.locator("#board")).toHaveClass(/show/);
  // some content is rendered (a message or rows), not left blank
  await expect(page.locator("#boardList")).not.toBeEmpty();
});

// The daily now loads a pinned revision live from the Fandom API. The shared-link
// path (?wiki=&rev=) uses the exact same loadArticle() mechanism, so this proves
// the live-load architecture end-to-end against a real wiki. Needs network.
test("loads a pinned revision live from a real wiki", async ({ page }) => {
  await page.goto("/?wiki=harrypotter.fandom.com&rev=2006074");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  await expect(page.locator("#status")).toContainText("title hidden");
  // the article title (Golden Snitch) is present but redacted
  await expect(page.locator("#title .red:not(.shown)").first()).toBeVisible();
  // the body has redacted words and is not empty
  expect(await page.locator("#body .red").count()).toBeGreaterThan(20);
});

test("article body keeps its block structure (paragraphs + headings)", async ({ page }) => {
  await page.goto("/?wiki=harrypotter.fandom.com&rev=2006074");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  // real <p> blocks, not one collapsed wall of text
  expect(await page.locator("#body > p").count()).toBeGreaterThan(2);
  // section headings are preserved as elements
  expect(await page.locator("#body h2, #body h3").count()).toBeGreaterThan(0);
});
