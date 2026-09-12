#!/usr/bin/env node
// Offline test for ledgerBuyersDaily — the distinct-buyer series behind
// "are we winning more buyers, or is the same handful paying more?"
//
// Distinct counts are easy to get subtly, flatteringly wrong, and every trap
// below fails in the direction of making us look better than we are:
//   • summing daily distinct counts instead of a running union turns a
//     stagnant handful of buyers into a rising line
//   • counting per day+chain reports one multi-chain buyer as two
//   • measuring "new" only against the charted window relabels old buyers as
//     new every time the epoch moves
//   • lowercasing base58/Stellar addresses merges distinct buyers into one
// Each is asserted here against a seeded ledger.
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "a402-buyers-"));
process.env.REVENUE_LEDGER_DB = join(dir, "ledger.db");
process.env.REVENUE_DAILY_START = "2026-06-15";

const { recordTransfer, ledgerBuyersDaily, ledgerBuyerRetention, ledgerDaily, ledgerSyncState, nextChunkSpan, LEDGER_BLOCK_MS } = await import("../src/revenue-ledger.js");

const WALLET = "0xwallet";
const day = (d) => Math.floor(Date.parse(`${d}T12:00:00Z`) / 1000);
let seq = 0;
const give = (d, payer, { chain = "base", usd = 0.01, external = 1 } = {}) =>
  recordTransfer({
    chain, wallet: WALLET, txid: `t${++seq}`, tx_hash: `0x${seq}`, block: 1000 + seq,
    when_ts: day(d), payer, usd, asset: "USDC", external,
  });

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};
const wallets = { walletAddress: WALLET, solanaWallet: WALLET, stellarWallet: WALLET, algorandWallet: WALLET };
const on = (rows, d) => rows.find((r) => r.day === d);

console.log("revenue buyers — distinct-count semantics");

// alice pays on two chains the same day; bob joins later and returns.
give("2026-06-20", "0xAAAA000000000000000000000000000000000001");
give("2026-06-20", "0xaaaa000000000000000000000000000000000001", { chain: "solana" }); // same buyer, different case + chain
give("2026-06-21", "0xBBBB000000000000000000000000000000000002");
give("2026-06-21", "0xAAAA000000000000000000000000000000000001");
give("2026-06-22", "0xBBBB000000000000000000000000000000000002");
give("2026-06-22", "0xBBBB000000000000000000000000000000000002"); // twice in one day

let rows = ledgerBuyersDaily(wallets);

check("a buyer paying on two chains the same day counts once", () => {
  assert.equal(on(rows, "2026-06-20").buyers, 1);
});

check("repeat payments in a day do not inflate the buyer count", () => {
  assert.equal(on(rows, "2026-06-22").buyers, 1);
  assert.equal(on(rows, "2026-06-22").returningBuyers, 1);
  assert.equal(on(rows, "2026-06-22").newBuyers, 0);
});

check("new vs returning splits correctly", () => {
  const d21 = on(rows, "2026-06-21");
  assert.equal(d21.buyers, 2);
  assert.equal(d21.newBuyers, 1, "only bob is new on the 21st");
  assert.equal(d21.returningBuyers, 1, "alice is returning");
});

check("cumulative is a running union, never a sum of daily counts", () => {
  const sumOfDaily = rows.reduce((n, r) => n + r.buyers, 0);
  const last = rows.at(-1).cumulative;
  assert.equal(last, 2, "only two distinct buyers ever existed");
  assert.ok(last < sumOfDaily, `cumulative ${last} must be below the naive sum ${sumOfDaily}`);
  // Monotonic, and never above the true distinct total.
  let prev = 0;
  for (const r of rows) { assert.ok(r.cumulative >= prev, "cumulative went backwards"); prev = r.cumulative; }
});

check("base58 and Stellar addresses are never case-folded together", () => {
  give("2026-06-25", "GABCDEF");
  give("2026-06-25", "gabcdef"); // a DIFFERENT account on a case-sensitive chain
  const r = ledgerBuyersDaily(wallets);
  assert.equal(on(r, "2026-06-25").buyers, 2, "case-sensitive chains must not merge buyers");
});

check("internal (canary) payments are excluded entirely", () => {
  give("2026-06-26", "0xCCCC000000000000000000000000000000000003", { external: 0 });
  const r = ledgerBuyersDaily(wallets);
  assert.equal(on(r, "2026-06-26"), undefined, "an internal-only day should produce no buyer row");
});

