// Unit test for the Algorand rail canary's paid-attempt classifiers
// (scripts/avm-canary-classify.js). These decide whether a non-200 buy in the
// ~500-tool weekly sweep is a real rail/tool defect (fails the run) or a
// third-party/edge outage or our-own-burst throttle (reported, does not fail).
// Getting this wrong is why #806 stayed open: a transient edge 502 or an
// upstream vendor 5xx was booked as a broken tool on first sight.
import { readFileSync } from "node:fs";
import { outcomeOf, isUpstreamOutage, isThrottle, isOurSettleBreaker } from "./avm-canary-classify.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.error("FAIL -", m); } };
const R = (status, body = "", elapsedMs = 6000) => ({ status, body, elapsedMs });

// ---- outcomeOf ----
ok(outcomeOf(R(200, '{"x":1}')) === "ok", "200 with a body is ok");
ok(outcomeOf(R(200, "   ")) === "empty", "200 with a blank body is empty");
ok(outcomeOf(R(402, "{}", 85)) === "fast-402", "a sub-1.5s 402 is fast-402 (never reached the chain)");
ok(outcomeOf(R(402, "{}", 5629)) === "slow-402", "a 5.6s 402 is slow-402 (a genuine settlement attempt)");
ok(outcomeOf(R(402, '{"error":"Payment rejected","reason":"requirements-mismatch","hint":"..."}', 40)) === "slow-402",
  "a FAST 402 carrying our gate's own named refusal is a rail verdict, never a throttle (metered Messages, 2026-08-31 + 09-07)");
ok(outcomeOf(R(402, '{"error":"Payment required"}', 40)) === "fast-402", "a fast bare 402 with no named refusal is still fast-402");
ok(outcomeOf(R(429, "rate limited")) === "throttle", "429 is throttle");
ok(outcomeOf(R(503, "rate limit exceeded")) === "throttle", "503 that says rate-limit is throttle");
ok(outcomeOf(R(502, "upstream error")) === "other", "a 502 is 'other' (handed to the upstream-vs-tool split)");
ok(outcomeOf(R(409, '{"error":"Payment authorization already used."}')) === "other", "409 replay is 'other'");
ok(outcomeOf(R(500, '{"error":"bad thing"}')) === "other", "500 is 'other'");

// ---- isUpstreamOutage: the NON-failing third-party/edge signatures ----
ok(isUpstreamOutage(502, "upstream error") === true, "502 'upstream error' (Railway edge mid-deploy) is an upstream outage");
ok(isUpstreamOutage(500, '{"error":"The operation was aborted due to timeout"}') === true, "500 'aborted due to timeout' (Blockscout) is an upstream outage");
ok(isUpstreamOutage(502, '{"error":"Seller rejected the paid retry (HTTP 500)"}') === true, "router 'Seller rejected the paid retry' is an upstream outage");
ok(isUpstreamOutage(504, "") === true, "504 Gateway Timeout is an upstream outage");
ok(isUpstreamOutage(503, "") === true, "a bare 503 is an upstream outage");

// ---- what MUST still fail the run (our own defect) ----
ok(isUpstreamOutage(409, '{"error":"Payment authorization already used."}') === false, "a 409 that SURVIVES a fresh retry is a real replay bug, not an upstream outage");
ok(isUpstreamOutage(500, '{"error":"TypeError: cannot read x"}') === false, "a 500 from our own handler is NOT an upstream outage");
ok(isUpstreamOutage(400, '{"error":"bad input"}') === false, "a 400 is our own validation, not an upstream outage");
ok(isUpstreamOutage(422, '{"error":"unprocessable"}') === false, "a 422 is not an upstream outage");

// ---- isThrottle only catches the burst shapes ----
ok(isThrottle(429, "") === true && isThrottle(503, "overloaded") === true, "429 and 503+overload are throttles");
ok(isThrottle(502, "upstream error") === false && isThrottle(500, "") === false, "502/500 are not throttles");

// ---- end-to-end intent: the exact 2026-08-19 failure set is now non-failing ----
const survivors = [
  R(502, "upstream error"),                                          // xml-validate (pure CPU! edge blip)
  R(500, '{"error":"The operation was aborted due to timeout"}'),    // address-profile / tx-inspect
  R(502, '{"error":"Seller rejected the paid retry (HTTP 500)"}'),   // contract-inspect / token-info
  R(502, "upstream error"),                                          // lei-lookup
];
ok(survivors.every((a) => outcomeOf(a) === "other" && isUpstreamOutage(a.status, a.body)), "every persistent third-party/edge failure from run 32301215912 is classified upstream (non-failing), not a tool defect");

