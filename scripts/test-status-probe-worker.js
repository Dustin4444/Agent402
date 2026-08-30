#!/usr/bin/env node
// Offline test for workers/status-probe — the Cloudflare cron observer.
//
// This Worker decides what /status reports about production, so the failure
// that matters is not "it crashed", it is "it recorded a broken component as
// operational". Every check below drives the real probe() against a stubbed
// fetch and asserts the mapping, including the cases where production answers
// but answers WRONG (a 200 where a 402 is required, a collapsed catalog, a
// rail silently missing from the offer) — the quiet regressions a plain
// reachability check would wave through.
import { strict as assert } from "node:assert";
import { probe, observe } from "../workers/status-probe/src/index.js";

const PROD = "https://prod.test";
let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

const offer = (nets) => btoa(JSON.stringify({ accepts: nets.map((n) => ({ network: n })) }));

/** Install a fetch stub. `over` overrides any leg of a healthy production. */
function stub(over = {}) {
  const healthy = {
    health: () => new Response("ok", { status: 200 }),
    pricing: () => Response.json({ endpoints: new Array(516).fill({}) }),
    mcp: () => new Response(JSON.stringify({ result: { serverInfo: { name: "agent402" } } }), { status: 200 }),
    extract: () => new Response("", { status: 402, headers: { "payment-required": offer(["eip155:8453", "solana:mainnet"]) } }),
    record: () => new Response("{}", { status: 200 }),
  };
  const legs = { ...healthy, ...over };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/health")) return legs.health();
    if (u.endsWith("/api/pricing")) return legs.pricing();
    if (u.endsWith("/mcp")) return legs.mcp();
    if (u.endsWith("/api/extract")) return legs.extract();
    if (u.endsWith("/api/status/probe")) return legs.record();
    throw new Error("unexpected url " + u);
  };
}

console.log("status-probe worker — observation mapping");

{
  stub();
  const { components, fails } = await probe(PROD);
  check("healthy production: all five components operational", () => {
    for (const k of ["api", "catalog", "mcp", "paywall", "rails"]) {
      assert.equal(components[k]?.ok, true, `${k} should be ok`);
    }
    assert.equal(fails.length, 0);
  });
  check("healthy production: paid-call is never claimed", () => {
    assert.equal(components["paid-call"], undefined,
      "this observer cannot see the paid path; claiming it would be a fabricated observation");
  });
}

{
  // The dangerous one: production answers 200 instead of 402. A reachability
  // check calls that healthy; it is actually paid tools being given away.
  stub({ extract: () => new Response("{}", { status: 200 }) });
  const { components } = await probe(PROD);
  check("paywall serving 200 instead of 402 is an outage, not a success", () => {
    assert.equal(components.paywall.ok, false);
    assert.match(components.paywall.detail, /200/);
  });
  check("an unreadable offer marks rails down rather than guessing", () => {
    assert.equal(components.rails.ok, false);
  });
}

{
  stub({ extract: () => new Response("", { status: 402, headers: { "payment-required": offer(["solana:mainnet"]) } }) });
  const { components } = await probe(PROD);
  check("Base dropping out of the offer is caught even though the 402 is correct", () => {
    assert.equal(components.paywall.ok, true, "the paywall itself is fine");
    assert.equal(components.rails.ok, false, "but the rail is gone");
  });
}

{
  stub({ pricing: () => Response.json({ endpoints: new Array(12).fill({}) }) });
  const { components } = await probe(PROD);
  check("a collapsed catalog is caught (12 routes is not a catalog)", () => {
    assert.equal(components.catalog.ok, false);
    assert.match(components.catalog.detail, /12/);
  });
  check("a collapsed catalog does not drag unrelated components down", () => {
    assert.equal(components.api.ok, true);
    assert.equal(components.mcp.ok, true);
  });
}

{
  stub({ mcp: () => new Response(JSON.stringify({ result: {} }), { status: 200 }) });
  const { components } = await probe(PROD);
  check("a 200 from /mcp without the server identity is still a failure", () => {
    assert.equal(components.mcp.ok, false);
  });
}

{
  stub({ health: () => { throw new Error("ECONNREFUSED"); } });
  const { components } = await probe(PROD);
  check("a thrown request records a failure, never a silent pass", () => {
    assert.equal(components.api.ok, false);
    assert.match(components.api.detail, /ECONNREFUSED/);
  });
  check("one dead endpoint does not abort the remaining checks", () => {
    assert.equal(components.catalog.ok, true, "catalog should still have been probed");
    assert.equal(components.paywall.ok, true, "paywall should still have been probed");
  });
}

{
  // Total outage: every leg throws. Nothing may come back ok.
  const dead = () => { throw new Error("down"); };
  stub({ health: dead, pricing: dead, mcp: dead, extract: dead });
  const { components } = await probe(PROD);
  check("total outage marks every observed component down", () => {
    for (const [k, v] of Object.entries(components)) assert.equal(v.ok, false, `${k} claimed ok during a total outage`);
    assert.ok(Object.keys(components).length >= 5);
  });
}

