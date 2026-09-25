// Per-route server time, split into our own compute and upstream wait, plus
// the in-flight request list the stall log names.
//
// Every request runs inside an AsyncLocalStorage scope; a global fetch wrapper
// adds each outbound call's wall time to the scope it was made in. On finish,
// total = time to response end, upstream = summed outbound wait, compute =
// total - upstream (a floor: overlapping outbound calls make it conservative).
// Samples go into a bounded ring per route key; percentiles are computed on
// read. Route keys are catalog routes or the first two path segments, never
// a query string or a value, and are capped in number.

import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage();
const RING = 512;
const MAX_KEYS = 300;
const routes = new Map(); // key -> { n, total: Float64Array, upstream: Float64Array, i }
const inflight = new Map(); // id -> { key, at }
let nextId = 1;
let fetchInstalled = false;

function ringFor(key) {
  let r = routes.get(key);
  if (!r) {
    if (routes.size >= MAX_KEYS) key = "(other)";
    r = routes.get(key);
    if (!r) { r = { n: 0, total: new Float64Array(RING), upstream: new Float64Array(RING), i: 0 }; routes.set(key, r); }
  }
  return r;
}

/** Record one finished request. Exported for the offline test. */
export function recordTiming(key, totalMs, upstreamMs) {
  const r = ringFor(key);
  r.total[r.i] = totalMs;
  r.upstream[r.i] = Math.min(upstreamMs, totalMs);
  r.i = (r.i + 1) % RING;
  r.n++;
}

/** Wrap global fetch so outbound wait is charged to the request that made it. */
export function installRequestTimingFetch() {
  if (fetchInstalled || typeof globalThis.fetch !== "function") return false;
  fetchInstalled = true;
  const orig = globalThis.fetch;
  globalThis.fetch = function timedFetch(...args) {
    const store = als.getStore();
    if (!store) return orig.apply(this, args);
    const t0 = performance.now();
    const p = orig.apply(this, args);
    const done = () => { store.upstreamMs += performance.now() - t0; };
    p.then(done, done);
    return p;
  };
  return true;
}

/** Express middleware. `keyOf(req)` maps a request to its route key. */
export function requestTimingMiddleware(keyOf) {
  return (req, res, next) => {
    const store = { upstreamMs: 0 };
    const t0 = performance.now();
    const id = nextId++;
    let key = "(unknown)";
    try { key = keyOf(req) || "(unknown)"; } catch { /* keep default */ }
    inflight.set(id, { key, at: Date.now() });
    const end = () => {
      if (!inflight.delete(id)) return;
      recordTiming(key, performance.now() - t0, store.upstreamMs);
    };
    res.on("finish", end);
    res.on("close", end);
    als.run(store, next);
  };
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

/** Percentiles per route: total, upstream, compute (ms). Counts only. */
export function routeTimings({ top = 40, minSamples = 1 } = {}) {
  const rows = [];
  for (const [key, r] of routes) {
    const k = Math.min(r.n, RING);
    if (k < minSamples) continue;
    const tot = Array.from(r.total.subarray(0, k)).sort((a, b) => a - b);
    const comp = Array.from(r.total.subarray(0, k), (t, j) => t - r.upstream[j]).sort((a, b) => a - b);
    const up = Array.from(r.upstream.subarray(0, k)).sort((a, b) => a - b);
    rows.push({
      route: key, count: r.n, window: k,
      totalMs: { p50: r1(pct(tot, 0.5)), p95: r1(pct(tot, 0.95)), p99: r1(pct(tot, 0.99)) },
      computeMs: { p50: r1(pct(comp, 0.5)), p95: r1(pct(comp, 0.95)), p99: r1(pct(comp, 0.99)) },
      upstreamMs: { p50: r1(pct(up, 0.5)), p95: r1(pct(up, 0.95)) },
    });
  }
  return rows.sort((a, b) => (b.computeMs.p95 ?? 0) - (a.computeMs.p95 ?? 0)).slice(0, top);
}

/** The oldest in-flight requests (route key + age), for the stall log. */
export function oldestInFlight(n = 3) {
  const now = Date.now();
  return [...inflight.values()].sort((a, b) => a.at - b.at).slice(0, n).map((x) => `${x.key} ${now - x.at}ms`);
}

export function inFlightCount() { return inflight.size; }

/** Test hook. */
export function __resetTimingForTest() { routes.clear(); inflight.clear(); }
