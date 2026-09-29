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

export async function decideHandler(input, req) {
  const depth = String(input?.depth ?? "plan").toLowerCase();
  if (!DEPTHS.includes(depth)) throw bad(`"depth" must be one of ${DEPTHS.join(", ")}`);
  const cfg = decideConfig();
  const priceUsd = decideQuoteUsd(input);
  const out = await callService("/internal/decide", {
    task: input?.task, constraints: input?.constraints, depth,
    payer: req ? payerFromRequest(req) || req.mppTempoPayer || null : null,
    rail: req?.mppTempoCredential ? "mpp" : "x402",
    priceUsd,
  }, { timeoutMs: cfg.budgetMs[depth] + 4000 });
  fileGaps(out.gaps, req);
  return {
    ...out,
    priceUsd,
    neutrality: "Ranking is identical for tools sold by Agent402 and by other sellers; each tool carries firstParty so the source is disclosed.",
    upgrade: depth === "quick" ? "depth \"plan\" adds steps and fallbacks; \"full\" adds params, a compiled prompt and cost/latency estimates" : undefined,
  };
}

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

export const DECIDE_TOOLS = [
  {
    route: "POST /api/decide",
    name: "Decide: tool plan for a task",
    slug: "decide",
    category: "agents",
    price: `$${priceForDepth("quick").toFixed(3)}`,
    quote: (body) => decideQuoteUsd(body),
    description:
      "Describe a job and get a call-ready plan: which tools, across this catalog and every indexed x402/MPP seller, solve it end to end, in what order, with fallbacks, input params that validate against each tool's schema, and cost/latency estimates. Priced by depth: quick (one best tool), plan (steps + fallbacks), full (plan + params + compiled prompt). Ranking is neutral; every tool carries firstParty. Uncovered needs are listed in gaps.",
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
    handler: decideHandler,
  },
];
