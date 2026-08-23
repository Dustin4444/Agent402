// GUARD: the Ox Alpha free trial is the ONE exception to the trial's structural
// safety rule, and this pins the two properties that make the exception safe.
//
// Normally a trial can only ever reach a PoW-eligible (pure-CPU) route, so it
// can never give away money we paid upstream. Ox Alpha is an upstream call, and
// it is allowed only because the model is currently free. That is a fact about
// a third party that will change without notice, so:
//
//   1. the trial is offered only while a FRESH read of the live catalog shows
//      the model at exactly 0 prompt and 0 completion, and
//   2. the trial must NEVER widen proof-of-work redemption to the route - PoW
//      is cheap and repeatable, so a solved challenge on an upstream-calling
//      route would be an unmetered free proxy.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { oxUpstreamIsFree, oxUpstreamPricing, __oxTest } from "../src/tools/llm-gateway-kit.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// --- 1. freeness fails closed --------------------------------------------------
const setPricing = __oxTest?.setPricing;
if (typeof setPricing === "function") {
  setPricing(null);
  ok(oxUpstreamIsFree() === false, "no reading yet: not free (fails closed before the first probe)");
  setPricing({ prompt: "0", completion: "0", checkedAt: Date.now() });
  ok(oxUpstreamIsFree() === true, "a fresh 0/0 reading is free");
  setPricing({ prompt: "0", completion: "0.0000004", checkedAt: Date.now() });
  ok(oxUpstreamIsFree() === false, "a non-zero completion price is NOT free (the reprice case)");
  setPricing({ prompt: "0.000001", completion: "0", checkedAt: Date.now() });
  ok(oxUpstreamIsFree() === false, "a non-zero prompt price is NOT free");
  setPricing({ prompt: "0", completion: "0", checkedAt: Date.now() - 48 * 3600_000 });
  ok(oxUpstreamIsFree() === false, "a stale reading is NOT free (we stop trusting an old price)");
  setPricing({ prompt: "", completion: "", checkedAt: Date.now() });
  ok(oxUpstreamIsFree() === false, "an empty price field is NOT free (absent is not zero)");
  setPricing(null);
  ok(oxUpstreamPricing() === null, "pricing surface reports null when nothing has been read");
} else {
  ok(false, "llm-gateway-kit exposes a __oxTest.setPricing seam for this guard");
}

// --- 2. the trial never widens proof-of-work redemption -----------------------
const server = readFileSync(join(ROOT, "src/server.js"), "utf8");
ok(/const powSlug\s*=/.test(server), "server keeps a separate powSlug for redemption");
ok(/const slug = powSlug \?\? oxTrialSlug;/.test(server), "the trial slug is additive to `slug`, never to `powSlug`");
ok(/const solution = powSlug \? req\.header\("x-pow-solution"\) : null;/.test(server),
  "a proof-of-work solution is only read on a PoW-eligible route, so the Ox route cannot redeem one");
ok(/oxAlphaAvailable\(\) && oxUpstreamIsFree\(\)/.test(server),
  "the trial is gated on BOTH availability and a proven-free upstream");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
