import { test, expect } from "@playwright/test";

// Baseline (test-first) suite for the realtime MULTIPLAYER feature — co-op (shared
// board) and versus (host-gated race). Written BEFORE the implementation, so these
// fail until the `mp` module + its hooks land in index.html.
//
// How realtime is tested hermetically in ONE page (no second browser, no network):
//   - The page itself is the LOCAL peer (drives the real DOM/board).
//   - The REMOTE peer is SIMULATED by injecting transport events into the local
//     `mp`: `mp._recv(event, payload)` (an incoming broadcast) and
//     `mp._recvPresence(roster)` (a presence/roster sync).
//   - Outgoing broadcasts are captured in `mp._sent` (the local peer's own actions).
//   - `window.__MP_FAKE_TX = true` makes `mp` use a no-op transport (never opens a
//     real Supabase channel), so create/join are fully offline.
//
// The article is the pinned Harry Potter "Golden Snitch" revision (2006074) — the
// same known-good live revision the other suites load; its title solves with
// "golden" + "snitch".

const HP_WIKI = "harrypotter.fandom.com";
const HP_REV = 2006074;

// hermetic Supabase plumbing (mirrors supabase.spec's routeRest); the article body
// is still fetched live from the pinned Fandom revision.
const routeRest = async page => {
  await page.route("**/functions/v1/**", r =>
    r.fulfill({ status: 200, contentType: "application/json", body: '{"summary":""}' }));
  await page.route("**/rest/v1/wikis**", r =>
    r.fulfill({ status: 200, contentType: "application/json", body: `[{"host":"${HP_WIKI}"}]` }));
  await page.route("**/auth/v1/**", r =>
    r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.route("**/rest/v1/plays**", r =>
    r.fulfill({ status: 201, contentType: "application/json", body: "[]" }));
  await page.route("**/rest/v1/follows**", r =>
    r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  // a daily pointer so boot settles to *something* when there's no ?room= override
  await page.route("**/rest/v1/puzzles**", r =>
    r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify([{ id: "2026-06-10", date: "2026-06-10", wiki: HP_WIKI, revision_id: HP_REV, is_featured: true }]) }));
};

// run the fake-transport flag BEFORE any app code, and sign in a fake REAL account
const fakeTx = page => page.addInitScript(() => { window.__MP_FAKE_TX = true; });
const beReal = page => page.evaluate(() => {
  currentUser = { id: "me-id", is_anonymous: false };
  currentProfile = { id: "me-id", username: "Me" };
});

// load the Golden Snitch article as a custom (pointer) game — the base every
// co-op/versus room is built on
const loadHP = page => page.evaluate(async ([wiki, rev]) => { await loadFromRevision(wiki, rev); }, [HP_WIKI, HP_REV]);

test("boot with ?room= while signed out shows the sign-in gate, not a board", async ({ page }) => {
  await routeRest(page);
  await page.goto("/?room=ABC123");
  // auth is stubbed empty → no real user → must gate behind sign-in
  await expect(page.locator("#authmodal")).toHaveClass(/open/);
  await expect(page.locator("#authJoinNote")).toBeVisible();
  await expect(page.locator("#authJoinNote")).toContainText(/sign in/i);
  // no game loaded → the guess box stays disabled
  await expect(page.locator("#guess")).toBeDisabled();
});

test("co-op: a remote guess reveals the word locally and tags who guessed it", async ({ page }) => {
  await fakeTx(page);
  await routeRest(page);
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  await beReal(page);
  await loadHP(page);
  await page.evaluate(() => mp.createRoom("coop"));

  // a teammate ("Bob") guesses "golden" → it reveals on our shared board
  await page.evaluate(() => mp._recv("guess", { key: "golden", raw: "golden", hint: false, by: "Bob" }));
  await expect(page.locator("#title .red.shown").first()).toBeVisible();
  // …and the history row credits Bob
  const row = page.locator("#history .row", { hasText: "golden" });
  await expect(row).toContainText("Bob");

  // our OWN typed guess is broadcast out exactly once (the originator applies locally,
  // peers receive it — no echo back to us)
  await page.fill("#guess", "snitch"); await page.press("#guess", "Enter");
  const sent = await page.evaluate(() => mp._sent.filter(m => m.event === "guess"));
  expect(sent.some(m => m.payload.key === "snitch")).toBe(true);
  // in co-op EVERY guess is attributed — our own guess shows OUR name, not a bare number
  await expect(page.locator("#history .row", { hasText: "snitch" })).toContainText("Me");
});

