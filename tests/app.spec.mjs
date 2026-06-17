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
  // intercept ALL auth so boot's silent anonymous sign-in never touches the real
  // project (it would create real guest users once anon sign-ins are enabled on prod)
  await page.route("**/auth/v1/**", route =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
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
  for (const id of ["#guess", "#go", "#hintsBtn", "#giveUpBtn"]) {
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
  await expect(page.locator("#hintsBtn")).toBeDisabled();   // hint controls stay locked after reload
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
  await expect(page.locator("#hintsBtn")).toBeDisabled();   // hint controls stay locked too
});

// A solo (random/custom) game must resume on a plain reload — the same article AND its
// progress — instead of jumping to the daily. Only a NEW local day routes to the daily.
test("a solo random/custom game resumes its article + progress on reload", async ({ page }) => {
  // load a solo (custom) game — a pinned HP revision — then make a guess that reveals a word
  await page.evaluate(([wiki, rev]) => loadFromRevision(wiki, rev), ["harrypotter.fandom.com", 2006074]);
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  await page.fill("#guess", "snitch"); await page.press("#guess", "Enter");
  await expect(page.locator('.red.shown:has-text("Snitch")').first()).toBeVisible();
  await expect(page.locator("#history .row")).toHaveCount(1);

  // a plain reload (no query params) resumes THIS solo game, not the daily
  await page.reload();
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  await expect(page.locator("#status")).toContainText("Resumed your progress");
  await expect(page.locator("#history .row")).toHaveCount(1);          // the guess came back
  await expect(page.locator('.red.shown:has-text("Snitch")').first()).toBeVisible();  // and its reveal
  // it's the solo game (custom), not a daily — Daily metrics don't apply
  expect(await page.evaluate(() => currentShare.kind)).toBe("custom");
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
  await page.click("#hintsBtn");                                             // open the Hints panel
  await page.click('.hint-tier[data-tier="reveal_word"] .hint-reveal');       // arm a reveal (now a panel row)
  await page.locator("#body .red.revealable").first().click();               // use 1 reveal 💡
  await page.click('.hint-tier[data-tier="summary"] .hint-reveal');          // reveal the summary tier
  await page.click("#shareBtn");
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain("✅ 1 good");
  expect(clip).toContain("❌ 1 bad");
  expect(clip).toContain("💡 1 reveal");
  expect(clip).not.toContain("💡 1 reveals");   // singular when exactly one
  expect(clip).toContain("📄 summary");          // the exact hint tier used, not a generic label
  expect(clip).toMatch(/[🟩⬛]{10}/u);            // the proportional accuracy bar
});

test("score adds a time penalty: +1 for every full 10s of active play", async ({ page }) => {
  // baseline: a fresh game with no guesses and ~no elapsed time scores 0
  expect(await page.evaluate(() => computeScore())).toBe(0);

  // 25s of accrued active play → floor(25/10)*1 = 2 points (the live pill reflects it)
  await page.evaluate(() => { playActiveMs = 25_000; updateScore(); });
  expect(await page.evaluate(() => computeScore())).toBe(2);
  await expect(page.locator("#scoreVal")).toHaveText("2");

  // a wrong guess (+1) stacks on top of the time penalty
  await page.fill("#guess", "zzzzzz"); await page.press("#guess", "Enter");
  expect(await page.evaluate(() => computeScore())).toBe(3);

  // the time component freezes at the finish (gameFinishedAt set) — more wall-clock
  // afterwards doesn't keep adding, because accruePlayTime stops once finished
  await page.evaluate(() => { gameFinishedAt = Date.now(); const before = playActiveMs; accruePlayTime(); if (playActiveMs !== before) throw new Error("clock kept ticking after finish"); });
});

test("synonym tier: reveals the AI synonym, costs +50, and shows in the share", async ({ page }) => {
  // the stubbed hint function returns no packet here, so inject one carrying a synonym
  await page.evaluate(() => { hints = { category: "", summary: "", synonym: "Automobile", first_letter: "" }; });
  await page.click("#hintsBtn");
  // the synonym row sits between First letter and Source in the panel
  const row = page.locator('.hint-tier[data-tier="synonym"]');
  await expect(row).toBeVisible();
  await row.locator(".hint-reveal").click();
  await expect(row.locator(".hint-tier-val")).toContainText("Automobile");

  // it's the priciest tier: +50 (no guesses, time zeroed so the pill is exactly the tier cost)
  await page.evaluate(() => { playActiveMs = 0; playTickAt = 0; updateScore(); });
  await expect(page.locator("#scoreVal")).toHaveText("50");

  // and it surfaces in the share breakdown with its own icon
  const share = await page.evaluate(() => buildShareText());
  expect(share).toContain("🔁 synonym");
});

