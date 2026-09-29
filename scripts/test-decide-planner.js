// Decide phase 2: ranking neutrality, the planner's steps/fallbacks/gaps,
// params that validate against each tool's schema, the live-window and schema
// filters, deadlines and model failure (partial plans), input validation and
// the decision cache. Offline: stub embedder and stub model.
//
//   node scripts/test-decide-planner.js

import { scoreCandidates, reliabilityScore, priceScore, freshnessScore } from "../services/decide/rank.js";
import { buildDecision, parseDecideInput, cacheKeyFor, compilePrompt } from "../services/decide/planner.js";
import { validateParams, skeletonParams, pruneParams } from "../services/decide/params.js";
import { DEFAULTS, decideConfig, priceForDepth } from "../services/decide/config.js";
import { makeDecisionCache, makeGate, MemoryDecisionStore } from "../services/decide/decision-store.js";
import { extractJson, judgePrompt } from "../services/decide/llm.js";
import { ToolIndex } from "../services/decide/tool-index.js";
import { localToolRow, remoteToolRow } from "../src/decide/tool-rows.js";
import { decideQuoteUsd } from "../src/tools/decide-kit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };
const rejects = async (fn, frag, m) => { let e = null; try { await fn(); } catch (x) { e = x; } ok(e && e.statusCode === 400 && String(e.message).includes(frag), `${m} (${e ? e.message.slice(0, 80) : "no throw"})`); };
const NOW = 1_800_000_000_000;
const cfg = decideConfig({});

// ---- neutrality: identical stats score identically, first or third party ----
{
  const base = localToolRow({ route: "POST /api/x", slug: "x", name: "X", price: "$0.01", description: "does x", discovery: { inputSchema: { properties: { q: { type: "string" } }, required: ["q"] } } }, { now: NOW });
  const fp = { ...base, id: "fp", firstParty: true, seller: "agent402", sellerName: "Agent402" };
  const tp = { ...base, id: "tp", firstParty: false, seller: "other.example", sellerName: "Other", endpoint: "https://other.example/x" };
  const stats = { successes: 10, failures: 2, latency_p95_ms: 900 };
  const scored = scoreCandidates([{ row: fp, fit: 0.8 }, { row: tp, fit: 0.8 }], { reliability: () => stats, weights: cfg.weights, now: NOW, halfLifeHours: 72 });
  ok(scored[0].score === scored[1].score && JSON.stringify(scored[0].parts) === JSON.stringify(scored[1].parts), `identical stats: first party ${scored.find((x) => x.row.id === "fp").score} = third party ${scored.find((x) => x.row.id === "tp").score}`);
  ok(!Object.keys(cfg.weights).some((k) => /first|party|house|own/i.test(k)), "no ranking weight refers to who sells the tool");
  const better = scoreCandidates([{ row: fp, fit: 0.5 }, { row: tp, fit: 0.9 }], { reliability: () => stats, weights: cfg.weights, now: NOW, halfLifeHours: 72 });
  ok(better[0].row.id === "tp", "a better-fitting third-party tool outranks a first-party one");
  ok(reliabilityScore({ successes: 0, failures: 0 }, 0.9) === 0.9 && reliabilityScore({ successes: 20, failures: 0 }, 0.1) > 0.9, "reliability: crawler health until observations accumulate, then observed success");
  ok(priceScore(0.01, 0.01) === 0.5 && priceScore(0.001, 0.01) > priceScore(0.1, 0.01), "cheaper scores higher, relative to the step's median");
  ok(freshnessScore(NOW, NOW, 72) === 1 && freshnessScore(NOW - 72 * 3600_000, NOW, 72) === 0.5 && freshnessScore(null, NOW, 72) === 0, "freshness halves per half-life; unknown is zero");
}

