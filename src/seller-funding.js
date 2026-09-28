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
// EVERY PAYER'S WHOLE HISTORY IS READ, ONCE, THE FIRST TIME IT PAYS (2026-09-28,
// after review). The first cut read a new wallet's outbound only from a fixed
// lookback before the scan window, so a seller that funded its fleet and then
// waited longer than the lookback before the fleet bought was credited in full.
// Now each wallet keeps the set of its KNOWN payers. When a payer first shows
// up in a scan, its whole history with the wallet is read with two targeted
// filters - the wallet's transfers to it from the token's deployment up to the
// wallet's cursor, and (only when the wallet ever funded it) its transfers to
// the wallet before the scan window - and its pool is built from that before
// any of its payments are judged. Its later funding is caught by the wallet's
// incremental outbound read, which records transfers to known payers only. So
// waiting buys nothing: however long before its first purchase a payer was
// funded, that funding is read. A recipient that never pays is never recorded,
// so no amount of transfers to non-payers can fill the pool caps.
// A payer forgotten for being idle (knownTtlBlocks, with no pool left) is read
// again from the start if it pays again, and so is every payer of a wallet
// whose whole state was dropped: forgetting only costs a read.
//
// The funding facts are PERSISTED (src/leaderboard.js keeps this state on the
// volume beside the snapshot) and read INCREMENTALLY: each wallet has a cursor,
// each hourly scan reads only the blocks since it, and each (W, P) pool
// survives until it is spent.
//
// COST BOUNDS: one eth_getLogs per job, at most `maxCalls` per scan across the
// outbound read, the history reads and the gap reads, wallets that clear the
// router's floor on gross figures first. A history read packs up to 200
// wallets and 200 payers into one call; a steady-state outbound read is one
// call per 200 wallets. A refusal splits only the job that was refused: its
// wallet list first when the RPC said the response was too large (isolating the
// heavy source), then its payer list, else its block range; the narrower range
// never spreads to other jobs. An unreachable RPC is retried once and then
// stops the read for this scan rather than fanning out; a timed-out read is
// split like a refusal, at most three times a scan (one count shared by every
// pass of the scan, `newFundingReadControl`). A rate-limit answer stops the
// read for the scan (splitting would only send more requests to a provider
// that is throttling), and so does an RPC that says it LIMITS the block range
// of eth_getLogs, when the read is a whole-history one: that is a property of
// the RPC, no split of this job can fit the history under it, and the log line
// names FUNDING_HISTORY_CHUNK_BLOCKS as the setting that can.
// ONE WALLET CANNOT SPEND THE SCAN (2026-09-28, after review). A history or gap
// read is charged to every wallet in it, and the next job read is always the
// one whose wallets have spent the least so far (ties in priority order), so
// every other wallet is served before a wallet whose history keeps being
// refused gets a second turn. Each wallet may spend the calls its reads were
// planned to take (payer jobs x range chunks) plus `walletMaxCalls` more on
// splits; past that its reads stop for the scan, and a wallet stopped there, or
// refused even over the narrowest range, is not read again for
// `retryBackoffMs` (a day), persisted, instead of from the token's deployment
// every hour. Such a wallet stays behind (its payments count as they are, the
// behaviour without this reader), which the scan's counts report. A history
// that could never fit one scan's budget (a range bound so small that one job
// needs more chunks than the whole budget) is not started at all.
// A wallet whose history
// reads did not complete this scan, or whose pools start before the window and
// whose gap before it was not read (readFundingGaps), is not advanced: it is
// "behind". What is known still nets it, what is not is unknown, and a circular
// wallet behind is credited nothing.
//
// The state also keeps what the router needs to net THIRD-PARTY counts of the
// same wallet (src/evidence-binding.js): per known payer the last position it
// paid with its own money and the last it paid with the wallet's, and per day
// how many payments were netted, over the Bazaar's 30-day window.
// RESIDUAL: those counts cover 30 days and a scan window 7, and a payment is
// netted once a scan's window has seen its payer. So for the first 30 days a
// wallet is read (when this state starts, or after it was dropped), payments
// made with the wallet's money before its first read, by payers that do not
// pay it again inside a window, are not netted from a third-party count. A
// funded payer that does pay inside a window has its earlier payments read
// with its history and netted.
export const FUNDING_DEFAULTS = {
  maxCalls: parseInt(process.env.LEADERBOARD_FUNDING_MAX_CALLS || "400", 10),
  minRangeBlocks: 1000,
  // The widest block range one history read asks for. Unbounded by default:
  // a targeted read's answer is tiny whatever the range, and a refusal splits
  // it. A provider that times out on very wide ranges can be given a bound.
  historyChunkBlocks: parseInt(process.env.FUNDING_HISTORY_CHUNK_BLOCKS || "0", 10) > 0 ? parseInt(process.env.FUNDING_HISTORY_CHUNK_BLOCKS, 10) : Infinity,
  walletChunk: 200,
  payerChunk: 200,
  // Calls one wallet may spend in a scan on history and gap reads beyond the
  // ones its reads were planned to take (splits after refusals), and how long
  // a wallet whose reads went past that, or were refused over the narrowest
  // range, waits before it is read again.
  walletMaxCalls: parseInt(process.env.LEADERBOARD_FUNDING_WALLET_MAX_CALLS || "32", 10) >= 0 ? parseInt(process.env.LEADERBOARD_FUNDING_WALLET_MAX_CALLS || "32", 10) : 32,
  retryBackoffMs: 86_400_000,
  // Pools kept per wallet and in total. Only a known payer ever has one; past
  // a cap, dust pools of payers not paying this scan make way first, and a
  // wallet that still cannot record one is flagged truncated.
  maxPairsPerWallet: 20_000,
  maxPairsTotal: 300_000,
  // Known payers per wallet: past it, the idlest ones with no pool are
  // forgotten first (they are read again if they pay again).
  maxKnownPerWallet: 100_000,
  // Funded payments remembered per wallet (the window's netted payments).
  maxRecordsPerWallet: 100_000,
  // How long a wallet stays "circular" for the Bazaar's sake after the last
  // scan that found it so: the Bazaar counts a 30-day window.
  circularWindowMs: 30 * 86_400_000,
  // The same 30 days in Base blocks (2 s each): the window the netted counts
  // that third-party figures are reduced by cover.
  bazaarWindowBlocks: 1_296_000,
  // One day of Base blocks: the netted-count bucket.
  bucketBlocks: 43_200,
  // A known payer with no pool, no credit and no payment for this many blocks
  // is forgotten (45 days: longer than the 30-day count, so no payer inside it
  // is ever lost).
  knownTtlBlocks: 1_944_000,
  // A wallet's state with nothing left to remember (no pool, no verdict) is
  // dropped once it has not been scanned for this long.
  walletTtlMs: 45 * 86_400_000,
  // A payer's credit (see THE RULE) with no activity for this many blocks is
  // forgotten (about 30 days of Base blocks).
  creditTtlBlocks: 1_296_000,
  // A payment is netted as a call when at least this share of it was covered.
  coveredShareToNet: 0.5,
};

