#!/usr/bin/env node
// Self-funded payments are not settlement evidence (2026-09-28).
//
// A payment into wallet W is the seller's own money coming home when W had sent
// its payer the USDC that pays it. The scan reads each paid wallet's OWN
// outbound transfers incrementally (a cursor per wallet, persisted pools per
// wallet and payer), works each pool through the payments first in first out,
// nets the per-wallet figures the router reads, and marks a wallet whose
// received DOLLARS were mostly self-funded as circular, whose Bazaar and
// chain-join figures (the same payments, counted by others) the router then
// disregards (src/seller-funding.js, src/leaderboard.js, src/evidence-binding.js,
// and the ranking tie-break in src/x402-index.js).
//
// Offline: fixture logs, a fake RPC that applies the provider's documented
// eth_getLogs rule (a range over 2,000 blocks is refused above 10,000 logs), one
// stub HTTP server playing the Bazaar and a Base RPC for the end-to-end scans,
// and a booted free server for the operator lever. Nothing is spent.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFreePort } from "./lib/free-port.js";

const dir = mkdtempSync(join(tmpdir(), "seller-funding-"));
process.env.LEADERBOARD_SNAPSHOT_FILE = join(dir, "leaderboard-snapshot.json");
process.env.LEADERBOARD_HISTORY_FILE = join(dir, "leaderboard-history.json");
process.env.LEADERBOARD_FUNDING_FILE = join(dir, "leaderboard-funding.json");
const LB = await import("../src/leaderboard.js");
const SF = await import("../src/seller-funding.js");
const { initWalletAccumulator, foldTransfers, finalizeLeaderboard, applySellerFunding, runLeaderboard } = LB;
const { readSellerFunding, readFundingGaps, processSellerFunding, createFundingState, serializeFundingState, parseFundingState, circularWalletsFrom, posOf, isScannableWallet, ZERO_ADDRESS } = SF;
const { buildEvidenceBinding, baseLiveGate } = await import("../src/evidence-binding.js");
const { dispatchEligibility, DISPATCH_REASONS, dispatchLegend } = await import("../src/dispatch-eligibility.js");
const { rankingPayersOf } = await import("../src/x402-index.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const FLOORS = { minSettled: 50, minPayers: 3 };
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const addr = (hex2) => "0x" + hex2.repeat(20);
const topic = (a) => "0x" + "0".repeat(24) + a.slice(2);
const hex = (n) => "0x" + n.toString(16);
const usd = (x) => Math.round(x * 1e6);
const log = (from, to, micro, block, idx = 0) => ({ address: USDC, topics: [TRANSFER, topic(from), topic(to)], data: "0x" + BigInt(micro).toString(16).padStart(64, "0"), blockNumber: hex(block), logIndex: hex(idx) });
const P = (i) => "0x" + "a0".repeat(18) + i.toString(16).padStart(4, "0"); // payer i
const seller = (wallet, host) => ({ wallet, name: host, network: "base", origins: [`https://${host}`], homepage: `https://${host}`, endpoints: 1, prices: new Set() });
const NOW = Date.parse("2026-09-28T00:00:00Z");

// eth_getLogs with the real filter semantics, and the provider's documented
// size rule: a range wider than 2,000 blocks is refused above 10,000 logs.
const inTopicSet = (set, t) => set === null || set === undefined || (Array.isArray(set) ? set.some((x) => x.toLowerCase() === t.toLowerCase()) : set.toLowerCase() === t.toLowerCase());
const filterLogs = (list, p) => {
  const lo = parseInt(p.fromBlock, 16), hi = parseInt(p.toBlock, 16);
  const froms = Array.isArray(p.topics?.[1]) ? new Set(p.topics[1].map((x) => x.toLowerCase())) : null;
  const tos = Array.isArray(p.topics?.[2]) ? new Set(p.topics[2].map((x) => x.toLowerCase())) : null;
  return list.filter((l) => {
    const b = parseInt(l.blockNumber, 16);
    return b >= lo && b <= hi && (!p.address || p.address.toLowerCase() === l.address) && inTopicSet(p.topics?.[0], l.topics[0])
      && (!froms || froms.has(l.topics[1].toLowerCase())) && (!tos || tos.has(l.topics[2].toLowerCase()));
  });
};
const SIZE_REFUSAL = "Log response size exceeded. You can make eth_getLogs requests with up to a 2K block range and no limit on the response size, or you can request any block range with a cap of 10K logs in the response.";
const fakeRpc = (list, { calls = [], transport = 0, refuse = null, rangeLimit = Infinity } = {}) => {
  let transportLeft = transport;
  return async (method, params) => {
    const p = params[0];
    const span = parseInt(p.toBlock, 16) - parseInt(p.fromBlock, 16) + 1;
    calls.push({ ...p, span });
    if (transportLeft > 0) { transportLeft--; throw new Error("All RPCs failed for eth_getLogs: fetch failed"); }
    if (refuse && refuse(p, span)) throw new Error("All RPCs failed for eth_getLogs: base.example: {\"code\":-32000,\"message\":\"temporarily unable to serve\"}");
    if (span > rangeLimit) throw new Error(`block range too large (${span})`);
    const logs = filterLogs(list, p);
    if (span > 2000 && logs.length > 10_000) throw new Error(SIZE_REFUSAL);
    return logs;
  };
};

// One scan's funding step, exactly as runLeaderboard composes it (pinned from
// source in section 11): fold, read the paid wallets' outbound (floor-clearing
// wallets first), read the gap before the window once, work the pools, apply,
// finalize. The fake chain holds the outbound logs AND every payment as a log,
// so a gap read (payers to a wallet, before the window) sees what it would.
function paidInOrder(acc, floor = FLOORS) {
  const clears = (w) => ((w.callsSettled || 0) >= floor.minSettled && w.perPayer.size >= floor.minPayers ? 1 : 0);
  return [...acc.values()].filter((w) => w.perPayer.size).sort((a, b) => clears(b) - clears(a) || b.callsSettled - a.callsSettled)
    .map((w) => ({ wallet: w.wallet, payers: new Set([...w.perPayer.keys()].map((p) => p.toLowerCase())) }));
}
const payLog = (t) => log(t.payer, t.wallet, Math.round(t.usd * 1e6), Math.floor(t.pos / 1e6), t.pos % 1e6);
async function scanOnce({ sellers, pays, outs, state, latest, span, lookback = 1_000_000, rpcOpts = {}, readOpts = {}, now = NOW, previous = null, gaps = true, chainHidesPaysBefore = 0 }) {
  const start = latest - span;
  const acc = initWalletAccumulator(sellers.map((s) => ({ ...s, origins: [...s.origins] })));
  foldTransfers(acc, pays.filter((t) => Math.floor(t.pos / 1e6) >= start && Math.floor(t.pos / 1e6) <= latest));
  const calls = [];
  const chain = [...outs, ...pays.filter((t) => t.payer !== t.wallet && Math.floor(t.pos / 1e6) >= chainHidesPaysBefore).map(payLog)];
  const rpc = fakeRpc(chain, { ...rpcOpts, calls });
  const paid = paidInOrder(acc);
  const stats = await readSellerFunding({ rpc, token: USDC, state, wallets: paid, latest, freshFrom: Math.max(0, start - lookback), now, ...readOpts });
  const gapRead = gaps ? await readFundingGaps({ rpc, token: USDC, state, wallets: paid.map((w) => w.wallet), windowStartBlock: start, maxCalls: Math.max(0, (readOpts.maxCalls ?? 400) - stats.calls) }) : { gaps: new Map(), stats: {} };
  stats.gap = gapRead.stats;
  processSellerFunding(state, acc, { windowStartBlock: start, gaps: gapRead.gaps, classify: (w, micro) => (micro <= 750_000 ? 1 : 2) });
  applySellerFunding(acc, state, { latest, now, previous });
  const ranked = finalizeLeaderboard(acc);
  return { acc, ranked, ev: ranked.walletEvidence, stats, calls };
}

// --- 1. What is never a wallet ----------------------------------------------------
ok(!isScannableWallet(ZERO_ADDRESS, USDC) && !isScannableWallet(USDC, USDC) && !isScannableWallet(USDC.toUpperCase().replace("0X", "0x"), USDC) && isScannableWallet(addr("11"), USDC),
  "the zero address and the token contract are never a scanned payTo or a funding source");

// --- 2. First in, first out, by amount ----------------------------------------------
const LOOP = addr("11"), ECHO = addr("12"), HONEST = addr("22"), MIXED = addr("33"), PART = addr("34"), SIB_A = addr("44"), SIB_B = addr("45");
const SELLERS = [seller(LOOP, "seller-a.example"), seller(ECHO, "seller-e.example"), seller(HONEST, "seller-b.example"), seller(MIXED, "seller-c.example"), seller(PART, "seller-p.example"), seller(SIB_A, "seller-d.example"), seller(SIB_B, "seller-d.example")];
const pays = [], outs = [];
const pay = (wallet, payer, micro, block, idx = 1) => pays.push({ wallet, payer, usd: micro / 1e6, pos: posOf(block, idx) });
// seller-a funds P1..P5 $0.13 each at block 100; each pays 12 x $0.01; two organic payers once each.
for (let i = 1; i <= 5; i++) { outs.push(log(LOOP, P(i), usd(0.13), 100, i)); for (let k = 0; k < 12; k++) pay(LOOP, P(i), usd(0.01), 200 + k, i); }
pay(LOOP, P(90), usd(0.01), 300); pay(LOOP, P(91), usd(0.01), 301);
// seller-a also funds P(40), which then buys from seller-b: another seller's money, not seller-b's.
outs.push(log(LOOP, P(40), usd(1), 150));
// seller-e returns every payment the moment it lands (the loop an "amount equals the payment it follows, so it is a refund" rule would admit).
outs.push(log(ECHO, P(70), usd(0.05), 100));
for (let k = 0; k < 20; k++) { pay(ECHO, P(70), usd(0.05), 200 + 2 * k, 1); outs.push(log(ECHO, P(70), usd(0.05), 201 + 2 * k, 2)); }
pay(ECHO, P(71), usd(0.05), 400);
// seller-b: ten payers x 10 payments of $0.01. It REFUNDS P(20) $0.01 after all
// of P(20)'s payments, and P(21) $0.01 mid-way (P(21) keeps paying after it).
for (let i = 20; i < 30; i++) for (let k = 0; k < 10; k++) pay(HONEST, P(i), usd(0.01), (i === 21 ? 200 : 400) + k * (i === 21 ? 20 : 1), i);
outs.push(log(HONEST, P(20), usd(0.01), 900));
outs.push(log(HONEST, P(21), usd(0.01), 290));
for (let k = 0; k < 6; k++) pay(HONEST, P(40), usd(0.01), 500 + k, 40);
// ZERO-VALUE "funding" logs from seller-b's wallet to its buyers before they pay: anyone can emit one.
for (let i = 22; i < 30; i++) outs.push(log(HONEST, P(i), 0, 50, i));
// seller-c: one whale it funded $0.80 makes 80 payments of $0.01; 16 organic payers make 4 each.
outs.push(log(MIXED, P(60), usd(0.8), 50));
for (let k = 0; k < 80; k++) pay(MIXED, P(60), usd(0.01), 100 + k, 60);
for (let i = 100; i < 116; i++) for (let k = 0; k < 4; k++) pay(MIXED, P(i), usd(0.01), 300 + k, i);
// seller-p funds each payment 80% ($0.04 of $0.05) ten times, and one payer 40% ($0.02 of $0.05) once.
for (let k = 0; k < 10; k++) { outs.push(log(PART, P(80), usd(0.04), 100 + 2 * k)); pay(PART, P(80), usd(0.05), 101 + 2 * k); }
outs.push(log(PART, P(81), usd(0.02), 300)); pay(PART, P(81), usd(0.05), 301);
// seller-d: two wallets listed under one host. SIB_B funds P(50); P(50) pays SIB_A.
outs.push(log(SIB_B, P(50), usd(1), 100));
for (let k = 0; k < 5; k++) pay(SIB_A, P(50), usd(0.01), 200 + k, 50);
for (let i = 51; i < 54; i++) pay(SIB_A, P(i), usd(0.01), 300, i);
// seller-a pays itself once: never a buyer. And a mint (from the zero address) to a seller-b buyer.
pays.push({ wallet: LOOP, payer: LOOP, usd: 0.01, pos: posOf(310, 1) });
outs.push(log(ZERO_ADDRESS, P(25), usd(5), 60));

const state1 = createFundingState(USDC);
const s1 = await scanOnce({ sellers: SELLERS, pays, outs, state: state1, latest: 1000, span: 1000 });
const ev = s1.ev;
ok(s1.stats.calls === 1 && s1.calls[0].topics[2] === null && s1.stats.caughtUp === 6 && !state1.wallets.has(SIB_B), "one wide untargeted read covers every paid wallet when the RPC accepts it (a wallet with no payment this window is not read)");
ok(!s1.calls[0].topics[1].includes(topic(ZERO_ADDRESS)) && ![...state1.wallets.keys()].includes(ZERO_ADDRESS), "the zero address is never read as a source (a mint is not a seller's money)");
ok(ev[LOOP].grossCallsSettled === 62 && ev[LOOP].selfFundedCalls === 60 && ev[LOOP].callsSettled === 2 && ev[LOOP].uniqueBuyers === 2 && ev[LOOP].circular === true,
  "FUNDED FLEET: 60 of 62 payments were paid with the seller's own $0.13 per wallet -> net 2 calls / 2 payers, circular");
ok(ev[ECHO].selfFundedCalls === 20 && ev[ECHO].callsSettled === 1 && ev[ECHO].circular === true, "ECHO LOOP: a seller that returns each payment as it lands is netted every time (the return funds the next payment)");
ok(s1.ranked.find((r) => r.wallets.includes(LOOP)).callsSettled === 62, "the public row stays gross (router input only; the self-transfer is skipped as a buyer)");
ok(ev[HONEST].grossCallsSettled === 106 && ev[HONEST].selfFundedCalls === 1 && ev[HONEST].callsSettled === 105 && ev[HONEST].uniqueBuyers === 11 && ev[HONEST].circular === false,
  "HONEST SELLER WITH REFUNDS: a $0.01 refund covers ONE later $0.01 payment, not every later payment (106 gross, 105 net, 11 payers, not circular)");
{
  const pair20 = state1.wallets.get(HONEST).pairs.get(P(20));
  ok(pair20 && pair20.pool === usd(0.01) && pair20.recs.length === 0, "a refund AFTER a payer's payments never makes those payments self-funded (P20: pool 0.01 unspent, nothing netted)");
  ok(!state1.wallets.get(HONEST).pairs.has(P(22)), "a ZERO-VALUE transfer log is never funding (anyone can emit one from any wallet)");
  ok(!state1.wallets.get(HONEST).pairs.has(P(40)) && ev[HONEST].uniqueBuyers === 11, "a payer funded by ANOTHER seller's wallet still counts for this seller");
}
ok(ev[MIXED].grossCallsSettled === 144 && ev[MIXED].selfFundedUsd === 0.8 && ev[MIXED].callsSettled === 64 && ev[MIXED].uniqueBuyers === 16 && ev[MIXED].circular === true,
  "MIXED SELLER: $0.80 of $1.44 self-funded -> circular by dollars, judged on its genuine part: 64 calls / 16 payers");
ok(ev[PART].selfFundedCalls === 10 && ev[PART].callsSettled === 1 && ev[PART].selfFundedUsd === 0.42 && ev[PART].circular === true,
  "PARTLY FUNDED: a payment 80% paid with the seller's money is netted as a call; one 40% funded stays a call, its $0.02 still counts as self-funded dollars");
ok(ev[SIB_A].callsSettled === 8 && ev[SIB_A].selfFundedCalls === 0 && ev[SIB_A].circular === false,
  "ANOTHER WALLET UNDER THE SAME HOST funding a payer does not net it: only the paid wallet's own outbound counts (host grouping comes from listings anyone can write)");
{
  // What the review measured against the branch's first cut: a third party whose
  // listing lands in an honest seller's host group sends dust to its buyers.
  const W = addr("61"), V = addr("62");
  const buyers = Array.from({ length: 6 }, (_, i) => P(200 + i));
  const sp = [], so = [];
  for (let r = 0; r < 20; r++) for (const [i, b] of buyers.entries()) sp.push({ wallet: W, payer: b, usd: 0.01, pos: posOf(1000 + r * 10 + i, 0) });
  for (const [i, b] of buyers.entries()) so.push(log(V, b, 1, 999, i)); // one base unit each, before every payment
  sp.push({ wallet: V, payer: P(250), usd: 0.01, pos: posOf(1500, 0) }); // V is itself a (paid) wallet under the same host
  const st = createFundingState(USDC);
  const r = await scanOnce({ sellers: [seller(W, "seller-a.example"), seller(V, "seller-a.example")], pays: sp, outs: so, state: st, latest: 2000, span: 2000 });
  ok(r.ev[W].callsSettled === 120 && r.ev[W].uniqueBuyers === 6 && r.ev[W].circular === false, "SIBLING DUST: a wallet sharing the seller's host that sends 1 base unit to each of its buyers changes nothing (120 / 6, not circular)");
}

// --- 3. The funding read: incremental, bounded, lineage-local ---------------------
{
  // Same fixtures, a second scan an hour later: every read starts at the cursor.
  const more = [...pays];
  for (let i = 1; i <= 5; i++) more.push({ wallet: LOOP, payer: P(i), usd: 0.01, pos: posOf(1100 + i, 1) }); // pool 0.01 left each: covered
  const s2 = await scanOnce({ sellers: SELLERS, pays: more, outs, state: state1, latest: 1400, span: 1300 });
  ok(s2.calls.length === 1 && s2.calls.every((c) => parseInt(c.fromBlock, 16) === 1001 && parseInt(c.toBlock, 16) === 1400), `a later scan reads only the blocks since the cursor (${s2.calls.map((c) => `${parseInt(c.fromBlock, 16)}-${parseInt(c.toBlock, 16)}`).join(",")})`);
  ok(s2.ev[LOOP].selfFundedCalls === 65 && s2.ev[LOOP].grossCallsSettled === 67, "payments worked through in the first scan keep their verdict in the second (60 remembered + 5 new, from the persisted pools)");
  // Round trip through the volume's format: the same state, the same answer.
  const re = parseFundingState(serializeFundingState(state1), USDC);
  ok(re.wallets.get(LOOP).cursor === 1400 && re.wallets.get(LOOP).pairs.get(P(1)).recs.length === state1.wallets.get(LOOP).pairs.get(P(1)).recs.length && re.wallets.get(HONEST).pairs.get(P(20)).pool === usd(0.01),
    "the state round-trips through its persisted form (cursors, pools, remembered payments)");
  ok(parseFundingState(serializeFundingState(state1), "0x" + "9".repeat(40)).wallets.size === 0 && parseFundingState("{not json", USDC).wallets.size === 0, "a state for another token, or an unreadable file, starts empty (read again from the lookback)");
}
{
  // WAITING IT OUT buys nothing: a buyer funded once, weeks before it pays, is
  // netted until it has spent the money, and not a payment after.
  const W = addr("71"), R = P(300), O = P(301);
  const st = createFundingState(USDC);
  const outsW = [log(W, R, usd(1), 100)];
  const paysW = [{ wallet: W, payer: O, usd: 0.01, pos: posOf(900, 0) }];
  await scanOnce({ sellers: [seller(W, "seller-w.example")], pays: paysW, outs: outsW, state: st, latest: 1000, span: 500, lookback: 1000 });
  ok(st.wallets.get(W).pairs.get(R)?.pool === usd(1), "scan 1: the $1 sent to a wallet that has not paid yet is remembered");
  for (let k = 0; k < 30; k++) paysW.push({ wallet: W, payer: R, usd: 0.01, pos: posOf(40_000 + k, 0) });
  for (let i = 0; i < 20; i++) paysW.push({ wallet: W, payer: P(310 + i), usd: 0.01, pos: posOf(40_100 + i, 0) });
  const w3 = await scanOnce({ sellers: [seller(W, "seller-w.example")], pays: paysW, outs: outsW, state: st, latest: 40_500, span: 1000, lookback: 1000 });
  ok(w3.ev[W].selfFundedCalls === 30 && w3.ev[W].callsSettled === 20, "scan 3, ~40,000 blocks later (far past any lookback): all 30 of its payments are still the seller's money");
  for (let k = 0; k < 80; k++) paysW.push({ wallet: W, payer: R, usd: 0.01, pos: posOf(41_600 + k, 0) });
  const w4 = await scanOnce({ sellers: [seller(W, "seller-w.example")], pays: paysW, outs: outsW, state: st, latest: 42_000, span: 1000, lookback: 1000 });
  ok(w4.ev[W].selfFundedCalls === 70 && w4.ev[W].callsSettled === 10 && st.wallets.get(W).pairs.get(R)?.pool === 0, "scan 4: the remaining $0.70 covers 70 more and the last 10 are its own money: a spent pool nets nothing more (no over-count forever)");
  await scanOnce({ sellers: [seller(W, "seller-w.example")], pays: paysW, outs: outsW, state: st, latest: 44_000, span: 1000, lookback: 1000 });
  ok(!st.wallets.get(W).pairs.has(R), "...and once its netted payments leave the window, the spent pool is forgotten");
}
{
  // THE BUDGET, on the shape the review measured: one wallet sending over
  // 10,000 transfers inside a chunk of 250 paid wallets with 1,250 payers, over
  // a 14-day first read. Every other wallet is read in full, the heavy one is
  // isolated and read by splitting only its own range.
  const HEAVY = addr("81");
  const lights = Array.from({ length: 249 }, (_, i) => "0x" + (0x1000 + i).toString(16).padStart(40, "0"));
  const sellersB = [seller(HEAVY, "seller-h.example"), ...lights.map((w, i) => seller(w, `light-${i}.example`))];
  const paysB = [], outsB = [];
  const LATEST = 604_800;
  for (let k = 0; k < 51; k++) outsB.push(log(HEAVY, P(1000 + k), usd(2), 1000 + k));
  for (let k = 0; k < 12_000; k++) outsB.push(log(HEAVY, P(1000 + (k % 51)), usd(0.05), 10_000 + k * 49, 1));
  for (let k = 0; k < 51 * 20; k++) paysB.push({ wallet: HEAVY, payer: P(1000 + (k % 51)), usd: 0.05, pos: posOf(LATEST - 300_000 + k * 20, 2) });
  lights.forEach((w, i) => {
    for (let j = 0; j < 5; j++) paysB.push({ wallet: w, payer: P(2000 + i * 5 + j), usd: 0.01, pos: posOf(LATEST - 1000 + j, 3) });
    outsB.push(log(w, P(9000 + i), usd(0.5), 5000 + i, 4));
  });
  const st = createFundingState(USDC);
  const b1 = await scanOnce({ sellers: sellersB, pays: paysB, outs: outsB, state: st, latest: LATEST, span: 302_400, lookback: 302_400 });
  const full = LATEST - 0 + 1;
  const outbound = b1.calls.filter((c) => c.topics[2] === null);
  const lightCalls = outbound.filter((c) => !c.topics[1].includes(topic(HEAVY)));
  const total = b1.stats.calls + b1.stats.gap.calls;
  ok(b1.stats.caughtUp === 250 && b1.stats.behind === 0 && b1.stats.gap.read === 250 && total <= 25, `ALL 250 wallets read in full, and the gap before the window read for each, within ${total} call(s) of the 400 budget (the heavy source isolated, not the budget spent)`);
  ok(lightCalls.length > 0 && lightCalls.every((c) => c.span === full), "no other wallet's read was narrowed by the heavy wallet's refusals (every call without it spans the whole range)");
  ok(b1.ev[HEAVY].circular === true && b1.ev[HEAVY].selfFundedCalls === 1020 && b1.ev[HEAVY].callsSettled === 0, "and the heavy source is netted: its 1,020 payments were all paid with its own money");
  // A tiny budget reads the wallets that clear the floor on gross first.
  const st2 = createFundingState(USDC);
  const tiny = await scanOnce({ sellers: [...lights.map((w, i) => seller(w, `light-${i}.example`)), seller(HEAVY, "seller-h.example")], pays: paysB.filter((t) => t.wallet !== HEAVY || true), outs: outsB.filter((l) => l.topics[1] !== topic(HEAVY)), state: st2, latest: LATEST, span: 302_400, lookback: 302_400, readOpts: { maxCalls: 1, walletChunk: 10 } });
  ok(tiny.stats.budgetExhausted === true && tiny.stats.caughtUp === 10 && st2.wallets.get(HEAVY).cursor === LATEST, "with a budget of one call, the one read goes to the wallets that clear the floor on gross first (the busiest one included), the rest are behind, and the read says so");
}
{
  // A transient refusal splits only its own job; a transport failure stops the read.
  const W1 = addr("91"), W2 = addr("92");
  const sp = [{ wallet: W1, payer: P(400), usd: 0.01, pos: posOf(900, 0) }, { wallet: W2, payer: P(401), usd: 0.01, pos: posOf(900, 1) }];
  const so = [log(W1, P(400), usd(0.01), 100), log(W2, P(401), usd(0.01), 100)];
  let first = true;
  const st = createFundingState(USDC);
  const r = await scanOnce({ sellers: [seller(W1, "seller-x.example"), seller(W2, "seller-y.example")], pays: sp, outs: so, state: st, latest: 1000, span: 500, rpcOpts: { refuse: (p) => { const hit = first && p.topics[1].includes(topic(W1)); first = false; return hit; } }, readOpts: { walletChunk: 1, minRangeBlocks: 100 } });
  const w2calls = r.calls.filter((c) => c.topics[1].includes(topic(W2)));
  ok(r.stats.caughtUp === 2 && w2calls.length === 1 && w2calls[0].span === 1001, "a refusal of one job narrows that job's range only: the next job still reads its whole range in one call");
  const st2 = createFundingState(USDC);
  const t = await scanOnce({ sellers: [seller(W1, "seller-x.example"), seller(W2, "seller-y.example")], pays: sp, outs: so, state: st2, latest: 1000, span: 500, rpcOpts: { transport: 5 }, readOpts: { walletChunk: 1 } });
  ok(t.stats.calls === 2 && t.stats.behind === 2 && /fetch failed/.test(t.stats.transportError || ""), "an unreachable RPC is retried once and then the read stops (no fan-out), every wallet left behind at its cursor");
  // A read that times out may just be too large: it is split, a few times per
  // scan; an RPC that times out on everything stops the read instead.
  const st4 = createFundingState(USDC);
  let slow = true;
  const timeoutRpc = async (m, params) => { const p = params[0]; const span = parseInt(p.toBlock, 16) - parseInt(p.fromBlock, 16) + 1; if (slow && span > 600) throw new Error("All RPCs failed for eth_getLogs: The operation was aborted due to timeout"); return filterLogs([...so, ...sp.map(payLog)], p); };
  const ts = await readSellerFunding({ rpc: timeoutRpc, token: USDC, state: st4, wallets: [{ wallet: W1, payers: new Set([P(400)]) }], latest: 1000, freshFrom: 100, minRangeBlocks: 100 });
  ok(ts.caughtUp === 1 && ts.refusals === 1 && !ts.transportError, "one slow wide read is split rather than abandoned (caught up after a single timeout)");
  const st5 = createFundingState(USDC);
  const ts2 = await readSellerFunding({ rpc: async () => { throw new Error("The operation was aborted due to timeout"); }, token: USDC, state: st5, wallets: [{ wallet: W1, payers: new Set([P(400)]) }, { wallet: W2, payers: new Set([P(401)]) }], latest: 1000, freshFrom: 100, minRangeBlocks: 100 });
  ok(ts2.calls === 4 && ts2.behind === 2 && /timeout/.test(ts2.transportError || ""), `an RPC that times out on everything stops after a few (${ts2.calls} calls), not after the budget`);
  // The pool caps cannot be filled cheaply. Zero-value logs are never
  // recorded; dust pools make way; a recipient that pays the wallet is always
  // recorded.
  const W3 = addr("93");
  const spray = [];
  for (let i = 0; i < 30; i++) spray.push(log(W3, P(3000 + i), 0, 100, i), log(W3, P(3100 + i), 1, 101, i));
  spray.push(log(W3, P(3200), usd(2), 150, 0), log(W3, P(3201), usd(2), 151, 0));
  const st6 = createFundingState(USDC);
  await readSellerFunding({ rpc: fakeRpc(spray), token: USDC, state: st6, wallets: [{ wallet: W3, payers: new Set([P(3201)]) }], latest: 1000, freshFrom: 50, maxPairsPerWallet: 10 });
  const pairs6 = st6.wallets.get(W3).pairs;
  const zeroKept = Array.from({ length: 30 }, (_, i) => P(3000 + i)).some((p) => pairs6.has(p));
  ok(!zeroKept && !st6.wallets.get(W3).truncated && pairs6.has(P(3200)) && pairs6.has(P(3201)), `SPRAY: 30 zero-value and 30 one-unit transfers do not fill a 10-pool cap; the real $2 fundings are recorded (${pairs6.size} pools, truncated ${st6.wallets.get(W3).truncated})`);
  const st7 = createFundingState(USDC);
  const big = [];
  for (let i = 0; i < 15; i++) big.push(log(W3, P(3300 + i), usd(0.5), 100, i));
  big.push(log(W3, P(3400), usd(2), 150, 0));
  await readSellerFunding({ rpc: fakeRpc(big), token: USDC, state: st7, wallets: [{ wallet: W3, payers: new Set([P(3400)]) }], latest: 1000, freshFrom: 50, maxPairsPerWallet: 10 });
  ok(st7.wallets.get(W3).truncated === true && st7.wallets.get(W3).pairs.has(P(3400)), "past the cap with real pools, the wallet is flagged truncated, and a recipient that pays it is still recorded");
  // A single wallet refused even over the narrowest range is read targeted at its own payers.
  const st3 = createFundingState(USDC);
  const g = await scanOnce({ sellers: [seller(W1, "seller-x.example")], pays: sp.slice(0, 1), outs: so, state: st3, latest: 1000, span: 500, rpcOpts: { refuse: (p) => p.topics[2] === null } , readOpts: { minRangeBlocks: 2000 } });
  ok(g.stats.caughtUp === 1 && st3.wallets.get(W1).truncated === true && g.ev[W1].selfFundedCalls === 1 && g.calls.some((c) => Array.isArray(c.topics[2])), "a wallet no untargeted read can serve is read targeted at its own payers and flagged truncated");
}

{
  // COLD START: a new wallet's first read looks back before the window, but the
  // window's inbound read never saw what its payers paid it back then. A payer
  // in a steady two-way flow (pays $1, gets $0.99 back, pays $0.0042) must not
  // be left with an inflated pool: the gap read finds its earlier $1s, which a
  // later transfer from the seller gives back first (credit).
  const W = addr("c1"), B2 = P(800);
  const so = [], sp = [];
  for (let d = 0; d < 12; d++) {
    const b0 = 1000 + d * 500;
    sp.push({ wallet: W, payer: B2, usd: 1, pos: posOf(b0, 1) }, { wallet: W, payer: B2, usd: 1, pos: posOf(b0 + 10, 1) });
    so.push(log(W, B2, usd(0.9946), b0 + 100, 1), log(W, B2, usd(0.9946), b0 + 120, 1));
    sp.push({ wallet: W, payer: B2, usd: 0.0042, pos: posOf(b0 + 110, 2) }, { wallet: W, payer: B2, usd: 0.0042, pos: posOf(b0 + 130, 2) });
  }
  for (let i = 0; i < 3; i++) for (let k = 0; k < 20; k++) sp.push({ wallet: W, payer: P(810 + i), usd: 0.01, pos: posOf(4200 + i * 30 + k, 3) });
  const withGap = await scanOnce({ sellers: [seller(W, "seller-t.example")], pays: sp, outs: so, state: createFundingState(USDC), latest: 7000, span: 3000, lookback: 4000 });
  const noGap = await scanOnce({ sellers: [seller(W, "seller-t.example")], pays: sp, outs: so, state: createFundingState(USDC), latest: 7000, span: 3000, lookback: 4000, gaps: false });
  ok(withGap.stats.gap.read === 1 && withGap.ev[W].selfFundedCalls === 0 && withGap.ev[W].callsSettled === 72 && withGap.ev[W].uniqueBuyers === 4, "cold start WITH the gap read: the two-way payer's small payments are its own money (its earlier $1s come back first): 72 / 4, nothing netted");
  ok(noGap.ev[W].fundingRead === false && noGap.ev[W].callsSettled === 72, "without the gap read the wallet is left behind (its pools are not advanced on half the story), not netted");
  const blind = await scanOnce({ sellers: [seller(W, "seller-t.example")], pays: sp, outs: so, state: createFundingState(USDC), latest: 7000, span: 3000, lookback: 4000, chainHidesPaysBefore: 4000 });
  ok(blind.ev[W].selfFundedCalls === 12 && blind.ev[W].uniqueBuyers === 3, "control: had the pools been worked blind to the payer's earlier $1s, every one of its small payments would read as the seller's money (12 netted, a buyer lost)");
}

// --- 4. Behind: known facts net it, and a circular wallet behind credits nothing ----
{
  const behind = await scanOnce({ sellers: SELLERS, pays, outs, state: parseFundingState(serializeFundingState(state1), USDC), latest: 1600, span: 1500, readOpts: { maxCalls: 0 } });
  ok(behind.stats.behind === 6 && behind.stats.calls === 0 && behind.ev[LOOP].fundingRead === false, "no budget: every paid wallet is behind this scan");
  ok(behind.ev[LOOP].callsSettled === 0 && behind.ev[LOOP].uniqueBuyers === 0 && behind.ev[LOOP].fundingPending === true, "a CIRCULAR wallet whose reads are behind is credited nothing until they catch up (its gross 62 is never credited)");
  ok(behind.ev[HONEST].callsSettled === 105 && behind.ev[HONEST].fundingPending === undefined, "a wallet that is not circular keeps what is known netted and counts the rest (absence of evidence never refuses)");
}

// --- 5. The verdict: carried 30 days, and the operator's clearance ------------------
{
  const at = ev[LOOP].lastCircularAt;
  ok(at === new Date(NOW).toISOString(), "a circular wallet carries the scan time as its verdict");
  ok(circularWalletsFrom({ [LOOP]: { lastCircularAt: at } }, { now: NOW + 10 * 86_400_000 }).has(LOOP) && !circularWalletsFrom({ [LOOP]: { lastCircularAt: at } }, { now: NOW + 31 * 86_400_000 }).has(LOOP), "the verdict holds inside the 30-day window, and not after it");
  ok(!circularWalletsFrom(ev, { now: NOW, cleared: new Set([LOOP]) }).has(LOOP) && circularWalletsFrom(ev, { now: NOW, cleared: new Set([LOOP]) }).has(MIXED), "a wallet the operator cleared is never circular; the others are untouched");
}

// --- 6. The gate: netted figures, the circular wallet's Bazaar ignored --------------
const circular = circularWalletsFrom(ev, { now: NOW });
ok(circular.has(LOOP) && circular.has(MIXED) && !circular.has(HONEST) && !circular.has(SIB_A), "circular set: the funded fleet and the mixed seller, never the honest seller or the host sibling");
const bazaar = [
  ["https://seller-a.example", { calls30d: 500, payers30d: 40, payTos: [LOOP] }],
  ["https://seller-c.example", { calls30d: 900, payers30d: 50, payTos: [MIXED] }],
];
const chainProven = new Map([["https://seller-a.example", { settled: 800, payers: 9, payTo: LOOP }]]);
const b = buildEvidenceBinding({ leaderboardRows: s1.ranked, walletEvidence: ev, bazaarQuality: bazaar, chainProven, circularWallets: circular, ...FLOORS });
const control = buildEvidenceBinding({ leaderboardRows: s1.ranked, walletEvidence: ev, bazaarQuality: bazaar, chainProven, ...FLOORS });
const label = (bind, origin, live) => dispatchEligibility({ routable: true, networks: ["eip155:8453"], settled: bind.get(origin)?.settled || 0, payers: bind.get(origin)?.payers, spendChains: ["base"], ...FLOORS, evidence: bind.get(origin), livePayTo: live });
ok(label(control, "https://seller-a.example", LOOP).eligible === true, "control: without the circular set, the Bazaar's count of the same self-payments re-admits seller-a");
const la = label(b, "https://seller-a.example", LOOP);
ok(la.eligible === false && la.reason === "settlement_self_funded", "FUNDED FLEET DEMOTED: reads settlement_self_funded");
ok(b.get("https://seller-a.example").byWallet.get(LOOP).settled === 2 && b.get("https://seller-a.example").selfFunded.byWallet.get(LOOP).settled === 800 && b.get("https://seller-a.example").ownSettled === 0, "its Bazaar and chain-join figures are disregarded (kept as selfFunded, never credited, not its own evidence)");
ok(baseLiveGate({ networks: ["eip155:8453"], settled: 800, payers: 40, priceUsd: 0.01, ...FLOORS, binding: b.get("https://seller-a.example"), livePayTo: LOOP }).ok === false, "handed the old figures (800 / 40) the gate still refuses: no wallet clears on genuine evidence");
ok(label(b, "https://seller-b.example", HONEST).eligible === true, "HONEST SELLER WITH REFUNDS KEPT: seller-b stays eligible at its wallet");
const lc = label(b, "https://seller-c.example", MIXED);
ok(lc.eligible === true && b.get("https://seller-c.example").byWallet.get(MIXED).settled === 64 && b.get("https://seller-c.example").selfFunded.byWallet.get(MIXED).settled === 900, "MIXED SELLER: eligible on its genuine 64 / 16, its Bazaar figures (900) disregarded");
{
  const legend = dispatchLegend()["routerDispatchReason.settlement_self_funded"];
  const words = DISPATCH_REASONS.settlement_self_funded + legend;
  ok(typeof DISPATCH_REASONS.settlement_self_funded === "string" && dispatchLegend().routerDispatchReason.settlement_self_funded === DISPATCH_REASONS.settlement_self_funded, "the public reason is published in the legend");
  ok(!/\b[a-z0-9-]+\.(example|com|io|xyz|ai|tools)\b/i.test(words) && !/0x[0-9a-f]{6}/i.test(words), "...and names no one");
  ok(!/same seller|same host|sibling/i.test(words) && /first in first out/i.test(legend) && /its own amount/i.test(legend) && /dollars/i.test(legend), "...and says what is measured: the wallet's own outbound, first in first out, a refund only up to its own amount, judged by dollars");
}

// --- 6b. The seller dossier says so, counts only --------------------------------------
{
  const { composeSellerDossier } = await import("../src/tools/seller-dossier.js");
  const DETAIL = { origin: "https://seller-a.example", host: "seller-a.example", routable: true, networks: ["eip155:8453"], payToByNetwork: { "eip155:8453": LOOP }, payTosByNetwork: { "eip155:8453": [LOOP] }, tools: [] };
  const helpers = { quoteIsStale: () => false, priceDisagreesWithOrigin: () => false, networksNeedLiveVerify: () => false, looksLikeListingInjection: () => false };
  const d = composeSellerDossier({ host: "seller-a.example", detail: DETAIL, entry: { origin: DETAIL.origin, tools: [] }, dispatch: { routerDispatchEligible: false, routerDispatchReason: "settlement_self_funded", routerDispatchByChain: { base: la.chains.base } }, evidenceBinding: b.get("https://seller-a.example"), leaderboardRow: null, bazaar: null, solana: null, mpp: null, refusals: [], registration: null, deliveries: new Map(), sharedClaims: {}, helpers, thresholds: { sorThreshold: 50, sorPayers: 3, sorCap: 0.005 }, self: false, now: NOW });
  const self = d.wallets?.base?.selfFundedAtWallets || [];
  const flag = (d.flags || []).find((f) => /paid with USDC that wallet had sent its payers/.test(f));
  ok(self.some((x) => x.wallet === LOOP && x.settled === 800) && flag && /most of the dollars/.test(flag), "the dossier lists the self-funded figures per wallet and flags them");
  ok(!JSON.stringify(self).includes(P(1)) && !/0x[0-9a-f]{6}|\.example/.test(flag), "...counts only (no payer), and the flag names no one");
}

// --- 7. Refunds and cheap calls cannot be turned against an honest seller ----------
{
  // A seller refunds its main repeat buyer $0.01 once; the buyer then makes 60
  // more purchases. Only what the refund covers is netted.
  const W = addr("a1");
  const sp = [], so = [];
  const main = P(500), others = [P(501), P(502), P(503)];
  for (let k = 0; k < 40; k++) sp.push({ wallet: W, payer: main, usd: 0.01, pos: posOf(1000 + k, 0) });
  for (const [i, o] of others.entries()) for (let k = 0; k < 20; k++) sp.push({ wallet: W, payer: o, usd: 0.01, pos: posOf(1100 + i * 30 + k, 0) });
  so.push(log(W, main, usd(0.01), 1300));
  for (let k = 0; k < 60; k++) sp.push({ wallet: W, payer: main, usd: 0.01, pos: posOf(1400 + k, 0) });
  const st = createFundingState(USDC);
  const r = await scanOnce({ sellers: [seller(W, "seller-r.example")], pays: sp, outs: so, state: st, latest: 2000, span: 2000 });
  const bz = [["https://seller-r.example", { calls30d: 400, payers30d: 12, payTos: [W] }]];
  const circ = circularWalletsFrom(r.ev, { now: NOW });
  const bind = buildEvidenceBinding({ leaderboardRows: r.ranked, walletEvidence: r.ev, bazaarQuality: bz, circularWallets: circ, ...FLOORS });
  ok(r.ev[W].selfFundedCalls === 1 && r.ev[W].callsSettled === 159 && r.ev[W].circular === false && !circ.has(W), "ONE $0.01 REFUND to the main buyer nets one later $0.01 payment, not its 60 (159 of 160 counted, not circular)");
  ok(label(bind, "https://seller-r.example", W).eligible === true && bind.get("https://seller-r.example").byWallet.get(W).settled === 400 && rankingPayersOf(bz[0][1], circ) === 12, "...eligible, and its Bazaar figures (400 / 12) and tie-break payers kept");
}
{
  // Wallets the seller once refunded, each paying the seller's cheapest price
  // again, cannot outweigh its genuine dollars: judged by dollars, not calls.
  const W = addr("a2");
  const sp = [], so = [];
  for (let i = 0; i < 4; i++) for (let k = 0; k < 10; k++) sp.push({ wallet: W, payer: P(600 + i), usd: 0.01, pos: posOf(1000 + i * 20 + k, 0) });
  for (let i = 0; i < 5; i++) { so.push(log(W, P(700 + i), usd(0.001), 1200 + i)); for (let k = 0; k < 40; k++) sp.push({ wallet: W, payer: P(700 + i), usd: 0.001, pos: posOf(1300 + i * 50 + k, 0) }); }
  const st = createFundingState(USDC);
  const r = await scanOnce({ sellers: [seller(W, "seller-v.example")], pays: sp, outs: so, state: st, latest: 2000, span: 2000 });
  const circ = circularWalletsFrom(r.ev, { now: NOW });
  ok(r.ev[W].selfFundedCalls === 5 && r.ev[W].selfFundedUsd === 0.005 && r.ev[W].circular === false && !circ.has(W), "five refunded wallets making 200 calls at $0.001 net five calls ($0.005 of $0.60): the seller is not circular, and keeps its Bazaar tie-break payers");
}

{
  // Many cheap calls paid with a refund cannot outweigh fewer, dearer genuine
  // ones: judged by dollars, a seller with 20 genuine $0.10 calls is not made
  // circular by 100 refunded $0.001 calls (by count it would be 100 of 120).
  const W = addr("a3");
  const sp = [], so = [];
  for (let i = 0; i < 4; i++) for (let k = 0; k < 5; k++) sp.push({ wallet: W, payer: P(900 + i), usd: 0.1, pos: posOf(1000 + i * 10 + k, 0) });
  so.push(log(W, P(950), usd(0.1), 1100));
  for (let k = 0; k < 100; k++) sp.push({ wallet: W, payer: P(950), usd: 0.001, pos: posOf(1200 + k, 0) });
  const r = await scanOnce({ sellers: [seller(W, "seller-u.example")], pays: sp, outs: so, state: createFundingState(USDC), latest: 2000, span: 2000 });
  ok(r.ev[W].selfFundedCalls === 100 && r.ev[W].circular === false && r.ev[W].callsSettled === 20 && r.ev[W].uniqueBuyers === 4, "100 refunded $0.001 calls against 20 genuine $0.10 ones: netted, but the seller is not circular ($0.10 of $2.10 self-funded)");
}

// --- 8. The ranking tie-break -------------------------------------------------------
{
  const q = { calls30d: 500, payers30d: 40, payTos: [LOOP] };
  ok(rankingPayersOf(q, circular) === null && rankingPayersOf(q, new Set()) === 40, "a circular wallet's Bazaar payer count never breaks a ranking tie (null = unmeasured, not zero)");
  const split = { calls30d: 510, payers30d: 40, payTos: [LOOP, HONEST] };
  Object.defineProperty(split, "byPayTo", { value: { [LOOP]: { calls: 500, payers: 40 }, [HONEST]: { calls: 10, payers: 6 } }, enumerable: false });
  ok(rankingPayersOf(split, circular) === 6, "with a per-wallet split only the circular wallet's slice is left out");
  const index = readFileSync(new URL("../src/x402-index.js", import.meta.url), "utf8");
  ok(/p = rankingPayersOf\(bazaarQualityFor\(seller\), circular\.wallets\)/.test(index) && /cacheVersion, circular\.version\]\)/.test(index), "routeQuery reads it for every seller, and its scoring memo is keyed on the circular set's version");
}

