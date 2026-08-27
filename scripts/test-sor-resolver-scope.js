#!/usr/bin/env node
// Source guard for resolveExternalSeller (src/server.js): the proven-payTo map
// must be declared at FUNCTION scope, before the per-chain branches. It was a
// `var` inside the Base branch, so the Tempo and Algorand legs read
// `undefined.get(...)` after their live probe, the surrounding catch marked
// every candidate not-live, and both external legs silently resolved nothing
// (the offline router tests inject the resolver, so they could not see it;
// the first live Tempo SOR buy did, 2026-08-27).
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const start = src.indexOf("async function resolveExternalSeller(");
ok(start > 0, "resolveExternalSeller is present");
// The function body ends at the next top-level declaration (its own closing
// brace is not the first "\n}\n" after the start: nested blocks close first).
const nextTop = src.slice(start + 1).search(/\n(?:async function|function|const|let|app\.|export) /);
const fn = src.slice(start, nextTop > 0 ? start + 1 + nextTop : start + 20000);
const decl = fn.indexOf("let provenPayToByOrigin = new Map()");
const branch = fn.indexOf('if (chain === "tempo")');
ok(decl > 0 && branch > 0 && decl < branch, "provenPayToByOrigin is declared at function scope BEFORE the chain branches");
ok(!/var provenPayToByOrigin/.test(fn), "no `var provenPayToByOrigin` inside a branch (the hoisted-undefined shape)");
ok(/provenPayToByOrigin = buildProvenPayToByOrigin\(\)/.test(fn), "the Base branch still assigns the proven-payTo evidence");
ok((fn.match(/provenPayToByOrigin[?.]+get\(/g) || []).length >= 1, "the post-probe check still reads the map (so an undefined map would have been fatal on the non-Base legs)");
ok(/if \(live\) return \{[^\n]*wire: r\.wire/.test(fn), "the resolved candidate carries its wire (a Tempo seller settles over MPP; the receipt said x402 before)");
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
