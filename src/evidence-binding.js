// Settlement evidence, bound to the WALLET it was measured at (2026-09-03,
// per wallet since 2026-09-28).
//
// The router's Base gate reads these kinds of evidence per origin:
//   - the committed seed (SOR_SEED_ORIGINS): origin -> count, no wallet;
//   - the chain join on the origin's OWN advertised Base address
//     (provenByChain), kept against that address;
//   - the x402 leaderboard, whose rows are keyed by operator and carry the
//     WALLETS they were paid at and every origin whose listing names one, with
//     the scan's per-wallet evidence beside them (getLeaderboardWalletEvidence);
//   - the Bazaar's per-resource quality counts, measured on the origin's own
//     URLs and split by the Base payTo each resource declares.
// Every figure is kept against the wallet it was measured at, and a wallet's
// figures count only for that wallet. The gate asks ONE question of the address
// the origin's live 402 asks to be paid at: does THAT wallet's own evidence
// clear the floor?
//
// Why per wallet and not "any wallet the origin was credited with": the
// 2026-09-03 form kept one UNION of wallets beside a MAX of counts, so an
// origin credited with a busy wallet W's history that also listed a resource
// at its own wallet V (one Bazaar call was enough to put V in the union)
// cleared the floor on W's history and was paid at V. A MAX taken per figure
// across wallets had the same shape one level down: W's call count and V's
// payer count could clear together although neither wallet cleared alone.
//
// A listing naming W can still be credited with W's evidence, and that is
// deliberate: the evidence then counts only where W is paid, so the money goes
// to W. The payer re-checks the accept it signs against the same wallets
// (payX402 `evidenceWallets`), so the probe's 402 and the payment's 402 cannot
// disagree about where the money goes.
//
// This is the ONE evidence builder: the settled and payers maps the gate reads
// are projections of what it returns. Pure functions over plain inputs, so the
// shape can be tested with a fake leaderboard row and a fake 402.
import { dispatchEligibility, evidencePayToVerdict } from "./dispatch-eligibility.js";
import { payToFromLive402, meetsRouterGate } from "./settlement-proof.js";

const norm = (u) => String(u || "").replace(/\/+$/, "").toLowerCase();
const evmKey = (a) => (typeof a === "string" && /^0x[0-9a-f]{40}$/i.test(a) ? a.toLowerCase() : null);

/** Fold one observation of wallet `w` into `map`: the larger count and the larger payer figure. */
function put(map, w, settled, payers) {
  if (!(Number(settled) > 0) && !(Number(payers) > 0)) return;
  const cur = map.get(w) || { settled: 0, payers: undefined };
  cur.settled = Math.max(cur.settled, Number(settled) || 0);
  if (Number(payers) > 0) cur.payers = Math.max(Number(cur.payers ?? 0), Number(payers));
  map.set(w, cur);
}

/** The per-wallet Bazaar split an origin's folded quality carries (x402-index foldBazaarQuality). */
export function bazaarByPayTo(q) {
  const split = q && typeof q === "object" ? q.byPayTo : null;
  if (split && typeof split === "object") return Object.entries(split);
  // No split (a quality object built before it existed, or by hand): the
  // counts can be attributed only when the resources declared ONE wallet.
  const payTos = (Array.isArray(q?.payTos) ? q.payTos : []).map(evmKey).filter(Boolean);
  return payTos.length === 1 ? [[payTos[0], { calls: q.calls30d, payers: q.payers30d }]] : [];
}

/** The per-wallet figures a leaderboard row contributes: the scan's per-wallet
 *  evidence when it has any of the row's wallets, else the row's totals when
 *  the row has exactly ONE wallet (they are then that wallet's), else nothing -
 *  a multi-wallet row's totals cannot be split between its wallets. */
export function rowWalletFigures(row, walletEvidence = null) {
  const wallets = [...new Set((Array.isArray(row?.wallets) && row.wallets.length ? row.wallets : [row?.wallet]).map(evmKey).filter(Boolean))];
  const evOf = (w) => {
    if (!walletEvidence) return null;
    const e = walletEvidence instanceof Map ? walletEvidence.get(w) : walletEvidence[w];
    return e && typeof e === "object" ? { settled: Number(e.callsSettled) || 0, payers: Number(e.uniqueBuyers) || 0 } : null;
  };
  const perWallet = wallets.map((w) => [w, evOf(w)]).filter(([, e]) => e);
  if (perWallet.length) return perWallet;
  if (wallets.length === 1) return [[wallets[0], { settled: Number(row?.callsSettled) || 0, payers: Number(row?.uniqueBuyers) || 0 }]];
  return [];
}

/**
 * origin -> {
 *   byWallet     Map(wallet -> { settled, payers })  evidence, per wallet it was measured at
 *   clearing     Set(wallet)  the wallets whose OWN evidence clears the floor
 *   settled, payers           the best wallet (clearing first, then most calls, then
 *                             most payers): the projection every pre-probe filter
 *                             and label reads
 *   payTos       Set(wallet)  every wallet with evidence
 *   ownSettled, ownPayers    the chain join alone (evidence on the origin's own
 *                             advertised address), for reporting
 *   seedSettled              the committed seed's count for the origin (no wallet)
 * }
 */