// ---- bare (unpaid) probe: a 502/503/504 is the edge in front of the tool
// (the handler only ever answers 402 unpaid), so it is an upstream outage;
// a 500/404 with a real body is a genuine defect. #842 was opened on a bare
// 502 for nft-holdings while it was 402ing fine seconds later.
ok(isUpstreamOutage(502, "") === true && isUpstreamOutage(503, "") === true && isUpstreamOutage(504, "") === true, "a bare-probe 502/503/504 (no body) is an upstream/edge outage");
ok(isUpstreamOutage(500, "") === false && isUpstreamOutage(404, "") === false && isUpstreamOutage(400, "") === false, "a bare-probe 500/404/400 is NOT auto-excused (a real problem still fails)");

// ---- OUR OWN settle breaker is not a vendor throttle -----------------------
//
// From run 35604560799 (2026-09-21), verbatim. An upstream facilitator failed
// 14 minutes into the sweep after 145 clean settlements; three settle failures
// opened our per-wallet breaker, and 346 of the remaining attempts came back as
// this and were reported as "upstream throttles (vendor refused us even after a
// backoff)". Our own guard, described as somebody else's, at the top of the
// only file anyone reads when the rail breaks.
const BREAKER_BODY = '{"error":"Recent payments from this wallet failed to settle (3 in the last 15 min: they verified, the call was served, and settlement failed). Retry after the window clears."}';
ok(isOurSettleBreaker(429, BREAKER_BODY) === true, "the live breaker body from run 35604560799 is recognised as ours");
ok(outcomeOf(R(429, BREAKER_BODY)) === "breaker", "...and classifies as `breaker`, not `throttle`");
ok(isThrottle(429, BREAKER_BODY) === false, "...and is NOT also counted as a vendor throttle - one refusal, one class");

// The global half of the same guard, which pauses the paid catalog rather than
// one wallet. Same conclusion for the sweep: nothing was measured.
ok(outcomeOf(R(429, '{"error":"The paid catalog is paused for a moment."}')) === "breaker", "the GLOBAL pause is also ours, not a vendor");

// CONTROL, in the other direction: a real vendor 429 must still read as a
// throttle. A predicate that swallowed every 429 would hide the facilitator
// rate-limiting our volume, which is the thing isThrottle was written for.
ok(isOurSettleBreaker(429, "rate limit exceeded") === false, "a vendor 429 is NOT claimed as ours");
ok(outcomeOf(R(429, "rate limit exceeded")) === "throttle", "...and still classifies as a vendor throttle");
ok(isOurSettleBreaker(402, BREAKER_BODY) === false, "the text alone is not enough - it has to be a 429");

// Ordering: `breaker` is decided before the 402 shapes and before isThrottle,
// because it is the only outcome that says nothing at all about the tool.
ok(outcomeOf({ status: 429, body: BREAKER_BODY, elapsedMs: 50 }) === "breaker", "a FAST breaker refusal is still a breaker, not a fast-402 or a throttle");

// ---- and the SWEEP acts on it ---------------------------------------------
//
// Source pins, because the sweep self-runs on import and cannot be driven from
// here. Each pins a decision the classifier alone cannot make: what the sweep
// DOES once a refusal is known to be ours.
{
  const src = readFileSync(new URL("./algorand-rail-canary.js", import.meta.url), "utf8");

  // CONTROL. A pin that matches nothing reports a clean run forever, so prove
  // the file is being read and that a string known to be absent is absent.
  ok(/ABORT_AFTER_CONSECUTIVE/.test(src), "control: the sweep source is readable and carries the abort knob");
  ok(!/CANARY_THIS_DOES_NOT_EXIST/.test(src), "control: and a string that should not be there is not found");

  ok(/out === "breaker" \? Math\.min\(a\.retryAfterMs/.test(src),
     "a breaker refusal waits the Retry-After it carries, not the 8s burst backoff that cannot clear a 15-minute window");
  ok(/report\.blocked\.push/.test(src) && !/out === "breaker"[\s\S]{0,400}report\.throttled\.push/.test(src),
     "a breaker refusal goes in `blocked`, never in the vendor-throttle bucket");
  ok(/consecutiveBlind \+\+|consecutiveBlind\+\+/.test(src) && /consecutiveBlind >= ABORT_AFTER_CONSECUTIVE/.test(src),
     "consecutive unmeasurable outcomes abort the sweep instead of buying ~350 more attempts that observe nothing");
  ok(/out === "ok"\) consecutiveBlind = 0/.test(src),
     "...and a single success resets the run, so an isolated failure among successes never trips it - that failure is what this alarm is for");
  ok(/bodyType \|\| ""\)\.toLowerCase\(\) === "form-data"[\s\S]{0,300}report\.skipped\.push/.test(src),
     "a multipart route is SKIPPED, not driven with JSON and then booked as a handler defect - and it is read from the seller's own declaration, not a slug list");
  ok(/report\.aborted && !bad[\s\S]{0,300}process\.exit\(1\)/.test(src),
     "an aborted sweep FAILS the run even with no defect recorded - a partial sweep may not report a pass");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
