// Seller-funded payments are not settlement evidence (2026-09-28).
//
// A payment into wallet W is the seller's own money coming home when W sent its
// payer the USDC that pays it: a seller can fund a fleet of fresh wallets and
// have them "buy" from it, and every one of those reads as a distinct buyer.
// Measured before building this: several sellers the router would pay drew
// most of their settled volume from wallets their own payTo had funded first.
//
// THE RULE, per (wallet W, payer P), in chain order, FIRST IN FIRST OUT:
//   - every non-zero USDC transfer W -> P adds its amount to P's "pool";
//   - every payment P -> W the leaderboard counts takes what the pool can
//     cover (up to its own amount) out of the pool: that much of the payment
//     is self-funded. A payment at least half covered does not count as a
//     settlement at all.
//   - a transfer P -> W the leaderboard does NOT count (above the per-call
//     ceiling: not a tool call, so never evidence) is P's own money going to
//     W: it first pays back the pool, and what is left is P's "credit", which
//     a later W -> P transfer spends before it adds to the pool (the refund of
//     a payment that was never counted is P's own money coming back, not the
//     seller's). A COUNTED payment earns no credit: refunding it and having it
//     spent again would count the same dollars twice.
// So a refund (W -> P after P paid) never makes the earlier payment
// self-funded, and it can cover later payments only up to its own amount; a
// seller that funds a buyer once is netted until that buyer has spent the
// money, and never after. Judged by DOLLARS: a wallet is "circular" when more
// than half of the dollars it received (of what has been read) were
// self-funded. Counting calls or payers instead would let anyone flip an
// honest seller with a few cheap calls from wallets the seller once refunded.
//
// ONLY THE PAID WALLET'S OWN OUTBOUND COUNTS. Crediting funding from "sibling"
// wallets (other wallets listed under the same host) let a third party whose
// listing lands in a seller's host group demote it with dust transfers to its
// buyers, and it added nothing against a seller who simply funds from a wallet
// that is not a payTo. Funding through an intermediary, a sibling wallet, an
// exchange withdrawal, or another chain is not caught: a documented residual.
//
// The funding facts are PERSISTED (src/leaderboard.js keeps this state on the
// volume beside the snapshot) and read INCREMENTALLY: each wallet has a cursor,
// each hourly scan reads only the blocks since it, and each (W, P) pool
// survives until it is spent. Waiting out a lookback therefore buys nothing,
// and a steady-state read is one small range per 200 wallets. A new wallet's
// first read looks back `lookbackBlocks` before the scan window.
//
// COST BOUNDS: one eth_getLogs per job, at most `maxCalls` per scan, wallets
// that clear the router's floor on gross figures read first. A refusal splits
// only the job that was refused: its wallet list first when the RPC said the
// response was too large (isolating the heavy source), else its block range;
// the narrower range never spreads to other jobs. A single wallet refused even
// over `minRangeBlocks` is read targeted at its own payers for that range and
// flagged truncated. An unreachable RPC is retried once and then stops the
// read for this scan rather than fanning out; a timed-out read is split like a
// refusal, at most three times a scan. A wallet whose pools start before the
// window has its funded payers' earlier payments read once (readFundingGaps,
// from what is left of the same budget) before its pools advance. A wallet not
// read up to the latest block is "behind": what is known still nets it, what is
// not is unknown, and a circular wallet behind is credited nothing.
export const FUNDING_DEFAULTS = {
  // Blocks before the scan window a NEW wallet's first read covers (default:
  // about 30 days of Base blocks). Only a wallet's first read uses it; after
  // that the cursor carries on from where it stopped.
  lookbackBlocks: parseInt(process.env.FUNDING_LOOKBACK_BLOCKS || "1296000", 10),
  maxCalls: parseInt(process.env.LEADERBOARD_FUNDING_MAX_CALLS || "400", 10),
  minRangeBlocks: 1000,
  walletChunk: 200,
  payerChunk: 200,
  // Recipients (pools) kept per wallet and in total. Beyond them, dust pools
  // are dropped first; a recipient that already pays the wallet is always
  // recorded; any other new funding is not, and the wallet is flagged
  // truncated.
  maxPairsPerWallet: 20_000,
  maxPairsTotal: 300_000,
  // Funded payments remembered per wallet (the window's netted payments).
  maxRecordsPerWallet: 100_000,
  // How long a wallet stays "circular" for the Bazaar's sake after the last
  // scan that found it so: the Bazaar counts a 30-day window.
  circularWindowMs: 30 * 86_400_000,
  // A wallet's state with nothing left to remember (no pool, no verdict) is
  // dropped once it has not been scanned for this long.
  walletTtlMs: 45 * 86_400_000,
  // A payer's credit (see THE RULE) with no activity for this many blocks is
  // forgotten (about 30 days of Base blocks).
  creditTtlBlocks: 1_296_000,
  // A payment is netted as a call when at least this share of it was covered.
  coveredShareToNet: 0.5,
};

