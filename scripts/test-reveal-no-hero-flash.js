// Locks in the "no hero flash" fix (2026-08-15): the shared reveal-on-scroll
// script must exempt the FIRST matched header/section from the opacity:0
// hide-then-observe cycle. That element is every page's hero and is always
// already in the initial viewport (verified live across 8 page templates -
// marketplace/tools/sell/leaderboard/skills/docs/status/home), so hiding it
// too meant it always had to wait on IntersectionObserver's first callback:
// measured 100-300ms of near-zero opacity on production even though the
// content was already fully in view - a real flash-of-blank-hero on every
// load, not a scroll-triggered effect at all. See the comment above the
// script in src/ledger-chrome.js for the full history and the deliberate
// choice to key off DOM order rather than a getBoundingClientRect check.
//
// Offline - reads the source directly, no server needed. CSP hardening
// (2026-08-16) moved this script from an inline ledgerShell <script> into
// assets/js/site-chrome.js.
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const src = readFileSync(new URL("../assets/js/site-chrome.js", import.meta.url), "utf8");
const scriptMatch = src.match(/document\.addEventListener\('DOMContentLoaded'[\s\S]*?\}catch\(e\)\{\}\}\);/);
ok(!!scriptMatch, "found the shared reveal-on-scroll DOMContentLoaded script block");
const script = scriptMatch ? scriptMatch[0] : "";

// The first matched element must never receive the .ml-reveal class - it
// must be excluded before the class is applied, not merely revealed faster
// by the observer.
ok(/els\.length\s*<\s*2/.test(script), "bails out entirely when there is only the hero to reveal (nothing left to observe)");
ok(/slice(\.call)?\(els\s*,\s*1\)/.test(script), "builds the observed set by slicing off the first (index 0) element");
ok(/rest\.forEach\(function\(el\)\{el\.classList\.add\('ml-reveal'\)/.test(script), "adds the hiding class only to the sliced 'rest' array, never to els[0] directly");
// Negative check: the pre-fix shape applied the hiding class to the FULL
// els array (including the hero). If this regex matches, the exemption
// regressed back out.
ok(!/els\.forEach\(function\(el\)\{el\.classList\.add\('ml-reveal'\)/.test(script), "does NOT apply the hiding class to the full els array (the pre-fix shape that caused the flash)");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
