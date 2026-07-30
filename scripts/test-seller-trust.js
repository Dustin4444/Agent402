#!/usr/bin/env node
// Offline unit tests for the seller-trust tool. No network: the crawler cache
// and settlement counts are injected.
//
// The invariants worth pinning are all HONESTY invariants — this tool reports on
// third parties, so every way it could overstate or understate evidence is a
// defect:
//   * an unknown origin is "no evidence", never a bad verdict
//   * advertised chains are never reported as proof of settlement
//   * the router gate reported here must match the router's real constants
//   * settled counts are a floor, and the caveats saying so must ship
//   * our own host is labelled self, not "untrustworthy"
//
//   node scripts/test-seller-trust.js
import { strict as assert } from "node:assert";
import { buildSellerTrustTool, assessSeller } from "../src/tools/seller-trust.js";

let passed = 0, failed = 0;
const check = (name, fn) => {
  try { fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`FAIL - ${name}\n      ${e.message}`); }
};

const PROVEN = {
  origin: "https://proven.example",
  displayName: "Proven Seller",
  homepage: "https://proven.example",
  toolCount: 3,
  fetchedAt: 1785000000000,
  error: null,
  health: 1,
  routable: true,
  tools: [
    { method: "POST", route: "/a", slug: "a", name: "A", price: 0.002, paid: true, networks: ["eip155:8453"] },
    { method: "POST", route: "/b", slug: "b", name: "B", price: 0.04, paid: true, networks: ["eip155:8453"] },
    { method: "GET", route: "/free", slug: "free", name: "Free", price: null, paid: false },
  ],
};
const SOLANA_ONLY = { ...PROVEN, origin: "https://svm.example", tools: [{ route: "/x", slug: "x", price: 0.002, paid: true, networks: ["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"] }] };
const PRICEY = { ...PROVEN, origin: "https://pricey.example", tools: [{ route: "/x", slug: "x", price: 0.5, paid: true, networks: ["eip155:8453"] }] };

const build = (details, settled, extra = {}) => buildSellerTrustTool({
  getSellerDetail: (host) => details.find((d) => d.origin.replace("https://", "") === host) || null,
  getSettledCalls: (origin) => settled[origin] || 0,
  sorThreshold: 50,
  sorCap: 0.005,
  settlementNetwork: "eip155:8453",
  ...extra,
});

// --- unknown origin: absence of evidence, never a bad verdict ----------------
check("an unindexed origin returns listed:false with a stated reason", () => {
  const t = build([], {});
  const r = t.handler({ origin: "nobody.example" });
  assert.equal(r.listed, false);
  assert.match(r.reason, /never crawled|no evidence/i, "must say we hold no evidence");
  assert.ok(r.howToList, "must tell an honest seller how to get listed");
  assert.ok(!("healthScore" in r), "must not invent a health score for an origin we never saw");
});

check("an unindexed origin is not described as untrustworthy", () => {
  const t = build([], {});
  const r = JSON.stringify(t.handler({ origin: "nobody.example" }));
  assert.ok(!/scam|fraud|untrust|unsafe|malicious/i.test(r), `verdict language leaked: ${r}`);
});

// --- the gate must mirror the router's real behaviour ------------------------
check("a proven in-cap Base seller is routable", () => {
  const t = build([PROVEN], { "https://proven.example": 120 });
  const r = t.handler({ origin: "proven.example" });
  assert.equal(r.routableByOurRouter, true, JSON.stringify(r.blockers));
  assert.equal(r.settledCallsObserved, 120);
  assert.deepEqual(r.blockers, []);
});

check("under the settlement threshold is refused, and says so numerically", () => {
  const t = build([PROVEN], { "https://proven.example": 49 });
  const r = t.handler({ origin: "proven.example" });
  assert.equal(r.routableByOurRouter, false);
  assert.equal(r.routerGate.meetsSettlementThreshold, false);
  assert.equal(r.routerGate.settlementThreshold, 50);
  assert.ok(r.blockers.some((b) => /50 settled/.test(b)), `expected a numeric blocker, got ${r.blockers}`);
});