export function buildEvidenceBinding({ seedOrigins = {}, leaderboardRows = [], walletEvidence = null, bazaarQuality = [], chainProven = null, minSettled = 50, minPayers = 3 } = {}) {
  const m = new Map();
  const ent = (o) => {
    const k = norm(o);
    if (!m.has(k)) m.set(k, { byWallet: new Map(), ownSettled: 0, ownPayers: undefined, seedSettled: 0 });
    return m.get(k);
  };
  for (const [o, c] of Object.entries(seedOrigins || {})) {
    if (!o) continue;
    const e = ent(o);
    e.seedSettled = Math.max(e.seedSettled, Number(c) || 0);
  }
  for (const row of Array.isArray(leaderboardRows) ? leaderboardRows : []) {
    const origins = Array.isArray(row?.origins) ? row.origins : (row?.homepage ? [row.homepage] : []);
    const figures = rowWalletFigures(row, walletEvidence);
    if (!figures.length) continue;
    for (const o of origins) {
      if (!o) continue;
      const e = ent(o);
      for (const [w, v] of figures) put(e.byWallet, w, v.settled, v.payers);
    }
  }
  for (const [o, q] of Array.isArray(bazaarQuality) ? bazaarQuality : []) {
    if (!o || !q) continue;
    for (const [w0, v] of bazaarByPayTo(q)) {
      const w = evmKey(w0);
      if (!w || !(Number(v?.calls) > 0)) continue;
      put(ent(o).byWallet, w, v.calls, v.payers);
    }
  }
  if (chainProven instanceof Map) {
    for (const [o, ev] of chainProven) {
      const w = evmKey(ev?.payTo);
      if (!o || !ev || !w) continue;
      const e = ent(o);
      put(e.byWallet, w, ev.settled, ev.payers);
      e.ownSettled = Math.max(e.ownSettled, Number(ev.settled) || 0);
      if (ev.payers != null) e.ownPayers = Math.max(Number(e.ownPayers ?? 0), Number(ev.payers) || 0);
    }
  }
  const out = new Map();
  for (const [o, e] of m) {
    const clearing = new Set();
    let best = null, bestClears = false;
    for (const [w, v] of e.byWallet) {
      const clears = meetsRouterGate({ settled: v.settled, payers: v.payers, minSettled, minPayers }).ok;
      if (clears) clearing.add(w);
      if (!best || (clears && !bestClears) || (clears === bestClears && (v.settled > best.settled || (v.settled === best.settled && Number(v.payers ?? 0) > Number(best.payers ?? 0))))) {
        best = v; bestClears = clears;
      }
    }
    // The seed carries a count and no wallet. It stands in the projection only
    // where no wallet clears on its own, with no payer figure of its own.
    const useSeed = !bestClears && e.seedSettled > (best ? best.settled : 0);
    out.set(o, {
      byWallet: e.byWallet,
      clearing,
      settled: useSeed ? e.seedSettled : (best ? best.settled : 0),
      payers: useSeed ? undefined : (best ? best.payers : undefined),
      payTos: new Set(e.byWallet.keys()),
      ownSettled: e.ownSettled,
      ownPayers: e.ownPayers,
      seedSettled: e.seedSettled,
    });
  }
  return out;
}

/**
 * The resolver's post-probe Base verdict for one candidate, ONE implementation
 * shared with the test: the same dispatchEligibility call the pre-probe filter
 * ran, now with the origin's binding and the address its live 402 named.
 *
 *   { ok: true, livePayTo, evidenceWallets }      - pay it; when the binding decided it,
 *                                                   the payer must sign only to one of
 *                                                   evidenceWallets (the wallets whose OWN
 *                                                   evidence clears), else null
 *   { ok: false, detail, livePayTo, payTos }      - skip it, and why
 *
 * `livePayTo` may be passed decoded, or read from the probe's `header` / `body`.
 */
export function baseLiveGate({ networks, settled, payers, priceUsd, urlTemplate = false, minSettled, minPayers, binding, livePayTo, header, body, usdcDomain = null } = {}) {
  const live = livePayTo !== undefined ? livePayTo : payToFromLive402({ header, body });
  const v = dispatchEligibility({
    routable: true, networks, settled, payers, priceUsd, urlTemplate: !!urlTemplate,
    spendChains: ["base"], minSettled, minPayers, usdcDomain,
    ...(binding ? { evidence: binding, livePayTo: live } : {}),
  });
  const base = v.chains?.base || {};
  const verdict = binding ? evidencePayToVerdict({ evidence: binding, livePayTo: live, minSettled, minPayers }) : null;
  if (base.eligible === true) return { ok: true, livePayTo: live, evidenceWallets: verdict?.bound ? [...verdict.payTos] : null };
  return { ok: false, detail: base.detail || base.reason || v.reason, livePayTo: live, payTos: verdict ? [...(verdict.payTos || [])] : [] };
}
