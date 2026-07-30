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
    { slug: "transcribe", calls: 2211, cached: 221, client_errored: 3, server_errored: 1, p50_ms: 900, p95_ms: 4100 },
    { slug: "search", calls: 1804, cached: 722, client_errored: 9, server_errored: 0, p50_ms: 220, p95_ms: 700 },
  ],
  errorTools: [{ slug: "defi-tvl", calls: 40, cached: 0, client_errored: 0, server_errored: 17, p50_ms: 3000, p95_ms: 8800 }],
  timeseries: [{ t: "2026-07-30T00:00:00Z", calls: 400 }],
});

// --- unauthenticated: reliability stays, volume goes ------------------------
// The split is deliberate. Error rate and latency are what a buyer needs to
// decide whether to depend on a tool, and publishing measured reliability is the
// same argument as /status one level down. Call volume ranked by traffic is
// demand intelligence and is what the paid bestsellers tool sells.
{
  const out = redactAnalytics(populated(), false);
  const blob = JSON.stringify(out);

  // VOLUME must be gone, in every form. Each raw field is a COUNT, so counts
  // scale with traffic and would rebuild the ranking on their own.
  ok(!blob.includes("2211") && !blob.includes("1804"), "no per-tool call count survives");
  ok(out.topTools.every((r) => r.calls === undefined && r.cached === undefined && r.errored === undefined),
    "no count field survives on any row");
  // The ORDER is a ranking too: source rows arrive sorted by traffic.
  const slugs = out.topTools.map((r) => r.slug);
  ok(JSON.stringify(slugs) === JSON.stringify([...slugs].sort()),
    `rows are alphabetical, not traffic-ranked (got ${slugs.join(",")})`);

  // RELIABILITY must survive, as rates rather than counts.
  const search = out.topTools.find((r) => r.slug === "search");
  ok(Boolean(search), "per-tool rows are still present");
  ok(typeof search.serverErrorRate === "number" && typeof search.clientErrorRate === "number",
    "error rates survive as rates");
  ok(search.p95_ms === 700 && search.p50_ms === 220, "latency percentiles survive untouched");
  ok(Math.abs(search.cacheRate - 0.4) < 0.001, `cache rate is a true rate (got ${search.cacheRate})`);
  ok(Array.isArray(out.errorTools) && out.errorTools.length === 1, "the error view survives");

  // Aggregates and the honest disclosure.
  ok(out.totals && out.totals.calls === 9812, "aggregate totals survive redaction");
  ok(Array.isArray(out.timeseries) && out.timeseries.length === 1, "the timeseries survives redaction");
  ok(out.toolsCount === 2, `a tool count replaces the volume table (got ${out.toolsCount})`);
  ok(typeof out.perToolNote === "string" && /operator-only/.test(out.perToolNote),
    "the payload states plainly that volume and ranking are withheld");
}

// --- the two responses must actually differ ----------------------------------
// The defect was that they were identical. Asserting the difference directly is
// the cheapest possible guard against the same mistake.
{
  const pubObj = redactAnalytics(populated(), false);
  const opObj = redactAnalytics(populated(), true);
  const pub = JSON.stringify(pubObj);
  const op = JSON.stringify(opObj);
  ok(pub !== op, "the unauthenticated and operator payloads are NOT identical");
  // Compare MEANING, not size. The public payload is now the LARGER string
  // (rates plus a disclosure note) while carrying strictly less information, so
  // a byte-length check would assert the opposite of what it appears to.
  ok(op.includes("2211") && !pub.includes("2211"),
    "the operator payload carries call volume and the public one does not");
  ok(opObj.topTools[0].calls !== undefined && pubObj.topTools[0].calls === undefined,
    "the volume field exists only on the operator side");
}

// --- degenerate inputs must not throw or leak --------------------------------
{
  ok(redactAnalytics({ ok: false, enabled: false }, false).enabled === false,
    "the disabled short-circuit passes through unchanged");
  ok(redactAnalytics(null, false) === null, "null payload is handled");
  ok(redactAnalytics(undefined, false) === undefined, "undefined payload is handled");
  const partial = redactAnalytics({ ok: true, enabled: true, topTools: [] }, false);
  ok(Array.isArray(partial.topTools) && partial.topTools.length === 0 && partial.toolsCount === 0, "an empty table stays an empty table");
}

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
