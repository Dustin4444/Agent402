// Decide phase 3: execution credits and plan execution. Offline: an
// in-memory ledger file, stub catalog handlers, a stub external router.
//
//   node scripts/test-decide-execute.js

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecideLedger, hashToken } from "../src/decide/ledger.js";
import { makeExecuteHandler, executeQuoteUsd, executeBudgetUsd, makeDecideHandler } from "../src/tools/decide-kit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };
const throwsWith = async (fn, status, frag, m) => { let e = null; try { await fn(); } catch (x) { e = x; } ok(e && e.statusCode === status && (!frag || String(e.message).includes(frag)), `${m} (${e ? `${e.statusCode} ${String(e.message).slice(0, 90)}` : "no throw"})`); return e; };

const dir = mkdtempSync(join(tmpdir(), "decide-exec-"));
let clock = 1_800_000_000_000;
const now = () => clock;
const ledger = openDecideLedger(join(dir, "ledger.db"));

// ---- credit lifecycle ----
{
  ledger.saveDecision({ decisionId: "d0", depth: "plan", priceUsd: 0.02, payer: "0xa", plan: [], costViaUsd: 0.01, now: clock });
  const c = ledger.mintCredit({ decisionId: "d0", amountUsd: 0.02, ttlMs: 24 * 3600_000, payer: "0xa", now: clock });
  ok(c.token.startsWith("dc_") && ledger.creditAvailableUsd(c.token, "d0", clock) === 0, "a minted credit is pending: worth nothing until its payment settles");
  ok(ledger.redeemCredit(c.token, "d0", "r0", clock) === 0, "a pending credit cannot be redeemed");
  ok(ledger.activateCredit(c.hash) && ledger.creditAvailableUsd(c.token, "d0", clock) === 0.02, "activation (after settlement) makes it spendable");
  ok(ledger.creditAvailableUsd(c.token, "other", clock) === 0, "a credit is bound to its decision");
  ok(ledger.creditAvailableUsd(c.token, "d0", clock + 25 * 3600_000) === 0, "a credit expires after its TTL");
  ok(ledger.redeemCredit(c.token, "d0", "r1", clock) === 0.02 && ledger.redeemCredit(c.token, "d0", "r2", clock) === 0, "exactly one run can redeem a credit");
  ledger.restoreCredit(c.token, "r2");
  ok(ledger.creditState(c.token).state === "redeemed", "only the run that redeemed it can restore it");
  ledger.restoreCredit(c.token, "r1");
  ok(ledger.creditState(c.token).state === "active", "a failed run restores its credit");
  ok(!ledger.db.prepare("SELECT token_hash FROM credits").all().some((r) => r.token_hash === c.token) && ledger.db.prepare("SELECT 1 FROM credits WHERE token_hash = ?").get(hashToken(c.token)), "only the token's hash is stored");
}

// ---- a decision to execute ----
const tool = (id, over = {}) => ({ id, slug: id, name: id, seller: "agent402", firstParty: true, endpoint: `https://agent402.tools/api/${id}`, method: "POST", priceUsd: 0.01, inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] }, exampleParams: { q: "x" }, ...over });
const plan = [
  { step: 1, purpose: "one", tool: tool("a"), fallbacks: [tool("b")], dependsOn: [] },
  { step: 2, purpose: "two", tool: tool("ext", { seller: "seller.example", firstParty: false, endpoint: "https://seller.example/x", priceUsd: 0.02 }), fallbacks: [tool("c")], dependsOn: [1] },
];
const calls = [];
let failA = false, routerMode = "ok";
const catalog = {
  a: { slug: "a", route: "POST /api/a", price: "$0.01", discovery: { bodyType: "json" }, handler: async (p) => { calls.push(["a", p]); if (failA) throw Object.assign(new Error("a broke"), { statusCode: 502 }); return { a: p.q }; } },
  b: { slug: "b", route: "POST /api/b", price: "$0.01", discovery: { bodyType: "json" }, handler: async (p) => { calls.push(["b", p]); return { b: p.q }; } },
  c: { slug: "c", route: "POST /api/c", price: "$0.01", discovery: { bodyType: "json" }, handler: async (p) => { calls.push(["c", p]); return { c: p.q }; } },
  rx: { slug: "route-execute-pro", route: "POST /api/route/execute-pro", handler: async (input) => {
    calls.push(["router", input]);
    if (routerMode === "committed") throw Object.assign(new Error("seller settled then failed"), { statusCode: 502, committed: true });
    if (routerMode === "fail") throw Object.assign(new Error("no seller"), { statusCode: 502 });
    return { result: { ext: true }, receipt: { underlyingPriceUsd: 0.018, seller: "seller.example" } };
  } },
};
const exec = makeExecuteHandler({ ledger, getCatalog: () => catalog, now });
function settle(req, status = 200) { for (const fn of req.__onFinalStatus || []) fn(status); }
function mkReq(payer = "0xabc") { return { headers: {}, ip: payer }; }

