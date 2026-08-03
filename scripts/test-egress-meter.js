#!/usr/bin/env node
// The thing that totals up what we spend must be cheap, safe and honest.
//
//   node scripts/test-egress-meter.js          (offline)
//
// WHY: three cost leaks were found by an invoice rather than by us. All three
// looked like ordinary traffic until someone totalled it up, and nothing was
// totalling it up. This meter runs in production on the hot path of every
// outbound call, so the properties that keep it safe there matter as much as
// the counting.
import { recordEgress, egressReport, __resetEgressMeter } from "../src/egress-meter.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

__resetEgressMeter();

// 1. It counts, and it attributes.
recordEgress("api.search.brave.com", "x\n at y\n at z (/Users/a/src/tools/search.js:1:1)");
recordEgress("api.search.brave.com", "x\n at y\n at z (/Users/a/src/tools/search.js:1:1)");
recordEgress("g.alchemy.com", "x\n at y\n at z (/Users/a/src/revenue-live.js:1:1)");
let r = egressReport();
ok(r.totalCalls === 3 && r.distinctHosts === 2, `counts calls and hosts (${r.totalCalls}/${r.distinctHosts})`);
const brave = r.hosts.find((h) => h.host === "api.search.brave.com");
ok(brave.calls === 2, "repeat calls to one host aggregate");
ok(brave.callers.includes("tools/search.js"), "the calling file is recorded");

// 2. Attribution must name the FEATURE, not the transport. Every outbound call
//    passes through fetch-guard; reporting that is true and useless, because it
//    never tells you which feature is spending.
__resetEgressMeter();
recordEgress("g.alchemy.com",
  "e\n at fetch\n at safeFetch (/Users/a/src/tools/fetch-guard.js:9:9)\n at scan (/Users/a/src/revenue-live.js:5:5)");
r = egressReport();
ok(r.hosts[0].callers.includes("revenue-live.js"),
  `skips the transport frame and names the caller (${r.hosts[0].callers.join(",")})`);
ok(!r.hosts[0].callers.includes("tools/fetch-guard.js"),
  "...and does not report the plumbing as the spender");

// 3. It must NEVER throw. It sits on the hot path of every tool call, and a
//    metering bug that breaks a paid request would cost more than the leak.
let threw = null;
try {
  recordEgress(null, null);
  recordEgress(undefined, undefined);
  recordEgress("", {});
  recordEgress("h", { toString() { throw new Error("hostile stack"); } });
  egressReport({ top: -5 });
} catch (e) { threw = e; }
ok(!threw, `malformed input never throws (${threw?.message || "no throw"})`);
// HONEST LIMIT: this exercises callerOf's own guard, not recordEgress's outer
// catch - mutating that catch to rethrow leaves this assertion green, because
// the hostile input is swallowed one level down. The outer catch is
// defence-in-depth for future edits and is NOT covered here. Recorded rather
// than papered over: a test that implies coverage it lacks is how three leaks
// survived guards that looked green.

// 4. Memory is bounded. An index crawl touches ~1,300 hosts; a hostile or
//    runaway caller must not grow this without limit.
__resetEgressMeter();
for (let i = 0; i < 2500; i++) recordEgress(`h${i}.test`, "");
r = egressReport({ top: 5 });
ok(r.distinctHosts <= 2000, `host table is capped (${r.distinctHosts})`);
ok(r.droppedHosts > 0, `and it reports what it dropped rather than silently truncating (${r.droppedHosts})`);

// 5. Host ONLY. A full URL would capture buyer-supplied input - a render
//    target, a search query - which is customer data we have no reason to keep.
__resetEgressMeter();
recordEgress("api.search.brave.com", "");
// Check the HOST fields, not the whole document: the report legitimately
// contains "?" as the unknown-caller marker, and matching that was the test
// flagging its own fallback as a privacy leak.
recordEgress("api.openai.com", "at x (/Users/a/src/tools/llm-kit.js:1:1)");
const hostFields = egressReport().hosts.map((h) => h.host);
ok(hostFields.every((h) => !/[/?#]/.test(h)),
  `no host field contains a path, query or fragment (${hostFields.join(", ")})`);
ok(hostFields.every((h) => !/^https?:/.test(h)),
  "hosts are stored bare, not as URLs");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
