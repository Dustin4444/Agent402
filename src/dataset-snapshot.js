// A dated, immutable record of the x402 / MPP ecosystem as we observed it.
//
// WHY THIS EXISTS, and why it had to start the day it was written. Every other
// store in /data is a CURRENT snapshot that overwrites itself on each crawl:
// the index cache, both MPP caches, the Solana board, the Tempo transfer feed.
// The one exception, leaderboard-history.json, keeps 35 days of the top 300
// sellers. So "who was selling what, at what price, on which chain, and who was
// actually getting paid" exists for today and is gone tomorrow, and the crawls
// that would have produced the history cannot be re-run. A time series is the
// only version of this data anyone can build on - ours or a buyer's - and the
// clock only starts once something writes a day down.
//
// FOUR RULES, each of which is a decision and not an implementation detail:
//
// 1. IMMUTABLE. A date already present in the bucket is never rewritten. A
//    record you can overwrite is a cache with a date in the name. `force` exists
//    for repairing a run that half-failed and says so in the manifest.
//
// 2. ALLOWLIST, NEVER DENYLIST. Each table names the exact columns it emits.
//    A field added to indexSnapshot or a board next month cannot silently
//    appear in a published dataset - it has to be added here on purpose. The
//    denylist direction fails open, and failing open here means publishing
//    something we did not mean to publish.
//
// 3. OURS ONLY. The index folds third-party measurements beside our own - the
//    Bazaar's 30-day call and payer counts most of all, which we display
//    labelled as their measurement. Displaying someone's figure with attribution
//    and redistributing it inside a dataset are different postures, so the
//    fold is excluded here by name and the manifest records that it was
//    excluded and why. Everything emitted is our own crawl, our own probe, or a
//    public chain read.
//
// 4. COUNTS, NEVER ROSTERS. A seller's payTo is public infrastructure and is
//    how rows join across tables, so it stays. Anything identifying a BUYER
//    does not: the Base board carries a `buyers` Set internally and publishes
//    only `uniqueBuyers`, the Solana rows carry a `funder` per credit. We
//    publish who SELLS, never who BUYS. That is the same line /revenue holds.
//
// HONEST HOLES ARE VISIBLE, NOT SILENT. Every column's non-null count rides in
// the manifest (`columnFill`). A column that is misspelled, or that an upstream
// accessor stopped populating, reads 0 there instead of quietly becoming a
// field of nulls that a buyer discovers a year later.
//
// Layout: datasets/v1/dt=YYYY-MM-DD/<table>.ndjson.gz + manifest.json, which is
// a Hive-partitioned prefix - the shape Delta Sharing, Databricks, Athena and
// DuckDB all read directly, so the storage decision does not bind the
// distribution decision.
import { gzipSync } from "node:zlib";
import { putObject, objectExists, backupConfigured } from "./backup.js";
import { priceToMicroUsd } from "./x402-index.js";

export const DATASET_VERSION = "v1";
export const DATASET_PREFIX = `datasets/${DATASET_VERSION}`;

// Bounds. Row caps are generous against today's ~2,900 sellers but keep one
// runaway crawl from writing a gigabyte into a bucket with a bill guard.
const MAX_ROWS = Number(process.env.DATASET_MAX_ROWS) > 0 ? Number(process.env.DATASET_MAX_ROWS) : 200_000;
const MAX_TABLE_BYTES = 64 * 1024 * 1024;

/** The Bazaar fold, by name, so the exclusion is greppable and testable rather
 *  than an absence. See rule 3. */
/** Columns deliberately NOT emitted because this source cannot fill them. Both
 *  are added by the /api/route DISPLAY projection, never by the crawl, so they
 *  would publish as a permanent field of nulls - which is precisely what this
 *  dataset promises not to ship. Named rather than silently absent. */
export const UNFILLABLE_HERE = Object.freeze({
  "routes.url_template": "set by urlTemplateProjection in the route display path, not on the crawl row",
  "routes.networks_inferred": "set by decoratedRemoteTools when building the route pool, not on the crawl row",
});

export const EXCLUDED_THIRD_PARTY = Object.freeze({
  "sellers.bazaar": "Coinbase Bazaar 30-day calls/payers - their measurement, displayed with attribution on our pages, not redistributed here",
});