test("synonym tier: per-word synonyms render positionally, names shown as '(a name)'", async ({ page }) => {
  // current packet shape: one synonym per title word, in order; "" = a proper name
  await page.evaluate(() => { hints = { category: "", summary: "", synonyms: ["glittering", ""], first_letter: "" }; });
  await page.click("#hintsBtn");
  const row = page.locator('.hint-tier[data-tier="synonym"]');
  await row.locator(".hint-reveal").click();
  // the synonym for word 1 shows; the name word (empty entry) renders as a marker, NOT a title word
  await expect(row.locator(".hint-tier-val")).toContainText("glittering");
  await expect(row.locator(".hint-tier-val")).toContainText("(a name)");
  await expect(row.locator(".hint-tier-val")).not.toContainText("Snitch");
});

test("a chosen-fandom source is shown but FREE — it isn't scored or listed as a used hint", async ({ page }) => {
  // playing a specific fandom (feed follow-card / 'Random from a fandom') reveals the source
  // for free — revealSource(true) marks it pre-known. Zero out time so the pill is exact.
  await page.evaluate(() => { revealSource(true); playActiveMs = 0; playTickAt = 0; updateScore(); });
  expect(await page.evaluate(() => fandomUsed)).toBe(true);    // the source IS shown (you chose the fandom)
  await expect(page.locator("#scoreVal")).toHaveText("0");     // …but it adds nothing to the score
  expect(await page.evaluate(() => buildShareText())).not.toContain("🏷️");   // and isn't a used hint in the share

  // contrast: a PAID source reveal (a featured/random game where the source was hidden) costs +10
  await page.evaluate(() => { sourceFree = false; updateScore(); });
  await expect(page.locator("#scoreVal")).toHaveText("10");
  expect(await page.evaluate(() => buildShareText())).toContain("🏷️ source");
});

test("Letters tier: each reveal uncovers the next title letter at an escalating cost", async ({ page }) => {
  await page.click("#hintsBtn");
  const row = page.locator('.hint-tier[data-tier="first_letter"]');
  // first letter costs +20 (same as the old single first-letter tier); the mask appears
  await row.locator(".hint-reveal").click();
  await page.evaluate(() => { playActiveMs = 0; playTickAt = 0; updateScore(); });
  expect(await page.evaluate(() => computeScore())).toBe(20);
  await expect(row.locator(".hint-tier-val")).toContainText("Title:");
  // the button now offers the NEXT letter at the escalated +25
  await expect(row.locator(".hint-reveal")).toContainText("+25");
  // two more letters → 20 + 25 + 30 = 75, and the title mask fills in (Golden Snitch → "Gol…")
  await row.locator(".hint-reveal").click();
  await row.locator(".hint-reveal").click();
  await page.evaluate(() => { playActiveMs = 0; playTickAt = 0; updateScore(); });
  expect(await page.evaluate(() => computeScore())).toBe(75);
  expect(await page.evaluate(() => lettersRevealed)).toBe(3);
  await expect(row.locator(".hint-tier-val")).toContainText("Gol");
  // the share breaks it down with the live count, not a generic label
  expect(await page.evaluate(() => buildShareText())).toContain("🔤 3 letters");
});

