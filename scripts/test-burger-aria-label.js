// Locks the hamburger menu aria-label fix (2026-08-16 audit): a402ToggleMenu()
// already correctly toggled aria-expanded, but never touched aria-label,
// which stayed "Open menu" permanently even while the menu was open - a
// screen reader user activating it never heard confirmation the menu opened,
// and had no way to know the SAME control now closes it.
//
// Verified via a real browser (Playwright) clicking the actual button, not a
// static check that both label strings exist somewhere in the source.
//
// Requires a booted server (same TARGET_URL convention as other page tests):
//   FREE_MODE=true PORT=3000 node src/server.js
//   TARGET_URL=http://localhost:3000 node scripts/test-burger-aria-label.js
import { chromium } from "playwright";

const BASE = process.env.TARGET_URL || "http://localhost:3000";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); // burger only shows below the collapse breakpoint
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });

  const burger = page.locator(".ml-burger");
  ok(await burger.count() === 1, "the hamburger button is present at mobile width");

  const before = await burger.evaluate((el) => ({ label: el.getAttribute("aria-label"), expanded: el.getAttribute("aria-expanded") }));
  ok(before.label === "Open menu", `closed state: aria-label is "Open menu" (got "${before.label}")`);
  ok(before.expanded === "false", `closed state: aria-expanded is "false" (got "${before.expanded}")`);

  await burger.click();
  const opened = await burger.evaluate((el) => ({ label: el.getAttribute("aria-label"), expanded: el.getAttribute("aria-expanded") }));
  ok(opened.label === "Close menu", `open state: aria-label flips to "Close menu" (got "${opened.label}")`);
  ok(opened.expanded === "true", `open state: aria-expanded flips to "true" (got "${opened.expanded}")`);

  await burger.click();
  const closed = await burger.evaluate((el) => ({ label: el.getAttribute("aria-label"), expanded: el.getAttribute("aria-expanded") }));
  ok(closed.label === "Open menu", `closed again: aria-label flips back to "Open menu" (got "${closed.label}")`);
  ok(closed.expanded === "false", `closed again: aria-expanded flips back to "false" (got "${closed.expanded}")`);
} finally {
  await browser.close();
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
