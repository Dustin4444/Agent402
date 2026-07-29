// Lightweight operational counters for the machine-to-machine economy: how many
// tool calls have been served, split by settlement method (USDC payment vs
// proof-of-work). Money itself is verifiable on-chain at the wallet — this is
// just the operational tally, persisted so it survives restarts.
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Counters + recent-calls + meta live in /data (persistent volume) so they
// survive redeploys — recentCalls is the live activity feed on the landing
// page, and a silent fallback to /tmp would wipe it on every container
// restart. Mirrors the same contract as pow.js: refuse to boot in production
// without /data unless an explicit ephemeral opt-in is set (local tests,
// FREE_MODE sweeps, edge runners). Exported as `statsPersistent` so /health
// can surface which path was actually picked.
const HAS_DATA_DIR = existsSync("/data");
const ALLOW_EPHEMERAL =
  process.env.STATS_ALLOW_EPHEMERAL === "true" ||
  process.env.FREE_MODE === "true" ||
  process.env.NODE_ENV !== "production";
if (!HAS_DATA_DIR && !ALLOW_EPHEMERAL) {
  console.error(
    "Stats DB has no persistent volume (/data missing) and NODE_ENV=production. Mount /data, or set STATS_ALLOW_EPHEMERAL=true to accept losing recentCalls + counters on restart."
  );
  process.exit(1);
}
const DATA_DIR = HAS_DATA_DIR ? "/data" : "/tmp";
export const statsPersistent = HAS_DATA_DIR;
const db = new Database(join(DATA_DIR, "agent402-stats.db"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS counters (k TEXT PRIMARY KEY, n INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS tool_counts (slug TEXT PRIMARY KEY, n INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS recent_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, method TEXT NOT NULL, ts INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS paid_tool_counts (slug TEXT PRIMARY KEY, n INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS heartbeat_tool_counts (slug TEXT PRIMARY KEY, n INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS charged_failures (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, status INTEGER NOT NULL, ts INTEGER NOT NULL);
  -- Daily served-call tally by settlement method. The lifetime counters above
  -- answer "how much free-tier adoption is there"; they cannot answer "is it
  -- growing", and recent_calls is pruned to RECENT_KEEP (200 rows) so it can
  -- never be the source of a time series. One row per (day, method) — three
  -- methods x 365 days is ~1k rows a year, so this is never pruned.
  CREATE TABLE IF NOT EXISTS daily_calls (day TEXT NOT NULL, method TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, method));
  -- Outbound PAID-upstream call meter, day-bucketed (2026-07-29). The in-memory
  -- meter in search.js resets on every redeploy, so it cannot reconcile a
  -- billing MONTH against the provider's dashboard; this table is the
  -- deploy-proof series that can. One row per (day, upstream, caller) -
  -- a handful of upstreams x a handful of callers x 365 days - never pruned.
  CREATE TABLE IF NOT EXISTS daily_upstream_calls (day TEXT NOT NULL, upstream TEXT NOT NULL, caller TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, upstream, caller));
`);

const RECENT_KEEP = 200; // rows retained
const RECENT_SHOW = 25;  // rows exposed in /api/stats

const bumpCounter = db.prepare("INSERT INTO counters (k, n) VALUES (?, 1) ON CONFLICT(k) DO UPDATE SET n = n + 1");
const bumpTool = db.prepare("INSERT INTO tool_counts (slug, n) VALUES (?, 1) ON CONFLICT(slug) DO UPDATE SET n = n + 1");
const getCounter = db.prepare("SELECT n FROM counters WHERE k = ?");
const allTools = db.prepare("SELECT slug, n FROM tool_counts ORDER BY n DESC LIMIT 10");
const setMetaIfAbsent = db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO NOTHING");
const getMeta = db.prepare("SELECT v FROM meta WHERE k = ?");
const insertRecent = db.prepare("INSERT INTO recent_calls (slug, method, ts) VALUES (?, ?, ?)");
const pruneRecent = db.prepare("DELETE FROM recent_calls WHERE id <= (SELECT MAX(id) FROM recent_calls) - ?");
const getRecent = db.prepare("SELECT slug, method, ts FROM recent_calls ORDER BY id DESC LIMIT ?");
const bumpPaidTool = db.prepare("INSERT INTO paid_tool_counts (slug, n) VALUES (?, 1) ON CONFLICT(slug) DO UPDATE SET n = n + 1");
const usdcNetCounters = db.prepare("SELECT k, n FROM counters WHERE k LIKE 'usdcNet:%'");
const topPaid = db.prepare("SELECT slug, n FROM paid_tool_counts ORDER BY n DESC LIMIT 10");
const allPaid = db.prepare("SELECT slug, n FROM paid_tool_counts");
// Per-tool count of internal heartbeat probes (PoW path, agent402-heartbeat UA).
// Kept separate so the operator dashboard can show real external PoW adoption
// without the every-15-min /api/hash probe drowning it out.
const bumpHeartbeatTool = db.prepare("INSERT INTO heartbeat_tool_counts (slug, n) VALUES (?, 1) ON CONFLICT(slug) DO UPDATE SET n = n + 1");
const allHeartbeat = db.prepare("SELECT slug, n FROM heartbeat_tool_counts");
const allToolsFull = db.prepare("SELECT slug, n FROM tool_counts ORDER BY n DESC");
const getRecentAll = db.prepare("SELECT slug, method, ts FROM recent_calls ORDER BY id DESC LIMIT ?");
// Detection for "we charged USDC on-chain but didn't serve a 200" — the worst-
// case operational failure (we took the buyer's money, gave them nothing). Kept
// as both a counter and a small retained log so an alarm can show *which* tools
// failed and when. Pruned to the most recent 200 events, same as recent_calls.
const bumpDaily = db.prepare("INSERT INTO daily_calls (day, method, n) VALUES (?, ?, 1) ON CONFLICT(day, method) DO UPDATE SET n = n + 1");
const allDaily = db.prepare("SELECT day, method, n FROM daily_calls ORDER BY day, method");
const bumpUpstream = db.prepare("INSERT INTO daily_upstream_calls (day, upstream, caller, n) VALUES (?, ?, ?, 1) ON CONFLICT(day, upstream, caller) DO UPDATE SET n = n + 1");
const dailyUpstream = db.prepare("SELECT day, caller, n FROM daily_upstream_calls WHERE upstream = ? ORDER BY day, caller");
const insertChargedFailure = db.prepare("INSERT INTO charged_failures (slug, status, ts) VALUES (?, ?, ?)");
const pruneChargedFailures = db.prepare("DELETE FROM charged_failures WHERE id <= (SELECT MAX(id) FROM charged_failures) - ?");
const getChargedFailures = db.prepare("SELECT slug, status, ts FROM charged_failures ORDER BY id DESC LIMIT ?");

setMetaIfAbsent.run("firstServed", String(Date.now()));
const bootedAt = Date.now();

const recordCall = db.transaction((slug, method, network, wire) => {
  bumpCounter.run("total");
  // Three rails: USDC (real revenue), external PoW (real free-tier adoption),
  // heartbeat (our own probe — pays via PoW but we track it separately so the
  // operator dashboard reflects external traffic only).
  const counterKey = method === "pow" ? "viaProofOfWork" : method === "heartbeat" ? "viaHeartbeat" : "viaUSDC";
  bumpCounter.run(counterKey);
  bumpTool.run(slug);
  if (method === "usdc") bumpPaidTool.run(slug); // USDC purchases — what people actually BUY
  // Which chain settled it. Multi-chain x402 means "viaUSDC" alone can't answer
  // "did anyone ever pay on Solana" — the settle receipt's network is the only
  // place that fact exists at serve time. "unknown" = settled before this
  // counter existed or the receipt header didn't decode.
  if (method === "usdc") bumpCounter.run(`usdcNet:${network || "unknown"}`);
  // Which WIRE carried the credential. Same settlement, same rail, but the
  // buyer spoke either x402 (PAYMENT-SIGNATURE) or MPP (Authorization:
  // Payment, translated by src/mpp-shim.js). Counted only for usdc — the MPP
  // adoption signal after the MPPScan/tempo directory listings.
  if (method === "usdc" && wire === "mpp") bumpCounter.run("viaMPPWire");
  if (method === "heartbeat") bumpHeartbeatTool.run(slug); // internal probe traffic
  // Privacy-safe activity feed: tool + settlement method + time only — never a
  // payload, wallet, or IP. Only successful (200) served calls reach here.
  insertRecent.run(slug, method, Date.now());
  pruneRecent.run(RECENT_KEEP);
  // Same transaction as the counters above: the daily series and the lifetime
  // totals are written together or not at all, so they cannot drift apart.
  bumpDaily.run(new Date().toISOString().slice(0, 10), method === "pow" ? "pow" : method === "heartbeat" ? "heartbeat" : "usdc");
  setMetaIfAbsent.run("firstServed", String(Date.now()));
});

/** Count one successfully served paid-tool call. method: "usdc" | "pow" | "heartbeat".
 *  network (usdc only): short chain name from the settle receipt, e.g. "base" | "solana".
 *  wire (usdc only): "mpp" when the credential arrived as MPP Authorization:
 *  Payment (translated by the shim); anything else counts as plain x402. */
export function recordServedCall(slug, method, network = null, wire = null) {
  try {
    recordCall(slug, method, network, wire);
  } catch {
    /* counters are best-effort; never break a response */
  }
}

// CAIP-2 → the short names used across /api/pricing and PAYMENT_NETWORKS.
const CAIP2_NAMES = {
  "eip155:8453": "base",
  "eip155:137": "polygon",
  "eip155:42161": "arbitrum",
  "eip155:84532": "base-sepolia",
  "eip155:42220": "celo",
  "eip155:43114": "avalanche",
  "eip155:143": "monad",
  // Settles USDG (Global Dollar), not USDC — shows up as its own bucket in
  // viaUSDCByNetwork so the per-rail split separates the two stablecoins.
  "eip155:4663": "robinhood (USDG)",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "solana",
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": "solana-devnet",
  "stellar:pubnet": "stellar",
  "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=": "algorand",
};

/**
 * Decode the settle-receipt header (PAYMENT-RESPONSE in x402 v2,
 * X-PAYMENT-RESPONSE in v1) into its JSON object, or null.
 *
 * SEMANTICS THAT MATTER (verified against @x402/core, 2026-07-16): the
 * middleware attaches this header to settle FAILURES too — a facilitator
 * rejection produces a 402 whose receipt is { success:false, errorReason, … }.
 * So the header's PRESENCE never proves the buyer was charged; only the
 * receipt's `success` field does. Pure and defensive: any shape surprise →
 * null, never a throw (this runs in the tally middleware on every response).
 */
export function decodeSettleReceipt(headerValue) {
  if (typeof headerValue !== "string" || !headerValue) return null;
  try {
    const receipt = JSON.parse(Buffer.from(headerValue, "base64").toString("utf8"));
    return receipt && typeof receipt === "object" && !Array.isArray(receipt) ? receipt : null;
  } catch {
    return null;
  }
}

/**
 * Which chain a settled x402 call was paid on, from the settle receipt:
 * `network` is CAIP-2 in v2, a short name in v1. Same defensive contract as
 * the decoder above.
 */
export function networkFromPaymentResponse(headerValue) {
  const net = decodeSettleReceipt(headerValue)?.network;
  if (typeof net !== "string" || !net) return null;
  return CAIP2_NAMES[net] || net;
}

/**
 * Record a "charged but didn't serve" event — the x402 middleware settled USDC
 * on-chain (X-PAYMENT-RESPONSE header present on the response) but the handler
 * returned non-200. The buyer was billed for nothing. A non-zero count of these
 * is an operational red alert; CI surfaces it via /api/stats.chargedButFailed.
 */
const recordFailure = db.transaction((slug, status) => {
  bumpCounter.run("chargedButFailedTotal");
  insertChargedFailure.run(slug, status, Date.now());
  pruneChargedFailures.run(RECENT_KEEP);
});

export function recordChargedFailure(slug, status) {
  try {
    recordFailure(slug, status);
  } catch {
    /* best-effort */
  }
}

/**
 * Lightweight DB liveness probe for /health. Reads the cheapest possible
 * statement (PK lookup on a tiny table) and returns true on success. Never
 * throws — the caller decides what status code to return.
 */
export function dbHealthy() {
  try {
    getMeta.get("firstServed");
    return true;
  } catch {
    return false;
  }
}

export function getStats({ wallet, walletName, network, toolCount, baseUrl, prices }) {
  const num = (k) => getCounter.get(k)?.n ?? 0;
  const priceOf = (slug) => (prices && Number(prices[slug])) || 0;
  const estimatedRevenueUsd = +allPaid.all().reduce((s, r) => s + r.n * priceOf(r.slug), 0).toFixed(4);
  const topPaidTools = topPaid.all().map((r) => ({ slug: r.slug, purchases: r.n, revenueUsd: +(r.n * priceOf(r.slug)).toFixed(4) }));
  const firstServed = parseInt(getMeta.get("firstServed")?.v ?? Date.now(), 10);
  const explorer = network === "base-sepolia" ? "https://sepolia.basescan.org" : "https://basescan.org";
  return {
    service: "Agent402.Tools",
    summary: "A live node in the machine-to-machine economy: autonomous agents pay per call in USDC (or with compute) and get the result - no human, no signup.",
    tools: toolCount,
    payment: { protocol: "x402", network, currency: "USDC" },
    wallet,
    walletName: walletName || null,
    onchainRevenueProof: wallet ? `${explorer}/address/${wallet}#tokentxns` : null,
    onchainNote: "Settled revenue is verifiable on-chain at the wallet above - that is the trustless source of truth, not this counter.",
    toolCallsServed: {
      total: num("total"),
      viaUSDC: num("viaUSDC"),
      // USDC split by settlement chain (from the x402 settle receipt). "unknown"
      // = counted before this split existed. Answers "has anyone ever paid on
      // Solana/Polygon/…" without an explorer scan per chain.
      viaUSDCByNetwork: Object.fromEntries(usdcNetCounters.all().map((r) => [r.k.slice("usdcNet:".length), r.n])),
      viaProofOfWork: num("viaProofOfWork"),
      viaHeartbeat: num("viaHeartbeat"), // internal probe traffic (PoW path, agent402-heartbeat UA)
      // Subset of viaUSDC whose credential arrived over the MPP wire
      // (Authorization: Payment, translated by src/mpp-shim.js) instead of
      // x402's PAYMENT-SIGNATURE. The MPP-adoption signal.
      viaMPPWire: num("viaMPPWire"),
    },
    // Charged on-chain but handler returned non-200 — should always be 0. Any
    // value here means we billed the buyer and gave them an error. The dashboard
    // and a daily CI check both alert when this is nonzero.
    chargedButFailed: num("chargedButFailedTotal"),
    topTools: allTools.all(),
    topPaidTools, // most-PURCHASED tools (USDC only), with estimated revenue
    estimatedRevenueUsd, // sum of price × USDC-purchase count (counters; chain is source of truth)
    recentCalls: getRecent.all(RECENT_SHOW).map((r) => ({
      slug: r.slug,
      paidWith: r.method === "pow" ? "proof-of-work" : r.method === "heartbeat" ? "heartbeat" : "usdc",
      at: new Date(r.ts).toISOString(),
    })),
    servingSince: new Date(firstServed).toISOString(),
    uptimeSeconds: Math.floor((Date.now() - bootedAt) / 1000),
    runTheDemo: `${baseUrl}/llms.txt`,
  };
}

/**
 * Daily served-call counts by settlement method, oldest first.
 * [{ day: "2026-07-26", usdc: 812, pow: 143, heartbeat: 96 }]
 *
 * Recording starts the day this table ships — earlier days genuinely have no
 * per-day record (recent_calls is pruned to 200 rows and the counters are
 * lifetime-only), so the series must never imply zero free-tier usage before
 * then. Callers get `recordingSince` to label that honestly.
 */
export function getDailyCalls() {
  const byDay = new Map();
  for (const r of allDaily.all()) {
    const d = byDay.get(r.day) || { day: r.day, usdc: 0, pow: 0, heartbeat: 0 };
    if (r.method === "pow" || r.method === "heartbeat" || r.method === "usdc") d[r.method] = r.n;
    byDay.set(r.day, d);
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/**
 * Record one outbound call to a paid upstream (e.g. "brave"), day-bucketed in
 * UTC like daily_calls. Best-effort: metering must never break serving.
 */
export function recordUpstreamCall(upstream, caller = "unknown") {
  try {
    bumpUpstream.run(new Date().toISOString().slice(0, 10), String(upstream), String(caller));
  } catch {
    /* best-effort */
  }
}

/** Day-bucketed outbound-call rows for one upstream: [{day, caller, n}]. */
export function getDailyUpstreamCalls(upstream) {
  try {
    return dailyUpstream.all(String(upstream));
  } catch {
    return [];
  }
}

/** First day the daily tally recorded anything, or null before the first call. */
export function dailyCallsRecordingSince() {
  const rows = allDaily.all();
  return rows.length ? rows.reduce((m, r) => (r.day < m ? r.day : m), rows[0].day) : null;
}

/**
 * Full per-tool breakdown for the operator dashboard — every tool that's ever
 * been served, USDC purchases per tool, estimated revenue per tool, and the
 * full retained recent-calls log. Pricing comes from the catalog at the call
 * site so this module stays decoupled from CATALOG. Operator-only — gated by
 * AGENT402_OPERATOR_TOKEN at the route layer.
 */
export function getOperatorBreakdown({ prices, walletOnlySet, limit = RECENT_KEEP } = {}) {
  const priceOf = (slug) => (prices && Number(prices[slug])) || 0;
  const isWalletOnly = (slug) => !!(walletOnlySet && walletOnlySet.has && walletOnlySet.has(slug));
  const paidBySlug = new Map(allPaid.all().map((r) => [r.slug, r.n]));
  const heartbeatBySlug = new Map(allHeartbeat.all().map((r) => [r.slug, r.n]));
  const tools = allToolsFull.all().map((r) => {
    const paid = paidBySlug.get(r.slug) || 0;
    const heartbeat = heartbeatBySlug.get(r.slug) || 0;
    return {
      slug: r.slug,
      calls: r.n,
      paid,
      // External PoW = everything that isn't USDC and isn't our heartbeat probe.
      // This is the column that reflects real free-tier adoption.
      pow: Math.max(0, r.n - paid - heartbeat),
      heartbeat,
      revenueUsd: +(paid * priceOf(r.slug)).toFixed(4),
      pricePerCall: priceOf(r.slug),
      walletOnly: isWalletOnly(r.slug),
    };
  });
  return {
    totals: {
      total: getCounter.get("total")?.n ?? 0,
      viaUSDC: getCounter.get("viaUSDC")?.n ?? 0,
      viaUSDCByNetwork: Object.fromEntries(usdcNetCounters.all().map((r) => [r.k.slice("usdcNet:".length), r.n])),
      viaProofOfWork: getCounter.get("viaProofOfWork")?.n ?? 0,
      viaHeartbeat: getCounter.get("viaHeartbeat")?.n ?? 0,
      estimatedRevenueUsd: +tools.reduce((s, t) => s + t.revenueUsd, 0).toFixed(4),
      toolsServed: tools.length,
      chargedButFailed: getCounter.get("chargedButFailedTotal")?.n ?? 0,
    },
    tools,
    recentCalls: getRecentAll.all(limit).map((r) => ({
      slug: r.slug,
      paidWith: r.method === "pow" ? "proof-of-work" : r.method === "heartbeat" ? "heartbeat" : "usdc",
      at: new Date(r.ts).toISOString(),
    })),
    chargedFailures: getChargedFailures.all(limit).map((r) => ({
      slug: r.slug,
      status: r.status,
      at: new Date(r.ts).toISOString(),
    })),
    bootedAt: new Date(bootedAt).toISOString(),
    uptimeSeconds: Math.floor((Date.now() - bootedAt) / 1000),
  };
}
