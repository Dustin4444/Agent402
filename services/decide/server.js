// The decide service: a separate Railway service that owns the decision
// index and (from phase 2) plan building. It never settles a payment and
// never sits in the paid-call path of any other route: the main app verifies
// payment, then calls this service over the private network with a timeout.
//
// Env:
//   PORT                     listen port
//   DECIDE_INTERNAL_TOKEN    shared secret with the main app (both directions)
//   DECIDE_SOURCE_URL        main app base, e.g. http://agent402.railway.internal:8080
//   DECIDE_DATABASE_URL      Postgres (falls back to DATABASE_URL); unset = memory only
//   OPENAI_API_KEY           embeddings
//   DECIDE_SYNC_MS           index sync period (default 30 min)

import http from "node:http";
import pg from "pg";
import { timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ToolIndex } from "./tool-index.js";
import { PgToolStore, MemoryToolStore } from "./tool-store.js";
import { migrate } from "./migrations.js";
import { syncIndex, loadIndex } from "./sync.js";
import { embedTexts, embedBudgetStatus } from "./embed.js";
import { decideConfig } from "./config.js";
import { makeLlm } from "./llm.js";
import { buildDecision, parseDecideInput, cacheKeyFor } from "./planner.js";
import { MemoryDecisionStore, PgDecisionStore, makeGate, makeDecisionCache } from "./decision-store.js";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT) || 8090;
const TOKEN = String(process.env.DECIDE_INTERNAL_TOKEN || "");
const SOURCE = String(process.env.DECIDE_SOURCE_URL || "").replace(/\/+$/, "");
const DB_URL = process.env.DECIDE_DATABASE_URL || process.env.DATABASE_URL || "";
const SYNC_MS = Number(process.env.DECIDE_SYNC_MS) || 30 * 60_000;
const MAX_BODY = 16 * 1024;

export const state = { index: new ToolIndex(), store: null, pool: null, lastSync: null, syncing: false, bootedAt: Date.now(), loadedRows: 0,
  decisions: new MemoryDecisionStore(), reliability: new Map(), llm: null, gate: makeGate(Number(process.env.DECIDE_MAX_CONCURRENT) || 4, Number(process.env.DECIDE_MAX_QUEUE) || 16),
  cache: makeDecisionCache(decideConfig().cacheTtlMs) };