// The first block a payer's history read covers, per token: the token
// contract's deployment block (Base USDC, measured with eth_getCode). An
// unlisted token reads from block 0, which is correct and only wider.
// FUNDING_HISTORY_FROM_BLOCK overrides it.
export const TOKEN_HISTORY_FROM = Object.freeze({ "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": 2_797_221 });
export function historyFromBlockFor(token) {
  const env = parseInt(process.env.FUNDING_HISTORY_FROM_BLOCK || "", 10);
  if (Number.isSafeInteger(env) && env >= 0) return env;
  return TOKEN_HISTORY_FROM[String(token || "").toLowerCase()] ?? 0;
}

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
  return { v: 2, token: lower(token), wallets: new Map() };
}
function newWalletState(windowStartBlock, now) {
  // `cursor`: the last block whose outbound transfers to KNOWN payers are
  // read (inclusive). `through`: the chain position up to which each pool has
  // been worked through against the payments the scan counted. `known`: payer
  // -> [addedAt, lastOwnMoneyPos, lastSellerMoneyPos, preWindowEnd] (positions,
  // -1 for never; preWindowEnd is the last block before the window when it
  // became known).
  // `netted`: day bucket -> payments netted.
  // `retryAt`: a wallet whose history or gap reads went past its share of a
  // scan waits until then (ms) before they are tried again.
  const s = Math.max(0, windowStartBlock);
  return { cursor: s - 1, through: posOf(s, 0) - 1, since: s, truncated: false, lastSeenAt: now, lastCircularAt: null, retryAt: 0, pairs: new Map(), known: new Map(), netted: new Map() };
}
// `h`: 1 once the payer's transfers to the wallet before it became known are
// accounted for (its credit); a pool is never worked without it.
function newPair(h = 0) { return { pool: 0, credit: 0, at: 0, recs: [], pend: [], h }; }
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
export function fundingKnownCount(state) {
  let n = 0;
  for (const ws of state?.wallets?.values?.() || []) n += ws.known.size;
  return n;
}

