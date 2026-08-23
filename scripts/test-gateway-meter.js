// The metered-settlement pricing rule.
import { meteredUsd, METER_MARKUP, METER_FLOOR_USD, isMeterable } from "../src/gateway-meter.js";

let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error("FAIL:", m); process.exit(1); } };

// The measured reality this exists to fix: v1-chat charges $0.02 against
// $0.0001 of real spend, i.e. 170x. Metered, the same call bills the floor.
const chat = meteredUsd({ upstreamUsd: 0.0001, ceilingUsd: 0.02 });
ok(chat === METER_FLOOR_USD, `a typical v1-chat call ($0.0001 upstream) bills $${chat} instead of the $0.02 flat price`);
ok(chat < 0.02 / 20, "which is more than 20x cheaper for the buyer than the flat tier");

// A real, large call bills its cost plus the markup, still under the ceiling.
const big = meteredUsd({ upstreamUsd: 0.012, ceilingUsd: 0.02 });
ok(Math.abs(big - 0.0156) < 1e-9, `a large call ($0.012 upstream) bills $${big}, cost plus ${Math.round((METER_MARKUP - 1) * 100)}%`);
ok(big < 0.02, "and still lands under the ceiling the buyer authorized");

// THE INVARIANT THAT MAKES THE CAP UNREACHABLE: the margin clamp already holds
// upstream at or under 70% of the tier price, so metered <= 0.91 x ceiling.
for (const ceiling of [0.003, 0.01, 0.02, 0.10, 0.50]) {
  const worst = meteredUsd({ upstreamUsd: ceiling * 0.7, ceilingUsd: ceiling });
  ok(worst < ceiling, `at the margin clamp's own bound (70% of $${ceiling}), the metered amount $${worst} is still under the ceiling, so the cap never binds`);
}

// It must still be capped, because "should never bind" is not a reason to omit
// a check on something that moves money.
const over = meteredUsd({ upstreamUsd: 5, ceilingUsd: 0.02 });
ok(over === 0.02, "an upstream cost beyond the ceiling settles AT the ceiling, never above what the buyer authorized");

// An unknown cost must never become a cheap settle.
// null is the one that mattered: Number(null) is 0, so a coercion-based guard
// reads a MISSING cost as a free call and bills the floor.
for (const [label, bad] of [["null", null], ["undefined", undefined], ["NaN", NaN], ["a string", "abc"], ["negative", -1], ["a numeric string", "0.001"]]) {
  ok(meteredUsd({ upstreamUsd: bad, ceilingUsd: 0.02 }) === null,
    `an unreported/invalid upstream cost (${label}) returns null so the caller keeps the ceiling, rather than silently underbilling`);
}
for (const bad of [0, -1, null, NaN]) {
  ok(meteredUsd({ upstreamUsd: 0.001, ceilingUsd: bad }) === null, `a missing ceiling (${JSON.stringify(bad)}) is not meterable`);
}

// A free call still bills the floor: a request costs us something before any
// model runs, and a $0 settle is not a payment.
ok(meteredUsd({ upstreamUsd: 0, ceilingUsd: 0.02 }) === METER_FLOOR_USD, "a zero-cost call still bills the floor, never $0");

// Rounding favours the seller, so a rounding error can never underbill.
const r = meteredUsd({ upstreamUsd: 0.0010001, ceilingUsd: 0.02 });
ok(r >= 0.0010001 * METER_MARKUP && Number.isInteger(Math.round(r * 1e6)),
  `settles in whole atomic units, rounded UP ($${r}), so rounding can only favour the seller`);

// Only an `upto` payment may be metered.
ok(isMeterable({ x402: { scheme: "upto" } }) === true, "an upto payment is meterable");
ok(isMeterable({ x402: { scheme: "exact" } }) === false, "an EXACT payment is never metered: that scheme fixed the amount at the 402 and cannot express a lower settle");
ok(isMeterable({}) === false && isMeterable(null) === false, "no scheme means no metering");

console.log(`\n${pass} passed, 0 failed`);