export const ZERO_ADDRESS = "0x" + "0".repeat(40);
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const EVM = /^0x[0-9a-f]{40}$/;
const lower = (a) => String(a || "").toLowerCase();
const pad = (a) => "0x" + "0".repeat(24) + String(a).replace(/^0x/, "");
const addrFromTopic = (t) => (typeof t === "string" && t.length >= 42 ? ("0x" + t.slice(-40)).toLowerCase() : null);
/** A log's position on the chain, orderable: block, then log index. */
export const posOf = (block, logIndex) => Number(block) * 1_000_000 + Number(logIndex);
/** The last position inside a block. */
export const endOfBlock = (block) => posOf(block, 999_999);

/** Neither the zero address (mints and burns) nor the token contract is a
 *  seller's wallet: never a scanned payTo, never a funding source. */
export function isScannableWallet(wallet, token) {
  const w = lower(wallet);
  return EVM.test(w) && w !== ZERO_ADDRESS && w !== lower(token);
}

// --- state ---------------------------------------------------------------------

/** Empty funding state for one token. */
export function createFundingState(token) {
  return { v: 1, token: lower(token), wallets: new Map() };
}
function newWalletState(freshFrom, now) {
  // `cursor`: the last block whose outbound transfers are read (inclusive).
  // `through`: the chain position up to which each pool has been worked
  // through against the payments the scan counted.
  return { cursor: freshFrom - 1, through: posOf(freshFrom, 0) - 1, since: freshFrom, truncated: false, lastSeenAt: now, lastCircularAt: null, pairs: new Map() };
}
function newPair() { return { pool: 0, credit: 0, at: 0, recs: [], pend: [] }; }
// Below this a pool is dust (token units: $0.01 of USDC).
const DUST_UNITS = 10_000;
/** Drop the wallet's pools that hold less than DUST_UNITS, net nothing yet,
 *  and belong to no current payer. Returns how many were dropped. */
function dropDustPairs(ws, payers) {
  let n = 0;
  for (const [p, pair] of ws.pairs) {
    if (payers?.has(p) || pair.recs.length || pair.credit > 0) continue;
    const held = pair.pool + pair.pend.reduce((a, [, v]) => a + v, 0);
    if (held < DUST_UNITS) { ws.pairs.delete(p); n++; }
  }
  return n;
}
export function fundingPairCount(state) {
  let n = 0;
  for (const ws of state?.wallets?.values?.() || []) n += ws.pairs.size;
  return n;
}

/** Plain JSON for the volume. Compact: flat number lists per pair. */
export function serializeFundingState(state, { now = Date.now() } = {}) {
  const wallets = {};
  for (const [w, ws] of state.wallets) {
    const p = {};
    for (const [payer, pair] of ws.pairs) p[payer] = [pair.pool, pair.recs.flat(), pair.pend.flat(), pair.credit, pair.at];
    wallets[w] = { c: ws.cursor, t: ws.through, s: ws.since, x: ws.truncated ? 1 : 0, seen: ws.lastSeenAt, lc: ws.lastCircularAt || null, p };
  }
  return JSON.stringify({ v: 1, token: state.token, savedAt: new Date(now).toISOString(), wallets });
}
const int = (x) => (Number.isSafeInteger(x) ? x : null);
function triples(flat, n) {
  const out = [];
  if (!Array.isArray(flat) || flat.length % n) return out;
  for (let i = 0; i < flat.length; i += n) {
    const t = flat.slice(i, i + n);
    if (t.every((x) => int(x) !== null && x >= 0)) out.push(t);
  }
  return out;
}
/** Parse what serializeFundingState wrote. A state for another token, or
 *  unreadable, yields an empty state (read again from the lookback). */
export function parseFundingState(text, token) {
  const state = createFundingState(token);
  let j;
  try { j = JSON.parse(text); } catch { return state; }
  if (!j || j.v !== 1 || lower(j.token) !== state.token || typeof j.wallets !== "object" || !j.wallets) return state;
  for (const [w0, e] of Object.entries(j.wallets)) {
    const w = lower(w0);
    if (!isScannableWallet(w, token) || !e || typeof e !== "object") continue;
    if (int(e.c) === null || int(e.t) === null || int(e.s) === null) continue;
    const ws = { cursor: e.c, through: e.t, since: e.s, truncated: e.x === 1, lastSeenAt: Number(e.seen) || 0, lastCircularAt: typeof e.lc === "string" ? e.lc : null, pairs: new Map() };
    for (const [p0, v] of Object.entries(e.p || {})) {
      const p = lower(p0);
      if (!EVM.test(p) || !Array.isArray(v) || int(v[0]) === null || v[0] < 0) continue;
      ws.pairs.set(p, { pool: v[0], recs: triples(v[1], 3), pend: triples(v[2], 2), credit: int(v[3]) !== null && v[3] >= 0 ? v[3] : 0, at: int(v[4]) !== null && v[4] >= 0 ? v[4] : 0 });
    }
    state.wallets.set(w, ws);
  }
  return state;
}