test("co-op: a hint revealed by a teammate shows for everyone (no extra fetch)", async ({ page }) => {
  await fakeTx(page);
  await routeRest(page);
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  await beReal(page);
  await loadHP(page);
  await page.evaluate(() => mp.createRoom("coop"));

  // teammate reveals the Summary tier and shares the packet → we render the same text
  await page.evaluate(() => mp._recv("hint", {
    tier: "summary",
    packet: { category: "", summary: "A small clue about a sport.", first_letter: "" },
    by: "Bob",
  }));
  await expect(page.locator("#hintbox")).toContainText("A small clue about a sport.");
  await expect(page.locator('#hintbox .hint-tier[data-tier="summary"] .hint-tier-val')).toBeVisible();
});

test("co-op: a teammate's letter reveals show in the shared title and stay PINNED across a teammate's guess", async ({ page }) => {
  await fakeTx(page);
  await routeRest(page);
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  await beReal(page);
  await loadHP(page);
  await page.evaluate(() => mp.createRoom("coop"));

  // a teammate reveals two letters (count + pinned per-word mask ride the hint event) → our
  // REAL title ("Golden Snitch") un-redacts them: "Go" lit on the first hidden word
  await page.evaluate(() => mp._recv("hint", { tier: "first_letter", letters: 2, litMask: [2, 0], packet: hints, by: "Bob" }));
  await expect(page.locator("#title .letterlit").first()).toHaveText("Go");
  expect(await page.evaluate(() => lettersRevealed)).toBe(2);

  // a teammate then GUESSES the first title word on the shared board. The two letters were
  // pinned to "Golden" → they must NOT jump to "Snitch" and reveal a free letter there.
  await page.evaluate(() => mp._recv("guess", { key: "golden", raw: "golden", hint: false, by: "Bob" }));
  await expect(page.locator("#title .red.shown").filter({ hasText: "Golden" }).first()).toBeVisible();
  await expect(page.locator("#title .letterlit")).toHaveCount(0);   // no free letter on Snitch
  expect(await page.evaluate(() => lettersRevealed)).toBe(2);
});

test("co-op: revealing the Synonym tier broadcasts the tier + packet (teammate pays no Groq call)", async ({ page }) => {
  await fakeTx(page);
  await routeRest(page);
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  await beReal(page);
  await loadHP(page);
  await page.evaluate(() => mp.createRoom("coop"));

  // we hold an AI packet with a synonym; reveal that tier
  await page.evaluate(() => { hints = { category: "", summary: "", synonym: "Gilded ball", first_letter: "" }; mp._sent.length = 0; });
  await page.click("#hintsBtn");
  await page.click('.hint-tier[data-tier="synonym"] .hint-reveal');

  // the synonym tier AND the full packet ride ONE broadcast → a teammate renders it
  // without a second Groq request (the whole point of sharing the packet verbatim)
  const hint = await page.evaluate(() => mp._sent.filter(s => s.event === "hint").pop());
  expect(hint.payload.tier).toBe("synonym");
  expect(hint.payload.packet.synonym).toBe("Gilded ball");

  // and incoming: a teammate's synonym renders for us too (generic _applyRemoteHint path)
  await page.evaluate(() => mp._recv("hint", { tier: "synonym", packet: { synonym: "Winged sphere" }, by: "Bob" }));
  await expect(page.locator('#hintbox .hint-tier[data-tier="synonym"] .hint-tier-val')).toContainText("Winged sphere");
});

