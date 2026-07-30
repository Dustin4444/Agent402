#!/usr/bin/env node
// Wallet-free trial: ?trial=1 serves ONE call per tool per client per hour.
//
//   node scripts/test-trial.js
//
// It boots its own server in PAID mode, because in FREE_MODE everything is free
// and every assertion here would pass vacuously - which is the failure mode this
// repo keeps rediscovering. A paywall test that cannot observe a paywall proves
// nothing.
//
// The invariants, in order of how much they would cost if wrong:
//
//  1. A trial is never counted as REVENUE. Attribution's else-branch is "usdc",
//     so a free path that forgets to name itself is silently booked as a sale.
//  2. A trial NEVER applies to a wallet-only tool. Those spend real money
//     upstream (LLM tiers, paid APIs, signing). The gate is scoped structurally
//     - the trial branch lives inside the PoW-eligible branch - and this asserts
//     that scope from the outside, where a refactor would break it.
//  3. The bounds hold: a second call to the same tool pays, and the catalog
//     cannot be swept.
import { spawn } from "node:child_process";
import { createServer } from "node:http";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = 3900 + (process.pid % 90);
const FAC_PORT = PORT + 100;
const base = `http://localhost:${PORT}`;
let log = "";

// Local stub facilitator (same pattern as scripts/test-mpp-shim.js). A real
// facilitator is unusable here: @x402/core refuses to BUILD a 402 for a
// scheme/network pair the facilitator does not advertise, so an unreachable or
// non-advertising facilitator turns every unpaid request into a 500 and the
// paywall this test exists to observe never appears. Nothing is ever settled -
// every assertion stops at the 402.
const facilitator = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const reply = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url === "/supported") return reply({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => facilitator.listen(FAC_PORT, r));
const child = spawn(process.execPath, ["src/server.js"], {
  env: {
    ...process.env,
    PORT: String(PORT),
    FREE_MODE: "",
    NETWORK: "base",
    PAYMENT_NETWORKS: "base",
    FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`,
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "",
    NODE_ENV: "test",
    X402_INDEX_CRAWL: "off",
    // X402_SYNC_ON_START is deliberately NOT set to false here. It skips the
    // facilitator handshake, and without those supported kinds @x402/core
    // cannot build a 402 at all - every unpaid request answers 500 and this
    // test would be asserting against a broken paywall rather than a real one.
    WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD",
    STATS_ALLOW_EPHEMERAL: "true",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (d) => { log += d; });
child.stderr.on("data", (d) => { log += d; });
const done = (code) => {
  try { child.kill("SIGKILL"); } catch { /* */ }
  try { facilitator.close(); } catch { /* */ }
  process.exit(code);
};

(async () => {
  let up = false;
  for (let i = 0; i < 240; i++) {
    try { if ((await fetch(`${base}/health`)).ok) { up = true; break; } } catch { /* booting */ }
    await wait(250);
  }
  ok(up, `server booted on :${PORT}`);
  if (!up) { console.error(log.slice(-2000) || "(no output)"); return done(1); }

  const statsTotals = async () => (await (await fetch(`${base}/api/stats`)).json()).toolCallsServed;

  // Every route below is a REAL GET route taken from /api/pricing, with its
  // computePayable flag checked. The first draft used paths that 404'd, and a
  // 404 satisfies "not trialable" - so the scope assertions passed while
  // proving nothing. Routes are asserted to exist before they are trusted.
  const pricing = await (await fetch(`${base}/api/pricing`)).json();
  const byPath = new Map(pricing.endpoints.map((e) => [`${e.method} ${e.path}`, e]));
  const mustExist = (m, p, computePayable) => {
    const e = byPath.get(`${m} ${p}`);
    ok(Boolean(e), `route exists in the catalog: ${m} ${p}`);
    if (e) ok(e.computePayable === computePayable,
      `  ...and is ${computePayable ? "compute-payable (trialable)" : "wallet-only (never trialable)"}: ${p}`);
    return Boolean(e);
  };
  const TRIAL_A = "/api/uuid", TRIAL_B = "/api/ulid", TRIAL_C = "/api/password";
  const WALLET_ONLY = ["/api/dns?name=example.com", "/api/memory?key=k", "/api/search?q=a"];
  mustExist("GET", TRIAL_A, true);
  mustExist("GET", TRIAL_B, true);
  mustExist("GET", TRIAL_C, true);
  for (const w of WALLET_ONLY) mustExist("GET", w.split("?")[0], false);

  // The paywall must actually be up, or everything below is vacuous.
  const unpaid = await fetch(`${base}${TRIAL_A}`);
  ok(unpaid.status === 402, `paid mode confirmed: an unpaid call is 402 (got ${unpaid.status})`);
  ok(String(unpaid.headers.get("x-trial-available") || "").includes("trial=1"),
    "the 402 advertises the trial, so a caller can discover it without docs");

  const before = await statsTotals();

  // 1. First trial is served.
  const t1 = await fetch(`${base}${TRIAL_A}?trial=1`);
  ok(t1.status === 200, `first ?trial=1 call is served (got ${t1.status})`);
  ok(t1.headers.get("x-trial-accepted") === "true", "and is labelled as a trial on the response");

  // 2. Second call to the SAME tool from the same client is back behind the paywall.
  const t2 = await fetch(`${base}${TRIAL_A}?trial=1`);
  ok(t2.status === 402, `a second trial of the same tool pays (got ${t2.status})`);
  ok(t2.headers.get("x-trial-exhausted") === "true", "and says why, rather than a bare 402");

  // 3. A DIFFERENT tool still gets its own trial (per-tool, not per-client-once).
  const t3 = await fetch(`${base}${TRIAL_B}?trial=1`);
  ok(t3.status === 200, `a different tool has its own trial (got ${t3.status})`);

  // 4. THE MONEY INVARIANT: none of that counted as revenue.
  const after = await statsTotals();
  ok((after.viaUSDC || 0) === (before.viaUSDC || 0),
    `trials did not increment viaUSDC (${before.viaUSDC} -> ${after.viaUSDC})`);
  ok((after.viaTrial || 0) === (before.viaTrial || 0) + 2,
    `trials are counted in their own class (viaTrial ${before.viaTrial || 0} -> ${after.viaTrial || 0})`);
  ok((after.viaProofOfWork || 0) === (before.viaProofOfWork || 0),
    "trials are not counted as proof-of-work either");

  // 5. THE SCOPE INVARIANT: a wallet-only tool is never trialable. These spend
  //    real money upstream, so this is the assertion that protects the bank.
  for (const path of WALLET_ONLY) {
    const r = await fetch(`${base}${path}&trial=1`);
    // 402 specifically - NOT merely "!= 200". A 404 would satisfy "not served"
    // while proving only that the route was missing, which is how the first
    // draft of this test passed vacuously.
    ok(r.status === 402, `wallet-only route still demands payment: ${path.split("?")[0]} (got ${r.status})`);
    ok(r.headers.get("x-trial-accepted") !== "true", `  ...and no trial was granted: ${path.split("?")[0]}`);
    ok(!r.headers.get("x-trial-available"), `  ...and no trial is even advertised: ${path.split("?")[0]}`);
  }

  // 6a. A trial must not become a REUSABLE RECEIPT via the idempotency cache.
  //
  // idemHashKey binds a cached entry to the `x-pow-solution` header AS
  // PRESENTED - the idempotency middleware runs before the PoW gate, so at key
  // time that string is whatever the caller typed. That was safe only while an
  // unauthenticated caller could never reach a 200 to seed the cache. The trial
  // returns 200 with no credential, so one trial plus a made-up solution seeded
  // an entry that any client could replay unpaid for the full TTL, defeating
  // the "1 per tool per hour" bound this feature advertises.
  {
    const KEY = `trial-amp-${process.pid}`;
    const forged = { "idempotency-key": KEY, "x-pow-solution": "i-made-this-up:0" };
    const seed = await fetch(`${base}${TRIAL_C}?trial=1`, { headers: forged });
    ok(seed.status === 200 && seed.headers.get("x-trial-accepted") === "true",
      `a fresh tool grants its trial while carrying an idempotency key (got ${seed.status})`);

    // Same key, trial now spent: must NOT replay, must be back behind the paywall.
    const replay = await fetch(`${base}${TRIAL_C}?trial=1`, { headers: forged });
    ok(replay.headers.get("x-idempotent-replay") !== "true",
      "the trial response was NOT committed to the idempotency cache");
    ok(replay.status === 402, `and the exhausted trial pays like any other (got ${replay.status})`);

    // And no unrelated caller can spend it either.
    const third = await fetch(`${base}${TRIAL_C}`, { headers: forged });
    ok(third.status === 402, `an unrelated caller cannot replay a trial via the key (got ${third.status})`);
  }

  // 6. The per-client cap bounds a catalog sweep. Ten distinct tools are
  //    allowed per hour; the eleventh must pay even though it is a fresh tool.
  const sweepTools = pricing.endpoints
    .filter((e) => e.method === "GET" && e.computePayable === true && ![TRIAL_A, TRIAL_B].includes(e.path))
    .slice(0, 12).map((e) => e.path);
  ok(sweepTools.length >= 10, `enough distinct trialable tools to test the sweep cap (${sweepTools.length})`);
  let served = 0, blocked = 0;
  for (const p of sweepTools) {
    const r = await fetch(`${base}${p}?trial=1`);
    if (r.status === 200) served++;
    if (r.headers.get("x-trial-exhausted") === "true") blocked++;
  }
  ok(blocked > 0 || served < sweepTools.length,
    `the per-client cap stops a catalog sweep (served ${served}/${sweepTools.length}, blocked ${blocked})`);

  console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
  done(fail ? 1 : 0);
})().catch((e) => { console.error(e); console.error(log.slice(-1500)); done(1); });
