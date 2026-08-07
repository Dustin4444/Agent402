// Dark-only theme — offline unit tests. No network.
//
// The site used to ship a light default plus a moon/sun toggle, a pre-paint
// script reading localStorage, and a :root[data-theme="dark"] override block.
// That is all gone: dark is now the ONLY theme, set directly on :root.
//
// Why that shape rather than just defaulting the toggle to dark: a palette
// applied through an attribute needs JavaScript to set it, which means a frame
// of the wrong colours before the script runs, plus a stored preference that
// can disagree with the markup. Dark values on :root make the first paint
// already correct with no script at all.
//
// These assertions exist because a HALF-removed theme is worse than either
// state. Reintroducing a light token, an override block, or a toggle should
// fail here rather than ship a page that is dark in some places and white in
// others.
//
//   node scripts/test-theme.js
import { ledgerShell, LEDGER_CSS } from "../src/ledger-chrome.js";
import { readFileSync } from "node:fs";

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`ok - ${msg}`); }
  else { failed++; console.error(`FAIL - ${msg}`); }
};

const html = ledgerShell({
  title: "t", description: "d", canonical: "https://agent402.tools/x",
  baseUrl: "https://agent402.tools", body: "<main>hi</main>",
});

// --- the :root palette IS the dark palette ----------------------------------
const rootBlock = LEDGER_CSS.slice(LEDGER_CSS.indexOf(":root {"), LEDGER_CSS.indexOf("}", LEDGER_CSS.indexOf("--font-mono")));
const tok = (name) => (rootBlock.match(new RegExp(`${name}:\\s*(\\S+);`)) || [])[1] || "";
const isDark = (h) => /^#[0-3]/.test(h);      // #0E0E10, #171719, #1E1E21…
const isLight = (h) => /^#[C-Fc-f]/.test(h);  // #ECECEA, #F4F4F2…

ok(isDark(tok("--paper")), `page background is dark (--paper ${tok("--paper")})`);
ok(isLight(tok("--ink")), `foreground is light (--ink ${tok("--ink")})`);
ok(isDark(tok("--card")), `cards are dark (--card ${tok("--card")})`);
// --ink and --cream must stay paired: ~100 chips are background:var(--ink)
// with color:var(--cream), so if only one of them flips they go invisible.
ok(isDark(tok("--cream")), `--cream is dark so ink chips read light-on-dark (${tok("--cream")})`);
ok(isLight(tok("--on-dark")), `text on dark surfaces stays light (--on-dark ${tok("--on-dark")})`);
ok(/color-scheme:\s*dark/.test(LEDGER_CSS), "color-scheme is dark so form controls and scrollbars match");
ok(!/color-scheme:\s*light/.test(LEDGER_CSS), "no light color-scheme survives");

// --- nothing of the toggle mechanism is left --------------------------------
ok(!LEDGER_CSS.includes('[data-theme="dark"]'), "no [data-theme] override block in the CSS");
// Matches the ATTRIBUTE form (`data-theme=`) and the selector form
// (`[data-theme`), not the bare word: the CSS comment above legitimately
// explains why the attribute is gone, and a test that fails on its own
// documentation is testing prose rather than behaviour.
ok(!/data-theme\s*=/.test(html), "no data-theme attribute is set on any element");
ok(!/\[data-theme/.test(html.replace(/\/\*[\s\S]*?\*\//g, "")), "no [data-theme] selector outside comments");
ok(!html.includes("a402ToggleTheme"), "no toggle function ships");
ok(!html.includes("a402-theme"), "no stored theme preference is read or written");
ok(!html.includes("prefers-color-scheme"), "the OS preference no longer decides the palette");
ok(!html.includes("ml-theme-toggle"), "the toggle button is gone from the nav");
ok(!html.includes("ml-moon") && !html.includes("ml-sun"), "moon and sun glyphs are gone");

// --- no orphaned selector where the toggle rules used to be -----------------
// The first removal pass matched from `.ml-theme-toggle` to end of line, which
// stranded `:root[data-theme="dark"] ` in front of the following comment and
// produced a malformed selector - the kind that silently invalidates the rule
// after it. Whole-line removal fixed it; this keeps it fixed.
ok((LEDGER_CSS.match(/\{/g) || []).length === (LEDGER_CSS.match(/\}/g) || []).length,
  "LEDGER_CSS braces balance");
const stranded = [...LEDGER_CSS.matchAll(/\}\s*([^\n{}]*)\/\*/g)].map((m) => m[1].trim()).filter(Boolean);
ok(stranded.length === 0,
  `no selector text stranded before a comment${stranded.length ? ` (found "${stranded[0].slice(0, 60)}")` : ""}`);

// --- the shell must not leak raw JavaScript into the page -------------------
// SHIPPED BROKEN once. Removing the theme IIFE with a regex ate its `<script>`
// OPENING tag and left the next function as bare text in <head>, followed by an
// orphaned `</script>`. Browsers hoist stray head text into the body, so a
// wall of JavaScript rendered at the top of every page - and a402ToggleMenu was
// never defined, which silently broke the mobile burger menu on every route.
// Neither the theme assertions nor the page tests noticed: the markup was still
// well-formed by div-balance standards and every route still returned 200.
// Case-insensitive on purpose. A tag counter that only sees lowercase would
// undercount `<SCRIPT>` openings and report a balance that isn't there, which
// is the exact failure this assertion exists to catch.
ok((html.match(/<script[\s>]/gi) || []).length === (html.match(/<\/script>/gi) || []).length,
  "script tags balance (an orphaned </script> means a stripped opening tag)");
const headOnly = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
ok(!/\n\s*function\s+\w+\s*\(/.test(headOnly),
  "no bare function declaration sitting outside a <script> in <head>");
ok(/<script>[^<]*function a402ToggleMenu/.test(html),
  "a402ToggleMenu is defined INSIDE a script element, so the burger menu works");
ok(html.includes('onclick="a402ToggleMenu()"'), "the burger button is still wired to it");

// --- the revenue chart palette had to follow the theme ----------------------
// Its dark series colours were keyed on [data-theme="dark"]. With the attribute
// gone that rule could never match, so the chart would have kept LIGHT series
// colours on a permanently dark page: still legible, easy to miss in review,
// and wrong.
const revenueSrc = readFileSync(new URL("../src/revenue-live.js", import.meta.url), "utf8");
ok(!revenueSrc.includes('[data-theme="dark"]'), "revenue chart has no dead [data-theme] rule");
ok(/\.rvz\{--s1:#3987e5/.test(revenueSrc), "the chart's dark series palette is the one that ships");

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
