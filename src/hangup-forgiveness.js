// A buyer who leaves before the answer is ready is not charged, within a
// budget (src/hangup-settlement.js is the rule; this module is its bound).
//
// Why a budget: not settling an abandoned run means the work was done and
// nobody paid. For an honest client whose timeout is shorter than a long
// route that is the right answer, and the only alternative - settle, then book
// the charge as owed and refund it - is the refund this rule exists to avoid.
// But a hang-up costs the caller nothing, so on its own it is a free run on
// repeat. The bound is money, not a refusal:
//
//   - A paid request reserves a forgiveness TICKET when its handler starts,
//     priced at what it would be charged. The ticket is granted only while
//     every key the request carries (the verified payer AND the client IP) and
//     the whole service stay inside their budgets for the window, counting
//     both runs still in flight and runs already abandoned. In-flight runs
//     count, so a burst of concurrent hang-ups cannot all be granted. A route
//     whose effect outlives the answer (a memory write, an attestation, a
//     stored verdict, a purchase from an outside seller) never gets one.
//   - A run whose buyer left before the first byte is recorded as ABANDONED
//     under every key it carried and globally. Nothing clears that record
//     except time: a paid success does not, because a success is exactly what
//     an attacker would interleave to reset a counter.
//   - With a granted ticket, a hang-up is not settled (no charge, no refund).
//     WITHOUT one - the budget is spent, for this wallet, this IP or everyone
//     - the request is served exactly as before this rule existed: the rail
//     settles the <400 response, and the charge the buyer never received is
//     booked as owed in the refund ledger. Nobody is ever refused service by
//     this module; running out of budget only puts the cost back on the
//     buyer, where the refund pipeline's own caps and human review apply.
//
// Keys are verified identities only: the signed EIP-3009 payer, the sender
// RECOVERED from a Tempo transaction's signature, or the credits key, plus
// always the client IP. A client-supplied field (a Tempo credential's
// `source`) is never a key, because choosing a fresh key per request is how a
// per-key bound is walked around.
//
// In memory, like the settle breaker and the composite guard: a restart
// resets the window. Money is counted in integer micro-dollars.

const MICRO = 1_000_000;
const MAX_KEYS = 20_000;

// Default budgets, per 24 h window, sized for micro-transactions: most
// catalog calls cost a fraction of a cent, so a quarter per key still covers
// dozens of abandoned runs from an honest short-timeout client, and the
// service-wide figure bounds what everyone together can walk away from. A
// single call priced above the per-key budget (a report, a card charge, the
// dearer router tiers) is never forgiven: its hang-up is settled and booked as
// owed, like any run past the budget. HANGUP_FORGIVE_KEY_USD and
// HANGUP_FORGIVE_GLOBAL_USD override them.
export const DEFAULT_KEY_BUDGET_USD = 0.25;
export const DEFAULT_GLOBAL_BUDGET_USD = 2;

// Routes whose effect persists whether or not the answer is delivered. Not
// settling an abandoned run is only right when the run left nothing behind
// but spent compute; on these the handler has already changed something that
// a hang-up does not undo, so they never take a ticket: a hang-up is settled
// and the undelivered answer booked as owed, as before the rule existed.
//   - the memory family's writers: the wallet's namespace (keys, counters,
//     grants, remembered documents) has changed;
//   - attest: an attestation on Base is permanent and paid for in gas;
//   - feedback: the verdict is stored against the sale;
//   - the route-execute tiers and seller-payability: they pay outside sellers
//     from our own wallet, and that payment is not returned.
// Readers in the same families (memory-read, memory-grants, memory-log,
// memory-recall, feedback-summary) leave nothing behind and follow the budget.
// scripts/test-hangup-settlement.js checks this list against the booted
// catalog: every slug must exist, every route-execute tier must be listed, and
// every memory route must be classified as a writer here or as a known reader.
const LASTING_EFFECT_SLUGS = new Set([
  "memory-write", "memory-incr", "memory-cas", "memory-grant", "memory-revoke", "memory-remember", "memory-forget",
  "attest",
  "feedback",
  "route-execute", "route-execute-plus", "route-execute-max", "route-execute-pro",
  "seller-payability",
]);
export const LASTING_EFFECT_SLUG_LIST = Object.freeze([...LASTING_EFFECT_SLUGS]);

