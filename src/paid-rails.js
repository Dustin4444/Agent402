// Which payment RAILS actually moved money.
//
// NOT to be confused with src/rails.js, which owns the settlement CHAINS we
// advertise (Base, Solana, Algorand…). The word is overloaded: a `rail` here
// is the GATE that accepted a served call — `usdc` and `marketplace` are
// purchases, while `pow` (proof-of-work), `trial` and `heartbeat` served the
// call for FREE.
//
// Both kinds are recorded everywhere, deliberately: the free-tier funnel is
// measured by comparing proof-of-work challenges ISSUED against pow calls
// SERVED, so dropping the free rows would delete that metric.
//
// THE TRAP THIS CLOSES. A free call still carries the tool's LIST price —
// that is the honest answer to "what would this have cost", and the free-tier
// subsidy metric needs it. So any count or sum filtered only on `synthetic`
// silently counts free traffic as revenue. `synthetic` does NOT mean free: it
// means OUR OWN traffic (canary, heartbeat probes). Proof-of-work is genuine
// external demand that happens to cost nothing, so it is correctly
// synthetic=false — which is precisely why the naive filter lets it through.
//
// Measured 2026-08-06 over 7 days: 385 external PAID settles against 388 free
// proof-of-work ones. Three saved dashboards filtering on `synthetic` alone
// read slightly over 2x reality, and the same mistake was made live while
// investigating a traffic spike, using the same filter, before it was caught.
//
// This set was ALREADY the convention, spelled out by hand in nine SQL queries
// in sales-ledger.js and in the settled-revenue dashboard. Naming it once
// means a new paying rail cannot be added to some readers and forgotten in
// others - the failure mode where revenue quietly stops being counted.
// "card" = Stripe Checkout (one-shot reports) and paid subscription invoices
// (src/human-checkout.js / stripe-subscriptions.js -> recordSale rail "card");
// "credits" = prepaid card credits debited per call (src/credits.js). Both are
// real money from others - without them here the human front door was invisible
// to /revenue (caught 2026-08-22).
export const PAYING_RAILS = Object.freeze(["usdc", "marketplace", "card", "credits"]);

/** Did money actually move on this rail? Free tiers (pow/trial/heartbeat) are false. */
export function isPaidRail(rail) {
  return PAYING_RAILS.includes(String(rail || ""));
}

/** The same set as a SQL list, so the queries cannot drift from the code. */
export const PAYING_RAILS_SQL = `(${PAYING_RAILS.map((r) => `'${r}'`).join(",")})`;
