// Agent wish loop: capture demand for tools we don't have yet, instead of
// losing it silently when a caller finds nothing useful and leaves. This
// module is the write path + aggregate view for that signal: free text ->
// normalized cluster -> (eventually) a real tool.
//
// Storage: append-only JSONL, one record per line. Same volume contract as
// stats.js/pow.js (persist to /data when mounted) but the fallback is
// SILENT — losing wish history on a restart is an acceptable tradeoff for a
// demand-signal feature, unlike payment counters or PoW replay state, so
// there's no production hard-stop here.
import {
  existsSync, statSync, readFileSync, appendFileSync,
  openSync, readSync, closeSync,
} from "node:fs";
import { join } from "node:path";
import { logSafe } from "./log-safe.js";

const HAS_DATA_DIR = existsSync("/data");
const DATA_DIR = HAS_DATA_DIR ? "/data" : "/tmp";
let WISH_FILE = join(DATA_DIR, "wishes.jsonl");
export const wishStoragePersistent = HAS_DATA_DIR;

const NEED_MAX = 500;
const CONTEXT_MAX = 300;
const MAX_READ_BYTES = 5 * 1024 * 1024; // 5MB boot-read cap; beyond that, tail only.
const CLUSTER_CAP = 20_000; // bound in-memory distinct-cluster growth

// Rate limits: mirrors the /api/index/register pattern in server.js — a
// per-IP sliding window plus a global sliding window, checked in that order.
// Find-miss records (implicit, server-generated) are exempt: they're capped
// naturally by /api/find's own traffic and the file-line cap below, and
// penalizing a caller for a search that happened to miss would be wrong.
const IP_WINDOW_MS = 3_600_000; // 1 hour
const IP_MAX = 10;
const GLOBAL_WINDOW_MS = 24 * 3_600_000; // 1 day
const GLOBAL_MAX = 100;

let MAX_LINES = 50_000;

let ipHits = new Map(); // ip -> timestamp[]
let globalHits = [];
let clusters = new Map(); // normalizedKey -> { count, firstSeen, lastSeen, sources, issueOpened }
let lineCount = 0;
let capReached = false;

// Threshold at which a repeated cluster is loud-logged as worth building. No
// GitHub API call from the server (no token in prod) — /api/wishes exposes
// the aggregate so a scheduled workflow can poll it and open the issue.
export const WISH_THRESHOLD = 5;

// A raw count is not enough to auto-open a public GitHub issue: one script can
// POST the same string 5 times in a minute (observed 2026-07-17: a single
// source drove a cluster to 100+ identical hits in a few hours, minting three
// junk issues). A cluster QUALIFIES only when it also shows independence —
// either corroboration across ≥2 distinct sources (api / mcp / find-miss), or
// demand sustained past QUALIFY_MIN_SPAN_MS. A genuine gap is hit by different
// agents across different surfaces, or recurs over days; a scripted burst is
// one source in one sitting and clears neither bar. Honest limit (same framing
// as the router's per-seller Sybil cap): a patient spammer can still drip over
// 24h or add a decoy hit on a second surface — this raises the cost from "5
// curls" to "sustained or multi-surface", it doesn't make gaming impossible.
// The wish is always recorded and visible on /api/wishes regardless; this gate
// only governs which clusters auto-open an issue.
export const QUALIFY_MIN_SPAN_MS = 24 * 3_600_000; // 24h

// Does a cluster's shape clear the anti-spam bar described above? Exported so
// the wish-issues workflow's gate and the unit tests share one definition.
export function clusterQualifies(c) {
  if (!c || c.count < WISH_THRESHOLD) return false;
  const distinctSources = ["api", "mcp", "find-miss"].filter((s) => (c.sources?.[s] || 0) > 0).length;
  const spanMs = (c.lastSeen || 0) - (c.firstSeen || 0);
  return distinctSources >= 2 || spanMs >= QUALIFY_MIN_SPAN_MS;
}

/**
 * Served-overlay for the operator board: mark every cluster whose text NOW
 * finds a real catalog tool. A qualified cluster is a demand signal only
 * while the catalog can't answer it - the "minia2a" cluster (2026-07-28)
 * stayed qualified for 8 days AFTER the tools it asked for shipped, because
 * qualification looks at count/span/sources, never at the catalog. scoreFn
 * is injected (server wires findTools + CATALOG) so this stays pure and the
 * threshold lives with the caller. Mutates and returns the same array.
 */
export function annotateServed(clusters, scoreFn, minScore) {
  for (const c of clusters || []) {
    try {
      const top = scoreFn(c.text);
      if (top && top.score >= minScore) c.served = { slug: top.slug, score: top.score };
    } catch { /* annotation is best-effort - the board must render regardless */ }
  }
  return clusters;
}

