// All-time revenue ledger — "how much has this service ACTUALLY earned,
// since the beginning?" answered from on-chain ground truth, persistently.
//
// The live /revenue view reads a few recent hours per refresh; this module
// owns the rest of history: a SQLite table (on the /data volume, same
// pattern as stats.js) of every inbound stablecoin transfer to the revenue
// wallet on every rail, each row classified with the scanners' shared rule
// (external = not our burner + per-call-sized). A background loop backfills
// from the wallet's first funding (LEDGER_EPOCH) in polite chunked
// eth_getLogs sweeps, persisting a per-chain cursor as it goes — restarts
// resume, they never rescan — then keeps tailing the head. Solana pages
// getSignaturesForAddress back to the account's genesis once, then follows
// new signatures. Stellar forward-pages Horizon /payments with one ascending
// cursor. SUM(external) is the all-time revenue figure; every row
// keeps its tx id, so the number stays independently verifiable.
//
// Zero config: runs whenever /data exists (i.e., prod) or when
// REVENUE_LEDGER=true forces it (local/dev); CI test boots have neither, so
// tests never hammer public RPCs.
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  EVM, SOLANA_RPCS, rpcCall, pad, TRANSFER_TOPIC, USDC_SOL_MINT,
  MAX_CALL_USD, OUR_EVM_WALLETS, OUR_SOLANA_WALLETS, OUR_STELLAR_WALLETS, OUR_ALGORAND_WALLETS, USDC_ISSUER,
  getJsonAcross, ALGORAND_INDEXER_BASES,
} from "./revenue-live.js";
import { usdcDeltaForOwner, payerFromMeta, isExternalPayment } from "../scripts/revenue-scan-solana.js";

const HAS_DATA_DIR = existsSync("/data");
const DB_PATH = process.env.REVENUE_LEDGER_DB || join(HAS_DATA_DIR ? "/data" : "/tmp", "agent402-revenue.db");
export const ledgerPersistent = HAS_DATA_DIR || Boolean(process.env.REVENUE_LEDGER_DB);

