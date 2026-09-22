// A per-client hourly budget for unpaid requests to priced catalog routes.
//
// An unpaid request to a priced route is a price check: it earns a 402 with the
// route's challenges. Those are free to read, and every indexer and first-time
// buyer starts with one. What this bounds is the BURST: one client walking every
// priced route many times an hour learns nothing the published documents
// (/.well-known/x402, /openapi.json, /api/pricing) did not already say, and each
// 402 costs us a challenge build. The default sits far above any steady
// indexer's rate on purpose. A 429 to an indexer reads as "down" in its listing,
// which is worse than the load, so the job is to stop bursts and never to
// penalize a steady monitor.
//
// Counted: GET/HEAD/POST to a priced catalog route that carries no payment or
// credential header and is not one of our own signed probes. Keyed by client ip
// AND the User-Agent product token, so two programs behind one address are two
// clients. Fixed UTC-hour windows: the 429 says exactly when the count resets.
// Never counted: named indexers and search/AI crawlers, our own User-Agents,
// /mcp and the MCP connector's own loopback, the discovery surfaces, any route
// that is not priced, and every request under FREE_MODE (the server does not
// mount this there). Memory is bounded: at most `keyCap` keys, least recently
// seen dropped first.
import { DISCOVERY_PATHS, OWN_UA, indexerFor, uaToken } from "./traffic-classifier.js";

export const DEFAULT_UNPAID_QUOTE_BUDGET_PER_HOUR = 3000;
export const UNPAID_QUOTE_BUDGET_KEY_CAP = 20_000;
const HOUR_MS = 3_600_000;
// Headers that make a request a paid (or proof-of-work) attempt rather than a
// price check. Authorization of any scheme counts: credits keys (Bearer), MPP
// credentials (Payment) and anything else a gate may read.
const CREDENTIAL_HEADERS = ["payment-signature", "x-payment", "authorization", "x-pow-solution"];

/** The configured budget. "0" or "off" disables (returns 0); a malformed or
 *  negative value reads as unset, never as off, because off is the one setting
 *  a typo must not select. */
export function unpaidQuoteBudgetPerHour(env = process.env) {
  const raw = String(env?.UNPAID_QUOTE_BUDGET_PER_HOUR ?? "").trim().toLowerCase();
  if (raw === "") return DEFAULT_UNPAID_QUOTE_BUDGET_PER_HOUR;
  if (raw === "0" || raw === "off") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_UNPAID_QUOTE_BUDGET_PER_HOUR;
  return Math.floor(n);
}

export function hasCredentialHeader(headers = {}) {
  return CREDENTIAL_HEADERS.some((h) => {
    const v = headers?.[h];
    return (Array.isArray(v) ? v.join("") : String(v ?? "")).trim().length > 0;
  });
}

/** Named indexers, search and AI crawlers, and our own User-Agents are never budgeted. */
export function isExemptUserAgent(ua) {
  const s = String(ua || "");
  return OWN_UA.test(s) || !!indexerFor(s);
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
/** The MCP connector replays a tool call to our own route over loopback and
 *  marks it. The header alone is caller-settable, so it counts only when the
 *  socket itself is local: a request arriving through the edge proxy never is. */
export function isMcpLoopback(req) {
  const via = String(req?.headers?.["x-agent402-via"] || "").trim().toLowerCase();
  if (via !== "mcp") return false;
  return LOOPBACK.has(String(req?.socket?.remoteAddress || ""));
}

export function isExemptPath(path) {
  const p = String(path || "");
  return p === "/mcp" || p.startsWith("/mcp/") || DISCOVERY_PATHS.has(p);
}

export const secondsToHourBoundary = (now = Date.now()) => Math.max(1, Math.ceil((HOUR_MS - (now % HOUR_MS)) / 1000));

/**
 * @param {object} o
 * @param {number} o.budget          requests per client per UTC hour; 0 disables
 * @param {(method:string, path:string) => boolean} o.isPriced  true for a priced catalog route
 * @param {(req:any) => boolean} [o.isSynthetic]  our own signed probes
 * @param {string} [o.policyUrl]     where the 429 points
 * @param {number} [o.keyCap]
 * @param {() => number} [o.now]
 * @param {(line:string) => void} [o.log]
 */
export function createUnpaidQuoteBudget({ budget, isPriced, isSynthetic = () => false, policyUrl = "/crawler", keyCap = UNPAID_QUOTE_BUDGET_KEY_CAP, now = Date.now, log = console.warn } = {}) {
  const limit = Number(budget) || 0;
  let hour = -1;
  const counts = new Map();       // `${ip}|${uaToken}` -> requests this hour, least recently seen first
  const logged = new Set();       // keys already logged as throttled this hour
  let throttled = 0;

  /** Count one request for `key`; returns { limited, count, retryAfterSeconds }. */
  function hit(key, t = now()) {
    const h = Math.floor(t / HOUR_MS);
    if (h !== hour) { hour = h; counts.clear(); logged.clear(); }
    const n = (counts.get(key) || 0) + 1;
    counts.delete(key);
    counts.set(key, n);
    while (counts.size > keyCap) counts.delete(counts.keys().next().value);
    return { limited: limit > 0 && n > limit, count: n, retryAfterSeconds: secondsToHourBoundary(t) };
  }

  /** Whether this request is a countable unpaid price check. */
  function isCounted(req) {
    const method = req.method === "HEAD" ? "GET" : req.method;
    if (method !== "GET" && method !== "POST") return false;
    const path = req.path;
    if (isExemptPath(path)) return false;
    // A POST on a GET-only route (and the reverse) runs the other verb's gate
    // chain, so a route priced under either verb is a price check here.
    if (!isPriced("GET", path) && !isPriced("POST", path)) return false;
    if (hasCredentialHeader(req.headers)) return false;
    if (isExemptUserAgent(req.headers?.["user-agent"])) return false;
    if (isMcpLoopback(req)) return false;
    try { if (isSynthetic(req)) return false; } catch { /* an unreadable token is not ours */ }
    return true;
  }

  function middleware(req, res, next) {
    if (limit <= 0) return next();
    let verdict;
    try {
      if (!isCounted(req)) return next();
      // Printable ASCII only: the token is caller text and reaches the log line below.
      const ua = uaToken(req.headers?.["user-agent"]).replace(/[^\x20-\x7e]/g, "?");
      const key = `${req.ip || req.socket?.remoteAddress || "-"}|${ua}`;
      verdict = hit(key);
      if (!verdict.limited) return next();
      throttled += 1;
      if (!logged.has(key) && logged.size < 1000) {
        logged.add(key);
        try { log(`[unpaid-budget] ${ua} passed ${limit} unpaid price checks this hour; answering 429 until the hour turns`); } catch { /* logging never breaks a response */ }
      }
    } catch { return next(); }
    res.set("Retry-After", String(verdict.retryAfterSeconds)).set("Cache-Control", "no-store");
    return res.status(429).json({
      ok: false,
      error: "rate-limited",
      hint: `Too many unpaid price checks from one client this hour (budget ${limit} per hour, per address and User-Agent). Every route and price is published at /.well-known/x402, /openapi.json and /api/pricing, and a request carrying a payment is never counted. See ${policyUrl}`,
      retryAfterSeconds: verdict.retryAfterSeconds,
    });
  }

  // Counts only: never a key, so never an address or a User-Agent.
  const stats = () => ({ budget: limit, clientsThisHour: counts.size, clientsThrottledThisHour: logged.size, throttledSinceBoot: throttled });
  return { middleware, hit, isCounted, stats };
}
