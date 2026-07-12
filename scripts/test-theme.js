// Dark-theme toggle — offline unit tests. No network. Verifies the shared
// shell ships the pre-paint theme script (no flash of the wrong theme), the
// moon/sun toggle button, and the dark-mode CSS overrides, and that the
// palette flip is internally consistent (--ink and --cream flip together so
// the ~100 solid-ink chips invert cleanly).
//
//   node scripts/test-theme.js
import { ledgerShell, LEDGER_CSS } from "../src/ledger-chrome.js";

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`ok - ${msg}`); }
  else { failed++; console.error(`FAIL - ${msg}`); }
};

const html = ledgerShell({
  title: "t", description: "d", canonical: "https://agent402.tools/x",
  baseUrl: "https://agent402.tools", body: "<main>hi</main>",
});

// --- no-flash: theme is applied from storage/prefers BEFORE first paint -------
const headStart = html.slice(0, html.indexOf("</head>"));
ok(headStart.includes("localStorage.getItem('a402-theme')"), "pre-paint script reads the saved theme");
ok(headStart.includes("prefers-color-scheme:dark"), "falls back to the OS preference");
ok(headStart.includes("setAttribute('data-theme','dark')"), "sets data-theme before paint");
// the setter script must be in <head> too, so the button's onclick resolves
ok(headStart.includes("function a402ToggleTheme"), "toggle function defined in head");
ok(html.indexOf("function a402ToggleTheme") < html.indexOf("</head>"), "toggle fn is above the body");

// --- the moon/sun control lives in the nav -----------------------------------
ok(html.includes('class="ml-theme-toggle"'), "nav has the theme toggle button");
ok(html.includes('onclick="a402ToggleTheme()"'), "button is wired to the toggle");
ok(html.includes('class="ml-moon"') && html.includes('class="ml-sun"'), "both moon + sun glyphs present");
ok(/aria-label="Toggle dark mode"/.test(html), "toggle is labelled for a11y");

// --- dark palette exists and flips the paired tokens together ----------------
ok(LEDGER_CSS.includes(':root[data-theme="dark"]'), "dark-theme CSS block present");
// --ink (foreground) goes light AND --cream (text on ink chips) goes dark, so
// every `background:var(--ink);color:var(--cream)` chip becomes light-on-dark.
const dark = LEDGER_CSS.slice(LEDGER_CSS.indexOf(':root[data-theme="dark"]'));
const darkBlock = dark.slice(0, dark.indexOf("}"));
ok(/--ink:\s*#[EeFf]/.test(darkBlock), "dark --ink is light");
ok(/--cream:\s*#0/.test(darkBlock), "dark --cream is dark (chips invert cleanly)");
ok(/--paper:\s*#0/.test(darkBlock), "dark --paper is dark");
// the moon hides in dark, the sun hides in light (CSS-only, no JS needed)
ok(LEDGER_CSS.includes('.ml-theme-toggle .ml-sun'), "sun hidden by default (light)");
ok(LEDGER_CSS.includes(':root[data-theme="dark"] .ml-theme-toggle .ml-moon'), "moon hidden in dark");

// light mode stays the default: no data-theme attribute is hardcoded on <html>
ok(!/<html[^>]*data-theme=/.test(html), "html has no hardcoded theme (light is the default)");

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
