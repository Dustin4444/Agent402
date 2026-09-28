#!/usr/bin/env node
// The seller-funding reader's calls stay bounded, and fall away, however many
// heavy payTos a scan meets (2026-09-28, after two reviews).
//
// A payTo whose history the RPC answers only over narrow ranges (a busy
// contract's shape, or an origin that lists one) cannot have its payers'
// history read inside any reasonable budget. The reader must find that out
// for a bounded number of calls, ONCE, and then leave it alone: a wallet
// whose read cannot be finished waits, and when it comes back it neither
// re-learns what it already learned nor spends on new payers it could not use.
//
// This drives the REAL runLeaderboard, refresh after refresh, against one stub
// HTTP server playing the Bazaar and a Base RPC with the provider's documented
// eth_getLogs rule (a range over 2,000 blocks is refused above 10,000 logs),
// plus a refusal of every funding read wider than 10,000 blocks that names a
// heavy payTo together with one of its dense payers. The funding state is
// written and read back between refreshes, as on the volume. For 1, 12, 20,
// 50 and 200 heavy payTos beside 20 light wallets (4 of them paid with their
// own money) and one legitimate wallet with a dense stretch of history, it
// asserts: every refresh within the scan's budget and every rolling day's
// retries within the day's allowance; each heavy payTo costing a few calls
// once and none after; every light wallet read in the first refresh. Then
// eight days of heavy payTos that keep getting new payers, where every day
// after the first must cost no more than the one before; and a day whose
// retry allowance is spent in the first refresh, where a wallet whose payers
// first pay later must still be read in its first scan. Offline, nothing is
// spent.
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "funding-budget-"));
process.env.LEADERBOARD_SNAPSHOT_FILE = join(dir, "leaderboard-snapshot.json");
process.env.LEADERBOARD_HISTORY_FILE = join(dir, "leaderboard-history.json");
process.env.LEADERBOARD_FUNDING_FILE = join(dir, "leaderboard-funding.json");
process.env.LEADERBOARD_FUNDING_SWITCH_FILE = join(dir, "leaderboard-funding-switch.json");
for (const k of ["LEADERBOARD_FUNDING_SCAN", "LEADERBOARD_FUNDING_MAX_CALLS", "LEADERBOARD_FUNDING_WALLET_MAX_CALLS", "LEADERBOARD_FUNDING_DAY_MAX_CALLS", "FUNDING_HISTORY_CHUNK_BLOCKS", "FUNDING_HISTORY_FROM_BLOCK"]) delete process.env[k];
const LB = await import("../src/leaderboard.js");
const SF = await import("../src/seller-funding.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topic = (a) => "0x" + "0".repeat(24) + a.slice(2);
const hex = (n) => "0x" + n.toString(16);
const log = (from, to, micro, block, idx = 0) => ({ address: USDC, topics: [TRANSFER, topic(from), topic(to)], data: "0x" + BigInt(micro).toString(16).padStart(64, "0"), blockNumber: hex(block), logIndex: hex(idx) });
const A = (n) => "0x" + n.toString(16).padStart(40, "0");
const SIZE_REFUSAL = "Log response size exceeded. You can make eth_getLogs requests with up to a 2K block range and no limit on the response size, or you can request any block range with a cap of 10K logs in the response.";
const HOUR = 3_600_000, DAY = 24 * HOUR;
const NOW0 = Date.parse("2026-09-28T00:00:00Z");
const SPAN = 302_400, LATEST0 = 60_000_000, BLOCKS_PER_HOUR = 1_800, BLOCKS_PER_DAY = 43_200;
const MAX_CALLS = SF.FUNDING_DEFAULTS.maxCalls, DAY_MAX = SF.FUNDING_DEFAULTS.dayMaxCalls;

// --- the chain ---------------------------------------------------------------------
// `newPerDay`: new payers each heavy payTo gets every day (light ones: the
// seller never sent them anything). `late`: the hour a self-funded wallet L's
// payers first pay it.
function buildChain(K, days = 2, { newPerDay = 0, late = null, pays = 6 } = {}) {
  const start = LATEST0 - SPAN;
  const logs = [];
  const items = [];
  const list = (wallet, host) => items.push({ resource: `https://${host}/api/x`, accepts: [{ network: "eip155:8453", asset: USDC, payTo: wallet, amount: "10000" }] });
  // K heavy payTos: 20 dense payers x `pays` payments each a day.
  const heavy = Array.from({ length: K }, (_, n) => A(0xd00000 + n));
  const dense = new Set();
  heavy.forEach((d, n) => {
    list(d, `heavy-${n}.example`);
    for (let k = 0; k < 20; k++) dense.add(topic(A(0x510000 + n * 20 + k)));
    for (let day = 0; day < days; day++) for (let k = 0; k < 20; k++) for (let c = 0; c < pays; c++) logs.push(log(A(0x510000 + n * 20 + k), d, 10_000, LATEST0 - 4_000 + day * BLOCKS_PER_DAY + k * 6 + c, 2));
    for (let day = 0; day < days; day++) for (let i = 0; i < newPerDay; i++) {
      const p = A(0x3000000 + (n * days + day) * 16 + i);
      for (let c = 0; c < 3; c++) logs.push(log(p, d, 10_000, LATEST0 + day * BLOCKS_PER_DAY + (i + 1) * 3_000 + c, 4));
    }
  });
  // 20 light wallets, 5 payers x 12 each; the first four funded their payers
  // about 2M blocks before the window (paid with their own money: circular).
  const lights = Array.from({ length: 20 }, (_, i) => A(0x2000 + i));
  lights.forEach((w, i) => {
    list(w, `light-${i}.example`);
    for (let j = 0; j < 5; j++) {
      const p = A(0x600000 + i * 5 + j);
      if (i < 4) logs.push(log(w, p, 200_000, start - 2_000_000, j));
      for (let day = 0; day < days; day++) for (let k = 0; k < 12; k++) logs.push(log(p, w, 10_000, LATEST0 - 20_000 + day * BLOCKS_PER_DAY + k, j));
    }
  });
  // One legitimate wallet paid with its own money whose history holds a
  // dense stretch: 25,000 small transfers to one of its payers over 2M blocks
  // (the size rule refuses any read of it wider than ~800k blocks).
  const H = A(0x4e4e);
  list(H, "dense-history.example");
  for (let j = 0; j < 5; j++) {
    const p = A(0x700000 + j);
    logs.push(log(H, p, 200_000, start - 2_000_000, j));
    for (let day = 0; day < days; day++) for (let k = 0; k < 12; k++) logs.push(log(p, H, 10_000, LATEST0 - 30_000 + day * BLOCKS_PER_DAY + k, j));
  }
  for (let i = 0; i < 25_000; i++) logs.push(log(H, A(0x700000), 1000 + i, start - 5_000_000 + i * 80, i % 1000));
  // A late self-funded wallet: it funded 5 payers long before the window,
  // and they first pay it at hour `late`.
  const L = A(0x4c4c);
  if (late !== null) {
    list(L, "late.example");
    for (let j = 0; j < 5; j++) {
      const p = A(0x800000 + j);
      logs.push(log(L, p, 200_000, start - 2_000_000, j));
      for (let k = 0; k < 12; k++) logs.push(log(p, L, 10_000, LATEST0 + late * BLOCKS_PER_HOUR - 500 + k, j));
    }
  }
  return { logs, items, heavy, lights, H, L, heavySet: new Set(heavy.map(topic)), dense };
}

// Wallets with MANY new payers (each payer chunk of 200 is one planned read):
// `n` wallets x `perWallet` payers paying once in the window; the first funded
// each of its payers long before the window.
function buildManyPayers(n, perWallet) {
  const start = LATEST0 - SPAN;
  const logs = [], items = [];
  const wallets = Array.from({ length: n }, (_, i) => A(0xe000 + i));
  wallets.forEach((w, i) => {
    items.push({ resource: `https://many-${i}.example/api/x`, accepts: [{ network: "eip155:8453", asset: USDC, payTo: w, amount: "10000" }] });
    for (let j = 0; j < perWallet; j++) {
      const p = A(0x10000000 + i * perWallet + j);
      if (i === 0) logs.push(log(w, p, 20_000, start - 500_000 + (j % 5_000), 500 + Math.floor(j / 5_000)));
      logs.push(log(p, w, 10_000, start + 1_000 + i * 5_000 + (j % 5_000), 2 + Math.floor(j / 5_000)));
    }
  });
  return { logs, items, heavy: [], lights: [], H: A(0x4e4e), L: A(0x4c4c), heavySet: new Set(), dense: new Set(), wallets };
}

// --- the stub Bazaar + RPC -------------------------------------------------------------
let chain = null;
let byFrom = new Map(), byTo = new Map();
let LATEST = LATEST0;
const counter = { funding: 0, namingHeavy: 0 };
// Every funding read of one wallet's payers: its direction, wallet, payer set
// and block range (to find a chunk read twice).
const reads = [];
function index(c) {
  byFrom = new Map(); byTo = new Map();
  for (const l of c.logs) {
    const f = l.topics[1].toLowerCase(), t = l.topics[2].toLowerCase();
    if (!byFrom.has(f)) byFrom.set(f, []); byFrom.get(f).push(l);
    if (!byTo.has(t)) byTo.set(t, []); byTo.get(t).push(l);
  }
}
function getLogs(p) {
  const lo = parseInt(p.fromBlock, 16), hi = parseInt(p.toBlock, 16);
  const froms = Array.isArray(p.topics?.[1]) ? new Set(p.topics[1].map((x) => x.toLowerCase())) : null;
  const tos = Array.isArray(p.topics?.[2]) ? new Set(p.topics[2].map((x) => x.toLowerCase())) : null;
  const cand = froms ? [...froms].flatMap((a) => byFrom.get(a) || []) : tos ? [...tos].flatMap((a) => byTo.get(a) || []) : chain.logs;
  return cand.filter((l) => {
    const b = parseInt(l.blockNumber, 16);
    return b >= lo && b <= hi && (!froms || froms.has(l.topics[1].toLowerCase())) && (!tos || tos.has(l.topics[2].toLowerCase()));
  });
}
const srv = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const send = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url.startsWith("/bazaar")) return send(/offset=0/.test(req.url) ? { items: chain.items, pagination: { total: chain.items.length } } : { items: [] });
    const j = JSON.parse(body || "{}");
    if (j.method === "eth_blockNumber") return send({ jsonrpc: "2.0", id: j.id, result: hex(LATEST) });
    if (j.method !== "eth_getLogs") return send({ jsonrpc: "2.0", id: j.id, error: { code: -32601, message: "no" } });
    const p = j.params[0];
    const span = parseInt(p.toBlock, 16) - parseInt(p.fromBlock, 16) + 1;
    // A funding read names wallets or payers in topics[1]; the scan's own
    // inbound read does not, and is answered in full (it is not what this
    // test measures).
    const funding = Array.isArray(p.topics?.[1]);
    if (funding) {
      counter.funding++;
      if (Array.isArray(p.topics[2])) reads.push({ t1: p.topics[1].map((x) => x.toLowerCase()).sort().join(), t2: p.topics[2].map((x) => x.toLowerCase()).sort().join(), lo: parseInt(p.fromBlock, 16), hi: parseInt(p.toBlock, 16) });
      const named = [...p.topics[1], ...(Array.isArray(p.topics[2]) ? p.topics[2] : [])].map((t) => t.toLowerCase());
      if (named.some((t) => chain.heavySet.has(t))) counter.namingHeavy++;
      if (span > 10_000 && named.some((t) => chain.heavySet.has(t)) && named.some((t) => chain.dense.has(t))) return send({ jsonrpc: "2.0", id: j.id, error: { code: -32602, message: SIZE_REFUSAL } });
    }
    const out = getLogs(p);
    if (funding && span > 2_000 && out.length > 10_000) return send({ jsonrpc: "2.0", id: j.id, error: { code: -32602, message: SIZE_REFUSAL } });
    return send({ jsonrpc: "2.0", id: j.id, result: out });
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;

