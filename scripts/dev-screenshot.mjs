// Dev-only: render index.html in headless Chromium at one or more viewport widths
// and save screenshots, so layout changes can be eyeballed without a browser.
//
//   node scripts/dev-screenshot.mjs [width...]   (default: 1920 1440 1280)
//
// Assumes the static server is reachable at http://localhost:5599
// (start it with: node tests/static-server.mjs). Output goes to .tmp/shots/.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const PORT = 5599;
const widths = process.argv.slice(2).map(Number).filter(Boolean);
const WIDTHS = widths.length ? widths : [1920, 1440, 1280];
const OUT = ".tmp/shots";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
for (const width of WIDTHS) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  // keep it deterministic + fast: don't depend on the live daily loading
  await page.route("**/rest/v1/puzzles**", r =>
    r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);
  await page.locator(".topbar").screenshot({ path: `${OUT}/header-${width}.png` });
  console.log(`wrote ${OUT}/header-${width}.png  (viewport ${width}px)`);
  await page.close();
}
await browser.close();
