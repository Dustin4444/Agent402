#!/usr/bin/env node
// Offline test for the canary refill decision (scripts/canary-refill.js).
//
// This job moves real money on a schedule with nobody watching, so the
// decision logic is pinned exhaustively. The two catastrophic wrong answers:
// sending when it should not (a loop that drains the refill wallet), and a
// redirectable recipient (there is none — asserted here as a constant).
import { strict as assert } from "node:assert";
import { decideRefill, BURNER, USDC_BASE } from "./canary-refill.js";

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};
const usd = (n) => Math.round(n * 1e6);

console.log("canary refill decision");

check("burner at/above the floor: skip, even with a full refill wallet", () => {
  assert.deepEqual(decideRefill({ burnerMicro: usd(8), refillMicro: usd(50) }), { action: "skip" });
  assert.deepEqual(decideRefill({ burnerMicro: usd(13.35), refillMicro: usd(50) }), { action: "skip" });
});

check("burner below the floor: send exactly up to the target", () => {
  const d = decideRefill({ burnerMicro: usd(3), refillMicro: usd(50) });
  assert.equal(d.action, "send");
  assert.equal(d.amountMicro, usd(12), "15 target - 3 balance = 12");
});

check("the per-run cap binds: an empty burner gets the cap, not the full target", () => {
  const d = decideRefill({ burnerMicro: 0, refillMicro: usd(50) });
  assert.equal(d.action, "send");
  assert.equal(d.amountMicro, usd(12), "capped at MAX_PER_RUN even though target-0 = 15");
});

check("a worst-case bug loop is bounded by the cap, not the wallet", () => {
  // Even if the burner read were somehow always 0, each run can move at most
  // the cap — the refill wallet drains over days with daily issues, not in one tx.
  const d = decideRefill({ burnerMicro: 0, refillMicro: usd(1000), maxPerRunUsd: 12 });
  assert.equal(d.amountMicro, usd(12));
});

check("refill wallet cannot cover the top-up: loud refill-empty, no partial send", () => {
  const d = decideRefill({ burnerMicro: usd(3), refillMicro: usd(5) });
  assert.equal(d.action, "refill-empty");
  assert.equal(d.amountMicro, usd(12), "the ask is reported so the issue can name it");
});

check("unreadable balances never produce a blind send", () => {
  assert.equal(decideRefill({ burnerMicro: NaN, refillMicro: usd(50) }).action, "refill-empty");
  assert.equal(decideRefill({ burnerMicro: usd(3), refillMicro: NaN }).action, "refill-empty");
});

check("custom floor/target/cap are honoured", () => {
  const d = decideRefill({ burnerMicro: usd(4), refillMicro: usd(100), floorUsd: 5, targetUsd: 20, maxPerRunUsd: 10 });
  assert.equal(d.action, "send");
  assert.equal(d.amountMicro, usd(10), "20-4=16, capped at 10");
});

check("money is integer micro-units — no float dust in the send amount", () => {
  const d = decideRefill({ burnerMicro: usd(7.99), refillMicro: usd(50) });
  assert.equal(d.amountMicro, Math.round(d.amountMicro), "amount must be an integer");
  assert.equal(d.amountMicro, usd(7.01));
});

check("the recipient and asset are constants, not configuration", () => {
  assert.equal(BURNER, "0x902dCf34E53695bDEA2fFB354b1a2e58bD598256");
  assert.equal(USDC_BASE, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
});

console.log(failures ? `\nFAILED (${failures})` : "\nall passed");
process.exit(failures ? 1 : 0);