ledger.saveDecision({ decisionId: "d1", depth: "plan", priceUsd: 0.02, payer: "0xabc", plan, costViaUsd: 0.031, now: clock });

await throwsWith(() => exec({ decisionId: "d1" }, mkReq()), 409, "not settled", "an unsettled decision cannot be executed");
ledger.markDecisionSettled("d1");
await throwsWith(() => exec({ decisionId: "nope" }, mkReq()), 404, "Unknown decisionId", "unknown decision is a 404 (not charged)");

// ---- pricing ----
{
  const c = ledger.mintCredit({ decisionId: "d1", amountUsd: 0.02, ttlMs: 3600_000, now: clock });
  ledger.activateCredit(c.hash);
  ok(executeBudgetUsd({}, ledger.getDecision("d1")) === 0.031 && executeBudgetUsd({ maxBudgetUsd: 0.01 }, ledger.getDecision("d1")) === 0.01, "budget is the plan's via-Agent402 estimate, or the caller's maxBudgetUsd");
  ok(executeQuoteUsd({ decisionId: "d1" }, { ledger, now: clock }) === 0.031, "no credit: the 402 quotes the whole budget");
  ok(executeQuoteUsd({ decisionId: "d1", creditToken: c.token }, { ledger, now: clock }) === 0.011, "a valid credit is taken off the quote");
  ok(executeQuoteUsd({ decisionId: "d1", creditToken: c.token, maxBudgetUsd: 0.01 }, { ledger, now: clock }) === 0.001, "a credit larger than the budget leaves the settlement floor");
  ok(executeQuoteUsd({ decisionId: "missing" }, { ledger, now: clock }) === 0.001, "an unknown decision quotes the floor (and the handler then refuses, uncharged)");
  globalThis.__credit1 = c.token;
}

// ---- a full run: first party, then an external step through the router ----
{
  calls.length = 0;
  const req = mkReq();
  const out = await exec({ decisionId: "d1", creditToken: globalThis.__credit1, params: { 2: { q: "given" } } }, req);
  ok(out.status === "complete" && out.steps.length === 2 && out.steps.every((s) => s.status === "ok"), "both steps ran");
  const rcall = calls.find((c) => c[0] === "router")?.[1];
  ok(rcall && rcall.include === "external" && rcall.target === "https://seller.example/x" && rcall.params.q === "given", "the external step is pinned to the planned endpoint and gets the caller's params");
  ok(out.steps[1].costUsd === 0.0189 && out.steps[1].routingFeeUsd === 0.0009 && out.steps[0].costUsd === 0.01, "cost = seller's actual price + disclosed fee on third-party steps; list price, no fee, on first-party");
  ok(out.creditAppliedUsd === 0.02 && out.paidUsd === 0.011 && out.budgetUsd === 0.031, "the credit is redeemed against the run");
  ok(out.leftoverCredit && out.leftoverCredit.amountUsd === 0.0021 && ledger.creditState(out.leftoverCredit.token).state === "pending", "unspent budget comes back as a credit, pending until settlement");
  settle(req, 200);
  ok(ledger.creditState(out.leftoverCredit.token).state === "active", "the leftover credit activates on a settled 200");
  ok(ledger.creditState(out.leftoverCredit.token).expiresAt === ledger.getDecision("d1").createdAt + 24 * 3600_000, "the leftover keeps the decision's expiry: no fresh window");
  ok(out.steps[1].untrustedContent === true, "third-party output is marked untrusted");
}

// ---- fallback order, and a first-party failure falls to the next tool ----
{
  calls.length = 0;
  failA = true;
  const out = await exec({ decisionId: "d1", params: { 2: { q: "z" } }, maxBudgetUsd: 0.05 }, mkReq("0xf"));
  failA = false;
  ok(out.steps[0].status === "ok" && out.steps[0].tool.slug === "b" && out.steps[0].attempts[0].error, "a failing primary falls to its fallback");
}

