// A wallet's concurrent paid runs must be covered by its balance TOGETHER.
//
// The facilitator verifies each EIP-3009 authorization on its own, against the
// wallet's balance at that moment, and settlement happens after the handler.
// This check adds the sum: for the expensive routes (EXPENSIVE_COMPOSITE_SLUGS:
// the reports and the media tiers), a run that would be this wallet's second
// or later in flight is admitted only when the wallet's balance on the paying
// chain covers every run it has in flight plus this one. That is exactly the
// set of runs that can all settle. A buyer whose balance covers what they start is never refused;
// a run the balance cannot also cover could never have been paid for, and is
// refused before it starts (429, nothing runs, nothing is charged) instead of
// after the work is done.
//
// Scope and cost:
//   - Only an EVM payment whose signed payer is known: an EIP-3009
//     authorization or a Permit2 authorization, the two shapes the exact
//     scheme's verify accepts; every expensive route is EVM exact only.
//     Credits holds its price at authorize and needs nothing here.
//   - The first run in flight needs no read: verify already proved the
//     balance covers it. A later one reads balanceOf once, cached for a few
//     seconds and shared by concurrent callers, so a burst costs one read.
//   - An unreadable balance (RPC down, the read lane full) admits up to
//     INFLIGHT_COVER_UNREAD_MAX runs in flight (default 4) and refuses beyond.
//   - A run leaves the ledger when its response ends, however it ends
//     (src/hangup-settlement.js onResponseEnd), which is after settlement.
//   - Between its handler's return and its response's end a run is SETTLING:
//     its payment may already be taken on chain, so a balance read then can
//     reflect it while the ledger still counts it. A run the balance would
//     not cover while another is settling waits for that one to leave the
//     ledger (at most SETTLE_WAIT_MS) and is judged again.
// INFLIGHT_COVER=off disables the check.

import { paymentHeaderOf } from "./payer.js";

const CHAIN_BY_CAIP2 = Object.freeze({
  "eip155:8453": "base", "eip155:137": "polygon", "eip155:42161": "arbitrum", "eip155:143": "monad",
  "eip155:42220": "celo", "eip155:43114": "avalanche", "eip155:1329": "sei", "eip155:10": "optimism",
  "eip155:4663": "robinhood",
});
const CAIP2_BY_NAME = Object.freeze(Object.fromEntries(Object.entries(CHAIN_BY_CAIP2).map(([c, n]) => [n, c])));

const CACHE_MS = 10_000;
const READ_TIMEOUT_MS = 2_500;
const MAX_READS_IN_FLIGHT = 8;
const SETTLE_WAIT_MS = 5_000;
const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^\d{1,78}$/;

const ledger = new Map(); // coverKey -> { count, atomic: bigint, settling }
const waiters = new Map(); // coverKey -> Set<() => void>, woken when a run leaves
const balances = new Map(); // coverKey -> { atomic: bigint, at }
const pendingReads = new Map(); // coverKey -> Promise<bigint|null>
let readsInFlight = 0;
const stats = { admitted: 0, admittedByRead: 0, admittedUnread: 0, refused: 0, refusedUnread: 0, settleWaits: 0 };

function unreadMax() {
  const n = Number(process.env.INFLIGHT_COVER_UNREAD_MAX);
  return Number.isInteger(n) && n >= 1 ? n : 4;
}
export function inflightCoverEnabled() {
  return String(process.env.INFLIGHT_COVER || "").trim().toLowerCase() !== "off";
}

/**
 * What an x402 payment header commits: { payer, network, asset, atomic }, all
 * from the signed authorization (EIP-3009, or Permit2 with its permitted
 * amount) and the accept it answered, or null when the header is neither.
 * Read after the paywall verified it. Pure; exported for the test.
 */
export function coverTermsOf(headerValue) {
  if (typeof headerValue !== "string" || !headerValue) return null;
  let p;
  try { p = JSON.parse(Buffer.from(headerValue, "base64").toString("utf8")); } catch { return null; }
  const inner = p?.payload;
  let payer, value;
  if (inner?.authorization && typeof inner.authorization === "object") {
    payer = String(inner.authorization.from || "");
    value = String(inner.authorization.value ?? "");
  } else if (inner?.permit2Authorization && typeof inner.permit2Authorization === "object") {
    payer = String(inner.permit2Authorization.from || "");
    value = String(inner.permit2Authorization.permitted?.amount ?? "");
  } else return null;
  if (!HEX_ADDR.test(payer) || !UINT.test(value)) return null;
  const network = typeof p?.accepted?.network === "string" ? p.accepted.network
    : (CAIP2_BY_NAME[String(p?.network || "").toLowerCase()] || null);
  if (!network || !Object.hasOwn(CHAIN_BY_CAIP2, network)) return null;
  const asset = typeof p?.accepted?.asset === "string" && HEX_ADDR.test(p.accepted.asset) ? p.accepted.asset.toLowerCase() : null;
  return { payer: payer.toLowerCase(), network, asset, atomic: BigInt(value) };
}

/** balanceOf(owner) on the paying chain, or null when it cannot be read. */
export async function readTokenBalance({ network, asset, payer }) {
  const chain = CHAIN_BY_CAIP2[network];
  if (!chain) return null;
  const { EVM, rpcCall } = await import("./revenue-live.js");
  const cfg = EVM[chain];
  const token = asset || cfg?.token;
  if (!cfg || !token || !HEX_ADDR.test(token)) return null;
  // Base reads go where every other Base read of ours goes (AGENT402_BASE_RPC
  // when set), so one variable points them all at a node.
  const base = String(process.env.AGENT402_BASE_RPC || "").trim();
  const rpcs = chain === "base" && base ? [base] : cfg.rpcs;
  const data = "0x70a08231" + payer.slice(2).toLowerCase().padStart(64, "0");
  const hex = await rpcCall(rpcs, "eth_call", [{ to: token, data }, "latest"], READ_TIMEOUT_MS);
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(hex)) return null;
  return BigInt(hex);
}

