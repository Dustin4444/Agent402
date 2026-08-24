// Locks a real bug found live on /marketplace (2026-08-16, reported as "the
// bottom part is missing the chain to select"): a single large scroll jump
// (trackpad flick, End key, clicking the scrollbar track - all ordinary user
// actions, not edge cases) can move a short <section> from below the
// viewport to above it within one rendered frame. The IntersectionObserver
// in ledger-chrome.js's reveal-on-scroll script never sees such a section
// cross its 8% threshold, so it never gets .ml-reveal-in and stays at
// opacity:0 FOREVER - proven by this test to be unrecoverable by further
// normal scrolling too, since a never-intersected element is never
// unobserved but also never re-checked.
//
// This can only be proven with a REAL browser reproducing the REAL scroll
// behavior - a static regex check on the script source (see
// test-reveal-on-scroll.js) can confirm the fix code exists but cannot prove
// it actually un-sticks a skipped section, the same class of gap the CSS
// `//`-comment bug taught this repo to distrust (source presence != runtime
// correctness).
//
// Requires a booted server:
//   FREE_MODE=true PORT=3000 node src/server.js
//   TARGET_URL=http://127.0.0.1:3000 node scripts/test-reveal-scroll-skip.js
import { chromium } from "playwright";

const BASE = process.env.TARGET_URL || "http://127.0.0.1:3000";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${BASE}/marketplace`, { waitUntil: "networkidle" });

  const sectionCount = await page.locator("header,section,[data-reveal]").count();
  ok(sectionCount >= 5, `/marketplace has enough sections to meaningfully test skip-over (got ${sectionCount})`);

  // Reproduce the exact failure: one instant jump straight to the bottom,
  // the same motion a trackpad flick or the End key produces.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1000); // past the 150ms debounce and the 500ms fallback timer

  const afterJump = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll("header,section,[data-reveal]"));
    return els.map((el) => getComputedStyle(el).opacity);
  });
  const stuckCount = afterJump.filter((o) => o !== "1").length;
  ok(stuckCount === 0, `every section is visible after a single instant scroll-to-bottom (${stuckCount}/${afterJump.length} stuck at opacity!=1)`);

  // The animation intent must survive the fix: a fresh load with NO scroll at
  // all must still leave below-the-fold sections hidden, or the "safety net"
  // would have degenerated into "reveal everything immediately," defeating
  // the whole feature.
  const page2 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page2.goto(`${BASE}/marketplace`, { waitUntil: "networkidle" });
  await page2.waitForTimeout(700); // past the 500ms fallback timer, still zero scroll
  const noScrollState = await page2.evaluate(() => {
    const els = Array.from(document.querySelectorAll("header,section,[data-reveal]"));
    return els.map((el) => ({ top: el.getBoundingClientRect().top, revealed: getComputedStyle(el).opacity === "1" }));
  });
  const belowFold = noScrollState.filter((s) => s.top > 900);
  ok(belowFold.length > 0, "sanity: /marketplace has sections genuinely below an ordinary fold to check");
  ok(belowFold.every((s) => !s.revealed), `sections still below the fold with zero scrolling stay hidden - the fix must not force-reveal everything immediately (${belowFold.filter((s) => s.revealed).length}/${belowFold.length} prematurely revealed)`);
  await page2.close();
} finally {
  await browser.close();
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