const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function normalize(s) {
  return String(s || "").toLowerCase().trim().replace(/\s+/g, " ");
}

function upsertCluster(key, source, ts) {
  let c = clusters.get(key);
  if (!c) {
    if (clusters.size >= CLUSTER_CAP) {
      // Overflow guard: never grow the in-memory map without bound. The
      // caller still gets a normal { recorded: true } response - dropping a
      // never-before-seen distinct wish silently is preferable to an
      // unbounded map or a crash.
      return { count: 1, firstSeen: ts, lastSeen: ts, sources: { [source]: 1 }, issueOpened: false, __overflow: true };
    }
    c = { count: 0, firstSeen: ts, lastSeen: ts, sources: { api: 0, mcp: 0, "find-miss": 0 }, issueOpened: false };
    clusters.set(key, c);
  }
  c.count++;
  c.lastSeen = ts;
  c.sources[source] = (c.sources[source] || 0) + 1;
  return c;
}

function appendLine(obj) {
  if (capReached) return;
  try {
    appendFileSync(WISH_FILE, JSON.stringify(obj) + "\n");
    lineCount++;
    if (lineCount >= MAX_LINES) {
      capReached = true;
      console.warn(`[wish] file line cap (${MAX_LINES}) reached at ${WISH_FILE} - further wishes are still counted/clustered but no longer written to disk.`);
    }
  } catch {
    /* best-effort write-through; never throw from the write path */
  }
}

function readTail(path, maxBytes) {
  const st = statSync(path);
  if (st.size <= maxBytes) return { text: readFileSync(path, "utf8"), truncated: false, size: st.size };
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    readSync(fd, buf, 0, maxBytes, st.size - maxBytes);
    return { text: buf.toString("utf8"), truncated: true, size: st.size };
  } finally {
    closeSync(fd);
  }
}

/**
 * Rebuild the in-memory cluster map (and approximate lineCount) from the
 * JSONL file at boot. Reads at most MAX_READ_BYTES - beyond that only the
 * tail is read, and lineCount is estimated from the sample's average line
 * length so the 50k-line cap still engages near the real boundary. Never
 * throws: a missing or corrupt file just means starting from empty state.
 */
function rebuildFromFile() {
  clusters = new Map();
  lineCount = 0;
  capReached = false;
  if (!existsSync(WISH_FILE)) return;
  try {
    const { text, truncated, size } = readTail(WISH_FILE, MAX_READ_BYTES);
    let lines = text.split("\n").filter(Boolean);
    // A truncated read may start mid-line; drop the (possibly partial) first line.
    if (truncated && lines.length) lines.shift();
    for (const line of lines) {
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec && rec.type === "threshold" && typeof rec.key === "string") {
        const c = clusters.get(rec.key);
        if (c) c.issueOpened = true;
        continue;
      }
      if (rec && typeof rec.need === "string") {
        const key = normalize(rec.need);
        if (key) upsertCluster(key, ["api", "mcp", "find-miss"].includes(rec.source) ? rec.source : "api", rec.ts || Date.now());
      }
    }
    if (!truncated) {
      lineCount = lines.length;
    } else {
      const avgLineLen = text.length / Math.max(lines.length, 1);
      lineCount = Math.round(size / Math.max(avgLineLen, 1));
      if (lineCount >= MAX_LINES) capReached = true;
    }
  } catch {
    /* best-effort rebuild; start clean on any surprise */
  }
}
rebuildFromFile();

function checkRateLimit(ip) {
  const now = Date.now();
  const key = ip || "?";
  const mine = (ipHits.get(key) || []).filter((t) => now - t < IP_WINDOW_MS);
  if (mine.length >= IP_MAX) return { limited: true, reason: `rate limit: ${IP_MAX} wishes per hour per IP` };
  const globalMine = globalHits.filter((t) => now - t < GLOBAL_WINDOW_MS);
  if (globalMine.length >= GLOBAL_MAX) {
    globalHits = globalMine;
    return { limited: true, reason: `rate limit: wish intake is busy, try again later` };
  }
  mine.push(now); ipHits.set(key, mine);
  globalMine.push(now); globalHits = globalMine;
  return { limited: false };
}

/**
 * Record a "we don't have this tool" signal. `need` is required free text
 * (max 500 chars); `context` is optional free text (max 300).
 * `source` is "api" | "mcp" | "find-miss" - find-miss records are implicit
 * (a /api/find or find_tool query that matched nothing useful) and are
 * exempt from the rate limit, since they're not a user directly hitting an
 * endpoint. Throws Error with .statusCode on bad input (400) or over the
 * rate limit (429); otherwise best-effort (a disk write failure never
 * throws — it just silently doesn't persist that line).
 */
