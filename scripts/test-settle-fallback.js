#!/usr/bin/env node
// Offline test for the settle-fallback chain (PayAI -> Solvador) in
// src/payments.js.
//
// The property that must never regress is the double-settle gate: a fallback
// facilitator is only tried when every earlier settler PROVABLY did not
// broadcast (a clean HTTP-402-class rejection). A timeout or 5xx anywhere in
// the chain means a transfer may already be on-chain, and trying anyone else
// could charge the buyer twice. Everything here drives the real
// registerFacilitatorFailureHooks against stub facilitator clients.
import { strict as assert } from "node:assert";
import {
  registerFacilitatorFailureHooks,
  fallbackCandidatesFor,
  isPreBroadcastSettleRejection,
} from "../src/payments.js";

let failures = 0;
const check = (name, fn) => {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok   ${name}`))
    .catch((e) => { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); });
};

// A fake x402ResourceServer capturing the hooks the real one would run.
function fakeServer() {
  const hooks = {};
  return {
    hooks,
    onVerifyFailure(fn) { hooks.verifyFailure = fn; return this; },
    onAfterSettle(fn) { hooks.afterSettle = fn; return this; },
    onSettleFailure(fn) { hooks.settleFailure = fn; return this; },
  };
}
const client = (name, behavior, log) => ({
  settle: async () => {
    log.push(name);
    return behavior(); // return a result, or throw
  },
});
const rejection402 = () => Object.assign(new Error("settle failed (402)"), { status: 402 });
const timeout = () => Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" });
const ctx = (network, error) => ({
  requirements: { network, scheme: "exact" },
  paymentPayload: { p: 1 },
  error,
});

console.log("settle-fallback chain");

await check("gate: 402-class is pre-broadcast, timeout/5xx is not", () => {
  assert.equal(isPreBroadcastSettleRejection(rejection402()), true);
  assert.equal(isPreBroadcastSettleRejection(Object.assign(new Error("payment-method-required"), {})), true);
  assert.equal(isPreBroadcastSettleRejection(timeout()), false);
  assert.equal(isPreBroadcastSettleRejection(Object.assign(new Error("500 upstream"), { status: 500 })), false);
  assert.equal(isPreBroadcastSettleRejection(null), false);
});

await check("candidates: PayAI skipped on networks it cannot settle", () => {
  const pa = {}, sv = {};
  assert.deepEqual(fallbackCandidatesFor("eip155:8453", pa, sv).map((c) => c.name), ["PayAI", "Solvador"]);
  // Celo, Monad, Robinhood: our single-facilitator rails go straight to Solvador.
  for (const net of ["eip155:42220", "eip155:143", "eip155:4663"]) {
    assert.deepEqual(fallbackCandidatesFor(net, pa, sv).map((c) => c.name), ["Solvador"], net);
  }
  assert.deepEqual(fallbackCandidatesFor("eip155:8453", pa, null).map((c) => c.name), ["PayAI"]);
  assert.deepEqual(fallbackCandidatesFor("eip155:8453", null, null), []);
});

async function run({ flag, primaryError, payai, solvador, network = "eip155:8453" }) {
  const prev = process.env.PAYMENT_SETTLE_FALLBACK;
  process.env.PAYMENT_SETTLE_FALLBACK = flag ? "true" : "";
  const calls = [];
  const s = fakeServer();
  registerFacilitatorFailureHooks(
    s,
    payai ? client("PayAI", payai, calls) : null,
    solvador ? client("Solvador", solvador, calls) : null,
  );
  const out = await s.hooks.settleFailure(ctx(network, primaryError));
  if (prev === undefined) delete process.env.PAYMENT_SETTLE_FALLBACK;
  else process.env.PAYMENT_SETTLE_FALLBACK = prev;
  return { out, calls };
}

await check("flag off: nothing is ever tried", async () => {
  const { out, calls } = await run({ flag: false, primaryError: rejection402(), payai: () => ({ success: true }), solvador: () => ({ success: true }) });
  assert.equal(out, undefined);
  assert.deepEqual(calls, []);
});

await check("primary timeout: no fallback at all (may have broadcast)", async () => {
  const { out, calls } = await run({ flag: true, primaryError: timeout(), payai: () => ({ success: true }), solvador: () => ({ success: true }) });
  assert.equal(out, undefined);
  assert.deepEqual(calls, []);
});

await check("primary 402: PayAI recovers, Solvador never touched", async () => {
  const { out, calls } = await run({ flag: true, primaryError: rejection402(), payai: () => ({ success: true, tx: "0xabc" }), solvador: () => { throw new Error("should not be called"); } });
  assert.equal(out?.recovered, true);
  assert.deepEqual(calls, ["PayAI"]);
});

await check("PayAI rejects 402-clean: chain continues, Solvador recovers", async () => {
  const { out, calls } = await run({ flag: true, primaryError: rejection402(), payai: () => { throw rejection402(); }, solvador: () => ({ success: true, tx: "0xdef" }) });
  assert.equal(out?.recovered, true);
  assert.deepEqual(calls, ["PayAI", "Solvador"]);
});

await check("THE gate: PayAI timeout STOPS the chain — Solvador must not run", async () => {
  const { out, calls } = await run({ flag: true, primaryError: rejection402(), payai: () => { throw timeout(); }, solvador: () => ({ success: true }) });
  assert.equal(out, undefined, "a recovery after an ambiguous failure would risk a double-charge");
  assert.deepEqual(calls, ["PayAI"], "Solvador ran after an ambiguous PayAI failure");
});

await check("Celo goes straight to Solvador (PayAI cannot settle it)", async () => {
  const { out, calls } = await run({ flag: true, primaryError: rejection402(), network: "eip155:42220", payai: () => { throw new Error("should not be called"); }, solvador: () => ({ success: true }) });
  assert.equal(out?.recovered, true);
  assert.deepEqual(calls, ["Solvador"]);
});

await check("thrown 400 (invalid-payload class) never falls back — 402 only", async () => {
  const err400 = Object.assign(new Error("settle failed (400) invalid payload"), { status: 400 });
  assert.equal(isPreBroadcastSettleRejection(err400), false);
  const { out, calls } = await run({ flag: true, primaryError: err400, payai: () => ({ success: true }), solvador: () => ({ success: true }) });
  assert.equal(out, undefined);
  assert.deepEqual(calls, []);
});

await check("graceful {success:false} rejections route to afterSettle, never the fallback", async () => {
  // Verified against @x402/core's settlePayment: a facilitator returning
  // { success:false } RETURNS normally — the onSettleFailure catch block is
  // never reached — so buyer-side failures (insufficient_funds, simulation
  // failed, failed on-chain) structurally cannot trigger a fallback settle.
  const prev = process.env.PAYMENT_SETTLE_FALLBACK;
  process.env.PAYMENT_SETTLE_FALLBACK = "true";
  const calls = [];
  const s = fakeServer();
  registerFacilitatorFailureHooks(
    s,
    client("PayAI", () => ({ success: true }), calls),
    client("Solvador", () => ({ success: true }), calls),
  );
  await s.hooks.afterSettle({ requirements: { network: "eip155:8453", scheme: "exact" }, result: { success: false, errorReason: "insufficient_funds" } });
  if (prev === undefined) delete process.env.PAYMENT_SETTLE_FALLBACK;
  else process.env.PAYMENT_SETTLE_FALLBACK = prev;
  assert.deepEqual(calls, [], "a graceful rejection must never reach a fallback client");
});

await check("no Solvador key: behavior is exactly the old PayAI-only chain", async () => {
  const { out, calls } = await run({ flag: true, primaryError: rejection402(), payai: () => { throw rejection402(); }, solvador: null });
  assert.equal(out, undefined);
  assert.deepEqual(calls, ["PayAI"]);
});

console.log(failures ? `\nFAILED (${failures})` : "\nall passed");
process.exit(failures ? 1 : 0);