const newDecisionId = () => `dec_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

/** Build (or reuse from cache) a decision. A cache hit is a new decision with
 *  its own id: the caller paid for it, so it is recorded like any other. */
export async function decide(body, { now = Date.now() } = {}) {
  const input = parseDecideInput(body);
  const cfg = decideConfig();
  const key = cacheKeyFor(input.task, input.constraints, input.depth);
  let result = state.cache.get(key, now);
  let cached = false;
  if (result) {
    result = { ...structuredClone(result), decisionId: newDecisionId() };
    cached = true;
  } else {
    result = await state.gate.run(() => buildDecision(input, {
      index: state.index,
      embed: (t) => embedTexts(t),
      llm: state.llm || (state.llm = makeLlm({ models: [cfg.model, cfg.modelFallback] })),
      reliability: (id) => state.reliability.get(id) || null,
      cfg, now,
    }));
    if (!result.partial) state.cache.set(key, result, now);
  }
  const { _rankingLog, ...pub } = result;
  await state.decisions.save(pub, { constraints: input.constraints, cacheKey: key, payer: body.payer || null, rail: body.rail || null, priceUsd: Number(body.priceUsd) || 0, rankingLog: _rankingLog || [] });
  return { ...pub, cached };
}

function tokenOk(req) {
  if (TOKEN.length < 24) return false;
  const got = Buffer.from(String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);
}

async function source() {
  const res = await fetch(`${SOURCE}/__internal/decide/tools.ndjson`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!res.ok) throw new Error(`index source HTTP ${res.status}`);
  return res.body;
}

export async function runSync() {
  if (state.syncing || !SOURCE || TOKEN.length < 24) return null;
  state.syncing = true;
  try {
    state.lastSync = await syncIndex({ index: state.index, store: state.store, source, embed: (t) => embedTexts(t) });
    console.log("[decide] sync", JSON.stringify(state.lastSync));
  } catch (e) {
    state.lastSync = { error: String(e?.message || e).slice(0, 200), at: Date.now() };
    console.warn("[decide] sync failed:", state.lastSync.error);
  } finally {
    state.syncing = false;
  }
  return state.lastSync;
}

function send(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

async function readJson(req) {
  let n = 0; const chunks = [];
  for await (const c of req) { n += c.length; if (n > MAX_BODY) throw Object.assign(new Error("body too large"), { statusCode: 413 }); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw Object.assign(new Error("invalid JSON"), { statusCode: 400 }); }
}

export const routes = {
  "GET /health": async () => ({ ok: true, rows: state.index.size, vectors: state.index.vectors.count, lastSync: state.lastSync, embed: embedBudgetStatus(), db: !!state.pool, gate: state.gate.stats(), llm: state.llm?.stats() || null, cached: state.cache.size() }),
  "POST /internal/search": async (req) => {
    const b = await readJson(req);
    const query = String(b.query || "").slice(0, 500);
    if (!query) throw Object.assign(new Error('"query" is required'), { statusCode: 400 });
    let queryVec = null;
    try { [queryVec] = await embedTexts([query]); } catch { /* lexical-only */ }
    const r = state.index.search({ query, queryVec, constraints: b.constraints || {}, k: Math.min(50, Number(b.k) || 20) });
    return { mode: r.mode, candidates: r.candidates, hits: r.hits.map((h) => ({ id: h.id, rrf: h.rrf, slug: h.row.slug, seller: h.row.seller, firstParty: h.row.firstParty, priceUsd: h.row.priceUsd, name: h.row.name })) };
  },
  "POST /internal/sync": async () => runSync(),
  "POST /internal/decide": async (req) => decide(await readJson(req)),
  "POST /internal/decision": async (req) => {
    const b = await readJson(req);
    const d = await state.decisions.get(String(b.decisionId || ""));
    if (!d) throw Object.assign(new Error("unknown decision"), { statusCode: 404 });
    return d;
  },
};

export function handler(req, res) {
  const key = `${req.method} ${req.url.split("?")[0]}`;
  const fn = routes[key];
  if (!fn) return send(res, 404, { error: "Not found" });
  if (key !== "GET /health" && !tokenOk(req)) return send(res, 404, { error: "Not found" });
  fn(req).then((out) => send(res, 200, out)).catch((e) => {
    if (e.retryAfter) res.setHeader("Retry-After", String(e.retryAfter));
    if (!e.statusCode) console.warn("[decide] handler error:", String(e?.stack || e).slice(0, 400));
    send(res, e.statusCode || 500, { error: e.statusCode ? e.message : "internal error" });
  });
}

async function boot() {
  if (DB_URL) {
    state.pool = new pg.Pool({ connectionString: DB_URL, max: 5, connectionTimeoutMillis: 20_000, ssl: /railway\.internal/.test(DB_URL) ? false : { rejectUnauthorized: false } });
    await migrate(state.pool);
    state.store = new PgToolStore(state.pool);
    state.decisions = new PgDecisionStore(state.pool);
  } else {
    state.store = new MemoryToolStore();
    console.warn("[decide] no database configured: index lives in memory only");
  }
  state.loadedRows = await loadIndex({ index: state.index, store: state.store });
  console.log(`[decide] loaded ${state.loadedRows} rows, ${state.index.vectors.count} vectors`);
  http.createServer(handler).listen(PORT, () => console.log(`[decide] listening on ${PORT}`));
  setTimeout(runSync, 15_000).unref();
  setInterval(runSync, SYNC_MS).unref();
}

const isMain = (() => { try { return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url; } catch { return false; } })();
if (isMain) {
  boot().catch((e) => { console.error("[decide] boot failed:", e); process.exit(1); });
}
