#!/usr/bin/env node
// The corpus runner's two pure pieces: expectation checking and outcome
// classification. Offline. Mutation-sensitive by design: every rule the corpus
// relies on is asserted here, so a change that quietly weakens an assertion
// (a `populated` that accepts [], a 500 read as upstream) fails this file
// before it can turn the corpus green.
import { checkExpect, classify, getPath, paceWaitMs } from "./test-corpus.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// getPath
ok(getPath({ a: { b: [10, { c: "x" }] } }, "a.b[1].c") === "x", "getPath walks dots and brackets");
ok(getPath({ a: null }, "a.b") === undefined, "getPath on null is undefined, never a throw");

// populated: the whole point - an empty answer is not populated
const body = { n: 0, s: "", arr: [], obj: {}, nul: null, nan: NaN, list: [1], text: "t" };
ok(checkExpect({ populated: ["n"] }, 200, body).length === 0, "0 is populated (a number is a value)");
for (const p of ["s", "arr", "obj", "nul", "nan", "missing"]) ok(checkExpect({ populated: [p] }, 200, body).length === 1, `${p} is NOT populated`);
ok(checkExpect({ populated: ["list", "text"] }, 200, body).length === 0, "non-empty array + string are populated");
// empty: the honest-empty case
ok(checkExpect({ empty: ["arr"] }, 200, body).length === 0 && checkExpect({ empty: ["list"] }, 200, body).length === 1 && checkExpect({ empty: ["nul"] }, 200, body).length === 1, "empty demands an actual []");
// equals / count / matches / numeric
ok(checkExpect({ equals: { "list[0]": 1, obj: {} } }, 200, body).length === 0, "equals is deep");
ok(checkExpect({ equals: { n: "0" } }, 200, body).length === 1, "equals is typed (0 != \"0\")");
ok(checkExpect({ count: { list: 1 }, minCount: { text: 1 }, maxCount: { list: 1 } }, 200, body).length === 0, "count on arrays and strings");
ok(checkExpect({ count: { n: 1 } }, 200, body).length === 1, "count on a number fails, never passes by accident");
ok(checkExpect({ matches: { text: "^T$" } }, 200, body).length === 0, "matches is case-insensitive");
ok(checkExpect({ gt: { n: -1 }, gte: { n: 0 }, lt: { n: 1 } }, 200, body).length === 0 && checkExpect({ gt: { text: 0 } }, 200, body).length === 1, "numeric comparisons; a non-number never satisfies gt");
// status
ok(checkExpect({}, 500, body).length === 1 && checkExpect({}, 200, body).length === 0, "default status is 200");
ok(checkExpect({ status: 400 }, 400, { error: "x" }).length === 0, "a 4xx case passes with a self-explaining error");
ok(checkExpect({ status: 400 }, 400, { message: "x" }).length === 1, "a 4xx with no `error` field fails");
ok(checkExpect({ status: 400, matches: { error: "currency" } }, 400, { error: "unknown currency" }).length === 0, "4xx matches run against the error text");
ok(checkExpect({ status: 400 }, 200, { error: "x" }).length === 1, "a 200 where a 400 was expected fails");

// classify
const T = (o) => classify({ expectFails: [], ...o }).kind;
ok(T({ status: 200, body: {}, tier: 1 }) === "ok", "clean is ok");
ok(T({ status: 200, body: {}, tier: 1, expectFails: ["x"] }) === "fatal", "an expectation miss is fatal");
ok(T({ status: 500, body: { error: "boom" }, tier: 1 }) === "fatal", "a 500 is fatal");
ok(T({ status: 502, body: { error: "upstream" }, tier: 1 }) === "upstream" && T({ status: 429, body: {}, tier: 1 }) === "upstream", "502/429 on a networked tool is upstream");
ok(T({ status: 503, body: { error: "x" }, tier: 0 }) === "fatal", "a 503 from a pure-CPU tool is fatal (nothing upstream to blame)");
ok(T({ status: 503, body: { error: "search is not configured (BRAVE_API_KEY)" }, tier: 2 }) === "skipped", "a not-configured 503 is skipped");
ok(T({ status: 0, body: null, netError: "ECONNRESET", tier: 1 }) === "upstream", "a network error is upstream");
ok(T({ status: 400, body: { error: "\"x\" is required" }, tier: 1, expectFails: ["status 400, expected 200"] }) === "fatal", "our own 400 on a valid input is fatal");
ok(T({ status: 422, body: { error: "Source URL timed out" }, tier: 1, expectFails: ["status 422, expected 200"] }) === "upstream", "fetch-guard's own relabelled upstream timeout (422 'Source URL timed out') is upstream on a networked tool");
ok(T({ status: 400, body: { error: '"timeout" must be a number' }, tier: 1, expectFails: ["status 400, expected 200"] }) === "fatal", "our own 400 that merely contains the word timeout is fatal (review, 2026-09-06)");
ok(T({ status: 404, body: { error: "Price feed upstream: not found (check ids)" }, tier: 1, expectFails: ["status 404, expected 200"] }) === "fatal", "our own 404 that contains the word upstream is fatal");

// pace: cases sharing a paceKey share ONE clock across files. Three per-file
// clocks at 3 s each started the CoinGecko cases 60/min against a 25/min
// bucket (nightly 2026-09-06: 13 cases rate-limited, never verified).
{
  const clocks = new Map();
  const a = { file: "chain.json", paceKey: "coingecko", pace: 5000 };
  const b = { file: "crypto-defi.json", paceKey: "coingecko", pace: 5000 };
  ok(paceWaitMs(a, clocks, 1000) === 0, "the first case on a clock starts at once");
  ok(paceWaitMs(b, clocks, 1000) === 5000, "a case in ANOTHER file on the same paceKey waits the full pace");
  ok(paceWaitMs({ file: "other.json", paceKey: "other.json", pace: 3000 }, clocks, 1000) === 0, "a different key is a different clock");
  ok(paceWaitMs({ file: "x.json", pace: 0 }, clocks, 1000) === 0 && !clocks.has("x.json"), "no pace: never waits, never reserves a slot");
  ok(paceWaitMs({ file: "chain.json", pace: 3000 }, clocks, 1000) === 0 && clocks.get("chain.json") === 4000, "no paceKey falls back to the file as the clock");
  ok(paceWaitMs(a, clocks, 20_000) === 0 && clocks.get("coingecko") === 25_000, "a clock in the past restarts from now");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