// ---- budget hard stop ----
{
  calls.length = 0;
  const out = await exec({ decisionId: "d1", maxBudgetUsd: 0.015, params: { 2: { q: "z" } } }, mkReq("0xg"));
  ok(out.spentUsd <= 0.015 && out.steps[1].status === "failed" && out.steps[1].attempts.every((a) => a.skipped === "over the remaining budget"), `spend never passes the budget (${out.spentUsd})`);
  ok(!calls.some((c) => c[0] === "router"), "a step that does not fit the remaining budget is never started");
}

// ---- params that do not fit the schema are never sent ----
{
  calls.length = 0;
  const out = await exec({ decisionId: "d1", params: { 1: { wrong: 1 }, 2: { q: "z" } } }, mkReq("0xh"));
  ok(out.steps[0].status === "failed" && out.steps[0].attempts.every((a) => /params do not fit/.test(a.skipped)) && !calls.some((c) => c[0] === "a"), "invalid params: the tool is not called");
}

// ---- a paid external failure is not followed by another paid seller ----
{
  calls.length = 0;
  routerMode = "committed";
  const plan2 = [{ step: 1, purpose: "x", tool: tool("e1", { firstParty: false, seller: "s1.example", endpoint: "https://s1.example/x" }), fallbacks: [tool("e2", { firstParty: false, seller: "s2.example", endpoint: "https://s2.example/x" })], dependsOn: [] },
    { step: 2, purpose: "y", tool: tool("a"), fallbacks: [], dependsOn: [] }];
  ledger.saveDecision({ decisionId: "d2", depth: "plan", priceUsd: 0.02, plan: plan2, costViaUsd: 0.05, now: clock });
  ledger.markDecisionSettled("d2");
  const out = await exec({ decisionId: "d2" }, mkReq("0xi"));
  routerMode = "ok";
  ok(calls.filter((c) => c[0] === "router").length === 1 && out.steps[0].status === "failed", "a committed external payment stops the step: no second paid seller");
}

// ---- nothing succeeds: 502, not charged, credit restored ----
{
  routerMode = "fail";
  failA = true;
  const plan3 = [{ step: 1, purpose: "x", tool: tool("a"), fallbacks: [], dependsOn: [] }];
  ledger.saveDecision({ decisionId: "d3", depth: "quick", priceUsd: 0.005, plan: plan3, costViaUsd: 0.01, now: clock });
  ledger.markDecisionSettled("d3");
  const c = ledger.mintCredit({ decisionId: "d3", amountUsd: 0.005, ttlMs: 3600_000, now: clock });
  ledger.activateCredit(c.hash);
  const e = await throwsWith(() => exec({ decisionId: "d3", creditToken: c.token }, mkReq("0xj")), 502, "Nothing was charged", "a run where no step succeeds is a 502 (settlement cancelled)");
  ok(ledger.creditState(c.token).state === "active", "...and its credit is back");
  failA = false; routerMode = "ok";
}

// ---- a settled-then-failed payment puts the redeemed credit back ----
{
  const plan4 = [{ step: 1, purpose: "x", tool: tool("a"), fallbacks: [], dependsOn: [] }];
  ledger.saveDecision({ decisionId: "d4", depth: "quick", priceUsd: 0.005, plan: plan4, costViaUsd: 0.01, now: clock });
  ledger.markDecisionSettled("d4");
  const c = ledger.mintCredit({ decisionId: "d4", amountUsd: 0.005, ttlMs: 3600_000, now: clock });
  ledger.activateCredit(c.hash);
  const req = mkReq("0xk");
  await exec({ decisionId: "d4", creditToken: c.token }, req);
  ok(ledger.creditState(c.token).state === "redeemed", "redeemed during the run");
  settle(req, 402);
  ok(ledger.creditState(c.token).state === "active", "settlement failed afterwards: the credit is restored");
}