// Before the wallet's first funding (service launched 2026-06-12; margin
// back to May). Per-chain block time turns this into a start block, so no
// per-chain block numbers need hardcoding. Env-overridable per chain with
// an absolute block: REVENUE_LEDGER_FROM_BASE=31000000 etc.
const LEDGER_EPOCH_MS = Date.parse(process.env.REVENUE_LEDGER_EPOCH || "2026-05-20T00:00:00Z");
// EVM rows carry no chain timestamp, so ledgerDaily DATES THEM FROM BLOCK
// HEIGHT using these. A chain missing from this table fell back to 2000ms, and
// every chain that fell back is exactly the set that went missing from
// /revenue: a settle 20h old on Monad (real 302ms blocks, assumed 2000ms) was
// filed ~80 HOURS in the past, so it never appeared on the day it happened.
// The rows were there the whole time, under the wrong date.
//
// Measured 2026-08-01 by sampling 5,000 blocks per chain and dividing by the
// elapsed timestamps, not taken from docs:
//   base 2000 · arbitrum 249 · optimism 2000 · avalanche 1136
//   celo 1000 · sei 448 · monad 302
// New rows no longer depend on this at all (syncEvmChain now stores the real
// block timestamp); it remains only to date rows recorded before that landed.
export const LEDGER_BLOCK_MS = {
  base: 2000, polygon: 2100, arbitrum: 250, robinhood: 150, // robinhood measured ~0.15s (not the 2s Orbit default)
  monad: 300, celo: 1000, avalanche: 1140, sei: 450, optimism: 2000,
};
const BLOCK_MS = LEDGER_BLOCK_MS;

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS transfers (
  chain    TEXT NOT NULL,
  wallet   TEXT NOT NULL,
  txid     TEXT NOT NULL,   -- EVM: txHash:logIndex · Solana: signature
  tx_hash  TEXT NOT NULL,
  block    INTEGER,          -- EVM block / Solana slot
  when_ts  INTEGER,          -- unix seconds when the chain reports it (Solana)
  payer    TEXT,
  usd      REAL NOT NULL,
  asset    TEXT NOT NULL,
  external INTEGER NOT NULL,
  PRIMARY KEY (chain, wallet, txid)
);
CREATE INDEX IF NOT EXISTS idx_transfers_ext ON transfers (wallet, external, chain);
CREATE TABLE IF NOT EXISTS cursors (
  chain      TEXT NOT NULL,
  wallet     TEXT NOT NULL,
  next_block INTEGER,        -- EVM: next fromBlock to scan
  newest_sig TEXT,           -- Solana: incremental anchor
  backfilled INTEGER DEFAULT 0, -- Solana: paged to account genesis
  caught_up  INTEGER DEFAULT 0,
  updated_ts INTEGER,
  PRIMARY KEY (chain, wallet)
);`);

const upsertTransfer = db.prepare(`INSERT OR IGNORE INTO transfers
  (chain, wallet, txid, tx_hash, block, when_ts, payer, usd, asset, external)
  VALUES (@chain, @wallet, @txid, @tx_hash, @block, @when_ts, @payer, @usd, @asset, @external)`);
const getCursor = db.prepare("SELECT * FROM cursors WHERE chain = ? AND wallet = ?");
const putCursor = db.prepare(`INSERT INTO cursors (chain, wallet, next_block, newest_sig, backfilled, caught_up, updated_ts)
  VALUES (@chain, @wallet, @next_block, @newest_sig, @backfilled, @caught_up, @updated_ts)
  ON CONFLICT (chain, wallet) DO UPDATE SET
    next_block = excluded.next_block, newest_sig = excluded.newest_sig,
    backfilled = excluded.backfilled, caught_up = excluded.caught_up, updated_ts = excluded.updated_ts`);

// One-off reclassification (user_version-gated): `external` is stamped at
// record time, so rule changes (the $0.50→$0.75 ceiling; wallets later added
// to the OUR_* sets, e.g. the SOR spending wallets) never touched stored
// rows. Recompute every row under the CURRENT rules whenever the migration
// version bumps. Idempotent, runs once per version, ~20k rows in well under
// a second.
const RECLASS_VERSION = 1;
function reclassifyAll() {
  if (db.pragma("user_version", { simple: true }) >= RECLASS_VERSION) return;
  const sets = { solana: OUR_SOLANA_WALLETS, stellar: OUR_STELLAR_WALLETS, algorand: OUR_ALGORAND_WALLETS };
  const rows = db.prepare("SELECT rowid, chain, payer, usd, external FROM transfers").all();
  const upd = db.prepare("UPDATE transfers SET external = ? WHERE rowid = ?");
  let flipped = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const ours = sets[r.chain] || OUR_EVM_WALLETS;
      const ext = isExternalPayment({ payer: r.payer, usd: r.usd }, { ourWallets: ours, maxUsd: MAX_CALL_USD }) ? 1 : 0;
      if (ext !== r.external) { upd.run(ext, r.rowid); flipped++; }
    }
    db.pragma(`user_version = ${RECLASS_VERSION}`);
  });
  tx();
  if (flipped) console.log(`revenue-ledger: reclassified ${flipped} rows under current rules (v${RECLASS_VERSION})`);
}
reclassifyAll();

/** Record one transfer (idempotent — the PK dedupes replays/rescans). */
export function recordTransfer(row) {
  upsertTransfer.run({ when_ts: null, payer: null, ...row, external: row.external ? 1 : 0 });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const startBlockFor = (chain, head) => {
  const env = parseInt(process.env[`REVENUE_LEDGER_FROM_${chain.toUpperCase()}`] || "", 10);
  if (Number.isFinite(env)) return Math.max(0, env);
  return Math.max(0, head - Math.ceil((Date.now() - LEDGER_EPOCH_MS) / (BLOCK_MS[chain] || 2000)));
};

/** getLogs window for one chain's ledger sync. Chains whose RPCs enforce a
 *  tighter range declare chunkBlocks (Sei: 1,900) — both other scanners
 *  honored it, this one didn't, so every Sei tick sent a 9,000-block range,
 *  the primary rejected it, the fallback walk ended on publicnode's archive
 *  gate, and the cursor never advanced: ZERO Sei rows ever despite daily
 *  canary settles (verified on-chain 2026-07-30). sei-apis serves any depth
 *  at ≤1,900 blocks per request, so backfill needs no archive lane. */
export const ledgerChunkBlocks = (c) => Math.min(c.chunkBlocks || 9000, 9000, Math.ceil(c.span / 4));

/** Advance one EVM chain's cursor by up to `maxChunks` getLogs windows. */
// Providers disagree, loudly and in their own words, about how many blocks one
// eth_getLogs may span. Measured against the ledger's own 9,000-block chunk:
//
//   avalanche  "requested too many blocks"
//   celo       "query exceeds range, retry smaller (max blocks ...)"
//   monad      "eth_getLogs is limited to a 100 range"
//
// Only `sei` ever declared a chunkBlocks, so every other chain's FALLBACK RPCs
// were unusable: the moment the first lane (Alchemy, where configured) has a
// bad day, rpcCall walks to a public RPC that rejects the range outright, the
// whole tick throws, and the chain simply stops reporting revenue.
//
// So a range rejection is no longer fatal. Parse the limit the provider names,
// or halve, and retry the SAME range smaller. The caller narrows its chunk for
// the rest of the run so one probe teaches the whole tick.
//
// The cursor is untouched here on purpose. It advances only after a range has
// actually been scanned, so a chunk that can never succeed throws and gets
// logged rather than silently skipping blocks - the one outcome that would
// lose revenue permanently.
const RANGE_ERR = /too many blocks|exceeds? range|limited to a \d+ range|range too large|block range|query returned more than/i;
const MIN_CHUNK = 100;

/**
 * Given a provider's rejection and the span we tried, what should we try next?
 * Returns null when the error is NOT a range complaint, so genuine failures
 * (auth, archive gates, network) still propagate instead of being retried into
 * a smaller shape that will fail identically.
 *
 * Exported because these three strings are real, measured provider output, and
 * a regex that stops matching them is how the fallback lanes silently die again.
 */
export function nextChunkSpan(message, span) {
  const msg = String(message || "");
  if (!RANGE_ERR.test(msg) || span <= MIN_CHUNK) return null;
  // Prefer the number the provider states ("limited to a 100 range") over a
  // blind reduction: it converges in one step instead of several.
  const stated = Number((msg.match(/(\d{2,6})\s*(?:block)?\s*range/i) || msg.match(/max blocks?\D{0,12}(\d{2,6})/i) || [])[1]);
  if (Number.isFinite(stated) && stated >= MIN_CHUNK && stated < span) return stated;
  return Math.max(MIN_CHUNK, Math.floor(span / 4));
}

async function getLogsAdaptive(c, wallet, from, to, onNarrow) {
  let span = to - from + 1;
  for (let attempt = 0; attempt < 6; attempt++) {
    const hi = from + span - 1;
    try {
      const scannedTo = Math.min(hi, to);
      const logs = await rpcCall(c.rpcs, "eth_getLogs", [{
        address: c.token,
        topics: [TRANSFER_TOPIC, null, pad(wallet)],
        fromBlock: "0x" + from.toString(16),
        toBlock: "0x" + scannedTo.toString(16),
      }], 8000);
      // Return the range actually covered. A narrowed retry scans LESS than the
      // caller asked for, and advancing the cursor past what was scanned would
      // skip those blocks forever - silently, since nothing throws.
      return { logs, scannedTo };
    } catch (e) {
      const msg = String(e?.message || e);
      const narrowed = nextChunkSpan(msg, span);
      if (narrowed === null) throw e;
      span = narrowed;
      onNarrow?.(span);
      console.warn(`revenue-ledger: ${c.label} narrowed getLogs chunk to ${span} blocks (provider: ${msg.slice(0, 60)})`);
    }
  }
  throw new Error(`${c.label}: getLogs kept failing down to ${span}-block ranges`);
}

async function syncEvmChain(chain, wallet, { maxChunks = 20 } = {}) {
  const c = EVM[chain];
  const head = parseInt(await rpcCall(c.rpcs, "eth_blockNumber", [], 6000), 16);
  const cur = getCursor.get(chain, wallet);
  let next = cur?.next_block ?? startBlockFor(chain, head);
  // Capped at 9,000 blocks like the other two scanners (revenue-scan.js and
  // the live view's recentInbound) — Alchemy rejects getLogs ranges over 10k
  // on some chains (Robinhood, verified 2026-07-08). Without the cap, any
  // cursor gap wider than the RPC limit (≈25 min of downtime at Robinhood's
  // 0.15s blocks) made every subsequent getLogs request span the whole gap,
  // fail, and never advance — the all-time figure froze with ↺ forever.
  let chunkSize = ledgerChunkBlocks(c);
  let chunks = 0;
  while (next <= head && chunks < maxChunks) {
    const to = Math.min(next + chunkSize - 1, head);
    const { logs, scannedTo } = await getLogsAdaptive(c, wallet, next, to, (smaller) => { chunkSize = smaller; });
    // EXACT dates, so a row never depends on a block-rate estimate again.
    // Only blocks that actually CONTAIN a transfer are fetched, and transfers
    // are rare (a handful per chain per day), so this is a few extra calls a
    // day rather than one per block. A failed lookup leaves when_ts null and
    // the estimate above still applies, so this can only improve accuracy.
    const blockTimes = new Map();
    for (const l of Array.isArray(logs) ? logs : []) {
      if (l?.blockNumber && !blockTimes.has(l.blockNumber)) blockTimes.set(l.blockNumber, null);
    }
    for (const bn of blockTimes.keys()) {
      try {
        const blk = await rpcCall(c.rpcs, "eth_getBlockByNumber", [bn, false], 6000);
        if (blk?.timestamp) blockTimes.set(bn, parseInt(blk.timestamp, 16));
      } catch { /* keep null - falls back to the height estimate */ }
    }
    for (const l of Array.isArray(logs) ? logs : []) {
      const usd = Number(BigInt(l.data && l.data !== "0x" ? l.data : "0x0")) / 1e6;
      const payer = l.topics?.[1] ? ("0x" + l.topics[1].slice(-40)).toLowerCase() : null;
      recordTransfer({
        chain, wallet,
        txid: `${l.transactionHash}:${parseInt(l.logIndex ?? "0x0", 16)}`,
        tx_hash: l.transactionHash,
        block: parseInt(l.blockNumber, 16),
        when_ts: blockTimes.get(l.blockNumber) ?? null,
        payer, usd, asset: c.asset,
        external: isExternalPayment({ payer, usd }, { ourWallets: OUR_EVM_WALLETS, maxUsd: MAX_CALL_USD }),
      });
    }
    next = scannedTo + 1;   // only past what was actually scanned
    chunks++;
    putCursor.run({
      chain, wallet, next_block: next, newest_sig: null, backfilled: 1,
      caught_up: next > head ? 1 : 0, updated_ts: Math.floor(Date.now() / 1000),
    });
    await sleep(150); // stay polite to public RPCs
  }
  return { caughtUp: next > head, next, head };
}

/** Solana: one-time page-to-genesis backfill, then follow new signatures. */
export async function syncSolana(wallet, { maxPages = 5 } = {}) {
  const chain = "solana";
  // Signatures MUST be read from the USDC associated token account, not the
  // owner: an inbound SPL transfer references only the token accounts, so
  // the owner's signature list never shows incoming settles (it only carried
  // ATA-creation/funding txs — the ledger recorded those, marked itself
  // caught up, and froze). Same resolution as the live card's solanaRail.
  const accts = await rpcCall(SOLANA_RPCS, "getTokenAccountsByOwner", [wallet, { mint: USDC_SOL_MINT }, { encoding: "jsonParsed" }], 8000);
  const tokenAccount = accts?.value?.[0]?.pubkey;
  if (!tokenAccount) throw new Error("no USDC token account found for the wallet");
  const cur = getCursor.get(chain, wallet);
  // next_block (unused on Solana) doubles as a mode sentinel: cursors written
  // before the token-account fix lack it, and their backfilled flag and
  // newest anchor describe the owner's history — discard both so the first
  // tick re-pages the token account's full history (the transfers PK dedupes
  // anything already recorded).
  const tokenMode = cur?.next_block === 1;
  const backfilled = tokenMode && Boolean(cur?.backfilled);
  let newest = tokenMode ? (cur?.newest_sig || null) : null;
  let before = null; // backfill pagination anchor (restarts refetch dup pages; PK dedupes)
  let pages = 0;
  let sawEnd = backfilled;
  while (pages < maxPages) {
    const opts = { limit: 100 };
    if (backfilled && newest) opts.until = newest;
    if (!backfilled && before) opts.before = before;
    const sigs = await rpcCall(SOLANA_RPCS, "getSignaturesForAddress", [tokenAccount, opts], 8000);
    if (!Array.isArray(sigs) || !sigs.length) { sawEnd = true; break; }
    if (!newest) newest = sigs[0].signature;
    if (backfilled) newest = sigs[0].signature; // follow mode: advance the anchor
    for (const s of sigs) {
      if (s.err) continue;
      // No try/catch here: rpcCall only throws when the RPC lane itself fails
      // (429/timeout — a genuinely undecodable tx returns a null result, and
      // usdcDeltaForOwner(null) is just 0). Swallowing that error silently
      // dropped the settle from all-time forever, because the cursor advanced
      // past it and no full re-pass ever happens. Let it propagate instead:
      // putCursor never runs, the tick retries in 20s, and the PK dedupes the
      // replayed page.
      const txn = await rpcCall(SOLANA_RPCS, "getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }], 8000);
      const usd = Number(usdcDeltaForOwner(txn?.meta, wallet).toFixed(6));
      if (usd > 0) {
        const payer = payerFromMeta(txn?.meta, wallet);
        recordTransfer({
          chain, wallet, txid: s.signature, tx_hash: s.signature,
          block: s.slot ?? null, when_ts: s.blockTime ?? null,
          payer, usd, asset: "USDC",
          external: isExternalPayment({ payer, usd }, { ourWallets: OUR_SOLANA_WALLETS, maxUsd: MAX_CALL_USD }),
        });
      }
      await sleep(200);
    }
    pages++;
    if (backfilled) break; // follow mode needs one page per tick
    before = sigs[sigs.length - 1].signature;
    if (sigs.length < 100) { sawEnd = true; break; }
  }
  putCursor.run({
    chain, wallet, next_block: 1, newest_sig: newest,
    backfilled: sawEnd ? 1 : 0, caught_up: sawEnd ? 1 : 0,
    updated_ts: Math.floor(Date.now() / 1000),
  });
  return { caughtUp: sawEnd };
}

/** Stellar: forward-page Horizon /payments from account genesis, then keep
 *  following. One ascending cursor (the record paging_token, stored in the
 *  newest_sig column) covers both backfill and tail — Horizon pages are
 *  ordered and cursor-resumable, so restarts continue where they left off.
 *  Classification mirrors stellarRail: classic payments checked for the
 *  Circle USDC issuer; Soroban invoke_host_function credited from its
 *  asset_balance_changes (r.source_account is the facilitator's fee channel,
 *  the change's `from` is the actual payer). */
export async function syncStellar(wallet, { maxPages = 5 } = {}) {
  const chain = "stellar";
  const cur = getCursor.get(chain, wallet);
  let cursor = cur?.newest_sig || null;
  const ours = new Set([...OUR_STELLAR_WALLETS, wallet]);
  let sawEnd = false;
  for (let pages = 0; pages < maxPages && !sawEnd; pages++) {
    const url = new URL(`https://horizon.stellar.org/accounts/${wallet}/payments`);
    url.searchParams.set("order", "asc");
    url.searchParams.set("limit", "200");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Horizon HTTP ${res.status}`);
    const records = (await res.json())?._embedded?.records || [];
    if (!records.length) { sawEnd = true; break; }
    for (const r of records) {
      cursor = r.paging_token;
      let usd = null, payer = null;
      if (r.type === "payment" || r.type === "path_payment_strict_send" || r.type === "path_payment_strict_receive") {
        if (r.to !== wallet || r.asset_code !== "USDC" || r.asset_issuer !== USDC_ISSUER) continue;
        usd = Number(r.amount) || 0;
        payer = r.from || null;
      } else if (r.type === "invoke_host_function") {
        const changes = (r.asset_balance_changes || []).filter(
          (c) => c.type === "transfer" && c.to === wallet && c.asset_code === "USDC" && c.asset_issuer === USDC_ISSUER
        );
        if (!changes.length) continue;
        usd = Number(changes.reduce((s, c) => s + Number(c.amount || 0), 0).toFixed(7));
        payer = changes[0].from || null;
      } else continue;
      recordTransfer({
        chain, wallet, txid: String(r.id), tx_hash: r.transaction_hash,
        block: null, when_ts: r.created_at ? Math.floor(Date.parse(r.created_at) / 1000) : null,
        payer, usd, asset: "USDC",
        external: isExternalPayment({ payer, usd }, { ourWallets: ours, maxUsd: MAX_CALL_USD }),
      });
    }
    if (records.length < 200) sawEnd = true;
    putCursor.run({
      chain, wallet, next_block: null, newest_sig: cursor,
      backfilled: sawEnd ? 1 : 0, caught_up: sawEnd ? 1 : 0,
      updated_ts: Math.floor(Date.now() / 1000),
    });
    if (!sawEnd) await sleep(300); // stay polite to Horizon
  }
  return { caughtUp: sawEnd };
}

/** Algorand: forward-page AlgoNode's indexer for inbound ASA 31566704 (USDC)
 *  transfers, ascending by round, using next_block as the round cursor (the
 *  AVM's block number — same role the EVM chains' next_block plays; Algorand
 *  has no signature/paging_token to reuse the way Solana/Stellar do). One
 *  indexer page (limit 1000) per chunk; a short page (< limit) means caught
 *  up. min-round is bumped past the highest confirmed-round actually seen
 *  each page (not just cursor+limit), so it's correct regardless of the
 *  indexer's internal sort order. Classification mirrors algorandRail: a
 *  per-record asset-id re-check even though the URL already filters —
 *  defense in depth against a filter regression/typo. */
// ALGORAND_INDEXER_URL pins a single indexer; otherwise walk the shared base
// list from revenue-live (Cloudflare relay first when configured — Nodely
// 403s Railway's egress IP, see workers/algorand-relay/).
const ALGORAND_INDEXER_LIST = process.env.ALGORAND_INDEXER_URL
  ? [process.env.ALGORAND_INDEXER_URL.trim().replace(/\/+$/, "")]
  : ALGORAND_INDEXER_BASES;
const ALGORAND_USDC_ASA = 31566704;
export async function syncAlgorand(wallet, { maxPages = 5 } = {}) {
  const chain = "algorand";
  const cur = getCursor.get(chain, wallet);
  let minRound = cur?.next_block ?? 0;
  const ours = new Set([...OUR_ALGORAND_WALLETS, wallet]);
  let sawEnd = false;
  for (let pages = 0; pages < maxPages && !sawEnd; pages++) {
    const path =
      `/v2/accounts/${wallet}/transactions?asset-id=${ALGORAND_USDC_ASA}` +
      `&tx-type=axfer&min-round=${minRound}&limit=1000`;
    const res = await getJsonAcross(ALGORAND_INDEXER_LIST, path, { timeoutMs: 8000 });
    if (!res.ok) throw new Error(res.error || `indexer HTTP ${res.status}`);
    const txns = res.json?.transactions || [];
    if (!txns.length) { sawEnd = true; break; }
    let highestRound = minRound - 1;
    for (const t of txns) {
      const xfer = t["asset-transfer-transaction"];
      if (!xfer || xfer["asset-id"] !== ALGORAND_USDC_ASA || xfer.receiver !== wallet) continue;
      const usd = Number(xfer.amount) / 1e6;
      const payer = t.sender || null;
      recordTransfer({
        chain, wallet, txid: t.id, tx_hash: t.id,
        block: t["confirmed-round"] ?? null,
        when_ts: t["round-time"] ?? null,
        payer, usd, asset: "USDC",
        external: isExternalPayment({ payer, usd }, { ourWallets: ours, maxUsd: MAX_CALL_USD }),
      });
      if (Number.isFinite(t["confirmed-round"])) highestRound = Math.max(highestRound, t["confirmed-round"]);
    }
    if (txns.length < 1000) sawEnd = true;
    minRound = highestRound + 1;
    putCursor.run({
      chain, wallet, next_block: minRound, newest_sig: null,
      backfilled: sawEnd ? 1 : 0, caught_up: sawEnd ? 1 : 0,
      updated_ts: Math.floor(Date.now() / 1000),
    });
    if (!sawEnd) await sleep(150); // stay polite to AlgoNode
  }
  return { caughtUp: sawEnd };
}

/** All-time totals + sync progress — cheap enough to run per request. */
// One (chain, wallet) pair per scanned wallet. baseExtraWallets are ADDITIONAL
// revenue wallets on Base only — the SOR spending wallet receives the
// route-execute Base leg (SELF_FUNDING_SLUGS), which is real revenue that the
// treasury-only scan missed entirely.
// EVM rows are stored lowercase (sync normalizes); Solana base58, Stellar
// G… addresses, and Algorand base32 addresses are all case-exact.
function walletPairs({ walletAddress, solanaWallet, stellarWallet, algorandWallet, baseExtraWallets = [], algorandExtraWallets = [] }) {
  return [
    ...Object.keys(EVM).map((k) => [k, walletAddress?.toLowerCase()]),
    ...baseExtraWallets.filter(Boolean).map((w) => ["base", w.toLowerCase()]),
    ["solana", solanaWallet], ["stellar", stellarWallet], ["algorand", algorandWallet],
    // AVM spending wallet (chain-matched self-funding). Base58-family
    // addresses are NEVER case-folded - folding merges distinct wallets
    // (same rule as src/payer.js).
    ...algorandExtraWallets.filter(Boolean).map((w) => ["algorand", w]),
  ];
}

/**
 * Per-chain sync state: where each cursor sits, how far behind the head it is,
 * and when it last moved.
 *
 * WHY THIS EXISTS. The canary settled on avalanche, celo and monad on
 * 2026-07-31 and those settlements are verifiably on-chain (two $0.001 Celo
 * transfers to the treasury, found by direct getLogs), yet the ledger reported
 * zero for all three that day. No error was logged, because none was thrown:
 * a chain that is merely BEHIND looks exactly like a chain with no activity,
 * and every surface built on this data — /revenue, the daily digest's
 * "Scan: ok" column — reported healthy throughout.
 *
 * A scan that returns nothing because it has not got there yet must not be
 * indistinguishable from a scan that returns nothing because nothing happened.
 * `lagBlocks` is the number that tells them apart, and until now nothing
 * exposed it.
 *
 * Operator-only: cursor positions and wallet addresses are not public data.
 */
/** The newest inbound transfers for a chain, in the shape the revenue rail
 *  cards already render.
 *
 *  WHY THIS EXISTS: the rail card built `recent[]` by re-scanning the chain on
 *  every snapshot refresh - chunked eth_getLogs across six EVM rails, measured
 *  at 221 Alchemy calls per refresh by a production egress census. Crawler
 *  traffic kept that cache warm, so it ran up to 144 times a day: on the order
 *  of a million billed calls a month, to redisplay transfers this table has
 *  already stored.
 *
 *  The ledger is the same data from the same source, indexed once by the
 *  background sync instead of re-derived per page view. Balances still need a
 *  live read (a balance is not a transfer, and nothing here records it), but
 *  those are single eth_call reads that already go publics-first - they were
 *  never the expensive part.
 *
 *  Returns [] when the ledger has nothing for this chain, which the caller
 *  MUST treat as "fall back to the live scan" rather than "no activity" - a
 *  cold boot or a chain we do not sync would otherwise silently render as
 *  zero settlements. */
export function ledgerRecent(chain, wallets, { limit = 8 } = {}) {
  // EVM addresses are stored lowercase by recordTransfer, and WALLET_ADDRESS is
  // checksummed - so an un-normalised IN clause matches nothing and every rail
  // silently falls back to the live chain scan. That is exactly what happened:
  // the ledger path shipped, never engaged once, and the tests passed because
  // they asserted the FALLBACK worked rather than that the ledger was used.
  //
  // ONLY 0x addresses are folded. Solana and Algorand are base58/base32 and
  // case-SENSITIVE; lowercasing those would merge or lose distinct accounts,
  // which is the rule src/payer.js states for the same reason.
  const norm = (w) => (/^0x[0-9a-fA-F]{40}$/.test(String(w)) ? String(w).toLowerCase() : String(w));
  const list = (Array.isArray(wallets) ? wallets : [wallets]).filter(Boolean).map(norm);
  if (!chain || !list.length) return [];
  try {
    const placeholders = list.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT tx_hash, block, when_ts, payer, usd, asset, external
         FROM transfers WHERE chain = ? AND wallet IN (${placeholders})
        ORDER BY COALESCE(block, 0) DESC, COALESCE(when_ts, 0) DESC
        LIMIT ?`
    ).all(chain, ...list, Math.max(1, Math.min(50, limit)));
    return rows.map((r) => ({
      usd: Number(r.usd),
      from: r.payer || null,
      txHash: r.tx_hash,
      block: r.block ?? null,
      // when_ts is unix SECONDS; the card renders an ISO string.
      when: r.when_ts ? new Date(r.when_ts * 1000).toISOString() : null,
      external: Boolean(r.external),
      internal: !r.external && r.payer != null,
      asset: r.asset || null,
      fromLedger: true,
    }));
  } catch {
    // A ledger read must never break the revenue page - the live scan is still
    // there, and returning [] routes the caller to it.
    return [];
  }
}

