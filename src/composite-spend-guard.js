// composite-spend-guard — protects the expensive composite tools (research-deep,
// dossier) from an upstream-drain grief. Because x402 settles AFTER the ~90s
// handler and a non-200 RELEASES the EIP-3009 nonce (the signed authorization
// stays reusable), a payer can present a verify-passing authorization, make us
// run costly OpenRouter/search work, then dodge settlement (e.g. move the funds
// out during the 90s window so settle fails), repeatedly, at ~zero cost to them.
// Each iteration burns ~$0.45-0.70 of OUR upstream with no revenue.
//
// This tracks per-payer "spent-then-failed-to-settle" events and blocks a payer
// who crosses the threshold BEFORE the next expensive run. A genuine paid 200
// clears the counter, so it never penalizes real buyers. In-memory per replica
// (the per-call drain is small, blocks are short, and the gateway-balance alarm
// is the outer backstop); tune via env. Only the EVM EIP-3009 payer is guarded
// (that is the rail the reusable-nonce mechanic applies to).
const WINDOW_MS = Number(process.env.COMPOSITE_GUARD_WINDOW_MS) || 15 * 60_000;
const MAX_FAILS = Number(process.env.COMPOSITE_GUARD_MAX_FAILS) || 3;
const BLOCK_MS = Number(process.env.COMPOSITE_GUARD_BLOCK_MS) || 30 * 60_000;

const fails = new Map();        // payer -> number[] (failure timestamps in window)
const blockedUntil = new Map(); // payer -> timestamp the block lifts
// Global circuit breaker: spend-then-fail events across ALL keys in the window.
// The per-key guard is evadable by rotating wallets/IPs; this bounds the total
// unsettled upstream burn regardless of who causes it. Trips to a short pause
// on every composite (503, nobody charged) rather than blocking any one buyer.
const GLOBAL_MAX_FAILS = Number(process.env.COMPOSITE_GUARD_GLOBAL_MAX_FAILS) || 12;
const GLOBAL_PAUSE_MS = Number(process.env.COMPOSITE_GUARD_GLOBAL_PAUSE_MS) || 15 * 60_000;
let globalFails = [];
let globalPausedUntil = 0;
// Upstream usage telemetry for composites (the most expensive calls we make,
// invisible to the gateway's per-call margin event): running totals here, and
// a PostHog event per run when PostHog is configured.
const usage = { runs: 0, ok: 0, failed: 0, upstreamUsd: 0, bySlug: {} };

/** Slugs whose handlers run long, expensive upstream work before settlement.
 * Every composite that fans out to metered upstream (OpenRouter synthesis, and
 * for token-risk real Blockscout x402 buys) MUST be here, or its agent path is
 * an unguarded upstream-drain. `scripts/test-composite-guard.js` asserts the
 * full set so a new expensive product can't ship outside the guard. */
export const EXPENSIVE_COMPOSITE_SLUGS = new Set([
  "research", "research-pro", "research-max", "dossier", "dossier-max",
  "fund-report", "fund-report-max", "domain-audit", "domain-audit-pro",
  "token-risk", "token-risk-pro",
  "recall-report", "insider-report", "market-brief",
  // Media tiers: one upstream call each, but a flat $0.014-$0.12 is spent BEFORE
  // settlement, so an unsettled repeat is free to the caller and real to us.
  // Being in this set also marks them longRunning (EVM exact only) - a 40-240 s
  // run outlives an SVM blockhash, the AVM default window and a Tempo credential.
  "v1-images-fast", "v1-images-pro", "v1-videos",
]);

/** True if this payer is currently blocked (checked BEFORE the handler spends). */
export function compositeGuardBlocked(payer) {
  if (!payer) return false;
  const until = blockedUntil.get(payer);
  if (!until) return false;
  if (until > Date.now()) return true;
  blockedUntil.delete(payer); // block expired
  fails.delete(payer);
  return false;
}

/** True while the global breaker is tripped (checked BEFORE the handler spends). */
export function compositeGuardGlobalPaused() {
  if (globalPausedUntil > Date.now()) return true;
  globalPausedUntil = 0;
  return false;
}

/** Record that we SPENT upstream for this payer and then did NOT settle (non-200). */
export function recordCompositeSpendFailure(payer) {
  const t = Date.now();
  globalFails = globalFails.filter((x) => t - x < WINDOW_MS);
  globalFails.push(t);
  if (globalFails.length >= GLOBAL_MAX_FAILS) { globalPausedUntil = t + GLOBAL_PAUSE_MS; globalFails = []; }
  if (!payer) return;
  const arr = (fails.get(payer) || []).filter((x) => t - x < WINDOW_MS);
  arr.push(t);
  if (arr.length >= MAX_FAILS) { blockedUntil.set(payer, t + BLOCK_MS); fails.delete(payer); }
  else fails.set(payer, arr);
}

/** A genuine paid success clears the payer's failure history. */
export function recordCompositeSpendSuccess(payer) {
  if (payer) fails.delete(payer);
}

/** A composite finished: account its upstream spend (PostHog when configured). */
export function recordCompositeUsage({ slug, upstreamUsd, ok, priceUsd }) {
  const usd = Number(upstreamUsd) || 0;
  usage.runs++; if (ok) usage.ok++; else usage.failed++;
  usage.upstreamUsd += usd;
  const b = (usage.bySlug[slug] ||= { runs: 0, ok: 0, upstreamUsd: 0 });
  b.runs++; if (ok) b.ok++; b.upstreamUsd += usd;
  import("./posthog.js").then((ph) => {
    try { ph.capturePostHogCompositeUsage?.({ slug, upstreamUsd: usd, ok: !!ok, priceUsd: Number(priceUsd) || null }); } catch { /* telemetry never throws */ }
  }).catch(() => {});
}

/** Test/ops introspection. */
export function _compositeGuardState() {
  return { fails: fails.size, blocked: blockedUntil.size, WINDOW_MS, MAX_FAILS, BLOCK_MS, globalFails: globalFails.length, globalPausedUntil, GLOBAL_MAX_FAILS, GLOBAL_PAUSE_MS, usage: { ...usage, upstreamUsd: Math.round(usage.upstreamUsd * 1e4) / 1e4 } };
}
export function _compositeGuardReset() { fails.clear(); blockedUntil.clear(); globalFails = []; globalPausedUntil = 0; }
