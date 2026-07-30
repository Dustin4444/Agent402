#!/usr/bin/env node
// Leak gate for every PUBLIC JSON surface. Requires a booted server:
//   FREE_MODE=true PORT=3000 node src/server.js
//   TARGET_URL=http://localhost:3000 node scripts/test-public-surface-leak.js
//
// WHY: we had a written doctrine - buyer identity is COUNTS ONLY, never
// addresses; per-tool revenue belongs to the paid tool and the operator - and
// nothing enforced it. So the same leak shipped on four separate routes and was
// found one at a time: /api/sales served a ranked customer list with full wallet
// addresses and per-buyer spend, /api/revenue embedded the same, /api/revenue/mpp
// carried a payer per settlement, and /api/stats published per-tool revenue.
// Each fix was an instance; the doctrine was never a test. This is the test.
//
// It sweeps the public surfaces and asserts on the SERIALIZED payload, because a
// nested field slips past a key check. Deliberately narrow so it stays honest:
// it only fails on things we have actually decided must not be public.
//
// If a new public endpoint should be allowed to carry an address (none does
// today), add it to ADDRESS_ALLOWED with the reason - do not weaken the check.
const TARGET = (process.env.TARGET_URL || "http://localhost:3000").replace(/\/+$/, "");

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`ok - ${msg}`); }
  else { failed++; console.error(`FAIL - ${msg}`); }
};

// Public JSON surfaces that describe money, demand, or traffic - the ones where
// a leak would matter. Catalog/discovery surfaces are covered elsewhere.
const SURFACES = [
  "/api/sales",
  "/api/stats",
  "/api/revenue/daily",
  "/api/revenue/mpp",
  "/api/calls/daily",
  "/api/wishes",
  "/api/reliability",
  "/api/status",
  "/api/gateway-status",
  "/api/analytics",
];

// Surfaces where an address is legitimate and intended. Our own payTo is a
// published fact (buyers need it to pay us); a BUYER's address never is.
const ADDRESS_ALLOWED = new Map([
  // /api/revenue publishes our own per-rail treasury payTo addresses on purpose,
  // and the leaderboard is other sellers' public payTo addresses - the product.
  ["/api/revenue", "our own payTo per rail, deliberately published"],
  ["/api/leaderboard", "other sellers' public payTo - the index product itself"],
]);

const OUR_WALLET = (process.env.WALLET_ADDRESS || "").toLowerCase();

for (const path of SURFACES) {
  let res, body;
  try {
    res = await fetch(`${TARGET}${path}`);
    body = await res.text();
  } catch (e) {
    ok(false, `${path} is reachable (${String(e?.message || e).slice(0, 60)})`);
    continue;
  }
  if (res.status >= 400) { ok(true, `${path} -> ${res.status} (not public, nothing to leak)`); continue; }

  // Say so when a surface has no rows. On a fresh database these feeds are
  // empty, so the value checks below would pass without checking anything - and
  // a vacuous pass reported as a pass is how a gate stops protecting you. The
  // seeded, deterministic version of this assertion lives in
  // scripts/test-sales-ledger.js, which is the guard that actually holds.
  const rowish = (() => {
    try {
      const j = JSON.parse(body);
      const arrays = Object.values(j).filter(Array.isArray);
      return arrays.length ? arrays.reduce((n, a) => n + a.length, 0) : null;
    } catch { return null; }
  })();
  if (rowish === 0) console.log(`  note: ${path} has no rows right now - value checks below are vacuous (see test-sales-ledger.js)`);

  // 1. No buyer wallet addresses, in any shape.
  const evm = [...body.matchAll(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g)].map((m) => m[0]);
  const foreign = evm.filter((a) => a.toLowerCase() !== OUR_WALLET);
  if (ADDRESS_ALLOWED.has(path)) {
    ok(true, `${path} may carry addresses (${ADDRESS_ALLOWED.get(path)})`);
  } else {
    ok(foreign.length === 0, `${path} carries no EVM address${foreign.length ? ` (found ${foreign.length}, e.g. ${foreign[0]})` : ""}`);
    // base58 / Stellar shapes, long enough to be an account rather than a word.
    const b58 = [...body.matchAll(/"[1-9A-HJ-NP-Za-km-z]{32,44}"/g)].map((m) => m[0]);
    const stellar = [...body.matchAll(/G[A-Z2-7]{55}/g)].map((m) => m[0]);
    ok(b58.length + stellar.length === 0, `${path} carries no base58/Stellar account${b58.length + stellar.length ? ` (found ${b58.length + stellar.length})` : ""}`);
  }

  // 2. No PER-TOOL revenue. Purchase counts are fine; money per tool is what the
  //    paid bestsellers tool sells and what the operator endpoint reports.
  let json = null;
  try { json = JSON.parse(body); } catch { /* not JSON, the text checks stand */ }
  if (json) {
    const perToolRevenue = [];
    const walk = (node, trail) => {
      if (Array.isArray(node)) return node.forEach((n) => walk(n, trail));
      if (!node || typeof node !== "object") return;
      const keys = Object.keys(node);
      const namesTool = keys.some((k) => /^(slug|tool|name)$/i.test(k));
      const hasMoney = keys.some((k) => /revenue|usd|earned/i.test(k));
      if (namesTool && hasMoney) perToolRevenue.push(`${trail}{${keys.join(",")}}`);
      for (const k of keys) walk(node[k], `${trail}${k}.`);
    };
    walk(json, "");
    ok(perToolRevenue.length === 0,
      `${path} pairs no tool name with a revenue figure${perToolRevenue.length ? ` (${perToolRevenue.slice(0, 2).join(" ")})` : ""}`);
  }
}

// 3. The itemized feeds must stay operator-gated, and say nothing without a token.
for (const path of ["/__operator/sales.json", "/__operator/wishes.json", "/__operator/stats"]) {
  const res = await fetch(`${TARGET}${path}`);
  ok(res.status === 404, `${path} is 404 without an operator token (got ${res.status}) - not 401, which would confirm it exists`);
}

// 4. No served surface may leak an un-interpolated template placeholder. A
//    quoted string where a template literal was intended shipped a literal
//    "${RAILS_OR}" in the OpenAPI description to every crawler.
for (const path of ["/openapi.json", "/llms.txt", "/api/pricing", "/.well-known/x402"]) {
  const body = await (await fetch(`${TARGET}${path}`)).text();
  const hits = [...body.matchAll(/\$\{[A-Za-z_]/g)].length;
  ok(hits === 0, `${path} contains no un-interpolated \${...} placeholder${hits ? ` (${hits} found)` : ""}`);
}

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
