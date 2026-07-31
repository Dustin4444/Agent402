#!/usr/bin/env node
// A cap of 1 must mean 1 across every replica.
//
//   node scripts/test-shared-limit.js
//
// WHY: rate limits lived in a per-process Map, so scaling 1 -> 2 replicas
// doubled every one of them. The RATE_LIMIT_REPLICAS divisor fixes any budget
// larger than the replica count but CANNOT fix a budget of 1: dividing 1 by 2
// floors back to 1, because zero is an outage rather than a limit. The trial's
// per-tool cap is exactly 1, so it stayed doubled — measured in production as
// the same tool granting two trials.
//
// One shared counter is the only construction that makes a cap of 1 hold. These
// assertions run against an injected store rather than a live Redis: the
// property is "two callers share one counter", and a fake proves that exactly
// while a skipped test proves nothing.
import { spend, peek, refund, windowKey, sharedLimitEnabled, __setTestClient } from "../src/shared-limit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// Minimal Redis-compatible store. INCR/DECR are atomic here for the same reason
// they are in Redis: single-threaded execution.
const makeStore = () => {
  const m = new Map();
  return {
    calls: { incr: 0, expire: 0, decr: 0 },
    async incr(k) { this.calls.incr++; const n = (m.get(k) || 0) + 1; m.set(k, n); return n; },
    async decr(k) { this.calls.decr++; const n = (m.get(k) || 0) - 1; m.set(k, n); return n; },
    async get(k) { return m.has(k) ? String(m.get(k)) : null; },
    async expire(k) { this.calls.expire++; return 1; },
    async set(k, v) { m.set(k, Number(v)); return "OK"; },
    _dump: m,
  };
};

// --- THE DEFECT, and the fix ------------------------------------------------
// Two replicas, one store. A cap of 1 must yield exactly one grant TOTAL.
{
  const store = makeStore();
  __setTestClient(store);
  ok(sharedLimitEnabled(), "shared limiting reports available when a store is present");

  const replicaA = await spend("trial-tool", "ip|uuid", 1, 3600);
  const replicaB = await spend("trial-tool", "ip|uuid", 1, 3600);
  ok(replicaA.limited === false, "replica A gets the one grant");
  ok(replicaB.limited === true,
    "replica B is refused — a cap of 1 means 1 across processes, which the in-memory limiter could not express");

  // The rejected increment must be handed back, or a refused caller inflates
  // the counter and extends their own lockout.
  ok(Number(store._dump.get(windowKey("trial-tool", "ip|uuid", 3600))) === 1,
    "an over-limit attempt does not inflate the counter");
  ok(store.calls.expire === 1, "the TTL is set once on creation, not refreshed on every hit (a sliding window never resets)");
}

// --- refund gives the grant back, and cannot mint budget --------------------
{
  const store = makeStore();
  __setTestClient(store);
  await spend("trial-tool", "k", 1, 3600);
  ok((await spend("trial-tool", "k", 1, 3600)).limited, "budget spent");
  await refund("trial-tool", "k", 3600);
  ok((await spend("trial-tool", "k", 1, 3600)).limited === false, "after a refund the grant is available again");

  await refund("trial-tool", "never-charged", 3600);
  const key = windowKey("trial-tool", "never-charged", 3600);
  ok(Number(store._dump.get(key)) === 0,
    "refunding an uncharged key floors at zero rather than minting negative budget");
}

// --- FAIL CLOSED ------------------------------------------------------------
// Granting when we cannot count turns a Redis outage into unmetered free
// access. A buyer paying is a worse experience; unbounded free calls are a
// worse failure.
{
  __setTestClient({
    async incr() { throw new Error("redis down"); },
    async decr() { throw new Error("redis down"); },
    async get() { throw new Error("redis down"); },
    async expire() { throw new Error("redis down"); },
    async set() { throw new Error("redis down"); },
  });
  const s = await spend("trial-tool", "k", 1, 3600);
  ok(s.limited === true && s.degraded === true, "a failing store reports LIMITED, not granted — fail closed");
  const p = await peek("trial-tool", "k", 1, 3600);
  ok(p.limited === true && p.degraded === true, "peek fails closed too");
  // A refund against a dead store must not throw into the request path.
  let threw = false;
  try { await refund("trial-tool", "k", 3600); } catch { threw = true; }
  ok(!threw, "a refund against a dead store never throws into the response path");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