let reader = readTokenBalance;
/** Test seam. */
export function _setBalanceReaderForTest(fn) { reader = typeof fn === "function" ? fn : readTokenBalance; }

async function balanceFor(coverKey, terms, now) {
  const hit = balances.get(coverKey);
  if (hit && now - hit.at < CACHE_MS) return hit.atomic;
  if (pendingReads.has(coverKey)) return pendingReads.get(coverKey);
  if (readsInFlight >= MAX_READS_IN_FLIGHT) return null; // never queue: a full lane reads as unknown
  readsInFlight++;
  const p = (async () => {
    try {
      const atomic = await reader(terms);
      if (typeof atomic === "bigint" && atomic >= 0n) { balances.set(coverKey, { atomic, at: Date.now() }); return atomic; }
      return null;
    } catch { return null; }
    finally { readsInFlight--; pendingReads.delete(coverKey); }
  })();
  pendingReads.set(coverKey, p);
  return p;
}

/** Resolves when a run leaves `coverKey`'s ledger, or after `ms`. */
function nextRelease(coverKey, ms) {
  return new Promise((resolve) => {
    const set = waiters.get(coverKey) || new Set();
    waiters.set(coverKey, set);
    const done = () => {
      clearTimeout(timer);
      set.delete(done);
      if (!set.size && waiters.get(coverKey) === set) waiters.delete(coverKey);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    set.add(done);
  });
}

/**
 * Admit a paid run into this wallet's in-flight ledger, or refuse it.
 * Resolves to a release function (call it once when the response ends), or to
 * null when the payment is not one this check covers. Throws a 429 when the
 * wallet's balance does not cover this run on top of its runs in flight.
 * The release function carries settling(): call it when the run's handler has
 * returned and its settlement is under way.
 */
export async function admitCoveredRun(req, { now = Date.now(), settleWaitMs = SETTLE_WAIT_MS } = {}) {
  if (!inflightCoverEnabled()) return null;
  const terms = coverTermsOf(paymentHeaderOf(req));
  if (!terms) return null;
  const coverKey = `${terms.network}|${terms.asset || "-"}|${terms.payer}`;
  const waitUntil = Date.now() + settleWaitMs;
  let at = now;
  for (;;) {
    const held = ledger.get(coverKey);
    if (!held || held.count <= 0) break;
    const balance = await balanceFor(coverKey, terms, at);
    // Re-read the ledger AFTER the await: other runs may have been admitted
    // meanwhile, and the check and the admission must see the same numbers.
    const cur = ledger.get(coverKey) || { count: 0, atomic: 0n, settling: 0 };
    if (cur.count <= 0) break;
    const need = cur.atomic + terms.atomic;
    const unread = balance === null;
    const covered = unread ? cur.count < unreadMax() : balance >= need;
    if (covered) {
      if (unread) stats.admittedUnread++; else stats.admittedByRead++;
      break;
    }
    // A settling run may already be paid for on chain while it still counts
    // here: wait for it to leave, then judge again against a fresh read.
    if (!unread && cur.settling > 0 && Date.now() < waitUntil) {
      stats.settleWaits++;
      await nextRelease(coverKey, waitUntil - Date.now());
      at = Date.now();
      continue;
    }
    stats.refused++;
    if (unread) stats.refusedUnread++;
    const e = new Error(unread
      ? `This wallet already has ${cur.count} paid runs in progress here, and its balance could not be read to confirm it also covers this one. Retry when one of them finishes. You have not been charged.`
      : `This wallet already has ${cur.count} paid runs in progress here, and its balance does not cover this one as well. Each payment is checked on its own, but settling them all needs the sum. Retry when one of them finishes, or add funds. You have not been charged.`);
    e.statusCode = 429;
    e.retryAfter = 30;
    throw e;
  }
  const entry = ledger.get(coverKey) || { count: 0, atomic: 0n, settling: 0 };
  entry.count += 1;
  entry.atomic += terms.atomic;
  ledger.set(coverKey, entry);
  stats.admitted++;
  let released = false, settling = false;
  const release = () => {
    if (released) return;
    released = true;
    const e = ledger.get(coverKey);
    if (e) {
      e.count -= 1;
      e.atomic -= terms.atomic;
      if (settling) e.settling -= 1;
      if (e.count <= 0) ledger.delete(coverKey);
    }
    // The balance has likely moved (this run settled, or failed to): the next
    // concurrent check reads it again.
    balances.delete(coverKey);
    const set = waiters.get(coverKey);
    if (set) for (const wake of [...set]) wake();
  };
  release.settling = () => {
    if (released || settling) return;
    settling = true;
    const e = ledger.get(coverKey);
    if (e) e.settling += 1;
  };
  return release;
}

/** Counts only - never a wallet. */
export function inflightCoverStatus() {
  let runs = 0;
  for (const e of ledger.values()) runs += e.count;
  return { enabled: inflightCoverEnabled(), walletsInFlight: ledger.size, runsInFlight: runs, unreadMax: unreadMax(), ...stats };
}

/** Test-only. */
export function _resetInflightCoverForTest() {
  ledger.clear(); balances.clear(); pendingReads.clear(); readsInFlight = 0; reader = readTokenBalance;
  for (const set of waiters.values()) for (const wake of [...set]) wake();
  waiters.clear();
  for (const k of Object.keys(stats)) stats[k] = 0;
}