check("payments with no readable payer are surfaced, not silently dropped", () => {
  give("2026-06-27", null);
  const r = ledgerBuyersDaily(wallets);
  const d = on(r, "2026-06-27");
  assert.equal(d.unattributed, 1);
  assert.equal(d.buyers, 0, "an unreadable payer is not a buyer we can count");
});

check("a buyer first seen BEFORE the window is not relabelled new inside it", () => {
  process.env.REVENUE_DAILY_START = "2026-06-21"; // cut off alice's first day
  const r = ledgerBuyersDaily(wallets);
  const d21 = on(r, "2026-06-21");
  assert.equal(d21.newBuyers, 1, "bob only; alice's history predates the epoch but she is not new");
  assert.equal(d21.cumulative, 2, "cumulative counts alice even though her first day is outside the window");
  process.env.REVENUE_DAILY_START = "2026-06-15";
});

// --- per-chain sync state must be inspectable, and must not leak wallets ----
//
// A chain that is merely BEHIND yields no rows and throws no error, which is
// indistinguishable from a chain with no activity. That is how canary
// settlements verified on-chain (two $0.001 Celo transfers to the treasury)
// went missing from /revenue while the daily digest still printed "Scan: ok".
// lagBlocks is the number that separates "not there yet" from "nothing
// happened"; nothing exposed it before.
check("ledgerSyncState returns an inspectable array", () => {
  assert.ok(Array.isArray(ledgerSyncState()));
});
check("every sync row names its chain and carries cursor + staleness", () => {
  for (const r of ledgerSyncState()) {
    assert.ok(typeof r.chain === "string" && r.chain.length > 0, `chain: ${r.chain}`);
    assert.ok("nextBlock" in r && "caughtUp" in r && "staleSeconds" in r, "cursor fields present");
  }
});
check("sync rows expose only a wallet PREFIX, never a full address", () => {
  for (const r of ledgerSyncState()) {
    assert.ok(typeof r.wallet === "string" && r.wallet.length <= 10, `wallet: ${r.wallet}`);
  }
});

// --- a provider's range limit must narrow the scan, not kill the chain -----
//
// These three strings are REAL, measured provider output against the ledger's
// 9,000-block chunk. Only `sei` ever declared a chunkBlocks, so on every other
// chain the fallback RPCs were unusable: the moment the first lane has a bad
// day, rpcCall reaches a public RPC that rejects the range, the tick throws,
// and the chain stops reporting revenue entirely.
check("avalanche's range complaint narrows the chunk", () => {
  assert.ok(nextChunkSpan("requested too many blocks from 1 to 9000", 9000) < 9000);
});
check("celo's range complaint narrows the chunk", () => {
  assert.ok(nextChunkSpan("query exceeds range, retry smaller (max blocks 1000)", 9000) < 9000);
});
check("monad's stated limit is honoured exactly, not guessed at", () => {
  assert.equal(nextChunkSpan("eth_getLogs is limited to a 100 range", 9000), 100);
});
check("a NON-range failure propagates instead of being retried smaller", () => {
  // The Sei archive gate is an entitlement problem. Retrying it in a smaller
  // shape fails identically and would bury the real reason.
  assert.equal(nextChunkSpan("Archive requests require a personal token", 9000), null);
  assert.equal(nextChunkSpan("fetch failed", 9000), null);
});
check("narrowing has a floor, so it cannot spin toward zero", () => {
  assert.equal(nextChunkSpan("too many blocks", 100), null);
});

// --- an EVM row's DATE decides whether it is ever seen ---------------------
//
// EVM transfers carry no chain timestamp, so ledgerDaily dates them from block
// height. Every chain missing from BLOCK_MS fell back to 2000ms, and that set
// is exactly the set that vanished from /revenue. Measured 2026-08-01: monad
// runs at 302ms, sei 448ms, celo 1000ms, avalanche 1136ms. At the 2000ms
// default a 20-hour-old Monad settle was filed ~80 hours in the past, so it
// never appeared on the day it happened. Nothing errored; the rows were simply
// under the wrong date.
check("a row with a real timestamp is dated by it, never by a block estimate", () => {
  const when = Math.floor(Date.parse("2026-07-31T15:27:00Z") / 1000);
  recordTransfer({ chain: "celo", wallet: WALLET, txid: "celo-exact", tx_hash: "0xcelo",
    block: 73611043, when_ts: when, payer: "0x" + "b".repeat(40), usd: 0.001, asset: "USDC", external: 0 });
  const rows = ledgerDaily({ walletAddress: WALLET });
  assert.ok(rows.some((r) => r.chain === "celo" && r.day === "2026-07-31"),
    "celo row lands on the day it actually settled");
});
check("fast chains are no longer dated with the 2000ms default", () => {
  // The guard that would have caught this: any chain the ledger dates by
  // height must declare its real cadence.
  for (const chain of ["monad", "celo", "avalanche", "sei", "optimism"]) {
    assert.ok(LEDGER_BLOCK_MS[chain], `${chain} declares a block cadence`);
  }
  assert.ok(LEDGER_BLOCK_MS.monad < 700, `monad cadence is sub-second (got ${LEDGER_BLOCK_MS.monad})`);
  assert.ok(LEDGER_BLOCK_MS.sei < 700, `sei cadence is sub-second (got ${LEDGER_BLOCK_MS.sei})`);
});

