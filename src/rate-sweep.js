// F21: bounded rate-limit bookkeeping.
//
// A per-IP "hits" map (ip -> [timestamps]) only prunes an entry when the SAME ip
// comes back, so a flood of one-time IPs accumulates keys without bound. And a
// per-IP limit alone lets a distributed source (many IPs, each under the limit)
// mass-submit. These two primitives close both:
//
//   sweepStaleTsMap  — evict keys whose timestamps are all older than the window.
//                      Run on a periodic timer AND inline when a map grows large.
//   makeWindowCounter — a global rolling-window counter: the aggregate ceiling a
//                      distributed source can't slip under.

/**
 * Delete every key of `map` (ip -> number[] of ms timestamps) whose timestamps
 * are all older than `windowMs`; keep the live subset otherwise. Mutates and
 * returns `map`.
 */
export function sweepStaleTsMap(map, windowMs, now = Date.now()) {
  for (const [k, ts] of map) {
    const live = ts.filter((t) => now - t < windowMs);
    if (live.length) map.set(k, live);
    else map.delete(k);
  }
  return map;
}

/**
 * Aggregate rolling-window counter. `allow()` records the hit and returns true
 * while fewer than `limit` hits fall inside the last `windowMs`, false once the
 * window is full. Not keyed by IP — this is the global ceiling.
 */
export function makeWindowCounter(windowMs, limit) {
  let hits = [];
  return {
    allow(now = Date.now()) {
      hits = hits.filter((t) => now - t < windowMs);
      if (hits.length >= limit) return false;
      hits.push(now);
      return true;
    },
    size() {
      return hits.length;
    },
  };
}