// Tx hashes this ledger has actually SEEN ON-CHAIN, for reconciling against the
// settlement receipts recorded at serve time. `tx_hash` (not `txid`) is the
// join key: EVM txids carry a `:logIndex` suffix that a settle receipt never
// has, so matching on txid would report every EVM settlement as missing.
const qTxHashes = db.prepare("SELECT DISTINCT tx_hash FROM transfers WHERE chain = ? AND tx_hash IS NOT NULL");
/** Set of tx hashes seen on-chain for a chain. Case-exact: base58/base32
 *  signatures are case-sensitive, and folding them merges distinct txs. */
export function onchainTxHashes(chain) {
  return new Set(qTxHashes.all(String(chain || "")).map((r) => r.tx_hash));
}

/** Which chains this ledger actually tracks. A chain with NO coverage is not
 *  "clean" - it is unscanned, and reconciliation must say so rather than report
 *  its settlements as missing money.
 *
 *  Coverage is a cursor OR any recorded transfer, and it needs both halves. A
 *  cursor with no transfers yet is still scanned (we would know if a payment
 *  landed), and transfers with no cursor row still prove we can see the chain.
 *  Reading cursors alone classified a chain we plainly had data for as
 *  unverifiable. */
export function ledgerTrackedChains() {
  const out = new Map();
  for (const r of db.prepare("SELECT DISTINCT chain FROM transfers").all()) {
    out.set(r.chain, { updatedTs: null, caughtUp: null });
  }
  for (const r of db.prepare("SELECT chain, MAX(updated_ts) AS updated_ts, MIN(caught_up) AS caught_up FROM cursors GROUP BY chain").all()) {
    out.set(r.chain, { updatedTs: r.updated_ts || null, caughtUp: r.caught_up === 1 });
  }
  return out;
}