// --- retention: did they ever come back? ------------------------------------
// The daily series says how many bought today and splits them new/returning
// FOR THAT DAY. This is the other question, and the one that decides whether
// any of the rest is a business: of everyone who ever paid, how many returned.
// Measured by hand 2026-09-11: 92 of 250 buyers paid exactly once, and no
// surface could show it.
//
// Asserted as DELTAS against whatever the earlier checks in this file already
// seeded - absolute totals here would silently encode the rest of the suite,
// and break the next time anyone adds a case above.
const base = ledgerBuyerRetention(wallets);

check("retention counts DAYS, not payments: an afternoon of calls is still one-time", () => {
  // A buyer with 40 calls on ONE day evaluated us once. Counting payments
  // would score that session as loyalty, which is the flattering error.
  for (let i = 0; i < 40; i++) give("2026-07-01", "0xbinge");
  give("2026-07-01", "0xonce");                                  // one call, one day
  give("2026-07-02", "0xloyal"); give("2026-07-09", "0xloyal");  // two distinct days
  const r = ledgerBuyerRetention(wallets);
  assert.equal(r.buyers - base.buyers, 3, `three new distinct buyers (got ${r.buyers - base.buyers})`);
  assert.equal(r.returned - base.returned, 1, "only the buyer seen on two DIFFERENT days counts as returned");
  assert.equal(r.oneDay - base.oneDay, 2, "the 40-call binge and the single call are both one-time");
  assert.equal(r.oneDayOneCall - base.oneDayOneCall, 1, "and oneDayOneCall separates the single test call from the afternoon that decided no");
  assert.equal(r.oneDay + r.returned, r.buyers, "every buyer is in exactly one class");
  assert.ok(Math.abs(r.returnedPct - (100 * r.returned) / r.buyers) < 0.11, "percentages are of buyers, rounded to a tenth");
});

check("retention is ALL-TIME, so a moving chart epoch cannot relabel a loyal buyer", () => {
  // 0xloyal's first day precedes this epoch. A windowed count would forget it
  // and call them one-time - the trap newBuyers was built to avoid.
  const wide = ledgerBuyerRetention(wallets);
  const prev = process.env.REVENUE_DAILY_START;
  process.env.REVENUE_DAILY_START = "2026-07-05";
  const r = ledgerBuyerRetention(wallets);
  assert.deepEqual(r, wide, "the epoch changes NOTHING about retention - it is all-time by construction");
  process.env.REVENUE_DAILY_START = prev;
});

check("retention never case-folds a base58 address", () => {
  // Two distinct Solana buyers differing only in case. Folding them would
  // invent a returning buyer out of two one-time ones - flattering, and wrong.
  const before = ledgerBuyerRetention(wallets);
  give("2026-07-03", "So11111111111111111111111111111111111111112", { chain: "solana" });
  give("2026-07-10", "so11111111111111111111111111111111111111112", { chain: "solana" });
  const r = ledgerBuyerRetention(wallets);
  assert.equal(r.buyers - before.buyers, 2, `both spellings count separately (got ${r.buyers - before.buyers})`);
  assert.equal(r.returned - before.returned, 0, "and neither became a returning buyer by being merged with the other");
});

check("retention excludes internal rows and reports an honest zero", () => {
  assert.deepEqual(
    ledgerBuyerRetention({ walletAddress: "0xnobody" }),
    { buyers: 0, oneDay: 0, oneDayOneCall: 0, returned: 0, oneDayPct: null, returnedPct: null },
    "a wallet with no external buyers reports zeros and NULL percentages, never 0% or 100%",
  );
  const before = ledgerBuyerRetention(wallets);
  give("2026-07-04", "0xinternal", { external: 0 });
  assert.equal(ledgerBuyerRetention(wallets).buyers, before.buyers, "an internal/canary payer is not a buyer");
});

rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\nFAILED (${failures})` : "\nall passed");
process.exit(failures ? 1 : 0);
