// dossier-kit — Company Due-Diligence Dossier. The flagship premium (card-tier)
// product identified by the PMF analysis: the deliverable with the widest
// incumbent price gap, proven per-report demand (Fiverr $25-70), and the one our
// data serves best. It grounds in OUR structured data - SEC EDGAR filings +
// Form 4 insider trades + a live quote - which generic-web research agents
// cannot reach, plus grounded web search for recent developments, then
// synthesizes a cited, structured dossier.
//
// Same discipline as research-deep: grounding-strict synthesis (every specific
// must trace to the provided data/sources, no invented figures, cite [n] only
// what a source supports), Opus synthesis, deterministic source list appended in
// code, settlement-safe (any upstream failure throws >=400 so the buyer is not
// charged), cost read for the internal accumulator and never returned,
// WALLET_ONLY, not cached. Gated on OPENROUTER_API_KEY (503 without it).
import { fetchOpenRouter, throwUpstreamError, bad, upstreamUserId } from "./llm-gateway-kit.js";
import { EDGAR_TOOLS } from "./edgar-kit.js";
import { FINANCE_TOOLS } from "./finance-kit.js";

// Per-buyer OpenRouter `user` id (OpenRouter abuse isolation); never throws.
function safeUser(req) { try { return req ? upstreamUserId(req) : undefined; } catch { return undefined; } }

const SYNTH = "anthropic/claude-opus-5"; // synthesis on both tiers (see research-deep eval)
const GROUND = "google/gemini-2.5-flash"; // grounded web search + read

// synthMaxTokens carries headroom over the word target (measured ~2.3 output
// tokens/word for dense cited markdown; a 6,000 cap truncated a "~2,500 word"
// dossier at ~2,540 words). Caps held at a provider-safe 8,000; word targets are
// what those budgets complete; the source list is appended in code (no budget).
export const DOSSIER_TIERS = {
  "dossier": { price: "$19", maxUpstreamUsd: 4, filings: 3, insiderDays: 120, searches: 4, topWeb: 20, synthMaxTokens: 7000, words: "~2,400" },
  "dossier-max": { price: "$39", maxUpstreamUsd: 8, filings: 6, insiderDays: 365, searches: 8, topWeb: 32, synthMaxTokens: 8000, words: "~2,800" },
};
// Models routed to - exported so the live-catalog guard checks them.
export const DOSSIER_MODELS = [SYNTH, GROUND];

const TICKER_RE = /^[A-Z0-9.\-]{1,10}$/;
const SEARCH_TIMEOUT_MS = 60_000;
const SYNTH_TIMEOUT_MS = 120_000;
const DATA_TIMEOUT_MS = 25_000;

async function chat(body, timeoutMs, user) {
  const res = await fetchOpenRouter({ ...body, ...(user ? { user } : {}), usage: { include: true } }, { timeoutMs });
  if (!res.ok) await throwUpstreamError(res);
  return res.json();
}
const costOf = (d) => Number(d?.usage?.cost) || 0;
const textOf = (d) => (d?.choices?.[0]?.message?.content || "").trim();
// The grounded-search model cites its sources inline as [domain](url) or bare
// [domain.com] tags. Strip them from the sub-answers so the synthesizer doesn't
// COPY those tags (it must cite our numbered [n] list instead).
function stripInlineCites(s) {
  return String(s || "")
    .replace(/\[([^\]]+)\]\((?:https?:)?\/\/[^)]+\)/g, "$1")                           // [text](url) -> text
    .replace(/\[[a-z0-9][a-z0-9.\-]*\.[a-z]{2,}(?:\s*,\s*[a-z0-9][a-z0-9.\-]*\.[a-z]{2,})*\]/gi, "") // [domain.com] / [d1, d2] -> ""
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
function webSourcesFrom(d) {
  const anns = d?.choices?.[0]?.message?.annotations || [];
  const out = [];
  for (const a of anns) {
    const c = a?.url_citation || a;
    if (c?.url) out.push({ title: String(c.title || c.url).slice(0, 200), url: String(c.url), snippet: String(c.content || c.snippet || "").slice(0, 500) });
  }
  return out;
}
function getHandler(kit, slug) {
  const t = kit.find((x) => x.slug === slug);
  if (!t) throw bad(`dossier: missing dependency '${slug}' - sub-kit renamed`, 500);
  return t.handler;
}
// settle: never throw from a data leg; return {ok,data} | {ok:false,error}.
async function settle(fn, input, timeoutMs) {
  try {
    const p = fn(input);
    const data = timeoutMs ? await Promise.race([p, new Promise((_, r) => setTimeout(() => r(bad("timeout", 504)), timeoutMs))]) : await p;
    return { ok: true, data };
  } catch (e) { return { ok: false, error: e?.message || String(e) }; }
}