// ---- concurrent redemption: spend only what was actually paid ----
{
  const plan5 = [{ step: 1, purpose: "x", tool: tool("a", { priceUsd: 0.01 }), fallbacks: [], dependsOn: [] }, { step: 2, purpose: "y", tool: tool("c", { priceUsd: 0.01 }), fallbacks: [], dependsOn: [] }];
  ledger.saveDecision({ decisionId: "d5", depth: "plan", priceUsd: 0.02, plan: plan5, costViaUsd: 0.02, now: clock });
  ledger.markDecisionSettled("d5");
  const c = ledger.mintCredit({ decisionId: "d5", amountUsd: 0.01, ttlMs: 3600_000, now: clock });
  ledger.activateCredit(c.hash);
  ledger.redeemCredit(c.token, "d5", "someone-else", clock); // taken between quote and run
  // quote was made while the credit was active: paid = 0.02 - 0.01 = 0.01
  const realAvail = ledger.creditAvailableUsd;
  ledger.creditAvailableUsd = () => 0.01; // what the quote saw
  const out = await exec({ decisionId: "d5", creditToken: c.token }, mkReq("0xl"));
  ledger.creditAvailableUsd = realAvail;
  ok(out.budgetUsd === 0.01 && out.spentUsd <= 0.01 && out.creditAppliedUsd === 0, "a credit lost to a concurrent run shrinks the budget to what this buyer paid");
}

// ---- no roll-forward: a decision past its window returns no leftover credit ----
{
  const planL = [{ step: 1, purpose: "x", tool: tool("a", { priceUsd: 0.001 }), fallbacks: [], dependsOn: [] }];
  ledger.saveDecision({ decisionId: "dL", depth: "quick", priceUsd: 0.005, plan: planL, costViaUsd: 0.001, now: clock - 24 * 3600_000 + 30_000 });
  ledger.markDecisionSettled("dL");
  const out = await exec({ decisionId: "dL", maxBudgetUsd: 0.01 }, mkReq("0xroll"));
  ok(out.leftoverCredit === null, "a decision about to expire mints no leftover credit, so none outlives it");
}

// ---- caps, refused before spending ----
{
  const plan6 = [{ step: 1, purpose: "x", tool: tool("a", { priceUsd: 2 }), fallbacks: [], dependsOn: [] }];
  ledger.saveDecision({ decisionId: "d6", depth: "quick", priceUsd: 0.005, plan: plan6, costViaUsd: 2, now: clock });
  ledger.markDecisionSettled("d6");
  process.env.DECIDE_CONFIG = JSON.stringify({ execute: { perWalletHourUsd: 3, globalDayUsd: 100 } });
  await exec({ decisionId: "d6" }, mkReq("0xcap"));
  calls.length = 0;
  await throwsWith(() => exec({ decisionId: "d6" }, mkReq("0xcap")), 429, "hourly execution ceiling", "the per-wallet hourly ceiling refuses before spending");
  ok(!calls.length, "...and no tool ran");
  process.env.DECIDE_CONFIG = JSON.stringify({ execute: { globalDayUsd: 1 } });
  await throwsWith(() => exec({ decisionId: "d6" }, mkReq("0xother")), 429, "paused for everyone", "the global daily ceiling refuses too");
  process.env.DECIDE_CONFIG = JSON.stringify({ execute: { perCallMaxUsd: 0.5 } });
  ok(executeBudgetUsd({ maxBudgetUsd: 10 }, ledger.getDecision("d6")) === 0.5, "per-call ceiling caps the budget whatever the caller asks");
  delete process.env.DECIDE_CONFIG;
}

// ---- decide mints a pending credit, activated only by a settled 200 ----
{
  const saved = [];
  const fakeLedger = { ...ledger, saveDecision: (x) => saved.push(x), mintCredit: ledger.mintCredit, activateCredit: ledger.activateCredit, markDecisionSettled: () => {} };
  const realFetch = globalThis.fetch;
  process.env.DECIDE_SERVICE_URL = "http://127.0.0.1:1"; process.env.DECIDE_INTERNAL_TOKEN = "t".repeat(32);
  globalThis.fetch = async () => new Response(JSON.stringify({ decisionId: "dx", plan: [{ step: 1, tool: tool("a"), fallbacks: [] }], gaps: [], estimatedCostViaAgent402Usd: 0.01 }), { status: 200 });
  const req = mkReq();
  const out = await makeDecideHandler({ ledger: fakeLedger, now })({ task: "do it", depth: "full" }, req);
  globalThis.fetch = realFetch;
  ok(out.executionCredit?.amountUsd === 0.05 && out.executionCredit.activeAfterPaymentSettles, "decide returns a credit worth the fee (config: 100%)");
  ok(ledger.creditState(out.executionCredit.token).state === "pending", "...pending until the decision's payment settles");
  settle(req, 402);
  ok(ledger.creditState(out.executionCredit.token).state === "pending", "a failed settlement never activates it");
  settle(req, 200);
  ok(ledger.creditState(out.executionCredit.token).state === "active", "a settled 200 does");
}

console.log(`\ntest-decide-execute: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
