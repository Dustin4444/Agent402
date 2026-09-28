#!/usr/bin/env node
// Self-funded payers are not settlement evidence (2026-09-28).
//
// A payment into wallet W does not count for W when its payer had received
// USDC from W (or a sibling wallet of the same seller) BEFORE paying: that is
// the seller's own money coming home. The scan reads each paid wallet's
// outbound transfers beside its inbound payments (src/leaderboard.js
// readSellerFunding / applySellerFunding), nets the per-wallet figures the
// router reads, and marks a wallet whose evidence is MOSTLY self-funded as
// circular, whose Bazaar and chain-join figures (the same payments, counted by
// others) the router then disregards (src/evidence-binding.js, and the ranking
// tie-break in src/x402-index.js).
//
// Offline: fixture logs, a fake RPC, and one stub HTTP server playing the
// Bazaar and a Base RPC for the end-to-end scan. Nothing is spent.
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "seller-funding-"));
process.env.LEADERBOARD_SNAPSHOT_FILE = join(dir, "leaderboard-snapshot.json");
process.env.LEADERBOARD_HISTORY_FILE = join(dir, "leaderboard-history.json");
const LB = await import("../src/leaderboard.js");
const { initWalletAccumulator, foldTransfers, finalizeLeaderboard, readSellerFunding, applySellerFunding, circularWalletsFrom, posOf, runLeaderboard } = LB;
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
const log = (from, to, value, block, idx = 0) => ({ address: USDC, topics: [TRANSFER, topic(from), topic(to)], data: "0x" + BigInt(value).toString(16).padStart(64, "0"), blockNumber: hex(block), logIndex: hex(idx) });

// Wallets and payers (neutral fixtures).
const CIRC = addr("11"), HONEST = addr("22"), MIXED = addr("33"), SIB_A = addr("44"), SIB_B = addr("45");
const P = (i) => "0x" + "a0".repeat(19) + i.toString(16).padStart(2, "0"); // payer i
const seller = (wallet, host) => ({ wallet, name: host, network: "base", origins: [`https://${host}`], homepage: `https://${host}`, endpoints: 1, prices: new Set() });
const SELLERS = [seller(CIRC, "seller-a.example"), seller(HONEST, "seller-b.example"), seller(MIXED, "seller-c.example"), seller(SIB_A, "seller-d.example"), seller(SIB_B, "seller-d.example")];

// Inbound payments (usd 0.01 each) with chain positions, and outbound funding.
const pays = [];
const outs = [];
const pay = (wallet, payer, block, idx = 1) => pays.push({ wallet, payer, usd: 0.01, pos: posOf(block, idx) });
// seller-a: funds P1..P5 at block 100, then each pays 12 times; two organic payers once each.
for (let i = 1; i <= 5; i++) { outs.push(log(CIRC, P(i), 2_000_000, 100, i)); for (let k = 0; k < 12; k++) pay(CIRC, P(i), 200 + k, i); }
pay(CIRC, P(90), 300); pay(CIRC, P(91), 301);
// seller-a also funds P(40), which then buys from seller-b: another seller's money, not seller-b's.
outs.push(log(CIRC, P(40), 1_000_000, 150));
// seller-b: ten payers x 10 payments. It REFUNDS P(20) after P(20)'s payments,
// and refunds P(21) mid-way (P(21) keeps paying after the refund).
for (let i = 20; i < 30; i++) for (let k = 0; k < 10; k++) pay(HONEST, P(i), (i === 21 ? 200 : 400) + k * (i === 21 ? 20 : 1), i);
outs.push(log(HONEST, P(20), 10_000, 900)); // refund after every P(20) payment
outs.push(log(HONEST, P(21), 10_000, 290)); // refund after P(21)'s first five (blocks 200..280)
for (let k = 0; k < 6; k++) pay(HONEST, P(40), 500 + k, 40);
// A ZERO-VALUE "funding" log from seller-b's wallet to its buyers, before they
// pay: anyone can emit one (a zero transferFrom needs no allowance).
for (let i = 22; i < 30; i++) outs.push(log(HONEST, P(i), 0, 50, i));
// seller-c: one whale it funded at block 50 makes 80 payments; 16 organic payers make 4 each.
outs.push(log(MIXED, P(60), 50_000_000, 50));
for (let k = 0; k < 80; k++) pay(MIXED, P(60), 100 + k, 60);
for (let i = 70; i < 86; i++) for (let k = 0; k < 4; k++) pay(MIXED, P(i), 300 + k, i);
// seller-d: two wallets, one host. SIB_B funds P(50); P(50) pays SIB_A.
outs.push(log(SIB_B, P(50), 1_000_000, 100));
for (let k = 0; k < 5; k++) pay(SIB_A, P(50), 200 + k, 50);
for (let i = 51; i < 54; i++) pay(SIB_A, P(i), 300, i);
// seller-a pays itself once: never a buyer.
pays.push({ wallet: CIRC, payer: CIRC, usd: 0.01, pos: posOf(310, 1) });

