// Withdraw the Algorand accept from SUB-CENT routes while the facilitator's
// sponsored sub-cent allowance for our payTo is spent.
//
// WHY (2026-09-28). The Algorand facilitator sponsors the fee on every
// settlement and gives each payTo a monthly count of sponsored SUB-CENT
// settlements; at or above one cent it does not meter. Once the month's count
// is spent it refuses every sub-cent settle with `subcent_quota_exceeded`
// until the reset on the 1st. Our 402s kept OFFERING Algorand on sub-cent
// routes the whole time, and @x402/express runs the handler before it
// settles, so an outside buyer paying there was verified, SERVED, and then
// refused at settle: not charged, our upstream spend absorbed, and the settle
// breaker counted each one against the buyer. Measured: one buyer, 175
// served-then-refused sub-cent calls in 45 minutes.
//
// WHAT. Per request, after @x402/core builds the requirements list - the one
// object that is both the 402 and what a payment is matched against - drop an
// Algorand USDC requirement priced under one cent while its payTo is paused.
// Dropping it THERE drops it from both: an Algorand payment on a sub-cent
// route is then refused BEFORE the handler ("no matching requirements"), so
// nothing is served and nothing reaches the breaker, and the 402 lists the
// networks that will settle. A route of one cent or more keeps its Algorand
// accept. Same prototype seam as src/accept-output-schema.js.
//
// WHEN PAUSED. On evidence, never on a schedule:
//   - the facilitator's own /sponsorship/status for the payTo reads
//     usedMonth >= quota with no purchased Settlement Units (the rule the
//     paid canary and the weekly sweep already apply), read by a boot timer
//     every AVM_SPONSORSHIP_REFRESH_MS - NEVER on a request, so no request
//     waits on it and the free-tier egress probe cannot attribute it to a tool;
//   - or a settle came back `subcent_quota_exceeded`: the refusal itself, so
//     the pause starts at the first refused buyer even while the status read
//     lags or fails.
// Cleared by a status read STARTED after that evidence that shows headroom
// (used < quota, or purchased units), and by the UTC month turning (the
// allowance resets on the 1st). A status row LAST UPDATED in an earlier UTC
// month is not evidence about this one: the document carries no month field,
// and its `usedMonth` is a stored counter that may only roll over on the
// facilitator's next write - which a paused rail would never send. So after
// the 1st only a fresh `subcent_quota_exceeded` refusal (or a row the
// facilitator has rewritten this month) can pause again. FAILS OPEN: evidence older than
// AVM_SPONSORSHIP_STALE_MS (the status unreadable since) offers the rail
// again, so an unreachable status endpoint costs at most one refused settle
// per window, never a silently withdrawn rail. Transitions are logged once.
//
// The discovery surfaces (/api/pricing, /openapi.json, /.well-known/x402)
// describe the CONFIGURED rails and are left alone: the 402 is the live
// per-request offer (it already differs by route and by body), and a pause is
// published where configured-versus-offered already is, /api/rails.
// AVM_SUBCENT_GATE=off disarms the filter, the refusal flip and the timer.

const PATCHED = Symbol.for("agent402.avmSubcentGate");
export const ALGORAND_PREFIX = "algorand:";
/** USDC on Algorand, mainnet and testnet ASA ids - both six decimals, so one cent is 10000 base units. */
const USDC_ASA_IDS = new Set(["31566704", "10458941"]);
export const SUBCENT_ATOMIC = 10000n;

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
/** How often the boot timer re-reads the facilitator's sponsorship status. */
export const REFRESH_MS = num(process.env.AVM_SPONSORSHIP_REFRESH_MS, 90_000);
/** Evidence older than this no longer pauses anything (fail open). */
export const STALE_MS = num(process.env.AVM_SPONSORSHIP_STALE_MS, 10 * 60_000);

export function avmSubcentGateEnabled(env = process.env) {
  return String(env.AVM_SUBCENT_GATE || "").toLowerCase() !== "off";
}