// ---- params ----
{
  const schema = { type: "object", properties: { q: { type: "string" }, n: { type: "integer" }, mode: { type: "string", enum: ["a", "b"] } }, required: ["q"] };
  ok(validateParams(schema, { q: "x", n: 3, mode: "a" }).ok, "valid params pass");
  ok(!validateParams(schema, { n: 3 }).ok && !validateParams(schema, { q: "x", n: "3" }).ok && !validateParams(schema, { q: "x", mode: "c" }).ok && !validateParams(schema, { q: "x", extra: 1 }).ok, "missing required, wrong type, bad enum and unknown keys fail");
  ok(validateParams(schema, { q: "{{step 1}}" }).ok, "a reference to an earlier step's output is allowed");
  ok(validateParams(schema, skeletonParams(schema)).ok && skeletonParams(schema).q === "<q>", "the skeleton validates and names what to fill in");
  ok(!Object.hasOwn(pruneParams(schema, JSON.parse('{"q":"x","__proto__":{"p":1},"zz":1}')), "__proto__") && Object.keys(pruneParams(schema, { q: "x", zz: 1 })).join() === "q", "pruning keeps only declared properties");
}

// ---- a small index ----
const mk = (id, over = {}) => ({
  ...localToolRow({ route: `POST /api/${id}`, slug: id, name: over.name || id, price: over.price || "$0.01", description: over.description || id, discovery: { input: over.example || null, inputSchema: { properties: over.props || { q: { type: "string" } }, required: over.required || ["q"] } } }, { now: NOW }),
  ...(over.row || {}),
});
function buildIndex() {
  const idx = new ToolIndex();
  idx.upsert(mk("btcprice", { description: "current bitcoin price in usd", props: { coin: { type: "string" } }, required: ["coin"], example: { coin: "bitcoin" } }));
  idx.upsert(mk("ethprice", { description: "current ethereum price in usd", props: { coin: { type: "string" } }, required: ["coin"] }));
  const third = remoteToolRow({ seller: "https://fng.example", route: "/fng", method: "GET", name: "Fear and greed index", description: "crypto fear and greed index today", price: 0.002, networks: ["eip155:8453"], health: 0.95 },
    { requestContract: { state: "absent", required: {} }, lastLiveAt: NOW - 3600_000 });
  idx.upsert(third);
  const stale = remoteToolRow({ seller: "https://stale.example", route: "/fng2", method: "GET", name: "Fear and greed index old", description: "crypto fear and greed index", price: 0.001, networks: ["eip155:8453"] },
    { requestContract: { state: "absent", required: {} }, lastLiveAt: NOW - 30 * 24 * 3600_000 });
  idx.upsert(stale);
  const noschema = remoteToolRow({ seller: "https://noschema.example", route: "/fng3", method: "GET", name: "Fear and greed index unknown", description: "crypto fear and greed index", price: 0.001 }, { lastLiveAt: NOW });
  idx.upsert(noschema);
  return { idx, third, stale, noschema };
}
const noEmbed = async () => { throw new Error("offline"); };
const fakeEmbed = async (texts) => texts.map((t) => Array.from({ length: 512 }, (_, i) => Math.sin(i + t.length)));

function stubLlm(responses) {
  const calls = [];
  return { calls, call: async (system, user, opts) => { calls.push({ system, user, opts }); const r = responses.shift(); return typeof r === "function" ? r(system, user) : r ?? null; } };
}
const keysFor = (user) => { const m = user.match(/<listings>(.*)<\/listings>/s); return JSON.parse(m[1]); };

