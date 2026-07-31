// A rate limit that survives horizontal scaling.
//
// src/rate-limit.js keeps buckets in a per-process Map, so every replica holds
// its own copy and the effective system-wide limit is (configured x replicas).
// Scaling 1 -> 2 replicas silently doubled every limit built on it. The
// RATE_LIMIT_REPLICAS divisor fixes that for any budget larger than the replica
// count, but it CANNOT fix a budget that is already 1: dividing 1 by 2 floors
// back to 1, because a budget of zero is an outage rather than a limit. The
// trial's per-tool cap is exactly 1, so it stayed doubled.
//
// This is the only way to make a cap of 1 mean 1 across N processes: one
// counter, somewhere both replicas can see it.
//
// FAILS CLOSED. If Redis is unreachable the answer is "over budget", so the
// caller is refused the free thing and pays instead. The opposite choice —
// granting when we cannot count — turns a Redis outage into unmetered free
// access, which is how a limiter becomes decorative at exactly the moment it
// matters. A buyer paying is a worse experience; unbounded free calls are a
// worse failure.
import { createClient } from "redis";

const REDIS_URL = process.env.REDIS_URL || "";
let client = null;
let connecting = null;
let unavailable = false;
// Test seam. The property that matters — a cap of 1 holding across SEVERAL
// processes — cannot be proven without a shared counter, and neither a Redis
// server nor Docker is guaranteed on a dev box or a CI runner. Skipping the
// test would leave the fix asserted but unverified, which is the failure mode
// this repo keeps rediscovering. Injecting a client lets two module consumers
// share one store and proves the semantics for real.
let testClient = null;
export function __setTestClient(c) { testClient = c; unavailable = false; }

async function getClient() {
  if (testClient) return testClient;
  if (!REDIS_URL || unavailable) return null;
  if (client && client.isReady) return client;
  if (connecting) return connecting;
  connecting = (async () => {
    try {
      const c = createClient({
        url: REDIS_URL,
        socket: {
          connectTimeout: 3_000,
          reconnectStrategy: (retries) =>
            retries > 5 ? new Error("redis: too many reconnects") : Math.min(retries * 200, 2_000),
        },
      });
      c.on("error", (err) => console.error("[shared-limit] redis error:", err.message));
      await c.connect();
      client = c;
      return c;
    } catch (e) {
      console.error("[shared-limit] connect failed:", e.message);
      unavailable = true;
      return null;
    } finally {
      connecting = null;
    }
  })();
  return connecting;
}

/** Is a shared counter actually available? Callers use this to decide whether
 *  the feature can be offered at all, rather than silently degrading. */
let announced = false;
export function sharedLimitEnabled() {
  const on = Boolean(testClient) || (Boolean(REDIS_URL) && !unavailable);
  // Say which path is live, once. This shipped believing Redis was in use while
  // production kept granting one trial PER REPLICA, and no surface — logs,
  // /health, the response — could say whether the shared counter was reached.
  // A limiter whose backing store is unknowable is a limiter you cannot debug.
  if (!announced) {
    announced = true;
    console.log(`[shared-limit] ${on ? "SHARED (redis)" : "PER-PROCESS (in-memory fallback)"}` +
      `${REDIS_URL ? "" : " — REDIS_URL unset"}${unavailable ? " — redis marked unavailable" : ""}`);
  }
  return on;
}

/** Window-bucketed key: all replicas in the same wall-clock window agree. */
export function windowKey(name, key, windowSeconds) {
  const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
  return `rl:${name}:${key}:${bucket}`;
}

/**
 * Spend one unit if the budget allows. ATOMIC: INCR is a single round trip, so
 * two replicas racing the same key cannot both see "1 left".
 *
 * Returns { limited, count, degraded }. `degraded` marks a Redis failure, where
 * we report limited:true — see the fail-closed note above.
 */
export async function spend(name, key, limit, windowSeconds) {
  const c = await getClient();
  if (!c) return { limited: true, count: null, degraded: true };
  const k = windowKey(name, key, windowSeconds);
  try {
    const n = await c.incr(k);
    // Set the TTL only on creation. Refreshing it on every hit would slide the
    // window forever under sustained traffic and the budget would never reset.
    if (n === 1) await c.expire(k, windowSeconds);
    if (n > limit) {
      // Give back the over-limit increment so a rejected caller cannot inflate
      // the counter and extend their own lockout indefinitely.
      await c.decr(k);
      return { limited: true, count: limit, degraded: false };
    }
    return { limited: false, count: n, degraded: false };
  } catch (e) {
    console.error("[shared-limit] spend failed:", e.message);
    return { limited: true, count: null, degraded: true };
  }
}

/** Read without spending. Same fail-closed rule. */
export async function peek(name, key, limit, windowSeconds) {
  const c = await getClient();
  if (!c) return { limited: true, count: null, degraded: true };
  try {
    const raw = await c.get(windowKey(name, key, windowSeconds));
    const n = Number(raw || 0);
    return { limited: n >= limit, count: n, degraded: false };
  } catch (e) {
    console.error("[shared-limit] peek failed:", e.message);
    return { limited: true, count: null, degraded: true };
  }
}

/**
 * Give back one unit. Used when the granted thing then FAILED: a trial charged
 * at grant time whose request returned >=400 never delivered anything, and the
 * caller should not lose their one free call to a malformed probe — the same
 * rule settlement ordering already applies to paying buyers.
 *
 * Floors at zero: a refund must never mint budget for a key that was never
 * charged.
 */
export async function refund(name, key, windowSeconds) {
  const c = await getClient();
  if (!c) return;
  const k = windowKey(name, key, windowSeconds);
  try {
    const n = await c.decr(k);
    if (n < 0) await c.set(k, "0", { KEEPTTL: true });
  } catch (e) {
    console.error("[shared-limit] refund failed:", e.message);
  }
}