test("co-op: a remote free-word reveal decrements the shared reveal allowance", async ({ page }) => {
  await fakeTx(page);
  await routeRest(page);
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  await beReal(page);
  await loadHP(page);
  await page.evaluate(() => mp.createRoom("coop"));

  // 3 reveals to start (desktop label)
  await expect(page.locator("#revealBtn")).toContainText("3");
  await page.evaluate(() => mp._recv("reveal", { key: "snitch", by: "Bob" }));
  await expect(page.locator("#revealBtn")).toContainText("2");
});

test("versus: a guest waits until the host starts, then the board unlocks", async ({ page }) => {
  await fakeTx(page);
  await routeRest(page);
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  await beReal(page);

  // join as a guest and receive the host's room config (versus, not yet started)
  await page.evaluate(async ([wiki, rev]) => {
    await mp.joinRoom("ROOM1");
    await mp._enterRoom({ mode: "versus", wiki, rev, started: false });
  }, [HP_WIKI, HP_REV]);

  // waiting: overlay shown, input locked
  await expect(page.locator("#mpWaiting")).toBeVisible();
  await expect(page.locator("#guess")).toBeDisabled();

  // host fires start with a shared timestamp → unlock + adopt the fair start time
  await page.evaluate(() => mp._recv("start", { startAt: 1750000000000 }));
  await expect(page.locator("#mpWaiting")).toBeHidden();
  await expect(page.locator("#guess")).toBeEnabled();
  expect(await page.evaluate(() => gameStartedAt)).toBe(1750000000000);
});

test("versus: opponents' live progress renders in the standings, leader flagged on solve", async ({ page }) => {
  await fakeTx(page);
  await routeRest(page);
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  await beReal(page);
  await page.evaluate(async ([wiki, rev]) => {
    await mp.joinRoom("ROOM2");
    await mp._enterRoom({ mode: "versus", wiki, rev, started: true });
  }, [HP_WIKI, HP_REV]);

  // a presence sync carrying an opponent's progress
  await page.evaluate(() => mp._recvPresence([
    { userId: "bob", name: "Bob", role: "guest", pct: 60, guesses: 9, score: 14, solved: false, gaveUp: false },
  ]));
  const bob = page.locator("#mpStandings .mp-peer", { hasText: "Bob" });
  await expect(bob).toBeVisible();
  await expect(bob).toContainText("60%");
  await expect(bob).toContainText("9");

  // when Bob solves, his row is flagged as finished
  await page.evaluate(() => mp._recvPresence([
    { userId: "bob", name: "Bob", role: "guest", pct: 100, guesses: 11, score: 14, solved: true, gaveUp: false },
  ]));
  await expect(page.locator("#mpStandings .mp-peer", { hasText: "Bob" })).toContainText("🏁");
});

test("co-op: giving up ends the game for teammates too (broadcast both ways)", async ({ page }) => {
  await fakeTx(page);
  await routeRest(page);
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  await beReal(page);
  await loadHP(page);
  await page.evaluate(() => mp.createRoom("coop"));

  // a teammate gives up → our shared board locks as "gave up"
  await page.evaluate(() => mp._recv("giveup", { by: "Bob" }));
  await expect(page.locator("#win")).toHaveClass(/show/);
  await expect(page.locator("#winHead")).toHaveText("GAVE UP");
  await expect(page.locator("#guess")).toBeDisabled();
});

test("co-op: my give-up is broadcast so teammates lose immediately", async ({ page }) => {
  await fakeTx(page);
  await routeRest(page);
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  await beReal(page);
  await loadHP(page);
  await page.evaluate(() => mp.createRoom("coop"));
  await page.evaluate(() => giveUp());     // bypass the confirm() dialog the button shows
  const sent = await page.evaluate(() => mp._sent.filter(s => s.event === "giveup"));
  expect(sent.length).toBe(1);
});

test("the Invite button turns the article you're playing into a co-op room", async ({ page }) => {
  await fakeTx(page);
  await routeRest(page);
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  await beReal(page);
  await loadHP(page);

  // while playing a custom article the Invite (co-op) button is offered…
  await expect(page.locator("#inviteBtn")).toBeVisible();
  await page.click("#inviteBtn");
  expect(await page.evaluate(() => mp.active)).toBe(true);
  expect(await page.evaluate(() => mp.mode)).toBe("coop");
  // …and it hides once you're in a room
  await expect(page.locator("#inviteBtn")).toBeHidden();
});

