// Shared per-IP sliding-window rate limiter used by both the hosted MCP free
// tier (src/mcp-http.js) and the direct HTTP PoW redemption path
// (src/server.js). One implementation, one quota: a client that exhausts the
// MCP free tier cannot then keep hammering /api/* with PoW solutions to get
// effectively unlimited free calls. The default window/burst are tuned for
// $0.001-grade CPU tools; the same env knobs that lift the MCP cap for
// internal sweeps also lift the HTTP path.

const WINDOW_MS = 60 * 60 * 1000;
const BURST_WINDOW_MS = 60 * 1000;

export const MAX_CALLS_PER_WINDOW =
  Number(process.env.AGENT402_MCP_MAX_PER_HOUR) || 120;
export const MAX_CALLS_PER_BURST =
  Number(process.env.AGENT402_MCP_MAX_PER_MIN) || 20;

// One bucket table per logical surface so the MCP free tier and the direct
// HTTP free tier each get their own per-IP history. They use the SAME limits,
// but mixing them in one bucket would mean an MCP burst silently throttles a
// later x402-paid call on the same IP (because some routes are PoW-eligible
// even for buyers). Separate buckets, shared policy.
export function createLimiter(name = "default", { perMin = MAX_CALLS_PER_BURST, perHour = MAX_CALLS_PER_WINDOW } = {}) {
  const buckets = new Map(); // ip -> number[] timestamps
  const prune = (hits, now) => { while (hits.length && hits[0] < now - WINDOW_MS) hits.shift(); };
  const over = (hits, now) =>
    hits.length >= perHour || hits.filter((t) => t > now - BURST_WINDOW_MS).length >= perMin;
  function check(ip) {
    const now = Date.now();
    let hits = buckets.get(ip);
    if (!hits) buckets.set(ip, (hits = []));
    prune(hits, now);
    if (over(hits, now)) return { limited: true, name };
    hits.push(now);
    return { limited: false, name };
  }
  // Is this key ALREADY over budget, WITHOUT spending any of it?
  //
  // check() is test-and-record in one step, which is right when every call is
  // the thing being metered. It is wrong when the budget must be consulted on a
  // request that should not itself count - notably an auth gate that meters only
  // FAILURES: calling check() there would charge the successful operator for
  // every page load and lock them out of their own dashboard.
  function peek(ip) {
    const now = Date.now();
    const hits = buckets.get(ip);
    if (!hits) return { limited: false, name };
    prune(hits, now);
    return { limited: over(hits, now), name };
  }
  // Forget a key's history. For flows where a stronger proof of identity
  // supersedes the failures counted so far (e.g. a successful login), so a
  // legitimate operator always has a way back in.
  const reset = (ip) => { buckets.delete(ip); };
  // Bound the table: drop empty/stale buckets occasionally.
  setInterval(() => {
    const cutoff = Date.now() - WINDOW_MS;
    for (const [ip, hits] of buckets) {
      while (hits.length && hits[0] < cutoff) hits.shift();
      if (!hits.length) buckets.delete(ip);
    }
  }, 10 * 60 * 1000).unref();
  return { check, peek, reset };
}

export const LIMITS_LABEL = `${MAX_CALLS_PER_BURST}/min, ${MAX_CALLS_PER_WINDOW}/hour per client`;