export function ledgerSyncState() {
  const rows = db.prepare("SELECT chain, wallet, next_block, caught_up, updated_ts FROM cursors").all();
  const now = Math.floor(Date.now() / 1000);
  return rows
    .map((r) => ({
      chain: r.chain,
      // Never expose a full wallet on an ops surface; the prefix is enough to
      // tell two cursors on the same chain apart.
      wallet: String(r.wallet || "").slice(0, 10),
      nextBlock: r.next_block,
      caughtUp: r.caught_up === 1,
      updatedAt: r.updated_ts ? new Date(r.updated_ts * 1000).toISOString() : null,
      staleSeconds: r.updated_ts ? now - r.updated_ts : null,
    }))
    .sort((a, b) => a.chain.localeCompare(b.chain) || a.wallet.localeCompare(b.wallet));
}

export function ledgerSummary(wallets) {
  const per = {};
  let allTimeExternalUsd = 0;
  let allTimeExternalCount = 0;
  let allTimeInboundUsd = 0;
  let allTimeInboundCount = 0;
  const q = db.prepare(`SELECT
      COUNT(*) AS n, COALESCE(SUM(usd), 0) AS usd,
      COALESCE(SUM(CASE WHEN external = 1 THEN usd END), 0) AS extUsd,
      COALESCE(SUM(external), 0) AS extN
    FROM transfers WHERE chain = ? AND wallet = ?`);
  for (const [chain, wallet] of walletPairs(wallets)) {
    if (!wallet) continue;
    const t = q.get(chain, wallet);
    const cur = getCursor.get(chain, wallet);
    // Two wallets on one chain (treasury + spending) ACCUMULATE into one row.
    const p = per[chain] || (per[chain] = { externalUsd: 0, externalCount: 0, inboundUsd: 0, inboundCount: 0, caughtUp: true, syncedAt: null });
    p.externalUsd = Number((p.externalUsd + t.extUsd).toFixed(6));
    p.externalCount += t.extN;
    p.inboundUsd = Number((p.inboundUsd + t.usd).toFixed(6));
    p.inboundCount += t.n;
    p.caughtUp = p.caughtUp && Boolean(cur?.caught_up);
    p.syncedAt = Math.max(p.syncedAt ?? 0, cur?.updated_ts ?? 0) || null;
    allTimeExternalUsd += t.extUsd;
    allTimeExternalCount += t.extN;
    allTimeInboundUsd += t.usd;
    allTimeInboundCount += t.n;
  }
  return {
    allTimeExternalUsd: Number(allTimeExternalUsd.toFixed(6)),
    allTimeExternalCount,
    // ALL settled inbound transfers, our own canary/volume/test wallets
    // included — the /revenue throughput band's number. Never presented as
    // revenue: throughput proves the rails, external proves the demand.
    allTimeInboundUsd: Number(allTimeInboundUsd.toFixed(6)),
    allTimeInboundCount,
    perChain: per,
    persistent: ledgerPersistent,
    syncing: Object.values(per).some((p) => !p.caughtUp),
  };
}

