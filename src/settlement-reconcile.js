// Settlement reconciliation: did the money we were told arrived actually arrive?
//
// WHY THIS EXISTS. Settlement is delegated to a facilitator, and we take its
// word for it. `@x402/express` settles after the handler and only for a <400
// response, so a 200 means "the facilitator said this settled" — not "USDC
// moved". Those are different claims, and until this check there was no
// surface anywhere that compared them.
//
// Measured 2026-08-06, Solana: 100 settlements recorded on 08-05 against 89
// transfers on-chain, and 63 against 47 on 08-04. Same buyer throughout, 100
// distinct timestamps (so not replayed), one token account (so nothing was
// missed by looking in the wrong place), and the revenue ledger matched the
// chain exactly on every EVM rail. The gap is settlements that were reported
// successful and never landed: 11% of that rail's calls one day, 25% the next.
// We ran the tool, returned the answer, and were not paid.
//
// This is the mirror of the Stellar defect. There the facilitator reported
// FAILURE for transfers that confirmed, so we did the work and withheld the
// result. Here it reports SUCCESS for transfers that do not, so we do the work
// and hand it over. The first was visible because buyers complained; this one
// is silent, which is why it needs a monitor rather than a bug report.
//
// Amounts are per-call micropayments by design. A rate is the honest unit here,
// not a dollar total: "11 of 100 settlements unconfirmed" is the finding, and
// it stays true whether the tool costs $0.001 or $0.25.
//
// NOT a serving-path fix. The buyer has already been handed the result by the
// time this could run, and blocking a response on chain confirmation would add
// seconds to every call. This detects and reports; it never withholds and never
// tries to claw back.
import { claimedSettlements } from "./sales-ledger.js";
import { onchainTxHashes, ledgerTrackedChains } from "./revenue-ledger.js";

// A settlement recorded seconds ago has not had time to be scanned, and would
// read as missing. Only rows older than this are judged; anything newer is
// reported separately as pending rather than counted either way.
export const SETTLE_GRACE_MS = Number(process.env.RECONCILE_GRACE_MS) || 60 * 60 * 1000;

/**
 * Compare recorded settlements against transfers seen on-chain.
 *
 * Every row lands in exactly one bucket, and the buckets that mean "we cannot
 * tell" are named rather than folded into either answer — the failure this
 * codebase keeps re-learning is an unreadable result being counted as a clean
 * one.
 *
 * @param {object}  [opts]
 * @param {number}  [opts.days=7]   window to reconcile
 * @param {number}  [opts.now]      injectable clock (tests)
 * @returns {{asOf:string, windowDays:number, graceMinutes:number, chains:object[], totals:object}}
 */
export function reconcileSettlements({ days = 7, now = Date.now() } = {}) {
  const since = now - days * 86_400_000;
  const cutoff = now - SETTLE_GRACE_MS;
  const rows = claimedSettlements(since, now);
  const tracked = ledgerTrackedChains();

  const byChain = new Map();
  for (const r of rows) {
    const chain = r.network || "(unknown)";
    if (!byChain.has(chain)) {
      byChain.set(chain, { chain, claimed: 0, confirmed: 0, unconfirmed: 0, pending: 0, noTx: 0, unconfirmedUsd: 0, samples: [] });
    }
    const c = byChain.get(chain);
    c.claimed++;
    // No tx to check. Not a discrepancy and NOT a confirmation - some rails
    // return a receipt without a hash, and calling that "confirmed" would be
    // the same wishful accounting this module exists to stop.
    if (!r.tx) { c.noTx++; continue; }
    if (r.ts >= cutoff) { c.pending++; continue; }
    if (!tracked.has(chain)) continue; // classified per-chain below, not per-row
    const seen = c._seen || (c._seen = onchainTxHashes(chain));
    if (seen.has(r.tx)) c.confirmed++;
    else {
      c.unconfirmed++;
      c.unconfirmedUsd += Number(r.usd) || 0;
      if (c.samples.length < 5) c.samples.push({ slug: r.slug, usd: r.usd, tx: String(r.tx).slice(0, 16) + "…", at: new Date(r.ts).toISOString() });
    }
  }

  const chains = [...byChain.values()].map((c) => {
    delete c._seen;
    const t = tracked.get(c.chain);
    // An unscanned chain cannot be reconciled. Say that, loudly, instead of
    // reporting its settlements as missing money.
    const scanned = Boolean(t);
    const judged = c.confirmed + c.unconfirmed;
    return {
      ...c,
      unconfirmedUsd: +c.unconfirmedUsd.toFixed(6),
      scanned,
      caughtUp: t ? t.caughtUp : null,
      // The headline. A rate, because these are micropayments and a dollar
      // total makes a systemic failure look like a rounding error.
      unconfirmedPct: judged ? +((c.unconfirmed / judged) * 100).toFixed(2) : null,
      note: scanned
        ? (judged ? null : "nothing judged yet in this window (all pending or without a tx)")
        : "NOT RECONCILED - no on-chain cursor for this chain, so its settlements are unverifiable here",
    };
  }).sort((a, b) => (b.unconfirmed - a.unconfirmed) || a.chain.localeCompare(b.chain));

  const sum = (k) => chains.reduce((s, c) => s + (c[k] || 0), 0);
  const judgedAll = sum("confirmed") + sum("unconfirmed");
  return {
    asOf: new Date(now).toISOString(),
    windowDays: days,
    graceMinutes: Math.round(SETTLE_GRACE_MS / 60000),
    chains,
    totals: {
      claimed: sum("claimed"),
      confirmed: sum("confirmed"),
      unconfirmed: sum("unconfirmed"),
      pending: sum("pending"),
      noTx: sum("noTx"),
      unconfirmedUsd: +sum("unconfirmedUsd").toFixed(6),
      unconfirmedPct: judgedAll ? +((sum("unconfirmed") / judgedAll) * 100).toFixed(2) : null,
      unscannedChains: chains.filter((c) => !c.scanned).map((c) => c.chain),
    },
  };
}