// A fake RPC that answers eth_getLogs over the fixture outbound list with the
// real filter semantics (address, block range, topic sets).
const inTopicSet = (set, t) => set === null || set === undefined || (Array.isArray(set) ? set.map((x) => x.toLowerCase()).includes(t.toLowerCase()) : set.toLowerCase() === t.toLowerCase());
const filterLogs = (list, p) => list.filter((l) => {
  const b = parseInt(l.blockNumber, 16);
  return b >= parseInt(p.fromBlock, 16) && b <= parseInt(p.toBlock, 16) && (!p.address || p.address.toLowerCase() === l.address)
    && inTopicSet(p.topics?.[0], l.topics[0]) && inTopicSet(p.topics?.[1], l.topics[1]) && inTopicSet(p.topics?.[2], l.topics[2]);
});
const fakeRpc = ({ refuseUntargeted = false, maxRangeBlocks = Infinity, calls = [] } = {}) => async (method, params) => {
  const p = params[0];
  calls.push(p);
  const span = parseInt(p.toBlock, 16) - parseInt(p.fromBlock, 16) + 1;
  if (refuseUntargeted && p.topics?.[2] === null) throw new Error("Log response size exceeded");
  if (span > maxRangeBlocks) throw new Error(`block range too large (${span})`);
  return filterLogs(outs, p);
};
const payersBy = (acc) => {
  const m = new Map();
  for (const w of acc.values()) m.set(String(w.wallet).toLowerCase(), new Set([...w.perPayer.keys()].map((x) => x.toLowerCase())));
  // group siblings share payers (the scan builds it the same way)
  const sib = new Set([...(m.get(SIB_A) || []), ...(m.get(SIB_B) || [])]);
  m.set(SIB_A, sib); m.set(SIB_B, sib);
  return m;
};
const scan = async (rpcOpts = {}, readOpts = {}) => {
  const acc = initWalletAccumulator(SELLERS.map((s) => ({ ...s, origins: [...s.origins] })));
  foldTransfers(acc, pays);
  const calls = [];
  const facts = await readSellerFunding({ rpc: fakeRpc({ ...rpcOpts, calls }), token: USDC, sources: [CIRC, HONEST, MIXED, SIB_A, SIB_B], payersBySource: payersBy(acc), fromBlock: 0, toBlock: 1000, chunkBlocks: 400, walletChunk: 200, ...readOpts });
  return { acc, facts, calls };
};