let loopStarted = false;
/** Boot the background sync loop. Fast ticks while backfilling, then a
 *  5-minute tail. Errors back off to the next tick — never crash the app. */
/** Daily revenue series for the /revenue chart: one row per (day, chain) with
 *  external vs internal (canary-sized) USD + tx counts. Funding/sweep-sized
 *  non-external inbound is EXCLUDED — the chart compares revenue-shaped flows.
 *  EVM rows carry no when_ts; their day is estimated from block height
 *  anchored to the sync cursor (next_block ≈ chain head at updated_ts) via the
 *  per-chain block cadence — no network calls, accurate to sync lag, and
 *  drift over months only ever mis-buckets a row by a day at the boundary. */
// `mppTx` is an optional Set of tx hashes whose credential arrived over the MPP
// wire (from the separate sales db — on-chain, an MPP settlement is identical to
// an x402 one, so the wire cannot be derived here). When supplied, each bucket
// also carries its MPP subset, letting the chart filter by wire. Absent or
// empty, the extra fields are all zero and the series behaves exactly as before.
export function ledgerDaily(wallets, mppTx = null) {
  const isMpp = (h) => {
    if (!mppTx || !mppTx.size || !h) return false;
    return mppTx.has(h) || (/^0x[0-9a-fA-F]+$/.test(h) && mppTx.has(h.toLowerCase()));
  };
  const rows = db.prepare("SELECT chain, wallet, block, when_ts, usd, external, tx_hash FROM transfers WHERE wallet = ?");
  const chains = walletPairs(wallets);
  // Settled-to split: rows received by the SOR spending wallet (self-funding
  // slugs: route-execute tiers + Blockscout kit) vs the treasury. On-chain
  // truth by receiving wallet - the /revenue SOR filter reads these fields.
  const sorWallets = new Set([
    ...(wallets.baseExtraWallets || []).filter(Boolean).map((w) => w.toLowerCase()),
    // AVM addresses join verbatim - never case-folded.
    ...(wallets.algorandExtraWallets || []).filter(Boolean),
  ]);
  const byDay = new Map(); // "YYYY-MM-DD|chain" -> {extUsd, extTx, intUsd, intTx}
  for (const [chain, wallet] of chains) {
    if (!wallet) continue;
    const cur = getCursor.get(chain, wallet);
    const anchorBlock = cur?.next_block ?? null;
    const anchorMs = cur?.updated_ts ? cur.updated_ts * 1000 : Date.now();
    const cadence = BLOCK_MS[chain] || 2000;
    for (const t of rows.all(wallet)) {
      if (t.chain !== chain) continue;
      let ms = t.when_ts ? t.when_ts * 1000 : null;
      if (ms == null && t.block != null && anchorBlock != null) ms = anchorMs - (anchorBlock - t.block) * cadence;
      if (ms == null) continue; // undateable row — skip rather than guess
      const day = new Date(ms).toISOString().slice(0, 10);
      const key = `${day}|${chain}`;
      const b = byDay.get(key) || {
        day, chain, extUsd: 0, extTx: 0, intUsd: 0, intTx: 0,
        extMppUsd: 0, extMppTx: 0, intMppUsd: 0, intMppTx: 0,
        extSorUsd: 0, extSorTx: 0, intSorUsd: 0, intSorTx: 0,
      };
      const mpp = isMpp(t.tx_hash);
      const sor = sorWallets.has(wallet);
      if (t.external) {
        b.extUsd += t.usd; b.extTx += 1;
        if (mpp) { b.extMppUsd += t.usd; b.extMppTx += 1; }
        if (sor) { b.extSorUsd += t.usd; b.extSorTx += 1; }
      } else if (t.usd <= MAX_CALL_USD) { // canary-sized only
        b.intUsd += t.usd; b.intTx += 1;
        if (mpp) { b.intMppUsd += t.usd; b.intMppTx += 1; }
        if (sor) { b.intSorUsd += t.usd; b.intSorTx += 1; }
      }
      byDay.set(key, b);
    }
  }
  // Chart epoch: the pre-launch trickle (ledger backfill of pre-launch dust)
  // adds a flat run of near-zero bars — start the series at June 15 unless
  // the operator overrides.
  const start = process.env.REVENUE_DAILY_START || "2026-06-15";
  return [...byDay.values()]
    .filter((b) => b.day >= start)
    .map((b) => ({
      ...b,
      extUsd: Number(b.extUsd.toFixed(6)), intUsd: Number(b.intUsd.toFixed(6)),
      extMppUsd: Number(b.extMppUsd.toFixed(6)), intMppUsd: Number(b.intMppUsd.toFixed(6)),
    }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.chain.localeCompare(b.chain)));
}

