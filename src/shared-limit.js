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
      c.on("error", (err) => {
        state.lastError = err.message;
        console.error("[shared-limit] redis error:", err.message);
      });
      await c.connect();
      client = c;
      // The confirmation the announce line deliberately does NOT make.
      if (state.connected !== true) console.log("[shared-limit] redis CONNECTED — counters are shared");
      state.connected = true;
      return c;
    } catch (e) {
      state.connected = false;
      state.lastError = e.message;
      console.error("[shared-limit] connect failed (FAILING CLOSED — trials will be refused):", e.message);
      unavailable = true;
      return null;
    } finally {
      connecting = null;
    }
  })();
  return connecting;
}

/** Is a shared counter CONFIGURED? Callers use this to pick the shared path
 *  over the per-process fallback.
 *
 *  Note the word: CONFIGURED, not connected. This is a synchronous check on the
 *  gate's hot path, so it cannot await a socket — it can only report whether a
 *  URL exists and whether we have already given up on it. Whether the counter
 *  was actually REACHED is knowable only per call, and `spend()` reports it via
 *  `degraded`. Do not read a true here as "the shared counter is working." */
let announced = false;
export function sharedLimitEnabled() {
  const on = Boolean(testClient) || (Boolean(REDIS_URL) && !unavailable);
  // Say which path was CHOSEN, once — and say plainly that choosing it is not
  // the same as reaching it. The previous line logged "SHARED (redis)" purely
  // because REDIS_URL was set, which is true even when every single INCR is
  // failing and the limiter is refusing everyone. A limiter that reports health
  // it has not verified is worse than one that reports nothing, because it ends
  // the investigation. The confirmation comes from connectionState() below.
  if (!announced) {
    announced = true;
    console.log(`[shared-limit] path=${on ? "shared" : "per-process"}` +
      `${REDIS_URL ? " (redis configured, not yet contacted)" : " — REDIS_URL unset"}` +
      `${unavailable ? " — redis marked unavailable" : ""}`);
  }
  return on;
}

// The verified half of the story. `getClient()` sets this the first time it
// actually reaches (or fails to reach) Redis, and `spend()` records the first
// degraded call. Exposed so an operator surface can show the TRUE state rather
// than the configured one.
let state = { connected: null, lastError: null, degradedCalls: 0 };
export function connectionState() { return { ...state, configured: Boolean(REDIS_URL) }; }

/** The fail-closed answer, counted. Every caller that cannot reach the shared
 *  counter goes through here so "how often are we refusing because the store is
 *  down?" has an answer instead of being invisible. */
function degradedResult() {
  state.degradedCalls++;
  return { limited: true, count: null, degraded: true };
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
  if (!c) return degradedResult();
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
    return degradedResult();
  }
}

/** Read without spending. Same fail-closed rule. */
export async function peek(name, key, limit, windowSeconds) {
  const c = await getClient();
  if (!c) return degradedResult();
  try {
    const raw = await c.get(windowKey(name, key, windowSeconds));
    const n = Number(raw || 0);
    return { limited: n >= limit, count: n, degraded: false };
  } catch (e) {
    console.error("[shared-limit] peek failed:", e.message);
    return degradedResult();
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