// --- 1. The funding read ---------------------------------------------------------
{
  const { facts, calls } = await scan();
  ok(calls.length === 1 && calls[0].topics[2] === null && facts.partial === false && facts.read.size === 5, "one wide untargeted read covers every paid wallet when the RPC accepts it");
  ok(facts.fundedBy.get(CIRC)?.get(P(1)) === posOf(100, 1), "the earliest non-zero transfer from a seller to a payer is kept, with its chain position");
  ok(!facts.fundedBy.get(HONEST)?.has(P(22)), "a ZERO-VALUE transfer log is never funding (anyone can emit one from any wallet)");
  const wide = await scan({ refuseUntargeted: true, maxRangeBlocks: 400 });
  const span = (c) => parseInt(c.toBlock, 16) - parseInt(c.fromBlock, 16) + 1;
  ok(wide.facts.partial === false && wide.calls[0].topics[2] === null && wide.calls.some((c) => Array.isArray(c.topics[2]) && span(c) <= 400),
    "a refused wide read falls back to reads TARGETED at the wallets' own payers, then to narrower ranges");
  ok(wide.facts.fundedBy.get(CIRC)?.get(P(1)) === posOf(100, 1) && wide.facts.fundedBy.get(SIB_B)?.get(P(50)) === posOf(100, 0), "...and learns the same funding facts");
  const capped = await scan({ refuseUntargeted: true, maxRangeBlocks: 400 }, { maxCalls: 3 });
  ok(capped.facts.partial === true && capped.calls.length === 3 && capped.facts.unread.size > 0, "the read stops at maxCalls and says which wallets it could not read (partial)");
  const trunc = await scan({}, { maxRecipientsPerSource: 2 });
  ok(trunc.facts.truncated.has(CIRC) && trunc.facts.fundedBy.get(CIRC).size === 2, "a wallet paying out to more recipients than the cap is read up to it and flagged");
}

// --- 2. Netting, per payment, ordered ---------------------------------------------
const NOW = Date.parse("2026-09-28T00:00:00Z");
const { acc, facts } = await scan();
applySellerFunding(acc, facts, { now: NOW });
const ranked = finalizeLeaderboard(acc);
const ev = ranked.walletEvidence;
ok(ev[CIRC].grossCallsSettled === 62 && ev[CIRC].callsSettled === 2 && ev[CIRC].uniqueBuyers === 2 && ev[CIRC].selfFundedCalls === 60 && ev[CIRC].selfFundedPayers === 5, "CIRCULAR SELLER: 60 of 62 payments came from payers it funded first -> net 2 calls / 2 payers");
ok(ev[CIRC].circular === true && ev[CIRC].lastCircularAt === new Date(NOW).toISOString(), "...and the wallet is marked circular (most of its evidence is self-funded)");
ok(ranked.find((r) => r.wallets.includes(CIRC)).callsSettled === 62, "the public row stays gross (router input only; the self-transfer is skipped as a buyer)");
ok(ev[HONEST].grossCallsSettled === 106 && ev[HONEST].callsSettled === 101 && ev[HONEST].uniqueBuyers === 11 && ev[HONEST].circular === false, "HONEST SELLER WITH REFUNDS: kept (106 gross, 101 net, 11 payers, not circular)");
{
  const p20 = acc.get(HONEST).perPayer.get(P(20));
  ok(p20.calls === 10 && facts.fundedBy.get(HONEST)?.get(P(20)) === posOf(900, 0) && ev[HONEST].selfFundedCalls === 5, "a refund AFTER a payer's payments never makes those earlier payments self-funded (P20 was refunded; none of its ten is netted)");
  ok(ev[HONEST].selfFundedCalls === 5, "a payer refunded mid-way keeps its earlier payments; only the five made after the refund stop counting");
  ok(!facts.fundedBy.get(HONEST)?.has(P(40)) && ev[HONEST].uniqueBuyers === 11, "a payer funded by ANOTHER seller's wallet still counts for this seller");
}
ok(ev[MIXED].grossCallsSettled === 144 && ev[MIXED].callsSettled === 64 && ev[MIXED].uniqueBuyers === 16 && ev[MIXED].circular === true, "MIXED SELLER: circular by calls (80 of 144), judged on its genuine part: 64 calls / 16 payers");
ok(ev[SIB_A].callsSettled === 3 && ev[SIB_A].selfFundedCalls === 5, "a payer funded by a SIBLING wallet of the same host is the same seller funding it");
{
  const noRead = initWalletAccumulator(SELLERS.map((s) => ({ ...s, origins: [...s.origins] })));
  foldTransfers(noRead, pays);
  applySellerFunding(noRead, { fundedBy: facts.fundedBy, read: new Set([HONEST, MIXED, SIB_A, SIB_B]) }, { now: NOW });
  ok(noRead.get(CIRC).funding.read === false && noRead.get(CIRC).funding.fundedCalls === 60, "a wallet whose own outbound was not read is flagged read:false (what IS known still nets it)");
  const none = initWalletAccumulator(SELLERS.map((s) => ({ ...s, origins: [...s.origins] })));
  foldTransfers(none, pays);
  applySellerFunding(none, null, { now: NOW });
  ok(none.get(CIRC).funding.netCalls === 62 && none.get(CIRC).funding.circular === false, "no funding facts at all nets nothing and flags nothing (absence of evidence never refuses)");
}
// The verdict outlives a quiet week while the Bazaar's 30 days still count it.
{
  const later = initWalletAccumulator(SELLERS.map((s) => ({ ...s, origins: [...s.origins] })));
  foldTransfers(later, [{ wallet: CIRC, payer: P(99), usd: 0.01, pos: posOf(5000, 1) }]);
  applySellerFunding(later, { fundedBy: new Map(), read: new Set([CIRC, HONEST, MIXED, SIB_A, SIB_B]) }, { now: NOW + 10 * 86_400_000, previous: ev });
  ok(later.get(CIRC).funding.circular === false && later.get(CIRC).funding.lastCircularAt === ev[CIRC].lastCircularAt, "ten days later, not circular this scan, the last verdict is carried");
  ok(circularWalletsFrom({ [CIRC]: { lastCircularAt: ev[CIRC].lastCircularAt } }, { now: NOW + 10 * 86_400_000 }).has(CIRC) && !circularWalletsFrom({ [CIRC]: { lastCircularAt: ev[CIRC].lastCircularAt } }, { now: NOW + 31 * 86_400_000 }).has(CIRC), "...inside the 30-day window, and not after it");
}

