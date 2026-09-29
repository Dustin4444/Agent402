// decide: a paid decision. The buyer describes a job; the answer is a
// call-ready plan over every tool in the index, ours and every routable
// outside x402/MPP seller, ranked neutrally.
//
// This file is the paid front: the payment gates run first (settlement is
// after the handler, so nothing here is reached unpaid and a >= 400 is never
// charged), then the plan is built by the separate decide service over the
// private network, under a hard timeout. The decide service never sees a
// payment credential.
//
// Listed only when DECIDE_SERVICE_URL and DECIDE_INTERNAL_TOKEN are set.

import { decideConfig, priceForDepth, DEPTHS } from "../../services/decide/config.js";
import { recordWish } from "../wish.js";
import { payerFromRequest } from "../payer.js";
import { openDecideLedger } from "../decide/ledger.js";
import { validateParams } from "../../services/decide/params.js";
import { randomUUID } from "node:crypto";
import { dispatchable } from "./route-execute.js";

const serviceUrl = () => String(process.env.DECIDE_SERVICE_URL || "").replace(/\/+$/, "");
const token = () => String(process.env.DECIDE_INTERNAL_TOKEN || "");
export const decideEnabled = () => !!serviceUrl() && token().length >= 24;

function bad(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }

export async function callService(path, body, { timeoutMs = 30_000, fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(`${serviceUrl()}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw bad(e?.name === "TimeoutError" ? "The decision service did not answer in time - not charged; retry shortly" : "The decision service is unreachable - not charged; retry shortly", 503);
  }
  let j = null;
  try { j = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    // Relay only our own service's 4xx wording; anything else is a generic 5xx.
    if (res.status >= 400 && res.status < 500 && typeof j?.error === "string") throw bad(j.error.slice(0, 300), res.status);
    throw bad("The decision service failed - not charged; retry shortly", res.status === 503 ? 503 : 502);
  }
  return j;
}

/** The 402 price follows the requested depth. */
export function decideQuoteUsd(body) {
  const d = String(body?.depth ?? "plan").toLowerCase();
  return priceForDepth(DEPTHS.includes(d) ? d : "plan");
}

function fileGaps(gaps, req) {
  for (const g of (gaps || []).slice(0, 4)) {
    try { recordWish({ need: String(g).slice(0, 200), context: "decide gap", source: "decide", ip: req?.ip }); } catch { /* the board is best effort */ }
  }
}

// Keyed like the router's spend guard: signed payer, else the verified Tempo
// sender, else the client ip, so no caller is unkeyed.
const payerOf = (req) => (req ? payerFromRequest(req) || (req.mppTempoSender ? `tempo:${req.mppTempoSender}` : null) || (req.ip ? `ip:${req.ip}` : null) : null);
const onFinal = (req, fn) => { if (req && typeof req === "object") (req.__onFinalStatus ||= []).push(fn); };
const roundUsd = (x) => Math.round(x * 1e6) / 1e6;

export function makeDecideHandler({ ledger, now = () => Date.now() }) {
  return async function decideHandler(input, req) {
    const depth = String(input?.depth ?? "plan").toLowerCase();
    if (!DEPTHS.includes(depth)) throw bad(`"depth" must be one of ${DEPTHS.join(", ")}`);
    const cfg = decideConfig();
    const priceUsd = decideQuoteUsd(input);
    const payer = payerOf(req);
    const out = await callService("/internal/decide", {
      task: input?.task, constraints: input?.constraints, depth,
      payer, rail: req?.mppTempoCredential ? "mpp" : "x402", priceUsd,
    }, { timeoutMs: cfg.budgetMs[depth] + 4000 });
    fileGaps(out.gaps, req);
    // The decision is kept here (money side) so execute can price from it;
    // its credit counts only once THIS payment settles.
    ledger.saveDecision({ decisionId: out.decisionId, depth, priceUsd, payer, plan: out.plan, costViaUsd: out.estimatedCostViaAgent402Usd || 0, now: now() });
    const amount = roundUsd(priceUsd * cfg.credit.percentOfFee / 100);
    let executionCredit = null;
    if (amount > 0 && out.plan?.length) {
      const c = ledger.mintCredit({ decisionId: out.decisionId, amountUsd: amount, ttlMs: cfg.credit.ttlHours * 3_600_000, payer, now: now() });
      onFinal(req, (status) => { if (status === 200) { ledger.activateCredit(c.hash); ledger.markDecisionSettled(out.decisionId); } });
      executionCredit = { amountUsd: c.amountUsd, expiresAt: new Date(c.expiresAt).toISOString(), token: c.token, redeemWith: "POST /api/decide/execute { decisionId, creditToken }", activeAfterPaymentSettles: true };
    } else {
      onFinal(req, (status) => { if (status === 200) ledger.markDecisionSettled(out.decisionId); });
    }
    return {
      ...out,
      priceUsd,
      executionCredit,
      neutrality: "Ranking is identical for tools sold by Agent402 and by other sellers; each tool carries firstParty so the source is disclosed.",
      ...(depth === "quick" ? { upgrade: 'depth "plan" adds steps and fallbacks; "full" adds params, a compiled prompt and cost/latency estimates' } : {}),
    };
  };
}

// ---------------------------------------------------------------- execute

/** What an execute call is priced at: its budget less a valid credit, never
 *  under the settlement floor. Sync: reads the local ledger only. */
export function executeQuoteUsd(body, { ledger, now = Date.now() }) {
  const floor = 0.001;
  const d = body?.decisionId ? ledger.getDecision(String(body.decisionId)) : null;
  if (!d) return floor;
  const budget = executeBudgetUsd(body, d);
  const credit = ledger.creditAvailableUsd(body?.creditToken, d.id, now);
  return Math.max(floor, roundUsd(budget - credit));
}

export function executeBudgetUsd(body, d, cfg = decideConfig()) {
  const asked = Number(body?.maxBudgetUsd);
  const planned = Number(d?.costViaUsd) || 0;
  const base = Number.isFinite(asked) && asked > 0 ? asked : planned;
  return roundUsd(Math.min(base, cfg.execute.perCallMaxUsd));
}

function stepParams(step, overrides) {
  const o = overrides && typeof overrides === "object" ? overrides[String(step.step)] : null;
  return o && typeof o === "object" && !Array.isArray(o) ? o : step.tool.exampleParams || {};
}
const REF = /^\{\{step (\d+)\}\}$/;

async function withTimeout(promise, ms, label) {
  let t;
  try {
    return await Promise.race([promise, new Promise((_, r) => { t = setTimeout(() => r(bad(`${label} did not answer within ${Math.round(ms / 1000)} s`, 504)), ms); })]);
  } finally { clearTimeout(t); }
}

export function makeExecuteHandler({ ledger, getCatalog, now = () => Date.now() }) {
  return async function executeHandler(input, req) {
    const cfg = decideConfig();
    const decisionId = String(input?.decisionId || "");
    if (!decisionId) throw bad('"decisionId" is required (from POST /api/decide)');
    const d = ledger.getDecision(decisionId);
    if (!d) throw bad("Unknown decisionId - decisions are kept for this server's own answers only", 404);
    if (!d.settled) throw bad("That decision's payment has not settled, so it cannot be executed", 409);
    if (input.params != null && (typeof input.params !== "object" || Array.isArray(input.params))) throw bad('"params" must be an object keyed by step number');
    const payer = payerOf(req);
    const t = now();
    const budget = executeBudgetUsd(input, d, cfg);
    const creditAtQuote = ledger.creditAvailableUsd(input.creditToken, d.id, t);
    const paid = Math.max(0.001, roundUsd(budget - creditAtQuote));

    // Caps, checked before anything is spent (a >= 400 is never charged).
    if (budget <= 0) throw bad("Nothing to execute: the plan has no priced steps; pass maxBudgetUsd", 400);
    if (payer && ledger.payerExposureUsd(payer, t - 3_600_000) + budget > cfg.execute.perWalletHourUsd) throw bad(`This wallet has reached its hourly execution ceiling ($${cfg.execute.perWalletHourUsd}); nothing was charged`, 429);
    if (ledger.globalExposureUsd(t - 86_400_000) + budget > cfg.execute.globalDayUsd) throw bad("Plan execution is paused for everyone for the rest of the day; nothing was charged", 429);

    const runId = `run_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const redeemed = creditAtQuote > 0 ? ledger.redeemCredit(input.creditToken, d.id, runId, t) : 0;
    // The buyer paid budget minus the credit seen at quote time. If the credit
    // was taken by a concurrent run since, spend only what was paid.
    const spendable = roundUsd(Math.min(budget, paid + redeemed));
    ledger.createRun({ runId, decisionId: d.id, payer, budgetUsd: spendable, creditUsd: redeemed, now: t });

    const catalog = getCatalog();
    const bySlug = new Map(Object.values(catalog).map((def) => [def.slug, def]));
    const router = bySlug.get("route-execute-pro");
    let spent = 0;
    const results = [];
    const outputs = {};
    for (const step of d.plan) {
      const params = stepParams(step, input.params);
      const missingRef = Object.values(params).map((v) => (typeof v === "string" ? REF.exec(v) : null)).find((m) => m && !outputs[m[1]]);
      if (missingRef || Object.values(params).some((v) => typeof v === "string" && REF.test(v))) {
        results.push({ step: step.step, status: "skipped", reason: `needs the output of step ${(missingRef || Object.values(params).map((v) => REF.exec(String(v))).find(Boolean))[1]}: pass params for this step` });
        continue;
      }
      let done = null;
      const attempts = [];
      for (const tool of [step.tool, ...(step.fallbacks || [])]) {
        const cost = tool.firstParty ? tool.priceUsd : roundUsd(tool.priceUsd * (1 + cfg.routingFeePct / 100));
        if (spent + cost > spendable + 1e-9) { attempts.push({ id: tool.id, skipped: "over the remaining budget" }); continue; }
        const v = validateParams(tool.inputSchema, params);
        if (!v.ok) { attempts.push({ id: tool.id, skipped: `params do not fit: ${v.errors.slice(0, 3).join("; ")}` }); continue; }
        try {
          if (tool.firstParty) {
            const def = bySlug.get(tool.slug);
            // The router's own dispatch rules, plus: a tool priced from its body
            // (tierQuote) is never run from a flat budget.
            const why = !def ? "no longer in the catalog" : (!dispatchable(def).ok ? dispatchable(def).why : (typeof def.tierQuote === "function" ? "priced per request; call it directly" : null));
            if (why) { attempts.push({ id: tool.id, skipped: why }); continue; }
            const result = await withTimeout(Promise.resolve(def.handler(params, req)), cfg.execute.stepTimeoutMs, tool.slug);
            spent = roundUsd(spent + cost);
            done = { tool: { id: tool.id, slug: tool.slug, seller: tool.seller, firstParty: true }, costUsd: cost, result };
          } else {
            if (!router) { attempts.push({ id: tool.id, skipped: "external execution is not enabled on this host" }); continue; }
            const maxUsd = Math.min(roundUsd((spendable - spent) / (1 + cfg.routingFeePct / 100)), cfg.execute.perCallMaxUsd);
            const r = await withTimeout(router.handler({ task: `${step.purpose} (${tool.name})`, include: "external", target: tool.endpoint, params, maxUsd }, req), cfg.execute.stepTimeoutMs + 15_000, tool.seller);
            const underlying = Number(r?.receipt?.underlyingPriceUsd) || tool.priceUsd;
            const fee = roundUsd(underlying * cfg.routingFeePct / 100);
            spent = roundUsd(spent + underlying + fee);
            done = { tool: { id: tool.id, slug: tool.slug, seller: tool.seller, firstParty: false }, costUsd: roundUsd(underlying + fee), routingFeeUsd: fee, result: r?.result, receipt: r?.receipt, untrustedContent: true };
          }
          break;
        } catch (e) {
          attempts.push({ id: tool.id, error: String(e?.message || e).slice(0, 240), status: e?.statusCode || 500 });
          // An external payment that may have left the wallet is never
          // followed by another paid seller for the same step.
          if (!tool.firstParty && (e?.committed === true || /no other seller is tried/.test(String(e?.message)))) break;
        }
      }
      if (done) { outputs[String(step.step)] = done.result; results.push({ step: step.step, status: "ok", ...done, ...(attempts.length ? { attempts } : {}) }); }
      else results.push({ step: step.step, status: "failed", attempts });
    }

    const okSteps = results.filter((r) => r.status === "ok").length;
    if (!okSteps) {
      ledger.finishRun({ runId, status: "failed", spentUsd: spent, steps: results, now: now() });
      if (redeemed) ledger.restoreCredit(input.creditToken, runId);
      throw Object.assign(bad(`No step of the plan could be run (${results.map((r) => `step ${r.step}: ${r.reason || (r.attempts || []).map((a) => a.error || a.skipped).join(" / ")}`).join("; ").slice(0, 600)}). Nothing was charged.`, 502), { steps: results });
    }
    ledger.finishRun({ runId, status: okSteps === results.length ? "complete" : "partial", spentUsd: spent, steps: results.map(({ result, ...r }) => r), now: now() });
    // Unspent budget returns as a credit on the same decision, live once this
    // payment settles and expiring with the decision; a settlement that fails
    // puts the redeemed credit back.
    // The leftover keeps the DECISION's expiry (never a fresh window), so a
    // credit cannot be rolled forward run after run.
    const leftover = roundUsd(spendable - spent);
    const decisionExpiry = d.createdAt + cfg.credit.ttlHours * 3_600_000;
    let leftoverCredit = null;
    if (leftover >= 0.001 && decisionExpiry > now() + 60_000) {
      const c = ledger.mintCredit({ decisionId: d.id, amountUsd: leftover, expiresAt: decisionExpiry, payer, now: now() });
      onFinal(req, (status) => { if (status === 200) ledger.activateCredit(c.hash); });
      leftoverCredit = { amountUsd: c.amountUsd, expiresAt: new Date(c.expiresAt).toISOString(), token: c.token, activeAfterPaymentSettles: true };
    }
    if (redeemed) onFinal(req, (status) => { if (status !== 200) ledger.restoreCredit(input.creditToken, runId); });
    return {
      runId, decisionId: d.id, status: okSteps === results.length ? "complete" : "partial",
      steps: results, budgetUsd: spendable, spentUsd: spent, paidUsd: paid, creditAppliedUsd: redeemed,
      routingFeePct: cfg.routingFeePct, leftoverCredit,
    };
  };
}

// ---------------------------------------------------------------- feedback (phase 4)

const EXAMPLE_OUT = {
  decisionId: "dec_2b1c9e0f4a7d4c3e9b8a1f00",
  task: "Research the latest EU AI Act obligations for general-purpose models, with citations",
  depth: "plan",
  plan: [{
    step: 1, purpose: "search recent sources on the EU AI Act GPAI obligations",
    tool: { id: "a1b2", slug: "search", name: "Web search", seller: "agent402", firstParty: true, endpoint: "https://agent402.tools/api/search", method: "GET", rail: "x402", rails: ["x402", "mpp"], networks: ["eip155:8453"], priceUsd: 0.02, executeViaAgent402Usd: 0.02, inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] }, exampleParams: { q: "EU AI Act general-purpose AI model obligations 2026" }, exampleParamsSource: "task" },
    why: "fit 0.92, score 0.801", score: 0.801, fallbacks: [], dependsOn: [],
  }],
  estimatedCostUsd: 0.02, estimatedCostViaAgent402Usd: 0.02, estimatedLatencyMs: 1500,
  confidence: 0.92, partial: false, gaps: [], cached: false, priceUsd: 0.02,
  ranking: { weights: { fit: 0.45, reliability: 0.2, price: 0.15, schema: 0.1, freshness: 0.1 }, firstPartyWeight: 0 },
  neutrality: "Ranking is identical for tools sold by Agent402 and by other sellers; each tool carries firstParty so the source is disclosed.",
};