test("Letters tier un-redacts the actual title; reveals are PINNED (no free re-flow) but the price keeps escalating", async ({ page }) => {
  // reveal two letters → the REAL title at the top un-redacts them (not just the panel mask)
  await page.click("#hintsBtn");
  const lettersBtn = page.locator('.hint-tier[data-tier="first_letter"] .hint-reveal');
  await lettersBtn.click();
  await lettersBtn.click();
  // "Golden Snitch" → the first hidden word gets the letters: "Go" shown inside #title
  await expect(page.locator("#title .letterlit").first()).toHaveText("Go");

  // now GUESS that first title word. The two paid letters were PINNED to "Golden" — they must
  // NOT jump to "Snitch" and hand you a free letter there.
  await page.fill("#guess", "golden"); await page.press("#guess", "Enter");
  await expect(page.locator("#title .red.shown").filter({ hasText: "Golden" }).first()).toBeVisible();
  await expect(page.locator("#title .letterlit")).toHaveCount(0);   // no free letter on Snitch
  // the panel mask agrees: Golden fully shown, Snitch fully masked still
  await expect(page.locator('.hint-tier[data-tier="first_letter"] .hint-tier-val')).toContainText("Golden ___");
  // the purchase count (and so the cost) is unchanged by the guess…
  expect(await page.evaluate(() => lettersRevealed)).toBe(2);
  // …and the NEXT letter still costs the escalated +30 (a 3rd purchase), not a reset +20
  await expect(lettersBtn).toContainText("+30");

  // buying it now reveals the first letter of Snitch — paid for, not free
  await lettersBtn.click();
  await expect(page.locator("#title .letterlit")).toHaveText("S");
  expect(await page.evaluate(() => lettersRevealed)).toBe(3);
});

test("Letters tier: fully spelling a word with letters enters it as a guessed word", async ({ page }) => {
  await page.click("#hintsBtn");
  const lettersBtn = page.locator('.hint-tier[data-tier="first_letter"] .hint-reveal');
  // "Golden Snitch": buy all 6 letters of the first word "Golden" to fully spell it out
  for (let i = 0; i < 6; i++) await lettersBtn.click();
  // it's now a real guessed word: in the guessed set + guess history (hits > 0), not a reveal
  expect(await page.evaluate(() => guessed.has("golden"))).toBe(true);
  expect(await page.evaluate(() => guesses.some(g => norm(g.word) === "golden" && g.hits > 0 && !g.hint))).toBe(true);
  // the title shows "Golden" fully revealed (promoted from letter-lit to guessed) — and the
  // game isn't solved, because "Snitch" is still hidden
  await expect(page.locator("#title .red.shown").filter({ hasText: "Golden" }).first()).toBeVisible();
  expect(await page.evaluate(() => solved)).toBe(false);
});

test("First sentence tier: reveals the lead sentence in place but keeps title words blacked", async ({ page }) => {
  await page.click("#hintsBtn");
  const row = page.locator('.hint-tier[data-tier="first_sentence"]');
  await expect(row.locator(".hint-reveal")).toContainText("+");   // priced before purchase
  await row.locator(".hint-reveal").click();
  // the panel shows the lead sentence (a distinctive non-title word from the Golden Snitch lead)…
  await expect(row.locator(".hint-tier-val")).toContainText("Quidditch");
  // …with the title spelled out NOWHERE (title words stay masked)
  await expect(row.locator(".hint-tier-val")).not.toContainText("Golden Snitch");
  // it un-redacts those lead words in the article body too
  await expect(page.locator("#body .red.shown").filter({ hasText: "Quidditch" }).first()).toBeVisible();
  expect(await page.evaluate(() => firstSentenceUsed)).toBe(true);
  expect(await page.evaluate(() => buildShareText())).toContain("📖 first sentence");
});

test("First sentence tier: live cost is +3 per still-hidden word and drops as you guess them", async ({ page }) => {
  await page.click("#hintsBtn");
  const btn = page.locator('.hint-tier[data-tier="first_sentence"] .hint-reveal');
  const costOf = async () => parseInt((await btn.textContent()).match(/\+(\d+)/)[1], 10);
  const hidden = () => page.evaluate(() => firstSentenceHiddenCount());

  // priced at exactly 3 per still-hidden non-title word it would uncover (no base)
  expect(await costOf()).toBe((await hidden()) * 3);

  // guessing a lead-sentence word un-redacts it, so the tier no longer has to uncover it —
  // the live button cost ticks down (−3 per now-revealed word) WITHOUT re-opening the panel
  const before = await costOf();
  await page.fill("#guess", "Quidditch"); await page.press("#guess", "Enter");
  const after = await costOf();
  expect(after).toBeLessThan(before);
  expect(after).toBe((await hidden()) * 3);   // still exactly 3 × what remains hidden
});