// ---- plan: decompose, judge by key, params, gaps ----
{
  const { idx, third } = buildIndex();
  const llm = stubLlm([
    { steps: [{ purpose: "bitcoin price", query: "bitcoin price", dependsOn: [] }, { purpose: "fear and greed", query: "fear and greed index", dependsOn: [] }, { purpose: "weather on mars", query: "mars weather", dependsOn: [1] }] },
    (system, user) => {
      const listing = keysFor(user);
      const fits = {};
      for (const s of listing) for (const c of s.candidates) fits[c.key] = /ENTIRE/.test(s.purpose) ? 0.3 : /bitcoin/i.test(s.purpose) && /bitcoin/.test(c.description) ? 0.95 : /fear/i.test(s.purpose) && /fear/.test(c.description) ? 0.9 : 0.1;
      return { fits };
    },
    { params: { "1": { coin: "bitcoin", injected: "x" }, "2": {} } },
  ]);
  const d = await buildDecision({ task: "bitcoin price and fear and greed index", constraints: {}, depth: "full" }, { index: idx, embed: fakeEmbed, llm, cfg, now: NOW, deadline: Date.now() + 20_000 });
  ok(d.plan.length === 2 && d.plan[0].tool.slug === "btcprice" && d.plan[1].tool.id === third.id, `steps pick the fitting tools (${d.plan.map((p) => p.tool.slug).join(", ")})`);
  ok(d.plan[1].tool.firstParty === false && d.plan[1].tool.seller === "fng.example" && d.plan[0].tool.firstParty === true, "every tool discloses firstParty and seller");
  ok(d.gaps.length === 1 && /mars/.test(d.gaps[0]), "an uncovered step is a gap, not a bad pick");
  ok(d.plan.every((p) => validateParams(p.tool.inputSchema, p.tool.exampleParams).ok), "every step's exampleParams validate against its schema");
  ok(d.plan[0].tool.exampleParams.coin === "bitcoin" && !("injected" in d.plan[0].tool.exampleParams) && d.plan[0].tool.exampleParamsSource === "task", "model params are pruned to declared fields and validated");
  ok(!d.partial && d.confidence > 0 && d.confidence < 1, `coverage lowers confidence (${d.confidence})`);
  ok(typeof d.compiledPrompt === "string" && d.compiledPrompt.includes(d.plan[1].tool.endpoint) && d.compiledPrompt.includes("No indexed tool covers"), "full depth compiles a prompt with endpoints and gaps");
  ok(d.estimatedCostUsd === Math.round((d.plan[0].tool.priceUsd + d.plan[1].tool.priceUsd) * 1e6) / 1e6 && d.estimatedCostViaAgent402Usd > d.estimatedCostUsd, "cost estimate sums the plan; via-Agent402 adds the routing fee on third-party steps only");
  ok(d.plan[1].tool.executeViaAgent402Usd === Math.round(0.002 * 1.05 * 1e6) / 1e6 && d.plan[0].tool.executeViaAgent402Usd === d.plan[0].tool.priceUsd, "routing fee: third party only, at the configured rate");
  ok(d.ranking.firstPartyWeight === 0, "the decision states the first-party weight is zero");
  const judge = llm.calls[1];
  ok(/untrusted third-party listing data/.test(judge.system) && judge.user.includes("<listings>"), "outside listings reach the model fenced as data");
}

// ---- live window and schema filters ----
{
  const { idx, stale, noschema } = buildIndex();
  const llm = stubLlm([(s, user) => { const fits = {}; for (const st of keysFor(user)) for (const c of st.candidates) fits[c.key] = 0.9; return { fits }; }]);
  const d = await buildDecision({ task: "fear and greed index", constraints: {}, depth: "quick" }, { index: idx, embed: noEmbed, llm, cfg, now: NOW, deadline: Date.now() + 10_000 });
  const all = d.plan.flatMap((p) => [p.tool.id, ...p.fallbacks.map((f) => f.id)]);
  ok(!all.includes(stale.id), "a third-party tool with no live 402 inside the window is never recommended");
  ok(!all.includes(noschema.id), "a tool whose input schema is unknown is never recommended");
}

