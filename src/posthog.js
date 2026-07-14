// PostHog product analytics + error tracking — opt-in, no-op without an API key.
//
// Mirrors src/sentry.js (and the cache.js / analytics-db.js pattern): if
// POSTHOG_API_KEY is unset, every export here is a safe no-op so the server
// boots and serves identically. Set the key and the next deploy starts
// streaming error events to PostHog.
//
// Why this exists alongside Sentry: PostHog's free tier is ~200x larger
// (1M events/mo vs ~5k) and combines error tracking with product analytics in
// a single tool. The Sentry adapter stays as scaffolding — both can be turned
// on together, or only one. Both are env-gated and independent.
//
// Privacy posture matches the rest of the project:
//   - No caller IP, wallet, payment, body, headers, or query values are sent.
//   - distinctId is a fixed server-side identifier (we have no end-user — the
//     "user" of a tool error is the catalog operator, not the calling agent).
//   - shape tag is keys-only ("b:url", "q:format") — same scrubbing as Sentry.
//   - Human page traffic ($pageview / $pageleave / $web_vitals) is captured
//     client-side by the cookieless posthog-js snippet in src/ledger-chrome.js,
//     ingested first-party through the /e reverse proxy in src/server.js. This
//     module stays server-only: no pageview code, no per-visitor keys here.
//
// Fire-and-forget: capture() enqueues; the SDK ships in the background, so a
// hung PostHog can never slow a tool response. Wrapped in try/catch top-to-bottom.
//
// Configure via Railway env:
//   POSTHOG_API_KEY   — your project API key (REQUIRED to enable; absence = no-op)
//   POSTHOG_HOST      — optional, defaults to "https://us.i.posthog.com"
//                       (use "https://eu.i.posthog.com" for the EU region)
import { PostHog } from "posthog-node";

const API_KEY = process.env.POSTHOG_API_KEY || "";
const HOST = process.env.POSTHOG_HOST || "https://us.i.posthog.com";
// Fixed identifier — we don't have an end-user for a server-side error; the
// "user" of this stream is the operator. A constant distinctId keeps PostHog's
// person-count at 1 and avoids leaking any signal about the calling agent.
const DISTINCT_ID = "agent402-server";

let client = null;
let initialized = false;
let enabled = false;

// Test sink: POSTHOG_TEST_CAPTURE=1 makes every capture append to an
// in-memory array AND print a single `[posthog-test] {json}` line instead of
// touching the network. This is how the funnel CI test asserts the exact
// events + properties the server would have sent, fully offline — same
// pattern as the wallet E2E's leak audit reading the server log.
const TEST_MODE = process.env.POSTHOG_TEST_CAPTURE === "1";
const testEvents = [];
export function _testEventsForTest() {
  return testEvents;
}

// Single choke point for every event this module emits. All properties are
// operator-authored aggregates (slugs, counts, rails) — the privacy posture
// in the header comment is enforced by what the callers pass, and this
// function adds nothing (no IP, no UA, no timestamps beyond PostHog's own).
function capture(event, properties, distinctId = DISTINCT_ID) {
  if (TEST_MODE) {
    const e = { event, properties, distinctId };
    testEvents.push(e);
    console.log(`[posthog-test] ${JSON.stringify(e)}`);
    return;
  }
  if (!enabled || !client) return;
  try {
    client.capture({ distinctId, event, properties });
  } catch { /* never throw from telemetry */ }
}

// True when captures should be built at all — real client or the test sink.
const active = () => TEST_MODE || (enabled && client);

