/**
 * Captures the four README screenshots.
 *
 * Needs both servers up first, because the upcoming shots use the real board and
 * only the live ones are fabricated:
 *
 *   npm run build
 *   PORT=8790 DIST_DIR=dist node dist-server/server/index.js &
 *   node scripts/mock-board.mjs --mode live       # then run this
 *   node scripts/mock-board.mjs --mode upcoming   # then run this again
 *
 *   node scripts/capture-screens.mjs live
 *   node scripts/capture-screens.mjs upcoming
 *
 * Headless Chromium comes from Playwright rather than a browser already on the
 * machine: Edge writes no file at all here, and driving Firefox kills content
 * processes belonging to whatever the user happens to have open.
 */
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2] === "upcoming" ? "upcoming" : "live";
const here = path.dirname(fileURLToPath(import.meta.url));
const docs = path.resolve(here, "..", "docs");

/** A tall phone: the board is read on one, and it is where the layout is tightest. */
const VIEWPORT = { width: 430, height: 1500 };

/**
 * One canvas for all four, because they sit side by side in a README table and a
 * set of mismatched heights reads as carelessness.
 *
 * A real phone viewport rather than the full scroll height. The board is read on
 * a phone, and a picture the shape of a phone says so at a glance; a 1400px
 * ribbon of every card at once does not. Content running past the fold is not a
 * defect here, it is what the screen actually looks like.
 */
const CANVAS_HEIGHT = 932;

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: VIEWPORT,
  deviceScaleFactor: 2,
  colorScheme: "dark",
});

for (const league of ["nfl", "cfb"]) {
  const page = await context.newPage();
  // Set before the app boots, so it opens on the right tab with no click and no
  // transition to catch mid-flight.
  await page.addInitScript((l) => {
    localStorage.setItem(
      "football-watchability-prefs",
      // A deliberately generic market. The feature is worth showing, but a README
      // is a public page and the author's own postal code is not going in it.
      JSON.stringify({ league: l, favourites: { nfl: [], cfb: [] }, zip: "10001", marketOff: false }),
    );
  }, league);
  await page.goto("http://localhost:8799/", { waitUntil: "networkidle" });
  await page.waitForSelector(".card, .row", { timeout: 15000 });
  // The "updated Ns ago" label ticks every second; let it settle on a round value.
  await page.waitForTimeout(1500);

  await page.setViewportSize({ width: VIEWPORT.width, height: CANVAS_HEIGHT });
  await page.waitForTimeout(300);


  const file = path.join(docs, `${league}-${mode}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`wrote ${file}`);
  await page.close();
}

await browser.close();
