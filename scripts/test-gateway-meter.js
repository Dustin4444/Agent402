// The metered-settlement pricing rule.
import { meteredUsd, METER_MARKUP, METER_FLOOR_USD, isMeterable } from "../src/gateway-meter.js";

let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error("FAIL:", m); process.exit(1); } };

// The measured reality this exists to fix: v1-chat charges $0.02 against
// $0.0001 of real spend, i.e. 170x. Metered, the same call bills the floor.
const chat = meteredUsd({ upstreamUsd: 0.0001, ceilingUsd: 0.02 });
ok(chat === METER_FLOOR_USD, `a typical v1-chat call ($0.0001 upstream) bills $${chat} instead of the $0.02 flat price`);
ok(chat < 0.02 / 20, "which is more than 20x cheaper for the buyer than the flat tier");

// The FLOOR dominates small calls, and that is worth stating rather than
// hiding: below about $0.00017 of model spend the bill is the fixed per-request
// component, not the markup. So a tiny call is still several times what a
// direct API caller pays - just in absolute terms a fifth of a thousandth of a
// dollar. Any claim of "cheaper than calling the API yourself" is false and
// this is the arithmetic that makes it false.
const breakeven = METER_FLOOR_USD / METER_MARKUP;
ok(meteredUsd({ upstreamUsd: breakeven * 0.5, ceilingUsd: 0.02 }) === METER_FLOOR_USD,
  `below the $${breakeven.toFixed(6)} breakeven the bill is the flat floor, not the markup`);
ok(meteredUsd({ upstreamUsd: breakeven * 2, ceilingUsd: 0.02 }) > METER_FLOOR_USD,
  "above it the markup governs");

// A real, large call bills its cost plus the markup, still under the ceiling.
const big = meteredUsd({ upstreamUsd: 0.012, ceilingUsd: 0.02 });
ok(Math.abs(big - 0.012 * METER_MARKUP) < 1e-6, `a large call ($0.012 upstream) bills $${big}, cost plus ${Math.round((METER_MARKUP - 1) * 100)}%`);
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
//
// These build a REQUEST, not a scheme. The previous version passed
// `{ x402: { scheme: "upto" } }` - a shape nothing ever produces - so it proved
// the comparison while the derivation was missing entirely, and the metered path
// was dead in production with both tests green. The input here is what an
// express request actually carries: a base64 payment header, read through the
// same `header()` accessor the middleware uses.
const reqWith = (headers) => ({ header: (n) => headers[String(n).toLowerCase()] ?? undefined });
const paymentHeader = (payload) => Buffer.from(JSON.stringify(payload)).toString("base64");
// BOTH wire versions, because they carry the scheme in DIFFERENT places and a
// v1-only reader returns null for every v2 payment - silently, since the caller
// reads null as "not this scheme". That is exactly what shipped: the first fix
// read only the top-level field, the live buy settled at the full ceiling again,
// and nothing logged. @x402/core's own schemas:
//   v1 { x402Version, scheme, network, payload }
//   v2 { x402Version, resource?, accepted: PaymentRequirementsV2, payload }
const v2Payload = (scheme) => ({
  x402Version: 2,
  accepted: { scheme, network: "eip155:8453", amount: "20000", asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", payTo: "0xabc", maxTimeoutSeconds: 60 },
  payload: { signature: "0xdead", authorization: {} },
});
const v1Payload = (scheme) => ({ x402Version: 1, scheme, network: "base", payload: { signature: "0xdead", authorization: {} } });
const uptoPayload = v2Payload("upto");
const exactPayload = v2Payload("exact");

ok(isMeterable(reqWith({ "payment-signature": paymentHeader(uptoPayload) })) === true,
  "an upto payment is meterable, read from the payment header the middleware settles from");
ok(isMeterable(reqWith({ "x-payment": paymentHeader(uptoPayload) })) === true,
  "the x-payment fallback header is read too, since the middleware falls back to it");
ok(isMeterable(reqWith({ "payment-signature": paymentHeader(exactPayload) })) === false,
  "an EXACT payment is never metered: that scheme fixed the amount at the 402 and cannot express a lower settle");
ok(isMeterable(reqWith({})) === false && isMeterable({}) === false && isMeterable(null) === false,
  "no payment header means no metering");
ok(isMeterable(reqWith({ "payment-signature": "not base64 json" })) === false,
  "an unparseable payment header is not meterable: it must never DEFAULT to metered");
ok(isMeterable(reqWith({ "payment-signature": paymentHeader({ x402Version: 2, network: "eip155:8453" }) })) === false,
  "a payload with no scheme at all is not meterable");
// v1 wire: the scheme is top-level. Dropping this reader would strand v1 buyers.
ok(isMeterable(reqWith({ "payment-signature": paymentHeader(v1Payload("upto")) })) === true,
  "a v1 payload carries the scheme TOP-LEVEL and is still read");
ok(isMeterable(reqWith({ "payment-signature": paymentHeader(v1Payload("exact")) })) === false,
  "a v1 exact payment is not metered either");
// v2 wire: the scheme is on `accepted`. This is the one the live buy proved.
ok(isMeterable(reqWith({ "payment-signature": paymentHeader(v2Payload("upto")) })) === true,
  "a v2 payload carries the scheme on `accepted` (NO top-level scheme) and is read there");
ok(isMeterable(reqWith({ "payment-signature": paymentHeader({ x402Version: 2, accepted: { network: "eip155:8453" }, payload: {} }) })) === false,
  "a v2 payload whose accepted names no scheme is not meterable");
// The shape the dead version believed in must not resurrect it.
ok(isMeterable({ x402: { scheme: "upto" } }) === false && isMeterable({ _x402Scheme: "upto" }) === false,
  "a decorated request property is NOT the source of truth: nothing sets those, and trusting them is what made this dead");

console.log(`\n${pass} passed, 0 failed`);
