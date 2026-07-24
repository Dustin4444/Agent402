// Sales ledger — every served paid/proven call, BY NAME, persistently.
//
// The stats odometer answers "how many calls"; the chain answers "how much
// money"; neither answers the merchant question: WHICH tools do external
// wallets actually buy? This module records one row per served catalog call
// at settle time — slug, price, rail, settlement chain, verified payer, tx —
// and classifies it internal/external so canary + burner + heartbeat traffic
// never masquerades as demand. SQLite on the /data volume (same pattern as
// stats.js / revenue-ledger.js): rows survive redeploys, and every USDC row
// keeps its settle tx so the ledger stays independently verifiable on-chain.
//
// Classification (internal = our own money/traffic):
//   - request carried a valid POW_SECRET-signed X-Heartbeat-Token (canary,
//     heartbeat probe, CI smoke — unspoofable), or
//   - the verified EIP-3009 payer is one of our burner wallets.
// Solana-settled calls carry no server-visible payer (the SVM payload embeds
// a signed transaction, not an authorization object) — the canary's Solana
// leg is covered by the heartbeat token instead.
//
// Privacy: rows hold ONLY slug, price, rail, chain, payer wallet (already
// public on-chain in the settle tx), and tx hash. Never inputs, IPs, or UAs.
//
// Zero config: persists wherever /data exists (prod); elsewhere it lands in
// /tmp (ephemeral, still functional) — SALES_LEDGER_DB overrides for tests.
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { OUR_EVM_WALLETS, OUR_SOLANA_WALLETS, OUR_STELLAR_WALLETS, OUR_ALGORAND_WALLETS } from "./revenue-live.js";
import { normalizePayerAddress } from "./payer.js";

const HAS_DATA_DIR = existsSync("/data");
const DB_PATH = process.env.SALES_LEDGER_DB || join(HAS_DATA_DIR ? "/data" : "/tmp", "agent402-sales.db");
export const salesPersistent = HAS_DATA_DIR || Boolean(process.env.SALES_LEDGER_DB);

