#!/usr/bin/env node
// What does this process ACTUALLY talk to, and which of it costs money?
//
//   node scripts/egress-census.js                 # local (most vendors blind)
//   railway run node scripts/egress-census.js     # the run that counts
//
// WHY THIS EXISTS: three separate cost leaks were found by an invoice rather
// than by us - Alchemy (crawlers holding a 60s cache warm), Brave (CI's own
// sweep), CDP SQL (a public page billing per seller wallet). After each one we
// added a guard for THAT vendor, from a list of vendors we could remember.
//
// A list cannot find what you have not thought of. This measures instead: it
// records every host the process contacts, attributes it to the source file
// that called, and separates crawl targets from vendors.
//
// THE PART THAT MATTERS MOST: a vendor whose API key is unset is UNREACHABLE,
// so a census run without prod's environment cannot see it and must never
// report a clean bill of health. This script prints what it was blind to, and
// exits non-zero if it was blind to anything - because "we found nothing" and
// "we could not look" are the same output otherwise, and that confusion is
// exactly how the last three leaks survived.
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Vendors that bill per request, and the env var that makes them reachable.
const METERED = [
  ["api.search.brave.com", "BRAVE_API_KEY", "Brave Search"],
  ["api.cdp.coinbase.com", "CDP_API_KEY_ID", "Coinbase CDP (SQL + x402)"],
  ["api.openai.com", "OPENAI_API_KEY", "OpenAI"],
  ["openrouter.ai", "OPENROUTER_API_KEY", "OpenRouter"],
  ["e2b.dev", "E2B_API_KEY", "E2B sandboxes"],
  ["api.neynar.com", "NEYNAR_API_KEY", "Neynar"],
  ["g.alchemy.com", "ALCHEMY_API_KEY", "Alchemy RPC"],
  ["blockscout.com", "X402_UPSTREAM_BUYER_KEY", "Blockscout Pro"],
];

const LOG = join(tmpdir(), `egress-census-${process.pid}.log`);
const PRELOAD = join(tmpdir(), `egress-preload-${process.pid}.cjs`);
writeFileSync(PRELOAD, `
const fs = require("fs");
const OUT = ${JSON.stringify(LOG)};
const note = (host, stack) => { try {
  const f = (stack||"").split("\\n").slice(2,8).map(s=>(s.match(/\\/src\\/([^\\s:)]+)/)||[])[1]).filter(Boolean)[0];
  fs.appendFileSync(OUT, host + "\\t" + (f||"?") + "\\n");
} catch {} };
const of = globalThis.fetch;
globalThis.fetch = function (i) {
  let h=""; try { const u = typeof i==="string" ? new URL(i) : (i instanceof URL ? i : new URL(i.url)); h=u.host; } catch {}
  if (h) note(h, new Error().stack);
  return of.apply(this, arguments);
};
for (const m of ["http","https"]) {
  const mod = require("node:"+m), orig = mod.request;
  mod.request = function (...a) {
    try { const x=a[0]; const h = typeof x==="string" ? new URL(x).host : (x && (x.host||x.hostname)); if (h) note(String(h), new Error().stack); } catch {}
    return orig.apply(this, a);
  };
}
`);
writeFileSync(LOG, "");

const PORT = process.env.CENSUS_PORT || "4399";
const SURFACES = [
  "/", "/marketplace", "/revenue", "/base", "/solana", "/status", "/index", "/sell",
  "/leaderboard", "/api/stats", "/api/leaderboard", "/api/x402-economy", "/api/index",
  "/api/reliability", "/api/rails", "/openapi.json", "/llms.txt", "/.well-known/x402",
];

const blind = METERED.filter(([, env]) => !process.env[env]);
console.log(`egress census — port ${PORT}\n`);

const child = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, PORT, FREE_MODE: "true", X402_SYNC_ON_START: "false", NODE_OPTIONS: `--require ${PRELOAD}` },
  stdio: "ignore",
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try { await fetch(`http://localhost:${PORT}/health`); up = true; } catch { await wait(1000); }
}
if (!up) { child.kill("SIGKILL"); console.error("server never came up"); process.exit(1); }

for (const s of SURFACES) { try { await fetch(`http://localhost:${PORT}${s}`); } catch {} }
const settle = Number(process.env.CENSUS_SETTLE_MS || 60_000);
console.log(`exercised ${SURFACES.length} public surfaces; waiting ${settle / 1000}s for background timers…\n`);
await wait(settle);
child.kill("SIGKILL");

const rows = readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split("\t"));
const byHost = new Map();
for (const [h, f] of rows) {
  if (!byHost.has(h)) byHost.set(h, { n: 0, files: new Set() });
  const e = byHost.get(h); e.n++; e.files.add(f);
}
const hits = METERED
  .map(([host, env, name]) => {
    const matched = [...byHost.entries()].filter(([h]) => h.includes(host));
    const n = matched.reduce((a, [, v]) => a + v.n, 0);
    const files = new Set(matched.flatMap(([, v]) => [...v.files]));
    return { host, env, name, n, files: [...files], observable: Boolean(process.env[env]) };
  })
  .filter((x) => x.n > 0 || x.observable);

console.log(`hosts contacted: ${byHost.size}`);
console.log(`\nMETERED vendors reached from a NON-TOOL path (page / crawler / background):`);
let unattached = 0;
for (const h of hits) {
  const nonTool = h.files.filter((f) => f && !f.startsWith("tools/"));
  if (h.n && nonTool.length) { unattached++; console.log(`  ${h.name}: ${h.n} call(s) <- ${nonTool.join(", ")}`); }
}
if (!unattached) console.log("  (none observed in this run)");

console.log(`\nBLIND SPOTS — vendors this run could NOT observe because their key is unset:`);
if (!blind.length) console.log("  (none — every metered vendor was reachable)");
for (const [host, env, name] of blind) console.log(`  ${name.padEnd(26)} ${env} unset  → ${host} unreachable`);

try { unlinkSync(PRELOAD); } catch {}
console.log("");
if (blind.length) {
  console.log(`INCOMPLETE: ${blind.length} of ${METERED.length} metered vendors were unobservable.`);
  console.log("Re-run with the production environment before treating this as a clean bill of health.");
  process.exit(2);
}
console.log(`COMPLETE: all ${METERED.length} metered vendors were observable; ${unattached} reached from a non-tool path.`);
process.exit(unattached ? 1 : 0);
