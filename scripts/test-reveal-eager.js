// Locks the data-reveal-eager opt-in (2026-08-16 audit): the hero-flash fix
// only ever exempted the FIRST matched header/section from the reveal-on-
// scroll hide-then-observe cycle. Some pages have a SECOND section that's
// also reliably above the fold (found on /pricing - the tier cards sit
// directly under a short hero) and got the same flash the hero fix already
// solved for index 0. Rather than guessing "how many leading sections are
// above the fold" generically - unsafe without a getBoundingClientRect read
// before webfonts/map settle, and wrong on every page where the second
// section really IS below the fold - this is an explicit, opt-in
// [data-reveal-eager] marker a page sets on a specific section it knows is
// always visible on load.
//
// Verified via a real browser (Playwright), not static source inspection -
// the whole point is client-side class-application behavior at
// DOMContentLoaded time.
//
// Requires a booted server (same TARGET_URL convention as other page tests):
//   FREE_MODE=true PORT=3000 node src/server.js
//   TARGET_URL=http://127.0.0.1:3000 node scripts/test-reveal-eager.js
import { chromium } from "playwright";

const BASE = process.env.TARGET_URL || "http://127.0.0.1:3000";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const browser = await chromium.launch();
try {
  const page = await browser.newPage();

  // /pricing's second section is marked data-reveal-eager - must never get
  // the hiding class at all, must render fully visible immediately.
  await page.goto(`${BASE}/pricing`, { waitUntil: "domcontentloaded" });
  const eager = await page.evaluate(() => {
    const els = document.querySelectorAll("header,section,[data-reveal]");
    const el = els[1];
    return el ? { present: true, hasEagerAttr: el.hasAttribute("data-reveal-eager"), hasRevealClass: el.classList.contains("ml-reveal"), opacity: getComputedStyle(el).opacity } : { present: false };
  });
  ok(eager.present, "/pricing has a second header/section element to check");
  ok(eager.hasEagerAttr, "/pricing's second section actually carries the data-reveal-eager marker (test isn't checking the wrong element)");
  ok(!eager.hasRevealClass, "the eager-marked section never gets the ml-reveal hiding class");
  ok(eager.opacity === "1", `the eager-marked section renders at full opacity immediately (got ${eager.opacity})`);

  // A page whose second section is NOT marked eager must be completely
  // unaffected - still gets the hiding class, still fades in on scroll.
  // This is the regression this fix could most easily cause: exempting too
  // much and quietly breaking the reveal effect for genuinely below-fold
  // content everywhere else.
  await page.goto(`${BASE}/marketplace`, { waitUntil: "domcontentloaded" });
  const notMarked = await page.evaluate(() => {
    const els = document.querySelectorAll("header,section,[data-reveal]");
    const el = els[1];
    return el ? { present: true, hasEagerAttr: el.hasAttribute("data-reveal-eager"), hasRevealClass: el.classList.contains("ml-reveal") } : { present: false };
  });
  ok(notMarked.present, "/marketplace has a second header/section element to check");
  ok(!notMarked.hasEagerAttr, "/marketplace's second section is genuinely unmarked (test isn't accidentally checking a marked page)");
  ok(notMarked.hasRevealClass, "an UNMARKED second section still gets the hiding class - the opt-in doesn't leak to pages that never asked for it");

  // The hero (first match) must still be exempt exactly as before on both
  // pages - this fix must not have disturbed the original hero-flash fix.
  for (const path of ["/pricing", "/marketplace"]) {
    await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
    const hero = await page.evaluate(() => {
      const el = document.querySelectorAll("header,section,[data-reveal]")[0];
      return el ? el.classList.contains("ml-reveal") : null;
    });
    ok(hero === false, `${path}: the hero (first match) still never gets the hiding class`);
  }
} finally {
  await browser.close();
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
