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
// outbound read, the history reads and the gap reads, and at most
// `dayMaxCalls` history and gap calls in any rolling day (persisted with the
// state), wallets that clear the router's floor on gross figures first. A
// history read packs up to 200 wallets and 200 payers into one call; a
// steady-state outbound read is one call per 200 wallets. A refusal splits
// only the job that was refused: its wallet list first (isolating the heavy
// source), then its payer list when the RPC said the answer was too large,
// else it halves the block width that job reads next. A history job reads its
// range front to back, one width at a time; the width doubles again after
// each read that is answered, so a dense stretch of history narrows only the
// reads that cross it. An unreachable RPC is retried once and then stops the
// read for this scan rather than fanning out; a timed-out read is split like a
// refusal, at most three times a scan (one count shared by every pass of the
// scan, `newFundingReadControl`). A rate-limit answer stops the read for the
// scan (splitting would only send more requests to a provider that is
// throttling), and so does an RPC that says it LIMITS the block range of
// eth_getLogs, when the read is a whole-history one: that is a property of the
// RPC, no split of this job can fit the history under it, and the log line
// names FUNDING_HISTORY_CHUNK_BLOCKS as the setting that can.
// ONE WALLET CANNOT SPEND THE READS (2026-09-28, after two reviews). Each
// wallet's history and gap reads are an EPISODE kept with its state: the calls
// they were planned to take (payer jobs x range widths) and the calls spent,
// ACROSS SCANS, until the reads complete and the wallet is worked. A read is
// charged to every wallet in it, and the next job read is always one whose
// wallets would overrun their plan least, then have spent least (ties in
// priority order), across both history reads, so light wallets are served
// before a heavy one gets another turn. A wallet may spend its plan plus
// `walletMaxCalls` more on splits (0: only what was planned); past that it
// WAITS - one day, then twice as long each time it has to wait again before
// its reads complete, up to a week - and while it waits it costs no call and
// counts gross, the behaviour without this reader. When a scan's or a day's
// budget runs out first, every unfinished wallet that has used its plan and
// has spent at least its fair slice of what the unfinished ones overran waits
// the same way, so however many heavy wallets there are, their calls stop
// within a scan or two instead of taking the whole budget every hour.
// PROGRESS PERSISTS: where each history job had got to (its next block, the
// width it had learned, and the transfers it had read below that block) is
// kept with the wallet, so the next attempt resumes there instead of reading
// from the token's deployment again; a wallet that waited resumes with the
// widths it learned doubled (a narrowing from a passing refusal heals). A
// wallet whose remaining reads at the widths it learned need more calls than
// one scan's budget is not started, and waits. RESIDUAL: a history too dense
// to be read inside those bounds (more than `maxPartialLogsPerWallet`
// transfers kept for it, or refused at every width a scan can afford) is never
// read, so that wallet is never netted and counts gross.
// A wallet whose history reads did not complete this scan, or whose pools
// start before the window and whose gap before it was not read
// (readFundingGaps), is not advanced: it is "behind". What is known still nets it, what is not is unknown, and a circular
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
/** A setting that is a whole number of at least 0, else `fallback`. */
function nonNegativeInt(raw, fallback) {
  const n = parseInt(raw ?? "", 10);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}
