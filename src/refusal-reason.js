// Why a 4xx happened, as a CLASS and never as the caller's words.
//
// Built 2026-09-19 after a question telemetry could not answer. The metered
// chat tier read as refusing 89% of its callers over twenty days, which looked
// like a product on fire; it was two bursts from bot clients sending a body we
// reject in under seven milliseconds, and every other day was clean. A scanner
// sending garbage and a paying customer who mistyped one field produce the
// SAME `tool_call` row today - status 400, errored true, nothing else - so the
// first reading of that number was wrong and took four queries to correct.
// The input-alias work had the same problem in reverse: it had to be inferred
// from 400 COUNTS because no cause was recorded anywhere.
//
// So this maps our OWN error messages onto a fixed vocabulary, the same shape
// as the payment classifier behind /x402-test. Two rules make it safe to send
// to a third-party analytics service:
//
//   1. The output is one of the constants below and nothing else. The caller's
//      message, values, field contents and credentials never leave here - a
//      400 often quotes what the buyer sent, and that is exactly the text an
//      analytics pipeline must never receive.
//   2. An unrecognised message is "other", never the message. That keeps the
//      vocabulary a closed set a query can GROUP BY, and it means a new error
//      string cannot silently start exporting buyer text.
//
// The value of `other` climbing is itself the signal to add a rule here.
export const REFUSAL_REASONS = Object.freeze([
  "missing_required",     // a required field was absent
  "unknown_field_value",  // an enum / allowlist value we do not serve
  "wrong_type",           // right name, wrong shape
  "out_of_range",         // a number or length past a documented bound
  "too_large",            // body or field over a size cap
  "model_not_allowed",    // the gateway allowlist refused the model
  "model_wrong_tier",     // real model, served by a different tier
  "quote_mismatch",       // metered: the served body is not the quoted one
  "over_cap",             // metered: quote above the per-call ceiling
  "unsupported_field",    // a field we refuse by name rather than ignore
  "malformed_body",       // not parseable as the documented shape
  "not_found",            // the named resource does not exist upstream
  "other",
]);

// Ordered: the FIRST match wins, so the specific patterns precede the generic
// ones. Each is anchored on words our own `bad()` calls actually use.
// Bounded repetition throughout: these run over an error message, and a kit's
// 400 can quote the caller's own input, so an unbounded [a-z_ ]* next to a
// literal is the same polynomial-backtracking shape CodeQL flagged in the
// Gemini path alias. Forty characters is far past any real field name.
const RULES = [
  [/\bis not in the gateway allowlist\b/i, "model_not_allowed"],
  [/\bis served by the .* tier\b|\bcall \/v1\/[a-z0-9/-]+ .*instead\b/i, "model_wrong_tier"],
  [/\bbut the body being served quotes\b|\bresend the request exactly as it should be served\b/i, "quote_mismatch"],
  [/\babove the \$[0-9.]+ per-call cap\b|\bper-call cap of\b/i, "over_cap"],
  [/\bis not supported on this route\b|\bis refused\b|\bnot served on this route\b/i, "unsupported_field"],
  // NOTE the missing \b after the closing quote: `must be "text/plain" or ...`
  // has a space next, and quote-to-space is non-word to non-word, so a word
  // boundary there never matches. The first cut had one and classified the
  // commonest enum refusal we serve as "other".
  [/\bmust be one of\b|\bmust be "[^"]*"|\bunknown [a-z_ ]{0,40}(mode|type|period|unit|format|category|network|chain)\b/i, "unknown_field_value"],
  [/\bis required\b|\bmust be a non-empty\b|\bneeds? an? "/i, "missing_required"],
  [/\bmust be an? (object|array|string|number|boolean|integer)\b|\bmust be a JSON object\b/i, "wrong_type"],
  // Format constraints on a field the caller DID send: right name, wrong
  // shape. "code must be 8-14 digits (a UPC/EAN barcode)" is the one that
  // started this - it is the single most common refusal we have ever served
  // and the first cut classified it "other".
  [/\bmust be \d+([-\u2013]\d+)? (digits|characters|chars|bytes)\b|\bmust be a valid\b|\bmust match\b|\bmust look like\b/i, "wrong_type"],
  [/\bis capped at\b|\btoo many\b|\bexceeds\b|\bmust be between\b|\bmust be at (most|least)\b/i, "out_of_range"],
  [/\btoo large\b|\bover the .* limit\b|\bpayload too large\b/i, "too_large"],
  [/\bdoes not exist\b|\bnot found\b|\bunknown (ticker|symbol|series|manager|company)\b/i, "not_found"],
  [/\bcould not be parsed\b|\bis not valid JSON\b|\bmalformed\b|\binvalid JSON\b/i, "malformed_body"],
];

/** Classify one refusal. Returns a member of REFUSAL_REASONS, always.
 *  @param message our own error text (never the caller's input)
 *  @param status  the HTTP status we answered with */
export function refusalReason(message, status) {
  const code = Number(status) || 0;
  if (code < 400 || code >= 500) return null; // only a refusal has a reason
  if (code === 413) return "too_large";
  if (code === 404) return "not_found";
  const text = typeof message === "string" ? message : "";
  if (!text) return "other";
  for (const [re, reason] of RULES) if (re.test(text)) return reason;
  return "other";
}