// ---- model failures: partial plans, never a hang ----
{
  const { idx } = buildIndex();
  const t0 = Date.now();
  const hang = { call: () => new Promise(() => {}) };
  const d = await buildDecision({ task: "bitcoin price", constraints: {}, depth: "plan" }, { index: idx, embed: noEmbed, llm: hang, cfg: { ...cfg, llmTimeoutMs: 300 }, now: NOW, deadline: Date.now() + 2500 });
  ok(Date.now() - t0 < 4000 && d.partial === true && d.plan.length >= 1, `a model that never answers still yields a partial plan in time (${Date.now() - t0} ms)`);
  ok(d.notes.some((n) => /decomposition unavailable/.test(n)) && d.confidence < 0.8, "the partial plan says what was skipped and lowers confidence");
  const garbage = stubLlm([{ steps: "nope" }, { fits: { bogus: 1, s9c9: 1 } }, null]);
  const g = await buildDecision({ task: "bitcoin price", constraints: {}, depth: "plan" }, { index: idx, embed: noEmbed, llm: garbage, cfg, now: NOW, deadline: Date.now() + 10_000 });
  ok(g.partial && g.notes.some((n) => /fit judging unavailable/.test(n)), "unknown or invented candidate keys are ignored, not trusted");
}

// ---- whole task in one tool ----
{
  const idx = new ToolIndex();
  idx.upsert(mk("dossier", { description: "company dossier from sec filings and insider trades" }));
  idx.upsert(mk("filings", { description: "sec filings" }));
  idx.upsert(mk("insiders", { description: "insider trades" }));
  const llm = stubLlm([
    { steps: [{ purpose: "sec filings", query: "sec filings" }, { purpose: "insider trades", query: "insider trades" }] },
    (s, user) => { const fits = {}; const L = keysFor(user); L.forEach((st) => st.candidates.forEach((c) => { fits[c.key] = /ENTIRE/.test(st.purpose) && c.name === "dossier" ? 0.95 : 0.7; })); return { fits }; },
    { params: {} },
  ]);
  const d = await buildDecision({ task: "company dossier from sec filings and insider trades", constraints: {}, depth: "plan" }, { index: idx, embed: noEmbed, llm, cfg, now: NOW, deadline: Date.now() + 10_000 });
  ok(d.plan.length === 1 && d.plan[0].tool.slug === "dossier" && d.notes.includes("one tool covers the whole task"), "a tool that covers the whole task replaces a multi-step plan");
}

// ---- dependsOn survives a dropped step ----
{
  const { idx } = buildIndex();
  const llm = stubLlm([
    { steps: [{ purpose: "mars weather", query: "mars" }, { purpose: "bitcoin price", query: "bitcoin price" }, { purpose: "fear and greed", query: "fear greed", dependsOn: [2] }] },
    (s, user) => { const fits = {}; for (const st of keysFor(user)) for (const c of st.candidates) fits[c.key] = /ENTIRE/.test(st.purpose) ? 0 : /bitcoin/i.test(st.purpose) && /bitcoin/.test(c.description) ? 0.9 : /fear/i.test(st.purpose) && /fear/.test(c.description) ? 0.9 : 0; return { fits }; },
    null,
  ]);
  const d = await buildDecision({ task: "x", constraints: {}, depth: "plan" }, { index: idx, embed: noEmbed, llm, cfg, now: NOW, deadline: Date.now() + 10_000 });
  ok(d.plan.length === 2 && d.plan[1].dependsOn.join() === "1", `dependsOn is renumbered when an earlier step becomes a gap (${JSON.stringify(d.plan.map((p) => p.dependsOn))})`);
}

// ---- budget constraint ----
{
  const { idx } = buildIndex();
  const llm = stubLlm([(s, user) => { const fits = {}; for (const st of keysFor(user)) for (const c of st.candidates) fits[c.key] = 0.9; return { fits }; }]);
  const d = await buildDecision({ task: "bitcoin price", constraints: { maxBudgetUsd: 0.005 }, depth: "quick" }, { index: idx, embed: noEmbed, llm, cfg, now: NOW, deadline: Date.now() + 10_000 });
  ok(d.plan.every((p) => p.tool.priceUsd <= 0.005 && p.fallbacks.every((f) => f.priceUsd <= 0.005)), "no tool over maxBudgetUsd is recommended");
}

