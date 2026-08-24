// Locks the scroll-wrapper fix for /compare (2026-08-16 audit): its four
// tables were the only ones site-wide with no horizontal-scroll wrapper -
// every other table (leaderboard, status, revenue) already follows this
// codebase's own documented pattern (<div class="X-scroll" style=
// "overflow-x:auto"><table style="min-width:...">). At mobile widths the
// unwrapped tables would clip content or force the WHOLE PAGE to scroll
// sideways instead of just the table.
//
// Verified via a real browser (Playwright) at a genuinely narrow viewport -
// a static check that the wrapper div/CSS rule exists in the source can't
// prove the table actually becomes scrollABLE (min-width vs viewport width
// is an empirical fact, not something regex can compute) or that the PAGE
// itself stays contained rather than scrolling horizontally too.
//
// Requires a booted server (same TARGET_URL convention as other page tests):
//   FREE_MODE=true PORT=3000 node src/server.js
//   TARGET_URL=http://127.0.0.1:3000 node scripts/test-compare-scroll.js
import { chromium } from "playwright";

const BASE = process.env.TARGET_URL || "http://127.0.0.1:3000";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); // genuinely narrow mobile
  await page.goto(`${BASE}/compare`, { waitUntil: "load" });

  const wraps = await page.locator(".cmp-scroll").count();
  ok(wraps === 4, `/compare has 4 scroll wrappers, one per table (got ${wraps})`);

  for (let i = 0; i < wraps; i++) {
    const el = page.locator(".cmp-scroll").nth(i);
    const table = el.locator("table.cmp-table");
    ok(await table.count() === 1, `wrapper ${i}: contains exactly one .cmp-table`);
    const { scrollWidth, clientWidth, overflowX } = await el.evaluate((e) => ({ scrollWidth: e.scrollWidth, clientWidth: e.clientWidth, overflowX: getComputedStyle(e).overflowX }));
    ok(scrollWidth > clientWidth, `wrapper ${i}: table is genuinely wider than its container at 390px (scrollWidth=${scrollWidth} > clientWidth=${clientWidth})`);
    // The direct, meaningful check: scrollWidth > clientWidth alone only
    // proves the content is bigger than the box - that's true whether or
    // not overflow is actually enabled. overflow-x must be auto/scroll
    // specifically, or the "wider content" fact above means nothing (the
    // page also has a SITE-WIDE `html { overflow-x: clip }` guard -
    // ledger-chrome.js:59 - that masks a missing wrapper rule by silently
    // clipping the overflow instead of showing a scrollbar, so checking
    // page-level overflow can never catch a regression in this specific
    // wrapper; checked directly against ledger-chrome.js's source to
    // confirm this guard is real, not assumed).
    ok(overflowX === "auto" || overflowX === "scroll", `wrapper ${i}: overflow-x is actually auto/scroll, not just visually wide (got "${overflowX}")`);
  }
} finally {
  await browser.close();
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