export const FUNDING_DEFAULTS = {
  maxCalls: parseInt(process.env.LEADERBOARD_FUNDING_MAX_CALLS || "400", 10),
  minRangeBlocks: 1000,
  // The widest block range one history read asks for. Unbounded by default:
  // a targeted read's answer is tiny whatever the range, and a refusal splits
  // it. A provider that times out on very wide ranges can be given a bound.
  historyChunkBlocks: parseInt(process.env.FUNDING_HISTORY_CHUNK_BLOCKS || "0", 10) > 0 ? parseInt(process.env.FUNDING_HISTORY_CHUNK_BLOCKS, 10) : Infinity,
  walletChunk: 200,
  payerChunk: 200,
  // Calls one wallet may spend on history and gap reads, across scans until
  // its reads complete, beyond the ones they were planned to take (splits
  // after refusals; 0: only the planned ones), and how long a wallet whose
  // reads went past that, were refused over the narrowest range, or were cut
  // short when a budget ran out, waits before it is read again: a day, then
  // twice as long each time it has to wait again, up to the maximum.
  walletMaxCalls: nonNegativeInt(process.env.LEADERBOARD_FUNDING_WALLET_MAX_CALLS, 32),
  retryBackoffMs: 86_400_000,
  maxRetryBackoffMs: 7 * 86_400_000,
  // History and gap calls in any rolling day, across scans.
  dayMaxCalls: nonNegativeInt(process.env.LEADERBOARD_FUNDING_DAY_MAX_CALLS, 1600),
  dayMs: 86_400_000,
  // Transfers kept for unfinished history reads (their progress), per wallet
  // and in total. Past either, that wallet's progress is dropped and it waits.
  maxPartialLogsPerWallet: 20_000,
  maxPartialLogsTotal: 200_000,
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
  // `day`: [time, calls] per pass, the history and gap calls of the last day.
  return { v: 2, token: lower(token), wallets: new Map(), day: [] };
}
function newWalletState(windowStartBlock, now) {
  // `cursor`: the last block whose outbound transfers to KNOWN payers are
  // read (inclusive). `through`: the chain position up to which each pool has
  // been worked through against the payments the scan counted. `known`: payer
  // -> [addedAt, lastOwnMoneyPos, lastSellerMoneyPos, preWindowEnd] (positions,
  // -1 for never; preWindowEnd is the last block before the window when it
  // became known).
  // `netted`: day bucket -> payments netted.
  // `retryAt`: a wallet whose history or gap reads went past its share waits
  // until then (ms) before they are tried again. The read accounting (see ONE
  // WALLET CANNOT SPEND THE READS): `ep` the current episode { pl planned, sp
  // spent, t last charged }, `st` how many times it has had to wait since its
  // reads last completed, `hw` the block width a new read of it starts at while
  // it has, and `hp` the progress of its unfinished reads (segments, see
  // newSegment).
  const s = Math.max(0, windowStartBlock);
  return { cursor: s - 1, through: posOf(s, 0) - 1, since: s, truncated: false, lastSeenAt: now, lastCircularAt: null, retryAt: 0, ep: null, st: 0, hw: 0, hp: [], pairs: new Map(), known: new Map(), netted: new Map() };
}
// A read's progress, kept between scans: kind `k` ("o" the wallet's transfers
// to new payers, "i" those payers' transfers to it before the window, "c" a
// known payer's transfers to it before it became known, "g" the gap before the
// window), `h` the fixed end block of a "c" read (or the start block of a "g"
// one; -1 otherwise), `p` its payers, `lo` the next block to read, `w` the
// width it had learned (0: none), `l` the transfers read below `lo`, flat
// [payer index, position, value, ...], and `pg` 1 when the attempt that saved
// it got further (0: it was refused at every width it tried).
function newSegment(k, h, p, lo, w, logs, pg = 1) {
  const idx = new Map(p.map((x, i) => [x, i]));
  const l = [];
  for (const [payer, list] of logs || []) { const i = idx.get(payer); if (i === undefined) continue; for (const [pos, v] of list) l.push(i, pos, v); }
  return { k, h, p, lo, w: Number.isFinite(w) && w > 0 ? w : 0, l, pg: pg ? 1 : 0 };
}
/** A segment's transfers as Map(payer -> [[position, value]]), in order. */
function segmentLogs(seg) {
  const m = new Map();
  for (let i = 0; i + 2 < seg.l.length; i += 3) {
    const p = seg.p[seg.l[i]];
    if (!p) continue;
    if (!m.has(p)) m.set(p, []);
    m.get(p).push([seg.l[i + 1], seg.l[i + 2]]);
  }
  for (const list of m.values()) list.sort((a, b) => a[0] - b[0]);
  return m;
}
const segmentLogCount = (ws) => (ws.hp || []).reduce((n, g) => n + g.l.length / 3, 0);
/** Transfers held by unfinished reads, in the whole state. */
export function fundingPartialLogCount(state) {
  let n = 0;
  for (const ws of state?.wallets?.values?.() || []) n += segmentLogCount(ws);
  return n;
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
    wallets[w] = {
      c: ws.cursor, t: ws.through, s: ws.since, x: ws.truncated ? 1 : 0, seen: ws.lastSeenAt, lc: ws.lastCircularAt || null,
      ...(ws.retryAt > 0 ? { ra: ws.retryAt } : {}),
      ...(ws.ep ? { ep: [ws.ep.pl, ws.ep.sp, ws.ep.t] } : {}),
      ...(ws.st > 0 ? { st: ws.st } : {}),
      ...(ws.hw > 0 ? { hw: ws.hw } : {}),
      ...(ws.hp?.length ? { hp: ws.hp.map((g) => [g.k, g.h, g.p, g.lo, g.w, g.l, g.pg ? 1 : 0]) } : {}),
      p, k, b,
    };
  }
  return JSON.stringify({ v: 2, token: state.token, savedAt: new Date(now).toISOString(), wallets, d: (state.day || []).map(([t, n]) => [t, n]) });
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
    const ep = Array.isArray(e.ep) && e.ep.length === 3 && e.ep.every((x) => int(x) !== null && x >= 0) ? { pl: e.ep[0], sp: e.ep[1], t: e.ep[2] } : null;
    const hp = [];
    for (const g of Array.isArray(e.hp) ? e.hp : []) {
      if (!Array.isArray(g) || (g.length !== 6 && g.length !== 7)) continue;
      const [k, h, p, lo, wd, l, pg = 1] = g;
      if (!["o", "i", "c", "g"].includes(k) || int(h) === null || h < -1 || int(lo) === null || lo < 0 || int(wd) === null || wd < 0 || !Array.isArray(p) || !Array.isArray(l) || l.length % 3) continue;
      const payers = p.map(lower);
      if (!payers.length || !payers.every((x) => EVM.test(x))) continue;
      if (!l.every((x, i) => int(x) !== null && x >= 0 && (i % 3 || x < payers.length))) continue;
      hp.push({ k, h, p: payers, lo, w: wd, l: l.slice(), pg: pg === 0 ? 0 : 1 });
    }
    const ws = { cursor: e.c, through: e.t, since: e.s, truncated: e.x === 1, lastSeenAt: Number(e.seen) || 0, lastCircularAt: typeof e.lc === "string" ? e.lc : null, retryAt: int(e.ra) !== null && e.ra > 0 ? e.ra : 0, ep, st: int(e.st) !== null && e.st > 0 ? e.st : 0, hw: int(e.hw) !== null && e.hw > 0 ? e.hw : 0, hp, pairs: new Map(), known: new Map(), netted: new Map() };
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
  for (const x of Array.isArray(j.d) ? j.d : []) if (Array.isArray(x) && x.length === 2 && int(x[0]) !== null && int(x[1]) !== null && x[1] >= 0) state.day.push([x[0], x[1]]);
  return state;
}

/** Drop what nothing needs any more (and keep the progress of unfinished
 *  reads within its caps, see capProgress): a payer's credit idle for
 *  `creditTtlBlocks` (when nothing else is left in its pair), a known payer
 *  with no pool idle for `knownTtlBlocks`, netted-count days older than the
 *  30-day window, and a wallet not scanned for `walletTtlMs` with no pool left
 *  and no verdict inside the circular window. */
export function pruneFundingState(state, { now = Date.now(), latest = null, walletTtlMs = FUNDING_DEFAULTS.walletTtlMs, circularWindowMs = FUNDING_DEFAULTS.circularWindowMs, creditTtlBlocks = FUNDING_DEFAULTS.creditTtlBlocks, knownTtlBlocks = FUNDING_DEFAULTS.knownTtlBlocks, bazaarWindowBlocks = FUNDING_DEFAULTS.bazaarWindowBlocks, bucketBlocks = FUNDING_DEFAULTS.bucketBlocks, maxPartialLogsPerWallet = FUNDING_DEFAULTS.maxPartialLogsPerWallet, maxPartialLogsTotal = FUNDING_DEFAULTS.maxPartialLogsTotal, counts = null } = {}) {
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
  // The progress of unfinished reads stays within its caps, and the day's
  // record holds the last day only.
  const progressDropped = capProgress(state, now, { maxPartialLogsPerWallet, maxPartialLogsTotal });
  fundingDayCalls(state, now);
  if (counts) counts.progressDropped = progressDropped;
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
  // `dayLeft`: history and gap calls the rolling day still allows (set by the
  // first pass that reads, from the state); `stopped`: wallets a pass of this
  // scan made wait (a later pass skips them without counting them again);
  // `waitingSeen`: wallets already counted as waiting this scan.
  return { timeouts: 0, transportRetried: false, stop: null, dayLeft: null, dayCapped: false, stopped: new Set(), waitingSeen: new Set() };
}
/** History and gap calls recorded in the rolling day ending `now` (older
 *  records are dropped). */
