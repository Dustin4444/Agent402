// Rolling per-tool reliability: success/failure counts and a p95 latency.
//
// Two sources, weighted differently. What OUR execute runs observed is a
// fact (we called it, we saw the answer). What a buyer reports through
// feedback is an opinion, and the feedback route is free, so it moves the
// stats half as far and a single decision can move a tool at most once per
// step (the main app keeps one verdict per decision step).
//
// Counts decay: every update multiplies the stored counts by DECAY first, so a
// tool that failed for a week and then recovered is not held to last week.

const DECAY = 0.98;
const LAT_KEEP = 64;
export const WEIGHT = { execution: 1, feedback: 0.5 };

export class Reliability {
  constructor() {
    this.stats = new Map();  // toolId -> { successes, failures, latency_p95_ms, lastSuccessAt }
    this.lat = new Map();    // toolId -> recent latencies
    this.dirty = new Set();
  }

  get(id) { return this.stats.get(id) || null; }

  load(rows) {
    for (const r of rows) this.stats.set(r.tool_id, { successes: Number(r.successes) || 0, failures: Number(r.failures) || 0, latency_p95_ms: r.latency_p95_ms ?? null, lastSuccessAt: r.last_success_at ? new Date(r.last_success_at).getTime() : null });
  }

  record({ toolId, ok, latencyMs = null, source = "execution", now = Date.now() }) {
    if (typeof toolId !== "string" || !toolId || toolId.length > 64) return false;
    const w = WEIGHT[source];
    if (!w) return false;
    const s = this.stats.get(toolId) || { successes: 0, failures: 0, latency_p95_ms: null, lastSuccessAt: null };
    s.successes = s.successes * DECAY + (ok ? w : 0);
    s.failures = s.failures * DECAY + (ok ? 0 : w);
    if (ok) s.lastSuccessAt = now;
    if (ok && Number.isFinite(latencyMs) && latencyMs > 0 && latencyMs < 600_000 && source === "execution") {
      const l = this.lat.get(toolId) || [];
      l.push(latencyMs);
      if (l.length > LAT_KEEP) l.shift();
      this.lat.set(toolId, l);
      const sorted = [...l].sort((a, b) => a - b);
      s.latency_p95_ms = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    }
    this.stats.set(toolId, s);
    this.dirty.add(toolId);
    return true;
  }

  /** Rows changed since the last flush (for persistence). */
  takeDirty() {
    const out = [...this.dirty].map((id) => ({ id, ...this.stats.get(id) }));
    this.dirty.clear();
    return out;
  }
}

export async function persistReliability(pool, rows) {
  for (const r of rows) {
    await pool.query(
      `INSERT INTO decide_tool_reliability (tool_id, successes, failures, latency_p95_ms, last_success_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (tool_id) DO UPDATE SET successes = EXCLUDED.successes, failures = EXCLUDED.failures,
         latency_p95_ms = EXCLUDED.latency_p95_ms, last_success_at = EXCLUDED.last_success_at, updated_at = now()`,
      [r.id, Math.round(r.successes), Math.round(r.failures), r.latency_p95_ms, r.lastSuccessAt ? new Date(r.lastSuccessAt) : null]);
  }
}