/** Drop what nothing needs any more: a payer's credit idle for
 *  `creditTtlBlocks` (when nothing else is left in its pair), and a wallet not
 *  scanned for `walletTtlMs` with no pool left and no verdict inside the
 *  circular window. */
export function pruneFundingState(state, { now = Date.now(), latest = null, walletTtlMs = FUNDING_DEFAULTS.walletTtlMs, circularWindowMs = FUNDING_DEFAULTS.circularWindowMs, creditTtlBlocks = FUNDING_DEFAULTS.creditTtlBlocks } = {}) {
  let dropped = 0;
  if (Number.isFinite(latest)) {
    const cutoff = posOf(latest - creditTtlBlocks, 0);
    for (const ws of state.wallets.values()) for (const [p, pair] of ws.pairs) {
      if (pair.pool <= 0 && !pair.recs.length && !pair.pend.length && pair.at < cutoff) ws.pairs.delete(p);
    }
  }
  for (const [w, ws] of state.wallets) {
    if (now - (ws.lastSeenAt || 0) < walletTtlMs) continue;
    const verdict = ws.lastCircularAt && now - Date.parse(ws.lastCircularAt) < circularWindowMs;
    const pooled = [...ws.pairs.values()].some((p) => p.pool > 0 || p.pend.length || p.credit > 0);
    if (!verdict && !pooled) { state.wallets.delete(w); dropped++; }
  }
  return dropped;
}

// --- the incremental read --------------------------------------------------------

const TOO_MANY = /response size|more than [\d,]+ (?:results|logs)|too many (?:results|logs)|returned more than|(?:results|logs) exceed|exceed(?:s|ed)? (?:the )?(?:max(?:imum)? )?(?:[\d,]+ )?(?:results|logs)|log response|query returned/i;
const UNREACHABLE = /fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|non-JSON \(5\d\d\)/i;
const TIMEOUT = /timed? ?out|TimeoutError|ETIMEDOUT|aborted/i;
// A timed-out read may simply be too large to answer in time, so it is split
// like a refusal - but only this many times in one scan, so an RPC that hangs
// on everything costs a few timeouts, not the budget.
const MAX_TIMEOUTS_PER_READ = 3;
/** How to answer a failed read: stop (the RPC is unreachable, or keeps timing
 *  out), or split the job (refused, too large, or one slow read). */
function failureKind(msg, timeouts) {
  if (TOO_MANY.test(msg)) return "split";
  if (TIMEOUT.test(msg)) return timeouts < MAX_TIMEOUTS_PER_READ ? "split" : "stop";
  if (UNREACHABLE.test(msg)) return "unreachable";
  return "split";
}

/**
 * Read the non-zero outbound token transfers of `wallets` since each one's
 * cursor, into `state` (mutated). `wallets` is [{ wallet, payers: Set }] in
 * the order to read them (highest priority first); `payers` is only used for
 * the targeted fallback. A wallet with no state starts at `freshFrom`.
 *
 * @returns counts only: { calls, refusals, wallets, caughtUp, behind, stuck,
 *   truncated, fresh, events, budgetExhausted, transportError }
 */
