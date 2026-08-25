// Reachability of the two Postgres databases, bucketed for a PUBLIC surface.
//
// Why this exists: both Postgres containers on the platform were down from
// 2026-07-02 until a platform-side image redeploy restarted them on
// 2026-08-25 - 54 days - and nothing paged. The app degrades gracefully
// (leads/analytics simply go dark), which is right for buyers and exactly
// why nobody noticed. This is the alarm: `/api/gateway-status.databases`
// carries one bucket per database and the heartbeat opens an issue on
// "unreachable".
//
// The endpoint is public, so the answer is a STATUS WORD only - never a
// host, port, address, error text or latency (those go to the server log via
// src/db-probe.js at init time). Cached for 60 s so a poll cannot become a
// connection storm against a database that is already struggling.

const STATUS_CACHE_MS = 60_000;
const PING_TIMEOUT_MS = 5_000;

let cache = null; // { at, value }

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// `ping` resolves when `SELECT 1` answered; rejects/throws otherwise; returns
// null when that database is not configured at all.
async function bucket(ping, timeoutMs) {
  try {
    const r = await withTimeout(Promise.resolve().then(ping), timeoutMs);
    if (r === null) return "unconfigured";
    return "ok";
  } catch {
    return "unreachable";
  }
}

export async function databasesStatus({ pings, now = Date.now, timeoutMs = PING_TIMEOUT_MS, cacheMs = STATUS_CACHE_MS } = {}) {
  const t = now();
  if (cache && t - cache.at < cacheMs) return cache.value;
  let p = pings;
  if (!p) {
    const [{ pingLeadsDb }, { pingAnalyticsDb }] = await Promise.all([import("./leads-db.js"), import("./analytics-db.js")]);
    p = { leads: pingLeadsDb, analytics: pingAnalyticsDb };
  }
  const [leads, analytics] = await Promise.all([bucket(p.leads, timeoutMs), bucket(p.analytics, timeoutMs)]);
  const value = { leads: { status: leads }, analytics: { status: analytics }, checkedAt: new Date(t).toISOString() };
  cache = { at: t, value };
  return value;
}

export function resetDatabasesStatusCache() { cache = null; }