// --- 9. The operator's clearance, through the leaderboard's getters -----------------
{
  LB._resetLeaderboardCacheForTests();
  writeFileSync(process.env.LEADERBOARD_SNAPSHOT_FILE, JSON.stringify({ spec: "x402-leaderboard/1", asOf: new Date(NOW).toISOString(), leaderboard: s1.ranked, walletEvidence: ev }));
  LB.startLeaderboardRefresh({ intervalMs: 3_600_000, firstDelayMs: 3_600_000 });
  const list = new Set();
  let version = 0;
  const store = { has: (w) => list.has(String(w).toLowerCase()), get version() { return version; } };
  LB.configureSellerFunding({ cleared: store });
  ok(LB.getLeaderboardCircularWallets(NOW).wallets.has(LOOP) && LB.getLeaderboardWalletEvidence()[LOOP].callsSettled === 2, "before: circular, credited its net figures");
  list.add(LOOP); version++;
  ok(!LB.getLeaderboardCircularWallets(NOW).wallets.has(LOOP) && LB.getLeaderboardWalletEvidence()[LOOP].callsSettled === 62 && LB.getLeaderboardWalletEvidence()[LOOP].selfFundingCleared === true, "CLEARED: not circular, and its evidence reads gross, from the next read (no rescan)");
  ok(LB.getLeaderboardCircularWallets(NOW).wallets.has(MIXED) && LB.getLeaderboardWalletEvidence()[MIXED].callsSettled === 64, "...every other wallet untouched");
  list.delete(LOOP); version++;
  ok(LB.getLeaderboardCircularWallets(NOW).wallets.has(LOOP) && LB.getLeaderboardWalletEvidence()[LOOP].callsSettled === 2, "RESTORED: the measurement was never dropped, so the verdict is back at once");
  LB.stopLeaderboardRefresh();
  LB._resetLeaderboardCacheForTests();
}

