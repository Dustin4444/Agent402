// Unit test for the Algorand rail canary's paid-attempt classifiers
// (scripts/avm-canary-classify.js). These decide whether a non-200 buy in the
// ~500-tool weekly sweep is a real rail/tool defect (fails the run) or a
// third-party/edge outage or our-own-burst throttle (reported, does not fail).
// Getting this wrong is why #806 stayed open: a transient edge 502 or an
// upstream vendor 5xx was booked as a broken tool on first sight.
import { outcomeOf, isUpstreamOutage, isThrottle } from "./avm-canary-classify.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.error("FAIL -", m); } };
const R = (status, body = "", elapsedMs = 6000) => ({ status, body, elapsedMs });

// ---- outcomeOf ----
ok(outcomeOf(R(200, '{"x":1}')) === "ok", "200 with a body is ok");
ok(outcomeOf(R(200, "   ")) === "empty", "200 with a blank body is empty");
ok(outcomeOf(R(402, "{}", 85)) === "fast-402", "a sub-1.5s 402 is fast-402 (never reached the chain)");
ok(outcomeOf(R(402, "{}", 5629)) === "slow-402", "a 5.6s 402 is slow-402 (a genuine settlement attempt)");
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
