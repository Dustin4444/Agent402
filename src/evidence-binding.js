// Shared-wallet evidence, bound to the wallet it belongs to (2026-09-03).
//
// The router's Base gate reads three kinds of evidence per origin:
//   - the committed seed (SOR_SEED_ORIGINS) and the chain join on the origin's
//     OWN advertised Base address (provenByChain): the origin's own evidence;
//   - the x402 leaderboard, whose rows are keyed by payTo WALLET and carry
//     every origin whose registry listing names that wallet; and
//   - the Bazaar's per-resource quality counts, which arrive with the payTo
//     each listed resource declares.
// The last two are SHARED-WALLET evidence: an origin is credited with a
// wallet's history because it CLAIMED the wallet in a listing, and a listing
// is a document anyone can write. A fresh origin naming a heavily paid
// third-party wallet cleared the Base floor on that wallet's history, showed
// no address of its own for the chain-join belt to bind, and was paid at
// whatever address its live 402 named (security review 2026-09-02/03).
//
// This module keeps the wallets beside the counts, so the resolver can require
// the origin's LIVE 402 to pay one of them before the inherited history counts.
// Pure functions over plain inputs, so the shape can be tested with a fake
// leaderboard row and a fake 402 and no server.
import { dispatchEligibility } from "./dispatch-eligibility.js";
import { payToFromLive402 } from "./settlement-proof.js";

const norm = (u) => String(u || "").replace(/\/+$/, "").toLowerCase();
const evmKey = (a) => (typeof a === "string" && /^0x[0-9a-f]{40}$/i.test(a) ? a.toLowerCase() : null);

/**
 * origin -> { payTos: Set<wallet>, ownSettled, ownPayers }
 *
 * @param {object} o
 * @param {Record<string,number>} o.seedOrigins   SOR_SEED_ORIGINS (origin -> settled), own evidence
 * @param {Array} o.leaderboardRows               x402 leaderboard rows: { origins[], wallet, wallets[] }
 * @param {Array<[string, object]>} o.bazaarQuality  bazaarQualityEntries(): [origin, { calls30d, payers30d, payTos[] }]
 * @param {Map<string, object>} [o.chainProven]   provenByChain(): origin -> { settled, payers, payTo }, own evidence
 */
export function buildEvidenceBinding({ seedOrigins = {}, leaderboardRows = [], bazaarQuality = [], chainProven = null } = {}) {
  const m = new Map();
  const ent = (o) => {
    const k = norm(o);
    if (!m.has(k)) m.set(k, { payTos: new Set(), ownSettled: 0, ownPayers: undefined });
    return m.get(k);
  };
  for (const [o, c] of Object.entries(seedOrigins || {})) {
    if (!o) continue;
    const e = ent(o);
    e.ownSettled = Math.max(e.ownSettled, Number(c) || 0);
  }
  for (const row of Array.isArray(leaderboardRows) ? leaderboardRows : []) {
    const wallets = (Array.isArray(row?.wallets) && row.wallets.length ? row.wallets : [row?.wallet]).map(evmKey).filter(Boolean);
    const origins = Array.isArray(row?.origins) ? row.origins : (row?.homepage ? [row.homepage] : []);
    for (const o of origins) {
      if (!o) continue;
      const e = ent(o);
      for (const w of wallets) e.payTos.add(w);
    }
  }
  for (const [o, q] of Array.isArray(bazaarQuality) ? bazaarQuality : []) {
    if (!o || !q || !(Number(q.calls30d) > 0 || Number(q.payers30d) > 0)) continue;
    const e = ent(o);
    for (const w of (Array.isArray(q.payTos) ? q.payTos : []).map(evmKey).filter(Boolean)) e.payTos.add(w);
  }
  if (chainProven instanceof Map) {
    for (const [o, ev] of chainProven) {
      if (!o || !ev) continue;
      const e = ent(o);
      e.ownSettled = Math.max(e.ownSettled, Number(ev.settled) || 0);
      if (ev.payers != null) e.ownPayers = Math.max(Number(e.ownPayers ?? 0), Number(ev.payers) || 0);
    }
  }
  return m;
}

/**
 * The resolver's post-probe Base verdict for one candidate, ONE implementation
 * shared with the test: the same dispatchEligibility call the pre-probe filter
 * ran, now with the origin's binding and the address its live 402 named.
 *
 *   { ok: true }                                  - pay it
 *   { ok: false, detail, livePayTo, payTos }      - skip it, and why
 *
 * `livePayTo` may be passed decoded, or read from the probe's `header` / `body`.
 */
export function baseLiveGate({ networks, settled, payers, priceUsd, urlTemplate = false, minSettled, minPayers, binding, livePayTo, header, body } = {}) {
  const live = livePayTo !== undefined ? livePayTo : payToFromLive402({ header, body });
  const v = dispatchEligibility({
    routable: true, networks, settled, payers, priceUsd, urlTemplate: !!urlTemplate,
    spendChains: ["base"], minSettled, minPayers,
    ...(binding ? { evidence: binding, livePayTo: live } : {}),
  });
  const base = v.chains?.base || {};
  if (base.eligible === true) return { ok: true, livePayTo: live };
  return { ok: false, detail: base.detail || base.reason || v.reason, livePayTo: live, payTos: binding ? [...(binding.payTos || [])] : [] };
}