export function initPostHog() {
  if (initialized) return { ok: enabled, reason: enabled ? undefined : "no-key" };
  initialized = true;
  if (!API_KEY) return { ok: false, reason: "no-key" };
  try {
    client = new PostHog(API_KEY, {
      host: HOST,
      // Modest batching — small bursts ship quickly without DDoSing PostHog
      // and without holding events in memory across deploys.
      flushAt: 20,
      flushInterval: 10_000,
    });
    enabled = true;
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

export function posthogEnabled() {
  return enabled;
}

// Capture a tool-handler error as a PostHog event. Properties mirror the
// Sentry tags (slug, status, errorClass, shape) so a single privacy-preserving
// payload feeds both backends. Never blocks, never throws.
export function capturePostHogToolError({ slug, status, message, shape, synthetic, probe }) {
  if (!active()) return;
  // Probe calls (a 4xx where the caller sent zero meaningful input keys) are
  // scanners/agents poking endpoints without arguments — discovery behavior,
  // not real errors. We deliberately keep them OFF the tool_error stream so
  // they never pollute error-tracking views/insights. The volume signal isn't
  // lost: capturePostHogToolCall still records every probe as a tool_call with
  // errored=true + probe=true, so "how much scanning is happening" stays
  // queryable without inflating the error rate.
  if (probe) return;
  capture("tool_error", {
    slug,
    status: Number(status) || 0,
    errorClass: Number(status) >= 500 ? "5xx" : "4xx",
    shape: Array.isArray(shape) && shape.length ? shape.join(",") : "",
    // Bounded — message text is never PII (we author all error messages
    // in the kits) but truncating is cheap defense in depth.
    message: String(message || "").slice(0, 200),
    // `synthetic` is true iff the caller proved knowledge of POW_SECRET
    // via an HMAC-signed X-Heartbeat-Token (see src/pow.js). Trusted
    // internal traffic only — CI canaries, the heartbeat probe, operator
    // smoke tests. PostHog dashboards can filter on this property to
    // exclude rehearsal traffic from real-user error rates.
    synthetic: !!synthetic,
    // `probe` is true when the caller sent a completely empty input and
    // the handler rejected it with 4xx. These are discovery/scanning
    // calls — not real schema mismatches — and inflate the error rate
    // if counted alongside genuine caller mistakes.
    probe: !!probe,
  });
}

// Capture every tool call (success AND failure) as a PostHog event. Fires
// from the `finally` block of the tool handler, so it covers the full picture:
// total volume, latency, cache hits, and success rates per slug. Errors are
// also captured separately via capturePostHogToolError with richer detail;
// this event is the volume/latency layer.
export function capturePostHogToolCall({ slug, latencyMs, cached, errored, status, synthetic, probe, payer }) {
  if (!active()) return;
  capture("tool_call", {
    slug,
    latencyMs: Number(latencyMs) || 0,
    cached: !!cached,
    errored: !!errored,
    status: Number(status) || 200,
    synthetic: !!synthetic,
    probe: !!probe,
    ...(payer ? { payer } : {}),
  });
}

// ---------------------------------------------------------------------------
// Conversion funnel: discovery → paywall_402 → payment_settled.
//
// The buyer journey we sell against is measurable in three stages:
//   1. "discovery"       — an agent fetched a machine-readable surface
//                          (/llms.txt, /.well-known/x402, /api/find, MCP
//                          search_tools…). Property: surface.
//   2. "paywall_402"     — a catalog route answered HTTP 402 (a real quote
//                          was issued). Rolled up (see below); property
//                          `count` carries the true total. `attempt` splits
//                          the bounce: none / usdc_failed / pow_failed.
//   2b. "pow_challenge"  — a free-tier PoW challenge was issued. Paired with
//                          payment_settled{rail=pow} it measures free-tier
//                          take rate (issued → solved). Rolled up like (2).
//   3. "payment_settled" — the gate accepted payment and the tool returned
//                          200. Properties: slug, rail (usdc / pow /
//                          heartbeat / marketplace), network for USDC.
//
// All three keep the file's privacy posture: no caller IP or input — only
// slugs, surfaces, rails, and counts, plus (on settlements only) the paying
// wallet and the caller's UA product token (attribution, not identity — see
// capturePostHogSettlement). distinctId stays constant, so
// these are aggregate stage counters, not per-user tracking; conversion is
// computed as a ratio of stage totals (a PostHog formula insight), which is
// the honest framing for an anonymous-by-design payment protocol.

// Discovery is per-event (arrival timing matters) but bot sweeps against
// /llms.txt etc. shouldn't be able to torch the event budget — cap captures
// per rolling hour and drop the excess silently (the tool_call stream is
// unaffected).
const DISCOVERY_MAX_PER_HOUR = 1000;
let discoveryWindowStart = 0;
let discoveryWindowCount = 0;

export function capturePostHogDiscovery({ surface, synthetic }) {
  if (!active()) return;
  try {
    const now = Date.now();
    if (now - discoveryWindowStart > 3_600_000) {
      discoveryWindowStart = now;
      discoveryWindowCount = 0;
    }
    if (++discoveryWindowCount > DISCOVERY_MAX_PER_HOUR) return;
    capture("discovery", { surface: String(surface || "unknown"), synthetic: !!synthetic });
  } catch { /* never throw from telemetry */ }
}

// 402s are the highest-volume stage by far — registry crawlers (Bazaar,
// x402scan…) re-verify every one of the ~1,300 endpoints, so per-request
// events could alone exceed PostHog's free tier. Instead: accumulate counts
// in memory and flush one event per (slug, synthetic) pair per window, top
// slugs individually + a single "_other" remainder. `sum(count)` in PostHog
// is the exact total — nothing is sampled away.
const PAYWALL_FLUSH_MS = Math.max(1_000, Number(process.env.POSTHOG_PAYWALL_FLUSH_MS) || 900_000);
const PAYWALL_TOP_SLUGS = 50;
let paywallCounts = new Map(); // "slug|synthetic|attempt" -> { slug, priceUsd, powEligible, synthetic, attempt, count }
let paywallTimer = null;

// One timer drives the whole rolled-up funnel (paywall_402 + pow_challenge).
// Created lazily on the first captured count, unref'd so it never holds the
// process open.
function ensureFunnelTimer() {
  if (!paywallTimer) {
    paywallTimer = setInterval(flushPaywallRollup, PAYWALL_FLUSH_MS);
    if (paywallTimer.unref) paywallTimer.unref();
  }
}

// `attempt` classifies a 402 by what the caller actually tried — the
// couldn't-pay vs wouldn't-pay split that turns a flat "93% bounce" into a
// diagnosis:
//   "none"        — no payment/PoW header on the request: a first-contact quote.
//                   An agent with no funded wallet, a discovery crawl, or a
//                   buyer that saw the price and left. Expected-to-bounce.
//   "usdc_failed" — an X-PAYMENT authorization WAS present but the route still
//                   answered 402 (facilitator/verification rejected it). A
//                   buyer that tried to pay and couldn't — the fixable leak.
//   "pow_failed"  — an X-Pow-Solution was present but rejected (bad/expired
//                   work). Tried the free tier and missed.
export function capturePostHogPaywall({ slug, priceUsd, powEligible, synthetic, attempt }) {
  if (!active()) return;
  try {
    const att = attempt === "usdc_failed" || attempt === "pow_failed" ? attempt : "none";
    const key = `${slug}|${synthetic ? 1 : 0}|${att}`;
    const cur = paywallCounts.get(key) || {
      slug: String(slug || "unknown"),
      priceUsd: Number(priceUsd) || 0,
      powEligible: !!powEligible,
      synthetic: !!synthetic,
      attempt: att,
      count: 0,
    };
    cur.count++;
    paywallCounts.set(key, cur);
    ensureFunnelTimer();
  } catch { /* never throw from telemetry */ }
}

function flushPaywallRollup() {
  try {
    if (paywallCounts.size) {
      const entries = [...paywallCounts.values()].sort((a, b) => b.count - a.count);
      paywallCounts = new Map();
      for (const e of entries.slice(0, PAYWALL_TOP_SLUGS)) {
        capture("paywall_402", { slug: e.slug, count: e.count, priceUsd: e.priceUsd, powEligible: e.powEligible, synthetic: e.synthetic, attempt: e.attempt });
      }
      const rest = entries.slice(PAYWALL_TOP_SLUGS);
      if (rest.length) {
        // Fold the long tail per `attempt` (not into one bucket) so the
        // couldn't-pay vs wouldn't-pay split survives for tail slugs too —
        // at most three "_other" rows, and sum(count) stays the exact total.
        const byAttempt = new Map();
        for (const e of rest) byAttempt.set(e.attempt, (byAttempt.get(e.attempt) || 0) + e.count);
        for (const [attempt, count] of byAttempt) {
          capture("paywall_402", { slug: "_other", count, priceUsd: 0, powEligible: false, synthetic: false, attempt });
        }
      }
    }
    flushPowChallengeRollup();
  } catch { /* never throw from telemetry */ }
}
export function _flushPaywallRollupForTest() {
  flushPaywallRollup();
}

// Free-tier funnel: a proof-of-work challenge was ISSUED (an agent asked how to
// pay for free via GET /api/pow/challenge). Compared against
// payment_settled{rail=pow}, this yields the free-tier take rate — of the
// agents that fetched a challenge, how many solved it vs abandoned the work.
// A near-zero take rate means the free path is discovered but too much friction;
// zero issuance means it isn't discovered at all. Rolled up like paywall_402
// (registry crawlers fetch challenges too), sharing the same flush timer.
let powChallengeCounts = new Map(); // "slug|synthetic" -> { slug, synthetic, count }
export function capturePostHogPowChallenge({ slug, synthetic }) {
  if (!active()) return;
  try {
    const key = `${slug}|${synthetic ? 1 : 0}`;
    const cur = powChallengeCounts.get(key) || { slug: String(slug || "unknown"), synthetic: !!synthetic, count: 0 };
    cur.count++;
    powChallengeCounts.set(key, cur);
    ensureFunnelTimer();
  } catch { /* never throw from telemetry */ }
}
function flushPowChallengeRollup() {
  if (!powChallengeCounts.size) return;
  const entries = [...powChallengeCounts.values()].sort((a, b) => b.count - a.count);
  powChallengeCounts = new Map();
  for (const e of entries.slice(0, PAYWALL_TOP_SLUGS)) {
    capture("pow_challenge", { slug: e.slug, count: e.count, synthetic: e.synthetic });
  }
  const rest = entries.slice(PAYWALL_TOP_SLUGS);
  if (rest.length) capture("pow_challenge", { slug: "_other", count: rest.reduce((s, e) => s + e.count, 0), synthetic: false });
}

// Settlements are rare and precious — always per-event. `rail` is what the
// gate actually accepted (mirrors the /api/stats three-rail attribution);
// `network` is the settlement chain decoded from the x402 receipt for USDC.
// `clientUa` is the caller's User-Agent PRODUCT TOKEN only (first token,
// hard-capped at 40 chars — e.g. "agent402-client/0.6.1", "node", "python-httpx/0.27"),
// never the full UA string: it answers "which SDK/client do paying wallets
// use?" (do agent402-client installs convert?) without carrying device or
// platform detail. No IP, ever — consistent with the file's privacy posture.
export function capturePostHogSettlement({ slug, rail, network, priceUsd, synthetic, payer, clientUa }) {
  if (!active()) return;
  capture("payment_settled", {
    slug: String(slug || "unknown"),
    rail: String(rail || "unknown"),
    network: network ? String(network) : null,
    priceUsd: Number(priceUsd) || 0,
    synthetic: !!synthetic,
    ...(payer ? { payer } : {}),
    ...(clientUa ? { clientUa: String(clientUa).slice(0, 40) } : {}),
  });
}

// Retired routes — the teaching 410s (the pruned convert-* pairs). Residual
// demand for a dead route is a product signal (someone's playbook or agent
// prompt still cites it), and without an event that demand is invisible.
// Properties are the route path (matched against a [a-z0-9-] regex before the
// handler runs — unit ids only, never caller input) and the taught
// replacement. Retired routes are also crawler fodder, so captures are
// capped per rolling hour like discovery; the 410 response itself is never
// affected.
const TOOL_GONE_MAX_PER_HOUR = 500;
let toolGoneWindowStart = 0;
let toolGoneWindowCount = 0;

export function capturePostHogToolGone({ route, replacement }) {
  if (!active()) return;
  try {
    const now = Date.now();
    if (now - toolGoneWindowStart > 3_600_000) {
      toolGoneWindowStart = now;
      toolGoneWindowCount = 0;
    }
    if (++toolGoneWindowCount > TOOL_GONE_MAX_PER_HOUR) return;
    capture("tool_gone", { route: String(route || "unknown"), replacement: String(replacement || "") });
  } catch { /* never throw from telemetry */ }
}

// Per-call gateway margin accounting. OpenRouter reports the exact upstream
// bill when usage accounting is requested; this event pairs it with the flat
// tier price so real margin per tier/model is a PostHog insight instead of a
// list-price estimate — and it back-checks the MODEL_COST table the margin
// clamp prices against. upstreamUsd null (provider didn't report) still
// captures tokens so volume stays queryable.
export function capturePostHogGatewayUsage({ tier, model, priceUsd, upstreamUsd, promptTokens, completionTokens }) {
  if (!active()) return;
  const price = Number(priceUsd) || 0;
  const upstream = Number(upstreamUsd) || 0;
  capture("gateway_usage", {
    tier: String(tier || "unknown"),
    model: String(model || ""),
    priceUsd: price,
    upstreamUsd: upstream,
    marginUsd: +(price - upstream).toFixed(6),
    upstreamReported: upstreamUsd != null,
    promptTokens: Number(promptTokens) || 0,
    completionTokens: Number(completionTokens) || 0,
  });
}

// Graceful shutdown helper — call from a SIGTERM handler if you want
// in-flight events flushed before Railway kills the process. Optional;
// PostHog's own batching usually catches them anyway. Also drains the
// paywall_402 rollup so a redeploy doesn't drop up to a window of counts.
export async function shutdownPostHog() {
  flushPaywallRollup();
  if (!client) return;
  try {
    await client.shutdown();
  } catch { /* swallow */ }
}
