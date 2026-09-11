// The /status 90-day strip must not push the page sideways on a phone.
//
// Reported from a real handset 2026-09-11: "the status green orange bars go
// off the page". It is arithmetic, not a rendering quirk. The strip is 90
// bars in a flex row; each has min-width 2px and the desktop gap is 2px, so
// its MINIMUM width is 90*2 + 89*2 = 358px, while the phone wrapper leaves
// viewport-36px. Every handset narrower than 394px overflowed - which is most
// of them. A 1px gap under the 640px breakpoint takes the floor to 269px.
//
// Checked in a REAL browser at a real viewport, because the failure is the
// document being wider than the screen, and only layout can tell you that.
// The bars keep their 2px min-width on purpose: thinner reads as a smear, and
// the whole point of the strip is that a bad day is visible.
import { chromium } from "playwright-core";

// Targets PROD by default, on purpose. The strip renders only from recorded
// probe observations and a local FREE_MODE boot has none, so a local run finds
// zero strips - and this file treats that as a FAILURE rather than a pass,
// because "nothing to check" must never read as "checked and fine". Same
// one-run lag as test-challenge-size: the test job runs before the deploy, so
// a CSS fix goes green on the run AFTER the one that ships it.
const TARGET = process.env.STATUS_TARGET_URL || "https://agent402.tools";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };

const browser = await chromium.launch();
try {
  for (const width of [320, 360, 375, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    await page.goto(`${TARGET}/status`, { waitUntil: "domcontentloaded" });

    const doc = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    ok(doc.scrollWidth <= doc.clientWidth + 1,
      `${width}px: the page does not scroll sideways (scrollWidth ${doc.scrollWidth} <= clientWidth ${doc.clientWidth})`);

    const strips = await page.$$eval(".bars", (els) => els.map((e) => ({
      scrollWidth: e.scrollWidth, clientWidth: e.clientWidth, bars: e.children.length,
      gap: getComputedStyle(e).columnGap,
    })));
    ok(strips.length > 0, `${width}px: the page actually rendered a 90-day strip (found ${strips.length})`);
    for (const [i, s] of strips.entries()) {
      ok(s.scrollWidth <= s.clientWidth + 1,
        `${width}px: strip ${i} (${s.bars} bars, gap ${s.gap}) fits its container - ${s.scrollWidth} <= ${s.clientWidth}`);
    }
    // The bars must still be WIDE enough to read: a strip that fits by
    // collapsing to hairlines would pass the overflow check and fail the
    // reader, which is the whole reason this page exists.
    const barW = await page.$$eval(".bars .b", (els) => els.slice(0, 3).map((e) => e.getBoundingClientRect().width));
    ok(barW.length > 0 && barW.every((w) => w >= 1.4), `${width}px: bars stay legible, not hairlines (first three: ${barW.map((w) => w.toFixed(2)).join(", ")}px)`);
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