// --- 10. End to end: the refresh loop against a stub Bazaar + RPC, twice ------------
{
  let LATEST = 10_000;
  const e2ePays = [], e2eOuts = [];
  const inLog = (to, from, block, idx) => ({ address: USDC, topics: [TRANSFER, topic(from), topic(to)], data: "0x" + (10_000).toString(16).padStart(64, "0"), blockNumber: hex(block), logIndex: hex(idx) });
  // seller-a funds three payers well BEFORE the window (inside the first read's
  // lookback), each pays 20x in the window; one organic payer.
  for (let i = 1; i <= 3; i++) { e2eOuts.push(log(LOOP, P(i), usd(3), 8_500, i)); for (let k = 0; k < 20; k++) e2ePays.push(inLog(LOOP, P(i), 9_100 + k, i)); }
  e2ePays.push(inLog(LOOP, P(90), 9_200, 0));
  // seller-b: four payers x 15, a refund to one after its payments.
  for (let i = 20; i < 24; i++) for (let k = 0; k < 15; k++) e2ePays.push(inLog(HONEST, P(i), 9_300 + k, i));
  e2eOuts.push(log(HONEST, P(20), 10_000, 9_900));
  const rpcCalls = [];
  const srv = createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      const send = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      if (req.url.startsWith("/bazaar")) {
        const items = [
          { resource: "https://seller-a.example/api/x", accepts: [{ network: "eip155:8453", asset: USDC, payTo: LOOP, amount: "10000" }] },
          { resource: "https://seller-b.example/api/y", accepts: [{ network: "eip155:8453", asset: USDC, payTo: HONEST, amount: "10000" }] },
          { resource: "https://burn.example/api/z", accepts: [{ network: "eip155:8453", asset: USDC, payTo: ZERO_ADDRESS, amount: "10000" }] },
        ];
        return send(/offset=0/.test(req.url) ? { items, pagination: { total: items.length } } : { items: [] });
      }
      const j = JSON.parse(body || "{}");
      if (j.method === "eth_blockNumber") return send({ jsonrpc: "2.0", id: j.id, result: hex(LATEST) });
      if (j.method === "eth_getLogs") {
        const p = j.params[0];
        rpcCalls.push(p);
        // One chain: the filter's topics pick inbound payments, outbound
        // funding, or a gap read (funded payers to a wallet) out of it.
        return send({ jsonrpc: "2.0", id: j.id, result: filterLogs([...e2ePays, ...e2eOuts], p) });
      }
      return send({ jsonrpc: "2.0", id: j.id, error: { code: -32601, message: "no" } });
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const opts = { bazaarUrl: `${base}/bazaar`, rpcs: [`${base}/rpc`, `${base}/rpc-fallback`], spanBlocks: 1_000, chunkBlocks: 500, fundingLookbackBlocks: 2_000, intervalMs: 3_600_000, firstDelayMs: 0 };
  const waitForScan = async (after) => { for (let i = 0; i < 200; i++) { const s = LB.getLeaderboardSnapshot(); if (s.asOf && s.asOf !== after && !s.warming && LB.getLeaderboardFundingScan()) return s; await new Promise((r) => setTimeout(r, 25)); } return null; };
  try {
    const direct = await runLeaderboard({ ...opts, now: NOW });
    ok(direct.walletsQueried === 2 && !direct.leaderboard.some((r) => r.wallets.includes(ZERO_ADDRESS)), "scan: a listing whose payTo is the zero address is not scanned (burns are not sales)");
    ok(direct.walletEvidence[LOOP]?.callsSettled === 1 && direct.walletEvidence[LOOP]?.grossCallsSettled === 61 && direct.walletEvidence[LOOP]?.circular === true, "scan: funding read in the lookback nets seller-a to 1 genuine call and marks it circular");
    ok(direct.walletEvidence[HONEST]?.callsSettled === 60 && direct.walletEvidence[HONEST]?.circular === false, "scan: seller-b's refund after payment leaves all 60 counted");
    rpcCalls.length = 0;
    LB._resetLeaderboardCacheForTests();
    LB.startLeaderboardRefresh(opts);
    const first = await waitForScan(null);
    const outbound1 = rpcCalls.filter((p) => Array.isArray(p.topics?.[1]) && p.topics?.[2] === null);
    const gap1 = rpcCalls.filter((p) => Array.isArray(p.topics?.[1]) && Array.isArray(p.topics?.[2]));
    ok(first && outbound1.length === 1 && parseInt(outbound1[0].fromBlock, 16) === LATEST - 1_000 - 2_000 && parseInt(outbound1[0].toBlock, 16) === LATEST, "refresh 1: ONE outbound read for both paid wallets over the window plus the first read's lookback");
    ok(gap1.length === 1 && parseInt(gap1[0].toBlock, 16) === LATEST - 1_000 - 1, "refresh 1: ONE gap read (both wallets' funded payers, up to the window) so their pools start right");
    ok(LB.getLeaderboardCircularWallets(NOW).wallets.has(LOOP) && LB.getLeaderboardFundingScan()?.walletsCaughtUp === 2, "refresh 1: the verdict and the read's counts are published to the router");
    await new Promise((r) => setTimeout(r, 50));
    ok(existsSync(process.env.LEADERBOARD_FUNDING_FILE) && parseFundingState(readFileSync(process.env.LEADERBOARD_FUNDING_FILE, "utf8"), USDC).wallets.get(LOOP)?.cursor === LATEST, "refresh 1: the funding state is persisted beside the snapshot with each wallet's cursor");
    const served = LB.getLeaderboardSnapshot();
    ok(!JSON.stringify(served).includes("routerFundingScan") && !JSON.stringify(served).includes("selfFundedCalls") && !JSON.stringify(served).includes("walletEvidence"), "served snapshot: no funding read, no per-wallet evidence");
    // A restart: the next process loads the persisted state and reads only new blocks.
    LB.stopLeaderboardRefresh();
    LB._resetLeaderboardCacheForTests();
    LATEST = 10_400;
    for (let k = 0; k < 5; k++) e2ePays.push(inLog(LOOP, P(1), 10_100 + k, 1));
    rpcCalls.length = 0;
    LB.startLeaderboardRefresh(opts);
    const second = await waitForScan(first?.asOf);
    const outbound2 = rpcCalls.filter((p) => Array.isArray(p.topics?.[1]));
    ok(second && outbound2.length === 1 && parseInt(outbound2[0].fromBlock, 16) === 10_001 && parseInt(outbound2[0].toBlock, 16) === 10_400, `refresh after a restart: the persisted cursors are used, only the new blocks are read (${outbound2.map((p) => `${parseInt(p.fromBlock, 16)}-${parseInt(p.toBlock, 16)}`).join(",")})`);
    ok(LB.getLeaderboardWalletEvidence()[LOOP]?.selfFundedCalls === 5 && LB.getLeaderboardWalletEvidence()[LOOP]?.grossCallsSettled === 5, "...and the pools remembered from the first process (funded before the first window) net the new payments");
    ok(outbound2.every((p) => rpcCalls.includes(p)) && !JSON.stringify(outbound2).includes("rpc-fallback"), "the funding read uses the primary RPC only");
  } finally {
    LB.stopLeaderboardRefresh();
    srv.close();
  }
}