// EVM burners lowercase; Solana/Stellar/Algorand burners case-exact (base58
// and Stellar/Algorand base32 addresses are case-sensitive — lowercasing
// them breaks matching).
const BURNERS = new Set([
  ...[...OUR_EVM_WALLETS].map((w) => String(w).toLowerCase()),
  ...OUR_SOLANA_WALLETS,
  ...OUR_STELLAR_WALLETS,
  ...OUR_ALGORAND_WALLETS,
]);

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS sales (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,   -- unix ms, server clock at response finish
  slug      TEXT    NOT NULL,
  price_usd REAL    NOT NULL,   -- catalog price at time of sale
  rail      TEXT    NOT NULL,   -- usdc | pow | heartbeat | marketplace
  network   TEXT,               -- settlement chain (usdc rail only)
  payer     TEXT,               -- verified EIP-3009 payer, lowercase (EVM only)
  tx        TEXT,               -- settle tx hash/signature from the receipt
  internal  INTEGER NOT NULL    -- 1 = our own traffic, 0 = external demand
);
CREATE INDEX IF NOT EXISTS idx_sales_ext_ts ON sales (internal, ts);
CREATE INDEX IF NOT EXISTS idx_sales_slug   ON sales (slug);
CREATE INDEX IF NOT EXISTS idx_sales_payer  ON sales (payer, ts);
`);
// Additive column (2026-07-24): which HTTP wire carried the credential —
// "x402" (PAYMENT-SIGNATURE) or "mpp" (Authorization: Payment via
// src/mpp-shim.js). Same settlement either way; recorded so MPP adoption is
// answerable from the ledger history the day it starts, and /revenue can
// surface the split once external MPP sales exist. NULL = pre-column rows.
try { db.exec("ALTER TABLE sales ADD COLUMN wire TEXT"); } catch { /* exists */ }

const insertSale = db.prepare(
  "INSERT INTO sales (ts, slug, price_usd, rail, network, payer, tx, internal, wire) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
);

/** Settle tx hash/signature out of the base64 PAYMENT-RESPONSE receipt. */
export function txFromPaymentResponse(headerValue) {
  if (typeof headerValue !== "string" || !headerValue) return null;
  try {
    const tx = JSON.parse(Buffer.from(headerValue, "base64").toString("utf8"))?.transaction;
    return typeof tx === "string" && tx ? tx : null;
  } catch {
    return null;
  }
}

/**
 * Record one served catalog call. Fire-and-forget from the serving path:
 * never throws, and a broken disk only costs the row, not the response.
 */
export function recordSale({ slug, priceUsd, rail, network, payer, tx, synthetic, wire }) {
  try {
    const p = normalizePayerAddress(payer); // lowercases EVM only — base58/Stellar stay case-exact
    const internal = Boolean(synthetic) || rail === "heartbeat" || (p !== null && BURNERS.has(p));
    insertSale.run(
      Date.now(),
      String(slug || "unknown"),
      Number(priceUsd) || 0,
      String(rail || "unknown"),
      network ? String(network) : null,
      p,
      tx ? String(tx) : null,
      internal ? 1 : 0,
      wire ? String(wire) : null
    );
  } catch { /* never break serving for accounting */ }
}

const qExtBySlug = db.prepare(`
  SELECT slug, COUNT(*) AS sales, SUM(price_usd) AS revenue, MAX(ts) AS last_ts
  FROM sales WHERE internal = 0 AND rail IN ('usdc','marketplace') AND ts >= ?
  GROUP BY slug ORDER BY sales DESC, revenue DESC LIMIT 20`);
const qExtRecent = db.prepare(`
  SELECT ts, slug, price_usd, rail, network, payer, tx
  FROM sales WHERE internal = 0 AND rail IN ('usdc','marketplace')
  ORDER BY ts DESC LIMIT 20`);
const qIntRecent = db.prepare(`
  SELECT ts, slug, price_usd, rail, network, payer, tx
  FROM sales WHERE internal = 1
  ORDER BY ts DESC LIMIT 20`);
// Settlements whose credential arrived over the MPP wire (Authorization:
// Payment). Same on-chain USDC settlement as x402 — the `wire` column is the
// only difference. Both external buys and internal (canary) MPP settlements
// are included, since MPP is new and most current MPP traffic is the daily
// canary's Base+Celo native-wire legs.
const qMppRecent = db.prepare(`
  SELECT ts, slug, price_usd, rail, network, payer, tx, internal
  FROM sales WHERE wire = 'mpp'
  ORDER BY ts DESC LIMIT ?`);
const qExtByPayer = db.prepare(`
  SELECT payer, COUNT(*) AS sales, SUM(price_usd) AS revenue, MAX(ts) AS last_ts
  FROM sales WHERE internal = 0 AND rail IN ('usdc','marketplace') AND payer IS NOT NULL AND ts >= ?
  GROUP BY payer ORDER BY revenue DESC LIMIT 10`);
// Demand composition: external tools ranked by how many DISTINCT verified
// wallets bought each (breadth, not dollars) — the public /index "what agents
// actually buy" widget. payer IS NOT NULL keeps it to attributable settlements
// (EVM exposes the payer; SVM rows carry none), and internal=0 excludes our
// own canary/burner traffic, so this only ever counts independent demand.
const qExtBuyersBySlug = db.prepare(`
  SELECT slug, COUNT(DISTINCT payer) AS buyers, COUNT(*) AS sales, SUM(price_usd) AS revenue
  FROM sales
  WHERE internal = 0 AND rail IN ('usdc','marketplace') AND payer IS NOT NULL AND ts >= ?
  GROUP BY slug ORDER BY buyers DESC, sales DESC LIMIT ?`);
const qTotals = db.prepare(`
  SELECT internal, rail, COUNT(*) AS n, SUM(price_usd) AS usd
  FROM sales WHERE ts >= ? GROUP BY internal, rail`);
const qFirstTs = db.prepare("SELECT MIN(ts) AS ts FROM sales");
// Per-slug external paid aggregation over a half-open window [since, until) —
// the bestsellers tool's data feed. COUNT(DISTINCT payer) skips NULLs, so
// `buyers` counts only attributable settlements (EVM exposes the signed payer;
// SVM/Stellar rows carry none and count toward sales but never buyers). No
// LIMIT: the row count is bounded by the catalog size, and the ranking lens
// (buyers vs sales vs revenue) is the caller's choice, not the query's.
const qExtSlugWindow = db.prepare(`
  SELECT slug, COUNT(*) AS sales, SUM(price_usd) AS revenue,
         COUNT(DISTINCT payer) AS buyers, MIN(ts) AS first_ts, MAX(ts) AS last_ts
  FROM sales WHERE internal = 0 AND rail IN ('usdc','marketplace') AND ts >= ? AND ts < ?
  GROUP BY slug`);

// Payer-scoped view (the /api/my-usage tool). Money rails only — PoW rows
// carry no payer, so they can never appear in a wallet-keyed report anyway.
const qPayerTotals = db.prepare(`
  SELECT COUNT(*) AS n, SUM(price_usd) AS usd, MIN(ts) AS first_ts, MAX(ts) AS last_ts
  FROM sales WHERE payer = ? AND rail IN ('usdc','marketplace') AND ts >= ?`);
const qPayerBySlug = db.prepare(`
  SELECT slug, COUNT(*) AS n, SUM(price_usd) AS usd, MAX(ts) AS last_ts
  FROM sales WHERE payer = ? AND rail IN ('usdc','marketplace') AND ts >= ?
  GROUP BY slug ORDER BY n DESC, usd DESC LIMIT 50`);
const qPayerByNetwork = db.prepare(`
  SELECT network, COUNT(*) AS n, SUM(price_usd) AS usd
  FROM sales WHERE payer = ? AND rail IN ('usdc','marketplace') AND ts >= ?
  GROUP BY network`);
const qPayerRecent = db.prepare(`
  SELECT ts, slug, price_usd, network, tx
  FROM sales WHERE payer = ? AND rail IN ('usdc','marketplace')
  ORDER BY ts DESC LIMIT ?`);

/**
 * One wallet's own purchase history — ONLY ever called with a payer address
 * the payment middleware verified (payment = identity, same model as the
 * memory tools). No internal/external filter: a wallet always sees all of
 * its own rows.
 */
export function payerUsage(payer, { days = 30, limit = 50 } = {}) {
  const since = Date.now() - days * 86_400_000;
  const t = qPayerTotals.get(payer, since);
  return {
    wallet: payer,
    days,
    persistent: salesPersistent,
    totals: {
      calls: t?.n || 0,
      paidUsd: +(t?.usd || 0).toFixed(4),
      firstAt: t?.first_ts ? new Date(t.first_ts).toISOString() : null,
      lastAt: t?.last_ts ? new Date(t.last_ts).toISOString() : null,
    },
    byNetwork: Object.fromEntries(
      qPayerByNetwork.all(payer, since).map((r) => [r.network || "unknown", { calls: r.n, usd: +(r.usd || 0).toFixed(4) }])
    ),
    bySlug: qPayerBySlug.all(payer, since).map((r) => ({
      slug: r.slug, calls: r.n, usd: +(r.usd || 0).toFixed(4), lastAt: new Date(r.last_ts).toISOString(),
    })),
    recent: qPayerRecent.all(payer, limit).map((r) => ({
      at: new Date(r.ts).toISOString(), slug: r.slug, priceUsd: r.price_usd, network: r.network, tx: r.tx,
    })),
    note: "Rows are recorded at settle time and every USDC row keeps its settle tx, so this report is independently verifiable on-chain. The call that paid for this report will appear in the next one.",
  };
}

/**
 * Public demand widget on /index — external tools ranked by DISTINCT verified
 * buyers over `days`. Breadth of demand, not revenue: the tools the most
 * independent wallets reach for. Canary/burner traffic excluded (internal=0).
 */
export function topByBuyers({ days = 30, limit = 8 } = {}) {
  const since = Date.now() - days * 86_400_000;
  return qExtBuyersBySlug.all(since, limit).map((r) => ({
    slug: r.slug,
    buyers: r.buyers,
    sales: r.sales,
    revenueUsd: +(r.revenue || 0).toFixed(4),
  }));
}

/**
 * Raw rows for the bestsellers tool: every externally-paid tool's window
 * aggregate over [sinceMs, untilMs). One row per slug — sales, revenue,
 * distinct attributable buyers, first/last sale ts. Ranking, lenses, and
 * trend math live in the tool's pure compute (x402-kit computeBestsellers).
 */
export function externalSlugWindow(sinceMs, untilMs) {
  return qExtSlugWindow.all(sinceMs, untilMs);
}

/** When the ledger recorded its first row (unix ms), or null when empty. */
export function firstRecordedTs() {
  return qFirstTs.get()?.ts ?? null;
}

/**
 * The merchant view: external paid sales by name, recent named sales,
 * repeat buyers, and honest internal/external totals. `days` bounds the
 * by-slug/by-payer aggregations (recent list is always the latest rows).
 */
/** Recent MPP-wire settlements (Authorization: Payment) with on-chain tx + payer. */
export function mppSales({ limit = 30 } = {}) {
  const rows = qMppRecent.all(Math.min(Math.max(1, limit | 0), 100));
  return {
    persistent: salesPersistent,
    count: rows.length,
    settlements: rows.map((r) => ({
      at: new Date(r.ts).toISOString(), slug: r.slug, priceUsd: r.price_usd,
      rail: r.rail, network: r.network, payer: r.payer, tx: r.tx, internal: !!r.internal,
    })),
  };
}

export function salesSummary({ days = 30 } = {}) {
  const since = Date.now() - days * 86_400_000;
  const totals = { external: { sales: 0, revenueUsd: 0 }, internal: { sales: 0, revenueUsd: 0 }, byRail: {} };
  for (const r of qTotals.all(since)) {
    const side = r.internal ? "internal" : "external";
    // Free-tier (pow) rows count as usage, not revenue — price is what it
    // WOULD have cost; only money rails add to revenueUsd.
    const paid = r.rail === "usdc" || r.rail === "marketplace";
    totals[side].sales += r.n;
    if (paid) totals[side].revenueUsd += r.usd;
    totals.byRail[`${side}:${r.rail}`] = r.n;
  }
  totals.external.revenueUsd = +totals.external.revenueUsd.toFixed(4);
  totals.internal.revenueUsd = +totals.internal.revenueUsd.toFixed(4);
  return {
    days,
    persistent: salesPersistent,
    recordingSince: qFirstTs.get()?.ts ?? null,
    totals,
    topExternal: qExtBySlug.all(since).map((r) => ({
      slug: r.slug, sales: r.sales, revenueUsd: +r.revenue.toFixed(4), lastAt: new Date(r.last_ts).toISOString(),
    })),
    recentExternal: qExtRecent.all().map((r) => ({
      at: new Date(r.ts).toISOString(), slug: r.slug, priceUsd: r.price_usd, rail: r.rail,
      network: r.network, payer: r.payer, tx: r.tx,
    })),
    recentInternal: qIntRecent.all().map((r) => ({
      at: new Date(r.ts).toISOString(), slug: r.slug, priceUsd: r.price_usd, rail: r.rail,
      network: r.network, payer: r.payer, tx: r.tx,
    })),
    repeatBuyers: qExtByPayer.all(since).map((r) => ({
      payer: r.payer, sales: r.sales, revenueUsd: +r.revenue.toFixed(4), lastAt: new Date(r.last_ts).toISOString(),
    })),
  };
}