function fmtUsd(v) {
  if (v == null || !Number.isFinite(Number(v))) return "?";
  const n = Number(v), a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  return `$${n.toLocaleString("en-US")}`;
}
// Pull key financial facts from SEC XBRL (data.sec.gov) - so figures come from
// the FILINGS, not a news article, and are traceable to a 10-K/10-Q. Each concept
// yields a latest-annual + most-recent datapoint. Revenue has two common tags.
const FIN_CONCEPTS = [
  ["Revenues", "Total revenue"],
  ["RevenueFromContractWithCustomerExcludingAssessedTax", "Total revenue"],
  ["NetIncomeLoss", "Net income"],
  ["OperatingIncomeLoss", "Operating income"],
  ["Assets", "Total assets"],
  ["Liabilities", "Total liabilities"],
  ["StockholdersEquity", "Stockholders' equity"],
  ["CashAndCashEquivalentsAtCarryingValue", "Cash & equivalents"],
  ["EarningsPerShareBasic", "EPS (basic)"],
];
async function pullFinancials(ticker, edgarConcept) {
  const results = await Promise.all(FIN_CONCEPTS.map(([tag, label]) =>
    settle(edgarConcept, { ticker, taxonomy: "us-gaap", tag }, DATA_TIMEOUT_MS).then((r) => ({ tag, label, r }))));
  const seen = new Set(); const lines = []; const rows = [];
  for (const { tag, label, r } of results) {
    if (seen.has(label)) continue;
    const units = r.ok ? (r.data?.units || {}) : {};
    const unitKey = units.USD ? "USD" : Object.keys(units)[0];
    const arr = unitKey ? units[unitKey] : [];
    if (!Array.isArray(arr) || !arr.length) continue;
    seen.add(label);
    const isShares = /shares/i.test(unitKey || "");
    const sorted = [...arr].filter((x) => x && x.end).sort((a, b) => String(a.end).localeCompare(String(b.end)));
    const annual = [...sorted].reverse().find((x) => x.form === "10-K" || x.fp === "FY");
    const latest = sorted[sorted.length - 1];
    const val = (x) => isShares ? String(x.val) : fmtUsd(x.val);
    const parts = [];
    if (annual) parts.push(`latest annual ${val(annual)} (${annual.fp || "FY"}${annual.fy ? " " + annual.fy : ""}, ${annual.form || "?"} filed ${annual.filed || "?"})`);
    if (latest && latest !== annual) parts.push(`most recent ${val(latest)} (period ending ${latest.end}, ${latest.form || "?"})`);
    if (parts.length) lines.push(`- ${label}: ${parts.join("; ")}`);
    // Structured row for the downloadable data appendix (same figures the prose
    // is grounded in, machine-readable for a spreadsheet).
    rows.push({
      metric: label,
      latestAnnual: annual ? val(annual) : "",
      annualPeriod: annual ? `${annual.fp || "FY"}${annual.fy ? " " + annual.fy : ""} ${annual.form || ""} filed ${annual.filed || "?"}`.trim() : "",
      mostRecent: (latest && latest !== annual) ? val(latest) : "",
      recentPeriod: (latest && latest !== annual) ? `${latest.end} (${latest.form || "?"})` : "",
    });
  }
  return { lines, rows };
}

