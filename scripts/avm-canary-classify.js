// Pure classifiers for the Algorand rail canary (scripts/algorand-rail-canary.js).
// Extracted into a side-effect-free module so they can be unit-tested without
// booting the sweep (the canary self-runs on import). See
// scripts/test-algorand-canary-classify.js.

// A 402 that comes back faster than this never reached the chain (real Algorand
// round trips measured 5s+): the AVM-specific shape of a throttle/burst reject.
export const FAST_REJECT_MS = Number(process.env.CANARY_FAST_REJECT_MS || "1500");

// The facilitator is refusing THIS wallet's volume (429, or a 503 that says so),
// not a rail defect - this sweep buys ~500 tools back to back.
export const isThrottle = (status, body) =>
  status === 429 || (status === 503 && /rate.?limit|throttl|too many|overload/i.test(String(body || "")));

// A THIRD-PARTY or EDGE failure: a vendor 5xx, a router "Seller rejected the
// paid retry", or Railway's edge returning 502 "upstream error" mid-deploy
// (which hits pure-CPU tools too, so it is never a handler defect). A >=400
// cancels settlement, so the buyer is never charged and the fault is not our
// rail or handler - reported, never fails the run.
export const isUpstreamOutage = (status, body) =>
  status === 502 || status === 503 || status === 504 ||
  /Seller rejected the paid retry|upstream error|operation was aborted|aborted due to timeout|ECONNRESET|ETIMEDOUT|socket hang up|Bad Gateway|Gateway Time-?out|fetch failed/i.test(String(body || ""));

// Terminal shape of one paid attempt:
// "ok" | "empty" | "fast-402" | "throttle" | "slow-402" | "other".
export const outcomeOf = (a) =>
  a.status === 200 && String(a.body || "").trim() ? "ok"
    : a.status === 200 ? "empty"
      : a.status === 402 && a.elapsedMs < FAST_REJECT_MS ? "fast-402"
        : isThrottle(a.status, a.body) ? "throttle"
          : a.status === 402 ? "slow-402"
            : "other";