/** Pure: the Algorand row of a /sponsorship/status document (usedMonth lives only there), or null. */
export function sponsorshipRowOf(json) {
  const rows = Array.isArray(json?.chains) ? json.chains : [];
  return rows.find((c) => c && c.chain === "algorand") || null;
}

const readable = (row) => !!row && Number.isFinite(Number(row.quota)) && Number.isFinite(Number(row.usedMonth));

/** Pure: the month's sponsored sub-cent allowance is spent and no purchased
 *  units remain. An unreadable row is NOT exhausted (fail open). */
export function isSponsorshipExhausted(row) {
  if (!readable(row)) return false;
  return Number(row.usedMonth) >= Number(row.quota) && !(Number(row.suBalance || 0) > 0);
}

export const utcMonthOf = (ms) => new Date(ms).toISOString().slice(0, 7);

/** Pure: the row was last written in an EARLIER UTC month than `now`, so its
 *  usedMonth describes that month, not this one. A row without a readable
 *  updatedTs is taken at its word (the rule the canaries already applied). */
export function isSponsorshipRowFromEarlierMonth(row, now = Date.now()) {
  const ts = Date.parse(String(row?.updatedTs ?? ""));
  return Number.isFinite(ts) && utcMonthOf(ts) < utcMonthOf(now);
}
const mask = (a) => { const s = String(a || ""); return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s; };

// payTo -> { exhausted, evidenceAt, source, detail, effective, pausedSince, lastRead }
const state = new Map();
let log = (msg) => console.warn(msg);
// Set once the filter is on the resource server's prototype: only then does a
// refusal the gate answers for actually leave the next 402.
let gateInstalled = false;
const entry = (payTo) => {
  const k = String(payTo);
  if (!state.has(k)) state.set(k, { exhausted: false, evidenceAt: 0, source: null, detail: null, effective: false, pausedSince: null, lastRead: null });
  return state.get(k);
};

/** Is the sub-cent Algorand accept withdrawn for this payTo right now? A read: logs nothing, fetches nothing. */
export function isSubcentPaused(payTo, now = Date.now()) {
  const s = state.get(String(payTo || ""));
  if (!s || !s.exhausted) return false;
  if (now - s.evidenceAt > STALE_MS) return false;               // stale evidence: fail open
  if (utcMonthOf(s.evidenceAt) !== utcMonthOf(now)) return false; // the allowance reset on the 1st
  return true;
}

/** Log ONE line per transition of the effective state. */
function reconcile(payTo, now) {
  const s = state.get(String(payTo));
  if (!s) return;
  const paused = isSubcentPaused(payTo, now);
  if (paused === s.effective) return;
  s.effective = paused;
  if (paused) {
    s.pausedSince = now;
    log(`[avm-subcent] Algorand PAUSED on routes priced under one cent (payTo ${mask(payTo)}): ${s.detail}. Routes of one cent and more keep Algorand; this is the facilitator's sponsored sub-cent allowance, not an outage.`);
  } else {
    s.pausedSince = null;
    const why = !s.exhausted ? "the facilitator reports headroom" : utcMonthOf(s.evidenceAt) !== utcMonthOf(now) ? "a new UTC month (the allowance resets)" : "the evidence went stale and the status is unreadable (failing open)";
    log(`[avm-subcent] Algorand OFFERED again on routes priced under one cent (payTo ${mask(payTo)}): ${why}.`);
  }
}

/**
 * Record a /sponsorship/status read. `readStartedAt` guards the one race that
 * matters: a read that began before a settle refusal cannot clear the pause
 * that refusal set. A row last updated in an earlier UTC month is not
 * evidence either way (see the header). Returns "exhausted" | "headroom" |
 * "unreadable" | "predates-refusal" | "earlier-month".
 */
