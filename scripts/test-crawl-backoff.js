#!/usr/bin/env node
// We must stop re-asking an origin a question it has already answered 686 times.
//
//   node scripts/test-crawl-backoff.js
//
// WHY: a seller reported (#645) that our crawler hit their /.well-known/x402
// 686 times in one week and got 404 every single time, while simultaneously
// fetching their /agents.json successfully. The crawl interval was "gentle"
// (5 min) but the BEHAVIOUR was not: an origin that had failed hundreds of
// times in a row was re-probed exactly as often as a healthy one. That is our
// index spending someone else's bandwidth ~98 times a day to re-learn a fact
// we already had.
//
// Two properties, and the second is what keeps this honest:
//   * repeated failure widens the gap between probes,
//   * ANY success clears it immediately, so a seller who fixes their manifest
//     is picked back up on the next crawl rather than punished for having been
//     broken.
import { manifestProbeDue, crawlBackoffState, __noteCrawlOutcomeForTest as note } from "../src/x402-index.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const o = "https://backoff.test";
const T0 = 1_000_000;

ok(manifestProbeDue(o, T0), "an origin we have never failed on is probed immediately");

// Early failures must NOT back off: a transient blip should not cost a seller
// their listing freshness.
note(o, false, T0); ok(manifestProbeDue(o, T0), "1st failure does not delay the next probe");
note(o, false, T0); ok(manifestProbeDue(o, T0), "2nd failure does not delay the next probe");
note(o, false, T0); ok(manifestProbeDue(o, T0), "3rd failure does not delay the next probe");

// Sustained failure does.
note(o, false, T0);
ok(!manifestProbeDue(o, T0), "4th consecutive failure starts backing off");
ok(manifestProbeDue(o, T0 + 31 * 60 * 1000), "...and it lifts once the window passes");

note(o, false, T0); note(o, false, T0);
const st = crawlBackoffState().find((x) => x.origin === o);
ok(st && st.fails >= 5, `sustained failure is tracked (${st?.fails} consecutive)`);
ok(!manifestProbeDue(o, T0 + 60 * 60 * 1000), "the window widens with further failures, not stays flat");

// THE PROPERTY THAT MATTERS MOST: a seller who fixes their manifest is not
// punished for having been broken.
note(o, true, T0);
ok(manifestProbeDue(o, T0), "a single success clears the backoff immediately");
ok(!crawlBackoffState().some((x) => x.origin === o), "and the origin leaves the backoff table entirely");

// The backoff is capped, not unbounded — an origin can never be shelved forever.
const o2 = "https://capped.test";
for (let i = 0; i < 50; i++) note(o2, false, T0);
ok(manifestProbeDue(o2, T0 + 7 * 60 * 60 * 1000),
  "even after 50 failures the probe resumes within hours - never permanently abandoned");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