export async function readSellerFunding({ rpc, token, state, wallets = [], latest, freshFrom, walletChunk = FUNDING_DEFAULTS.walletChunk, payerChunk = FUNDING_DEFAULTS.payerChunk, maxCalls = FUNDING_DEFAULTS.maxCalls, minRangeBlocks = FUNDING_DEFAULTS.minRangeBlocks, maxPairsPerWallet = FUNDING_DEFAULTS.maxPairsPerWallet, maxPairsTotal = FUNDING_DEFAULTS.maxPairsTotal, ignore = new Set(), now = Date.now(), onProgress = () => {} } = {}) {
  const tok = lower(token);
  const stats = { calls: 0, refusals: 0, wallets: 0, caughtUp: 0, behind: 0, stuck: 0, truncated: 0, fresh: 0, events: 0, budgetExhausted: false, transportError: null };
  const payersOf = new Map();
  const order = [];
  for (const e of wallets) {
    const w = lower(e?.wallet);
    if (!isScannableWallet(w, tok) || payersOf.has(w)) continue;
    let ws = state.wallets.get(w);
    if (!ws) { ws = newWalletState(Math.max(0, freshFrom), now); state.wallets.set(w, ws); stats.fresh++; }
    ws.lastSeenAt = now;
    payersOf.set(w, e.payers instanceof Set ? e.payers : new Set(e.payers || []));
    order.push(w);
  }
  stats.wallets = order.length;
  let totalPairs = fundingPairCount(state);
  const stuck = new Set();
  // Jobs by start block, keeping the priority order (in steady state every
  // wallet starts at the same block: one job per 200 wallets).
  const groups = new Map();
  for (const w of order) {
    const start = state.wallets.get(w).cursor + 1;
    if (start > latest) continue;
    if (!groups.has(start)) groups.set(start, []);
    groups.get(start).push(w);
  }
  // Each job carries its LINEAGE: the widest block range known to work for it.
  // A refusal narrows its own lineage only (the halves share it, so a sibling
  // range is pre-split without spending a call); a wallet-list split hands
  // each half a copy, and no other job's range ever narrows.
  const queue = [];
  for (const [start, ws] of groups) for (let i = 0; i < ws.length; i += walletChunk) queue.push({ froms: ws.slice(i, i + walletChunk), lo: start, hi: latest, tos: null, lineage: { limit: Infinity } });

  const record = (logs, froms, targeted) => {
    const fromSet = new Set(froms);
    for (const l of Array.isArray(logs) ? logs : []) {
      const from = addrFromTopic(l?.topics?.[1]);
      const to = addrFromTopic(l?.topics?.[2]);
      if (!from || !to || !fromSet.has(from)) continue;
      let value;
      try { value = BigInt(l.data || "0x0"); } catch { continue; }
      // Zero-value logs are free to forge (a zero transferFrom needs no
      // allowance): never funding.
      if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) continue;
      if (to === from || !isScannableWallet(to, tok) || ignore.has(to)) continue;
      const block = parseInt(l.blockNumber, 16), idx = parseInt(l.logIndex, 16);
      if (!Number.isFinite(block) || !Number.isFinite(idx)) continue;
      const ws = state.wallets.get(from);
      let pair = ws.pairs.get(to);
      if (!pair) {
        // Past a cap, a recipient that already pays this wallet is still
        // recorded (it is what the rule is for); for any other, the wallet's
        // dust pools are dropped first, so a seller spraying tiny transfers
        // cannot fill the caps and stop its real funding being recorded.
        const full = () => ws.pairs.size >= maxPairsPerWallet || totalPairs >= maxPairsTotal;
        if (full() && !payersOf.get(from)?.has(to)) {
          totalPairs -= dropDustPairs(ws, payersOf.get(from));
          if (full()) { ws.truncated = true; continue; }
        }
        pair = newPair();
        ws.pairs.set(to, pair);
        totalPairs++;
      }
      pair.pend.push([posOf(block, idx), Number(value)]);
      stats.events++;
    }
    for (const w of froms) if (targeted) state.wallets.get(w).truncated = true;
  };
  const filter = (froms, tos, lo, hi) => ({
    fromBlock: "0x" + Math.max(0, lo).toString(16),
    toBlock: "0x" + hi.toString(16),
    address: tok,
    topics: [TRANSFER, froms.map(pad), tos ? tos.map(pad) : null],
  });
  const BUDGET = Symbol("budget");
  let transportRetried = false;
  let timeouts = 0;

  while (queue.length) {
    const job = queue.shift();
    // Contiguity: a wallet reads a range only right after its cursor; one
    // whose earlier range failed this scan (stuck) sits out the rest.
    const froms = job.froms.filter((w) => !stuck.has(w) && state.wallets.get(w).cursor + 1 === job.lo);
    if (!froms.length) continue;
    if (!job.tos && job.hi - job.lo + 1 > job.lineage.limit) {
      const mid = job.lo + Math.floor((job.hi - job.lo) / 2);
      queue.unshift({ ...job, froms, hi: mid }, { ...job, froms, lo: mid + 1 });
      continue;
    }
    if (stats.calls >= maxCalls) { stats.budgetExhausted = true; break; }
    let logs = [];
    try {
      if (job.tos) {
        for (let i = 0; i < job.tos.length; i += payerChunk) {
          if (stats.calls >= maxCalls) throw BUDGET;
          stats.calls++;
          const part = await rpc("eth_getLogs", [filter(froms, job.tos.slice(i, i + payerChunk), job.lo, job.hi)]);
          if (Array.isArray(part)) logs.push(...part);
        }
      } else {
        stats.calls++;
        logs = await rpc("eth_getLogs", [filter(froms, null, job.lo, job.hi)]);
      }
    } catch (e) {
      if (e === BUDGET) { stats.budgetExhausted = true; break; }
      const msg = String(e?.message || e);
      const kind = failureKind(msg, timeouts);
      if (TIMEOUT.test(msg)) timeouts++;
      if (kind !== "split") {
        // The RPC is not answering: retry this job once, then stop the read
        // for this scan (cursors stay; the next scan carries on).
        if (kind === "unreachable" && !transportRetried) { transportRetried = true; queue.unshift({ ...job, froms }); continue; }
        stats.transportError = msg.slice(0, 160);
        onProgress(`      funding read stopped (RPC not answering): ${stats.transportError}`);
        break;
      }
      stats.refusals++;
      const span = job.hi - job.lo + 1;
      if (job.tos) {
        for (const w of froms) stuck.add(w);
        onProgress(`      funding read gave up on ${froms.length} wallet(s) at blocks ${job.lo}-${job.hi}: ${msg.slice(0, 120)}`);
        continue;
      }
      const splitFroms = () => { const mid = Math.ceil(froms.length / 2); queue.unshift({ ...job, froms: froms.slice(0, mid), lineage: { ...job.lineage } }, { ...job, froms: froms.slice(mid), lineage: { ...job.lineage } }); };
      const splitRange = () => { job.lineage.limit = Math.min(job.lineage.limit, span - 1); const mid = job.lo + Math.floor((job.hi - job.lo) / 2); queue.unshift({ ...job, froms, hi: mid }, { ...job, froms, lo: mid + 1 }); };
      if (froms.length > 1 && (TOO_MANY.test(msg) || span <= minRangeBlocks)) { splitFroms(); continue; }
      if (span > minRangeBlocks) { splitRange(); continue; }
      if (froms.length > 1) { splitFroms(); continue; }
      const payers = [...(payersOf.get(froms[0]) || [])];
      if (payers.length) { queue.unshift({ froms, lo: job.lo, hi: job.hi, tos: payers, lineage: job.lineage }); continue; }
      stuck.add(froms[0]);
      continue;
    }
    record(logs, froms, !!job.tos);
    for (const w of froms) state.wallets.get(w).cursor = job.hi;
  }
  for (const w of order) {
    const ws = state.wallets.get(w);
    if (ws.cursor >= latest) stats.caughtUp++; else stats.behind++;
    if (ws.truncated) stats.truncated++;
  }
  stats.stuck = stuck.size;
  return stats;
}

