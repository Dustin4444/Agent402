// Reveal-on-scroll must be a SHARED mechanism, not a per-page opt-in copied
// into every page's own script - the exact shape that let the effect exist
// on the homepage but nowhere else on the site for weeks. Locks two things:
//
//  1. The observer init in ledger-chrome.js's shared <head> script selects
//     "header,section,[data-reveal]" - broadening it back down to only
//     "[data-reveal]" would silently un-fix every page that relies on it
//     applying automatically (no page other than legacy [data-reveal] users
//     would opt in on its own).
//  2. A sample of real, booted pages that are SUPPOSED to be section-based
//     (homepage, /marketplace, chain pages, and the other site-revamp
//     pages) actually renders real <section>/<header> markup for the
//     shared selector to reach - catching a regression where a page's
//     template quietly reverts to <div>-only, which would silently drop it
//     from reveal-on-scroll with no test failure anywhere else. This is a
//     static-markup check (no browser, matching this suite's own idiom),
//     not a runtime assertion that the class actually gets applied - the
//     shared script's own try/catch means a JS failure fails open (visible
//     content), which this test cannot observe from raw HTML alone.
//
//   FREE_MODE=true PORT=3000 node src/server.js
//   TARGET_URL=http://localhost:3000 node scripts/test-reveal-coverage.js
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.TARGET_URL || "http://localhost:3000";
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

// --- the shared script's selector must stay broad, not opt-in-only --------
const chromeSrc = readFileSync(join(ROOT, "src", "ledger-chrome.js"), "utf8");
ok(/querySelectorAll\('header,section,\[data-reveal\]'\)/.test(chromeSrc),
  "shared reveal-on-scroll observer selects header/section site-wide, not just [data-reveal] opt-ins");

// --- every page that HAS section/header elements must keep at least the
// count it had when this was locked in - an exact floor, not just ">0", so
// a partial regression (one section quietly reverting to a <div>, not the
// whole page) still fails instead of hiding behind the sections that
// weren't touched. Bumping a number here is expected and fine when a page
// legitimately gains/loses a section; a silent drop is what this catches. */
const MIN_SECTIONS = {
  "/": 10, "/base": 5, "/marketplace": 8, "/pricing": 7, "/leaderboard": 6, "/skills": 7, "/tools": 5, "/what-is-x402": 11, "/sell": 10,
  // Extended 2026-08-15: these 18 pages were <div>-only (zero real sections,
  // zero reveal-on-scroll effect) until this pass gave each one real
  // <section>/<header> markup for the shared observer to reach.
  "/docs": 7, "/status": 5, "/faq": 3, "/revenue": 5, "/playground": 3, "/badges": 4, "/compare": 7, "/community": 7,
  "/changelog": 3, "/blog": 3, "/transparency": 3, "/privacy": 3, "/terms": 3, "/contact": 4, "/analytics": 4,
  "/workflows": 4, "/quickstart": 4, "/guides": 3,
};
for (const [path, min] of Object.entries(MIN_SECTIONS)) {
  const html = await (await fetch(`${BASE}${path}`)).text();
  const realSectionCount = (html.match(/<section[ >]/g) || []).length + (html.match(/<header[ >]/g) || []).length;
  ok(realSectionCount >= min, `${path}: has at least ${min} real <section>/<header> elements to reveal (got ${realSectionCount})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
