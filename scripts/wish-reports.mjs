#!/usr/bin/env node
// A buyer telling us something is BROKEN, found among the wishes.
//
// 2026-09-01 01:26 UTC a paying customer wrote, through POST /api/wish:
//   "route-execute with include=external returns 502 bad gateway after payment
//    (3 consecutive tests, paid each time) ... please fix the external
//    execution path."
// Nothing surfaced it. It was read eleven days later, by hand, while auditing
// the board for something else. The board had 4,062 signals and exactly one of
// them was a person reporting a fault.
//
// WHY A CLASSIFIER AND NOT "ALERT ON EVERY EXPLICIT WISH". The obvious design -
// page on source:"api" - was wrong, and measuring said so: 50 of 500 clusters
// carry an explicit wish and almost every recent one is a seller advertising
// their own product through the board ("buy X for $1 usdc on base", thirteen
// rephrasings in an hour). That alert would fire constantly and be muted within
// a week, which is worse than no alert.
//
// So it matches two things at once: failure vocabulary AND a reference to our
// own surface or to having paid. An advert says "buy this for a dollar"; a
// report says "it returned 502 after payment". Measured against the live board:
// ONE hit in 500 clusters, and it is the report above.
//
// Deliberately keyword-based. A model could read these better, but this has to
// run unattended, cost nothing, and never spend upstream to decide whether to
// page - and at one signal a month the recall of a regex is sufficient.

const TARGET = (process.env.TARGET_URL || "https://agent402.tools").replace(/\/+$/, "");
const TOKEN = process.env.AGENT402_OPERATOR_TOKEN || "";
const DAYS = Number(process.env.WISH_REPORT_DAYS) > 0 ? Number(process.env.WISH_REPORT_DAYS) : 7;

/** Failure vocabulary: the buyer is describing something going wrong. */
const FAILURE = /\b(50\d|4\d\d)\b|\b(error|errors|fail(s|ed|ing)?|broken|bug|times? out|timed out|timeout|cannot|can't|does ?n't work|not working|stuck|hang(s|ing)?|refund|charged|double.?charg|please fix|unavailab|(response|body|result)s? (was|is|are|were) empty|nothing back|no response|returned nothing)/i;

/** ...to something of OURS, or after paying. This is what separates a report
 *  from an advert, and it is the half that does the work. */
// NO leading \b: several of these start with "/", which is not a word
// character, so a word boundary there can never match - "/v1/chat" silently
// failed to be recognised as ours until the test caught it.
const OURS = /(route-execute|\bapi\/|\bagent402|\/v1\/|\bmcp\b|x402 gateway|your (api|router|tool|server|endpoint)|after payment|paid (each|for)|\bsettle(d|ment)?\b)/i;

/** Reported as a hint on the alert, never as a filter: a message can be both a
 *  pitch and a real report, and dropping it on this would be the wrong error. */
const ADVERT = /\b(buy|for sale|free sample|get https?:|price[d]? at)\b/i;

export function isFaultReport(text) {
  const t = String(text || "");
  return FAILURE.test(t) && OURS.test(t);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!TOKEN) {
    console.error("::error::AGENT402_OPERATOR_TOKEN is not set - refusing to report a clean board it cannot read");
    process.exit(1);
  }
  const res = await fetch(`${TARGET}/__operator/wishes.json?limit=500`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    console.error(`::error::could not read the board: HTTP ${res.status}`);
    process.exit(1);
  }
  const board = await res.json();
  const since = Date.now() - DAYS * 86_400_000;
  const clusters = (board.clusters || []).filter((c) => Date.parse(c.lastSeen) >= since);

  // Explicit wishes only. A find-miss is a search that missed - it carries no
  // sentence a person wrote, so it cannot be a fault report.
  const reports = clusters.filter((c) => (c.sources?.api || 0) + (c.sources?.mcp || 0) > 0 && isFaultReport(c.text));

  console.log(`board: ${board.liveClusters ?? board.distinctClusters} live clusters, ${clusters.length} touched in ${DAYS}d`);
  console.log(`fault reports: ${reports.length}`);
  for (const r of reports) {
    console.log(`\n  ${r.lastSeen}${ADVERT.test(r.text) ? "  (also reads like a pitch - judge it yourself)" : ""}`);
    console.log(`  ${r.text}`);
  }
  if (reports.length) {
    // The exit code is the signal the workflow keys on.
    process.exit(2);
  }
  console.log("\nNo buyer reported a fault through the wish board in this window.");
}
