// research-deep — grounded multi-search + rerank + synthesis report tools.
// One request, one payment, one cited report. Three tiers priced per report
// ($5/$15/$30). Payable like any paid route (crypto/x402/MPP or card).
//
// Composes gateway primitives in-process (never loopback HTTP to our own paid
// routes): fetchOpenRouter for plan/search/synthesis, OpenRouter's `web` (Exa)
// plugin for grounding, and the cohere/rerank-v3.5 router for relevance.
// Upstream token cost is small against the price; the pipeline shape is FIXED
// per tier and a per-tier upstream cap is the circuit breaker, so no input can
// blow the margin. NOT deterministic (LLM + live web) → WALLET_ONLY, lenient
// NETWORK test set, never cached (the web moves). Gated on OPENROUTER_API_KEY
// (503 without it), independent of Stripe keys.
import { fetchOpenRouter, throwUpstreamError, RERANK_MODEL, bad } from "./llm-gateway-kit.js";

const RERANK_URL = "https://openrouter.ai/api/v1/rerank";

// Models: all already in the gateway's live-catalog guard tables (gemini flex
// table; claude reasoning table) so they can't silently die untested.
const M = {
  plan: "google/gemini-2.5-flash-lite",  // cheap planner
  ground: "google/gemini-2.5-flash",     // grounded search + read
  synthStd: "anthropic/claude-sonnet-5", // standard synthesis
  synthPrem: "anthropic/claude-opus-5",  // premium synthesis
};

export const RESEARCH_TIERS = {
  "research": { price: "$5", maxUpstreamUsd: 1.5, subQ: 3, searches: 3, topK: 15, synth: M.synthStd, synthMaxTokens: 2500, words: "~1,500" },
  "research-pro": { price: "$15", maxUpstreamUsd: 4.5, subQ: 6, searches: 8, topK: 30, synth: M.synthPrem, synthMaxTokens: 4000, words: "~3,000" },
  "research-max": { price: "$30", maxUpstreamUsd: 9.0, subQ: 12, searches: 12, topK: 40, synth: M.synthPrem, synthMaxTokens: 6000, words: "~5,000" },
};
// Models this kit routes to — exported so the live-catalog guard checks them.
export const RESEARCH_MODELS = [M.plan, M.ground, M.synthStd, M.synthPrem];

const MAX_QUERY_CHARS = 2000;
const SEARCH_TIMEOUT_MS = 60_000;
const SYNTH_TIMEOUT_MS = 120_000;

async function chat(body, timeoutMs) {
  // usage.include gets `usage.cost` back so we can meter margin; stripped
  // before the buyer ever sees the response.
  const res = await fetchOpenRouter({ ...body, usage: { include: true } }, { timeoutMs });
  if (!res.ok) await throwUpstreamError(res);
  return res.json();
}
async function rerankCall(query, documents, topN) {
  const res = await fetchOpenRouter({ model: RERANK_MODEL, query, documents, top_n: topN }, { url: RERANK_URL, timeoutMs: 30_000 });
  if (!res.ok) await throwUpstreamError(res);
  return res.json();
}
const costOf = (data) => Number(data?.usage?.cost) || 0;
const textOf = (data) => (data?.choices?.[0]?.message?.content || "").trim();

// Sources from a grounded answer: OpenRouter web plugin returns url_citation
// annotations on message.annotations.
function sourcesFrom(data) {
  const anns = data?.choices?.[0]?.message?.annotations || [];
  const out = [];
  for (const a of anns) {
    const c = a?.url_citation || a;
    if (c?.url) out.push({ title: String(c.title || c.url).slice(0, 200), url: String(c.url), snippet: String(c.content || c.snippet || "").slice(0, 500) });
  }
  return out;
}