export function buildDecideTools({ getCatalog, ledger = openDecideLedger(), now = () => Date.now() } = {}) {
  return [
    {
      route: "POST /api/decide",
      name: "Decide: tool plan for a task",
      slug: "decide",
      category: "agents",
      price: `$${priceForDepth("quick").toFixed(3)}`,
      quote: (body) => decideQuoteUsd(body),
      description:
        "Describe a job and get a call-ready plan: which tools, across this catalog and every indexed x402/MPP seller, solve it end to end, in what order, with fallbacks, input params that validate against each tool's schema, and cost/latency estimates. Priced by depth: quick (one best tool), plan (steps + fallbacks), full (plan + params + compiled prompt). The fee comes back as a 24-hour credit toward running the plan with POST /api/decide/execute. Ranking is neutral; every tool carries firstParty. Uncovered needs are listed in gaps.",
      tags: ["agents", "routing", "planning", "discovery", "x402"],
      discovery: {
        bodyType: "json",
        input: { task: "Research the latest EU AI Act obligations for general-purpose models, with citations", depth: "plan" },
        inputSchema: {
          properties: {
            task: { type: "string", description: "What the agent needs done (max 2000 chars)" },
            depth: { type: "string", enum: DEPTHS, description: "quick | plan (default) | full" },
            constraints: { type: "object", description: "maxBudgetUsd, maxLatencyMs, rails [x402|mpp], chains [CAIP-2 or namespace], excludeSellers [host], requireDeterministic" },
          },
          required: ["task"],
        },
        output: { example: EXAMPLE_OUT },
      },
      handler: makeDecideHandler({ ledger, now }),
    },
    {
      route: "POST /api/decide/execute",
      name: "Decide: execute a plan",
      slug: "decide-execute",
      category: "agents",
      price: "$0.001",
      spendsOwnWallet: true,
      quote: (body) => executeQuoteUsd(body, { ledger, now: now() }),
      description:
        "Run a decision's plan through Agent402: first-party steps run directly, third-party steps are paid on your behalf and relayed at the seller's price plus a disclosed routing fee. Priced at the plan's budget (or your maxBudgetUsd, whichever you set) less a valid execution credit; spend stops at that budget, fallbacks are tried in order, and any unspent amount comes back as a credit. A run where no step succeeds is not charged.",
      tags: ["agents", "execute", "planning", "router", "x402"],
      discovery: {
        bodyType: "json",
        input: { decisionId: "dec_2b1c9e0f4a7d4c3e9b8a1f00", creditToken: "dc_...", maxBudgetUsd: 0.05 },
        inputSchema: {
          properties: {
            decisionId: { type: "string", description: "From POST /api/decide" },
            creditToken: { type: "string", description: "executionCredit.token from that decision (optional)" },
            maxBudgetUsd: { type: "number", description: "Spend ceiling for the run (default: the plan's estimate via Agent402)" },
            params: { type: "object", description: "Per-step params overriding the plan's exampleParams, keyed by step number" },
          },
          required: ["decisionId"],
        },
        output: { example: { runId: "run_…", decisionId: "dec_…", status: "complete", steps: [{ step: 1, status: "ok", tool: { slug: "search", seller: "agent402", firstParty: true }, costUsd: 0.02, result: {} }], budgetUsd: 0.02, spentUsd: 0.02, paidUsd: 0.001, creditAppliedUsd: 0.02, routingFeePct: 5, leftoverCredit: null } },
      },
      handler: makeExecuteHandler({ ledger, getCatalog, now }),
    },
  ];
}
