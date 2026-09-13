// Exa kit - neural web search, grounded answers, and page-content retrieval
// over Exa's API.
//
// WHY THIS EXISTS AND WHAT IT IS NOT: we already sell Brave-backed `search`,
// `search-news`, `search-images` and `search-videos` at $0.02, and a cheaper
// clone of our own best-selling tool would cannibalise real revenue to serve
// nobody better. Exa is a DIFFERENT retrieval model - embedding/neural search
// over a curated index, plus an answer endpoint that returns citations - so
// these are listed beside the Brave tools, never as a replacement.
//
// Env-gated: EXA_API_KEY. `EXA_TOOLS` is exported unconditionally and
// `exaEnabled()` is the listing predicate, so an unkeyed deployment lists
// nothing and a handler called anyway throws a self-explaining 503. Every
// tool reaches the network and is WALLET-ONLY (metered upstream quota; never
// PoW-eligible).
//
// Pricing verified against exa.ai/pricing on 2026-09-13: search $7/1k
// requests (base, up to 10 results; +$1/1k per result beyond 10), answer
// $5/1k, contents $1/1k pages PER CONTENT TYPE. New accounts get $20 of
// credits and the free tier adds $10/month, which is why this can ship and be
// measured before anyone spends anything. Result counts are capped at 10 so a
// call cannot silently cross into the per-result surcharge band.
//
// Wire verified against exa.ai/docs/reference/{search,answer,get-contents} on
// 2026-09-13: POST https://api.exa.ai/<endpoint>, `x-api-key` header, bodies
// keyed `query` / `urls`. Do not adjust these from memory - this repository
// has shipped two live wire drifts (Tempo decimals, Tempo `decimals` on the
// wire) that stub tests could not see.
//
// Covered by scripts/test-exa-kit.js (offline, stubbed fetch).

import { markUntrusted } from "./provenance.js";

const EXA_API = "https://api.exa.ai";
const TIMEOUT_MS = 30_000;
const USER_AGENT = "agent402-exa/1";
const SHARED_TAGS = ["web", "search", "exa"];

// Result/page caps. These are the COST lever, not a UX nicety: Exa's base
// price covers 10 results, and every result past that bills $1/1k on top, so
// an uncapped numResults turns a fixed-price tool into an open tab.
const MAX_RESULTS = 10;
const MAX_URLS = 10;

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

const apiKey = () => (process.env.EXA_API_KEY || "").trim();

export function exaEnabled() {
  return apiKey().length > 0;
}

function requireKey() {
  const k = apiKey();
  if (!k) throw bad("Exa tools are not configured on this deployment (EXA_API_KEY unset)", 503);
  return k;
}

// ---- daily upstream spend cap ----------------------------------------------
// Exa is pay-as-you-go against a prepaid balance, and the whole point of
// shipping on the free tier is to measure demand without spending - so a
// buyer must not be able to burn the allowance in an afternoon. Every call is
// priced BEFORE it goes out at the published card, refused 503 (uncharged,
// so a >= 400 cancels settlement and nobody pays for the refusal) once the
// UTC day's booked spend would pass the cap, and then re-booked AFTER the
// call at what Exa itself reports in `costDollars` - the estimate is only
// ever a gate, never the accounting. In memory: a restart resets the day,
// exactly like the other spend guards, and the prepaid balance is the outer
// bound.
const EXA_SEARCH_USD = 0.007;   // per request, <= 10 results
const EXA_ANSWER_USD = 0.005;   // per request
const EXA_CONTENT_USD = 0.001;  // per page, per content type
const EXA_DAILY_MAX_USD = () => { const n = Number(process.env.EXA_DAILY_MAX_USD); return Number.isFinite(n) && n >= 0 ? n : 1; };
const spend = { day: "", micro: 0, refused: 0 };
const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
const spentToday = (now = Date.now()) => {
  const d = utcDay(now);
  if (spend.day !== d) { spend.day = d; spend.micro = 0; spend.refused = 0; }
  return spend.micro / 1e6;
};