// --- 3. The gate: netted figures, and the circular wallet's Bazaar ignored -------
const rows = ranked;
const circular = circularWalletsFrom(ev, { now: NOW });
ok(circular.has(CIRC) && circular.has(MIXED) && !circular.has(HONEST), "circular set: seller-a and seller-c, never seller-b");
const bazaar = [
  ["https://seller-a.example", { calls30d: 500, payers30d: 40, payTos: [CIRC] }],
  ["https://seller-c.example", { calls30d: 900, payers30d: 50, payTos: [MIXED] }],
];
const chainProven = new Map([["https://seller-a.example", { settled: 800, payers: 9, payTo: CIRC }]]);
const b = buildEvidenceBinding({ leaderboardRows: rows, walletEvidence: ev, bazaarQuality: bazaar, chainProven, circularWallets: circular, ...FLOORS });
const control = buildEvidenceBinding({ leaderboardRows: rows, walletEvidence: ev, bazaarQuality: bazaar, chainProven, ...FLOORS });
const label = (bind, origin, live) => dispatchEligibility({ routable: true, networks: ["eip155:8453"], settled: bind.get(origin)?.settled || 0, payers: bind.get(origin)?.payers, spendChains: ["base"], ...FLOORS, evidence: bind.get(origin), livePayTo: live });
ok(label(control, "https://seller-a.example", CIRC).eligible === true, "control: without the circular set, the Bazaar's count of the same self-payments re-admits seller-a");
const la = label(b, "https://seller-a.example", CIRC);
ok(la.eligible === false && la.reason === "settlement_self_funded", "CIRCULAR SELLER DEMOTED: reads settlement_self_funded");
ok(b.get("https://seller-a.example").byWallet.get(CIRC).settled === 2 && b.get("https://seller-a.example").selfFunded.byWallet.get(CIRC).settled === 800, "its Bazaar and chain-join figures are disregarded (kept as selfFunded, never credited)");
ok(b.get("https://seller-a.example").ownSettled === 0, "the chain join at a circular wallet is not the origin's own evidence either");
const forced = baseLiveGate({ networks: ["eip155:8453"], settled: 800, payers: 40, priceUsd: 0.01, ...FLOORS, binding: b.get("https://seller-a.example"), livePayTo: CIRC });
ok(forced.ok === false, "handed the old figures (800 / 40) the gate still refuses: no wallet clears on genuine evidence");
const lb = label(b, "https://seller-b.example", HONEST);
ok(lb.eligible === true && lb.reason === "eligible", "HONEST SELLER KEPT: seller-b stays eligible at its wallet");
const lc = label(b, "https://seller-c.example", MIXED);
ok(lc.eligible === true && b.get("https://seller-c.example").byWallet.get(MIXED).settled === 64 && b.get("https://seller-c.example").selfFunded.byWallet.get(MIXED).settled === 900, "MIXED SELLER: eligible on its genuine 64 / 16, its Bazaar figures (900) disregarded");
ok(typeof DISPATCH_REASONS.settlement_self_funded === "string" && dispatchLegend().routerDispatchReason.settlement_self_funded === DISPATCH_REASONS.settlement_self_funded && !/\b[a-z0-9-]+\.(example|com|io|xyz|ai|tools)\b/i.test(DISPATCH_REASONS.settlement_self_funded + dispatchLegend()["routerDispatchReason.settlement_self_funded"]), "the public reason and its legend sentence are published and name no one");