test("versus: the host can CANCEL the match before it starts, and keep playing solo", async ({ page }) => {
  await fakeTx(page);
  await routeRest(page);
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  await beReal(page);
  await loadHP(page);
  await page.evaluate(() => mp.createRoom("versus"));

  await expect(page.locator("#mpWaiting")).toBeVisible();
  await expect(page.locator("#mpCancelBtn")).toBeVisible();
  await page.click("#mpCancelBtn");
  await expect(page.locator("#mpWaiting")).toBeHidden();
  expect(await page.evaluate(() => mp.active)).toBe(false);
  const sent = await page.evaluate(() => mp._sent.filter(s => s.event === "cancel"));
  expect(sent.length).toBe(1);
  await expect(page.locator("#guess")).toBeEnabled();          // back to solo on the same article
});

test("versus: a waiting guest is released when the host cancels", async ({ page }) => {
  await fakeTx(page);
  await routeRest(page);
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  await beReal(page);
  await page.evaluate(async ([wiki, rev]) => {
    await mp.joinRoom("ROOMC");
    await mp._enterRoom({ mode: "versus", wiki, rev, started: false });
  }, [HP_WIKI, HP_REV]);
  await expect(page.locator("#mpWaiting")).toBeVisible();

  await page.evaluate(() => mp._recv("cancel", {}));
  await expect(page.locator("#mpWaiting")).toBeHidden();
  expect(await page.evaluate(() => mp.active)).toBe(false);
});

test("versus host replies to a guest's hello with the room config (broadcast handshake)", async ({ page }) => {
  await fakeTx(page);
  await routeRest(page);
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  await beReal(page);
  await loadHP(page);
  await page.evaluate(() => mp.createRoom("versus"));

  // a guest's hello must make the host broadcast the room config (mode + article pointer)
  const cfg = await page.evaluate(() => {
    mp._recv("hello", {});
    const m = mp._sent.filter(s => s.event === "config").pop();
    return m && m.payload;
  });
  expect(cfg).toMatchObject({ mode: "versus", wiki: HP_WIKI, rev: HP_REV });
});

test("versus: opponents' progress updates LIVE via broadcast (not presence — that's rate-limited)", async ({ page }) => {
  await fakeTx(page);
  await routeRest(page);
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  await beReal(page);
  await page.evaluate(async ([wiki, rev]) => {
    await mp.joinRoom("ROOMP");
    await mp._enterRoom({ mode: "versus", wiki, rev, started: true });
  }, [HP_WIKI, HP_REV]);

  // a progress broadcast updates the opponent's standings row…
  await page.evaluate(() => mp._recv("progress", { userId: "bob", name: "Bob", role: "guest", pct: 50, guesses: 8, score: 12, solved: false, gaveUp: false }));
  const bob = page.locator("#mpStandings .mp-peer", { hasText: "Bob" });
  await expect(bob).toContainText("50%");
  await expect(bob).toContainText("8");
  // …and a further broadcast updates it again (live), flagging the solve
  await page.evaluate(() => mp._recv("progress", { userId: "bob", name: "Bob", role: "guest", pct: 100, guesses: 11, score: 12, solved: true, gaveUp: false }));
  await expect(page.locator("#mpStandings .mp-peer", { hasText: "Bob" })).toContainText("🏁");

  // our own guesses broadcast progress (so opponents see US move) — not a presence call
  await page.fill("#guess", "golden"); await page.press("#guess", "Enter");
  const prog = await page.evaluate(() => mp._sent.filter(s => s.event === "progress"));
  expect(prog.length).toBeGreaterThan(0);
});