/**
 * Distinct EXTERNAL buyers per day, oldest first.
 *
 * Answers "are we winning more buyers, or is the same handful paying more?",
 * which transaction counts alone cannot: 200 calls is one whale or fifty
 * customers and the revenue line looks identical either way.
 *
 * Three things this gets right on purpose:
 *   • A buyer is counted ONCE PER DAY no matter how many chains they paid on.
 *     The transfer rows are keyed by day+chain, so counting there would report
 *     a multi-chain buyer as two buyers.
 *   • `cumulative` is a running UNION, never a sum of the daily counts. Summing
 *     distinct counts double-counts every returning buyer and would turn a
 *     stagnant handful into an impressive-looking climb — the exact illusion
 *     this series exists to dispel.
 *   • `newBuyers` is measured against ALL prior history, not just the charted
 *     window, so nobody is called "new" merely because the epoch cuts them off.
 *
 * `unattributed` counts external payments whose payer could not be read from
 * the chain scan. Those are in the revenue totals but cannot be attributed to a
 * buyer, so the page can say so instead of quietly undercounting.
 *
 * Returns counts only. Buyer addresses are public on-chain, but publishing a
 * per-day roster of who pays us is a customer list, so it stays out.
 */
export function ledgerBuyersDaily(wallets) {
  const rows = db.prepare("SELECT chain, wallet, block, when_ts, usd, external, payer FROM transfers WHERE wallet = ?");
  const chains = walletPairs(wallets);
  const byDay = new Map(); // day -> Set(payer)
  const unattributed = new Map(); // day -> count
  const firstSeen = new Map(); // payer -> earliest day ever, across ALL history

  for (const [chain, wallet] of chains) {
    if (!wallet) continue;
    const cur = getCursor.get(chain, wallet);
    const anchorBlock = cur?.next_block ?? null;
    const anchorMs = cur?.updated_ts ? cur.updated_ts * 1000 : Date.now();
    const cadence = BLOCK_MS[chain] || 2000;
    for (const t of rows.all(wallet)) {
      if (t.chain !== chain || !t.external) continue;
      let ms = t.when_ts ? t.when_ts * 1000 : null;
      if (ms == null && t.block != null && anchorBlock != null) ms = anchorMs - (anchorBlock - t.block) * cadence;
      if (ms == null) continue; // undateable row — skip rather than guess
      const day = new Date(ms).toISOString().slice(0, 10);
      // EVM addresses are case-insensitive; base58/Stellar are NOT (see
      // src/payer.js — never lowercase those or two buyers merge into one).
      const raw = t.payer || null;
      if (!raw) { unattributed.set(day, (unattributed.get(day) || 0) + 1); continue; }
      const payer = /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw.toLowerCase() : raw;
      if (!byDay.has(day)) byDay.set(day, new Set());
      byDay.get(day).add(payer);
      const prev = firstSeen.get(payer);
      if (!prev || day < prev) firstSeen.set(payer, day);
    }
  }

  const start = process.env.REVENUE_DAILY_START || "2026-06-15";
  const allDays = [...new Set([...byDay.keys(), ...unattributed.keys()])].sort();
  const seen = new Set();
  const out = [];
  for (const day of allDays) {
    const set = byDay.get(day) || new Set();
    for (const p of set) seen.add(p); // union BEFORE the window filter, so the
    // cumulative line is a true all-time distinct count rather than restarting
    // at the chart epoch.
    if (day < start) continue;
    let fresh = 0;
    for (const p of set) if (firstSeen.get(p) === day) fresh++;
    out.push({
      day,
      buyers: set.size,
      newBuyers: fresh,
      returningBuyers: set.size - fresh,
      cumulative: seen.size,
      unattributed: unattributed.get(day) || 0,
    });
  }
  return out;
}

