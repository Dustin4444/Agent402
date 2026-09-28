#!/usr/bin/env node
// The seller-funding reader's calls stay bounded, and fall away, however many
// heavy payTos a scan meets (2026-09-28, after review).
//
// A payTo whose history the RPC answers only over narrow ranges (a busy
// contract's shape, or an origin that lists one) cannot have its payers'
// history read inside any reasonable budget. Before, each such wallet had a
// share of ONE scan and nothing more: with about a dozen of them the scan's
// budget ran out before any wallet reached its share, so none waited, nothing
// was kept, and the whole budget was spent again every hour.
//
// This drives the REAL runLeaderboard, refresh after refresh, against one stub
// HTTP server playing the Bazaar and a Base RPC with the provider's documented
// eth_getLogs rule (a range over 2,000 blocks is refused above 10,000 logs),
// plus a refusal of every funding read wider than 10,000 blocks that touches
// a heavy payTo. The funding state is written and read back between refreshes,
// as on the volume. For 1, 12, 20, 50 and 200 heavy payTos beside 20 light
// wallets (4 of them paid with their own money) and one legitimate wallet with
// a dense stretch of history, it asserts: every refresh within the scan's
// budget, every day within the day's; the calls falling away; every light
// wallet read in the first refresh; every heavy payTo ending read or waiting.
// Offline, nothing is spent.
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
const SPAN = 302_400, LATEST0 = 60_000_000, BLOCKS_PER_HOUR = 1_800;
const MAX_CALLS = SF.FUNDING_DEFAULTS.maxCalls, DAY_MAX = SF.FUNDING_DEFAULTS.dayMaxCalls;