// --- 4. The ranking tie-break ------------------------------------------------------
{
  const q = { calls30d: 500, payers30d: 40, payTos: [CIRC] };
  ok(rankingPayersOf(q, circular) === null && rankingPayersOf(q, new Set()) === 40, "a circular wallet's Bazaar payer count never breaks a ranking tie (null = unmeasured, not zero)");
  const split = { calls30d: 510, payers30d: 40, payTos: [CIRC, HONEST] };
  Object.defineProperty(split, "byPayTo", { value: { [CIRC]: { calls: 500, payers: 40 }, [HONEST]: { calls: 10, payers: 6 } }, enumerable: false });
  ok(rankingPayersOf(split, circular) === 6, "with a per-wallet split only the circular wallet's slice is left out");
  const index = readFileSync(new URL("../src/x402-index.js", import.meta.url), "utf8");
  ok(/p = rankingPayersOf\(bazaarQualityFor\(seller\), circular\.wallets\)/.test(index) && /cacheVersion, circular\.version\]\)/.test(index), "routeQuery reads it for every seller, and its scoring memo is keyed on the circular set's version");
}

// --- 5. End to end: runLeaderboard against a stub Bazaar + RPC ----------------------
{
  const LATEST = 10_000;
  const e2ePays = [], e2eOuts = [];
  const inLog = (to, from, block, idx) => ({ address: USDC, topics: [TRANSFER, topic(from), topic(to)], data: "0x" + (10_000).toString(16).padStart(64, "0"), blockNumber: hex(block), logIndex: hex(idx) });
  // seller-a funds three payers in the LOOKBACK (before the window), each pays 20x in the window; one organic payer.
  for (let i = 1; i <= 3; i++) { e2eOuts.push(log(CIRC, P(i), 3_000_000, 8_500, i)); for (let k = 0; k < 20; k++) e2ePays.push(inLog(CIRC, P(i), 9_100 + k, i)); }
  e2ePays.push(inLog(CIRC, P(90), 9_200, 0));
  // seller-b: four payers x 15, a refund to one after its payments.
  for (let i = 20; i < 24; i++) for (let k = 0; k < 15; k++) e2ePays.push(inLog(HONEST, P(i), 9_300 + k, i));
  e2eOuts.push(log(HONEST, P(20), 10_000, 9_900));
  let refuseUntargeted = false;
  const rpcCalls = [];
  const srv = createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      const send = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      if (req.url.startsWith("/bazaar")) {
        const items = [
          { resource: "https://seller-a.example/api/x", accepts: [{ network: "eip155:8453", asset: USDC, payTo: CIRC, amount: "10000" }] },
          { resource: "https://seller-b.example/api/y", accepts: [{ network: "eip155:8453", asset: USDC, payTo: HONEST, amount: "10000" }] },
        ];
        return send(/offset=0/.test(req.url) ? { items, pagination: { total: items.length } } : { items: [] });
      }
      const j = JSON.parse(body || "{}");
      if (j.method === "eth_blockNumber") return send({ jsonrpc: "2.0", id: j.id, result: hex(LATEST) });
      if (j.method === "eth_getLogs") {
        const p = j.params[0];
        rpcCalls.push(p);
        if (Array.isArray(p.topics?.[2]) && p.topics[1] === null) return send({ jsonrpc: "2.0", id: j.id, result: filterLogs(e2ePays, p) });
        if (refuseUntargeted && p.topics?.[2] === null) return send({ jsonrpc: "2.0", id: j.id, error: { code: -32602, message: "Log response size exceeded" } });
        return send({ jsonrpc: "2.0", id: j.id, result: filterLogs(e2eOuts, p) });
      }
      return send({ jsonrpc: "2.0", id: j.id, error: { code: -32601, message: "no" } });
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const run = () => runLeaderboard({ bazaarUrl: `${base}/bazaar`, rpcs: [`${base}/rpc`], spanBlocks: 1_000, chunkBlocks: 500, fundingLookbackBlocks: 2_000, now: NOW });
  try {
    const snap = await run();
    const w = snap.walletEvidence;
    ok(w[CIRC]?.callsSettled === 1 && w[CIRC]?.grossCallsSettled === 61 && w[CIRC]?.circular === true && w[CIRC]?.fundingRead === true, "scan: funding read in the lookback nets seller-a to 1 genuine call and marks it circular");
    ok(w[HONEST]?.callsSettled === 60 && w[HONEST]?.uniqueBuyers === 4 && w[HONEST]?.circular === false, "scan: seller-b's refund after payment leaves all 60 counted");
    ok(snap.leaderboard.find((r) => r.wallets.includes(CIRC))?.callsSettled === 61, "scan: the public row is untouched (gross)");
    ok(snap.routerFundingScan?.calls === 1 && snap.routerFundingScan?.wallets === 2 && snap.routerFundingScan?.partial === false, "scan: ONE outbound read for both paid wallets over window + lookback");
    const outbound = rpcCalls.filter((p) => p.topics?.[1] !== null);
    ok(outbound.length === 1 && parseInt(outbound[0].fromBlock, 16) === LATEST - 1_000 - 2_000 && parseInt(outbound[0].toBlock, 16) === LATEST, "scan: the outbound read spans the window plus the lookback");
    rpcCalls.length = 0; refuseUntargeted = true;
    const snap2 = await run();
    ok(snap2.walletEvidence[CIRC]?.callsSettled === 1 && snap2.routerFundingScan.calls > 1 && rpcCalls.some((p) => p.topics?.[1] !== null && Array.isArray(p.topics?.[2])), "scan: a refused wide read falls back to the targeted read and reaches the same verdict");
    // Persisted and warm-started with the snapshot, never served.
    writeFileSync(process.env.LEADERBOARD_SNAPSHOT_FILE, JSON.stringify(snap));
    LB._resetLeaderboardCacheForTests();
    LB.startLeaderboardRefresh({ intervalMs: 3_600_000, firstDelayMs: 3_600_000 });
    const served = LB.getLeaderboardSnapshot();
    ok(!JSON.stringify(served).includes("routerFundingScan") && !JSON.stringify(served).includes("selfFundedCalls") && !JSON.stringify(served).includes("walletEvidence"), "served snapshot: no funding read, no per-wallet evidence");
    ok(LB.getLeaderboardCircularWallets(NOW).wallets.has(CIRC) && LB.getLeaderboardFundingScan()?.calls === 1, "warm start: the circular verdict and the read's counts come back from /data");
    LB.stopLeaderboardRefresh();
  } finally {
    srv.close();
  }
}

// --- 6. The call sites, pinned from source ------------------------------------------
{
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const at = server.indexOf("function buildEvidenceBindingByOrigin(");
  ok(/circularWallets: getLeaderboardCircularWallets\(\)\.wallets,/.test(server.slice(at, server.indexOf("\n}\n", at))), "the router's evidence binding reads the circular set");
  const lbSrc = readFileSync(new URL("../src/leaderboard.js", import.meta.url), "utf8");
  ok(/applySellerFunding\(byWallet, facts,/.test(lbSrc) && lbSrc.indexOf("applySellerFunding(byWallet, facts,") < lbSrc.indexOf("const ranked = finalizeLeaderboard(byWallet"), "runLeaderboard nets the scan before it finalizes");
  ok(/previousWalletEvidence: cached\.snapshot\?\.walletEvidence/.test(lbSrc), "each refresh hands the previous verdicts in (the 30-day carry)");
}

try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