check("advertising a chain is never treated as proof of settling on it", () => {
  const t = build([SOLANA_ONLY], { "https://svm.example": 5000 });
  const r = t.handler({ origin: "svm.example" });
  assert.equal(r.routableByOurRouter, false, "a Solana-only seller must not be Base-routable on advertised chains alone");
  assert.equal(r.routerGate.advertisesSettlementNetwork, false);
  assert.ok(r.caveats.some((c) => /not proof/i.test(c)), "the advertised-vs-settles caveat must ship");
});

check("a seller priced above the router cap is refused with the cap named", () => {
  const t = build([PRICEY], { "https://pricey.example": 999 });
  const r = t.handler({ origin: "pricey.example" });
  assert.equal(r.routerGate.hasToolWithinRouterCap, false);
  assert.equal(r.routerGate.routerUnderlyingCapUsd, 0.005);
  assert.equal(r.routerGate.cheapestPaidToolUsd, 0.5);
});

// --- counts are a floor, and the response must say so -----------------------
check("settled counts are labelled a floor, not a total", () => {
  const t = build([PROVEN], { "https://proven.example": 120 });
  const r = t.handler({ origin: "proven.example" });
  assert.ok(r.caveats.some((c) => /floor, not a total/i.test(c)), "the floor caveat must ship");
  assert.ok(r.caveats.some((c) => /no liveness probe/i.test(c)), "must disclose there is no call-time probe");
});

// --- free tools never inflate the paid picture ------------------------------
check("free resources are excluded from paid counts and price range", () => {
  const t = build([PROVEN], { "https://proven.example": 60 });
  const r = t.handler({ origin: "proven.example" });
  assert.equal(r.paidToolCount, 2, "the free resource must not count as paid");
  assert.deepEqual(r.priceRangeUsd, { min: 0.002, max: 0.04 });
});

// --- self ---------------------------------------------------------------------
check("our own host is labelled self rather than reading as a bad seller", () => {
  const t = build([{ ...PROVEN, origin: "https://agent402.tools" }], {}, { selfHost: "agent402.tools" });
  const r = t.handler({ origin: "agent402.tools" });
  assert.equal(r.self, true);
  assert.match(r.note, /never routes to itself/i);
  assert.ok(r.blockers.some((b) => /local catalog/.test(b)), "self blocker must explain, not accuse");
});

// --- input handling ----------------------------------------------------------
check("a full URL and a bare host resolve identically", () => {
  const t = build([PROVEN], { "https://proven.example": 60 });
  const a = t.handler({ origin: "https://proven.example/some/path" });
  const b = t.handler({ origin: "proven.example" });
  assert.equal(a.origin, b.origin);
  assert.equal(a.routableByOurRouter, b.routableByOurRouter);
});

check("missing or non-host input is a 400, never a guess", () => {
  const t = build([PROVEN], {});
  for (const bad of [undefined, "", "   ", "localhost", "not-a-host"]) {
    let code = null;
    try { t.handler({ origin: bad }); } catch (e) { code = e.statusCode; }
    assert.equal(code, 400, `expected 400 for ${JSON.stringify(bad)}`);
  }
});

check("the tool answers its own declared example", () => {
  const t = build([{ ...PROVEN, origin: "https://agent402.tools" }], {}, { selfHost: "agent402.tools" });
  const r = t.handler(t.discovery.example);
  assert.ok(r && typeof r === "object" && r.origin, "example input must produce a real answer");
});

// --- assessSeller purity -----------------------------------------------------
check("assessSeller is pure and tolerates a detail with no tools", () => {
  const a = assessSeller({ origin: "https://x.example", detail: { tools: [] }, settledCalls: 0, sorThreshold: 50, sorCap: 0.005, requireNetwork: "eip155:8453" });
  assert.deepEqual(a.advertisedNetworks, []);
  assert.equal(a.priceRangeUsd, null);
  assert.equal(a.routableByOurRouter, false);
});

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