export function makeDossierHandler(tierSlug) {
  const t = DOSSIER_TIERS[tierSlug];
  return async (input, req) => {
    if (!input || typeof input !== "object") throw bad('Body must be a JSON object: {"ticker": "AAPL"}');
    const ticker = String(input.ticker ?? "").trim().toUpperCase();
    if (!ticker) throw bad('"ticker" (US stock ticker, e.g. "AAPL") is required');
    if (!TICKER_RE.test(ticker)) throw bad("ticker must be a short alphanumeric symbol, e.g. AAPL");
    const focus = Array.isArray(input.focus) ? input.focus.filter((x) => typeof x === "string").slice(0, 8) : [];
    const format = input.format === "json" ? "json" : "markdown";
    const user = safeUser(req);

    const edgarFilings = getHandler(EDGAR_TOOLS, "edgar-filings");
    const edgarInsider = getHandler(EDGAR_TOOLS, "edgar-insider-trades");
    const edgarConcept = getHandler(EDGAR_TOOLS, "edgar-company-concept");
    const stockQuote = getHandler(FINANCE_TOOLS, "stock-quote");

    let spent = 0;

    // 1) STRUCTURED DATA - fan out to EDGAR + quote in parallel (the moat). This
    // includes real XBRL financials pulled from the filings, so financial figures
    // are grounded in SEC data, not a news article.
    const [quote, k10, q10, k8, insider, financials] = await Promise.all([
      settle(stockQuote, { symbol: ticker }, DATA_TIMEOUT_MS),
      settle(edgarFilings, { ticker, form: "10-K", limit: Math.min(t.filings, 3) }, DATA_TIMEOUT_MS),
      settle(edgarFilings, { ticker, form: "10-Q", limit: t.filings }, DATA_TIMEOUT_MS),
      settle(edgarFilings, { ticker, form: "8-K", limit: t.filings * 2 }, DATA_TIMEOUT_MS),
      settle(edgarInsider, { ticker, days: t.insiderDays, limit: t.filings * 6 }, DATA_TIMEOUT_MS),
      pullFinancials(ticker, edgarConcept),
    ]);
    const company = [k10, q10, k8].map((r) => r.ok && r.data?.name).find(Boolean) || ticker;

    // If EDGAR gave us nothing at all, this isn't a US-listed company we can
    // do diligence on - fail (no charge) rather than sell a web-only "dossier".
    const anyFilings = [k10, q10, k8].some((r) => r.ok && (r.data?.filings?.length || 0) > 0);
    if (!anyFilings) throw bad(`No SEC EDGAR filings found for "${ticker}" - this product covers US-listed companies (try a ticker like AAPL). Not charged.`, 422);

    // 2) GROUNDED WEB SEARCH - recent developments / risks / analyst view.
    const queries = [
      `${company} (${ticker}) recent news and business developments`,
      `${company} (${ticker}) risks, litigation, regulatory or accounting concerns`,
      `${company} (${ticker}) latest earnings results, guidance and analyst view`,
      `${company} (${ticker}) competitive position and market share`,
      `${company} (${ticker}) management, strategy and outlook`,
      `${company} (${ticker}) debt, liquidity and capital allocation`,
      `${company} (${ticker}) insider or institutional ownership changes`,
      `${company} (${ticker}) short interest, controversies or bear thesis`,
    ].slice(0, t.searches);
    const searchBody = (q) => ({
      model: GROUND,
      messages: [{ role: "user", content: `Search the web and answer with SPECIFIC, verifiable facts - figures, dates, named events, quotes - each with a citation. Do not state a number unless a source supports it. Question: ${q}` }],
      max_tokens: 800,
      plugins: [{ id: "web", engine: "exa", max_results: 5 }],
    });
    const webResults = await Promise.all(queries.map((q) => chat(searchBody(q), SEARCH_TIMEOUT_MS, user).then(
      (d) => ({ q, answer: textOf(d), sources: webSourcesFrom(d), cost: costOf(d) }),
      () => null,
    )));
    const webGood = webResults.filter(Boolean);
    for (const r of webGood) spent += r.cost;

    // 3) BUILD A UNIFIED, NUMBERED SOURCE LIST: SEC filings (real EDGAR URLs)
    // first, then deduped web citations. Everything the report cites is [n].
    const sources = [];
    const pushFiling = (f, label) => {
      if (f?.url) sources.push({ title: `${label} filed ${f.filingDate || "?"}${f.reportDate ? ` (period ${f.reportDate})` : ""} - SEC EDGAR`, url: f.url });
    };
    for (const r of [k10, q10, k8]) {
      if (r.ok) for (const f of (r.data?.filings || [])) pushFiling(f, f.form || "Filing");
    }
    const seenWeb = new Set(sources.map((s) => s.url));
    for (const r of webGood) for (const s of r.sources) if (s.url && !seenWeb.has(s.url)) { seenWeb.add(s.url); sources.push(s); }
    const numbered = sources.slice(0, t.topWeb).map((s, i) => ({ n: i + 1, ...s }));

    // 4) STRUCTURED DATA BLOCK for the synthesizer (grounding material).
    const q = quote.ok ? quote.data : null;
    const quoteBlock = q ? `Live quote (${q.symbol || ticker}): last ${q.price ?? q.last ?? "?"} ${q.currency || ""}, day range ${q.dayLow ?? "?"}-${q.dayHigh ?? "?"}, 52-week ${q.week52Low ?? q.fiftyTwoWeekLow ?? "?"}-${q.week52High ?? q.fiftyTwoWeekHigh ?? "?"}, prev close ${q.previousClose ?? "?"}, change ${q.change ?? q.changePercent ?? "?"}.` : "Live quote: unavailable.";
    const filingLines = numbered.filter((s) => s.title.includes("SEC EDGAR")).map((s) => `[${s.n}] ${s.title} - ${s.url}`).join("\n") || "(no filings retrieved)";
    const insiderTrades = insider.ok ? (insider.data?.trades || insider.data?.transactions || []) : [];
    const insiderBlock = insiderTrades.length
      ? insiderTrades.slice(0, 25).map((tr) => `- ${tr.reportingOwner || tr.name || tr.insider || "insider"}${tr.relationship || tr.title ? ` (${tr.relationship || tr.title})` : ""}: ${tr.transactionCode || tr.code || tr.type || "?"} ${tr.shares ?? tr.amount ?? "?"} sh on ${tr.transactionDate || tr.date || tr.filedAt || "?"}`).join("\n")
      : (insider.ok ? "No Form 4 insider transactions in the window." : "Insider data unavailable.");
    const webBlock = webGood.map((r, i) => `WEB ANGLE ${i + 1}: ${r.q}\n${stripInlineCites(r.answer)}`).join("\n\n") || "(web research unavailable)";
    // Web sources WITH their snippet content, so the model can only cite [n] for
    // what a source actually says - not guess a claim from a title alone.
    const webSourceLines = numbered.filter((s) => !s.title.includes("SEC EDGAR")).map((s) => `[${s.n}] ${s.title}${s.snippet ? `\n    "${s.snippet.slice(0, 320)}"` : ""} - ${s.url}`).join("\n") || "(none)";
    const financialsBlock = financials.lines.length ? financials.lines.join("\n") : "SEC XBRL financial facts unavailable for this issuer.";
    const maxCite = numbered.length;

    // 5) SYNTHESIZE - grounding-strict cited dossier.
    const synthPrompt = `You are a diligence analyst writing a COMPANY DUE-DILIGENCE DOSSIER on ${company} (${ticker}) that will be SOLD to a paying customer. Accuracy is paramount; a fabricated fact fails the whole report.

=== ABSOLUTE GROUNDING RULES ===
1. Use ONLY the SEC DATA, INSIDER DATA, LIVE QUOTE, and WEB RESEARCH provided below. Treat them as your only knowledge about this company.
2. Every SPECIFIC fact - financial figures, dates, share counts, prices, filing references, named events - MUST appear in the provided material. NEVER introduce a number, metric, or claim from your own training/memory. If the material lacks a figure, describe it qualitatively rather than inventing one.
3. CITATIONS: the sources are numbered [1] to [${maxCite}]. NEVER cite a number outside that range - if you cannot ground a claim in sources [1]-[${maxCite}], do not attach a citation to it. Cite every substantive claim with [n], and ONLY attach [n] to a claim that source's own text supports - for a WEB source, that means the claim appears in that source's quoted snippet or the web research; do NOT infer a source's content from its title alone. A citation is ONLY a bracketed number, e.g. [14] or [3][7] - NEVER put words, notes, ranges, or explanations inside the brackets (not "[14 for the release]", not "[13-adjacent]"), and never use a word-tag or source name like [research]/[web]/[data]/[morningstar]/[reuters] - EVERY citation must be a numbered [n] from the list, never a publication name or domain. The LIVE QUOTE, SEC XBRL FINANCIALS, and FORM 4 INSIDER data are given directly: for financial figures, cite the corresponding 10-K/10-Q filing [n] they came from; for the quote and insider data, reference them in prose ("the live quote shows...", "Form 4 filings in the window show...") WITHOUT a bracket.
4. Do not overstate: reproduce magnitudes and dates exactly as given. Where sources disagree or are silent, say so. Being less specific beats stating something you cannot ground.
5. Do NOT write a "Sources" section - a complete numbered source list is appended automatically. Prioritize COMPLETING the dossier (finish your final sentence and section) over length.

Write a thorough, well-structured dossier of up to ${t.words} words, with these sections where the material supports them: an opening SNAPSHOT (what the company is, current quote, one-paragraph bottom line), BUSINESS & RECENT FILINGS (what the latest 10-K/10-Q/8-K disclose), FINANCIAL POSTURE, RECENT DEVELOPMENTS (from the web research), INSIDER ACTIVITY (interpret the Form 4 data), RISKS & RED FLAGS, and a closing DILIGENCE READ (the balanced takeaway). Be specific and analytical, not a data dump; call out what matters for someone deciding whether to trust, invest in, or partner with this company.${focus.length ? `\nEmphasize: ${focus.join(", ")}.` : ""}

=== LIVE QUOTE ===\n${quoteBlock}
=== SEC XBRL FINANCIALS (reported in the filings - cite the 10-K/10-Q they came from) ===\n${financialsBlock}
=== SEC FILINGS (numbered sources) ===\n${filingLines}
=== FORM 4 INSIDER TRANSACTIONS (last ${t.insiderDays} days) ===\n${insiderBlock}
=== WEB RESEARCH ===\n${webBlock}
=== WEB SOURCES (numbered, with snippet content) ===\n${webSourceLines}`;

    const sd = await chat({ model: SYNTH, messages: [{ role: "user", content: synthPrompt }], max_tokens: t.synthMaxTokens, reasoning: { enabled: false } }, SYNTH_TIMEOUT_MS, user);
    spent += costOf(sd);
    const prose = textOf(sd);
    if (!prose) throw bad("Dossier synthesis produced nothing - not charged", 502);

    const sourceList = numbered.map((s) => `[${s.n}] ${s.title} - ${s.url}`).join("\n");
    const dossier = sourceList ? `${prose}\n\n## Sources\n${sourceList}` : prose;

    // Downloadable DATA APPENDIX - the structured tables the prose is grounded
    // in, so the buyer gets a spreadsheet-ready dataset, not only narrative.
    const insiderRows = insiderTrades.slice(0, 100).map((tr) => [
      String(tr.reportingOwner || tr.name || tr.insider || ""),
      String(tr.relationship || tr.title || ""),
      String(tr.transactionCode || tr.code || tr.type || ""),
      String(tr.shares ?? tr.amount ?? ""),
      String(tr.price ?? tr.pricePerShare ?? ""),
      String(tr.transactionDate || tr.date || tr.filedAt || ""),
    ]);
    const tables = [];
    if (insiderRows.length) tables.push({
      name: "insider-trades", label: "Form 4 insider transactions",
      columns: ["Insider", "Role", "Code", "Shares", "Price", "Date"], rows: insiderRows,
    });
    if (financials.rows.length) tables.push({
      name: "financials", label: "SEC XBRL financials",
      columns: ["Metric", "Latest annual", "Annual period", "Most recent", "Recent period"],
      rows: financials.rows.map((r) => [r.metric, r.latestAnnual, r.annualPeriod, r.mostRecent, r.recentPeriod]),
    });

    const meta = {
      tier: tierSlug, company, ticker,
      filings_10k: (k10.ok && k10.data?.filings?.length) || 0,
      filings_10q: (q10.ok && q10.data?.filings?.length) || 0,
      filings_8k: (k8.ok && k8.data?.filings?.length) || 0,
      insider_transactions: insiderTrades.length,
      web_angles: webGood.length,
      sources_cited: numbered.length,
      synthesis_model: SYNTH,
    };
    const out = format === "json"
      ? { dossier, company, ticker, sources: numbered, tables, meta }
      : { dossier, company, ticker, sources: numbered, tables, meta };
    if (process.env.RESEARCH_DEBUG === "1") out._debug = { webAnswers: webGood.map((r) => ({ q: r.q, answer: r.answer })), quoteBlock, insiderBlock, financialsBlock, webSources: numbered.filter((s) => !s.title.includes("SEC EDGAR")).map((s) => ({ n: s.n, snippet: s.snippet })) };
    return out;
  };
}

