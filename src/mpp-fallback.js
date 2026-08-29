// "Stop offering this client an MPP challenge so it falls through to x402."
//
// Companion to src/mpp-evm-domain.js. Once a client has PROVEN (by a signature
// that recovers to its own payload `from`) that it signs EIP-3009 under the
// wrong token domain name, its MPP evm path cannot work here - but its x402
// path demonstrably can (measured on the AgentCore instrument, Base tx
// 0x9b48b7fe...). The remedy is to withhold the `WWW-Authenticate: Payment`
// challenges from that client for a short while: a manager that prefers MPP
// then has nothing to select, and falls back to the x402 offer already sitting
// in the same 402's PAYMENT-REQUIRED header.
//
// WHY IT IS STICKY AND NOT JUST PER-RESPONSE. Suppressing only on the response
// to the failing credential is not enough: an agent that retries the tool call
// starts a FRESH request that carries no credential, sees the challenge again,
// and loops. So a client is remembered briefly, keyed by remote address + a
// short User-Agent fingerprint - the only identity a bare unpaid request has.
//
// WHY THAT KEY IS SAFE ENOUGH. The flag is only ever SET by a request that
// carried a cryptographically attributable signature, so it cannot be planted
// on someone else by a forged header. The blast radius of a false hit (a
// different client behind the same egress IP and User-Agent) is that it sees a
// 402 offering x402 only - our primary, most-settled rail - for at most the
// TTL. Bounded map, bounded TTL, single process; MPP_EVM_DOMAIN_FALLBACK=off
// disables the whole mechanism.
const TTL_MS = Number(process.env.MPP_EVM_DOMAIN_FALLBACK_TTL_MS || 30 * 60 * 1000);
const MAX_ENTRIES = 500;

/** key -> expiry epoch ms */
const flagged = new Map();

/** Call-time read, like every other rollout knob here. */
export function evmDomainFallbackEnabled() {
  return String(process.env.MPP_EVM_DOMAIN_FALLBACK || "").trim().toLowerCase() !== "off";
}

/** Remote address + a truncated UA. Never logged, never surfaced - it is only
 *  ever compared against itself. */
export function clientFingerprint(req) {
  const ip = String(req?.ip || req?.socket?.remoteAddress || "").slice(0, 64);
  const ua = String(req?.headers?.["user-agent"] || "").slice(0, 80);
  if (!ip && !ua) return null;
  return `${ip}|${ua}`;
}

function prune(now) {
  for (const [k, exp] of flagged) if (exp <= now) flagged.delete(k);
  // Bound the map even under a pathological spread of fingerprints: oldest
  // insertion order first (Map preserves it), never unbounded growth.
  while (flagged.size > MAX_ENTRIES) flagged.delete(flagged.keys().next().value);
}

/** Record that this client signs under the wrong token domain, and suppress
 *  challenges on THIS response too. */
export function noteWrongDomainSigner(req) {
  if (req) req.mppSuppressChallenges = true;
  if (!evmDomainFallbackEnabled()) return;
  const key = clientFingerprint(req);
  if (!key) return;
  const now = Date.now();
  flagged.set(key, now + TTL_MS);
  prune(now);
}

/** Should this request's 402 carry MPP challenges? */
export function mppChallengesSuppressed(req) {
  if (!evmDomainFallbackEnabled()) return false;
  if (req?.mppSuppressChallenges) return true;
  const key = clientFingerprint(req);
  if (!key) return false;
  const exp = flagged.get(key);
  if (!exp) return false;
  if (exp <= Date.now()) { flagged.delete(key); return false; }
  return true;
}

/** Test seam only. */
export function _resetMppFallback() {
  flagged.clear();
}

/** Operator visibility: how many clients are currently falling back. Counts
 *  only - a fingerprint is never exposed. */
export function mppFallbackStatus() {
  const now = Date.now();
  let live = 0;
  for (const exp of flagged.values()) if (exp > now) live++;
  return { enabled: evmDomainFallbackEnabled(), suppressedClients: live, ttlMs: TTL_MS };
}