export function fundingDayCalls(state, now = Date.now(), { dayMs = FUNDING_DEFAULTS.dayMs } = {}) {
  if (!Array.isArray(state?.day)) return 0;
  state.day = state.day.filter(([t]) => now - t < dayMs);
  return state.day.reduce((n, [, c]) => n + c, 0);
}
function openDay(ctl, state, now, dayMaxCalls) {
  if (ctl.dayLeft === null || ctl.dayLeft === undefined) ctl.dayLeft = Math.max(0, dayMaxCalls - fundingDayCalls(state, now));
}
function noteDay(state, now, calls) {
  if (!state || !(calls > 0)) return;
  if (!Array.isArray(state.day)) state.day = [];
  state.day.push([now, calls]);
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
// Targeted reads of the transfers between a wallet and a set of its payers:
// `dir` "out" is wallet -> payer (topics [T, wallets, payers]), "in" is payer
// -> wallet. A REQUEST is one wallet, a list of its payers and a block range
// [lo, hi]; requests with the same range and width are packed up to
// `walletChunk` wallets and `payerChunk` payers per job. A job reads its range
// front to back: [lo, lo + width - 1], then on; a refusal halves the width of
// that job alone (after its wallet list, then its payer list, is split), and
// an answered read doubles it again (never past `maxSpanBlocks`, nor past a
// range limit the RPC stated). Every call is charged to every wallet in it, in
// the wallet's episode (`acct`, see ONE WALLET CANNOT SPEND THE READS). Each
// request ends the pass done, or with a frontier (the first block not read),
// the width it had learned, and the transfers read below the frontier - which
// the caller keeps as the request's progress.
//
// `stopOnRangeLimit`: a whole-history read stops for the scan when the RPC
// says it limits the block range (no width fits a history under it at an
// affordable number of calls); a gap read narrows to the stated limit instead.
/** One call per payer chunk: the probe a read that got nowhere last time is planned. */
const probeCalls = (r, payerChunk = FUNDING_DEFAULTS.payerChunk) => Math.ceil(r.payers.length / Math.max(1, payerChunk));
/** The calls a read of `span` blocks at `width` blocks per call, for `payers`
 *  payers, is planned to take (a width of 0 or Infinity: one per payer chunk). */
export function plannedCalls(span, width, payers, payerChunk = FUNDING_DEFAULTS.payerChunk) {
  if (!(span > 0) || !(payers > 0)) return 0;
  const pieces = !(width > 0) || width >= span ? 1 : Math.ceil(span / width);
  return pieces * Math.ceil(payers / Math.max(1, payerChunk));
}
/** Order two job keys (see pairsReader); null (nothing to read) sorts last. */
function compareKeys(a, b) {
  if (!a || !b) return a ? -1 : b ? 1 : 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
function pairsReader({ rpc, token, dir, budget, walletChunk, payerChunk, minRangeBlocks, onProgress, stats, maxSpanBlocks = Infinity, walletMaxCalls = FUNDING_DEFAULTS.walletMaxCalls, walletMaxPlan = Infinity, ctl = newFundingReadControl(), stopOnRangeLimit = false, acct, now = Date.now() }) {
  const tok = lower(token);
  const failed = new Set(), overShare = new Set(), gaveUp = new Set(), tooLarge = new Set();
  const queue = [];
  const requests = [];
  const out = new Map(); // request key -> Map(payer -> [[pos, value]])
  const dropped = new Map(); // request key -> { lo, w } of a job left when its wallet stopped
  const lastWidth = new Map(); // request key -> the width after its last answered read
  const seen = new Set();
  let halted = null; // "budget" | "stop"
  const widthOf = (x) => (x > 0 ? Math.min(x, maxSpanBlocks) : maxSpanBlocks);
  const mkJob = (rs, tos, lo, hi, width, cap) => ({ rs, tos: [...new Set(tos)], ws: [...new Set(rs.map((r) => r.w))], lo, hi, width, cap });
  const sub = (job, rs) => mkJob(rs, job.tos.filter((p) => rs.some((r) => r.payerSet.has(p))), job.lo, job.hi, job.width, job.cap);
  const pack = (rs, lo, hi, width) => {
    const jobs = [];
    let cur = null;
    for (const r of rs) {
      // A request that picks up earlier progress (or of a wallet that has
      // had to wait) reads alone: its wallet is the one that was heavy, and
      // packing it again would spend the same isolating splits every scan.
      if (r.alone) {
        for (let i = 0; i < r.payers.length; i += payerChunk) jobs.push(mkJob([r], r.payers.slice(i, i + payerChunk), lo, hi, width, Infinity));
        continue;
      }
      if (r.payers.length > payerChunk) {
        for (let i = 0; i < r.payers.length; i += payerChunk) jobs.push(mkJob([r], r.payers.slice(i, i + payerChunk), lo, hi, width, Infinity));
        continue;
      }
      const curWallets = cur ? new Set(cur.rs.map((x) => x.w)) : null;
      if (!cur || (!curWallets.has(r.w) && curWallets.size >= walletChunk) || cur.tos.length + r.payers.length > payerChunk) { cur = { rs: [], tos: [], lo, hi, width }; jobs.push(cur); }
      cur.rs.push(r); cur.tos.push(...r.payers);
    }
    return jobs.map((j) => (j.ws ? j : mkJob(j.rs, j.tos, j.lo, j.hi, j.width, Infinity)));
  };
  /** Add requests: { key, w, payers, lo, hi, width, logs } (logs: what an
   *  earlier pass read below `lo`, kept as it is). */
  function add(reqs) {
    const byRange = new Map();
    for (const r of reqs) {
      r.payerSet = new Set(r.payers);
      requests.push(r);
      const m = new Map();
      for (const [p, list] of r.logs || []) m.set(p, list.slice());
      out.set(r.key, m);
      if (!(r.hi >= r.lo) || !r.payers.length) continue; // nothing to read: done
      const width = widthOf(r.width);
      const k = `${r.lo}:${r.hi}:${width}`;
      if (!byRange.has(k)) byRange.set(k, []);
      byRange.get(k).push(r);
    }
    for (const rs of byRange.values()) queue.push(...pack(rs, rs[0].lo, rs[0].hi, widthOf(rs[0].width)));
  }
  // The order (keyOf, compared by compareKeys): a read that picks up
  // progress which got nowhere last time (refused at every width it tried)
  // after every other; then planned work before any call past a plan, and
  // among planned work the wallets that have spent least. Among calls past a
  // plan, the job with the fewest reads left at its width first (a history
  // with one dense stretch finishes; one refused all the way through falls
  // behind), then the least overrun, then the least spent. Ties go to the
  // front of the queue (priority order, and a job just split).
  const keyOf = (job) => {
    let ov = 0, sp = 0;
    for (const w of job.ws) { const a = acct(w); ov = Math.max(ov, a.sp + 1 - a.pl); sp = Math.max(sp, a.sp); }
    const stalled = job.rs.every((r) => r.stalled) ? 1 : 0;
    return ov > 0 ? [stalled, 1, plannedCalls(job.hi - job.lo + 1, job.width, 1), ov, sp] : [stalled, 0, sp, 0, 0];
  };
  const pickIndex = () => {
    let bi = -1, bk = null;
    for (let i = 0; i < queue.length; i++) {
      const k = keyOf(queue[i]);
      if (!bk || compareKeys(k, bk) < 0) { bk = k; bi = i; if (k[0] === 0 && k[1] === 0 && k[2] === 0) break; }
    }
    return { index: bi, key: bk };
  };
  const noteDrop = (r, job) => {
    const e = dropped.get(r.key);
    if (!e || job.lo < e.lo) dropped.set(r.key, { lo: job.lo, w: Math.min(e?.w ?? Infinity, job.width) });
    else e.w = Math.min(e.w, job.width);
  };
  const record = (job, logs, end) => {
    const byWP = new Map();
    for (const r of job.rs) for (const p of job.tos) if (r.payerSet.has(p)) byWP.set(`${r.w}:${p}`, r);
    for (const l of Array.isArray(logs) ? logs : []) {
      const a = addrFromTopic(l?.topics?.[1]), b = addrFromTopic(l?.topics?.[2]);
      const w = dir === "out" ? a : b, p = dir === "out" ? b : a;
      const r = w && p ? byWP.get(`${w}:${p}`) : null;
      if (!r) continue;
      const value = valueOf(l), pos = posOfLog(l);
      if (value === null || pos === null || pos < posOf(job.lo, 0) || pos > endOfBlock(end)) continue;
      const k = `${r.key}:${p}:${pos}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const m = out.get(r.key);
      if (!m.has(p)) m.set(p, []);
      m.get(p).push([pos, value]);
      stats.events++;
    }
  };
  /** One step: read (or split, or drop) the job picked next. "halt" when
   *  the budget is spent or the scan's read stopped. */
  async function step() {
    if (halted) return "halt";
    const { index } = pickIndex();
    if (index < 0) return "empty";
    const job = queue.splice(index, 1)[0];
    // A wallet whose next call would pass its plan plus walletMaxCalls stops
    // here, and so does one whose reads left, at the width it has learned,
    // are more than a whole scan could make.
    for (const w of job.ws) if (!failed.has(w)) { const a = acct(w); if (a.sp + 1 > a.pl + walletMaxCalls) { failed.add(w); overShare.add(w); } }
    if (job.ws.length === 1 && !failed.has(job.ws[0]) && plannedCalls(job.hi - job.lo + 1, job.width, job.tos.length, payerChunk) > walletMaxPlan) { failed.add(job.ws[0]); tooLarge.add(job.ws[0]); }
    const live = job.rs.filter((r) => !failed.has(r.w));
    if (live.length < job.rs.length) {
      for (const r of job.rs) if (failed.has(r.w)) noteDrop(r, job);
      if (live.length) queue.unshift(sub(job, live));
      return "ok";
    }
    if (ctl.stop) { queue.unshift(job); halted = "stop"; return "halt"; }
    if (budget.calls >= budget.max || !(ctl.dayLeft > 0)) {
      if (!(ctl.dayLeft > 0)) ctl.dayCapped = true;
      stats.budgetExhausted = true; queue.unshift(job); halted = "budget"; return "halt";
    }
    const end = job.width >= job.hi - job.lo + 1 ? job.hi : job.lo + job.width - 1;
    const span = end - job.lo + 1;
    budget.calls++; stats.calls++; ctl.dayLeft--;
    for (const w of job.ws) { const a = acct(w); a.sp++; a.t = now; }
    for (const r of job.rs) r.tried = true;
    let logs;
    try {
      const walletTopics = job.ws.map(pad), payerTopics = job.tos.map(pad);
      logs = await rpc("eth_getLogs", [{ fromBlock: "0x" + job.lo.toString(16), toBlock: "0x" + end.toString(16), address: tok, topics: dir === "out" ? [TRANSFER, walletTopics, payerTopics] : [TRANSFER, payerTopics, walletTopics] }]);
    } catch (e) {
      const msg = String(e?.message || e);
      const kind = failureKind(msg, ctl.timeouts);
      if (TIMEOUT.test(msg)) ctl.timeouts++;
      if (kind === "range" && !stopOnRangeLimit && span > minRangeBlocks) {
        // A gap read under a range limit: narrow this job to it, for good.
        stats.refusals++;
        const stated = statedRangeLimit(msg);
        job.cap = Math.min(job.cap, stated ?? Infinity);
        job.width = Math.max(1, Math.min(span - 1, stated ?? Math.floor(span / 2)));
        queue.unshift(job);
        return "ok";
      }
      if (kind !== "split") {
        if (kind === "unreachable" && !ctl.transportRetried) { ctl.transportRetried = true; queue.unshift(job); return "ok"; }
        ctl.stop = kind === "range" ? "range-limited" : kind === "rate" ? "rate-limited" : kind === "stop" ? "timeouts" : "unreachable";
        stats.transportError = msg.slice(0, 160); queue.unshift(job); halted = "stop"; return "halt";
      }
      stats.refusals++;
      if (job.ws.length > 1) {
        // Which of its wallets made it too large is not known yet: the reads
        // that isolate it are planned for every one of them, so a light
        // wallet packed with a heavy one is never charged for it.
        for (const w of job.ws) acct(w).pl++;
        const mid = Math.ceil(job.ws.length / 2);
        const left = new Set(job.ws.slice(0, mid));
        queue.unshift(sub(job, job.rs.filter((r) => left.has(r.w))), sub(job, job.rs.filter((r) => !left.has(r.w))));
        return "ok";
      }
      // One wallet: narrow the width first (the payers of a dense stretch
      // ride along in the same calls, and a width that grows back after it
      // costs nothing elsewhere); split its payer list only once the width
      // cannot narrow further.
      if (span > minRangeBlocks) { job.width = Math.max(1, Math.floor(span / 2)); queue.unshift(job); return "ok"; }
      if (job.tos.length > 1) {
        const mid = Math.ceil(job.tos.length / 2);
        queue.unshift({ ...job, tos: job.tos.slice(0, mid) }, { ...job, tos: job.tos.slice(mid) });
        return "ok";
      }
      onProgress(`      payer history read gave up on one wallet at blocks ${job.lo}-${end}: ${msg.slice(0, 120)}`);
      failed.add(job.ws[0]); gaveUp.add(job.ws[0]);
      for (const r of job.rs) noteDrop(r, job);
      return "ok";
    }
    record(job, logs, end);
    for (const r of job.rs) { r.stalled = false; r.advanced = true; }
    job.lo = end + 1;
    if (Number.isFinite(job.width)) job.width = Math.min(maxSpanBlocks, job.cap, job.width * 2);
    for (const r of job.rs) lastWidth.set(r.key, job.width);
    if (job.lo <= job.hi) queue.unshift(job);
    return "ok";
  }
  const pendingKeys = () => { const k = new Set(dropped.keys()); for (const j of queue) for (const r of j.rs) k.add(r.key); return k; };
  return {
    add,
    step,
    /** Why the reader stopped: "budget", "stop", or null. */
    haltedFor: () => halted,
    /** The order key of the job this reader would read next (null when it has none). */
    nextKey: () => (halted || !queue.length ? null : pickIndex().key),
    /** Whether the request has been read in full (so far this pass). */
    isDone: (r) => !failed.has(r.w) && !pendingKeys().has(r.key),
    /** Whether any transfer for (request, payer) has been read, earlier passes included. */
    hasLogs: (r, p) => !!out.get(r.key)?.get(p)?.length,
    /**
     * Every request, with `done`, `frontier` (the first block not read),
     * `width` (the width it had learned), and `logs` (Map payer -> sorted
     * list; for an unfinished request, only what lies below its frontier).
     * `overShare` / `gaveUp` / `tooLarge`: wallets that stopped for those reasons.
     */
    result() {
      const pend = new Map();
      for (const j of queue) for (const r of j.rs) {
        const e = pend.get(r.key);
        if (!e || j.lo < e.lo) pend.set(r.key, { lo: j.lo, w: Math.min(e?.w ?? Infinity, j.width) });
        else e.w = Math.min(e.w, j.width);
      }
      for (const [k, d] of dropped) {
        const e = pend.get(k);
        if (!e || d.lo < e.lo) pend.set(k, { lo: d.lo, w: Math.min(e?.w ?? Infinity, d.w) });
        else e.w = Math.min(e.w, d.w);
      }
      for (const r of requests) {
        const m = out.get(r.key);
        for (const list of m.values()) list.sort((x, y) => x[0] - y[0]);
        const p = pend.get(r.key);
        if (!p) { r.done = true; r.frontier = Math.max(r.lo, r.hi + 1); r.endWidth = lastWidth.get(r.key) ?? widthOf(r.width); r.out = m; continue; }
        r.done = false; r.frontier = p.lo; r.endWidth = p.w;
        const cut = posOf(p.lo, 0);
        const below = new Map();
        for (const [payer, list] of m) { const keep = list.filter(([pos]) => pos < cut); if (keep.length) below.set(payer, keep); }
        r.out = below;
      }
      if (overShare.size) onProgress(`      ${overShare.size} wallet(s) spent their share of the reads; each waits before it is tried again`);
      return { requests, overShare, gaveUp, tooLarge, failed, halted };
    },
  };
}

// --- the read accounting, per wallet ---------------------------------------------------
//
// See ONE WALLET CANNOT SPEND THE READS above.
/** Whether a wallet may be read now; a wallet whose wait is over starts a new
 *  attempt with the widths it learned doubled. Counts a waiting wallet once a
 *  scan. */
function mayRead(ws, w, now, ctl, stats, retryBackoffMs) {
  if (ctl.stopped.has(w)) return false; // stopped by an earlier pass of this scan (counted there)
  if (ws.retryAt > now) {
    if (!ctl.waitingSeen.has(w)) { ctl.waitingSeen.add(w); stats.waiting++; }
    return false;
  }
  if (ws.retryAt) {
    ws.retryAt = 0;
    if (ws.hw > 0) ws.hw *= 2;
    for (const g of ws.hp) if (g.w > 0) g.w *= 2;
  }
  // An episode idle for a day (nothing charged to it) starts over.
  if (ws.ep && now - ws.ep.t > retryBackoffMs) ws.ep = null;
  return true;
}
/** The wallet waits: a day, doubling each time it has to wait again, up to the maximum. */
function makeWait(ws, w, now, ctl, { retryBackoffMs = FUNDING_DEFAULTS.retryBackoffMs, maxRetryBackoffMs = FUNDING_DEFAULTS.maxRetryBackoffMs } = {}) {
  ws.st = (ws.st || 0) + 1;
  ws.retryAt = now + Math.min(maxRetryBackoffMs, retryBackoffMs * 2 ** Math.min(ws.st - 1, 20));
  ws.ep = null;
  ctl?.stopped.add(w);
}
/** When a budget ran out: the unfinished wallets that have used their plan
 *  and spent at least their fair slice of what those wallets overran (at
 *  least one call past the plan, counting the one they were waiting for). */
function cutShortOf(unfinished, acct) {
  const need = [...unfinished].map((w) => [w, acct(w)]).filter(([, a]) => a && a.sp >= a.pl).map(([w, a]) => [w, a.sp - a.pl + 1]);
  if (!need.length) return [];
  const slice = Math.max(1, Math.floor(need.reduce((n, [, x]) => n + x, 0) / need.length));
  return need.filter(([, x]) => x >= slice).map(([w]) => w);
}
/** Replace the wallet's progress segments `was` with those saved from this
 *  pass's requests (done ones too: a later scan only extends them). */
function saveSegments(ws, was, reqs, kindH) {
  const drop = new Set(was);
  ws.hp = ws.hp.filter((g) => !drop.has(g));
  // Got nowhere: tried this pass and never answered. A read not tried keeps
  // what it was.
  for (const r of reqs) ws.hp.push(newSegment(r.kind, kindH(r), r.payers, r.frontier, r.endWidth, r.out, r.done || r.advanced ? 1 : r.tried ? 0 : r.seg ? r.seg.pg : 1));
  const widths = reqs.filter((r) => !r.done).map((r) => r.endWidth);
  const learned = (widths.length ? widths : reqs.map((r) => r.endWidth)).filter((x) => Number.isFinite(x) && x > 0);
  if (learned.length) ws.hw = Math.min(...learned);
}
/** Keep the progress of unfinished reads within its caps: a wallet over its
 *  own cap, then the wallets holding most while the total is over, lose it and
 *  wait. Returns how many wallets lost their progress. */
function capProgress(state, now, { maxPartialLogsPerWallet = FUNDING_DEFAULTS.maxPartialLogsPerWallet, maxPartialLogsTotal = FUNDING_DEFAULTS.maxPartialLogsTotal, ...waitOpts } = {}) {
  let n = 0;
  const drop = (w, ws) => { ws.hp = []; makeWait(ws, w, now, null, waitOpts); n++; };
  for (const [w, ws] of state.wallets) if (segmentLogCount(ws) > maxPartialLogsPerWallet) drop(w, ws);
  let total = fundingPartialLogCount(state);
  if (total <= maxPartialLogsTotal) return n;
  const heavy = [...state.wallets].filter(([, ws]) => ws.hp?.length).sort((a, b) => segmentLogCount(b[1]) - segmentLogCount(a[1]));
  for (const [w, ws] of heavy) { if (total <= maxPartialLogsTotal) break; total -= segmentLogCount(ws); drop(w, ws); }
  return n;
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
 * Each read resumes where an earlier scan's left off (the wallet's `hp`).
 * `wallets` is [{ wallet, payers }] in priority order, `payers` this scan's.
 *
 * @returns { histories: Map(wallet -> { upTo, covered: Set, funds, ins, credits }),
 *   stats } - a wallet appears only when every read it needed completed.
 */
export async function readPayerHistory({ rpc, token, state, wallets = [], windowStartBlock, historyFromBlock = historyFromBlockFor(token), historyChunkBlocks = FUNDING_DEFAULTS.historyChunkBlocks, walletChunk = FUNDING_DEFAULTS.walletChunk, payerChunk = FUNDING_DEFAULTS.payerChunk, maxCalls = FUNDING_DEFAULTS.maxCalls, minRangeBlocks = FUNDING_DEFAULTS.minRangeBlocks, walletMaxCalls = FUNDING_DEFAULTS.walletMaxCalls, retryBackoffMs = FUNDING_DEFAULTS.retryBackoffMs, maxRetryBackoffMs = FUNDING_DEFAULTS.maxRetryBackoffMs, dayMaxCalls = FUNDING_DEFAULTS.dayMaxCalls, scanMaxCalls = maxCalls, now = Date.now(), ctl = newFundingReadControl(), onProgress = () => {} } = {}) {
  const tok = lower(token);
  // overShare / gaveUp: wallets whose reads stopped for the reasons pairsReader
  // names; cutShort: stopped when a budget ran out (see cutShortOf); tooLarge:
  // not started, their remaining reads needing more calls than a scan has (or
  // their progress over its cap); waiting: not read this scan because an
  // earlier scan made them wait. resumed: reads that picked up an earlier
  // scan's progress.
  const stats = { calls: 0, refusals: 0, wallets: 0, payers: 0, funded: 0, creditReads: 0, read: 0, failed: 0, overShare: 0, gaveUp: 0, cutShort: 0, tooLarge: 0, waiting: 0, resumed: 0, events: 0, budgetExhausted: false, dayCapReached: false, transportError: null, stopped: null };
  const budget = { calls: 0, max: Math.max(0, maxCalls) };
  openDay(ctl, state, now, dayMaxCalls);
  const from = Math.max(0, historyFromBlock);
  const maxSpan = historyChunkBlocks > 0 ? historyChunkBlocks : Infinity;
  const walletMaxPlan = Math.max(1, scanMaxCalls);
  const waitOpts = { retryBackoffMs, maxRetryBackoffMs };
  let seq = 0;
  const req = (w, kind, seg, payers, lo, hi, width, h = -1) => ({ key: `${kind}${++seq}`, kind, w, seg, payers, lo, hi, width, h, logs: seg ? segmentLogs(seg) : null, stalled: !!seg && !seg.pg });
  const planCalls = (r) => plannedCalls(r.hi - r.lo + 1, r.width > 0 ? Math.min(r.width, maxSpan) : maxSpan, r.payers.length, payerChunk);
  const plan = new Map(); // wallet -> { ws, fresh: Set, o: [], i: [], c: [], was: [segments resumed], iBuilt }
  const seenW = new Set();
  for (const e of wallets) {
    const w = lower(e?.wallet);
    const ws = state.wallets.get(w);
    if (!ws || seenW.has(w)) continue;
    seenW.add(w);
    const ps = [...new Set([...(e.payers || [])].map(lower))].filter((p) => EVM.test(p) && p !== w && isScannableWallet(p, tok) && !ws.known.has(p));
    const cr = [];
    for (const [p, pair] of ws.pairs) if (!pair.h && pair.pend.length) cr.push({ payer: p, hi: ws.known.get(p)?.[3] ?? -1 });
    if (!ps.length && !cr.length) continue;
    if (!mayRead(ws, w, now, ctl, stats, retryBackoffMs)) continue;
    stats.wallets++;
    const fresh = new Set(ps);
    const startW = ws.st > 0 && ws.hw > 0 ? ws.hw : 0;
    const p1 = { ws, fresh, o: [], i: [], c: [], was: [], iBuilt: false, startW };
    // 1: the progress of earlier scans first, then the payers none of it covers.
    const coveredO = new Set();
    for (const g of ws.hp) if (g.k === "o" && g.p.some((p) => fresh.has(p))) { p1.o.push(req(w, "o", g, g.p, g.lo, ws.cursor, g.w)); p1.was.push(g); for (const p of g.p) coveredO.add(p); }
    const newO = ps.filter((p) => !coveredO.has(p));
    if (newO.length) p1.o.push(req(w, "o", null, newO, from, ws.cursor, startW));
    // 2, resumed: payers an earlier part of read 1 already found funded.
    for (const g of ws.hp) if (g.k === "i" && g.p.some((p) => fresh.has(p))) { p1.i.push(req(w, "i", g, g.p, g.lo, windowStartBlock - 1, g.w)); p1.was.push(g); }
    // 3: per fixed end block.
    const byHi = new Map();
    for (const { payer, hi } of cr) { stats.creditReads++; if (!byHi.has(hi)) byHi.set(hi, []); byHi.get(hi).push(payer); }
    for (const [hi, payers] of byHi) {
      const pset = new Set(payers), cov = new Set();
      for (const g of ws.hp) if (g.k === "c" && g.h === hi && g.p.some((p) => pset.has(p))) { p1.c.push(req(w, "c", g, g.p, g.lo, hi, g.w, hi)); p1.was.push(g); for (const p of g.p) cov.add(p); }
      const rest = payers.filter((p) => !cov.has(p));
      if (rest.length) p1.c.push(req(w, "c", null, rest, from, hi, startW, hi));
    }
    const all = [...p1.o, ...p1.i, ...p1.c];
    const alone = ws.st > 0 || p1.was.length > 0;
    for (const r of all) r.alone = alone;
    const need = all.reduce((n, r) => n + planCalls(r), 0);
    if (need > walletMaxPlan) {
      // More than a scan can afford: not started. At widths it LEARNED, it
      // waits (they double when it comes back); at the configured bound
      // (FUNDING_HISTORY_CHUNK_BLOCKS), nothing will change until the setting
      // does, so it is only skipped.
      stats.tooLarge++;
      if (all.some((r) => r.width > 0 && r.width < maxSpan)) makeWait(ws, w, now, ctl, waitOpts);
      continue;
    }
    // The calls planned: a read that got nowhere last time is planned one
    // probe (anything past it is overrun), the rest what they need.
    if (!ws.ep) ws.ep = { pl: all.reduce((n, r) => n + (r.stalled ? probeCalls(r) : planCalls(r)), 0), sp: 0, t: now };
    else ws.ep.pl += all.filter((r) => !r.seg).reduce((n, r) => n + planCalls(r), 0);
    stats.payers += ps.length;
    stats.resumed += p1.was.length;
    plan.set(w, p1);
  }
  const acct = (w) => state.wallets.get(w).ep;
  const common = { rpc, token: tok, budget, walletChunk, payerChunk, minRangeBlocks, onProgress, stats, maxSpanBlocks: maxSpan, walletMaxCalls, walletMaxPlan, ctl, stopOnRangeLimit: true, acct, now };
  // ONE schedule for both directions (see ONE WALLET CANNOT SPEND THE READS):
  // the step taken next is always the least-overrun job of either reader, so
  // a wallet's read 2 (planned work) goes before another wallet's splits of
  // read 1. A wallet's read 2 is queued the moment its read 1 is complete;
  // ties go to read 1.
  const a = pairsReader({ ...common, dir: "out" });
  const b = pairsReader({ ...common, dir: "in" });
  a.add([...plan.values()].flatMap((p1) => p1.o));
  b.add([...plan.values()].flatMap((p1) => [...p1.c, ...p1.i]));
  const queueFunded = () => {
    const add = [];
    for (const [w, p1] of plan) {
      if (p1.iBuilt || !p1.o.every((r) => a.isDone(r))) continue;
      p1.iBuilt = true;
      if (!p1.ws.ep) continue; // stopped
      const funded = [...p1.fresh].filter((p) => p1.o.some((r) => a.hasLogs(r, p)));
      stats.funded += funded.length;
      const coveredI = new Set(p1.i.flatMap((r) => r.payers));
      const rest = funded.filter((p) => !coveredI.has(p));
      if (!rest.length) continue;
      const r = req(w, "i", null, rest, from, windowStartBlock - 1, p1.startW);
      r.alone = p1.o.some((x) => x.alone);
      p1.i.push(r);
      p1.ws.ep.pl += planCalls(r);
      add.push(r);
    }
    if (add.length) b.add(add);
  };
  queueFunded();
  for (;;) {
    const ka = a.nextKey(), kb = b.nextKey();
    if (!ka && !kb) break;
    const best = compareKeys(ka, kb) <= 0 ? a : b;
    const res = await best.step();
    if (res === "halt") break;
    if (best === a) queueFunded();
  }
  const ra = a.result(), rb = b.result();
  const overShare = new Set([...ra.overShare, ...rb.overShare]), gaveUp = new Set([...ra.gaveUp, ...rb.gaveUp]), hopeless = new Set([...ra.tooLarge, ...rb.tooLarge]);
  const stoppedW = new Set([...overShare, ...gaveUp, ...hopeless]);
  // A budget ran out (the scan's, or the day's) with wallets unfinished: those
  // that have spent their fair slice of the overrun wait (see cutShortOf).
  const unfinished = new Set();
  for (const [w, p1] of plan) if (!stoppedW.has(w) && ([...p1.o, ...p1.i, ...p1.c].some((r) => !r.done) || !p1.iBuilt)) unfinished.add(w);
  const cut = a.haltedFor() === "budget" || b.haltedFor() === "budget" ? new Set(cutShortOf(unfinished, acct)) : new Set();
  const histories = new Map();
  for (const [w, p1] of plan) {
    const ws = p1.ws;
    const reqs = [...p1.o, ...p1.i, ...p1.c];
    saveSegments(ws, p1.was, reqs, (r) => (r.kind === "c" ? r.h : -1));
    if (stoppedW.has(w) || cut.has(w)) {
      makeWait(ws, w, now, ctl, waitOpts);
      if (cut.has(w)) stats.cutShort++;
      stats.failed++;
      continue;
    }
    if (unfinished.has(w)) { stats.failed++; continue; }
    const funds = new Map(), ins = new Map(), credits = new Map();
    for (const r of p1.o) for (const [p, list] of r.out) if (p1.fresh.has(p)) funds.set(p, [...(funds.get(p) || []), ...list].sort((x, y) => x[0] - y[0]));
    for (const r of p1.i) for (const [p, list] of r.out) if (p1.fresh.has(p)) ins.set(p, [...(ins.get(p) || []), ...list].sort((x, y) => x[0] - y[0]));
    for (const r of p1.c) { for (const p of r.payers) if (!credits.has(p)) credits.set(p, []); for (const [p, list] of r.out) credits.set(p, [...credits.get(p), ...list].sort((x, y) => x[0] - y[0])); }
    histories.set(w, { upTo: ws.cursor, covered: new Set(p1.o.flatMap((r) => r.payers)), funds, ins, credits });
    stats.read++;
  }
  stats.overShare = overShare.size; stats.gaveUp = gaveUp.size; stats.tooLarge += hopeless.size;
  stats.stopped = ctl.stop;
  stats.dayCapReached = !!ctl.dayCapped;
  noteDay(state, now, stats.calls);
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
// It shares each wallet's read accounting with the history read, and resumes
// the same way.
export async function readFundingGaps({ rpc, token, state, wallets = [], windowStartBlock, maxCalls = FUNDING_DEFAULTS.maxCalls, minRangeBlocks = FUNDING_DEFAULTS.minRangeBlocks, payerChunk = FUNDING_DEFAULTS.payerChunk, walletChunk = FUNDING_DEFAULTS.walletChunk, walletMaxCalls = FUNDING_DEFAULTS.walletMaxCalls, retryBackoffMs = FUNDING_DEFAULTS.retryBackoffMs, maxRetryBackoffMs = FUNDING_DEFAULTS.maxRetryBackoffMs, dayMaxCalls = FUNDING_DEFAULTS.dayMaxCalls, scanMaxCalls = maxCalls, now = Date.now(), ctl = newFundingReadControl(), onProgress = () => {} } = {}) {
  const tok = lower(token);
  const stats = { calls: 0, refusals: 0, wallets: 0, read: 0, failed: 0, overShare: 0, gaveUp: 0, cutShort: 0, tooLarge: 0, waiting: 0, resumed: 0, events: 0, budgetExhausted: false, dayCapReached: false, transportError: null };
  const gaps = new Map();
  const budget = { calls: 0, max: Math.max(0, maxCalls) };
  openDay(ctl, state, now, dayMaxCalls);
  const walletMaxPlan = Math.max(1, scanMaxCalls);
  const waitOpts = { retryBackoffMs, maxRetryBackoffMs };
  let seq = 0;
  const plan = new Map(); // wallet -> { ws, need, reqs, was }
  for (const w0 of wallets) {
    const w = lower(w0);
    const ws = state.wallets.get(w);
    const n = gapNeeded(ws, windowStartBlock);
    if (!n || plan.has(w)) continue;
    // Progress of a gap that no longer starts where it did (the pools moved) is stale.
    ws.hp = ws.hp.filter((g) => g.k !== "g" || g.h === n.from);
    if (!mayRead(ws, w, now, ctl, stats, retryBackoffMs)) continue;
    stats.wallets++;
    const payers = [...ws.pairs.keys()];
    const pset = new Set(payers), cov = new Set();
    const startW = ws.st > 0 && ws.hw > 0 ? ws.hw : 0;
    const reqs = [], was = [];
    const mk = (seg, ps, lo, width) => ({ key: `g${++seq}`, kind: "g", w, seg, payers: ps, lo, hi: n.to, width, logs: seg ? segmentLogs(seg) : null, stalled: !!seg && !seg.pg });
    for (const g of ws.hp) if (g.k === "g" && g.p.some((p) => pset.has(p))) { reqs.push(mk(g, g.p, g.lo, g.w)); was.push(g); for (const p of g.p) cov.add(p); }
    const rest = payers.filter((p) => !cov.has(p));
    if (rest.length) reqs.push(mk(null, rest, n.from, startW));
    const planCalls = (r) => plannedCalls(r.hi - r.lo + 1, r.width, r.payers.length, payerChunk);
    for (const q of reqs) q.alone = ws.st > 0 || was.length > 0;
    const need = reqs.reduce((x, r) => x + planCalls(r), 0);
    if (need > walletMaxPlan) { stats.tooLarge++; makeWait(ws, w, now, ctl, waitOpts); continue; }
    if (!ws.ep) ws.ep = { pl: reqs.reduce((x, r) => x + (r.stalled ? probeCalls(r) : planCalls(r)), 0), sp: 0, t: now };
    else ws.ep.pl += reqs.filter((r) => !r.seg).reduce((x, r) => x + planCalls(r), 0);
    stats.resumed += was.length;
    plan.set(w, { ws, need: n, reqs, was });
  }
  const acct = (w) => state.wallets.get(w).ep;
  const r = pairsReader({ rpc, token: tok, dir: "in", budget, walletChunk, payerChunk, minRangeBlocks, onProgress, stats, walletMaxCalls, walletMaxPlan, ctl, stopOnRangeLimit: false, acct, now });
  r.add([...plan.values()].flatMap((x) => x.reqs));
  while ((await r.step()) === "ok");
  const res = r.result();
  const stoppedW = new Set([...res.overShare, ...res.gaveUp, ...res.tooLarge]);
  const unfinished = new Set();
  for (const [w, x] of plan) if (!stoppedW.has(w) && x.reqs.some((q) => !q.done)) unfinished.add(w);
  const cut = r.haltedFor() === "budget" ? new Set(cutShortOf(unfinished, acct)) : new Set();
  for (const [w, x] of plan) {
    saveSegments(x.ws, x.was, x.reqs, () => x.need.from);
    if (stoppedW.has(w) || cut.has(w)) { makeWait(x.ws, w, now, ctl, waitOpts); if (cut.has(w)) stats.cutShort++; stats.failed++; continue; }
    if (unfinished.has(w)) { stats.failed++; continue; }
    const ins = new Map();
    for (const q of x.reqs) for (const [p, list] of q.out) ins.set(p, [...(ins.get(p) || []), ...list].sort((a, b) => a[0] - b[0]));
    gaps.set(w, { toBlock: x.need.to, ins });
    stats.read++;
  }
  stats.overShare = res.overShare.size; stats.gaveUp = res.gaveUp.size; stats.tooLarge += res.tooLarge.size;
  stats.dayCapReached = !!ctl.dayCapped;
  noteDay(state, now, stats.calls);
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
        clearConsumedProgress(ws, { read: !!hist || !!gap });
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
// A wallet just worked: the progress it was worked from is spent (its payers
// are known, its credits and its gap accounted for), and when reads were
// needed for it and all completed, its read accounting starts over.
function clearConsumedProgress(ws, { read }) {
  const keep = [];
  for (const g of ws.hp || []) {
    if (g.k === "g") continue;
    const stay = (p) => (g.k === "c" ? ws.pairs.has(p) && !ws.pairs.get(p).h : !ws.known.has(p));
    if (g.p.every(stay)) { keep.push(g); continue; }
    const logs = segmentLogs(g);
    const payers = g.p.filter(stay);
    if (payers.length) keep.push(newSegment(g.k, g.h, payers, g.lo, g.w, new Map([...logs].filter(([p]) => payers.includes(p))), g.pg));
  }
  ws.hp = keep;
  if (read) { ws.ep = null; ws.st = 0; ws.hw = 0; }
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