const SCHEMA = {
  type: "object",
  required: ["ticker"],
  properties: {
    ticker: { type: "string", description: "US stock ticker to investigate, e.g. AAPL." },
    focus: { type: "array", items: { type: "string" }, description: "Optional aspects to emphasize (<= 8), e.g. [\"litigation\", \"debt\"]." },
    format: { type: "string", enum: ["markdown", "json"], description: "Response shape (default markdown dossier)." },
  },
};
const OUT_EXAMPLE = {
  dossier: "# Due-Diligence Dossier: Example Corp (EXMP)\n\n## Snapshot\nExample Corp trades at ... [1]\n\n## Sources\n[1] 10-K filed ... - https://www.sec.gov/...",
  company: "Example Corp", ticker: "EXMP",
  sources: [{ n: 1, title: "10-K filed 2025-11-01 - SEC EDGAR", url: "https://www.sec.gov/..." }],
  tables: [{ name: "financials", label: "SEC XBRL financials", columns: ["Metric", "Latest annual", "Annual period", "Most recent", "Recent period"], rows: [["Total revenue", "$1.2B", "FY 2024 10-K filed 2025-11-01", "$0.3B", "2025-09-30 (10-Q)"]] }],
  meta: { tier: "dossier", company: "Example Corp", ticker: "EXMP", filings_10k: 1, filings_10q: 3, filings_8k: 5, insider_transactions: 8, web_angles: 4, sources_cited: 18, synthesis_model: "anthropic/claude-opus-5" },
};

