// Offline unit test for refresh-bazaar's "did this pass leave work undone?"
// decision. Pins the distinction that matters: a route we paid for that the
// Bazaar harvester has not ingested yet is THEIR lag and must not fail the run,
// while a failed buy or a route we never paid for must.
//
// This exists because the old rule (any still-missing route => exit 1) put a
// red X on the 2026-07-24 run where all 74 buys succeeded and every route was
// listed within ~2.5h unattended. A check that reports failure on success
// teaches people to ignore it.
//
// Run: node scripts/test-bazaar-verdict.js
import { missingModeVerdict } from "./refresh-bazaar.js";

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log(`ok - ${name}`); }
  else { fail++; console.error(`FAIL - ${name}`); }
};

// Nothing outstanding at all.
{
  const v = missingModeVerdict({ failCount: 0, okCount: 12, stillMissingPaths: [], boughtPaths: new Set() });
  check("everything listed exits 0", v.exitCode === 0);
}

// The 2026-07-24 shape: every route bought, none ingested yet.
{
  const paths = ["/api/a", "/api/b", "/api/c"];
  const v = missingModeVerdict({ failCount: 0, okCount: 3, stillMissingPaths: paths, boughtPaths: new Set(paths) });
  check("all bought but none ingested yet exits 0 (harvester lag is not our failure)", v.exitCode === 0);
  check("lag message names the harvester", /harvester/i.test(v.message));
  check("lag message tells the reader to re-count", /re-count/i.test(v.message));
}

// A buy genuinely failed.
{
  const v = missingModeVerdict({ failCount: 1, okCount: 2, stillMissingPaths: ["/api/a"], boughtPaths: new Set(["/api/a"]) });
  check("a failed buy exits 1 even if the missing route was also bought", v.exitCode === 1);
  check("failure message counts the failed buys", /1 failed buy/.test(v.message));
}

// A route was never paid for (spend cap / price cap / batch stride).
{
  const v = missingModeVerdict({ failCount: 0, okCount: 1, stillMissingPaths: ["/api/a", "/api/unpaid"], boughtPaths: new Set(["/api/a"]) });
  check("an unpaid route exits 1", v.exitCode === 1);
  check("failure message counts the unpaid routes", /1 route\(s\) never paid for/.test(v.message));
}

// Mixed: some lag, some never paid — the unpaid ones decide it.
{
  const v = missingModeVerdict({
    failCount: 0, okCount: 5,
    stillMissingPaths: ["/api/a", "/api/b", "/api/never"],
    boughtPaths: new Set(["/api/a", "/api/b"]),
  });
  check("lag plus an unpaid route still exits 1", v.exitCode === 1);
}

// Accepts a plain array as well as a Set (call-site convenience).
{
  const v = missingModeVerdict({ failCount: 0, okCount: 1, stillMissingPaths: ["/api/a"], boughtPaths: ["/api/a"] });
  check("boughtPaths accepts an array", v.exitCode === 0);
}

// Importing the module must not run the script (main guard).
check("importing refresh-bazaar does not execute main", true);

console.log(`\ntest-bazaar-verdict: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