/** Worst-case cost of one call at Exa's published card, before it is sent. */
export function estimateExaUsd(path, body = {}) {
  if (path === "/search" || path === "/findSimilar") {
    const n = Math.max(1, Number(body.numResults) || MAX_RESULTS);
    // Content types requested alongside a search bill per returned page.
    const types = ["text", "highlights", "summary"].filter((k) => body?.contents?.[k]).length;
    return EXA_SEARCH_USD + n * types * EXA_CONTENT_USD;
  }
  if (path === "/answer") return EXA_ANSWER_USD;
  if (path === "/contents") {
    const n = Math.max(1, (Array.isArray(body.urls) ? body.urls.length : 0) || 1);
    const types = ["text", "highlights", "summary"].filter((k) => body[k]).length || 1;
    return n * types * EXA_CONTENT_USD;
  }
  return EXA_SEARCH_USD; // an endpoint this table does not know is priced as a search
}

/**
 * What the call ACTUALLY cost, read from Exa's own `costDollars.total`.
 * Returns null when the field is absent or unusable, and the caller then
 * keeps the estimate - a missing cost is never booked as zero, which would
 * make the cap silently stop counting.
 */
export function actualExaUsd(data) {
  const t = data?.costDollars?.total;
  return typeof t === "number" && Number.isFinite(t) && t >= 0 ? t : null;
}

/** Counts only - never a key, a query or a buyer. */
export function exaSpendStatus(now = Date.now()) {
  const spent = spentToday(now);
  const cap = EXA_DAILY_MAX_USD();
  return {
    day: spend.day,
    spentUsd: Number(spent.toFixed(4)),
    capUsd: cap,
    refusedToday: spend.refused,
    status: cap > 0 && spent >= cap ? "capped" : "ok",
  };
}
export function _exaSpendReset() { spend.day = ""; spend.micro = 0; spend.refused = 0; }
export function _exaSpendBook(usd) { spentToday(); spend.micro += Math.round(usd * 1e6); }

