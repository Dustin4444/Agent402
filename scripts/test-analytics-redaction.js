#!/usr/bin/env node
// The per-tool analytics table must not reach an unauthenticated caller.
//
//   node scripts/test-analytics-redaction.js
//
// WHY THIS IS A UNIT TEST AND NOT AN HTTP TEST: the control it guards shipped
// BROKEN and nothing noticed. The first version destructured a key named
// `tools`, which getAnalytics() never returns (it returns `topTools` and
// `errorTools`), so the rest spread copied the whole table through and the
// unauthenticated response was byte-identical to the operator response. It read
// as enforced and enforced nothing.
//
// It survived review because it cannot be observed over HTTP on this instance:
// ANALYTICS_DATABASE_URL is unset, getAnalytics() short-circuits to
// {ok:false, enabled:false}, and scripts/test-public-surface-leak.js - which
// does probe /api/analytics - passes VACUOUSLY against an empty payload. A test
// that only sees the disabled path can never catch a redaction bug.
//
// So this seeds a POPULATED payload shaped exactly like the real one and asserts
// on the redaction function directly. It needs no database and cannot go vacuous.
import { redactAnalytics } from "../src/analytics-db.js";

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`ok - ${msg}`); }
  else { failed++; console.error(`FAIL - ${msg}`); }
};

// Shaped after the real return of getAnalytics (src/analytics-db.js): the
// per-tool tables are `topTools` and `errorTools`. If those key names ever
// change, this fixture must change with them - which is the point, because the
// bug was a name that did not match.
const populated = () => ({
  ok: true,
  enabled: true,
  windowHours: 720,
  includeSynthetic: false,
  includeProbes: false,
  syntheticHidden: 12,
  probesHidden: 3,
  totals: { calls: 9812, errors: 41, p50: 88, p95: 410 },
  topTools: [
    { slug: "transcribe", calls: 2211, cacheRate: 0.1, err4xx: 3, err5xx: 1, p50: 900, p95: 4100 },
    { slug: "search", calls: 1804, cacheRate: 0.4, err4xx: 9, err5xx: 0, p50: 220, p95: 700 },
  ],
  errorTools: [{ slug: "defi-tvl", err5xx: 17, p95: 8800 }],
  timeseries: [{ t: "2026-07-30T00:00:00Z", calls: 400 }],
});

// --- unauthenticated: the ranking must be gone -------------------------------
{
  const out = redactAnalytics(populated(), false);
  const blob = JSON.stringify(out);
  ok(!("topTools" in out), "unauthenticated response has no topTools");
  ok(!("errorTools" in out), "unauthenticated response has no errorTools");
  // Assert on the SERIALIZED payload too: a nested copy would slip past a key
  // check, and the whole point of this test is that a key check already failed.
  ok(!blob.includes("transcribe") && !blob.includes("defi-tvl"),
    "no tool slug appears anywhere in the unauthenticated payload");
  ok(!blob.includes("cacheRate") && !blob.includes("err5xx"),
    "no per-tool metric appears anywhere in the unauthenticated payload");

  // What SHOULD survive: the dashboard still has to be usable and honest.
  ok(out.totals && out.totals.calls === 9812, "aggregate totals survive redaction");
  ok(Array.isArray(out.timeseries) && out.timeseries.length === 1, "the timeseries survives redaction");
  ok(out.toolsCount === 2 && out.errorToolsCount === 1,
    `counts replace the tables (got toolsCount=${out.toolsCount}, errorToolsCount=${out.errorToolsCount})`);
  ok(out.enabled === true && out.windowHours === 720, "the surrounding shape is untouched");
}

// --- operator: nothing is withheld -------------------------------------------
{
  const out = redactAnalytics(populated(), true);
  ok(Array.isArray(out.topTools) && out.topTools.length === 2, "operator still receives topTools");
  ok(Array.isArray(out.errorTools) && out.errorTools.length === 1, "operator still receives errorTools");
  ok(out.toolsCount === undefined, "operator payload is not rewritten into counts");
}

// --- the two responses must actually differ ----------------------------------
// The defect was that they were identical. Asserting the difference directly is
// the cheapest possible guard against the same mistake.
{
  const pub = JSON.stringify(redactAnalytics(populated(), false));
  const op = JSON.stringify(redactAnalytics(populated(), true));
  ok(pub !== op, "the unauthenticated and operator payloads are NOT identical");
  ok(op.length > pub.length, "the operator payload is the larger of the two");
}

// --- degenerate inputs must not throw or leak --------------------------------
{
  ok(redactAnalytics({ ok: false, enabled: false }, false).enabled === false,
    "the disabled short-circuit passes through unchanged");
  ok(redactAnalytics(null, false) === null, "null payload is handled");
  ok(redactAnalytics(undefined, false) === undefined, "undefined payload is handled");
  const partial = redactAnalytics({ ok: true, enabled: true, topTools: [] }, false);
  ok(!("topTools" in partial) && partial.toolsCount === 0, "an empty table still redacts to a count");
}

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