/**
 * Buyer concentration over the charted window: how much of our external volume
 * comes from the biggest few wallets.
 *
 * The daily series answers "how many buyers"; this answers the other half,
 * "does it matter". Two hundred buyers where one wallet is 80% of payments is a
 * single-customer business wearing a crowd as a costume, and only this number
 * says so.
 *
 * Shares are of PAYMENT COUNT, not dollars: at sub-cent prices a single
 * expensive call would otherwise masquerade as concentration. Counts and
 * percentages only, never addresses.
 */
export function ledgerBuyerConcentration(wallets) {
  const rows = db.prepare("SELECT chain, wallet, block, when_ts, external, payer FROM transfers WHERE wallet = ?");
  const chains = walletPairs(wallets);
  const start = process.env.REVENUE_DAILY_START || "2026-06-15";
  const counts = new Map();
  let payments = 0;
  for (const [chain, wallet] of chains) {
    if (!wallet) continue;
    const cur = getCursor.get(chain, wallet);
    const anchorBlock = cur?.next_block ?? null;
    const anchorMs = cur?.updated_ts ? cur.updated_ts * 1000 : Date.now();
    const cadence = BLOCK_MS[chain] || 2000;
    for (const t of rows.all(wallet)) {
      if (t.chain !== chain || !t.external || !t.payer) continue;
      let ms = t.when_ts ? t.when_ts * 1000 : null;
      if (ms == null && t.block != null && anchorBlock != null) ms = anchorMs - (anchorBlock - t.block) * cadence;
      if (ms == null) continue;
      if (new Date(ms).toISOString().slice(0, 10) < start) continue;
      const payer = /^0x[0-9a-fA-F]{40}$/.test(t.payer) ? t.payer.toLowerCase() : t.payer;
      counts.set(payer, (counts.get(payer) || 0) + 1);
      payments++;
    }
  }
  if (!payments) return { buyers: 0, payments: 0, topSharePct: null, top5SharePct: null };
  const sorted = [...counts.values()].sort((a, b) => b - a);
  const pct = (n) => Math.round((n / payments) * 1000) / 10;
  return {
    buyers: counts.size,
    payments,
    topSharePct: pct(sorted[0]),
    top5SharePct: pct(sorted.slice(0, 5).reduce((a, b) => a + b, 0)),
  };
}