// --- the chain ---------------------------------------------------------------------
function buildChain(K, days = 2) {
  const start = LATEST0 - SPAN;
  const logs = [];
  const items = [];
  const list = (wallet, host) => items.push({ resource: `https://${host}/api/x`, accepts: [{ network: "eip155:8453", asset: USDC, payTo: wallet, amount: "10000" }] });
  // K heavy payTos: 20 payers x 6 payments each inside the window.
  const heavy = Array.from({ length: K }, (_, n) => A(0xd00000 + n));
  heavy.forEach((d, n) => {
    list(d, `heavy-${n}.example`);
    for (let day = 0; day < days; day++) for (let k = 0; k < 20; k++) for (let c = 0; c < 6; c++) logs.push(log(A(0x510000 + n * 20 + k), d, 10_000, LATEST0 - 4_000 + day * 43_200 + k * 6 + c, 2));
  });
  // 20 light wallets, 5 payers x 12 each; the first four funded their payers
  // about 2M blocks before the window (paid with their own money: circular).
  const lights = Array.from({ length: 20 }, (_, i) => A(0x2000 + i));
  lights.forEach((w, i) => {
    list(w, `light-${i}.example`);
    for (let j = 0; j < 5; j++) {
      const p = A(0x600000 + i * 5 + j);
      if (i < 4) logs.push(log(w, p, 200_000, start - 2_000_000, j));
      for (let day = 0; day < days; day++) for (let k = 0; k < 12; k++) logs.push(log(p, w, 10_000, LATEST0 - 20_000 + day * 43_200 + k, j));
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
    for (let day = 0; day < days; day++) for (let k = 0; k < 12; k++) logs.push(log(p, H, 10_000, LATEST0 - 30_000 + day * 43_200 + k, j));
  }
  for (let i = 0; i < 25_000; i++) logs.push(log(H, A(0x700000), 1000 + i, start - 5_000_000 + i * 80, i % 1000));
  return { logs, items, heavy, lights, H, heavySet: new Set(heavy.map(topic)) };
}

// --- the stub Bazaar + RPC -------------------------------------------------------------
let chain = null;
let byFrom = new Map(), byTo = new Map();
let LATEST = LATEST0;
const counter = { funding: 0 };
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
      const touches = [...p.topics[1], ...(Array.isArray(p.topics[2]) ? p.topics[2] : [])].some((t) => chain.heavySet.has(t.toLowerCase()));
      if (touches && span > 10_000) return send({ jsonrpc: "2.0", id: j.id, error: { code: -32602, message: SIZE_REFUSAL } });
    }
    const out = getLogs(p);
    if (funding && span > 2_000 && out.length > 10_000) return send({ jsonrpc: "2.0", id: j.id, error: { code: -32602, message: SIZE_REFUSAL } });
    return send({ jsonrpc: "2.0", id: j.id, result: out });
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;

// --- one run: `hours` hourly refreshes of the real scan -------------------------------
async function run(K, { hours = 24, dayMaxCalls, walletMaxCalls } = {}) {
  chain = buildChain(K, Math.ceil(hours / 24) + 1);
  index(chain);
  let state = SF.createFundingState(USDC);
  let prev = null;
  const rows = [];
  for (let h = 0; h < hours; h++) {
    LATEST = LATEST0 + h * BLOCKS_PER_HOUR;
    const now = NOW0 + h * HOUR;
    counter.funding = 0;
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
    const heavyDone = chain.heavy.filter((d) => ev[d]?.fundingRead === true || state.wallets.get(d)?.retryAt > now).length;
    rows.push({
      h, now, calls: f.calls ?? 0, stubCalls: counter.funding, history: (f.historyCalls ?? 0) + (f.gapCalls ?? 0),
      lightsRead: chain.lights.filter((w) => ev[w]?.fundingRead === true).length,
      lightsCircular: chain.lights.filter((w) => ev[w]?.circular === true).length,
      heavyDone, heavyWaiting: chain.heavy.filter((d) => state.wallets.get(d)?.retryAt > now).length,
      heavyGross: chain.heavy.filter((d) => ev[d]?.fundingRead === false && ev[d]?.callsSettled === ev[d]?.grossCallsSettled && ev[d]?.callsSettled > 0).length,
      H: { read: ev[chain.H]?.fundingRead === true, circular: ev[chain.H]?.circular === true },
      day: f.historyCallsDay ?? null, cut: f.historyWalletsCutShort ?? 0, over: f.historyWalletsOverShare ?? 0, tooLarge: f.historyWalletsTooLarge ?? 0, resumed: f.historyReadsResumed ?? 0, dayCap: !!f.dayCapReached, notes: LB.fundingReadNotes(f),
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
    ok(sum(day1.map((r) => r.history)) <= DAY_MAX, `${K} heavy: the day's history and gap calls within the day's allowance (${sum(day1.map((r) => r.history))} of ${DAY_MAX})`);
    ok(sum(calls.slice(12)) < sum(calls.slice(0, 12)) && Math.max(...calls.slice(1)) <= 3, `${K} heavy: the calls fall away after the first refresh (first ${calls[0]}, then never over 3; last 12 refreshes ${sum(calls.slice(12))})`);
    ok(rows[0].lightsRead === 20 && rows[0].lightsCircular === 4, `${K} heavy: every light wallet read in the first refresh (${rows[0].lightsRead} of 20), the four paid with their own money found (${rows[0].lightsCircular})`);
    ok(rows[23].heavyDone === K, `${K} heavy: at the end of the day every heavy payTo is read or waiting (${rows[23].heavyDone} of ${K})`);
    const hAt = rows.findIndex((r) => r.H.read);
    ok(K <= 50 ? hAt === 0 : hAt >= 0 && hAt <= 24, `${K} heavy: the wallet with a dense stretch of history is read ${K <= 50 ? "in the first refresh" : "by the time the heavy ones come due again"} (refresh ${hAt}), and found paid with its own money (${rows[hAt]?.H.circular})`);
    ok(sum(next.map((r) => r.calls)) <= MAX_CALLS + next.length * 3, `${K} heavy: when they come due again the next day, one scan's budget at most (${next.map((r) => r.calls).join(",")})`);
  }
  // THE DAY'S ALLOWANCE binds on its own: 200 heavy payTos on a day of 150
  // history calls - the first refresh stops at 150 and says why, and no
  // history call is made for the rest of the day.
  const capped = await run(200, { hours: 24, dayMaxCalls: 150 });
  const hist = capped.rows.map((r) => r.history);
  ok(hist[0] === 150 && capped.rows[0].dayCap === true && /LEADERBOARD_FUNDING_DAY_MAX_CALLS/.test(capped.rows[0].notes) && sum(hist) === 150,
    `a day's allowance of 150: the first refresh makes ${hist[0]} history call(s) and says the day's are spent; the whole day ${sum(hist)}`);
  ok(capped.rows[23].heavyGross === 200, `...and every heavy payTo, waiting or left behind, counts as it is (${capped.rows[23].heavyGross} of 200), never netted blind`);
} finally {
  srv.close();
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