// --- column allowlists (rule 2) ---------------------------------------------
// Each entry is [outputColumn, sourceField]. Same name on both sides is the
// common case; they differ where the source name is ambiguous out of context.

const SELLER_COLUMNS = [
  ["origin", "origin"],
  ["display_name", "displayName"],
  ["homepage", "homepage"],
  ["primary_network", "network"],
  ["networks", "networks"],
  ["tool_count", "toolCount"],
  ["paid_tool_count", "paidToolCount"],
  ["origin_responded", "originResponded"],
  ["discovery_path", "discoveryPath"],
  ["source", "source"],
  ["health", "health"],
  ["routable", "routable"],
  ["mpp", "mpp"],
  ["stellar_pay_to", "stellarWallet"],
  ["algorand_pay_to", "algorandWallet"],
  // The EVM payout address per chain: the join key between this table and the
  // settlement tables, and already public on /api/index.
  ["pay_to_by_network", "payToByNetwork"],
  ["payment_networks_known", "paymentNetworksKnown"],
  // Our router's own verdict on whether it would pay this seller right now,
  // and why not. First-party, and the single most useful column for anyone
  // deciding who is actually transactable rather than merely listed.
  ["router_dispatch_eligible", "routerDispatchEligible"],
  ["router_dispatch_reason", "routerDispatchReason"],
  ["fetched_at", "fetchedAt"],
  ["crawl_error", "error"],
];

// The price-provenance columns are the point of this table: a price is worth
// little without when it was observed, whether the origin itself declared it,
// and whether it was carried forward from an older crawl.
const ROUTE_COLUMNS = [
  ["origin", "__origin"],
  ["route", "route"],
  ["method", "method"],
  // DERIVED, not read: the raw crawl row stores the origin's published price as
  // a display STRING ("$0.005") under `price`; `priceUsd` is a later display
  // derivation that does not exist on the crawl object. The first real day
  // shipped this column entirely null while the provenance column beside it
  // carried the number - caught by columnFill, which is what it is for.
  // Unparseable reads null, never 0: "free" and "we could not read it" are
  // different facts and only one of them is ours to publish.
  ["price_usd", "__priceUsd"],
  ["price_published", "price"],
  ["price_source", "quoteSource"],
  ["price_resolved_from", "priceResolvedFrom"],
  ["origin_declared_price", "originDeclaredPrice"],
  ["quote_observed_at", "quoteObservedAt"],
  ["quote_carried_forward", "quoteCarriedForward"],
  ["networks", "networks"],
  ["networks_verified_at", "networksVerifiedAt"],
  ["method_inferred", "methodInferred"],
  ["method_corrected_from", "methodCorrectedFrom"],
];

const BASE_SETTLEMENT_COLUMNS = [
  ["name", "name"],
  ["origins", "origins"],
  ["homepage", "homepage"],
  ["pay_to", "wallet"],
  ["pay_to_count", "walletCount"],
  ["network", "network"],
  ["calls_settled", "callsSettled"],
  ["total_usd", "totalUsd"],
  ["unique_buyers", "uniqueBuyers"], // a COUNT; the addresses never leave the process
  ["endpoints", "endpoints"],
];

const SOLANA_SETTLEMENT_COLUMNS = [
  ["pay_to", "payTo"],
  ["origins", "origins"],
  ["credits", "credits"],
  ["payers", "payers"],
  ["truncated", "truncated"],
  ["stale", "stale"],
  ["is_host", "self"], // our own row stays labelled, exactly as on the public board
];

const MPP_SETTLEMENT_COLUMNS = [
  ["recipient", "recipient"],
  ["sellers", "sellers"],
  ["intents", "intents"],
  ["transfers", "transfers"],
  ["volume_usdc", "volumeUsdc"],
  ["payers", "payers"],
  ["proven", "proven"],
  ["routable", "routable"],
  ["is_host", "self"], // ours is mostly volume-run traffic; a buyer must be able to exclude it
];

/** Project one source object through a column allowlist. Missing reads as null,
 *  never as absent: a NDJSON table whose rows have different key sets is a
 *  table every downstream reader has to guess the schema of. */
function project(src, columns, extra = {}) {
  const row = { ...extra };
  for (const [out, from] of columns) {
    const v = src?.[from];
    row[out] = v === undefined ? null : v;
  }
  return row;
}

