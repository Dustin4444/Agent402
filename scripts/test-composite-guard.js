// Unit test for the composite-spend guard (research/dossier upstream-drain
// protection). Offline, fast, in CI.
process.env.COMPOSITE_GUARD_MAX_FAILS = "3";
process.env.COMPOSITE_GUARD_WINDOW_MS = "60000";
process.env.COMPOSITE_GUARD_BLOCK_MS = "600";

const g = await import("../src/composite-spend-guard.js");
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "ok" : "NOT OK") + " - " + m); };

const P = "0xPayerAAA";
ok(!g.compositeGuardBlocked(P), "a clean payer is not blocked");
ok(!g.compositeGuardBlocked(null), "a null/unknown payer is never blocked (no false-positive)");

g.recordCompositeSpendFailure(P);
g.recordCompositeSpendFailure(P);
ok(!g.compositeGuardBlocked(P), "2 failures (under the threshold of 3) does NOT block");
g.recordCompositeSpendFailure(P);
ok(g.compositeGuardBlocked(P), "the 3rd spend-then-fail BLOCKS the payer");

const Q = "0xPayerBBB";
g.recordCompositeSpendFailure(Q);
g.recordCompositeSpendFailure(Q);
g.recordCompositeSpendSuccess(Q); // a genuine paid success
g.recordCompositeSpendFailure(Q);
g.recordCompositeSpendFailure(Q);
ok(!g.compositeGuardBlocked(Q), "a paid success resets the counter (legit buyers never blocked)");

ok(["research", "research-pro", "research-max", "dossier", "dossier-max"].every((s) => g.EXPENSIVE_COMPOSITE_SLUGS.has(s)), "all 5 expensive composite slugs are covered");
ok(!g.EXPENSIVE_COMPOSITE_SLUGS.has("uuid"), "cheap tools are NOT in the guard set");

await new Promise((r) => setTimeout(r, 700));
ok(!g.compositeGuardBlocked(P), "the block lifts after BLOCK_MS (temporary, not permanent)");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
