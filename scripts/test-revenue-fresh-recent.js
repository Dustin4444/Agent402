// /revenue showed new settlements only on the SECOND refresh: the per-rail
// recent-transfer rows were read inside the hourly revenue snapshot, which is
// served stale while it rebuilds in the background. withFreshRecent re-reads
// those rows from the ledger on every request; only the balances stay cached.
import { readFileSync } from "node:fs";
import { withFreshRecent, EVM } from "../src/revenue-live.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

const W = "0x" + "ab".repeat(20);
const base = EVM.base;
const oldRow = { usd: 0.001, from: "0x" + "11".repeat(20), txHash: "0x" + "aa".repeat(32), block: 100, external: true };
const newRow = { usd: 0.05, from: "0x" + "22".repeat(20), txHash: "0x" + "bb".repeat(32), block: 200, external: true };
const snap = Object.freeze({
  asOf: "2026-09-28T22:00:00Z",
  rails: Object.freeze([
    Object.freeze({ rail: base.label, wallet: W, balance: 5, recentSource: "ledger", recent: [oldRow], externalUsd: 0.001 }),
    Object.freeze({ rail: "Solana", wallet: "So1ana", recentSource: undefined, recent: [{ usd: 1 }] }),
    Object.freeze({ rail: EVM.polygon.label, wallet: W, recentSource: "chain-scan", recent: [oldRow] }),
  ]),
});
const calls = [];
const ledger = (chain, wallet, opts) => { calls.push([chain, wallet, opts?.limit]); return chain === (base.ledgerChain || "base") ? [newRow, oldRow] : []; };

const out = withFreshRecent(snap, ledger);
const b = out.rails[0];
ok(b.recent.length === 2 && b.recent[0].txHash === newRow.txHash, "a settlement the ledger recorded after the snapshot was built shows on the first read");
ok(b.recent[0].tx === base.tx(newRow.txHash), "each fresh row carries its explorer link");
ok(b.externalUsd === 0.051, `the rail's outside total is recomputed from the fresh rows (${b.externalUsd})`);
ok(b.balance === 5, "balances stay those of the cached snapshot");
ok(out.rails[1] === snap.rails[1] && out.rails[2] === snap.rails[2], "rails not read from the ledger (Solana, a chain-scan fallback) are passed through untouched");
ok(calls.length === 1 && calls[0][2] === 8, "one ledger read, for the ledger-backed rail only, limit 8 as in the snapshot");
ok(snap.rails[0].recent.length === 1, "the cached snapshot is not mutated");
ok(withFreshRecent(snap, () => []) === snap, "an empty ledger read keeps the snapshot's rows (a cold ledger never blanks the list)");
ok(withFreshRecent(snap, () => { throw new Error("db closed"); }).rails[0].recent[0].txHash === oldRow.txHash, "a failing ledger read keeps the snapshot's rows");
ok(withFreshRecent(null, ledger) === null && withFreshRecent(snap, null) === snap, "no snapshot or no reader passes through");

// Wiring: every surface that renders the recent rows re-reads them.
const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const route = (p) => src.slice(src.indexOf(`app.get("${p}", async`), src.indexOf(`app.get("${p}", async`) + 600);
ok(/withFreshRecent\(await revenueSnapshot\(revenueWallets\(\)\), ledgerRecent\)/.test(route("/revenue")), "/revenue re-reads the recent rows");
ok(/withFreshRecent\(await revenueSnapshot\(revenueWallets\(\)\), ledgerRecent\)/.test(route("/api/revenue")), "/api/revenue re-reads the recent rows");
ok(/revenueSnapshot\(revenueWallets\(\)\)\.then\(\(snap\) => withFreshRecent\(snap, ledgerRecent\)\)/.test(src), "the chain pages re-read their rail's recent rows");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
