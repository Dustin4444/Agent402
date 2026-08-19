#!/usr/bin/env node
// Offline test for classifyCanaryFailure — the gate that decides whether a
// failed paid-canary run is a real settlement outage or the canary's own
// empty wallet.
//
// Both wrong answers are costly in opposite directions: calling a real outage
// "underfunded" silences the one alarm for buying being broken, and calling an
// empty wallet "broken" puts OUTAGE on the public status page while buyers are
// settling fine (which is exactly what happened 2026-07-27). So every arm of
// the gate is pinned, and every ambiguous case must resolve to "broken" — the
// scary answer is the safe answer.
import { strict as assert } from "node:assert";
import { classifyCanaryFailure } from "./paid-canary.js";

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

const rows = (specs) => specs.map(([cls, priceUsd]) => ({ cls, priceUsd }));
const dec = (specs, broken = true) => ({
  broken,
  rows: rows(specs),
  settled: specs.filter(([c]) => c === "settled").length,
  reasons: [],
});

console.log("canary underfunded classification");

check("the 2026-07-27 incident shape classifies as underfunded", () => {
  // 3 settled, the rest clean 402s, balance $0.0000 < cheapest failed ($0.003)
  const d = dec([["settled", 0.001], ["settled", 0.005], ["settled", 0.004],
    ["unsettled", 0.003], ["unsettled", 0.005], ["unsettled", 0.02]]);
  assert.equal(classifyCanaryFailure(d, { balanceUsd: 0 }), "underfunded");
});

check("a non-broken decision is just ok", () => {
  assert.equal(classifyCanaryFailure(dec([["settled", 0.001]], false), { balanceUsd: 0 }), "ok");
});

check("any 5xx/unreachable leg keeps it broken — that is not what empty wallets look like", () => {
  const d = dec([["settled", 0.001], ["unsettled", 0.003], ["unreachable", 0.005]]);
  assert.equal(classifyCanaryFailure(d, { balanceUsd: 0 }), "broken");
});

check("zero settlements keeps it broken — no proof the path works at all", () => {
  const d = dec([["unsettled", 0.003], ["unsettled", 0.005]]);
  assert.equal(classifyCanaryFailure(d, { balanceUsd: 0 }), "broken");
});

check("balance above the cheapest failed leg keeps it broken — funds were there", () => {
  const d = dec([["settled", 0.001], ["unsettled", 0.003], ["unsettled", 0.005]]);
  assert.equal(classifyCanaryFailure(d, { balanceUsd: 0.5 }), "broken");
});

check("balance between cheapest and priciest failed legs still reads underfunded", () => {
  // $0.004 in the wallet: can't afford the $0.005 leg. cheapest failed is
  // 0.005 here so 0.004 < 0.005 -> underfunded.
  const d = dec([["settled", 0.001], ["unsettled", 0.005], ["unsettled", 0.02]]);
  assert.equal(classifyCanaryFailure(d, { balanceUsd: 0.004 }), "underfunded");
});

check("an unreadable balance keeps it broken — never classify on missing evidence", () => {
  const d = dec([["settled", 0.001], ["unsettled", 0.003]]);
  assert.equal(classifyCanaryFailure(d, { balanceUsd: null }), "broken");
  assert.equal(classifyCanaryFailure(d, {}), "broken");
  assert.equal(classifyCanaryFailure(d, { balanceUsd: NaN }), "broken");
});

check("unpriced failed legs: only a truly empty wallet proves underfunding", () => {
  const d = dec([["settled", 0.001], ["unsettled", undefined]]);
  // Below the platform minimum ($0.001) nothing is affordable — provable.
  assert.equal(classifyCanaryFailure(d, { balanceUsd: 0 }), "underfunded");
  // With money present and no known prices there is NO arithmetic proof, and
  // balance < Infinity must not silently pass. Scary answer is the safe one.
  assert.equal(classifyCanaryFailure(d, { balanceUsd: 5 }), "broken");
});


// ---- chain low-water sweep verdict (2026-07-28 extension) ----
// Chain legs WARN and never page, so a starved chain wallet degrades
// silently; the sweep pages ok-low while the rail proof still works. An
// unreadable balance (RPC outage) is reported but never counted as low.
const { chainLowWaterReport } = await import("./paid-canary.js");
check("chain sweep: only the genuinely low chain is flagged", () => {
  const r = chainLowWaterReport(
    [
      { key: "sei", label: "Sei", usd: 2.9 },
      { key: "optimism", label: "Optimism", usd: 0.011 },
      { key: "monad", label: "Monad", usd: null },
      { key: "celo", label: "Celo", usd: 0.05 },
    ],
    { chainLowWater: 0.05 },
  );
  assert.equal(r.low.length, 1);
  assert.equal(r.low[0].key, "optimism");
});
check("chain sweep: an unreadable balance is reported, never low", () => {
  const r = chainLowWaterReport([{ key: "monad", label: "Monad", usd: null }], { chainLowWater: 0.05 });
  assert.deepEqual(r.unreadable, ["monad"]);
  assert.equal(r.low.length, 0);
});
check("chain sweep: a per-chain lowWater override pages Tempo at $0.40 while Monad at $0.40 is fine (100 buys/day runway)", () => {
  const r = chainLowWaterReport([
    { key: "tempo-pathusd", label: "Tempo (PathUSD)", usd: 0.4, lowWater: 0.5 },
    { key: "monad", label: "Monad", usd: 0.4 },
  ], { chainLowWater: 0.05 });
  assert.equal(r.low.length, 1);
  assert.equal(r.low[0].key, "tempo-pathusd");
  assert.equal(r.low[0].lowWater, 0.5);
});
check("chain sweep: a balance exactly at the threshold is not low", () => {
  const r = chainLowWaterReport([{ key: "celo", label: "Celo", usd: 0.05 }], { chainLowWater: 0.05 });
  assert.equal(r.low.length, 0);
});
check("chain sweep: empty input is empty output, not a crash", () => {
  const r = chainLowWaterReport([], { chainLowWater: 0.05 });
  assert.equal(r.low.length + r.unreadable.length, 0);
});

console.log(failures ? `\nFAILED (${failures})` : "\nall passed");
process.exit(failures ? 1 : 0);