test("Letters + first-sentence tiers survive a reload", async ({ page }) => {
  await page.click("#hintsBtn");
  await page.locator('.hint-tier[data-tier="first_letter"] .hint-reveal').click();
  await page.locator('.hint-tier[data-tier="first_letter"] .hint-reveal').click();
  await page.locator('.hint-tier[data-tier="first_sentence"] .hint-reveal').click();
  await page.reload();
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  // the panel re-renders from saved state: the letter count and the revealed sentence both return
  expect(await page.evaluate(() => lettersRevealed)).toBe(2);
  expect(await page.evaluate(() => firstSentenceUsed)).toBe(true);
  await expect(page.locator('.hint-tier[data-tier="first_sentence"] .hint-tier-val')).toContainText("Quidditch");
  // and the body still shows the lead sentence un-redacted after the reload
  await expect(page.locator("#body .red.shown").filter({ hasText: "Quidditch" }).first()).toBeVisible();
});

test("used hints survive a reload (summary comes back, reflected in share)", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.click("#hintsBtn");
  await page.click('.hint-tier[data-tier="summary"] .hint-reveal');
  await expect(page.locator('.hint-tier[data-tier="summary"] .hint-tier-val')).toBeVisible();
  await page.reload();
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  // the revealed summary tier comes back on its own (panel re-rendered from saved state)
  await expect(page.locator('.hint-tier[data-tier="summary"] .hint-tier-val')).toBeVisible();
  await page.click("#shareBtn");
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain("📄 summary");
});

test("mobile: the Hints button opens a popup with the tiers (not above the article)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();   // re-boot at mobile width so placeHintbox moves #hintbox into the modal
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  // the panel is reparented into the modal body, and the popup stays closed until tapped
  await expect(page.locator("#hintsModalBody #hintbox")).toBeAttached();
  await expect(page.locator("#hintsmodal")).not.toHaveClass(/open/);
  await page.click("#hintsBtn");
  await expect(page.locator("#hintsmodal")).toHaveClass(/open/);
  await page.click('#hintsmodal .hint-tier[data-tier="summary"] .hint-reveal');
  await expect(page.locator('#hintsmodal .hint-tier[data-tier="summary"] .hint-tier-val')).toBeVisible();
  await page.click("#hintsClose");   // ✕ closes it
  await expect(page.locator("#hintsmodal")).not.toHaveClass(/open/);
});