// --- the gap: what funded payers paid BEFORE the window ---------------------------
//
// The scan's inbound read covers its window only. A wallet whose pools start
// before the window (its first read looked back, or it fell behind) would have
// them inflated by every payment its payers made before the window, which that
// read never saw - and a pool only drains as the payer spends, so a payer in a
// steady two-way flow with the seller would be netted for good. So once, for
// such a wallet, the transfers its FUNDED payers sent it between its pools'
// position and the window's start are read (targeted: those payers to that
// wallet, a handful of calls) and worked through the pools in order. Until that
// read completes, the wallet's pools are not advanced (it reads as behind).
export async function readFundingGaps({ rpc, token, state, wallets = [], windowStartBlock, maxCalls = FUNDING_DEFAULTS.maxCalls, minRangeBlocks = FUNDING_DEFAULTS.minRangeBlocks, payerChunk = FUNDING_DEFAULTS.payerChunk, walletChunk = FUNDING_DEFAULTS.walletChunk, onProgress = () => {} } = {}) {
  const tok = lower(token);
  const stats = { calls: 0, wallets: 0, read: 0, failed: 0, events: 0, budgetExhausted: false, transportError: null };
  const gaps = new Map();
  // Wallets sharing a gap range (every new wallet in one scan does) are read
  // together: up to `walletChunk` wallets and `payerChunk` payers per call.
  const byRange = new Map();
  const need = new Map();
  for (const w0 of wallets) {
    const w = lower(w0);
    const ws = state.wallets.get(w);
    const n = gapNeeded(ws, windowStartBlock);
    if (!n || need.has(w)) continue;
    need.set(w, n);
    const key = `${n.from}:${n.to}`;
    if (!byRange.has(key)) byRange.set(key, []);
    byRange.get(key).push(w);
  }
  stats.wallets = need.size;
  const recipientsOf = (w) => [...state.wallets.get(w).pairs.keys()];
  const pack = (ws, lo, hi, lineage) => {
    const out = [];
    let cur = null;
    for (const w of ws) {
      const r = recipientsOf(w);
      if (r.length > payerChunk) {
        for (let i = 0; i < r.length; i += payerChunk) out.push({ ws: [w], tos: r.slice(i, i + payerChunk), lo, hi, lineage: { ...lineage } });
        continue;
      }
      if (!cur || cur.ws.length >= walletChunk || cur.tos.length + r.length > payerChunk) { cur = { ws: [], tos: [], lo, hi, lineage: { ...lineage } }; out.push(cur); }
      cur.ws.push(w); cur.tos.push(...r);
    }
    return out;
  };
  const queue = [];
  for (const [key, ws] of byRange) { const [from, to] = key.split(":").map(Number); queue.push(...pack(ws, from, to, { limit: Infinity })); }
  const ins = new Map();
  const failed = new Set();
  let transportRetried = false;
  let timeouts = 0;
  let stopped = false;
  while (queue.length) {
    const job = queue.shift();
    const live = job.ws.filter((w) => !failed.has(w));
    if (!live.length) continue;
    if (live.length < job.ws.length) { queue.unshift(...pack(live, job.lo, job.hi, job.lineage)); continue; }
    const span = job.hi - job.lo + 1;
    if (span > job.lineage.limit) { const mid = job.lo + Math.floor((job.hi - job.lo) / 2); queue.unshift({ ...job, hi: mid }, { ...job, lo: mid + 1 }); continue; }
    if (stats.calls >= maxCalls) { stats.budgetExhausted = true; queue.unshift(job); stopped = true; break; }
    stats.calls++;
    let logs;
    try {
      logs = await rpc("eth_getLogs", [{ fromBlock: "0x" + job.lo.toString(16), toBlock: "0x" + job.hi.toString(16), address: tok, topics: [TRANSFER, job.tos.map(pad), job.ws.map(pad)] }]);
    } catch (e) {
      const msg = String(e?.message || e);
      const kind = failureKind(msg, timeouts);
      if (TIMEOUT.test(msg)) timeouts++;
      if (kind !== "split") {
        if (kind === "unreachable" && !transportRetried) { transportRetried = true; queue.unshift(job); continue; }
        stats.transportError = msg.slice(0, 160); queue.unshift(job); stopped = true; break;
      }
      if (job.ws.length > 1) { const mid = Math.ceil(job.ws.length / 2); queue.unshift(...pack(job.ws.slice(0, mid), job.lo, job.hi, job.lineage), ...pack(job.ws.slice(mid), job.lo, job.hi, job.lineage)); continue; }
      if (job.tos.length > 1 && (TOO_MANY.test(msg) || span <= minRangeBlocks)) { const mid = Math.ceil(job.tos.length / 2); queue.unshift({ ...job, tos: job.tos.slice(0, mid), lineage: { ...job.lineage } }, { ...job, tos: job.tos.slice(mid), lineage: { ...job.lineage } }); continue; }
      if (span > minRangeBlocks) { job.lineage.limit = Math.min(job.lineage.limit, span - 1); const mid = job.lo + Math.floor((job.hi - job.lo) / 2); queue.unshift({ ...job, hi: mid }, { ...job, lo: mid + 1 }); continue; }
      onProgress(`      funding gap read gave up on one wallet at blocks ${job.lo}-${job.hi}: ${msg.slice(0, 120)}`);
      failed.add(job.ws[0]);
      continue;
    }
    const inJob = new Set(job.ws);
    for (const l of Array.isArray(logs) ? logs : []) {
      const from = addrFromTopic(l?.topics?.[1]);
      const to = addrFromTopic(l?.topics?.[2]);
      if (!from || !to || !inJob.has(to) || !state.wallets.get(to).pairs.has(from)) continue;
      let value;
      try { value = BigInt(l.data || "0x0"); } catch { continue; }
      if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) continue;
      const block = parseInt(l.blockNumber, 16), idx = parseInt(l.logIndex, 16);
      if (!Number.isFinite(block) || !Number.isFinite(idx)) continue;
      if (!ins.has(to)) ins.set(to, new Map());
      const m = ins.get(to);
      if (!m.has(from)) m.set(from, []);
      m.get(from).push([posOf(block, idx), Number(value)]);
      stats.events++;
    }
  }
  // Complete: every job naming the wallet answered. A wallet left in the queue
  // (budget, an unreachable RPC) or refused outright is not.
  const unfinished = new Set(queue.flatMap((j) => j.ws));
  for (const [w, n] of need) {
    if (failed.has(w) || unfinished.has(w)) { stats.failed++; continue; }
    const m = ins.get(w) || new Map();
    for (const list of m.values()) list.sort((x, y) => x[0] - y[0]);
    gaps.set(w, { toBlock: n.to, ins: m });
    stats.read++;
  }
  if (stopped && stats.transportError) onProgress(`      funding gap read stopped (RPC unreachable): ${stats.transportError}`);
  return { gaps, stats };
}
/** The block range [from, to] of payments a wallet's pools have not seen that
 *  the window's inbound read cannot supply, or null. */