// ---- input validation ----
await rejects(() => parseDecideInput({}), '"task" is required', "missing task");
await rejects(() => parseDecideInput({ task: "abc", depth: "huge" }), '"depth"', "unknown depth");
await rejects(() => parseDecideInput({ task: "abc", constraints: { rails: ["card"] } }), "rails", "unknown rail");
await rejects(() => parseDecideInput({ task: "abc", constraints: { maxBudgetUsd: -1 } }), "maxBudgetUsd", "negative budget");
await rejects(() => parseDecideInput({ task: "abc", constraints: { chains: "base" } }), "chains", "chains must be an array");
ok(parseDecideInput({ task: "  do   the thing ", constraints: { requireDeterministic: "yes" } }).constraints.requireDeterministic === undefined, "requireDeterministic must be literally true");

// ---- cache, gate, prices ----
ok(cacheKeyFor("Do the Thing", { rails: ["mpp", "x402"] }, "plan") === cacheKeyFor("do   the thing", { rails: ["x402", "mpp"] }, "plan"), "cache key normalizes case, spacing and list order");
ok(cacheKeyFor("x", {}, "plan") !== cacheKeyFor("x", {}, "full") && cacheKeyFor("x", {}, "plan") !== cacheKeyFor("x", { maxBudgetUsd: 1 }, "plan"), "depth and constraints are part of the key");
{
  const c = makeDecisionCache(1000);
  c.set("k", { a: 1 }, 0);
  ok(c.get("k", 500)?.a === 1 && c.get("k", 1500) === null, "cache entries expire after the TTL");
}
{
  const g = makeGate(1, 1);
  let release;
  const a = g.run(() => new Promise((r) => { release = r; }));
  const b = g.run(async () => "b");
  let refused = null;
  try { await g.run(async () => "c"); } catch (e) { refused = e; }
  ok(refused?.statusCode === 503 && refused.retryAfter, "the gate refuses past its queue with a retryable 503");
  release("a");
  ok((await a) === "a" && (await b) === "b", "queued work runs when a slot frees");
}
ok(priceForDepth("quick") === DEFAULTS.prices.quick && priceForDepth("full") === DEFAULTS.prices.full && priceForDepth("bogus") === DEFAULTS.prices.plan, "prices come from config by depth");
ok(decideConfig({ DECIDE_CONFIG: '{"prices":{"quick":0.004},"evil":1,"weights":{"fit":"x"}}' }).prices.quick === 0.004 && decideConfig({ DECIDE_CONFIG: '{"prices":{"quick":0.004},"evil":1,"weights":{"fit":"x"}}' }).weights.fit === DEFAULTS.weights.fit && !("evil" in decideConfig({ DECIDE_CONFIG: '{"evil":1}' })), "config overrides merge by key and type; unknown keys are ignored");
ok(decideQuoteUsd({ depth: "full" }) === DEFAULTS.prices.full && decideQuoteUsd({}) === DEFAULTS.prices.plan, "the 402 quote follows depth (default plan)");
ok(extractJson('noise {"a":1} tail') ?.a === 1 && extractJson("nothing") === null, "JSON is extracted from a model's wrapped answer");
{
  const s = new MemoryDecisionStore();
  await s.save({ decisionId: "d1", task: "t", depth: "plan", plan: [{ step: 1, tool: { id: "a", seller: "agent402", firstParty: true }, score: 1, fallbacks: [{ id: "b", seller: "x", firstParty: false, score: 0.5 }] }] }, {});
  ok((await s.get("d1"))?.result.decisionId === "d1" && s.steps.length === 2 && s.steps.some((r) => r.role === "fallback" && r.firstParty === false), "decisions persist with primary and fallback steps");
}

console.log(`\ntest-decide-planner: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