export function makeResearchHandler(tierSlug) {
  const t = RESEARCH_TIERS[tierSlug];
  return async (input) => {
    if (!input || typeof input !== "object") throw bad('Body must be a JSON object: {"query": "…"}');
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (!query) throw bad('"query" (string) is required — the research question to investigate');
    if (query.length > MAX_QUERY_CHARS) throw bad(`"query" too long (${query.length} chars; max ${MAX_QUERY_CHARS})`);
    const focus = Array.isArray(input.focus) ? input.focus.filter((x) => typeof x === "string").slice(0, 8) : [];
    const recency = ["week", "month", "year", "any"].includes(input.recency) ? input.recency : "any";
    const format = input.format === "json" ? "json" : "markdown";

    let spent = 0;

    // 1) PLAN — decompose into sub-questions (bounded to the tier's subQ).
    const planPrompt = `You are a research planner. Break this question into ${t.subQ} focused, non-overlapping web-search sub-questions that together fully answer it. Return ONLY a JSON object: {"sub_questions": ["…"], "outline": ["section titles for the final report"]}.\n\nQuestion: ${query}${focus.length ? `\nEmphasize: ${focus.join(", ")}` : ""}${recency !== "any" ? `\nPrefer sources from the last ${recency}.` : ""}`;
    let plan;
    try {
      const pd = await chat({ model: M.plan, messages: [{ role: "user", content: planPrompt }], max_tokens: 600, response_format: { type: "json_object" }, reasoning: { enabled: false } }, 45_000);
      spent += costOf(pd);
      plan = JSON.parse(textOf(pd) || "{}");
    } catch {
      plan = null;
    }
    let subQuestions = Array.isArray(plan?.sub_questions) ? plan.sub_questions.filter((s) => typeof s === "string" && s.trim()).slice(0, t.subQ) : [];
    if (!subQuestions.length) subQuestions = [query]; // planner failed → search the question itself
    const outline = Array.isArray(plan?.outline) ? plan.outline.filter((s) => typeof s === "string").slice(0, 8) : [];

    // 2) GROUNDED SEARCH — one Exa-grounded call per sub-question (concurrent,
    // capped at the tier's `searches`). A failed leg drops to null, not fatal.
    const toRun = subQuestions.slice(0, t.searches);
    const searchBody = (q) => ({
      model: M.ground,
      messages: [{ role: "user", content: `Search the web and answer concisely with citations: ${q}` }],
      max_tokens: 700,
      plugins: [{ id: "web", engine: "exa", max_results: 5 }],
    });
    const results = await Promise.all(toRun.map((q) => chat(searchBody(q), SEARCH_TIMEOUT_MS).then(
      (d) => ({ q, answer: textOf(d), sources: sourcesFrom(d), cost: costOf(d) }),
      () => null,
    )));
    const good = results.filter(Boolean);
    for (const r of good) spent += r.cost;
    if (!good.length) throw bad("All grounded searches failed upstream - not charged", 502);

    // Dedupe sources by URL across all searches.
    const byUrl = new Map();
    for (const r of good) for (const s of r.sources) if (!byUrl.has(s.url)) byUrl.set(s.url, s);
    let sources = [...byUrl.values()];

    // 3) RERANK the pooled sources against the ORIGINAL question, keep top-K.
    if (sources.length > 3) {
      try {
        const docs = sources.map((s) => `${s.title}\n${s.snippet}`.slice(0, 1500));
        const rr = await rerankCall(query, docs, Math.min(t.topK, sources.length));
        const ranked = (rr?.results || []).map((x) => ({ ...sources[x.index], rank: Number(x.relevance_score) || null })).filter((x) => x.url);
        if (ranked.length) sources = ranked;
        spent += Number(rr?.usage?.cost) || 0.002;
      } catch { /* rerank is best-effort; keep the unranked pooled sources */ }
    }
    sources = sources.slice(0, t.topK).map((s, i) => ({ n: i + 1, ...s }));

    // 4) SYNTHESIZE — cited long-form report. Downgrade to the cheaper model if
    // we've already spent past the tier's upstream cap (circuit breaker; the
    // fixed pipeline shape means this effectively never fires).
    const synthModel = spent > t.maxUpstreamUsd ? M.synthStd : t.synth;
    const sourceBlock = sources.map((s) => `[${s.n}] ${s.title} (${s.url})\n${s.snippet}`).join("\n\n");
    const subAnswers = good.map((r, i) => `Q${i + 1}: ${r.q}\n${r.answer}`).join("\n\n");
    const synthPrompt = `Write a thorough, well-structured research report answering: "${query}".\n\nUse ONLY the sub-answers and sources below. Cite every claim inline with [n] matching the source numbers. Target ${t.words} words${outline.length ? `, following this outline: ${outline.join("; ")}` : ""}. End with a "Sources" list of [n] title - url. Be specific, note disagreements between sources, and flag anything the sources do not establish.\n\n=== SUB-ANSWERS ===\n${subAnswers}\n\n=== SOURCES ===\n${sourceBlock}`;
    // reasoning OFF: the synthesis models (Claude Sonnet/Opus) reason by
    // default, and reasoning tokens would eat the max_tokens budget before the
    // report is written (smoke test 2026-08-20: a 76-char "I'll write the
    // report now…" stub that still 200'd). We want every token on the report.
    const sd = await chat({ model: synthModel, messages: [{ role: "user", content: synthPrompt }], max_tokens: t.synthMaxTokens, reasoning: { enabled: false } }, SYNTH_TIMEOUT_MS);
    spent += costOf(sd);
    const report = textOf(sd);
    if (!report) throw bad("Synthesis produced no report - not charged", 502);

    const meta = { tier: tierSlug, searches_run: good.length, sources_consulted: byUrl.size, sources_cited: sources.length, synthesis_model: synthModel };
    // Cost is NEVER returned to the buyer (same rule as the gateway).
    return format === "json"
      ? { report, sources, sub_questions: subQuestions, outline, meta }
      : { report, sources, sub_questions: subQuestions, meta };
  };
}

