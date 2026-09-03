// gateway-settle-breaker - a settle-failure breaker for the LLM gateway tiers.
//
// THE HOLE. @x402/express runs the handler FIRST and settles AFTER, and a <400
// response whose settlement then fails is rewritten to a 402 with nothing
// charged. On the /v1/* tiers (chat, messages, responses, images, embeddings,
// rerank, speech, metered) the handler is an OpenRouter or OpenAI call we pay
// for, so "verify passes, settle fails" (USDC moved away between the two, a
// raced nonce, a facilitator refusal) is upstream spend with no revenue. The
// report composites already have src/composite-spend-guard.js for exactly
// this; the gateway tiers had nothing, and a handler there runs in seconds,
// so one wallet could loop it.
//
// THE SEAM. A tool handler is called as handler(input, req) and never sees the
// response, but Express hands every request its response as `req.res`, and the
// FINAL status of that response is the only honest settlement signal: a 200 is
// settled, a 402 after the handler ran is a settlement that failed (the vendor
// rewrite, the Tempo gate's post-handler broadcast failure - the same shape on
// every rail), a 4xx/5xx the handler threw was never settled and never charged
// (and is not this wallet's fault). So each gateway handler calls
// gatewaySettleBreakerCheck(req) as its FIRST statement: it refuses (429 for a
// wallet, 503 for the global pause) before any upstream call - a >= 400
// cancels settlement, so nobody is charged for the refusal - and arms one
// finish listener on req.res that records the outcome under the same key the
// consult used. Keying is the composite guard's: the signed EIP-3009 payer,
// else the Tempo payer the gate verified, else the client IP.
//
// The finish listener reads the status AND the settle receipt (PAYMENT-RESPONSE
// with success:false), so a graceful facilitator rejection is caught whatever
// status rides with it. Not caught, and accepted: a MALFORMED facilitator
// response at settle (FacilitatorResponseError, answered 502 by the vendor) -
// indistinguishable from a handler 502 without a served marker, rare, and the
// facilitator-diagnostics wrapper logs it loudly.
//
// A handler must therefore never throw a 402 itself - a post-arm 402 IS a
// settlement failure here. scripts/test-gateway-settle-breaker.js pins that
// invariant from source for every gateway kit.
//
// In-memory per process (a restart resets it, the same as the composite and
// external-spend guards); tune via env. Not a reputation system: a settled
// call clears the wallet's count at once.
import { payerFromRequest } from "./payer.js";

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
/** Settle failures a wallet may accumulate inside the window before it is refused. */
export const MAX_FAILS = num(process.env.GATEWAY_SETTLE_BREAKER_MAX, 3);
/** Rolling window, and the length of a global pause. */
export const WINDOW_MS = num(process.env.GATEWAY_SETTLE_BREAKER_WINDOW_MS, 15 * 60_000);
/** Settle failures across ALL keys in the window that pause every tier - the
 *  per-key count is evadable by rotating wallets or IPs; this is not. */
export const GLOBAL_MAX_FAILS = num(process.env.GATEWAY_SETTLE_BREAKER_GLOBAL_MAX, 12);

const fails = new Map(); // key -> number[] (failure timestamps inside the window)
let globalFails = [];
let globalPausedUntil = 0;
let globalTrips = 0;

/** The identity a gateway call is counted under. Same derivation as the
 *  composite guard in server.js and route-execute's spend key: the signed EVM
 *  payer, else the Tempo payer the gate verified, else the client IP. Null only
 *  for an in-process caller with no request (route-execute dispatching a flat
 *  tier), which the global breaker still covers. */
export function gatewaySettleBreakerKey(req) {
  if (!req || typeof req !== "object") return null;
  const payer = payerFromRequest(req);
  if (payer) return payer;
  if (req.mppTempoPayer) return `tempo:${req.mppTempoPayer}`;
  const ip = typeof req.ip === "string" && req.ip.trim() ? req.ip.trim() : req.socket?.remoteAddress;
  return ip ? `ip:${String(ip).trim()}` : null;
}

function inWindow(arr, now) { return arr.filter((t) => now - t < WINDOW_MS); }

/** Per-key state: blocked while MAX_FAILS or more failures sit inside the
 *  window; `until` is when the count next drops below the threshold. */
export function gatewaySettleBreakerBlocked(key, now = Date.now()) {
  if (!key) return { blocked: false, fails: 0 };
  const arr = inWindow(fails.get(key) || [], now);
  if (arr.length) fails.set(key, arr); else fails.delete(key);
  if (arr.length < MAX_FAILS) return { blocked: false, fails: arr.length };
  // The block lifts when the (len - MAX + 1)th newest failure ages out.
  const until = arr[arr.length - MAX_FAILS] + WINDOW_MS;
  return { blocked: true, fails: arr.length, until };
}

/** Global state: paused for WINDOW_MS once GLOBAL_MAX_FAILS failures land in a window. */
export function gatewaySettleBreakerGlobalPaused(now = Date.now()) {
  if (globalPausedUntil > now) return { paused: true, until: globalPausedUntil };
  globalPausedUntil = 0;
  return { paused: false };
}