test("versus: revealing a hint broadcasts our updated score (opponents see the +10 immediately)", async ({ page }) => {
  await fakeTx(page);
  await routeRest(page);
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  await beReal(page);
  await page.evaluate(async ([wiki, rev]) => {
    await mp.joinRoom("ROOMHINT");
    await mp._enterRoom({ mode: "versus", wiki, rev, started: true });
  }, [HP_WIKI, HP_REV]);

  // reveal a hint tier (+10) and check it pushed a fresh progress broadcast — this used
  // NOT to fire (renderHints didn't publish), so opponents kept our stale score
  await page.evaluate(() => { mp._sent.length = 0; });
  await page.click("#hintsBtn");
  await page.click('.hint-tier[data-tier="summary"] .hint-reveal');
  const prog = await page.evaluate(() => mp._sent.filter(s => s.event === "progress"));
  expect(prog.length).toBeGreaterThan(0);
  expect(prog.some(p => p.payload.score >= 10)).toBe(true);   // the summary tier is reflected in the broadcast score
});

test("versus: revealing the Synonym tier broadcasts our +50 score", async ({ page }) => {
  await fakeTx(page);
  await routeRest(page);
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  await beReal(page);
  await page.evaluate(async ([wiki, rev]) => {
    await mp.joinRoom("ROOMSYN");
    await mp._enterRoom({ mode: "versus", wiki, rev, started: true });
  }, [HP_WIKI, HP_REV]);

  // reveal the synonym tier (+50) and confirm a fresh progress broadcast carries it
  await page.evaluate(() => { hints = { category: "", summary: "", synonym: "Gilded ball", first_letter: "" }; mp._sent.length = 0; });
  await page.click("#hintsBtn");
  await page.click('.hint-tier[data-tier="synonym"] .hint-reveal');
  const prog = await page.evaluate(() => mp._sent.filter(s => s.event === "progress"));
  expect(prog.some(p => p.payload.score >= 50)).toBe(true);   // synonym is the priciest tier
});

test("a finished co-op game is logged to plays with game_type 'coop'", async ({ page }) => {
  await fakeTx(page);
  await routeRest(page);
  let logged = null;
  await page.route("**/rest/v1/plays**", r => {        // override routeRest's plays stub
    if (r.request().method() === "POST") logged = JSON.parse(r.request().postData() || "{}");
    return r.fulfill({ status: 201, contentType: "application/json", body: "[]" });
  });
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  await beReal(page);
  await loadHP(page);
  await page.evaluate(() => mp.createRoom("coop"));

  // solve it locally → recordPlay upserts with the multiplayer game_type
  await page.fill("#guess", "golden"); await page.press("#guess", "Enter");
  await page.fill("#guess", "snitch"); await page.press("#guess", "Enter");
  await expect(page.locator("#win")).toHaveClass(/show/);

  const lastRow = () => (Array.isArray(logged) ? logged[0] : logged);
  await expect.poll(() => !!(lastRow() && lastRow().solved), { timeout: 5_000 }).toBe(true);
  expect(lastRow().game_type).toBe("coop");      // a random/custom co-op game counts ONLY as co-op
  expect(lastRow().coop).toBe(true);
  expect(lastRow().wiki).toBe(HP_WIKI);
});