// --- one run: `hours` hourly refreshes of the real scan -------------------------------
async function run(K, { hours = 24, dayMaxCalls, walletMaxCalls, newPerDay = 0, late = null, pays, many = null } = {}) {
  chain = many || buildChain(K, Math.ceil(hours / 24) + 1, { newPerDay, late, ...(pays ? { pays } : {}) });
  reads.length = 0;
  index(chain);
  let state = SF.createFundingState(USDC);
  let prev = null;
  const rows = [];
  for (let h = 0; h < hours; h++) {
    LATEST = LATEST0 + h * BLOCKS_PER_HOUR;
    const now = NOW0 + h * HOUR;
    counter.funding = 0; counter.namingHeavy = 0;
    const snap = await LB.runLeaderboard({
      bazaarUrl: `${base}/bazaar`, rpcs: [`${base}/rpc`], spanBlocks: SPAN, chunkBlocks: SPAN + 1, now,
      fundingState: state, previousWalletEvidence: prev,
      ...(dayMaxCalls !== undefined ? { fundingDayMaxCalls: dayMaxCalls } : {}),
      ...(walletMaxCalls !== undefined ? { fundingWalletMaxCalls: walletMaxCalls } : {}),
    });
    const f = snap.routerFundingScan || {};
    const ev = snap.walletEvidence || {};
    // The volume round trip, as between refreshes in production.
    state = SF.parseFundingState(SF.serializeFundingState(state, { now }), USDC);
    prev = ev;
    const settled = (d) => ev[d]?.fundingRead === true || state.wallets.get(d)?.retryAt > now;
    rows.push({
      h, now, calls: f.calls ?? 0, stubCalls: counter.funding, namingHeavy: counter.namingHeavy, history: (f.historyCalls ?? 0) + (f.gapCalls ?? 0),
      lightsRead: chain.lights.filter((w) => ev[w]?.fundingRead === true).length,
      lightsCircular: chain.lights.filter((w) => ev[w]?.circular === true).length,
      heavySettled: chain.heavy.filter(settled).length,
      heavyGross: chain.heavy.filter((d) => ev[d]?.fundingRead === false && ev[d]?.callsSettled === ev[d]?.grossCallsSettled && ev[d]?.callsSettled > 0).length,
      H: { read: ev[chain.H]?.fundingRead === true, circular: ev[chain.H]?.circular === true },
      L: { read: ev[chain.L]?.fundingRead === true, circular: ev[chain.L]?.circular === true, net: ev[chain.L]?.callsSettled },
      retryDay: f.historyRetryCallsDay ?? null, retries: f.historyRetryCalls ?? 0, dayCap: !!f.dayCapReached, notes: LB.fundingReadNotes(f),
      many: (chain.wallets || []).map((w) => ({ read: ev[w]?.fundingRead === true, circular: ev[w]?.circular === true })),
    });
  }
  return { rows, state };
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
try {
  for (const K of [1, 12, 20, 50, 200]) {
    const { rows } = await run(K, { hours: 30 });
    const day1 = rows.slice(0, 24), next = rows.slice(24);
    const calls = day1.map((r) => r.calls);
    console.log(`# ${K} heavy payTo(s): calls per refresh ${calls.join(",")}; the next day ${next.map((r) => r.calls).join(",")}`);
    ok(rows.every((r) => r.calls === r.stubCalls), `${K} heavy: the scan's own count of its funding calls is the RPC's (${sum(rows.map((r) => r.stubCalls))} in all)`);
    ok(rows.every((r) => r.calls <= MAX_CALLS), `${K} heavy: every refresh within the scan's budget (at most ${Math.max(...rows.map((r) => r.calls))} of ${MAX_CALLS})`);
    ok(rows.every((r) => r.retryDay <= DAY_MAX), `${K} heavy: the retries of every rolling day within the day's allowance (at most ${Math.max(...rows.map((r) => r.retryDay))} of ${DAY_MAX})`);
    ok(Math.max(...rows.slice(6).map((r) => r.calls)) <= 3, `${K} heavy: the calls fall away once the heavy payTos are settled, within the first refreshes (from refresh 6 on, never over 3)`);
    // (isolating it from the light wallets packed with it, then narrowing
    // until what is left of its history needs more calls than a scan has)
    ok(sum(rows.map((r) => r.namingHeavy)) <= 12 * K && sum(next.map((r) => r.namingHeavy)) === 0, `${K} heavy: each heavy payTo costs a few calls once (${sum(rows.map((r) => r.namingHeavy))} in all, ${(sum(rows.map((r) => r.namingHeavy)) / K).toFixed(1)} each) and none the next day`);
    ok(rows[0].lightsRead === 20 && rows[0].lightsCircular === 4, `${K} heavy: every light wallet read in the first refresh (${rows[0].lightsRead} of 20), the four paid with their own money found (${rows[0].lightsCircular})`);
    ok(rows[23].heavySettled === K, `${K} heavy: at the end of the day every heavy payTo is read or waiting (${rows[23].heavySettled} of ${K})`);
    const hAt = rows.findIndex((r) => r.H.read);
    ok((K <= 50 ? hAt === 0 : hAt >= 0 && hAt <= 23) && rows[hAt]?.H.circular, `${K} heavy: the wallet with a dense stretch of history is read ${K <= 50 ? "in the first refresh" : "within the first day"} (refresh ${hAt}), and found paid with its own money (${rows[hAt]?.H.circular})`);
  }

  // HEAVY PAYTOS THAT KEEP GETTING NEW PAYERS, for eight days. Each time a
  // heavy payTo comes back from its wait, it must not buy back what it
  // learned: before, it read its new payers at the narrow width its refused
  // read had learned, and every return cost as much as the first day, or more.
  const t0 = Date.now();
  const week = await run(200, { hours: 192, newPerDay: 4, pays: 1 });
  console.log(`# (eight days in ${Date.now() - t0} ms)`);
  const perDay = Array.from({ length: 8 }, (_, d) => sum(week.rows.slice(d * 24, d * 24 + 24).map((r) => r.calls)));
  const heavyPerDay = Array.from({ length: 8 }, (_, d) => sum(week.rows.slice(d * 24, d * 24 + 24).map((r) => r.namingHeavy)));
  console.log(`# 200 heavy payTos with 4 new payers each a day: calls per day ${perDay.join(",")}; naming a heavy payTo ${heavyPerDay.join(",")}`);
  ok(perDay.slice(1).every((c, d) => c <= perDay[d]), `every day costs no more than the day before (${perDay.join(", ")})`);
  ok(heavyPerDay.slice(1).every((c) => c === 0) && Math.max(...week.rows.slice(6).map((r) => r.calls)) <= 3, `after the first day not one call names a heavy payTo, however many new payers they get, and no refresh makes more than 3 calls`);
  ok(week.rows.every((r) => r.retryDay <= DAY_MAX && r.calls === r.stubCalls), `...every rolling day's retries within the allowance, and every call counted`);

  // WALLETS WITH MANY NEW PAYERS: three wallets with 30,000 each (150 payer
  // chunks of reads apiece, 450 planned before the funded one's second read:
  // more than one scan). Each chunk keeps its own progress and planned work
  // finishes one wallet at a time, so all three are read within two scans,
  // the one that funded its payers is found paying itself, and no chunk's
  // blocks are read twice. Before, a request kept one frontier for all its
  // chunks, a finished chunk beside an untouched one kept nothing, and the
  // budget was spread over every wallet: none was ever read.
  const many = await run(0, { hours: 3, many: buildManyPayers(3, 30_000) });
  const readAt = many.rows.findIndex((r) => r.many.every((x) => x.read));
  const byChunk = new Map();
  for (const r of reads) { const k = `${r.t1}|${r.t2}`; if (!byChunk.has(k)) byChunk.set(k, []); byChunk.get(k).push([r.lo, r.hi]); }
  const twice = [...byChunk.values()].filter((rs) => rs.some(([lo, hi], i) => rs.some(([lo2, hi2], j) => j !== i && lo2 <= hi && lo <= hi2))).length;
  console.log(`# 3 wallets x 30,000 new payers: calls per refresh ${many.rows.map((r) => r.calls).join(",")}`);
  ok(readAt >= 0 && readAt <= 1 && many.rows[readAt].many[0].circular === true && many.rows[readAt].many.slice(1).every((x) => !x.circular) && many.rows.every((r) => r.calls <= MAX_CALLS),
    `three wallets with 30,000 new payers each are all read by refresh ${readAt}, and the one that funded its payers is found paying itself`);
  ok(twice === 0 && byChunk.size >= 450, `...and no payer chunk has any block read twice (${byChunk.size} chunk reads, ${twice} overlapping)`);

  // THE DAY'S ALLOWANCE binds retries, not first reads: 200 heavy payTos on a
  // day of 150 retries - the refresh that spends them says so, and no more
  // retries are made all day - while a self-funded wallet whose payers first
  // pay it at hour 5 is still read in its first scan.
  const capped = await run(200, { hours: 24, dayMaxCalls: 150, late: 5 });
  const retries = capped.rows.map((r) => r.retries);
  const capAt = capped.rows.findIndex((r) => r.dayCap);
  ok(capAt >= 0 && capAt <= 2 && /LEADERBOARD_FUNDING_DAY_MAX_CALLS/.test(capped.rows[capAt].notes) && sum(retries) === 150 && sum(retries.slice(capAt + 1)) === 0,
    `a day's allowance of 150 retries: spent by refresh ${capAt}, which says so; the whole day ${sum(retries)} (${retries.slice(0, capAt + 1).join(", ")}), none after`);
  ok(capped.rows[0].lightsRead === 20 && capped.rows[0].lightsCircular === 4, `...first reads never wait for it: every light wallet read in the first refresh (${capped.rows[0].lightsRead} of 20)`);
  const lAt = capped.rows.findIndex((r) => r.L.read);
  ok(lAt === 5 && capped.rows[5].L.circular === true && capped.rows[5].L.net === 0, `...and the wallet whose payers first pay at hour 5 is read in that refresh (refresh ${lAt}), found paid with its own money, credited nothing`);
  ok(capped.rows[23].heavyGross === 200, `...and every heavy payTo, waiting or left behind, counts as it is (${capped.rows[23].heavyGross} of 200), never netted blind`);
} finally {
  srv.close();
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