/** Non-null count per column - the honesty mechanism. A misspelled source
 *  field, or an accessor that stopped populating one, shows up here as 0. */
export function columnFill(rows, columns) {
  const fill = {};
  for (const [out] of columns) fill[out] = 0;
  for (const r of rows) {
    for (const [out] of columns) {
      const v = r[out];
      if (v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0)) fill[out]++;
    }
  }
  return fill;
}

/** Build every table from already-fetched sources. Pure: no network, no clock
 *  beyond what the caller passes, so the test drives it on fixtures. */
export function buildTables({ sellers = [], baseRows = [], solanaRows = [], mppRows = [] } = {}) {
  const sellerRows = [];
  const routeRows = [];
  for (const s of sellers.slice(0, MAX_ROWS)) {
    sellerRows.push(project(s, SELLER_COLUMNS));
    for (const t of Array.isArray(s.tools) ? s.tools : []) {
      if (routeRows.length >= MAX_ROWS) break;
      const micro = priceToMicroUsd(t?.price ?? t?.priceUsd);
      routeRows.push(project({ ...t, __origin: s.origin, __priceUsd: micro == null ? null : micro / 1e6 }, ROUTE_COLUMNS));
    }
  }
  return {
    sellers: { rows: sellerRows, columns: SELLER_COLUMNS },
    routes: { rows: routeRows, columns: ROUTE_COLUMNS },
    settlement_base: { rows: baseRows.slice(0, MAX_ROWS).map((r) => project(r, BASE_SETTLEMENT_COLUMNS)), columns: BASE_SETTLEMENT_COLUMNS },
    settlement_solana: { rows: solanaRows.slice(0, MAX_ROWS).map((r) => project(r, SOLANA_SETTLEMENT_COLUMNS)), columns: SOLANA_SETTLEMENT_COLUMNS },
    settlement_mpp: { rows: mppRows.slice(0, MAX_ROWS).map((r) => project(r, MPP_SETTLEMENT_COLUMNS)), columns: MPP_SETTLEMENT_COLUMNS },
  };
}

/** Serialize a table to gzip'd NDJSON. Throws past the per-table byte cap
 *  rather than uploading something unbounded. */
export function serializeTable(rows) {
  const body = gzipSync(Buffer.from(rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""), "utf8"), { level: 6 });
  if (body.length > MAX_TABLE_BYTES) throw new Error(`table is ${(body.length / 1e6).toFixed(1)}MB gz, over the ${MAX_TABLE_BYTES / 1e6}MB cap`);
  return body;
}

export function manifestFor({ day, tables, sources = {}, partial = null, force = false }) {
  return {
    dataset: "agent402-x402-ecosystem",
    version: DATASET_VERSION,
    day,
    writtenAt: new Date().toISOString(),
    // Provenance is part of the artifact, not a README someone loses.
    provenance: "First-party: our own crawl of publicly advertised x402/MPP endpoints, our own live 402 probes, and public chain reads. Third-party measurements are excluded by name below.",
    excludedThirdParty: EXCLUDED_THIRD_PARTY,
    privacy: "Seller payTo addresses are published (public infrastructure, and the join key across tables). Buyer identities are never published - buyer figures are counts only.",
    tables: Object.fromEntries(Object.entries(tables).map(([name, t]) => [name, {
      file: `${name}.ndjson.gz`,
      rows: t.rows.length,
      columns: t.columns.map(([out]) => out),
      columnFill: columnFill(t.rows, t.columns),
    }])),
    sources,
    ...(partial ? { partial } : {}),
    ...(force ? { forcedOverwrite: true } : {}),
  };
}

// --- the run ----------------------------------------------------------------

const status = {
  lastAttempt: null, lastSuccess: null, lastError: null,
  lastDay: null, lastRows: null, lastSkipped: null,
};
export const datasetStatus = () => ({ ...status, configured: backupConfigured() });

let running = false;

/**
 * Write one day. Sources are injected so this module imports nothing stateful
 * and the test drives the whole path against a stub bucket.
 *
 * A source that throws does NOT fail the run: the day is written with the
 * tables that succeeded and the manifest names what was missing. A partial day
 * recorded honestly beats no day at all, because the day cannot be revisited.
 */