export const DOSSIER_TOOLS = [
  {
    route: "POST /v1/dossier", name: "Company due-diligence dossier (grounded, cited)", slug: "dossier", category: "llm", price: DOSSIER_TIERS["dossier"].price,
    description: "Hand over a ticker and get one due-diligence dossier back. Pulls the company's SEC EDGAR filings (10-K / 10-Q / 8-K) and Form 4 insider trades, a live quote, and grounded web research on recent developments and risks, then synthesizes a ~2,400-word cited dossier - business, financial posture, insider activity, red flags, and a balanced diligence read. Grounded in real SEC data, not a generic web guess. One payment, one report. USDC (x402/MPP) or card (Stripe). Not cached.",
    tags: ["research", "due-diligence", "company", "sec", "edgar", "filings", "insider", "stocks", "dossier", "premium", "agent"],
    discovery: { bodyType: "json", input: { ticker: "AAPL", focus: ["risks"] }, inputSchema: SCHEMA, output: { example: OUT_EXAMPLE } },
    handler: makeDossierHandler("dossier"),
  },
  {
    route: "POST /v1/dossier/max", name: "Company due-diligence dossier - MAX (exhaustive)", slug: "dossier-max", category: "llm", price: DOSSIER_TIERS["dossier-max"].price,
    description: "The exhaustive due-diligence tier: more filings, a full year of Form 4 insider activity, wider web research (up to 8 angles), the widest source set, and a ~2,800-word cited dossier with a full source table. For a decision that warrants real diligence. USDC or card (Stripe). Not cached.",
    tags: ["research", "due-diligence", "company", "sec", "edgar", "filings", "insider", "stocks", "dossier", "premium", "agent"],
    discovery: { bodyType: "json", input: { ticker: "AAPL", focus: ["debt", "litigation"] }, inputSchema: SCHEMA, output: { example: { ...OUT_EXAMPLE, meta: { ...OUT_EXAMPLE.meta, tier: "dossier-max" } } } },
    handler: makeDossierHandler("dossier-max"),
  },
];
