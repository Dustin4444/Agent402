// METERED SETTLEMENT for the LLM gateway: bill what a call actually cost,
// not the flat tier price.
//
// WHY. The gateway prices in flat tiers because `exact` fixes the amount in the
// 402 before the handler runs. Measured over 30 days of `gateway_usage`, that
// makes us 170x to 2,162x the upstream cost on the chat tiers: v1-chat charges
// $0.02 against $0.0001 of real spend, v1-chat-pro $0.10 against ~$0.00005. An
// agent that can hold an API key has no reason to route through that, and the
// flat price is bad at BOTH ends - small calls are wildly overpriced, and large
// ones hit the margin clamp, which shrinks max_tokens and hands the buyer a
// truncated answer to defend our margin.
//
// The `upto` scheme fixes the shape: the buyer authorizes a CEILING and the
// seller names the settled amount afterwards, never above it. So the tier price
// becomes a guaranteed maximum and the bill becomes the meter.
//
// THE MARKUP IS THE PRODUCT. Charging upstream + 30% makes routing through us
// cheaper than a subscription while still paying for the service, which is the
// only version of this that a buyer can verify and therefore trust.
export const METER_MARKUP = 1.3;
// Every request costs us something no percentage of a $0.000003 call can cover
// (the paywall, the settle, egress). This floor is what a request is worth
// before any model runs, and it is deliberately far under the old flat price.
export const METER_FLOOR_USD = 0.0005;

/**
 * What to settle for a metered call.
 *
 * @param {object} p
 * @param {number} p.upstreamUsd  what the call actually cost us upstream
 * @param {number} p.ceilingUsd   the tier price the buyer authorized
 * @returns {number|null} USD to settle, or null when it cannot be metered
 *                        (unknown cost, or nothing to bill against)
 */
export function meteredUsd({ upstreamUsd, ceilingUsd }) {
  const ceiling = Number(ceilingUsd);
  if (!Number.isFinite(ceiling) || ceiling <= 0) return null;
  // An unreported cost must NEVER silently become a cheap settle: without a
  // number we cannot meter, so the caller keeps the ceiling it already quoted.
  //
  // The type check is the load-bearing part. `Number(null)` is 0, which is
  // finite and non-negative, so a coercion-based guard reads a MISSING cost as
  // a free call and bills the floor - underbilling ourselves on precisely the
  // calls where we do not know what we spent.
  if (typeof upstreamUsd !== "number" || !Number.isFinite(upstreamUsd) || upstreamUsd < 0) return null;
  const up = upstreamUsd;
  const metered = Math.max(METER_FLOOR_USD, up * METER_MARKUP);
  // Never above what the buyer authorized. The margin clamp already holds
  // upstream at or under 70% of the tier price, so metered <= 0.91 x ceiling
  // and this cap should never bind - it is here because "should never" is not
  // an argument to skip the check on something that moves money.
  const capped = Math.min(metered, ceiling);
  // Settle in whole atomic units of a 6-decimal stablecoin, rounding UP so a
  // rounding error can only favour the seller.
  //
  // The epsilon is not cosmetic: 0.012 * 1.3 is 0.015600000000000001 in binary
  // floating point, and a bare ceil() turns that into 15,601 units - a whole
  // extra atomic unit of overbilling on any call whose product lands just above
  // an exact unit, which is most of them.
  return Math.ceil(capped * 1e6 - 1e-9) / 1e6;
}

/** True when this request may be metered: it paid over `upto`, so the amount is
 *  ours to name. An `exact` payment fixed the amount at the 402 and overriding
 *  it is not something the scheme can express. */
export function isMeterable(req) {
  return String(req?.x402?.scheme || req?._x402Scheme || "").toLowerCase() === "upto";
}
