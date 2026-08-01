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

const { recordTransfer, ledgerBuyersDaily, ledgerSyncState } = await import("../src/revenue-ledger.js");

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

rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\nFAILED (${failures})` : "\nall passed");
process.exit(failures ? 1 : 0);