{
  // Deploy-blip retry (2026-07-29): a single failed attempt that recovers by
  // the retry is recorded CLEAN — one probe landing inside a deploy restart
  // must not amber the whole day's bar on /status.
  let calls = 0;
  const blip = () => { calls++; if (calls === 1) throw new Error("connection reset"); return new Response("ok", { status: 200 }); };
  stub({ health: blip });
  const result = await observe(PROD, { sleep: async () => {} });
  check("transient blip: retry succeeds and is recorded clean", () => {
    assert.equal(result.retried, true, "should have retried");
    assert.equal(result.fails.length, 0, `expected no recorded fails, got: ${result.fails.join(" ")}`);
    assert.equal(result.components.api.ok, true);
  });
}

{
  // A failure that SURVIVES the retry is a real outage and must be recorded —
  // the retry may never soften a sustained failure.
  const dead = () => { throw new Error("down"); };
  stub({ health: dead });
  const result = await observe(PROD, { sleep: async () => {} });
  check("sustained failure: recorded down even after the retry", () => {
    assert.equal(result.retried, true);
    assert.equal(result.components.api.ok, false, "a real outage must never be retried away");
    assert.ok(result.fails.some((f) => f.startsWith("api(")));
  });
}

{
  // Healthy path never pays the retry pause.
  stub();
  let slept = false;
  const result = await observe(PROD, { sleep: async () => { slept = true; } });
  check("healthy production: no retry, no pause", () => {
    assert.equal(result.retried, false);
    assert.equal(slept, false, "healthy path must not sleep");
  });
}


// --- the heartbeat kick -----------------------------------------------------
// heartbeat.yml carries eighteen alarm checks and is their ONLY observer, but
// GitHub does not deliver its schedule: measured 2026-08-30, `*/15` gave gaps
// of 2-12 h and a gentler `9,39` gave ONE run in 9.8 h. This Worker's 5-minute
// cron IS honoured, so it kicks the workflow. These pin the bounds that keep
// that from becoming a dispatch storm.
{
  const { kickHeartbeat } = await import("../workers/status-probe/src/index.js");
  const acheck = async (name, fn) => {
    try { await fn(); console.log(`  ok   ${name}`); }
    catch (e) { failures++; console.log(`  FAIL ${name}`); console.log(`       ${e.message}`); }
  };
  const NOW = 1_800_000_000_000;
  const ago = (min) => new Date(NOW - min * 60000).toISOString();
  const realFetch = globalThis.fetch;
  let dispatches = 0;
  const mk = (runs, dispatchOk = true) => {
    dispatches = 0;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("/dispatches")) { dispatches++; return dispatchOk ? new Response(null, { status: 204 }) : new Response("", { status: 403 }); }
      if (u.includes("/runs")) return Response.json({ workflow_runs: runs });
      return new Response("{}", { status: 200 });
    };
  };
  const ENV = { GITHUB_DISPATCH_TOKEN: "t", HEARTBEAT_MAX_AGE_MIN: "20" };

  await acheck("a 5-hour-old heartbeat is kicked", async () => {
    mk([{ status: "completed", created_at: ago(300) }]);
    const r = await kickHeartbeat(ENV, NOW);
    assert.ok(r.kicked, `expected a kick, got: ${r.reason}`);
    assert.equal(dispatches, 1);
  });
  await acheck("a recent run is NOT kicked", async () => {
    mk([{ status: "completed", created_at: ago(5) }]);
    const r = await kickHeartbeat(ENV, NOW);
    assert.ok(!r.kicked, r.reason); assert.equal(dispatches, 0);
  });
  await acheck("a run already in flight is never piled onto, however old", async () => {
    mk([{ status: "in_progress", created_at: ago(400) }]);
    const r = await kickHeartbeat(ENV, NOW);
    assert.ok(!r.kicked, r.reason); assert.equal(dispatches, 0);
  });
  await acheck("no prior run at all -> kick", async () => {
    mk([]);
    const r = await kickHeartbeat(ENV, NOW);
    assert.ok(r.kicked, r.reason); assert.equal(dispatches, 1);
  });
  await acheck("a refused dispatch is reported, not silently swallowed", async () => {
    mk([{ status: "completed", created_at: ago(300) }], false);
    const r = await kickHeartbeat(ENV, NOW);
    assert.ok(!r.kicked); assert.match(r.reason, /dispatch failed \(403\)/);
  });
  await acheck("without a token it is an env-gated no-op, and says so", async () => {
    mk([{ status: "completed", created_at: ago(300) }]);
    const r = await kickHeartbeat({}, NOW);
    assert.ok(!r.kicked); assert.equal(dispatches, 0);
    assert.match(r.reason, /no GITHUB_DISPATCH_TOKEN/);
  });
  await acheck("a network failure never throws out of the probe", async () => {
    globalThis.fetch = async () => { throw new Error("network down"); };
    const r = await kickHeartbeat(ENV, NOW);
    assert.ok(!r.kicked); assert.match(r.reason, /error:/);
  });
  globalThis.fetch = realFetch;
}

console.log(failures ? `\nFAILED (${failures})` : "\nall passed");
process.exit(failures ? 1 : 0);