/** True for a slug whose effect outlives an undelivered answer: never forgiven. */
export function hasLastingEffect(slug) {
  return typeof slug === "string" && LASTING_EFFECT_SLUGS.has(slug);
}

function envNumber(name, dflt) {
  const raw = String(process.env[name] ?? "").trim();
  if (raw === "") return dflt;
  const n = Number(raw);
  // A malformed value reads as unset, never as a wider budget.
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/** Call-time config (a test boot sets the env before it starts the server). */
export function hangupForgivenessConfig() {
  const off = String(process.env.HANGUP_FORGIVE || "").trim().toLowerCase() === "off";
  return {
    enabled: !off,
    keyMicro: Math.round(envNumber("HANGUP_FORGIVE_KEY_USD", DEFAULT_KEY_BUDGET_USD) * MICRO),
    globalMicro: Math.round(envNumber("HANGUP_FORGIVE_GLOBAL_USD", DEFAULT_GLOBAL_BUDGET_USD) * MICRO),
    windowMs: Math.max(1_000, envNumber("HANGUP_FORGIVE_WINDOW_MS", 24 * 60 * 60 * 1000)),
  };
}

const inflightByKey = new Map(); // key -> micro-dollars held by granted, unfinished runs
let globalInflight = 0;
const abandonedByKey = new Map(); // key -> [[t, micro], ...] oldest first
let globalAbandoned = []; // [[t, micro], ...] oldest first
let lastExhaustedLog = 0;

function prune(list, now, windowMs) {
  let i = 0;
  while (i < list.length && now - list[i][0] >= windowMs) i++;
  return i ? list.slice(i) : list;
}
function sumOf(list) { let s = 0; for (const [, m] of list) s += m; return s; }
function abandonedMicro(key, now, windowMs) {
  const list = abandonedByKey.get(key);
  if (!list) return 0;
  const kept = prune(list, now, windowMs);
  if (!kept.length) { abandonedByKey.delete(key); return 0; }
  if (kept !== list) abandonedByKey.set(key, kept);
  return sumOf(kept);
}
function evictIfFull() {
  if (abandonedByKey.size < MAX_KEYS) return;
  // Oldest insertion first. Forgetting a key only ever makes that key's next
  // run LESS likely to be refused forgiveness, and the global budget still
  // holds, so the bound the service relies on does not move.
  const drop = abandonedByKey.size - MAX_KEYS + 1;
  let n = 0;
  for (const k of abandonedByKey.keys()) { abandonedByKey.delete(k); if (++n >= drop) break; }
}

/** The ticket on a request, or null. Own property only: a polluted prototype
 *  must never make a request look forgiven (and therefore unsettled). */
function ticketOf(req) {
  if (!req || typeof req !== "object" || !Object.hasOwn(req, "__a402HangupTicket")) return null;
  const t = req.__a402HangupTicket;
  return t && typeof t === "object" ? t : null;
}

/** True when this request holds a GRANTED ticket: a close before the first
 *  byte cancels its charge. Every settlement point reads this through
 *  chargeCancelledForClientGone() in src/hangup-settlement.js. */
export function hangupForgiven(req) {
  return ticketOf(req)?.granted === true;
}

/** Why this request's ticket was denied ("lasting effect", "payer budget",
 *  ...), or null when it holds a granted ticket or none at all. For the log
 *  line that books an undelivered charge as owed. */
export function hangupTicketDenial(req) {
  const t = ticketOf(req);
  return t && t.granted !== true && typeof t.reason === "string" ? t.reason : null;
}

/**
 * Reserve a forgiveness ticket for a paid request whose handler is starting.
 * `keys` are the verified identities it carries (falsy entries dropped);
 * `priceUsd` is what it would be charged; `slug` is the catalog route, and a
 * slug with a lasting effect (hasLastingEffect) is always denied. Always
 * stores a ticket on the request (granted or not, with the reason) and
 * returns it.
 */
export function reserveHangupForgiveness(req, { keys = [], priceUsd = 0, slug = null, now = Date.now() } = {}) {
  const cfg = hangupForgivenessConfig();
  const uniq = [...new Set(keys.filter((k) => typeof k === "string" && k))];
  const micro = Math.max(0, Math.round(Number(priceUsd) * MICRO) || 0);
  const ticket = { granted: false, keys: uniq, micro, state: "denied", reason: null };
  const store = (t) => { if (req && typeof req === "object") Object.defineProperty(req, "__a402HangupTicket", { value: t, writable: true, configurable: true, enumerable: false }); return t; };
  if (!cfg.enabled) { ticket.reason = "disabled"; return store(ticket); }
  // Before any budget is read: a route that leaves something behind is never
  // forgiven, however much budget is left, and spends none of it.
  if (hasLastingEffect(slug)) { ticket.reason = "lasting effect"; return store(ticket); }
  if (!(micro > 0)) { ticket.reason = "no price"; return store(ticket); }
  // Every request carries at least the IP key; one that carries none is not
  // bounded per key, so it is never forgiven.
  if (!uniq.length) { ticket.reason = "no key"; return store(ticket); }
  globalAbandoned = prune(globalAbandoned, now, cfg.windowMs);
  if (globalInflight + sumOf(globalAbandoned) + micro > cfg.globalMicro) {
    ticket.reason = "global budget";
    if (now - lastExhaustedLog > 60_000) {
      lastExhaustedLog = now;
      console.warn("[hangup] forgiveness budget for the whole service is spent for this window: a buyer who leaves before the answer is charged and the charge booked as owed until it clears");
    }
    return store(ticket);
  }
  for (const k of uniq) {
    if ((inflightByKey.get(k) || 0) + abandonedMicro(k, now, cfg.windowMs) + micro > cfg.keyMicro) {
      ticket.reason = k.startsWith("ip:") ? "ip budget" : "payer budget";
      return store(ticket);
    }
  }
  for (const k of uniq) inflightByKey.set(k, (inflightByKey.get(k) || 0) + micro);
  globalInflight += micro;
  ticket.granted = true;
  ticket.state = "inflight";
  return store(ticket);
}

/**
 * Finish a request's ticket: `abandoned` when the buyer left before the first
 * byte (recorded under every key and globally, for the window), otherwise the
 * reservation is simply returned. Idempotent; a denied ticket holds nothing.
 */
export function settleHangupTicket(req, { abandoned = false, now = Date.now() } = {}) {
  const t = ticketOf(req);
  if (!t || !t.granted || t.state !== "inflight") return false;
  for (const k of t.keys) {
    const left = (inflightByKey.get(k) || 0) - t.micro;
    if (left > 0) inflightByKey.set(k, left); else inflightByKey.delete(k);
  }
  globalInflight = Math.max(0, globalInflight - t.micro);
  if (abandoned) {
    evictIfFull();
    for (const k of t.keys) { const list = abandonedByKey.get(k) || []; list.push([now, t.micro]); abandonedByKey.set(k, list); }
    globalAbandoned.push([now, t.micro]);
    t.state = "abandoned";
  } else {
    t.state = "released";
  }
  return true;
}

/** Counts for the operator surface: how much of the budget is in use. */
export function hangupForgivenessStatus(now = Date.now()) {
  const cfg = hangupForgivenessConfig();
  globalAbandoned = prune(globalAbandoned, now, cfg.windowMs);
  return {
    enabled: cfg.enabled,
    windowHours: Math.round((cfg.windowMs / 3_600_000) * 100) / 100,
    perKeyBudgetUsd: cfg.keyMicro / MICRO,
    globalBudgetUsd: cfg.globalMicro / MICRO,
    abandonedInWindow: globalAbandoned.length,
    abandonedUsdInWindow: sumOf(globalAbandoned) / MICRO,
    inflightUsd: globalInflight / MICRO,
    keysTracked: abandonedByKey.size,
    // Routes a hang-up is never forgiven on (their effect outlives the answer).
    neverForgiven: LASTING_EFFECT_SLUG_LIST,
  };
}

/** Test seam only. */
export function _resetHangupForgiveness() {
  inflightByKey.clear(); globalInflight = 0; abandonedByKey.clear(); globalAbandoned = []; lastExhaustedLog = 0;
}