// --- 11. The call sites, pinned from source ------------------------------------------
{
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const at = server.indexOf("function buildEvidenceBindingByOrigin(");
  ok(/circularWallets: getLeaderboardCircularWallets\(\)\.wallets,/.test(server.slice(at, server.indexOf("\n}\n", at))), "the router's evidence binding reads the circular set");
  ok(/configureSellerFunding\(\{ cleared: selfFundingClearedStore\(\), skip: \(w\) => sharedPayToStore\(\)\.has\(w\) \}\)/.test(server), "the server hands the rule the operator's clearances and skips the shared settlement contracts");
  const lbSrc = readFileSync(new URL("../src/leaderboard.js", import.meta.url), "utf8");
  const run = lbSrc.slice(lbSrc.indexOf("export async function runLeaderboard("), lbSrc.indexOf("// --- history persistence"));
  const order = ["await readSellerFunding(", "processSellerFunding(state, byWallet,", "applySellerFunding(byWallet, state,", "const ranked = finalizeLeaderboard(byWallet"].map((x) => run.indexOf(x));
  ok(order.every((i) => i > 0) && order.every((i, k) => k === 0 || i > order[k - 1]), "runLeaderboard reads, works the pools, applies, then finalizes (the order scanOnce above mirrors)");
  ok(/rpcCall\(primary, method, params, \{ passes: 1 \}\)/.test(run) && /\.filter\(\(s\) => isScannableWallet\(s\.wallet, chain\.token\)\)/.test(run), "the funding read uses the primary RPC once per call; non-wallet payTos are dropped from the scan");
  ok(/\.sort\(\(a, b\) => clears\(b\) - clears\(a\) \|\| \(b\.callsSettled \|\| 0\) - \(a\.callsSettled \|\| 0\)\)/.test(run) && /await readFundingGaps\(\{ rpc: fundingRpc,[^\n]*maxCalls: Math\.max\(0, maxCalls - facts\.calls\)/.test(run), "wallets that clear the floor on gross are read first, and the gap read spends only what the outbound read left of the budget");
  ok(/await loadSellerFundingState\(\)/.test(lbSrc) && /await persistSellerFundingState\(fundingState\)/.test(lbSrc), "every refresh loads the persisted state and writes it back");
}

// --- 12. The operator lever on a booted server ----------------------------------------
{
  const dir2 = mkdtempSync(join(tmpdir(), "seller-funding-boot-"));
  const W = addr("b1");
  const A = "https://seller-q.example";
  const nowIso = new Date().toISOString();
  writeFileSync(join(dir2, "lb.json"), JSON.stringify({
    spec: "x402-leaderboard/1", asOf: nowIso, windowLabel: "7d",
    leaderboard: [{ rank: 1, homepage: A, origins: [A], wallet: W, wallets: [W], callsSettled: 500, uniqueBuyers: 40 }],
    walletEvidence: { [W]: { callsSettled: 4, uniqueBuyers: 3, grossCallsSettled: 500, grossUniqueBuyers: 40, selfFundedCalls: 496, selfFundedUsd: 4.96, grossUsd: 5, circular: true, lastCircularAt: nowIso, fundingRead: true, origins: [A] } },
  }));
  const TOKEN = "seller-funding-operator-token-for-tests";
  const H = { "x-operator-token": TOKEN, "content-type": "application/json" };
  let proc = null, port = null;
  const serverLog = [];
  const boot = async () => {
    port = await getFreePort();
    proc = spawn(process.execPath, ["src/server.js"], {
      env: {
        ...process.env, PORT: String(port), FREE_MODE: "true", AGENT402_OPERATOR_TOKEN: TOKEN,
        LEADERBOARD_SNAPSHOT_FILE: join(dir2, "lb.json"), LEADERBOARD_FUNDING_FILE: join(dir2, "funding.json"),
        SOR_SELF_FUNDING_CLEARED_FILE: join(dir2, "cleared.json"), SOR_SHARED_PAYTOS_FILE: join(dir2, "shared.json"),
        X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false",
        MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", WALLET_DIGEST: "off",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const keep = (c) => { for (const l of String(c).split("\n")) if (l.trim()) serverLog.push(l.slice(0, 300)); if (serverLog.length > 60) serverLog.splice(0, serverLog.length - 60); };
    proc.stdout.on("data", keep); proc.stderr.on("data", keep);
    for (let i = 0; i < 160; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return true; } catch { /* booting */ } await new Promise((r) => setTimeout(r, 500)); }
    return false;
  };
  const stop = () => new Promise((r) => { if (!proc) return r(); proc.once("exit", () => r()); proc.kill("SIGKILL"); });
  const get = async (p, h = H) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers: h }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const post = async (body, h = H) => { const r = await fetch(`http://127.0.0.1:${port}/__operator/seller-funding`, { method: "POST", headers: h, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  try {
    ok(await boot(), "server booted (free mode, leaderboard warm-started from a fixture with one circular wallet)");
    const before = await get(`/__operator/seller-funding.json?wallet=${W}`);
    ok(before.status === 200 && before.body.circular === true && before.body.cleared === false && before.body.selfFundedAt.some((x) => x.origin === A && x.settled === 500) && before.body.creditedTo.some((x) => x.origin === A && x.settled === 4), "before: circular, credited its net 4 with the gross 500 held as self-funded");
    ok((await get("/__operator/seller-funding.json", { accept: "application/json" })).status === 404 && (await post({ action: "clear", wallet: W }, { "content-type": "application/json" })).status === 404, "without the operator token both routes answer 404");
    const listing = await get("/__operator/seller-funding");
    ok(listing.status === 200 && listing.body.circular.some((x) => x.wallet === W) && !JSON.stringify(listing.body).match(/0xa0a0/), "the listing names the circular wallet and no payer");
    const clear = await post({ action: "clear", wallet: W, note: "rewards program" });
    ok(clear.status === 200 && clear.body.changed === true && clear.body.cleared === true, "POST clear lists the wallet");
    const after = await get(`/__operator/seller-funding.json?wallet=${W}`);
    ok(after.body.cleared === true && after.body.creditedTo.some((x) => x.origin === A && x.settled === 500) && after.body.selfFundedAt.length === 0, "applied from the next read, no redeploy: the gross 500 is credited and nothing is held as self-funded");
    ok((await post({ action: "clear", wallet: "0x12" })).status === 400 && (await post({ action: "nope", wallet: W })).status === 400, "a malformed wallet or action is refused 400");
    await stop();
    ok(await boot(), "RESTART: the server boots again over the same /data files");
    const restarted = await get(`/__operator/seller-funding.json?wallet=${W}`);
    ok(restarted.body.cleared === true && restarted.body.entry?.note === "rewards program" && restarted.body.creditedTo.some((x) => x.settled === 500), "the clearance survived the restart");
    const restore = await post({ action: "restore", wallet: W });
    const back = await get(`/__operator/seller-funding.json?wallet=${W}`);
    ok(restore.body.changed === true && back.body.cleared === false && back.body.circular === true && back.body.creditedTo.some((x) => x.settled === 4), "POST restore puts the verdict back at once");
  } catch (e) {
    ok(false, `booted leg threw: ${e?.stack || e}`);
    for (const l of serverLog.slice(-20)) console.error("  server:", l);
  } finally {
    await stop();
    try { rmSync(dir2, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