test("converting a DAILY to co-op keeps it in daily stats but flags coop (and skips the leaderboard)", async ({ page }) => {
  await fakeTx(page);
  await routeRest(page);
  let logged = null, scorePost = false;
  await page.route("**/rest/v1/plays**", r => {
    if (r.request().method() === "POST") logged = JSON.parse(r.request().postData() || "{}");
    return r.fulfill({ status: 201, contentType: "application/json", body: "[]" });
  });
  await page.route("**/rest/v1/scores**", r => {
    if (r.request().method() === "POST") scorePost = true;
    return r.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  await beReal(page);
  // the featured daily is already loaded at boot → convert THIS daily to co-op (don't loadHP)
  await page.evaluate(() => mp.createRoom("coop"));
  expect(await page.evaluate(() => currentShare.kind)).toBe("daily");   // it STAYS a daily

  await page.fill("#guess", "golden"); await page.press("#guess", "Enter");
  await page.fill("#guess", "snitch"); await page.press("#guess", "Enter");
  await expect(page.locator("#win")).toHaveClass(/show/);

  const last = () => (Array.isArray(logged) ? logged[0] : logged);
  await expect.poll(() => !!(last() && last().solved), { timeout: 5_000 }).toBe(true);
  expect(last().game_type).toBe("featured_daily");   // daily stats, NOT "coop"
  expect(last().puzzle_id).toBe("2026-06-10");        // keeps its daily identity
  expect(last().coop).toBe(true);                     // …but remembered as co-op
  // a co-op solve is NOT pushed to the competitive leaderboard
  await page.waitForTimeout(200);
  expect(scorePost).toBe(false);
});

test("versus guest enters via the host's config broadcast (reliable handshake, not only presence)", async ({ page }) => {
  await fakeTx(page);
  await routeRest(page);
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  await beReal(page);

  // join, then receive the host's config over broadcast → the guest loads the article + waits
  await page.evaluate(() => mp.joinRoom("ROOMX"));
  await page.evaluate(([wiki, rev]) => mp._recv("config", { mode: "versus", wiki, rev, started: false }), [HP_WIKI, HP_REV]);
  await expect.poll(() => page.evaluate(() => mp.mode), { timeout: 20_000 }).toBe("versus");
  await expect(page.locator("#title .red").first()).toBeVisible({ timeout: 20_000 });   // board built
  await expect(page.locator("#mpWaiting")).toBeVisible();                               // versus → waiting
  // joining a guest broadcasts a hello so the host knows to (re)send config
  // (transport is faked here; we just assert the panel label is correct below)
});

test("the room panel never mislabels a joining guest as Co-op before the mode is known", async ({ page }) => {
  await fakeTx(page);
  await routeRest(page);
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  await beReal(page);

  // simulate the REAL ?room= boot: no puzzle has loaded yet, so tokens/guesses are
  // uninitialised — the standings must still render without throwing
  await page.evaluate(() => { tokens = undefined; guesses = undefined; mp.joinRoom("ROOMY"); mp._recvPresence([]); });
  await expect(page.locator("#mpPanel")).toBeVisible();
  await expect(page.locator("#mpTitle")).toHaveText("Joining…");
  await expect(page.locator("#mpTitle")).not.toContainText(/co-?op/i);
});

test("versus host can reach the invite link from the waiting overlay, and the timer starts on Play", async ({ page }) => {
  await fakeTx(page);
  await routeRest(page);
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  await beReal(page);
  await loadHP(page);
  await page.evaluate(() => mp.createRoom("versus"));

  // the host waits behind the overlay — a Copy button must be reachable THERE
  // (the overlay covers #mpPanel), with the Play button. No raw link text is shown.
  await expect(page.locator("#mpWaiting")).toBeVisible();
  await expect(page.locator("#mpPlayBtn")).toBeVisible();
  await expect(page.locator("#mpWaitCopyBtn")).toBeVisible();
  await expect(page.locator("#mpWaitInvite")).toHaveCount(0);   // no link text input in the popup

  // the clock only starts when the host presses Play
  const before = await page.evaluate(() => Date.now());
  await page.click("#mpPlayBtn");
  await expect(page.locator("#mpWaiting")).toBeHidden();
  await expect(page.locator("#guess")).toBeEnabled();
  const startedAt = await page.evaluate(() => gameStartedAt);
  expect(startedAt).toBeGreaterThanOrEqual(before);
});

test("createRoom mints a room id and an invite URL carrying ?room=", async ({ page }) => {
  await fakeTx(page);
  await routeRest(page);
  await page.goto("/");
  await expect(page.locator("#guess")).toBeEnabled({ timeout: 20_000 });
  await beReal(page);
  await loadHP(page);

  const info = await page.evaluate(() => {
    mp.createRoom("versus");
    return { id: mp.roomId, url: mp.inviteUrl(), role: mp.role, mode: mp.mode, active: mp.active };
  });
  expect(info.active).toBe(true);
  expect(info.role).toBe("host");
  expect(info.mode).toBe("versus");
  expect(info.id).toBeTruthy();
  expect(info.url).toContain("?room=" + info.id);
});