/** Plain JSON for the volume. Compact: flat number lists per pair. */
export function serializeFundingState(state, { now = Date.now() } = {}) {
  const wallets = {};
  for (const [w, ws] of state.wallets) {
    const p = {}, k = {}, b = {};
    for (const [payer, pair] of ws.pairs) p[payer] = [pair.pool, pair.recs.flat(), pair.pend.flat(), pair.credit, pair.at, pair.h ? 1 : 0];
    for (const [payer, e] of ws.known) k[payer] = e;
    for (const [day, n] of ws.netted) b[day] = n;
    wallets[w] = { c: ws.cursor, t: ws.through, s: ws.since, x: ws.truncated ? 1 : 0, seen: ws.lastSeenAt, lc: ws.lastCircularAt || null, ...(ws.retryAt > 0 ? { ra: ws.retryAt } : {}), p, k, b };
  }
  return JSON.stringify({ v: 2, token: state.token, savedAt: new Date(now).toISOString(), wallets });
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
/** Parse what serializeFundingState wrote. A state for another token, of
 *  another version, or unreadable, yields an empty state (every payer is read
 *  from its history again). */
export function parseFundingState(text, token) {
  const state = createFundingState(token);
  let j;
  try { j = JSON.parse(text); } catch { return state; }
  if (!j || j.v !== 2 || lower(j.token) !== state.token || typeof j.wallets !== "object" || !j.wallets) return state;
  for (const [w0, e] of Object.entries(j.wallets)) {
    const w = lower(w0);
    if (!isScannableWallet(w, token) || !e || typeof e !== "object") continue;
    if (int(e.c) === null || int(e.t) === null || int(e.s) === null) continue;
    const ws = { cursor: e.c, through: e.t, since: e.s, truncated: e.x === 1, lastSeenAt: Number(e.seen) || 0, lastCircularAt: typeof e.lc === "string" ? e.lc : null, retryAt: int(e.ra) !== null && e.ra > 0 ? e.ra : 0, pairs: new Map(), known: new Map(), netted: new Map() };
    for (const [p0, v] of Object.entries(e.k || {})) {
      const p = lower(p0);
      if (EVM.test(p) && Array.isArray(v) && v.length === 4 && v.every((x) => int(x) !== null && x >= -1)) ws.known.set(p, v.slice());
    }
    for (const [p0, v] of Object.entries(e.p || {})) {
      const p = lower(p0);
      if (!EVM.test(p) || !Array.isArray(v) || int(v[0]) === null || v[0] < 0) continue;
      ws.pairs.set(p, { pool: v[0], recs: triples(v[1], 3), pend: triples(v[2], 2), credit: int(v[3]) !== null && v[3] >= 0 ? v[3] : 0, at: int(v[4]) !== null && v[4] >= 0 ? v[4] : 0, h: v[5] === 1 ? 1 : 0 });
      // A pool always belongs to a known payer.
      if (!ws.known.has(p)) ws.known.set(p, [0, -1, -1, -1]);
    }
    for (const [d, n] of Object.entries(e.b || {})) if (int(Number(d)) !== null && int(n) !== null && n > 0) ws.netted.set(Number(d), n);
    state.wallets.set(w, ws);
  }
  return state;
}

/** Drop what nothing needs any more: a payer's credit idle for
 *  `creditTtlBlocks` (when nothing else is left in its pair), a known payer
 *  with no pool idle for `knownTtlBlocks`, netted-count days older than the
 *  30-day window, and a wallet not scanned for `walletTtlMs` with no pool left
 *  and no verdict inside the circular window. */
export function pruneFundingState(state, { now = Date.now(), latest = null, walletTtlMs = FUNDING_DEFAULTS.walletTtlMs, circularWindowMs = FUNDING_DEFAULTS.circularWindowMs, creditTtlBlocks = FUNDING_DEFAULTS.creditTtlBlocks, knownTtlBlocks = FUNDING_DEFAULTS.knownTtlBlocks, bazaarWindowBlocks = FUNDING_DEFAULTS.bazaarWindowBlocks, bucketBlocks = FUNDING_DEFAULTS.bucketBlocks } = {}) {
  let dropped = 0;
  if (Number.isFinite(latest)) {
    const cutoff = posOf(latest - creditTtlBlocks, 0);
    const knownCut = posOf(latest - knownTtlBlocks, 0);
    const dayCut = Math.floor((latest - bazaarWindowBlocks) / bucketBlocks) - 1;
    for (const ws of state.wallets.values()) {
      for (const [p, pair] of ws.pairs) {
        if (pair.pool <= 0 && !pair.recs.length && !pair.pend.length && pair.at < cutoff) ws.pairs.delete(p);
      }
      for (const [p, k] of ws.known) if (!ws.pairs.has(p) && Math.max(k[0], k[1], k[2]) < knownCut) ws.known.delete(p);
      for (const d of ws.netted.keys()) if (d < dayCut) ws.netted.delete(d);
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
// The provider is throttling us: more requests only make it worse.
const RATE_LIMITED = /"code":\s*429\b|\b429\b|rate[- ]?limit|too many requests|compute units per second|exceeded (?:its|your) (?:compute|request|throughput)/i;
// The provider limits the block RANGE of eth_getLogs, whatever the answer's
// size ("eth_getLogs is limited to a 2,000 range", "block range too large",
// "exceeds the maximum block range"). Checked after TOO_MANY: a size refusal
// that also names a range it would accept is about THIS job, not the RPC.
const RANGE_LIMITED = /limited to a [\d,]+(?: block)? range|block range (?:is )?too (?:large|wide|big)|range (?:is )?too (?:large|wide)|exceed(?:s|ed)? (?:the )?max(?:imum)? (?:block )?range|max(?:imum)? block range|maximum is set to|too many blocks|up to a [\d,.]+k? block range/i;
/** The range limit a RANGE_LIMITED answer states, or null. */
function statedRangeLimit(msg) {
  const m = /limited to a ([\d,]+)|max(?:imum)?(?: block)? range(?: is| of)?:? ([\d,]+)|maximum is set to ([\d,]+)/i.exec(msg);
  const n = m ? parseInt(String(m[1] || m[2] || m[3]).replace(/,/g, ""), 10) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
// A timed-out read may simply be too large to answer in time, so it is split
// like a refusal - but only this many times in one scan (shared by every pass,
// see newFundingReadControl), so an RPC that hangs on everything costs a few
// timeouts, not the budget.
const MAX_TIMEOUTS_PER_READ = 3;
/** How to answer a failed read: split the job (refused, too large, or one
 *  slow read), stop the read for the scan ("stop": keeps timing out; "rate":
 *  throttled), retry once then stop ("unreachable"), or "range" (the RPC
 *  limits the block range: narrow it, or stop a whole-history read). */
function failureKind(msg, timeouts) {
  if (TOO_MANY.test(msg)) return "split";
  if (RATE_LIMITED.test(msg)) return "rate";
  if (RANGE_LIMITED.test(msg)) return "range";
  if (TIMEOUT.test(msg)) return timeouts < MAX_TIMEOUTS_PER_READ ? "split" : "stop";
  if (UNREACHABLE.test(msg)) return "unreachable";
  return "split";
}
/**
 * What the reads of ONE scan share: the timeouts and the transport retry are
 * counted once for the scan (not once per pass), a reason the read stopped
 * ends every later pass without a call, and each wallet's calls (`spent`) and
 * planned calls (`allow`) on history and gap reads are kept across passes, so
 * its share of the scan is one share. runLeaderboard makes one per scan.
 */
export function newFundingReadControl() {
  return { timeouts: 0, transportRetried: false, stop: null, spent: new Map(), allow: new Map() };
}
/** A transfer log's value in token units, or null (zero, unreadable, or past
 *  the safe-integer range). Zero-value logs are free to forge (a zero
 *  transferFrom needs no allowance): never funding, never a payment. */
function valueOf(l) {
  let v;
  try { v = BigInt(l?.data || "0x0"); } catch { return null; }
  return v > 0n && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : null;
}
function posOfLog(l) {
  const block = parseInt(l?.blockNumber, 16), idx = parseInt(l?.logIndex, 16);
  return Number.isFinite(block) && Number.isFinite(idx) ? posOf(block, idx) : null;
}

/**
 * Read the non-zero transfers each wallet sent its KNOWN payers since its
 * cursor, into `state` (mutated). `wallets` is [{ wallet, payers: Set }] in
 * the order to read them (highest priority first); `payers` are this scan's
 * payers (their dust pools are never dropped to make room). A wallet with no
 * state starts at the window; a wallet with no known payer has nothing to read
 * and its cursor moves to `latest` (its payers' history is read by
 * readPayerHistory, which then covers up to that cursor).
 *
 * @returns counts only: { calls, refusals, wallets, caughtUp, behind, stuck,
 *   truncated, fresh, events, budgetExhausted, transportError }
 */
export async function readSellerFunding({ rpc, token, state, wallets = [], latest, windowStartBlock, walletChunk = FUNDING_DEFAULTS.walletChunk, payerChunk = FUNDING_DEFAULTS.payerChunk, maxCalls = FUNDING_DEFAULTS.maxCalls, minRangeBlocks = FUNDING_DEFAULTS.minRangeBlocks, maxPairsPerWallet = FUNDING_DEFAULTS.maxPairsPerWallet, maxPairsTotal = FUNDING_DEFAULTS.maxPairsTotal, ignore = new Set(), now = Date.now(), onProgress = () => {}, ctl = newFundingReadControl() } = {}) {
  const tok = lower(token);
  const stats = { calls: 0, refusals: 0, wallets: 0, caughtUp: 0, behind: 0, stuck: 0, truncated: 0, fresh: 0, events: 0, budgetExhausted: false, transportError: null };
  const payersOf = new Map();
  const order = [];
  for (const e of wallets) {
    const w = lower(e?.wallet);
    if (!isScannableWallet(w, tok) || payersOf.has(w)) continue;
    let ws = state.wallets.get(w);
    if (!ws) { ws = newWalletState(windowStartBlock, now); state.wallets.set(w, ws); stats.fresh++; }
    ws.lastSeenAt = now;
    payersOf.set(w, e.payers instanceof Set ? new Set([...e.payers].map(lower)) : new Set((e.payers || []).map(lower)));
    order.push(w);
  }
  stats.wallets = order.length;
  let totalPairs = fundingPairCount(state);
  const stuck = new Set();
  // Jobs by start block, keeping the priority order (in steady state every
  // wallet starts at the same block: one job per 200 wallets).
  const groups = new Map();
  for (const w of order) {
    const ws = state.wallets.get(w);
    // Nothing is recorded for a wallet with no known payer: no read needed.
    if (!ws.known.size) { ws.cursor = Math.max(ws.cursor, latest); continue; }
    const start = ws.cursor + 1;
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

  const record = (logs, froms) => {
    const fromSet = new Set(froms);
    for (const l of Array.isArray(logs) ? logs : []) {
      const from = addrFromTopic(l?.topics?.[1]);
      const to = addrFromTopic(l?.topics?.[2]);
      if (!from || !to || !fromSet.has(from)) continue;
      const value = valueOf(l);
      if (value === null) continue;
      if (to === from || !isScannableWallet(to, tok) || ignore.has(to)) continue;
      const ws = state.wallets.get(from);
      // Only a KNOWN payer's funding is recorded: a recipient that has never
      // paid has its whole history read if it ever does (readPayerHistory).
      if (!ws.known.has(to)) continue;
      const pos = posOfLog(l);
      if (pos === null) continue;
      let pair = ws.pairs.get(to);
      if (!pair) {
        // Past a cap, a payer paying this scan is still recorded (it is what
        // the rule is for); for any other, dust pools make way first.
        const full = () => ws.pairs.size >= maxPairsPerWallet || totalPairs >= maxPairsTotal;
        if (full() && !payersOf.get(from)?.has(to)) {
          totalPairs -= dropDustPairs(ws, payersOf.get(from));
          if (full()) { ws.truncated = true; continue; }
        }
        pair = newPair(0);
        ws.pairs.set(to, pair);
        totalPairs++;
      }
      pair.pend.push([pos, value]);
      stats.events++;
    }
  };
  const filter = (froms, tos, lo, hi) => ({
    fromBlock: "0x" + Math.max(0, lo).toString(16),
    toBlock: "0x" + hi.toString(16),
    address: tok,
    topics: [TRANSFER, froms.map(pad), tos ? tos.map(pad) : null],
  });
  const BUDGET = Symbol("budget");

  while (queue.length && !ctl.stop) {
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
      // A range limit is answered here by narrowing the range: the ranges
      // this read asks for are the blocks since each cursor, not a history.
      const kind0 = failureKind(msg, ctl.timeouts);
      const kind = kind0 === "range" ? "split" : kind0;
      if (TIMEOUT.test(msg)) ctl.timeouts++;
      if (kind !== "split") {
        // The RPC is not answering, or is throttling us: retry an unreachable
        // one once, then stop the read for this scan (cursors stay; the next
        // scan carries on).
        if (kind === "unreachable" && !ctl.transportRetried) { ctl.transportRetried = true; queue.unshift({ ...job, froms }); continue; }
        ctl.stop = kind === "rate" ? "rate-limited" : kind === "stop" ? "timeouts" : "unreachable";
        stats.transportError = msg.slice(0, 160);
        onProgress(`      funding read stopped (${ctl.stop}): ${stats.transportError}`);
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
      // One wallet no untargeted read can serve: read it targeted at its
      // known payers, which is exactly what is recorded anyway (complete).
      const known = [...state.wallets.get(froms[0]).known.keys()];
      if (known.length) { queue.unshift({ froms, lo: job.lo, hi: job.hi, tos: known, lineage: job.lineage }); continue; }
      stuck.add(froms[0]);
      continue;
    }
    record(logs, froms);
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

// --- a payer's whole history, read once ---------------------------------------------
//
// Targeted reads of the transfers between one wallet and a set of its payers
// over one block range: `dir` "out" is wallet -> payer (topics [T, wallets,
// payers]), "in" is payer -> wallet. Requests with the same range are packed
// up to `walletChunk` wallets and `payerChunk` payers per call. Returns the
// logs per (wallet, payer), deduplicated by position, and the wallets whose
// requests did not all complete: of those, `overShare` spent their share of the
// scan, `gaveUp` were refused over the narrowest range, and `tooLarge` needed
// more range chunks than the whole scan's budget (see ONE WALLET CANNOT SPEND
// THE SCAN above; `ctl` is the scan's newFundingReadControl).
//
// `stopOnRangeLimit`: a whole-history read stops for the scan when the RPC
// says it limits the block range (no split fits a history under it); a gap
// read narrows its range instead.
/** How many calls the halving takes to bring `span` blocks under `limit`,
 *  capped at `cap` (the exact count: halves differ by at most one block). */
export function rangePieces(span, limit, cap = Infinity) {
  if (!(span > 0)) return 0;
  if (!(limit > 0)) return Infinity;
  const memo = new Map();
  const count = (n) => {
    if (n <= limit) return 1;
    if (memo.has(n)) return memo.get(n);
    const left = Math.floor((n - 1) / 2) + 1;
    const c = Math.min(cap, count(left) + count(n - left));
    memo.set(n, c);
    return c;
  };
  return count(span);
}
async function readPairs({ rpc, token, requests, dir, budget, walletChunk, payerChunk, minRangeBlocks, onProgress, stats, maxSpanBlocks = Infinity, walletMaxCalls = FUNDING_DEFAULTS.walletMaxCalls, scanMaxCalls = budget.max, ctl = newFundingReadControl(), stopOnRangeLimit = false }) {
  const tok = lower(token);
  const out = new Map();
  const failed = new Set(), overShare = new Set(), gaveUp = new Set(), tooLarge = new Set();
  const spentOf = (w) => ctl.spent.get(w) || 0;
  // A wallet's overrun: calls spent beyond the ones its reads were planned to
  // take. The next job read is one whose wallets have overrun least.
  const overrunOf = (w) => Math.max(0, spentOf(w) - (ctl.allow.get(w) || 0));
  const byRange = new Map();
  for (const [w, r] of requests) {
    if (!(r.hi >= r.lo) || !r.payers.length) continue;
    const pieces = rangePieces(r.hi - r.lo + 1, maxSpanBlocks, scanMaxCalls + 1);
    if (pieces > scanMaxCalls) { tooLarge.add(w); continue; }
    ctl.allow.set(w, (ctl.allow.get(w) || 0) + pieces * Math.max(1, Math.ceil(r.payers.length / payerChunk)));
    const key = `${r.lo}:${r.hi}`;
    if (!byRange.has(key)) byRange.set(key, []);
    byRange.get(key).push(w);
  }
  if (tooLarge.size) onProgress(`      ${tooLarge.size} wallet(s) not read: one history needs more range chunks than a scan's budget (raise FUNDING_HISTORY_CHUNK_BLOCKS)`);
  const payersOf = (w) => requests.get(w).payers;
  const pack = (ws, lo, hi, lineage) => {
    const jobs = [];
    let cur = null;
    for (const w of ws) {
      const r = payersOf(w);
      if (r.length > payerChunk) {
        for (let i = 0; i < r.length; i += payerChunk) jobs.push({ ws: [w], tos: r.slice(i, i + payerChunk), lo, hi, lineage: { ...lineage } });
        continue;
      }
      if (!cur || cur.ws.length >= walletChunk || cur.tos.length + r.length > payerChunk) { cur = { ws: [], tos: [], lo, hi, lineage: { ...lineage } }; jobs.push(cur); }
      cur.ws.push(w); cur.tos.push(...r);
    }
    return jobs;
  };
  const queue = [];
  const stoppedBefore = !!ctl.stop;
  if (!stoppedBefore) for (const [key, ws] of byRange) { const [lo, hi] = key.split(":").map(Number); queue.push(...pack(ws, lo, hi, { limit: maxSpanBlocks })); }
  const wanted = new Map([...requests].map(([w, r]) => [w, new Set(r.payers)]));
  const seen = new Map();
  // The job whose wallets have overrun least; ties go to the front of the
  // queue (priority order, and a job's own pieces depth first).
  const pick = () => {
    let bi = 0, bk = Infinity;
    for (let i = 0; i < queue.length && bk > 0; i++) {
      let k = 0;
      for (const w of queue[i].ws) { const o = overrunOf(w); if (o > k) k = o; }
      if (k < bk) { bk = k; bi = i; }
    }
    return queue.splice(bi, 1)[0];
  };
  while (queue.length) {
    const job = pick();
    // A wallet past its share of the scan stops here, for this scan.
    for (const w of job.ws) if (!failed.has(w) && overrunOf(w) >= walletMaxCalls) { failed.add(w); overShare.add(w); }
    const live = job.ws.filter((w) => !failed.has(w));
    if (!live.length) continue;
    if (live.length < job.ws.length) { queue.unshift(...pack(live, job.lo, job.hi, job.lineage)); continue; }
    const span = job.hi - job.lo + 1;
    if (span > job.lineage.limit) { const mid = job.lo + Math.floor((job.hi - job.lo) / 2); queue.unshift({ ...job, hi: mid }, { ...job, lo: mid + 1 }); continue; }
    if (budget.calls >= budget.max) { stats.budgetExhausted = true; queue.unshift(job); break; }
    budget.calls++; stats.calls++;
    for (const w of job.ws) ctl.spent.set(w, spentOf(w) + 1);
    let logs;
    try {
      const walletTopics = job.ws.map(pad), payerTopics = job.tos.map(pad);
      logs = await rpc("eth_getLogs", [{ fromBlock: "0x" + job.lo.toString(16), toBlock: "0x" + job.hi.toString(16), address: tok, topics: dir === "out" ? [TRANSFER, walletTopics, payerTopics] : [TRANSFER, payerTopics, walletTopics] }]);
    } catch (e) {
      const msg = String(e?.message || e);
      const kind = failureKind(msg, ctl.timeouts);
      if (TIMEOUT.test(msg)) ctl.timeouts++;
      if (kind === "range" && !stopOnRangeLimit && span > minRangeBlocks) {
        // A gap read under a range limit: narrow this job's range to it.
        stats.refusals++;
        job.lineage.limit = Math.min(job.lineage.limit, span - 1, statedRangeLimit(msg) ?? Infinity);
        const mid = job.lo + Math.floor((job.hi - job.lo) / 2);
        queue.unshift({ ...job, hi: mid }, { ...job, lo: mid + 1 });
        continue;
      }
      if (kind !== "split") {
        if (kind === "unreachable" && !ctl.transportRetried) { ctl.transportRetried = true; queue.unshift(job); continue; }
        ctl.stop = kind === "range" ? "range-limited" : kind === "rate" ? "rate-limited" : kind === "stop" ? "timeouts" : "unreachable";
        stats.transportError = msg.slice(0, 160); queue.unshift(job); break;
      }
      stats.refusals++;
      if (job.ws.length > 1) { const mid = Math.ceil(job.ws.length / 2); queue.unshift(...pack(job.ws.slice(0, mid), job.lo, job.hi, job.lineage), ...pack(job.ws.slice(mid), job.lo, job.hi, job.lineage)); continue; }
      if (job.tos.length > 1 && (TOO_MANY.test(msg) || span <= minRangeBlocks)) { const mid = Math.ceil(job.tos.length / 2); queue.unshift({ ...job, tos: job.tos.slice(0, mid), lineage: { ...job.lineage } }, { ...job, tos: job.tos.slice(mid), lineage: { ...job.lineage } }); continue; }
      if (span > minRangeBlocks) { job.lineage.limit = Math.min(job.lineage.limit, span - 1); const mid = job.lo + Math.floor((job.hi - job.lo) / 2); queue.unshift({ ...job, hi: mid }, { ...job, lo: mid + 1 }); continue; }
      onProgress(`      payer history read gave up on one wallet at blocks ${job.lo}-${job.hi}: ${msg.slice(0, 120)}`);
      failed.add(job.ws[0]); gaveUp.add(job.ws[0]);
      continue;
    }
    const inJob = new Set(job.ws);
    for (const l of Array.isArray(logs) ? logs : []) {
      const a = addrFromTopic(l?.topics?.[1]), b = addrFromTopic(l?.topics?.[2]);
      const w = dir === "out" ? a : b, p = dir === "out" ? b : a;
      if (!w || !p || !inJob.has(w) || !wanted.get(w)?.has(p)) continue;
      const value = valueOf(l), pos = posOfLog(l);
      if (value === null || pos === null || pos < posOf(job.lo, 0) || pos > endOfBlock(job.hi)) continue;
      const key = `${w}:${p}:${pos}`;
      if (seen.has(key)) continue;
      seen.set(key, true);
      if (!out.has(w)) out.set(w, new Map());
      const m = out.get(w);
      if (!m.has(p)) m.set(p, []);
      m.get(p).push([pos, value]);
      stats.events++;
    }
  }
  if (overShare.size) onProgress(`      ${overShare.size} wallet(s) spent their share of this scan's reads; each is tried again in a day`);
  const unfinished = new Set(queue.flatMap((j) => j.ws));
  // Nothing is read once an earlier pass of the scan stopped it.
  if (stoppedBefore) for (const ws of byRange.values()) for (const w of ws) unfinished.add(w);
  for (const m of out.values()) for (const list of m.values()) list.sort((x, y) => x[0] - y[0]);
  return { logs: out, incomplete: new Set([...failed, ...unfinished, ...tooLarge]), overShare, gaveUp, tooLarge };
}

/**
 * The whole history, with each wallet, of every payer it has not seen before,
 * read once (see EVERY PAYER'S WHOLE HISTORY above), plus the credit of a known
 * payer whose pool is about to receive its first funding:
 *   1. the wallet's transfers to its NEW payers, from `historyFromBlock` up to
 *      its cursor (after readSellerFunding, so the two reads meet exactly);
 *   2. for the new payers it ever funded, their transfers to it before the
 *      window (the window's own payments come from the scan);
 *   3. for a known payer whose first funding is pending, its transfers to the
 *      wallet before it became known (its credit: money of its own the
 *      funding may be returning).
 * `wallets` is [{ wallet, payers }] in priority order, `payers` this scan's.
 *
 * @returns { histories: Map(wallet -> { upTo, covered: Set, funds, ins, credits }),
 *   stats } - a wallet appears only when every read it needed completed.
 */
export async function readPayerHistory({ rpc, token, state, wallets = [], windowStartBlock, historyFromBlock = historyFromBlockFor(token), historyChunkBlocks = FUNDING_DEFAULTS.historyChunkBlocks, walletChunk = FUNDING_DEFAULTS.walletChunk, payerChunk = FUNDING_DEFAULTS.payerChunk, maxCalls = FUNDING_DEFAULTS.maxCalls, minRangeBlocks = FUNDING_DEFAULTS.minRangeBlocks, walletMaxCalls = FUNDING_DEFAULTS.walletMaxCalls, retryBackoffMs = FUNDING_DEFAULTS.retryBackoffMs, scanMaxCalls = maxCalls, now = Date.now(), ctl = newFundingReadControl(), onProgress = () => {} } = {}) {
  const tok = lower(token);
  // overShare / gaveUp / tooLarge: wallets whose reads stopped for the reasons
  // readPairs names; waiting: wallets not read this scan because an earlier
  // one stopped them (their `retryAt` is still ahead).
  const stats = { calls: 0, refusals: 0, wallets: 0, payers: 0, funded: 0, creditReads: 0, read: 0, failed: 0, overShare: 0, gaveUp: 0, tooLarge: 0, waiting: 0, events: 0, budgetExhausted: false, transportError: null, stopped: null };
  const budget = { calls: 0, max: Math.max(0, maxCalls) };
  const from = Math.max(0, historyFromBlock);
  const fresh = new Map(); // wallet -> new payers
  const credit = new Map(); // wallet -> [{ payer, hi }]
  for (const e of wallets) {
    const w = lower(e?.wallet);
    const ws = state.wallets.get(w);
    if (!ws || fresh.has(w) || credit.has(w)) continue;
    const ps = [...new Set([...(e.payers || [])].map(lower))].filter((p) => EVM.test(p) && p !== w && isScannableWallet(p, tok) && !ws.known.has(p));
    const cr = [];
    for (const [p, pair] of ws.pairs) if (!pair.h && pair.pend.length) cr.push({ payer: p, hi: ws.known.get(p)?.[3] ?? -1 });
    // A wallet whose reads went past its share of a scan, or were refused over
    // the narrowest range, waits a day: it stays behind, read nothing.
    if ((ps.length || cr.length) && ws.retryAt > now) { stats.waiting++; continue; }
    if (ps.length) fresh.set(w, ps);
    if (cr.length) credit.set(w, cr);
  }
  stats.wallets = new Set([...fresh.keys(), ...credit.keys()]).size;
  for (const ps of fresh.values()) stats.payers += ps.length;
  // 1. The wallet's transfers to its new payers, over their whole history.
  const reqA = new Map();
  for (const [w, ps] of fresh) reqA.set(w, { payers: ps, lo: from, hi: state.wallets.get(w).cursor });
  const share = { walletMaxCalls, scanMaxCalls, ctl, stopOnRangeLimit: true };
  const a = await readPairs({ rpc, token: tok, requests: reqA, dir: "out", budget, walletChunk, payerChunk, minRangeBlocks, onProgress, stats, maxSpanBlocks: historyChunkBlocks, ...share });
  const overShare = new Set(a.overShare), gaveUp = new Set(a.gaveUp), tooLarge = new Set(a.tooLarge);
  // 2 and 3: transfers TO the wallet, before the window (new funded payers),
  // or before the payer became known (credit). One request per wallet and
  // range, so a wallet may carry two.
  const reqB = new Map();
  const add = (w, p, hi, tag) => { const key = `${w}|${hi}`; if (!reqB.has(key)) reqB.set(key, { w, payers: [], lo: from, hi, tag }); reqB.get(key).payers.push(p); };
  for (const [w, ps] of fresh) {
    if (a.incomplete.has(w)) continue;
    for (const p of ps) if (a.logs.get(w)?.get(p)?.length) { stats.funded++; add(w, p, windowStartBlock - 1, "fresh"); }
  }
  for (const [w, list] of credit) for (const { payer, hi } of list) { stats.creditReads++; add(w, payer, hi, "credit"); }
  // readPairs keys its requests by wallet: run one pass per (wallet, range)
  // group so a wallet with both kinds is read over each range.
  const reqByRange = new Map();
  for (const r of reqB.values()) {
    const key = `${r.lo}:${r.hi}`;
    if (!reqByRange.has(key)) reqByRange.set(key, new Map());
    reqByRange.get(key).set(r.w, { payers: r.payers, lo: r.lo, hi: r.hi });
  }
  const insByWallet = new Map(); // w -> Map(p -> [[pos, amt]])
  const incompleteB = new Set();
  for (const reqs of reqByRange.values()) {
    const b = await readPairs({ rpc, token: tok, requests: reqs, dir: "in", budget, walletChunk, payerChunk, minRangeBlocks, onProgress, stats, maxSpanBlocks: historyChunkBlocks, ...share });
    for (const w of b.incomplete) incompleteB.add(w);
    for (const w of b.overShare) overShare.add(w);
    for (const w of b.gaveUp) gaveUp.add(w);
    for (const w of b.tooLarge) tooLarge.add(w);
    for (const [w, m] of b.logs) {
      if (!insByWallet.has(w)) insByWallet.set(w, new Map());
      for (const [p, list] of m) insByWallet.get(w).set(p, list);
    }
  }
  const histories = new Map();
  for (const w of new Set([...fresh.keys(), ...credit.keys()])) {
    if (a.incomplete.has(w) || incompleteB.has(w)) { stats.failed++; continue; }
    const ins = insByWallet.get(w) || new Map();
    const creditPayers = new Set((credit.get(w) || []).map((x) => x.payer));
    const freshIns = new Map(), credits = new Map();
    for (const [p, list] of ins) (creditPayers.has(p) && !(fresh.get(w) || []).includes(p) ? credits : freshIns).set(p, list);
    for (const p of creditPayers) if (!credits.has(p)) credits.set(p, []);
    histories.set(w, { upTo: state.wallets.get(w).cursor, covered: new Set(fresh.get(w) || []), funds: a.logs.get(w) || new Map(), ins: freshIns, credits });
    state.wallets.get(w).retryAt = 0;
    stats.read++;
  }
  for (const w of new Set([...overShare, ...gaveUp])) { const ws = state.wallets.get(w); if (ws) ws.retryAt = now + retryBackoffMs; }
  stats.overShare = overShare.size; stats.gaveUp = gaveUp.size; stats.tooLarge = tooLarge.size;
  stats.stopped = ctl.stop;
  stats.budgetExhausted = stats.budgetExhausted || budget.calls >= budget.max && (a.incomplete.size + incompleteB.size) > 0;
  if (stats.transportError) onProgress(`      payer history read stopped (${ctl.stop || "RPC unreachable"}): ${stats.transportError}${ctl.stop === "range-limited" ? " - this RPC limits the block range of eth_getLogs; set FUNDING_HISTORY_CHUNK_BLOCKS under its limit, or LEADERBOARD_FUNDING_SCAN=off" : ""}`);
  return { histories, stats };
}

// --- the gap: what funded payers paid BEFORE the window ---------------------------
//
// The scan's inbound read covers its window only. A wallet that fell behind by
// more than a window has pools that start before the window, and would have
// them inflated by every payment its payers made in between, which that read
// never saw - and a pool only drains as the payer spends, so a payer in a
// steady two-way flow with the seller would be netted for good. So once, for
// such a wallet, the transfers its FUNDED payers sent it between its pools'
// position and the window's start are read (targeted: those payers to that
// wallet, a handful of calls) and worked through the pools in order. Until that
// read completes, the wallet's pools are not advanced (it reads as behind).
export async function readFundingGaps({ rpc, token, state, wallets = [], windowStartBlock, maxCalls = FUNDING_DEFAULTS.maxCalls, minRangeBlocks = FUNDING_DEFAULTS.minRangeBlocks, payerChunk = FUNDING_DEFAULTS.payerChunk, walletChunk = FUNDING_DEFAULTS.walletChunk, walletMaxCalls = FUNDING_DEFAULTS.walletMaxCalls, retryBackoffMs = FUNDING_DEFAULTS.retryBackoffMs, scanMaxCalls = maxCalls, now = Date.now(), ctl = newFundingReadControl(), onProgress = () => {} } = {}) {
  const tok = lower(token);
  const stats = { calls: 0, refusals: 0, wallets: 0, read: 0, failed: 0, overShare: 0, gaveUp: 0, waiting: 0, events: 0, budgetExhausted: false, transportError: null };
  const gaps = new Map();
  const requests = new Map();
  for (const w0 of wallets) {
    const w = lower(w0);
    const ws = state.wallets.get(w);
    const n = gapNeeded(ws, windowStartBlock);
    if (!n || requests.has(w)) continue;
    if (ws.retryAt > now) { stats.waiting++; continue; }
    requests.set(w, { payers: [...ws.pairs.keys()], lo: n.from, hi: n.to, need: n });
  }
  stats.wallets = requests.size;
  const budget = { calls: 0, max: Math.max(0, maxCalls) };
  const r = await readPairs({ rpc, token: tok, requests, dir: "in", budget, walletChunk, payerChunk, minRangeBlocks, onProgress, stats, walletMaxCalls, scanMaxCalls, ctl, stopOnRangeLimit: false });
  for (const w of new Set([...r.overShare, ...r.gaveUp])) { const ws = state.wallets.get(w); if (ws) ws.retryAt = now + retryBackoffMs; }
  stats.overShare = r.overShare.size; stats.gaveUp = r.gaveUp.size;
  for (const [w, req] of requests) {
    if (r.incomplete.has(w)) { stats.failed++; continue; }
    gaps.set(w, { toBlock: req.need.to, ins: r.logs.get(w) || new Map() });
    stats.read++;
  }
  if (stats.transportError) onProgress(`      funding gap read stopped (${ctl.stop || "RPC unreachable"}): ${stats.transportError}`);
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
const payerKeysOf = (row) => new Set([...(row?.perPayer?.keys?.() || [])].map(lower));

/**
 * Work every (W, P) pool through the payments the scan counted, in chain order,
 * up to `throughFor(wallet)` (the position the scan's inbound read is complete
 * through) and the wallet's cursor. Mutates `state`. Payments already worked
 * through in an earlier scan are not touched again: their result is in `recs`.
 *
 * A wallet is worked only when everything it needs was read this scan: the
 * history of every payer it has not seen before (`histories`, from
 * readPayerHistory), the credit of every known payer whose first funding is
 * pending, and the gap before the window when its pools start before it
 * (`gaps`). Otherwise it is left behind, untouched.
 */
export function processSellerFunding(state, byWallet, { throughFor = () => Infinity, windowStartBlock = 0, gaps = new Map(), histories = new Map(), classify = () => 1, coveredShareToNet = FUNDING_DEFAULTS.coveredShareToNet, bucketBlocks = FUNDING_DEFAULTS.bucketBlocks, maxRecordsPerWallet = FUNDING_DEFAULTS.maxRecordsPerWallet, maxPairsPerWallet = FUNDING_DEFAULTS.maxPairsPerWallet, maxPairsTotal = FUNDING_DEFAULTS.maxPairsTotal, maxKnownPerWallet = FUNDING_DEFAULTS.maxKnownPerWallet } = {}) {
  const rows = new Map();
  for (const row of byWallet.values()) rows.set(lower(row.wallet), row);
  const total = { n: fundingPairCount(state), max: maxPairsTotal };
  for (const [w, ws] of state.wallets) {
    // A wallet this scan did not look at has payments we have not seen: its
    // pools are not worked, only its remembered payments are trimmed below.
    const row = rows.get(w);
    const limit = Math.min(endOfBlock(ws.cursor), throughFor(w));
    if (row && limit > ws.through) {
      const need = gapNeeded(ws, windowStartBlock);
      const gap = need ? gaps.get(w) : null;
      const current = payerKeysOf(row);
      const freshPayers = [...current].filter((p) => p !== w && !ws.known.has(p));
      const hist = histories.get(w) || null;
      const creditPending = [...ws.pairs].filter(([, pair]) => !pair.h && pair.pend.some(([pos]) => pos <= limit)).map(([p]) => p);
      const historyOk = (!freshPayers.length || (hist && hist.upTo === ws.cursor && freshPayers.every((p) => hist.covered.has(p))))
        && (!creditPending.length || (hist && creditPending.every((p) => hist.credits.has(p))));
      if ((!need || (gap && gap.toBlock >= need.to)) && historyOk) {
        const fresh = new Map();
        for (const p of freshPayers) {
          ws.known.set(p, [limit, -1, -1, windowStartBlock - 1]);
          const funds = hist?.funds?.get(p);
          if (!funds?.length) continue;
          if (ws.pairs.size >= maxPairsPerWallet || total.n >= total.max) { ws.truncated = true; continue; }
          const pair = newPair(1);
          pair.pend = funds.slice();
          ws.pairs.set(p, pair);
          total.n++;
          fresh.set(p, hist.ins.get(p) || []);
        }
        for (const p of creditPending) {
          const pair = ws.pairs.get(p);
          // Money of its own the payer sent before it became known: with no
          // funding before then its pool was empty, so all of it is credit.
          for (const [, m] of hist.credits.get(p) || []) if (classify(w, m) !== 1) pair.credit += m;
          pair.h = 1;
        }
        workPools(ws, row, limit, { fresh, freshPayers: new Set(freshPayers), maxPairsPerWallet, total, gapIns: gap?.ins || null, classify: (micro) => classify(w, micro), coveredShareToNet, bucketBlocks });
        evictKnown(ws, current, maxKnownPerWallet);
      }
    }
    trimWallet(ws, windowStartBlock, maxRecordsPerWallet);
  }
  return state;
}
function workPools(ws, row, limit, { fresh = new Map(), freshPayers = new Set(), maxPairsPerWallet = FUNDING_DEFAULTS.maxPairsPerWallet, total = { n: 0, max: Infinity }, gapIns = null, classify = () => 1, coveredShareToNet = FUNDING_DEFAULTS.coveredShareToNet, bucketBlocks = FUNDING_DEFAULTS.bucketBlocks } = {}) {
  const from = ws.through;
  // A payer seen for the first time has never been worked: all of its events
  // up to the limit count, not only those past the wallet's position.
  const lowFor = (p) => (freshPayers.has(p) ? -Infinity : from);
  const inRange = (p) => { const lo = lowFor(p); return ([pos]) => pos > lo && pos <= limit; };
  // Per known payer: the last payment made with its own money, and the last
  // made with the wallet's (the 30-day payer count); per day, payments netted.
  const note = (p, pos, netted) => {
    const k = ws.known.get(p);
    if (!k) return;
    if (netted) {
      k[2] = Math.max(k[2], pos);
      const day = Math.floor(pos / 1_000_000 / bucketBlocks);
      ws.netted.set(day, (ws.netted.get(day) || 0) + 1);
    } else k[1] = Math.max(k[1], pos);
  };
  const byPayer = new Map();
  for (const [p0, v] of row.perPayer || []) {
    const p = lower(p0);
    const pays = paymentsOf(v).filter(inRange(p));
    if (!pays.length) continue;
    if (ws.pairs.has(p)) byPayer.set(p, pays);
    else for (const [pos] of pays) note(p, pos, false); // never funded: its own money
  }
  // Uncounted money a KNOWN payer sent this wallet: its credit, kept even
  // before the wallet has sent that payer anything (a refund can come later).
  const uncounted = new Map();
  for (const [p0, v] of row.uncountedIn || []) {
    const p = lower(p0);
    if (!ws.known.has(p)) continue;
    const ins = paymentsOf({ ...v, calls: v.pos.length }).filter(inRange(p));
    if (!ins.length) continue;
    if (!ws.pairs.has(p)) {
      if (ws.pairs.size >= maxPairsPerWallet || total.n >= total.max) continue; // credit is a courtesy to the seller; losing it only nets more
      // A payer seen for the first time with no funding: everything before
      // the window is irrelevant until it is funded, when its credit is read.
      ws.pairs.set(p, newPair(0));
      total.n++;
    }
    uncounted.set(p, ins);
  }
  for (const [p, pair] of ws.pairs) {
    const r = inRange(p);
    const funds = pair.pend.filter(([pos]) => pos <= limit);
    const pays = byPayer.get(p) || [];
    const ins = uncounted.get(p) || [];
    // What this payer sent the wallet before the window: from its history
    // read when it is new, from the gap read when the wallet fell behind.
    // Counted-sized payments spend the pool, anything larger is payback /
    // credit, exactly as inside the window.
    const beforeSrc = fresh.has(p) ? fresh.get(p) : (gapIns?.get(p) || []).filter(r);
    const before = beforeSrc.map(([pos, m]) => [pos, classify(m) === 1 ? 1 : 2, m]);
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
        note(p, pos, covered > 0 && covered >= amt * coveredShareToNet);
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
// Past the per-wallet cap, forget the idlest known payers with no pool and not
// paying this scan (they are read again from their history if they pay).
function evictKnown(ws, current, maxKnownPerWallet) {
  if (ws.known.size <= maxKnownPerWallet) return;
  const idle = [...ws.known].filter(([p]) => !ws.pairs.has(p) && !current.has(p)).sort((x, y) => Math.max(x[1][0], x[1][1], x[1][2]) - Math.max(y[1][0], y[1][1], y[1][2]));
  for (const [p] of idle.slice(0, ws.known.size - maxKnownPerWallet)) ws.known.delete(p);
}
// Keep only what a later scan's window can still contain, and forget a pair
// with nothing left in it (its payer stays known).
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
 * What the wallet netted over the Bazaar's window ending at `latest`: payments
 * netted (by day, so up to a day wider), and payers that paid it only with its
 * own money inside the window. Counts only.
 */
export function selfFundedOver(ws, latest, { windowBlocks = FUNDING_DEFAULTS.bazaarWindowBlocks, bucketBlocks = FUNDING_DEFAULTS.bucketBlocks } = {}) {
  if (!ws || !Number.isFinite(latest)) return { calls: 0, payers: 0 };
  const cutBlock = Math.max(0, latest - windowBlocks);
  const cutDay = Math.floor(cutBlock / bucketBlocks);
  let calls = 0;
  for (const [day, n] of ws.netted) if (day >= cutDay) calls += n;
  const cut = posOf(cutBlock, 0);
  let payers = 0;
  for (const k of ws.known.values()) if (k[2] >= cut && k[1] < cut) payers++;
  return { calls, payers };
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
export function sellerFundingFigures(row, ws, { latest, now = Date.now(), carriedAt = null, circularWindowMs = FUNDING_DEFAULTS.circularWindowMs, coveredShareToNet = FUNDING_DEFAULTS.coveredShareToNet, bazaarWindowBlocks = FUNDING_DEFAULTS.bazaarWindowBlocks, bucketBlocks = FUNDING_DEFAULTS.bucketBlocks } = {}) {
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
  const over = selfFundedOver(ws, latest, { windowBlocks: bazaarWindowBlocks, bucketBlocks });
  return {
    netCalls: withheldUntilRead ? 0 : Math.max(0, grossCalls - fundedCalls),
    netPayers: withheldUntilRead ? 0 : netPayers,
    grossCalls, grossBuyers,
    fundedCalls,
    // Payers every one of whose payments in the window was netted.
    fundedPayers: Math.max(0, grossBuyers - netPayers),
    fundedUsd: fundedMicro / 1e6,
    grossUsd: grossMicro / 1e6,
    unknownUsd: unknownMicro / 1e6,
    // The same, over the Bazaar's 30-day window.
    fundedCalls30d: over.calls,
    fundedPayers30d: over.payers,
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