test("mobile: Share + Invite collapse into a 'Social' popup", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();   // re-boot at mobile width so placeSocial moves the buttons into the modal
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  // Share + Invite are reparented into the popup body; the bar shows the single "Social" button
  await expect(page.locator("#socialModalBody #shareBtn")).toBeAttached();
  await expect(page.locator("#socialModalBody #inviteBtn")).toBeAttached();
  await expect(page.locator("#socialBtn")).toBeVisible();
  await expect(page.locator("#socialmodal")).not.toHaveClass(/open/);
  await page.click("#socialBtn");
  await expect(page.locator("#socialmodal")).toHaveClass(/open/);
  await expect(page.locator("#socialmodal #shareBtn")).toBeVisible();   // Share reachable inside
  await page.click("#socialClose");   // ✕ closes it
  await expect(page.locator("#socialmodal")).not.toHaveClass(/open/);
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
  await expect(page.locator("#authmodal")).toHaveClass(/open/);   // opens as a popup
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

test("New game: 'Random from a fandom' shows a searchable fandom list", async ({ page }) => {
  await page.click("#newBtn");
  await page.click("#fandomRandomBtn");
  await expect(page.locator("#fandomrow")).toHaveClass(/show/);
  await expect(page.locator("#fandomSearch")).toBeVisible();
  // a visual list built from the wikis table (stubbed: 2 hosts)
  const opts = page.locator("#fandomPickList .fandomopt");
  await expect(opts).toHaveCount(2);
  await expect(page.locator('#fandomPickList .fandomopt[data-host="harrypotter.fandom.com"]')).toHaveCount(1);
  // the search box narrows the list live
  await page.fill("#fandomSearch", "zelda");
  await expect(opts.filter({ hasText: "zelda" })).toBeVisible();
  await expect(opts.filter({ hasText: "harrypotter" })).toBeHidden();
  // a "Curated search" toggle, on by default, controls whether the picker-style
  // quality search is used for the chosen fandom
  await expect(page.locator("#fandomCurated")).toBeChecked();
});

test("How to play opens a modal explaining the game and closes", async ({ page }) => {
  await expect(page.locator("#helpmodal")).not.toHaveClass(/open/);
  await page.click("#helpBtn");
  await expect(page.locator("#helpmodal")).toHaveClass(/open/);
  await expect(page.locator("#helpmodal")).toContainText("blacked out");
  await expect(page.locator("#helpmodal")).toContainText("title");
  await page.click("#helpClose");
  await expect(page.locator("#helpmodal")).not.toHaveClass(/open/);
});

test("daily metrics popup opens", async ({ page }) => {
  await page.click("#metricsBtn");
  await expect(page.locator("#metricsmodal")).toHaveClass(/open/);
  // some content is rendered (a message or rows), not left blank
  await expect(page.locator("#metricsList")).not.toBeEmpty();
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

test("clicking a guessed word in the history cycles through its occurrences in the text", async ({ page }) => {
  await page.goto("/?wiki=harrypotter.fandom.com&rev=2006074");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  // find two distinct non-stop, non-title body words that each occur at least
  // twice (non-title so guessing them never solves the puzzle / skips the jump)
  const info = await page.evaluate(() => {
    const counts = {};
    tokens.forEach(t => { if (t.region === "body" && !t.stop && t.key) counts[t.key] = (counts[t.key] || 0) + 1; });
    const multi = Object.keys(counts).filter(k => counts[k] >= 2 && !isTitleWord(k));
    return { key: multi[0], n: counts[multi[0]], key2: multi[1] };
  });
  expect(info.key).toBeTruthy();
  expect(info.n).toBeGreaterThanOrEqual(2);
  expect(info.key2).toBeTruthy();
  // guess it
  await page.fill("#guess", info.key);
  await page.press("#guess", "Enter");
  // its history row is navigable and carries the key
  const row = page.locator('#history .row.nav[data-key="' + info.key + '"]');
  await expect(row).toHaveCount(1);
  // every occurrence is now shown in the body
  expect(await page.locator('#body span.shown[data-key="' + info.key + '"]').count()).toBe(info.n);
  // a correct guess already highlights the word at its first occurrence…
  expect(await page.evaluate(k => wordNav.get(k), info.key)).toBe(1);
  expect(await page.locator('#body span.locate-active[data-key="' + info.key + '"]').count()).toBe(1);
  expect(await page.locator('#body span.locate[data-key="' + info.key + '"]').count()).toBe(info.n - 1);
  // …and clicking the history row advances to the next occurrence each time…
  await row.click();
  expect(await page.evaluate(k => wordNav.get(k), info.key)).toBe(2);
  // …cycling through the rest and wrapping back to the first
  for (let i = 3; i <= info.n; i++) await row.click();   // advance to the last → cursor at n
  expect(await page.evaluate(k => wordNav.get(k), info.key)).toBe(info.n);
  await row.click();                                     // one past the end → wrap
  expect(await page.evaluate(k => wordNav.get(k), info.key)).toBe(1);

  // guessing a DIFFERENT word moves the highlight to it (occurrence 1) and resets the old one
  await page.fill("#guess", info.key2);
  await page.press("#guess", "Enter");
  const row2 = page.locator('#history .row.nav[data-key="' + info.key2 + '"]');
  await expect(row2).toHaveCount(1);
  expect(await page.evaluate(k => wordNav.get(k), info.key2)).toBe(1);          // new word: occurrence 1
  expect(await page.evaluate(k => wordNav.has(k), info.key)).toBe(false);       // previous word: cursor reset
});

test("article body keeps its block structure (paragraphs + headings)", async ({ page }) => {
  await page.goto("/?wiki=harrypotter.fandom.com&rev=2006074");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  // real <p> blocks, not one collapsed wall of text
  expect(await page.locator("#body > p").count()).toBeGreaterThan(2);
  // section headings are preserved as elements
  expect(await page.locator("#body h2, #body h3").count()).toBeGreaterThan(0);
});

test("Settings opens a daily-feed fandom list built from the wikis table", async ({ page }) => {
  await page.click("#settingsBtn");
  await expect(page.locator("#settingsmodal")).toHaveClass(/open/);
  // logged out → saved on this device
  await expect(page.locator("#settingsNote")).toContainText("device");
  // one row per wiki from the (stubbed) wikis table
  const rows = page.locator("#followList .followrow");
  await expect(rows).toHaveCount(2);
  await expect(page.locator('#followList input[data-wiki="harrypotter.fandom.com"]')).toHaveCount(1);
  await expect(page.locator('#followList input[data-wiki="zelda.fandom.com"]')).toHaveCount(1);
  // searching narrows the list to matching fandoms
  await page.fill("#followSearch", "harry");
  await expect(page.locator('#followList .followrow', { hasText: "harrypotter" })).toBeVisible();
  await expect(page.locator('#followList .followrow', { hasText: "zelda" })).toBeHidden();
  await page.fill("#followSearch", "");
  await expect(page.locator('#followList .followrow', { hasText: "zelda" })).toBeVisible();
  // clicking the dimmed backdrop closes it
  await page.locator("#settingsmodal").click({ position: { x: 5, y: 5 } });
  await expect(page.locator("#settingsmodal")).not.toHaveClass(/open/);
});

test("layout: the two-column play area is the default (article | controls grid)", async ({ page }) => {
  // wide is now the base layout — #playarea is a CSS grid on a desktop-width viewport
  await page.setViewportSize({ width: 1200, height: 900 });
  await expect(page.locator("#playarea")).toHaveCSS("display", "grid");
  // and the controls column is the sticky right-hand cell
  await expect(page.locator("#controlcol")).toHaveCSS("position", "sticky");
  // Settings has two visible sections here: Preferences (dark mode / jump-to-word) and
  // Daily feed. (The Profile section is hidden when not signed in as a real account.)
  await page.click("#settingsBtn");
  const headers = page.locator("#settingsmodal .settings-h:visible");
  await expect(headers).toHaveCount(2);
  await expect(headers.nth(0)).toHaveText("Preferences");
  await expect(headers.nth(1)).toHaveText("Daily feed");
  await expect(page.locator("#profileSec")).toBeHidden();
});

test("layout: collapses to a single column on a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 900 });
  // below the 880px breakpoint #playarea is display:contents — single column
  await expect(page.locator("#playarea")).toHaveCSS("display", "contents");
});

test("Settings: Dark mode toggles the theme and persists across reloads", async ({ page }) => {
  // starts light
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.click("#settingsBtn");
  await page.locator("#darkToggle").check();
  await expect(page.locator("html")).toHaveClass(/dark/);
  expect(await page.evaluate(() => localStorage.getItem("redigeerdle:theme"))).toBe("dark");
  // survives a reload (the head script re-applies it before paint) and the toggle reflects it
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.click("#settingsBtn");
  await expect(page.locator("#darkToggle")).toBeChecked();
  // turning it off restores light and persists
  await page.locator("#darkToggle").uncheck();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  expect(await page.evaluate(() => localStorage.getItem("redigeerdle:theme"))).toBe("light");
});

test("Settings: 'Jump to a word' is on by default and persists when turned off", async ({ page }) => {
  await page.click("#settingsBtn");
  await expect(page.locator("#scrollToggle")).toBeChecked();          // default on
  expect(await page.evaluate(() => prefAutoScroll)).toBe(true);
  await page.locator("#scrollToggle").uncheck();
  expect(await page.evaluate(() => prefAutoScroll)).toBe(false);      // disables the auto-scroll
  expect(await page.evaluate(() => localStorage.getItem("redigeerdle:autoscroll"))).toBe("0");
  // survives a reload
  await page.reload();
  expect(await page.evaluate(() => prefAutoScroll)).toBe(false);
  await page.click("#settingsBtn");
  await expect(page.locator("#scrollToggle")).not.toBeChecked();
});

test("layout: the top bar is a sticky header and publishes its height as --header-h", async ({ page }) => {
  await expect(page.locator(".topbar")).toHaveCSS("position", "sticky");
  await expect(page.locator(".topbar")).toHaveCSS("top", "0px");
  // JS measures the header and exposes --header-h so the sticky controls pin below it
  const h = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--header-h").trim());
  expect(h).toMatch(/^\d+(\.\d+)?px$/);
  expect(parseFloat(h)).toBeGreaterThan(40);
});

test("the daily-feed dropdown toggles from the header and prompts you to follow fandoms when none are chosen", async ({ page }) => {
  // closed by default — it's a header dropdown now
  await expect(page.locator("#feed")).not.toHaveClass(/open/);
  await page.click("#feedBtn");
  await expect(page.locator("#feed")).toHaveClass(/open/);
  // no follows set → a prompt (puzzles stubbed empty)
  await expect(page.locator("#feedCards")).toContainText("Follow fandoms in Settings");
  // clicking the button again collapses it
  await page.click("#feedBtn");
  await expect(page.locator("#feed")).not.toHaveClass(/open/);
});

test("Settings: following a fandom persists to localStorage and survives reload (logged out)", async ({ page }) => {
  await page.click("#settingsBtn");
  await page.locator('#followList input[data-wiki="harrypotter.fandom.com"]').check();
  // written to the local cache
  const stored = await page.evaluate(() => localStorage.getItem("redigeerdle:follows"));
  expect(stored).toContain("harrypotter.fandom.com");
  // reload → the choice comes back checked
  await page.reload();
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  await page.click("#settingsBtn");
  await expect(page.locator('#followList input[data-wiki="harrypotter.fandom.com"]')).toBeChecked();
  await expect(page.locator('#followList input[data-wiki="zelda.fandom.com"]')).not.toBeChecked();
});

test("custom-link parser handles Fandom, Wikipedia, minecraft.wiki and ?title= URLs", async ({ page }) => {
  const cases = await page.evaluate(() => [
    "https://harrypotter.fandom.com/wiki/Golden_Snitch",
    "https://harrypotter.fandom.com/de/wiki/Goldener_Schnatz",
    "https://en.wikipedia.org/wiki/Cat",
    "https://minecraft.wiki/w/Block_of_Resin",
    "https://wiki.guildwars2.com/wiki/Guild_Wars_2",
    "https://wiki.guildwars2.com/index.php?title=Mesmer",
  ].map(u => { try { return parseWikiUrl(u); } catch (e) { return { error: e.message }; } }));
  expect(cases[0]).toMatchObject({ host: "harrypotter.fandom.com", langPrefix: "", title: "Golden Snitch" });
  expect(cases[1]).toMatchObject({ host: "harrypotter.fandom.com", langPrefix: "/de", title: "Goldener Schnatz" });
  expect(cases[2]).toMatchObject({ host: "en.wikipedia.org", title: "Cat" });
  expect(cases[3]).toMatchObject({ host: "minecraft.wiki", title: "Block of Resin" });   // /w/ path
  expect(cases[4]).toMatchObject({ host: "wiki.guildwars2.com", title: "Guild Wars 2" });
  expect(cases[5]).toMatchObject({ host: "wiki.guildwars2.com", title: "Mesmer" });       // ?title=
});

// A bad custom link must show an error IN the modal (the #status bar it also writes
// is hidden behind the open modal, so previously a bad link looked like a no-op).
test("Custom link shows an in-modal error for a malformed URL", async ({ page }) => {
  await page.click("#newBtn");
  await page.click("#ownBtn");
  await page.fill("#url", "not-a-real-url");
  await page.click("#loadUrlBtn");
  const msg = page.locator("#urlMsg");
  await expect(msg).toBeVisible();
  await expect(msg).toHaveClass(/err/);
  await expect(msg).toContainText("valid URL");
  // the modal stays open so the user sees the feedback
  await expect(page.locator("#newmodal")).toHaveClass(/open/);
  // editing the field clears the stale error
  await page.fill("#url", "https://en.wikipedia.org/wiki/Cat");
  await expect(msg).toBeHidden();
});

// End-to-end proof for a non-Fandom wiki: Wikipedia's API is at /w/api.php, so
// resolveApiBase must discover it. Needs network.
test("Custom link loads a Wikipedia article (auto-resolves /w/api.php)", async ({ page }) => {
  await page.click("#newBtn");
  await page.click("#ownBtn");
  await page.fill("#url", "https://en.wikipedia.org/wiki/Cat");
  await page.click("#loadUrlBtn");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 25_000 });
  await expect(page.locator("#title .red:not(.shown)").first()).toBeVisible();   // title redacted
  expect(await page.locator("#body .red").count()).toBeGreaterThan(20);          // redacted body
});
