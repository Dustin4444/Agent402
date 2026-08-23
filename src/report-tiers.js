// ONE registry of every priced report tier, so "what does this cost and what is
// it allowed to spend" has a single answer.
//
// Built because `maxUpstreamUsd` was a DECLARED bound in 8 of the 10 report
// kits: only research-deep and ticker-pack read their own field at runtime, and
// everywhere else the number was a comment that nothing checked. That is how it
// drifted below measured cost without anyone noticing, and how three products
// ended up priced under their own worst case.
//
// The kits keep owning their tier config; this only collects it.
import { RESEARCH_TIERS } from "./tools/research-deep-kit.js";
import { DOSSIER_TIERS } from "./tools/dossier-kit.js";
import { FUND_TIERS } from "./tools/fund-report-kit.js";
import { DOMAIN_AUDIT_TIERS } from "./tools/domain-audit-kit.js";
import { RECALL_TIERS } from "./tools/recall-report-kit.js";
import { INSIDER_TIERS } from "./tools/insider-flow-kit.js";
import { TOKEN_RISK_TIERS } from "./tools/token-risk-kit.js";
import { TOKEN_BRIEF_TIERS } from "./tools/token-brief-kit.js";
import { FILING_TIERS } from "./tools/filing-watch-kit.js";
import { TICKER_PACK_TIERS } from "./tools/ticker-pack-kit.js";

export const REPORT_TIERS = {
  ...RESEARCH_TIERS, ...DOSSIER_TIERS, ...FUND_TIERS, ...DOMAIN_AUDIT_TIERS,
  ...RECALL_TIERS, ...INSIDER_TIERS, ...TOKEN_RISK_TIERS, ...TOKEN_BRIEF_TIERS,
  ...FILING_TIERS, ...TICKER_PACK_TIERS,
};

/** The declared upstream ceiling for a slug, or null when it is not a report. */
export function capUsdFor(slug) {
  const t = REPORT_TIERS[String(slug ?? "")];
  const n = t ? Number(t.maxUpstreamUsd) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** List price for a slug, or null. */
export function priceUsdFor(slug) {
  const t = REPORT_TIERS[String(slug ?? "")];
  if (!t) return null;
  const n = Number(String(t.price).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}