export function noteSponsorshipStatus(payTo, row, { now = Date.now(), readStartedAt = now } = {}) {
  if (!payTo) return "unreadable";
  const s = entry(payTo);
  if (!readable(row)) {
    if (s.lastRead !== "unreadable") log(`[avm-subcent] sponsorship status for payTo ${mask(payTo)} unreadable - keeping the last evidence until it is ${Math.round(STALE_MS / 60_000)} min old, then offering Algorand on every route (fail open)`);
    s.lastRead = "unreadable";
    reconcile(payTo, now);
    return "unreadable";
  }
  if (isSponsorshipRowFromEarlierMonth(row, now)) {
    if (s.lastRead !== "earlier-month") log(`[avm-subcent] sponsorship status for payTo ${mask(payTo)} was last updated ${new Date(Date.parse(row.updatedTs)).toISOString()}, before this UTC month began - not evidence for this month; only a fresh subcent_quota_exceeded refusal can pause sub-cent Algorand until the facilitator rewrites it`);
    s.lastRead = "earlier-month";
    reconcile(payTo, now);
    return "earlier-month";
  }
  s.lastRead = "ok";
  const exhausted = isSponsorshipExhausted(row);
  if (!exhausted && s.exhausted && s.source === "settle-refusal" && readStartedAt < s.evidenceAt) {
    reconcile(payTo, now);
    return "predates-refusal";
  }
  s.exhausted = exhausted;
  s.evidenceAt = now;
  s.source = "facilitator-status";
  s.detail = `the facilitator's status reads ${Number(row.usedMonth)}/${Number(row.quota)} sponsored sub-cent settlements used this month and no purchased units`;
  reconcile(payTo, now);
  return exhausted ? "exhausted" : "headroom";
}

/** A settle refused for the sub-cent allowance pauses that payTo at once. Returns true when it did. */
export function noteAvmSettleRefusal({ network, payTo, reason, now = Date.now() } = {}) {
  if (!avmSubcentGateEnabled()) return false;
  if (!String(network || "").startsWith(ALGORAND_PREFIX) || !payTo) return false;
  if (!/subcent_quota_exceeded/i.test(String(reason || ""))) return false;
  const s = entry(payTo);
  s.exhausted = true;
  s.evidenceAt = now;
  s.source = "settle-refusal";
  s.detail = "a settlement came back subcent_quota_exceeded";
  reconcile(payTo, now);
  return true;
}

/**
 * A settle receipt (decoded PAYMENT-RESPONSE) that THIS gate answers for: an
 * Algorand settle refused `subcent_quota_exceeded` while the gate is armed and
 * installed and a payTo is paused right now. The settle-failure hook has
 * already paused that payTo (it runs before the response is written), so the
 * next sub-cent 402 no longer offers Algorand and the loop is closed here.
 * The settle breaker uses this, and only this, to keep such a refusal off the
 * BUYER's count. Every other billing refusal - another network, another
 * facilitator, the gate switched off - has nothing withdrawing its offer, so
 * the breakers' bounds stay on it.
 */
export function isWithdrawnSubcentRefusal(receipt, now = Date.now()) {
  if (!gateInstalled || !avmSubcentGateEnabled()) return false;
  if (!receipt || typeof receipt !== "object" || receipt.success !== false) return false;
  if (!String(receipt.network || "").startsWith(ALGORAND_PREFIX)) return false;
  if (!/subcent_quota_exceeded/i.test(`${receipt.errorReason || ""} ${receipt.errorMessage || ""}`)) return false;
  for (const payTo of state.keys()) if (isSubcentPaused(payTo, now)) return true;
  return false;
}

/** Pure: an Algorand USDC requirement priced under one cent. Anything unreadable is not. */
export function isAvmSubcentRequirement(r) {
  if (!r || typeof r !== "object" || !String(r.network || "").startsWith(ALGORAND_PREFIX)) return false;
  if (!USDC_ASA_IDS.has(String(r.asset ?? ""))) return false;
  let amount;
  try { amount = BigInt(String(r.amount ?? r.maxAmountRequired)); } catch { return false; }
  return amount < SUBCENT_ATOMIC;
}

/** Pure: `requirements` minus the sub-cent Algorand ones whose payTo is paused.
 *  Never returns an empty list (a 402 nobody can pay is worse than one rail
 *  that will refuse), and returns the SAME array when nothing is dropped. */