function gapNeeded(ws, windowStartBlock) {
  if (!ws || !ws.pairs.size) return null;
  const from = Math.floor((ws.through + 1) / 1_000_000);
  const to = Math.min(windowStartBlock - 1, ws.cursor);
  return from <= to ? { from, to } : null;
}

// --- working the pools through the counted payments --------------------------------

function paymentsOf(v) {
  const pos = Array.isArray(v?.pos) ? v.pos : [];
  const micro = Array.isArray(v?.micro) ? v.micro : [];
  const out = [];
  const each = v?.calls ? Math.round((Number(v.usd) || 0) * 1e6 / v.calls) : 0;
  for (let i = 0; i < pos.length; i++) out.push([pos[i], Number.isFinite(micro[i]) ? micro[i] : each]);
  return out;
}

/**
 * Work every (W, P) pool through the payments the scan counted, in chain order,
 * up to `throughFor(wallet)` (the position the scan's inbound read is complete
 * through) and the wallet's cursor. Mutates `state`. Payments already worked
 * through in an earlier scan are not touched again: their result is in `recs`.
 */
export function processSellerFunding(state, byWallet, { throughFor = () => Infinity, windowStartBlock = 0, gaps = new Map(), classify = () => 1, maxRecordsPerWallet = FUNDING_DEFAULTS.maxRecordsPerWallet, maxPairsPerWallet = FUNDING_DEFAULTS.maxPairsPerWallet, maxPairsTotal = FUNDING_DEFAULTS.maxPairsTotal } = {}) {
  const rows = new Map();
  for (const row of byWallet.values()) rows.set(lower(row.wallet), row);
  const total = { n: fundingPairCount(state), max: maxPairsTotal };
  for (const [w, ws] of state.wallets) {
    // A wallet this scan did not look at has payments we have not seen: its
    // pools are not worked, only its remembered payments are trimmed below.
    const row = rows.get(w);
    const limit = Math.min(endOfBlock(ws.cursor), throughFor(w));
    // Pools that start before the window advance only once the gap before it
    // has been read (readFundingGaps): otherwise the wallet stays behind.
    const need = gapNeeded(ws, windowStartBlock);
    const gap = need ? gaps.get(w) : null;
    if (row && limit > ws.through && (!need || (gap && gap.toBlock >= need.to))) workPools(ws, row, limit, { maxPairsPerWallet, total, gapIns: gap?.ins || null, classify: (micro) => classify(w, micro) });
    trimWallet(ws, windowStartBlock, maxRecordsPerWallet);
  }
  return state;
}
function workPools(ws, row, limit, { maxPairsPerWallet = FUNDING_DEFAULTS.maxPairsPerWallet, total = { n: 0, max: Infinity }, gapIns = null, classify = () => 1 } = {}) {
  const from = ws.through;
  const inWindow = ([pos]) => pos > from && pos <= limit;
  const byPayer = new Map();
  for (const [p0, v] of row.perPayer || []) {
    const p = lower(p0);
    if (!ws.pairs.has(p)) continue; // never funded by this wallet: genuine
    const pays = paymentsOf(v).filter(inWindow);
    if (pays.length) byPayer.set(p, pays);
  }
  // Uncounted money a payer sent this wallet: its credit, kept even before
  // the wallet has sent that payer anything (a refund can come later).
  const uncounted = new Map();
  for (const [p0, v] of row.uncountedIn || []) {
    const p = lower(p0);
    const ins = paymentsOf({ ...v, calls: v.pos.length }).filter(inWindow);
    if (!ins.length) continue;
    if (!ws.pairs.has(p)) {
      if (ws.pairs.size >= maxPairsPerWallet || total.n >= total.max) continue; // credit is a courtesy to the seller; losing it only nets more
      ws.pairs.set(p, newPair());
      total.n++;
    }
    uncounted.set(p, ins);
  }
  for (const [p, pair] of ws.pairs) {
    const funds = pair.pend.filter(([pos]) => pos <= limit);
    const pays = byPayer.get(p) || [];
    const ins = uncounted.get(p) || [];
    // What this payer sent the wallet before the window, read once
    // (readFundingGaps): counted-sized payments spend the pool, anything
    // larger is payback / credit, exactly as inside the window.
    const before = (gapIns?.get(p) || []).filter(inWindow).map(([pos, m]) => [pos, classify(m) === 1 ? 1 : 2, m]);
    if (!funds.length && !pays.length && !ins.length && !before.length) continue;
    pair.pend = pair.pend.filter(([pos]) => pos > limit);
    const events = [...funds.map(([pos, a]) => [pos, 0, a]), ...pays.map(([pos, b]) => [pos, 1, b]), ...ins.map(([pos, u]) => [pos, 2, u]), ...before].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    for (const [pos, kind, amt] of events) {
      pair.at = Math.max(pair.at || 0, pos);
      if (kind === 0) {
        // The seller sends: first give back the payer's own uncounted money.
        const refund = Math.min(pair.credit || 0, amt);
        pair.credit = (pair.credit || 0) - refund;
        pair.pool += amt - refund;
      } else if (kind === 1) {
        const covered = Math.min(pair.pool, amt);
        if (covered > 0) { pair.pool -= covered; pair.recs.push([pos, covered, amt]); }
      } else {
        // Uncounted money from the payer: it pays back the pool first, the
        // rest is the payer's credit.
        const back = Math.min(pair.pool, amt);
        pair.pool -= back;
        pair.credit = (pair.credit || 0) + amt - back;
      }
    }
  }
  ws.through = limit;
}
// Keep only what a later scan's window can still contain, and forget a pair
// with nothing left in it.
function trimWallet(ws, windowStartBlock, maxRecordsPerWallet) {
  const keepFrom = posOf(windowStartBlock, 0);
  let recs = 0;
  for (const [p, pair] of ws.pairs) {
    if (pair.recs.length && pair.recs[0][0] < keepFrom) pair.recs = pair.recs.filter(([pos]) => pos >= keepFrom);
    recs += pair.recs.length;
    if (pair.pool <= 0 && !pair.recs.length && !pair.pend.length && !(pair.credit > 0)) ws.pairs.delete(p);
  }
  if (recs > maxRecordsPerWallet) {
    const cut = [...ws.pairs.values()].flatMap((pair) => pair.recs.map((r) => r[0])).sort((a, b) => a - b)[recs - maxRecordsPerWallet];
    for (const pair of ws.pairs.values()) pair.recs = pair.recs.filter(([pos]) => pos >= cut);
    ws.truncated = true;
  }
}