async function exaPost(path, body) {
  const key = requireKey();
  const cap = EXA_DAILY_MAX_USD();
  const estimate = estimateExaUsd(path, body);
  if (cap > 0 && spentToday() + estimate > cap) {
    spend.refused++;
    throw bad(
      `Exa tools have reached today's upstream spend cap ($${cap.toFixed(2)} per UTC day) - retry after 00:00 UTC. Nothing was charged for this request.`,
      503,
    );
  }
  // Book the estimate BEFORE the call. If the request dies mid-flight we may
  // still have been billed, and a guard that only books on success is a guard
  // a timeout walks straight through.
  _exaSpendBook(estimate);

  let res;
  try {
    res = await fetch(`${EXA_API}${path}`, {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json", Accept: "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") throw bad("Exa did not respond in time", 504);
    throw bad("could not reach Exa", 502);
  }

  // Never relay an upstream error body to the buyer: it can carry our own key
  // material, account identifiers or another tenant's text.
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw bad("Exa rejected this deployment's API key", 503);
    if (res.status === 402) throw bad("the Exa account is out of credits", 503);
    if (res.status === 429) throw bad("Exa is rate-limiting this deployment right now - retry shortly", 503);
    if (res.status === 404) throw bad("Exa has nothing for that request", 404);
    if (res.status >= 500) throw bad(`Exa upstream error (HTTP ${res.status})`, 502);
    throw bad(`Exa refused the request (HTTP ${res.status}) - check the query and any filters`, 400);
  }

  let data;
  try { data = await res.json(); }
  catch { throw bad("Exa returned a body that is not JSON", 502); }

  // Correct the day's booking to what Exa says it charged. Only ever replaces
  // the estimate with a real figure; an absent costDollars keeps the estimate.
  const actual = actualExaUsd(data);
  if (actual !== null) _exaSpendBook(actual - estimate);
  return data;
}

// ---- input helpers ---------------------------------------------------------
function takeQuery(raw, field = "query", max = 1000) {
  const q = typeof raw === "string" ? raw.trim() : "";
  if (!q) throw bad(`"${field}" is required - the text to search for`);
  if (q.length > max) throw bad(`"${field}" is too long (${q.length} chars, max ${max})`);
  return q;
}

function takeNumResults(raw) {
  if (raw === undefined || raw === null || raw === "") return MAX_RESULTS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw bad(`"numResults" must be a whole number of 1 or more`);
  if (n > MAX_RESULTS) {
    throw bad(`"numResults" is capped at ${MAX_RESULTS} on this tool - Exa bills per result beyond ten, so a larger page would cost more than this call's price`);
  }
  return n;
}

function takeUrl(raw, field = "url") {
  const u = typeof raw === "string" ? raw.trim() : "";
  let parsed;
  try { parsed = new URL(u); } catch { throw bad(`"${field}" must be an absolute http(s) URL`); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw bad(`"${field}" must be an absolute http(s) URL`);
  return parsed.toString();
}

function shapeResult(r) {
  return {
    title: r?.title ?? null,
    url: r?.url ?? null,
    publishedDate: r?.publishedDate ?? null,
    author: r?.author ?? null,
    text: typeof r?.text === "string" ? r.text : null,
    highlights: Array.isArray(r?.highlights) ? r.highlights : undefined,
    summary: typeof r?.summary === "string" ? r.summary : undefined,
  };
}

const RESULT_EXAMPLE = {
  title: "What is the x402 payment protocol?",
  url: "https://example.com/x402-explained",
  publishedDate: "2026-08-02T00:00:00.000Z",
  author: null,
  text: null,
};

export const EXA_TOOLS = [
  {
    route: "POST /api/exa-search",
    name: "Exa neural web search",
    slug: "exa-search",
    category: "web",
    price: "$0.012",
    description:
      "Neural (embedding-based) web search over Exa's curated index, which finds pages by meaning rather than keyword overlap. Use it when a keyword engine returns the wrong thing: conceptual questions, 'pages like this one', or niche technical writing. Returns up to 10 results with title, URL, published date and author. Complements the Brave-backed web search rather than replacing it.",
    tags: [...SHARED_TAGS, "neural", "semantic"],
    discovery: {
      bodyType: "json",
      input: { query: "how agent-to-agent micropayment protocols settle onchain", numResults: 5 },
      inputSchema: {
        properties: {
          query: { type: "string", description: "What to search for, in natural language (max 1000 chars)." },
          numResults: { type: "number", description: `Results to return, 1 to ${MAX_RESULTS} (default ${MAX_RESULTS}).` },
          type: { type: "string", description: "auto (default), neural, or keyword." },
          category: { type: "string", description: "Optional Exa category filter, e.g. 'research paper', 'news', 'company'." },
          includeDomains: { type: "array", description: "Only return results from these domains." },
          excludeDomains: { type: "array", description: "Never return results from these domains." },
          startPublishedDate: { type: "string", description: "ISO date; only pages published on or after it." },
          endPublishedDate: { type: "string", description: "ISO date; only pages published on or before it." },
        },
        required: ["query"],
      },
      output: {
        example: {
          source: "exa",
          fetchedAt: "2026-09-13T20:00:00.000Z",
          query: "how agent-to-agent micropayment protocols settle onchain",
          searchType: "neural",
          count: 1,
          results: [RESULT_EXAMPLE],
        },
      },
    },
    handler: async (i) => {
      const query = takeQuery(i.query);
      const numResults = takeNumResults(i.numResults);
      const body = { query, numResults };
      if (i.type !== undefined && i.type !== null && i.type !== "") {
        const t = String(i.type);
        if (!["auto", "neural", "keyword", "fast"].includes(t)) throw bad('"type" must be auto, neural, keyword or fast');
        body.type = t;
      }
      if (typeof i.category === "string" && i.category.trim()) body.category = i.category.trim();
      for (const k of ["includeDomains", "excludeDomains"]) {
        if (i[k] !== undefined && i[k] !== null) {
          if (!Array.isArray(i[k])) throw bad(`"${k}" must be an array of domains`);
          if (i[k].length) body[k] = i[k].map(String).slice(0, 20);
        }
      }
      for (const k of ["startPublishedDate", "endPublishedDate"]) {
        if (typeof i[k] === "string" && i[k].trim()) body[k] = i[k].trim();
      }
      const data = await exaPost("/search", body);
      const results = Array.isArray(data?.results) ? data.results.map(shapeResult) : [];
      return {
        source: "exa",
        fetchedAt: new Date().toISOString(),
        query,
        searchType: data?.resolvedSearchType ?? null,
        count: results.length,
        results,
        ...(results.length ? {} : { note: "Exa returned no results for this query" }),
      };
    },
  },
  {
    route: "POST /api/exa-answer",
    name: "Exa grounded answer",
    slug: "exa-answer",
    category: "web",
    price: "$0.010",
    description:
      "Ask a question and get a written answer with the sources it was drawn from. Exa searches its index, reads the pages and composes the answer, returning the citation list (title, URL, published date) alongside it so every claim can be checked. Model-backed: the answer text is generated, the citations are retrieved.",
    tags: [...SHARED_TAGS, "answer", "citations"],
    discovery: {
      bodyType: "json",
      input: { query: "What is the x402 payment protocol and who uses it?" },
      inputSchema: {
        properties: {
          query: { type: "string", description: "The question to answer (max 1000 chars)." },
          text: { type: "boolean", description: "Include the full page text of each citation (bills extra per page; default false)." },
        },
        required: ["query"],
      },
      output: {
        example: {
          source: "exa",
          fetchedAt: "2026-09-13T20:00:00.000Z",
          query: "What is the x402 payment protocol and who uses it?",
          answer: "x402 is an HTTP-native payment protocol that settles stablecoin payments per request ...",
          citationCount: 1,
          citations: [RESULT_EXAMPLE],
        },
      },
    },
    handler: async (i) => {
      const query = takeQuery(i.query);
      const body = { query };
      if (i.text === true) body.text = true;
      const data = await exaPost("/answer", body);
      const citations = Array.isArray(data?.citations) ? data.citations.map(shapeResult) : [];
      const answer = typeof data?.answer === "string" ? data.answer : (data?.answer ?? null);
      if (answer === null || answer === "") throw bad("Exa returned no answer for that question", 502);
      return {
        source: "exa",
        fetchedAt: new Date().toISOString(),
        query,
        answer,
        citationCount: citations.length,
        citations,
      };
    },
  },
  {
    route: "POST /api/exa-contents",
    name: "Exa page contents",
    slug: "exa-contents",
    category: "web",
    price: "$0.006",
    description:
      "Retrieve the readable text of up to 10 web pages by URL, with optional query-focused highlights. Exa serves from its crawl cache when the page is fresh enough and live-crawls otherwise, so this answers for pages a plain fetch would be blocked from. Returns per-URL status so a page that could not be read is named rather than silently missing.",
    tags: [...SHARED_TAGS, "contents", "extract"],
    discovery: {
      bodyType: "json",
      input: { urls: ["https://example.com/x402-explained"] },
      inputSchema: {
        properties: {
          urls: { type: "array", description: `Absolute http(s) URLs to read, 1 to ${MAX_URLS}.` },
          highlights: { type: "boolean", description: "Also return the passages most relevant to `query` (bills extra per page)." },
          query: { type: "string", description: "Focuses the highlights; ignored unless highlights is true." },
        },
        required: ["urls"],
      },
      output: {
        example: {
          source: "exa",
          fetchedAt: "2026-09-13T20:00:00.000Z",
          count: 1,
          results: [{ ...RESULT_EXAMPLE, text: "x402 is an HTTP-native payment protocol ..." }],
          statuses: [{ id: "https://example.com/x402-explained", status: "success" }],
        },
      },
    },
    handler: async (i) => {
      if (!Array.isArray(i.urls) || i.urls.length === 0) throw bad('"urls" is required - an array of absolute http(s) URLs');
      if (i.urls.length > MAX_URLS) throw bad(`"urls" is capped at ${MAX_URLS} per call - Exa bills per page read`);
      const urls = i.urls.map((u, n) => takeUrl(u, `urls[${n}]`));
      const body = { urls, text: true };
      if (i.highlights === true) {
        body.highlights = typeof i.query === "string" && i.query.trim() ? { query: i.query.trim() } : true;
      }
      const data = await exaPost("/contents", body);
      const results = Array.isArray(data?.results) ? data.results.map(shapeResult) : [];
      const statuses = Array.isArray(data?.statuses)
        ? data.statuses.map((s) => ({ id: s?.id ?? null, status: s?.status ?? null, ...(s?.error ? { error: String(s.error).slice(0, 200) } : {}) }))
        : [];
      return {
        source: "exa",
        fetchedAt: new Date().toISOString(),
        count: results.length,
        results,
        statuses,
        ...(results.length ? {} : { note: "Exa could not read any of these URLs - see statuses" }),
      };
    },
  },
];

// Exa returns third-party web text: page titles, extracted body text and
// generated answers drawn from them. That is untrusted content and can carry
// instructions aimed at whatever agent reads it, so every result is wrapped
// the same way the other web-reading kits wrap theirs.
for (const t of EXA_TOOLS) {
  const inner = t.handler;
  t.handler = async (...args) => markUntrusted(await inner(...args));
}