export function withoutPausedSubcentAvm(requirements, isPaused = isSubcentPaused) {
  if (!Array.isArray(requirements)) return requirements;
  const kept = requirements.filter((r) => !(isAvmSubcentRequirement(r) && isPaused(r.payTo)));
  return kept.length === requirements.length || kept.length === 0 ? requirements : kept;
}

/** Install once on the resource server class (idempotent). Returns true when it patched. */
export function installAvmSubcentGate(ResourceServerClass) {
  const proto = ResourceServerClass?.prototype;
  if (!proto || typeof proto.buildPaymentRequirementsFromOptions !== "function") return false;
  if (proto.buildPaymentRequirementsFromOptions[PATCHED]) { gateInstalled = true; return false; }
  const orig = proto.buildPaymentRequirementsFromOptions;
  const build = async function buildPaymentRequirementsFromOptions(paymentOptions, context) {
    const requirements = await orig.call(this, paymentOptions, context);
    try { return withoutPausedSubcentAvm(requirements); } catch { return requirements; }
  };
  // Carry the inner patch's own marker (accept-output-schema) so its
  // install-once check still sees itself through this wrapper.
  for (const sym of Object.getOwnPropertySymbols(orig)) build[sym] = orig[sym];
  build[PATCHED] = true;
  proto.buildPaymentRequirementsFromOptions = build;
  gateInstalled = true;
  return true;
}

/**
 * The boot timer that reads /sponsorship/status. Unref'd, one read in flight
 * at a time, each bounded by `timeoutMs`; every tick also reconciles, so a
 * staleness or month transition is logged within one interval. Returns stop().
 */
export function startAvmSponsorshipRefresher({ facilitatorUrl, payTos, intervalMs = REFRESH_MS, firstDelayMs = 2_000, timeoutMs = 5_000, fetchImpl = globalThis.fetch } = {}) {
  const list = [...new Set((payTos || []).map((p) => String(p || "").trim()).filter(Boolean))];
  if (!facilitatorUrl || !list.length || typeof fetchImpl !== "function") return () => {};
  const base = String(facilitatorUrl).replace(/\/+$/, "");
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const payTo of list) {
        const readStartedAt = Date.now();
        let row = null;
        try {
          const r = await fetchImpl(`${base}/sponsorship/status?wallet=${encodeURIComponent(payTo)}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
          if (r.ok) row = sponsorshipRowOf(await r.json());
        } catch { row = null; }
        noteSponsorshipStatus(payTo, row, { now: Date.now(), readStartedAt });
      }
    } finally { running = false; }
  };
  const first = setTimeout(tick, firstDelayMs);
  const every = setInterval(tick, intervalMs);
  first.unref?.();
  every.unref?.();
  return () => { clearTimeout(first); clearInterval(every); };
}

/** For /api/rails: status words and times only - never a payTo, never the counts. */
export function avmSubcentOfferStatus(now = Date.now()) {
  let since = null, source = null;
  for (const [payTo, s] of state) {
    if (!isSubcentPaused(payTo, now)) continue;
    if (since === null || (s.pausedSince ?? now) < since) { since = s.pausedSince ?? now; source = s.source; }
  }
  if (since === null) return [];
  return [{
    network: "algorand",
    scope: "routes priced under one cent",
    status: "paused",
    since: new Date(since).toISOString(),
    source,
    reason: "the facilitator's sponsored allowance for sub-cent settlements is spent for this month; routes of one cent and more still take Algorand",
    resumes: "when the facilitator reports headroom, and no later than the first day of the next UTC month",
  }];
}

/** Test-only. `installed` overrides the install flag (the prototype patch
 *  itself is process-wide and cannot be undone). */
export function _resetAvmSponsorshipForTest({ logger, installed } = {}) {
  state.clear();
  log = logger || ((msg) => console.warn(msg));
  if (typeof installed === "boolean") gateInstalled = installed;
}
