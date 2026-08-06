// Settlement reconciliation — did the money we were told arrived actually arrive?
//
// Both ledgers are pointed at temp files BEFORE import so this touches no real
// data. Offline: no RPC, no network. The whole check is a join between two
// SQLite files we already keep.
//
// The defect being guarded: a facilitator reports a settlement succeeded, we
// return the buyer's answer, and no transfer ever lands. Measured on Solana
// 2026-08-06 at 11% of one day's settlements and 25% of the next.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "a402-reconcile-"));
process.env.SALES_LEDGER_DB = join(dir, "sales.db");
process.env.REVENUE_LEDGER_DB = join(dir, "revenue.db");
process.env.RECONCILE_GRACE_MS = "3600000";

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };

const { recordSale } = await import("../src/sales-ledger.js");
const { recordTransfer } = await import("../src/revenue-ledger.js");
const { reconcileSettlements } = await import("../src/settlement-reconcile.js");

const NOW = 1_800_000_000_000;
const OLD = NOW - 3 * 3600_000;   // outside the grace window, judged
const BUYER = "0x1234567890123456789012345678901234567890";

// Helper: recordSale stamps Date.now(), so freeze it for deterministic ages.
const realNow = Date.now;
const at = (ms, fn) => { Date.now = () => ms; try { return fn(); } finally { Date.now = realNow; } };

// --- a settlement that DID land ---------------------------------------------
at(OLD, () => recordSale({ slug: "hash", priceUsd: 0.001, rail: "usdc", network: "base", payer: BUYER, tx: "0xLANDED", synthetic: false }));
recordTransfer({ chain: "base", wallet: "w", txid: "0xLANDED:0", tx_hash: "0xLANDED", block: 1, when_ts: OLD / 1000, payer: BUYER, usd: 0.001, asset: "USDC", external: 1 });

// --- a settlement the facilitator claimed but that never landed --------------
at(OLD, () => recordSale({ slug: "random", priceUsd: 0.001, rail: "usdc", network: "base", payer: BUYER, tx: "0xGHOST", synthetic: false }));

let r = reconcileSettlements({ days: 7, now: NOW });
const base = r.chains.find((c) => c.chain === "base");
ok(base.claimed === 2, `both settlements counted as claimed (got ${base.claimed})`);
ok(base.confirmed === 1, `the transfer seen on-chain is confirmed (got ${base.confirmed})`);
ok(base.unconfirmed === 1, `the one that never landed is UNCONFIRMED (got ${base.unconfirmed})`);
ok(base.unconfirmedPct === 50, `reported as a RATE, not a dollar total (got ${base.unconfirmedPct}%)`);
ok(base.samples.length === 1 && base.samples[0].slug === "random", "an unconfirmed sample names the tool, so it is actionable");

// --- the grace window: a fresh settlement is PENDING, never "missing" --------
// A settle recorded seconds ago has not had time to be scanned. Counting it as
// unconfirmed would make every healthy run look like a leak.
at(NOW - 60_000, () => recordSale({ slug: "uuid", priceUsd: 0.001, rail: "usdc", network: "base", payer: BUYER, tx: "0xFRESH", synthetic: false }));
r = reconcileSettlements({ days: 7, now: NOW });
const base2 = r.chains.find((c) => c.chain === "base");
ok(base2.pending === 1, `a settlement inside the grace window is PENDING (got ${base2.pending})`);
ok(base2.unconfirmed === 1, "...and is NOT counted as unconfirmed (that would cry leak on every healthy run)");

// --- an unscanned chain is UNVERIFIABLE, never "clean" ----------------------
// The failure this repo keeps re-learning: an unreadable result treated as a
// good one. A chain with no cursor cannot be reconciled, and must say so.
at(OLD, () => recordSale({ slug: "hash", priceUsd: 0.001, rail: "usdc", network: "monad", payer: BUYER, tx: "0xNOSCAN", synthetic: false }));
r = reconcileSettlements({ days: 7, now: NOW });
const monad = r.chains.find((c) => c.chain === "monad");
ok(monad.scanned === false, "a chain with no on-chain cursor is flagged scanned=false");
ok(monad.unconfirmed === 0 && monad.confirmed === 0, "...and its settlements are neither confirmed nor reported as missing");
ok(/NOT RECONCILED/.test(monad.note || ""), `...and the note says so plainly (got ${JSON.stringify(monad.note)})`);
ok(r.totals.unscannedChains.includes("monad"), "unscanned chains are named in the totals, not silently dropped");

// --- free rails carry no claim and must not enter the reconciliation ---------
at(OLD, () => recordSale({ slug: "hash", priceUsd: 0.001, rail: "pow", network: null, payer: null, tx: null, synthetic: false }));
r = reconcileSettlements({ days: 7, now: NOW });
ok(!r.chains.some((c) => c.chain === "(unknown)" && c.claimed > 1),
  "a free proof-of-work call is not a settlement claim and never appears as one");

// --- a settlement with no tx is counted separately, not assumed good ---------
at(OLD, () => recordSale({ slug: "hash", priceUsd: 0.001, rail: "usdc", network: "solana", payer: null, tx: null, synthetic: false }));
r = reconcileSettlements({ days: 7, now: NOW });
const sol = r.chains.find((c) => c.chain === "solana");
ok(sol.noTx === 1, `a receipt without a tx hash is counted as noTx (got ${sol.noTx})`);
ok(sol.confirmed === 0, "...and is NOT counted as confirmed - there is no claim to check");

// --- internal (canary/burner) traffic is our own money, not a leak ----------
at(OLD, () => recordSale({ slug: "hash", priceUsd: 0.001, rail: "usdc", network: "base", payer: BUYER, tx: "0xINTERNAL", synthetic: true }));
r = reconcileSettlements({ days: 7, now: NOW });
const base3 = r.chains.find((c) => c.chain === "base");
ok(base3.unconfirmed === 1, "a synthetic (canary) settlement is excluded - paying ourselves is not revenue to reconcile");

rmSync(dir, { recursive: true, force: true });
console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
