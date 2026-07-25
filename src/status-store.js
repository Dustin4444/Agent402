// Probe history for the public status page (/status).
//
// WHY THIS EXISTS
//   A status page served by the system it describes cannot honestly report its
//   own outage — if we were down, nothing here was running to notice. So the
//   observations are made OUTSIDE the server, by the heartbeat workflow running
//   on GitHub Actions every 15 minutes, and merely stored here. Uptime on
//   /status is "what an external observer saw", not "what we say about
//   ourselves", and every figure links back to the run that produced it.
//
//   A consequence worth understanding: when production is down, the heartbeat's
//   POST to this store fails too, so the outage appears as a GAP rather than a
//   row of zeros. Gaps are therefore treated as unobserved, never as uptime.
//   `dailyUptime` reports the observation count next to every percentage so a
//   thinly-sampled day can never masquerade as a well-measured one.
//
// The table is idempotent by (source, component, ts) so the one-time GitHub
// Actions backfill can be re-run safely.
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";

const HAS_DATA_DIR = existsSync("/data");
// STATUS_DB_PATH lets the offline tests point at a scratch file. Production
// uses the persistent volume; without it we fall back to /tmp, which loses
// history on restart but never blocks a boot.
const DB_PATH = process.env.STATUS_DB_PATH || `${HAS_DATA_DIR ? "/data" : "/tmp"}/status.db`;