export function recordWish({ need, context, source, ip } = {}) {
  const src = source === "mcp" || source === "find-miss" ? source : "api";
  if (typeof need !== "string" || !need.trim()) {
    const e = new Error("`need` is required and must be non-empty text");
    e.statusCode = 400;
    throw e;
  }
  if (context != null && typeof context !== "string") {
    const e = new Error("`context` must be a string when provided");
    e.statusCode = 400;
    throw e;
  }
  const needTrimmed = need.trim().slice(0, NEED_MAX);
  const contextTrimmed = typeof context === "string" && context.trim() ? context.trim().slice(0, CONTEXT_MAX) : undefined;

  const key = normalize(needTrimmed);
  if (!key) {
    const e = new Error("`need` has no usable content after normalization");
    e.statusCode = 400;
    throw e;
  }

  const exempt = src === "find-miss";
  if (!exempt) {
    const rl = checkRateLimit(ip);
    if (rl.limited) {
      const e = new Error(rl.reason);
      e.statusCode = 429;
      throw e;
    }
  }

  const now = Date.now();
  const cluster = upsertCluster(key, src, now);
  appendLine({ need: needTrimmed, context: contextTrimmed, source: src, ts: now });

  if (!exempt && !cluster.__overflow && cluster.count === WISH_THRESHOLD && !cluster.issueOpened) {
    cluster.issueOpened = true;
    console.warn(`[wish-threshold] cluster "${logSafe(key)}" hit ${WISH_THRESHOLD} signals`);
    appendLine({ type: "threshold", key, ts: now });
  }

  return { recorded: true, cluster: { count: cluster.count } };
}

/**
 * Aggregate view for /api/wishes: normalized text, count, per-source
 * breakdown, first/last seen, and whether the threshold-crossing log already
 * fired. Deliberately excludes raw `context` - that field is free text
 * supplied by callers and never belongs on a public surface. `text` is
 * esc()'d in case this ever gets rendered on an HTML surface later.
 */
/**
 * Wish aggregate. Two modes:
 *  - detailed:true (operator dashboard + the wish-issues bridge, both
 *    token-gated) — every cluster's normalized text, per-source counts,
 *    timestamps, and qualification verdict.
 *  - detailed:false (DEFAULT, the public /api/wishes) — a BEACON only:
 *    headline totals plus qualified-cluster COUNT, no per-cluster text or
 *    counts. The itemized demand board is strategic intel (which unmet
 *    agent needs to build against, and how hot each is) that a competitor
 *    should not be able to poll for free — while "there is real demand
 *    here, come sell" stays public to pull sellers in. The paid demand-radar
 *    tool sells the analysis layer; this keeps the raw list off the free path.
 */
export function getWishesAggregate({ limit = 200, detailed = false } = {}) {
  const cap = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 500);
  const base = {
    distinctClusters: clusters.size,
    totalWishes: [...clusters.values()].reduce((s, c) => s + c.count, 0),
    threshold: WISH_THRESHOLD,
    qualifyMinSpanHours: QUALIFY_MIN_SPAN_MS / 3_600_000,
  };
  if (!detailed) {
    // Public beacon: aggregates only. Expose how many clusters are hot enough
    // to matter, never WHICH — no text, no per-cluster counts, no timestamps.
    return { ...base, qualifiedClusters: [...clusters.values()].filter(clusterQualifies).length };
  }
  const rows = [...clusters.entries()]
    .sort((a, b) => b[1].count - a[1].count || b[1].lastSeen - a[1].lastSeen)
    .slice(0, cap)
    .map(([key, c]) => ({
      text: esc(key),
      count: c.count,
      sources: { api: c.sources.api || 0, mcp: c.sources.mcp || 0, "find-miss": c.sources["find-miss"] || 0 },
      firstSeen: new Date(c.firstSeen).toISOString(),
      lastSeen: new Date(c.lastSeen).toISOString(),
      issueOpened: !!c.issueOpened,
      // The gate the wish-issues workflow selects on. count >= threshold is
      // necessary but not sufficient — see clusterQualifies / QUALIFY_MIN_SPAN_MS.
      qualified: clusterQualifies(c),
    }));
  return { ...base, clusters: rows };
}

// --- test-only hooks (mirror the __testResetSubmitted style in x402-index.js) ---
// Both reset the rate-limit buckets too — a test switching storage wants a
// fully isolated instance, not just a fresh file.
export function __testSetFilePath(path) {
  WISH_FILE = path;
  ipHits = new Map();
  globalHits = [];
  rebuildFromFile();
}
export function __testReset() {
  ipHits = new Map();
  globalHits = [];
  rebuildFromFile();
}
export function __testSetLineCap(n) {
  MAX_LINES = n == null ? 50_000 : n;
}
export function __testState() {
  return { lineCount, capReached, clusterCount: clusters.size, file: WISH_FILE };
}