export function startRevenueLedger({ walletAddress, solanaWallet, stellarWallet, algorandWallet, baseExtraWallets = [] }) {
  const enabled = HAS_DATA_DIR || process.env.REVENUE_LEDGER === "true";
  if (loopStarted || !enabled || (!walletAddress && !solanaWallet && !stellarWallet && !algorandWallet)) return false;
  loopStarted = true;
  const tick = async () => {
    let allCaughtUp = true;
    if (walletAddress) {
      for (const chain of Object.keys(EVM)) {
        try {
          const r = await syncEvmChain(chain, walletAddress.toLowerCase());
          if (!r.caughtUp) allCaughtUp = false;
        } catch (e) {
          allCaughtUp = false;
          console.warn(`revenue-ledger: ${chain} sync tick failed (will retry): ${String(e?.message || e).slice(0, 100)}`);
        }
      }
    }
    // Extra Base revenue wallets (the SOR spending wallet: route-execute's
    // Base leg settles here — revenue, not float).
    for (const w of baseExtraWallets.filter(Boolean)) {
      try {
        const r = await syncEvmChain("base", w.toLowerCase());
        if (!r.caughtUp) allCaughtUp = false;
      } catch (e) {
        allCaughtUp = false;
        console.warn(`revenue-ledger: base extra-wallet sync tick failed (will retry): ${String(e?.message || e).slice(0, 100)}`);
      }
    }
    if (solanaWallet) {
      try {
        const r = await syncSolana(solanaWallet);
        if (!r.caughtUp) allCaughtUp = false;
      } catch (e) {
        allCaughtUp = false;
        console.warn(`revenue-ledger: solana sync tick failed (will retry): ${String(e?.message || e).slice(0, 100)}`);
      }
    }
    if (stellarWallet) {
      try {
        const r = await syncStellar(stellarWallet);
        if (!r.caughtUp) allCaughtUp = false;
      } catch (e) {
        allCaughtUp = false;
        console.warn(`revenue-ledger: stellar sync tick failed (will retry): ${String(e?.message || e).slice(0, 100)}`);
      }
    }
    if (algorandWallet) {
      try {
        const r = await syncAlgorand(algorandWallet);
        if (!r.caughtUp) allCaughtUp = false;
      } catch (e) {
        allCaughtUp = false;
        console.warn(`revenue-ledger: algorand sync tick failed (will retry): ${String(e?.message || e).slice(0, 100)}`);
      }
    }
    setTimeout(tick, allCaughtUp ? 300_000 : 20_000).unref?.();
  };
  setTimeout(tick, 5_000).unref?.(); // let boot settle first
  console.log(`revenue-ledger: sync loop started (db: ${DB_PATH})`);
  return true;
}