/**
 * The funding figures for one scanned wallet row, from its state `ws` (null
 * when the wallet has none). Payments past `ws.through` are UNKNOWN: counted
 * as they are, unless the wallet is circular, in which case a wallet not read
 * up to `latest` is credited nothing until it is (a wallet already found to
 * pay itself does not get its unread payments counted as buyers).
 *
 * `carriedAt`: the last verdict from an earlier scan (ISO string or null).
 */
export function sellerFundingFigures(row, ws, { latest, now = Date.now(), carriedAt = null, circularWindowMs = FUNDING_DEFAULTS.circularWindowMs, coveredShareToNet = FUNDING_DEFAULTS.coveredShareToNet } = {}) {
  const through = ws ? ws.through : -Infinity;
  const caughtUp = !!ws && through >= endOfBlock(latest);
  const grossCalls = row.callsSettled || 0;
  const grossBuyers = row.perPayer ? row.perPayer.size : 0;
  const grossMicro = Math.round((Number(row.totalUsd) || 0) * 1e6);
  let fundedCalls = 0, fundedMicro = 0, unknownMicro = 0, netPayers = 0;
  for (const [p0, v] of row.perPayer || []) {
    const pair = ws?.pairs.get(lower(p0));
    const covered = pair && pair.recs.length ? new Map(pair.recs.map(([pos, c]) => [pos, c])) : null;
    const pos = Array.isArray(v?.pos) ? v.pos : [];
    const micro = Array.isArray(v?.micro) ? v.micro : [];
    const each = v?.calls ? Math.round((Number(v.usd) || 0) * 1e6 / v.calls) : 0;
    // Payments with no chain position have nothing to net them against.
    let genuine = pos.length < (v?.calls || 0);
    for (let i = 0; i < pos.length; i++) {
      const b = Number.isFinite(micro[i]) ? micro[i] : each;
      if (pos[i] > through) { unknownMicro += b; genuine = true; continue; }
      const c = covered?.get(pos[i]) || 0;
      fundedMicro += c;
      if (c > 0 && c >= b * coveredShareToNet) fundedCalls++;
      else genuine = true;
    }
    if (genuine) netPayers++;
  }
  const knownMicro = Math.max(0, grossMicro - unknownMicro);
  const circularNow = knownMicro > 0 && fundedMicro * 2 > knownMicro;
  const nowIso = new Date(now).toISOString();
  const carried = typeof carriedAt === "string" && now - Date.parse(carriedAt) < circularWindowMs ? carriedAt : null;
  const lastCircularAt = circularNow ? nowIso : carried;
  // A circular wallet whose reads are behind is credited nothing until they
  // catch up: its unread payments are the ones most likely to be its own.
  const withheldUntilRead = !caughtUp && !!lastCircularAt;
  return {
    netCalls: withheldUntilRead ? 0 : Math.max(0, grossCalls - fundedCalls),
    netPayers: withheldUntilRead ? 0 : netPayers,
    grossCalls, grossBuyers,
    fundedCalls,
    fundedUsd: fundedMicro / 1e6,
    grossUsd: grossMicro / 1e6,
    unknownUsd: unknownMicro / 1e6,
    circular: circularNow,
    lastCircularAt,
    read: caughtUp,
    withheldUntilRead,
    truncated: !!ws?.truncated,
  };
}

/** The wallets whose Bazaar and chain-join figures the router disregards:
 *  circular in the last scan, or in any scan within `circularWindowMs`, and not
 *  cleared by the operator (`cleared`: anything with has(wallet)). */
export function circularWalletsFrom(walletEvidence, { now = Date.now(), circularWindowMs = FUNDING_DEFAULTS.circularWindowMs, cleared = null } = {}) {
  const out = new Set();
  if (!walletEvidence || typeof walletEvidence !== "object") return out;
  const isCleared = (w) => !!(cleared && typeof cleared.has === "function" && cleared.has(w));
  for (const [w0, e] of Object.entries(walletEvidence)) {
    const w = w0.toLowerCase();
    if (isCleared(w)) continue;
    if (e?.circular === true) { out.add(w); continue; }
    const t = typeof e?.lastCircularAt === "string" ? Date.parse(e.lastCircularAt) : NaN;
    if (Number.isFinite(t) && now - t < circularWindowMs) out.add(w);
  }
  return out;
}