// ---- Catalog registration ----
const SCHEMA = {
  type: "object",
  required: ["query"],
  properties: {
    query: { type: "string", description: "The research question to investigate (<= 2000 chars)." },
    focus: { type: "array", items: { type: "string" }, description: "Optional aspects to emphasize (<= 8)." },
    recency: { type: "string", enum: ["week", "month", "year", "any"], description: "Prefer sources from this window (default any)." },
    format: { type: "string", enum: ["markdown", "json"], description: "Response shape (default markdown report)." },
  },
};
const EXAMPLE = { query: "What are the leading agentic-payment protocols in 2026 and how do they differ?", recency: "year" };
const OUT_EXAMPLE = {
  report: "# Leading agentic-payment protocols (2026)\n\nThe field splits into stablecoin rails and card rails [1]…\n\n## Sources\n[1] … - https://…",
  sources: [{ n: 1, title: "…", url: "https://…", snippet: "…", rank: 0.94 }],
  sub_questions: ["What stablecoin agent-payment protocols exist?", "…"],
  meta: { tier: "research", searches_run: 3, sources_consulted: 14, sources_cited: 12, synthesis_model: "anthropic/claude-sonnet-5" },
};

export const RESEARCH_DEEP_TOOLS = [
  {
    route: "POST /v1/research", name: "Deep research report (grounded, cited)", slug: "research", category: "llm", price: RESEARCH_TIERS["research"].price,
    description: "Hand over a whole research question and get one cited report back. The gateway plans sub-questions, runs multiple live Exa web searches, reranks the sources by relevance, and synthesizes a ~1,500-word report with inline [n] citations and a source list - one payment, one outcome. Priced per report, not per call. Payable in USDC (x402/MPP) or by card (Stripe, >= $0.50 minimum - this clears it). Not cached (the web moves).",
    tags: ["llm", "research", "web-search", "grounded", "citations", "deep-research", "agent", "premium"],
    discovery: { bodyType: "json", input: EXAMPLE, inputSchema: SCHEMA, output: { example: OUT_EXAMPLE } },
    handler: makeResearchHandler("research"),
  },
  {
    route: "POST /v1/research/pro", name: "Deep research report - PRO (premium synthesis)", slug: "research-pro", category: "llm", price: RESEARCH_TIERS["research-pro"].price,
    description: "The deeper research tier: more sub-questions, more grounded searches, wider reranked source set, and a premium (Claude Opus class) synthesis into a ~3,000-word cited report with structured findings. For questions worth a real dossier. USDC or card (Stripe). Not cached.",
    tags: ["llm", "research", "web-search", "grounded", "citations", "deep-research", "agent", "premium"],
    discovery: { bodyType: "json", input: EXAMPLE, inputSchema: SCHEMA, output: { example: { ...OUT_EXAMPLE, meta: { ...OUT_EXAMPLE.meta, tier: "research-pro", synthesis_model: "anthropic/claude-opus-5" } } } },
    handler: makeResearchHandler("research-pro"),
  },
  {
    route: "POST /v1/research/max", name: "Deep research report - MAX (exhaustive)", slug: "research-max", category: "llm", price: RESEARCH_TIERS["research-max"].price,
    description: "The exhaustive tier: up to a dozen sub-questions and grounded searches, the widest reranked source set, premium synthesis into a ~5,000-word cited report with a full source table. Our most thorough single-call research report. USDC or card (Stripe). Not cached.",
    tags: ["llm", "research", "web-search", "grounded", "citations", "deep-research", "agent", "premium"],
    discovery: { bodyType: "json", input: EXAMPLE, inputSchema: SCHEMA, output: { example: { ...OUT_EXAMPLE, meta: { ...OUT_EXAMPLE.meta, tier: "research-max", synthesis_model: "anthropic/claude-opus-5" } } } },
    handler: makeResearchHandler("research-max"),
  },
];