/** A payment was presented, the handler served, and settlement FAILED. */
export function recordGatewaySettleFailure(key, now = Date.now()) {
  globalFails = inWindow(globalFails, now);
  globalFails.push(now);
  if (globalFails.length >= GLOBAL_MAX_FAILS) {
    globalPausedUntil = now + WINDOW_MS;
    globalFails = [];
    globalTrips++;
    console.warn(`[gateway-breaker] ${GLOBAL_MAX_FAILS} unsettled gateway calls inside ${Math.round(WINDOW_MS / 1000)} s - pausing every /v1 tier until ${new Date(globalPausedUntil).toISOString()}`);
  }
  if (!key) return;
  const arr = inWindow(fails.get(key) || [], now);
  arr.push(now);
  fails.set(key, arr);
  if (arr.length >= MAX_FAILS) console.warn(`[gateway-breaker] ${arr.length} settle failures inside the window for one buyer - refusing its gateway calls until the window clears`);
}

/** A settled 200 clears the key at once - a good buyer is never impeded. */
export function recordGatewaySettleSuccess(key) {
  if (key) fails.delete(key);
}

function decodeReceipt(res) {
  try {
    const h = res.getHeader?.("PAYMENT-RESPONSE") || res.getHeader?.("X-PAYMENT-RESPONSE");
    if (typeof h !== "string" || !h) return null;
    return JSON.parse(Buffer.from(h, "base64").toString("utf-8"));
  } catch { return null; }
}

/** Arm ONE finish listener per request on `req.res`, recording the FINAL
 *  outcome under `key`. Exported for the test; the check below calls it. */
export function armGatewaySettleBreaker(req, key) {
  if (!req || typeof req !== "object" || req.__gatewaySettleBreakerArmed) return false;
  const res = req.res;
  if (!res || typeof res.once !== "function") return false;
  req.__gatewaySettleBreakerArmed = true;
  res.once("finish", () => {
    try {
      const st = res.statusCode;
      const receipt = decodeReceipt(res);
      if (st === 402 || receipt?.success === false) recordGatewaySettleFailure(key);
      else if (st === 200) recordGatewaySettleSuccess(key);
      // Anything else (a 4xx/5xx the handler threw) was never settled and is
      // not this wallet's doing: neither counted nor cleared.
    } catch { /* never break a response */ }
  });
  return true;
}

/**
 * THE CONSULT LINE. Every gateway handler calls this first, before validation
 * and before any upstream call. Throws 503 while the global pause holds, 429
 * while this buyer is blocked; otherwise arms the outcome listener.
 */
export function gatewaySettleBreakerCheck(req, { now = Date.now() } = {}) {
  const key = gatewaySettleBreakerKey(req);
  const g = gatewaySettleBreakerGlobalPaused(now);
  if (g.paused) {
    const secs = Math.max(1, Math.ceil((g.until - now) / 1000));
    const e = new Error(`The LLM gateway is briefly paused after a burst of payments that verified and then failed to settle; retry after ${new Date(g.until).toISOString()} (about ${secs} s). Nothing was charged for this request.`);
    e.statusCode = 503;
    e.retryAfterMs = g.until - now;
    try { req?.res?.setHeader?.("Retry-After", String(secs)); } catch { /* headers are best-effort */ }
    throw e;
  }
  const b = gatewaySettleBreakerBlocked(key, now);
  if (b.blocked) {
    const secs = Math.max(1, Math.ceil((b.until - now) / 1000));
    const e = new Error(`Recent payments from this wallet failed to settle (${b.fails} in the last ${Math.round(WINDOW_MS / 60_000)} min: they verified, the call was served, and the transfer did not go through); the gateway refuses new calls from it until ${new Date(b.until).toISOString()} (about ${secs} s). Nothing was charged for this request. Check the wallet's USDC balance on the paying chain before retrying.`);
    e.statusCode = 429;
    e.retryAfterMs = b.until - now;
    try { req?.res?.setHeader?.("Retry-After", String(secs)); } catch { /* headers are best-effort */ }
    throw e;
  }
  armGatewaySettleBreaker(req, key);
}

/** Counts only - never a key, address or IP. */
export function gatewaySettleBreakerStatus(now = Date.now()) {
  let blockedKeys = 0, trackedKeys = 0;
  for (const [key] of fails) {
    const s = gatewaySettleBreakerBlocked(key, now);
    if (s.fails) trackedKeys++;
    if (s.blocked) blockedKeys++;
  }
  const g = gatewaySettleBreakerGlobalPaused(now);
  return {
    trackedKeys, blockedKeys,
    globalFailsInWindow: inWindow(globalFails, now).length,
    globalPaused: g.paused, globalPausedUntil: g.paused ? new Date(g.until).toISOString() : null, globalTrips,
    maxFails: MAX_FAILS, windowMs: WINDOW_MS, globalMaxFails: GLOBAL_MAX_FAILS,
  };
}

/** Test-only. */
export function _gatewaySettleBreakerReset() { fails.clear(); globalFails = []; globalPausedUntil = 0; globalTrips = 0; }
