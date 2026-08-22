// Theme contract — offline unit tests. No network.
//
// 2026-08-22: TWO themes, dark is the DEFAULT. The dark palette sits directly
// on bare :root (first paint is already dark, no script needed, no flash); the
// light "milled" palette is an override block under :root[data-theme="light"],
// applied by /js/site-chrome.js (synchronous in <head>, reads the stored
// preference BEFORE body paints) and flipped by the .ml-theme-toggle button.
// No OS media query decides the theme, no inline script, no inline onclick.
//
// These assertions exist because a HALF-done theme is worse than either state:
// a light token that lives only in the override, a toggle without the pre-paint
// read (flash), or a page class with a hardcoded hex that only works in one
// theme should fail here rather than ship a page that is dark in some places
// and white in others.
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

// --- the bare :root palette IS the dark (default) palette ---------------------
const rootStart = LEDGER_CSS.indexOf(":root {");
const rootBlock = LEDGER_CSS.slice(rootStart, LEDGER_CSS.indexOf("\n}", rootStart));
const lightStart = LEDGER_CSS.indexOf(':root[data-theme="light"] {');
const lightBlock = lightStart >= 0 ? LEDGER_CSS.slice(lightStart, LEDGER_CSS.indexOf("\n}", lightStart)) : "";
const tokIn = (block, name) => (block.match(new RegExp(`${name}:\\s*([^;]+);`)) || [])[1]?.trim() || "";
const tok = (name) => tokIn(rootBlock, name);
const ltok = (name) => tokIn(lightBlock, name);
const isDark = (h) => /^#[0-3]/.test(h);      // #0B0C0E, #141619, #24282C…
const isLight = (h) => /^#[C-Fc-f]/.test(h);  // #F3F4F5, #FFFFFF, #E9EAEC…

ok(isDark(tok("--paper")), `default page background is dark (--paper ${tok("--paper")})`);
ok(isLight(tok("--ink")), `default foreground is light (--ink ${tok("--ink")})`);
ok(isDark(tok("--card")), `default cards are dark (--card ${tok("--card")})`);
ok(isLight(tok("--on-dark")), `text on obsidian surfaces stays light in both themes (--on-dark ${tok("--on-dark")})`);
ok(/:root \{ color-scheme: dark; \}/.test(LEDGER_CSS), "bare :root declares color-scheme: dark (form controls + scrollbars match the default)");

// --- the light theme is a complete override, not a partial one -----------------
ok(lightBlock.length > 0, "a :root[data-theme=\"light\"] override block exists");
ok(isLight(ltok("--paper")) && isDark(ltok("--ink")) && isLight(ltok("--card")), `light override flips paper/ink/card (${ltok("--paper")} / ${ltok("--ink")} / ${ltok("--card")})`);
ok(/color-scheme:\s*light/.test(lightBlock), "light override sets color-scheme: light");
const rootNames = [...rootBlock.matchAll(/--([a-z0-9-]+):/g)].map((m) => m[1]).filter((n) => !n.startsWith("font-"));
const lightNames = new Set([...lightBlock.matchAll(/--([a-z0-9-]+):/g)].map((m) => m[1]));
const missing = rootNames.filter((n) => !lightNames.has(n));
ok(missing.length === 0, `every default token has a light counterpart${missing.length ? ` - MISSING: ${missing.map((n) => "--" + n).join(", ")}` : ""}`);
ok(!/prefers-color-scheme/.test(LEDGER_CSS) && !html.includes("prefers-color-scheme"), "no OS preference media query decides the palette (dark is the default, the user flips it)");

// --- theme-specific surfaces go through tokens, never hardcoded hex -------------
for (const name of ["--btn-bg", "--btn-fg", "--nav-bg", "--brand-mark", "--milled-bg", "--obsidian-bg", "--chip-bg", "--card-inset", "--on-accent"]) {
  ok(tok(name) && ltok(name), `${name} is defined in BOTH themes (surfaces that differ per theme ride tokens)`);
}

// --- the toggle: present, CSP-clean, no flash --------------------------------
ok(html.includes('class="ml-theme-toggle"'), "the theme toggle button is in the nav");
ok(html.includes("ml-moon") && html.includes("ml-sun"), "moon + sun glyphs ship (CSS shows one per theme)");
ok(!/\bonclick\s*=/.test(html), "no inline onclick attribute anywhere - CSP-blocked, must be wired via addEventListener");
ok(!/<script>[^<]*localStorage/.test(html) && !/<script>[\s\S]{0,400}data-theme/.test(html), "no inline pre-paint theme script in the page (CSP); the external site-chrome.js does it");
ok(!/<html[^>]*data-theme/.test(html) && !/<body[^>]*data-theme/.test(html), "the server never stamps data-theme on the document (the default is the bare :root; only the client's stored preference sets light)");
const siteChromeJs = readFileSync(new URL("../assets/js/site-chrome.js", import.meta.url), "utf8");
const headOnly = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
ok(headOnly.includes('<script src="/js/site-chrome.js">'), "site-chrome.js is referenced in <head> (synchronous) so the stored theme applies before first paint");
ok(/localStorage\.getItem\('a402-theme'\)/.test(siteChromeJs.slice(0, 1200)) && /setAttribute\('data-theme','light'\)/.test(siteChromeJs.slice(0, 1200)), "site-chrome.js applies a stored light preference at the very top (pre-paint)");
ok(/\.ml-theme-toggle/.test(siteChromeJs) && /localStorage\.setItem\('a402-theme'/.test(siteChromeJs) && siteChromeJs.includes("addEventListener('click'"), "site-chrome.js wires the toggle via addEventListener and stores the choice");
ok(!html.includes("a402ToggleTheme"), "no global toggle function is referenced from markup");

// --- CSS hygiene (historical incidents) ----------------------------------------
ok((LEDGER_CSS.match(/\{/g) || []).length === (LEDGER_CSS.match(/\}/g) || []).length, "LEDGER_CSS braces balance");
const stranded = [...LEDGER_CSS.matchAll(/\}\s*([^\n{}]*)\/\*/g)].map((m) => m[1].trim()).filter(Boolean);
ok(stranded.length === 0, `no selector text stranded before a comment${stranded.length ? ` (found "${stranded[0].slice(0, 60)}")` : ""}`);
ok(!/\n\s*\/\/[^\n]*\n[^}]*\}/.test(rootBlock), "no // comment inside the :root block (it would kill every token after it)");
ok((html.match(/<script[\s>]/gi) || []).length === (html.match(/<\/script>/gi) || []).length, "script tags balance (an orphaned </script> means a stripped opening tag)");
ok(!/\n\s*function\s+\w+\s*\(/.test(headOnly), "no bare function declaration sitting outside a <script> in <head>");
ok(/function\s+toggleMenu\s*\(/.test(siteChromeJs) && siteChromeJs.includes(".ml-burger"), "site-chrome.js still defines the burger menu toggle");

// --- the revenue chart palette follows the theme ---------------------------------
const revenueSrc = readFileSync(new URL("../src/revenue-live.js", import.meta.url), "utf8");
ok(/\.rvz\{--s1:#3987e5/.test(revenueSrc), "the chart's dark series palette is the one that ships by default");

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