export async function runDatasetSnapshot({
  sellers, baseRows, solanaRows, mppRows,
  day = new Date().toISOString().slice(0, 10),
  force = false,
  put = putObject,
  exists = objectExists,
  log = console.log,
} = {}) {
  if (!backupConfigured()) return { skipped: "not configured (BACKUP_S3_* unset)" };
  if (running) return { skipped: "already running" };
  running = true;
  status.lastAttempt = new Date().toISOString();
  const prefix = `${DATASET_PREFIX}/dt=${day}`;
  try {
    if (!force && await exists(`${prefix}/manifest.json`)) {
      status.lastSkipped = `${day} already recorded`;
      log(`[dataset] ${day} already recorded - not rewriting (immutable; pass force to repair)`);
      return { ok: true, skipped: "already recorded", day };
    }

    // Each source is read behind its own guard: one dead accessor must not
    // cost the whole day.
    const partial = {};
    const read = (name, fn) => {
      try { const v = fn(); return Array.isArray(v) ? v : []; }
      catch (e) { partial[name] = String(e.message).slice(0, 200); return []; }
    };
    const tables = buildTables({
      sellers: read("sellers", sellers),
      baseRows: read("settlement_base", baseRows),
      solanaRows: read("settlement_solana", solanaRows),
      mppRows: read("settlement_mpp", mppRows),
    });

    let bytes = 0;
    for (const [name, t] of Object.entries(tables)) {
      const body = serializeTable(t.rows);
      await put(`${prefix}/${name}.ndjson.gz`, body);
      bytes += body.length;
    }
    // The manifest is written LAST and is what `exists` checks, so a run that
    // dies halfway leaves no day claiming to be complete.
    const manifest = manifestFor({ day, tables, partial: Object.keys(partial).length ? partial : null, force });
    await put(`${prefix}/manifest.json`, Buffer.from(JSON.stringify(manifest, null, 2), "utf8"));

    const rows = Object.fromEntries(Object.entries(tables).map(([n, t]) => [n, t.rows.length]));
    status.lastSuccess = new Date().toISOString();
    status.lastError = null;
    status.lastDay = day;
    status.lastRows = rows;
    status.lastSkipped = null;
    log(`[dataset] OK dt=${day} ${Object.entries(rows).map(([n, c]) => `${n}=${c}`).join(" ")} (${(bytes / 1e6).toFixed(2)}MB gz)${Object.keys(partial).length ? ` PARTIAL: ${Object.keys(partial).join(",")}` : ""}`);
    return { ok: true, day, rows, bytes, partial };
  } catch (e) {
    // Cause first. `fetch failed` on its own names nothing, and this repo has
    // already lost an afternoon to a message-first log that hid the one line
    // that mattered.
    const cause = e?.cause?.code || e?.cause?.message || "";
    const detail = `${e.message}${cause ? ` (${String(cause).slice(0, 120)})` : ""}`;
    status.lastError = `${new Date().toISOString()} ${detail.slice(0, 300)}`;
    log(`[dataset] FAILED dt=${day}: ${detail}`);
    return { ok: false, error: detail };
  } finally {
    running = false;
  }
}

/** Once per UTC day, an hour after the backup window so the two never contend
 *  for the same upload budget. Same 10-minute tick shape as the backup
 *  scheduler; a restart re-running a day is harmless because the day is
 *  immutable and the second run skips. */
let lastDay = null;
export function startDatasetScheduler({ log = console.log, ...sources } = {}) {
  if (!backupConfigured()) {
    log("[dataset] not configured (BACKUP_S3_* unset) - daily ecosystem snapshot disabled");
    return null;
  }
  const hour = Number.isFinite(Number(process.env.DATASET_UTC_HOUR)) ? Math.min(23, Math.max(0, Number(process.env.DATASET_UTC_HOUR))) : 5;
  const timer = setInterval(() => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getUTCHours() === hour && lastDay !== day) {
      lastDay = day;
      runDatasetSnapshot({ ...sources, day, log }).catch((e) => log(`[dataset] scheduler run threw: ${e.message}`));
    }
  }, 10 * 60 * 1000);
  timer.unref?.();
  log(`[dataset] daily ecosystem snapshot armed (UTC hour ${hour}, prefix ${DATASET_PREFIX}/dt=<day>, immutable)`);
  return timer;
}