let db = null;
function open() {
  if (db) return db;
  try {
    const dir = DB_PATH.replace(/\/[^/]+$/, "");
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS status_probes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        source TEXT NOT NULL,
        component TEXT NOT NULL,
        ok INTEGER NOT NULL,
        detail TEXT,
        url TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS status_probes_unique ON status_probes (source, component, ts);
      CREATE INDEX IF NOT EXISTS status_probes_ts ON status_probes (component, ts);
    `);
  } catch (e) {
    // A status page must never be the reason the server fails to boot.
    console.error("[status-store] disabled (cannot open DB):", e?.message || e);
    db = null;
  }
  return db;
}

/** True when history is being persisted somewhere that survives a restart. */
export function statusPersistent() {
  return Boolean(open()) && (DB_PATH.startsWith("/data") || Boolean(process.env.STATUS_DB_PATH));
}

/** Insert one observation. Ignores duplicates so a backfill can be re-run. */
export function recordProbe({ ts, source, component, ok, detail = null, url = null }) {
  const d = open();
  if (!d) return false;
  try {
    d.prepare(
      "INSERT OR IGNORE INTO status_probes (ts, source, component, ok, detail, url) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(Math.floor(Number(ts)), String(source), String(component), ok ? 1 : 0, detail ? String(detail).slice(0, 500) : null, url ? String(url).slice(0, 300) : null);
    return true;
  } catch (e) {
    console.error("[status-store] recordProbe failed:", e?.message || e);
    return false;
  }
}

/** Insert many observations in one transaction (the backfill path). */
export function recordProbes(rows) {
  const d = open();
  if (!d) return 0;
  const stmt = d.prepare(
    "INSERT OR IGNORE INTO status_probes (ts, source, component, ok, detail, url) VALUES (?, ?, ?, ?, ?, ?)",
  );
  let written = 0;
  const tx = d.transaction((list) => {
    for (const r of list) {
      const res = stmt.run(
        Math.floor(Number(r.ts)), String(r.source), String(r.component), r.ok ? 1 : 0,
        r.detail ? String(r.detail).slice(0, 500) : null, r.url ? String(r.url).slice(0, 300) : null,
      );
      written += res.changes;
    }
  });
  try { tx(rows || []); } catch (e) { console.error("[status-store] recordProbes failed:", e?.message || e); }
  return written;
}

/** Raw observations for a component, oldest first. */
export function probeRows(component, sinceMs) {
  const d = open();
  if (!d) return [];
  return d
    .prepare("SELECT ts, ok, detail, url, source FROM status_probes WHERE component = ? AND ts >= ? ORDER BY ts ASC")
    .all(String(component), Math.floor(sinceMs));
}

/** Components we have ever observed, plus their most recent observation.
 *
 *  Keyed on MAX(ts), deliberately NOT MAX(id): the backfill inserts historical
 *  observations after live ones, so insertion order does not track time. Using
 *  the newest id would let a backfilled row from weeks ago present itself as
 *  the current state of a component. */
export function latestByComponent() {
  const d = open();
  if (!d) return [];
  return d
    .prepare(
      `SELECT component, ts, ok, detail, url FROM status_probes p
       WHERE ts = (SELECT MAX(ts) FROM status_probes q WHERE q.component = p.component)
       GROUP BY component
       ORDER BY component ASC`,
    )
    .all();
}

export function earliestObservation() {
  const d = open();
  if (!d) return null;
  const r = d.prepare("SELECT MIN(ts) AS ts FROM status_probes").get();
  return r?.ts ?? null;
}

export function totalObservations() {
  const d = open();
  if (!d) return 0;
  return d.prepare("SELECT COUNT(*) AS n FROM status_probes").get()?.n ?? 0;
}

// ── Pure aggregation (exported for scripts/test-status-store.js) ─────────────

/** Uptime over a window. `observed` is reported alongside the percentage on
 *  purpose: 100% of two probes is not the same claim as 100% of two thousand,
 *  and a status page that hides the denominator is telling a story rather than
 *  reporting a measurement. Returns pct null when nothing was observed. */
export function uptimeFrom(rows) {
  const observed = rows.length;
  const up = rows.reduce((n, r) => n + (r.ok ? 1 : 0), 0);
  return { observed, up, down: observed - up, pct: observed ? +((up / observed) * 100).toFixed(4) : null };
}

/** Bucket observations into UTC days, newest last. Days with no observation
 *  are emitted with observed:0 and pct:null — rendered as "no data", never as
 *  a green bar, because we did not measure them. */
export function dailyFrom(rows, { days, nowMs }) {
  const DAY = 86400000;
  const endDay = Math.floor(nowMs / DAY);
  const buckets = new Map();
  for (let i = days - 1; i >= 0; i--) {
    const dayIndex = endDay - i;
    buckets.set(dayIndex, { date: new Date(dayIndex * DAY).toISOString().slice(0, 10), observed: 0, up: 0 });
  }
  for (const r of rows) {
    const dayIndex = Math.floor(r.ts / DAY);
    const b = buckets.get(dayIndex);
    if (!b) continue;
    b.observed++;
    if (r.ok) b.up++;
  }
  return [...buckets.values()].map((b) => ({
    ...b,
    down: b.observed - b.up,
    pct: b.observed ? +((b.up / b.observed) * 100).toFixed(4) : null,
  }));
}

/** Collapse consecutive failed observations into incidents. A single failed
 *  probe is still an incident — it means a real request failed — but grouping
 *  keeps a two-hour outage from rendering as eight separate events. */
export function incidentsFrom(rows, { gapMs = 2 * 3600_000 } = {}) {
  const incidents = [];
  let cur = null;
  for (const r of rows) {
    if (r.ok) { cur = null; continue; }
    if (cur && r.ts - cur.endedAt <= gapMs) {
      cur.endedAt = r.ts;
      cur.probes++;
      if (r.detail && !cur.detail) cur.detail = r.detail;
      continue;
    }
    cur = { startedAt: r.ts, endedAt: r.ts, probes: 1, detail: r.detail || null, url: r.url || null };
    incidents.push(cur);
  }
  return incidents
    .map((i) => ({ ...i, durationMs: Math.max(0, i.endedAt - i.startedAt) }))
    .sort((a, b) => b.startedAt - a.startedAt);
}

/** Current state of a component from its newest observation.
 *  `stale` matters: a component whose last observation is old is NOT
 *  "operational", it is unmeasured, and saying otherwise would be the exact
 *  self-reporting failure this module exists to avoid. */
export function stateFrom(latest, { nowMs, staleAfterMs = 45 * 60_000 }) {
  if (!latest) return { state: "unknown", reason: "never observed" };
  const age = nowMs - latest.ts;
  if (age > staleAfterMs) return { state: "unknown", reason: "no recent observation", ageMs: age };
  return { state: latest.ok ? "operational" : "outage", ageMs: age, detail: latest.detail || null };
}

export function _resetForTest() {
  if (db) { try { db.close(); } catch { /* ignore */ } }
  db = null;
}
