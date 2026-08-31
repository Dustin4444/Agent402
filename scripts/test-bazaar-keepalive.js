// The keep-alive must actually run on a schedule, and page when it doesn't.
//
// CDP's seller docs: "Resources that go 30 days without a settlement are
// removed." Measured 2026-08-31: our oldest surviving Bazaar listing was dated
// exactly 30 days back and 405 of 573 routes had aged out - not a registration
// failure, a cull. scripts/refresh-bazaar.js already carried the remedy
// (MODE=sweep) and had been wired to workflow_dispatch ONLY, so it had never
// run on a cadence in the catalog's life.
//
// So the properties worth pinning are not about the payment logic - that script
// is unchanged and tested elsewhere - but about the things that would silently
// undo this again: no schedule, too slow a cadence, a missing key treated as a
// skip, or a failure nobody hears about.
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const wf = await readFile(new URL("../.github/workflows/bazaar-keepalive.yml", import.meta.url), "utf8");

ok(/^on:/m.test(wf) && /schedule:/.test(wf), "it is scheduled at all - the whole defect was a dispatch-only job");

// Cadence: a 30-day rule needs real headroom, because GitHub throttles
// schedules (measured 2026-08-30: a */15 cron delivered one run in 9.8 hours).
const cron = (wf.match(/cron:\s*"([^"]+)"/) || [])[1] || "";
const dom = cron.split(/\s+/)[2], dow = cron.split(/\s+/)[4];
ok(cron !== "", `carries a cron (${cron})`);
ok(dow !== "*" && dom === "*", "weekly, not monthly - four missed runs still leave the listings alive");

ok(/MODE:\s*sweep/.test(wf), "uses the sweep mode that re-settles every affordable route");
ok(/BATCH_COUNT/.test(wf) && /BATCH_INDEX/.test(wf), "batches the pass so one run cannot time out mid-catalog");
ok(/max-parallel:\s*1/.test(wf), "batches run sequentially - one burner address, concurrent buys race their own nonces");

// A missing key must FAIL, never skip: a silent skip is indistinguishable from
// success for 30 days, and then the catalog is gone.
ok(/BURNER_KEY is not set/.test(wf) && /exit 1/.test(wf), "a missing burner key fails the run loudly, never skips");
ok(/add-mask/.test(wf), "the key is masked in the log");
ok(/secrets\.BURNER_KEY/.test(wf), "uses the same burner secret as the existing sweep job, not a new one");

// Nobody watches a weekly job, so it has to speak up.
ok(/issues:\s*write/.test(wf), "may open an issue");
ok(/Bazaar keep-alive FAILED/.test(wf), "pages on failure with a title that says what breaks");
ok(/gh issue close/.test(wf), "and closes the issue when a later run succeeds");
ok(/if:\s*always\(\)/.test(wf), "the report step runs even when the sweep failed - the failure is the point");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
