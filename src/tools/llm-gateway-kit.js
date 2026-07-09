// LLM gateway — OpenAI-compatible pay-per-call inference over x402.
//
// Unlike llm-kit (a custom JSON tool), these routes live at the OpenAI wire
// paths and speak the full chat/completions format, so ANY existing agent or
// SDK adopts the gateway by changing base_url — no integration work. That is
// the distribution mechanism behind the top x402 earners: agents pay per
// reasoning turn, in loops, not per occasional tool call.
//
//   POST /v1/chat/completions          $0.02  — budget/mid models
//   POST /v1/auto/chat/completions     $0.01  — eval-ranked routing, no model needed
//   POST /v1/pro/chat/completions      $0.10  — mid-frontier models
//   POST /v1/premium/chat/completions  $0.50  — frontier models
//   GET  /v1/models                    free   — served by server.js from TIERS
//
// Upstream: OpenRouter (one key, hundreds of models). x402 settles BEFORE the
// handler runs, so the buyer's USDC always arrives before a single upstream
// token is spent — no credit risk beyond one in-flight call. Env-gated:
// missing OPENROUTER_API_KEY → 503 at call time, not boot failure.
//
// Pricing is deterministic by design (flat per tier), matching the project's
// predictability brand: model allowlists + input/output caps keep worst-case
// upstream cost well under the x402 price. Streaming (stream: true) is
// supported: payment settles BEFORE the handler runs, so the response can
// stream out with no credit risk; max_tokens is clamped before the upstream
// call, so the provider stops the stream at the cap. Streamed responses are
// not idempotency-replayable (the cache hooks res.json only).

import { createHash } from "node:crypto";

const OPENROUTER_KEY = () => (process.env.OPENROUTER_API_KEY || "").trim();
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// ---------------------------------------------------------------------------
// Auto tier — eval-ranked model routing. The buyer sends messages and NO
// model; the gateway classifies the prompt and serves it with the top-ranked
// budget model for that task type. The classification is lexical-signal only
// and the ranking is a fixed, human-curated table distilled from public evals
// (LMArena + OpenRouter usage rankings for sub-$1/M models) — updated by code
// review, never at runtime — so the routing decision is fully deterministic:
// no LLM in the routing path, identical requests always route identically.
//
// Each list doubles as the tier's failover chain: a provider error walks down
// the ranking, and every list contains openai/gpt-4o-mini — the model the
// daily paid canary proves alive. Worst-case upstream at the auto caps
// (~4k tokens in / 1024 out) is deepseek-chat at ~$0.0022 — >4x under the
// $0.01 price, same headroom discipline as the other tiers.
export const AUTO_RANKINGS = {
  code: ["deepseek/deepseek-chat", "qwen/qwen-2.5-coder-32b-instruct", "openai/gpt-4o-mini"],
  reasoning: ["deepseek/deepseek-chat", "google/gemini-2.0-flash-001", "openai/gpt-4o-mini"],
  long: ["google/gemini-2.0-flash-001", "openai/gpt-4o-mini", "deepseek/deepseek-chat"],
  general: ["openai/gpt-4o-mini", "google/gemini-2.0-flash-001", "deepseek/deepseek-chat"],
};

// Explicit code/reasoning signals outrank raw length, so a long code review
// routes to a code model, not a long-context generalist. Keywords are chosen
// to be rare in plain prose (no bare "class"/"let"); a misclassification is
// benign — every ranked model is a competent generalist — but determinism is
// the contract, so the signal lists only ever change by code review.
const CODE_RE = /```|\bfunction\s*\(|\bdef\s+\w+\s*\(|\bimport\s+[\w{.]|\bconsole\.log\b|\bTraceback\b|\bstack trace\b|\bregex\b|\brefactor\b|\bunit test\b|\bcompile error\b|\btypescript\b|\bjavascript\b|\bpython\b|\bSELECT\b[\s\S]{0,120}\bFROM\b/i;
const REASONING_RE = /[∑∫√π≠≤≥]|\bprove\b|\btheorem\b|\bderive\b|\bcalculate\b|\bsolve\b|\bequation\b|\bintegral\b|\bprobability\b|\bhow many\b|\bstep[ -]by[ -]step\b|\blogic puzzle\b|\briddle\b/i;
const LONG_CHARS = 8000;

/** Deterministic prompt classifier for the auto tier. Tolerates malformed
 *  messages (returns "general") — validateRequest raises the real 400 right
 *  after, so garbage never reaches the upstream anyway. */
export function classifyPrompt(messages) {
  let text = "";
  if (Array.isArray(messages)) {
    for (const m of messages) {
      if (typeof m?.content === "string") text += m.content + "\n";
      else if (Array.isArray(m?.content)) {
        for (const b of m.content) if (b?.type === "text" && typeof b.text === "string") text += b.text + "\n";
      }
    }
  }
  if (CODE_RE.test(text)) return "code";
  if (REASONING_RE.test(text)) return "reasoning";
  if (text.length > LONG_CHARS) return "long";
  return "general";
}

// Tier → OpenRouter model-id prefixes, input char budget, output token cap.
// Caps chosen so worst-case upstream cost stays well below the x402 price
// (budget models run ~$0.15-0.60/M tokens; 2048 output + 32k input tops out
// around $0.003 — a $0.02 price leaves >6x headroom).
export const TIERS = {
  // Nano tier — priced for agent LOOPS, not occasional calls. The x402
  // leaderboard's top earner does ~800k inference calls/day at sub-cent
  // average prices; the $0.02 base tier is priced out of that traffic.
  // Caps keep worst-case upstream (~3k tokens in / 768 out on ~$0.10-0.40/M
  // models) around $0.0006 — >5x headroom under the $0.003 price, same
  // discipline as the other tiers. Listed FIRST so tierFor()'s
  // self-correcting 400s and /v1/models lead with the cheapest home.
  "v1-chat-nano": {
    route: "POST /v1/nano/chat/completions",
    price: 0.003,
    maxInputChars: 12_000,
    maxTokens: 768,
    // Server-chosen upstream failover, tried in order when the requested
    // model's provider errors. The terminal entry is deliberately gpt-4o-mini:
    // the daily canary proves it alive every morning, and at the nano caps its
    // worst case (~$0.0009) stays ~3x under the price. Fallback models bypass
    // the tier allowlist (server-chosen, caps still enforced by the body).
    fallbacks: ["deepseek/deepseek-chat", "openai/gpt-4o-mini"],
    prefixes: [
      "openai/gpt-4.1-nano", "openai/gpt-5-nano",
      "google/gemini-2.0-flash-lite", "google/gemini-2.5-flash-lite",
      "meta-llama/llama-3.2-1b-instruct", "meta-llama/llama-3.2-3b-instruct",
      "mistralai/ministral-3b", "mistralai/ministral-8b",
      "qwen/qwen-2.5-7b-instruct",
      "deepseek/deepseek-chat",
    ],
  },
  "v1-chat": {
    route: "POST /v1/chat/completions",
    price: 0.02,
    maxInputChars: 32_000,
    maxTokens: 2048,
    prefixes: [
      "openai/gpt-4o-mini", "openai/gpt-4.1-mini", "openai/gpt-4.1-nano",
      "anthropic/claude-haiku", "anthropic/claude-3-haiku", "anthropic/claude-3.5-haiku",
      "google/gemini-flash", "google/gemini-2.0-flash", "google/gemini-2.5-flash",
      "deepseek/", "meta-llama/", "mistralai/", "qwen/",
    ],
  },
  "v1-chat-pro": {
    route: "POST /v1/pro/chat/completions",
    price: 0.10,
    maxInputChars: 48_000,
    maxTokens: 4096,
    prefixes: [
      "openai/gpt-4o", "openai/gpt-4.1",
      "anthropic/claude-sonnet", "anthropic/claude-3.5-sonnet", "anthropic/claude-3.7-sonnet",
      "google/gemini-pro", "google/gemini-2.5-pro",
      "x-ai/grok",
    ],
  },
  "v1-chat-premium": {
    route: "POST /v1/premium/chat/completions",
    price: 0.50,
    maxInputChars: 64_000,
    maxTokens: 8192,
    prefixes: [
      "openai/gpt-5", "openai/o3", "openai/o4",
      "anthropic/claude-opus",
    ],
  },
  // Auto tier — model chosen server-side (see AUTO_RANKINGS above). Listed
  // LAST so tierFor() keeps resolving explicit models to their existing home
  // tiers: the auto prefixes deliberately overlap the nano/base allowlists
  // (an explicit ranked model is honored here at the auto caps), and listing
  // this tier first would hijack those models' self-correcting 400s.
  "v1-chat-auto": {
    route: "POST /v1/auto/chat/completions",
    price: 0.01,
    maxInputChars: 16_000,
    maxTokens: 1024,
    router: true,
    fallbacks: ["openai/gpt-4o-mini"],
    prefixes: [...new Set(Object.values(AUTO_RANKINGS).flat())],
  },
};

// Drop-in compatibility: bare OpenAI-style names map to their OpenRouter ids,
// so `model: "gpt-4o-mini"` from an unmodified OpenAI SDK works unchanged.
export function canonicalModel(model) {
  const m = String(model || "").trim();
  if (!m) return m;
  if (m.includes("/")) return m; // already an OpenRouter id
  if (/^(gpt|o[0-9])/i.test(m)) return `openai/${m}`;
  if (/^claude/i.test(m)) return `anthropic/${m}`;
  if (/^gemini/i.test(m)) return `google/${m}`;
  if (/^grok/i.test(m)) return `x-ai/${m}`;
  if (/^deepseek/i.test(m)) return `deepseek/${m}`;
  return m;
}

export function tierAllows(tierSlug, model) {
  const tier = TIERS[tierSlug];
  if (!tier) return false;
  const id = canonicalModel(model).toLowerCase();
  return tier.prefixes.some((p) => (p.endsWith("/") ? id.startsWith(p) : id === p || id.startsWith(p + "-") || id.startsWith(p + ":")));
}

/** Which gateway tier serves this model — for self-correcting 400s. */
export function tierFor(model) {
  for (const slug of Object.keys(TIERS)) if (tierAllows(slug, model)) return slug;
  return null;
}

const MAX_MESSAGES = 100;
const MAX_IMAGES = 4;
const MAX_IMAGE_URL_LEN = 2048;

function contentChars(content) {
  if (typeof content === "string") return { chars: content.length, images: 0 };
  if (!Array.isArray(content)) throw bad('"content" must be a string or an array of content blocks');
  let chars = 0;
  let images = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") throw bad("Each content block must be an object with a type field");
    if (block.type === "text") {
      if (typeof block.text !== "string") throw bad('Text content block must have "text" (string)');
      chars += block.text.length;
    } else if (block.type === "image_url") {
      const url = typeof block.image_url?.url === "string" ? block.image_url.url : "";
      if (!url) throw bad("image_url.url is required");
      if (url.length > MAX_IMAGE_URL_LEN && !url.startsWith("data:")) throw bad(`image_url.url too long (max ${MAX_IMAGE_URL_LEN})`);
      if (url.startsWith("data:") && url.length > 1_500_000) throw bad("data: image too large (max ~1MB)");
      images++;
    } else {
      throw bad(`Unknown content block type "${block.type}". Allowed: text, image_url`);
    }
  }
  return { chars, images };
}

// OpenAI request params passed through verbatim when present. Everything else
// (stream, unknown fields) is dropped or rejected explicitly.
const PASSTHROUGH = [
  "temperature", "top_p", "stop", "seed", "presence_penalty", "frequency_penalty",
  "response_format", "tools", "tool_choice", "parallel_tool_calls", "logprobs", "top_logprobs", "n",
];

export function validateRequest(input, tierSlug) {
  const tier = TIERS[tierSlug];
  if (input == null || typeof input !== "object") throw bad("Request body must be a JSON object");

  let model = canonicalModel(input.model);
  if (tier.router === true && (!model || model === "auto")) {
    // Auto tier, no model (or model:"auto") → deterministic eval-ranked pick.
    // Resolving HERE (not in the handler) keeps promptCacheKey correct: the
    // resolved model is part of the normalized body, so cached entries
    // invalidate cleanly when the ranking table changes.
    model = AUTO_RANKINGS[classifyPrompt(input.messages)][0];
  }
  if (!model) throw bad('"model" is required (e.g. "openai/gpt-4o-mini" or "gpt-4o-mini")');
  if (!tierAllows(tierSlug, model)) {
    const home = tierFor(model);
    throw bad(
      home
        ? `Model "${model}" is served by the ${home} tier — call ${TIERS[home].route.split(" ")[1]} (price $${TIERS[home].price.toFixed(2)}/call) instead.`
        : `Model "${model}" is not in the gateway allowlist. GET /v1/models lists every supported model and its tier.`
    );
  }

  const messages = input.messages;
  if (!Array.isArray(messages) || messages.length === 0) throw bad('"messages" must be a non-empty array of {role, content} objects');
  if (messages.length > MAX_MESSAGES) throw bad(`Too many messages (${messages.length}). Maximum is ${MAX_MESSAGES}`);

  let totalChars = 0;
  let totalImages = 0;
  for (const m of messages) {
    if (!m || typeof m.role !== "string") throw bad('Each message must have "role" (string)');
    if (m.content == null && !m.tool_calls) throw bad('Each message must have "content" (or "tool_calls")');
    if (m.content != null) {
      const { chars, images } = contentChars(m.content);
      totalChars += chars;
      totalImages += images;
    }
  }
  if (totalChars > tier.maxInputChars) throw bad(`Input too large (${totalChars} chars). The ${tierSlug} tier allows up to ${tier.maxInputChars} chars`);
  if (totalImages > MAX_IMAGES) throw bad(`Too many images (${totalImages}). Maximum is ${MAX_IMAGES} per request`);

  let maxTokens = input.max_tokens != null ? parseInt(input.max_tokens, 10) : Math.min(1024, tier.maxTokens);
  if (Number.isNaN(maxTokens) || maxTokens < 1) maxTokens = Math.min(1024, tier.maxTokens);
  if (maxTokens > tier.maxTokens) maxTokens = tier.maxTokens; // clamp, don't reject — drop-in friendliness

  const body = { model, messages, max_tokens: maxTokens };
  for (const k of PASSTHROUGH) if (input[k] !== undefined) body[k] = input[k];
  if (input.stream === true) {
    body.stream = true;
    if (input.stream_options !== undefined) body.stream_options = input.stream_options;
  }
  return body;
}

async function fetchOpenRouter(body, { timeoutMs, signal } = {}) {
  const key = OPENROUTER_KEY();
  if (!key) throw bad("LLM gateway not configured (OPENROUTER_API_KEY unset)", 503);
  try {
    return await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://agent402.tools",
        "X-Title": "Agent402.Tools x402 gateway",
      },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(timeoutMs ?? 90_000),
    });
  } catch (e) {
    throw bad(`Upstream request failed: ${e.message}`, 504);
  }
}

async function throwUpstreamError(res) {
  const text = await res.text().catch(() => "");
  if (res.status === 401 || res.status === 403) throw bad("Gateway upstream auth failed", 502);
  if (res.status === 402) throw bad("Gateway upstream balance exhausted — the operator has been notified", 502);
  if (res.status === 429) throw bad("Upstream rate-limited — retry shortly", 503);
  if (res.status >= 500) throw bad(`Upstream error (HTTP ${res.status})`, 502);
  let msg = text.slice(0, 200);
  try { msg = JSON.parse(text).error?.message || msg; } catch { /* keep raw slice */ }
  throw bad(`Upstream error: ${msg}`, 502);
}

async function callOpenRouter(body) {
  const res = await fetchOpenRouter(body);
  if (!res.ok) await throwUpstreamError(res);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw bad("Upstream returned non-JSON", 502); }
  // Full OpenAI wire shape passes through untouched (id, object, created,
  // model, choices incl. tool_calls, usage) — drop-in fidelity is the product.
  return data;
}

/** Stream the upstream SSE body to the client verbatim (OpenAI wire format:
 *  `data: {chunk}` lines, terminated by `data: [DONE]`). Throws ONLY before
 *  headers are written — once streaming starts, an upstream drop just ends
 *  the stream. Output cost stays bounded: max_tokens was clamped server-side
 *  before the upstream call, so the provider stops the stream at the cap. */
async function streamOpenRouterTo(body, res) {
  // One controller covers connect AND the whole body read; client disconnect
  // aborts the upstream so a closed tab never keeps burning tokens.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180_000);
  res.on?.("close", () => ctrl.abort());
  try {
    const upstream = await fetchOpenRouter(body, { signal: ctrl.signal });
    if (!upstream.ok) await throwUpstreamError(upstream);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();
    try {
      for await (const chunk of upstream.body) res.write(chunk);
    } catch { /* upstream dropped mid-stream — end what we have */ }
    res.end();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Prompt cache — EXPLICIT opt-in (`cache: true` in the request body).
//
// A byte-identical repeat of an already-paid generation is served from this
// cache BEFORE the paywall (see the pre-gate middleware in server.js), so the
// repeat costs the buyer nothing — retry-heavy agent loops stop re-paying for
// work already done. Opt-in is load-bearing: LLM output is sampled, and a
// buyer resending the same prompt often WANTS a fresh sample; only requests
// that declare cache:true ever read or write this cache.
//
// Keying: sha256 over the tier + the NORMALIZED body (validateRequest output,
// stable-stringified), so model aliases (gpt-4o-mini vs openai/gpt-4o-mini)
// and caller field order collapse to one entry, and every sampling-relevant
// field (temperature, seed, max_tokens, …) is part of the key. Pre-paywall
// service is necessarily buyer-agnostic — identical requests share entries.
// Streamed requests are never cached. Values are our own 200 responses.
const PROMPT_CACHE_TTL_MS = 10 * 60 * 1000;
const PROMPT_CACHE_MAX_ENTRIES = 5000;
const PROMPT_CACHE_MAX_BYTES = 50 * 1024 * 1024;
const PROMPT_CACHE_MAX_ENTRY_BYTES = 256 * 1024;
const promptStore = new Map(); // key -> { at, body, bytes } (insertion order ≈ FIFO eviction)
let promptStoreBytes = 0;

export function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
}

/** Cache key for an opted-in, non-streamed gateway request. Throws (via
 *  validateRequest) on invalid input — callers treat that as "no cache" and
 *  let the normal path produce the real 402/400. Returns null for streams. */
export function promptCacheKey(tierSlug, input) {
  const body = validateRequest(input, tierSlug);
  if (body.stream === true) return null;
  return createHash("sha256").update(`${tierSlug}\n${stableStringify(body)}`).digest("hex");
}

export function promptCacheGet(key) {
  if (!key) return null;
  const hit = promptStore.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > PROMPT_CACHE_TTL_MS) {
    promptStore.delete(key);
    promptStoreBytes -= hit.bytes;
    return null;
  }
  return hit.body;
}

export function promptCacheStore(key, body) {
  if (!key || body == null) return;
  let bytes = 0;
  try { bytes = Buffer.byteLength(JSON.stringify(body), "utf8"); } catch { return; }
  if (!bytes || bytes > PROMPT_CACHE_MAX_ENTRY_BYTES) return;
  while ((promptStore.size >= PROMPT_CACHE_MAX_ENTRIES || promptStoreBytes + bytes > PROMPT_CACHE_MAX_BYTES) && promptStore.size > 0) {
    const firstKey = promptStore.keys().next().value;
    const ev = promptStore.get(firstKey);
    if (ev) promptStoreBytes -= ev.bytes;
    promptStore.delete(firstKey);
  }
  promptStore.set(key, { at: Date.now(), body, bytes });
  promptStoreBytes += bytes;
}

/** "POST /v1/…" path -> tier slug, for the pre-paywall middleware. */
export const GATEWAY_TIER_BY_PATH = Object.fromEntries(
  Object.entries(TIERS).map(([slug, t]) => [t.route.split(" ")[1], slug])
);

// ---------------------------------------------------------------------------
// /v1/embeddings — OpenAI wire-path embeddings, loop-priced with batching.
// Upstream is OpenAI directly (OpenRouter serves chat only); env-gated on
// OPENAI_API_KEY like llm-kit/embed-kit. Unlike the sampled chat tiers,
// embeddings are DETERMINISTIC per model — so the response cache is
// default-ON (opt out with cache:false): a byte-identical repeat within the
// TTL is served free pre-paywall with zero freshness concerns.
//
// Cost discipline: caps 16k chars (~4k tokens) / 64 items per request.
// Worst-case upstream at the caps: 3-small $0.00008, ada-002 $0.0004,
// 3-large $0.00052 — all ≥3.8x under the $0.002 price.
const OPENAI_KEY = () => (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
export const EMBEDDINGS_PATH = "/v1/embeddings";
const EMBEDDINGS_DEFAULT_MODEL = "text-embedding-3-small";
const EMBEDDINGS_MODELS = new Set([EMBEDDINGS_DEFAULT_MODEL, "text-embedding-3-large", "text-embedding-ada-002"]);
const EMBEDDINGS_MAX_ITEMS = 64;
const EMBEDDINGS_MAX_CHARS = 16_000;

export function validateEmbeddingsRequest(input) {
  if (input == null || typeof input !== "object") throw bad("Request body must be a JSON object");
  let model = String(input.model || EMBEDDINGS_DEFAULT_MODEL).trim();
  if (model.startsWith("openai/")) model = model.slice("openai/".length);
  if (!EMBEDDINGS_MODELS.has(model)) {
    throw bad(`"model" must be one of: ${[...EMBEDDINGS_MODELS].join(", ")} (default ${EMBEDDINGS_DEFAULT_MODEL})`);
  }
  const raw = input.input;
  // Normalize string -> [string]: OpenAI returns the same list shape either
  // way, and normalizing collapses both spellings to ONE cache entry.
  const items = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : null;
  if (!items || items.length === 0) throw bad('"input" is required — a string or an array of strings to embed');
  if (items.length > EMBEDDINGS_MAX_ITEMS) throw bad(`Too many inputs (${items.length}). Maximum is ${EMBEDDINGS_MAX_ITEMS} per request`);
  let totalChars = 0;
  for (const it of items) {
    if (typeof it !== "string" || !it) throw bad("Every input item must be a non-empty string");
    totalChars += it.length;
  }
  if (totalChars > EMBEDDINGS_MAX_CHARS) throw bad(`Input too large (${totalChars} chars). /v1/embeddings allows up to ${EMBEDDINGS_MAX_CHARS} chars per request`);
  const body = { model, input: items };
  if (input.dimensions !== undefined) {
    if (model === "text-embedding-ada-002") throw bad('"dimensions" is not supported by text-embedding-ada-002');
    const d = parseInt(input.dimensions, 10);
    if (Number.isNaN(d) || d < 1 || d > 3072) throw bad('"dimensions" must be an integer between 1 and 3072');
    body.dimensions = d;
  }
  if (input.encoding_format !== undefined) {
    if (input.encoding_format !== "float" && input.encoding_format !== "base64") throw bad('"encoding_format" must be "float" or "base64"');
    body.encoding_format = input.encoding_format;
  }
  return body;
}

/** Cache key for /v1/embeddings — default-ON (deterministic output), so the
 *  only opt-out is an explicit cache:false. Returns null when opted out;
 *  throws (via validation) on invalid bodies — callers treat that as "no
 *  cache" and let the normal path answer honestly. */
export function embeddingsCacheKey(input) {
  if (input?.cache === false) return null;
  const body = validateEmbeddingsRequest(input);
  return createHash("sha256").update(`v1-embeddings\n${stableStringify(body)}`).digest("hex");
}

async function embeddingsHandler(input) {
  const body = validateEmbeddingsRequest(input);
  const key = OPENAI_KEY();
  if (!key) throw bad("Embeddings gateway not configured (OPENAI_API_KEY unset)", 503);
  let res;
  try {
    res = await fetch(OPENAI_EMBEDDINGS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw bad(`Upstream request failed: ${e.message}`, 504);
  }
  if (!res.ok) await throwUpstreamError(res);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw bad("Upstream returned non-JSON", 502); }
  // Full OpenAI wire shape passes through untouched (object, data[], model,
  // usage). Store unless the buyer opted out; oversized batches are skipped
  // by the store's own per-entry byte cap.
  try { promptCacheStore(embeddingsCacheKey(input), data); } catch { /* never fail a served response over the cache */ }
  return data;
}

function makeHandler(tierSlug) {
  return async (input) => {
    const body = validateRequest(input, tierSlug);
    // Payment settles BEFORE this handler runs, so an upstream provider
    // failure must not become the buyer's problem when an equivalent model
    // can serve: walk the tier's fallback chain on upstream errors
    // (502/503/504) only — our own validation 4xxs pass through untouched.
    // The response's `model` field discloses which model actually served.
    // (Origin: openai/gpt-4.1-nano returned persistent provider errors on
    // 2026-07-08 — two independent paid runs — and buyers were charged $0.003
    // for 502s. No allowlist can guarantee a provider stays alive; a chain
    // ending in a canary-proven model can.)
    // Auto tier with no explicit model: the routed category's full ranking IS
    // the failover chain (body.model is already its head). Explicit-model
    // requests — on any tier — keep the requested model first, then the
    // tier's static fallbacks.
    const routedCategory =
      TIERS[tierSlug].router === true && (!canonicalModel(input.model) || canonicalModel(input.model) === "auto")
        ? classifyPrompt(input.messages)
        : null;
    const chain = routedCategory
      ? [...AUTO_RANKINGS[routedCategory]]
      : [body.model, ...(TIERS[tierSlug].fallbacks || []).filter((m) => m !== body.model)];
    if (body.stream === true) {
      // The route binder invokes __sse(res) after the paywall settled.
      // streamOpenRouterTo throws only BEFORE headers are written, so the
      // failover chain is safe: once bytes flow, errors just end the stream.
      return {
        __sse: async (res) => {
          let lastErr;
          for (const model of chain) {
            try {
              return await streamOpenRouterTo({ ...body, model }, res);
            } catch (e) {
              if (res.headersSent || ![502, 503, 504].includes(e?.statusCode)) throw e;
              lastErr = e;
            }
          }
          throw lastErr;
        },
      };
    }
    let lastErr;
    for (const model of chain) {
      try {
        const data = await callOpenRouter({ ...body, model });
        // Routed requests disclose the decision: additive key, OpenAI wire
        // shape otherwise untouched (the standard `model` field already names
        // the server, this adds WHY). Streams pass through unannotated.
        if (routedCategory && data && typeof data === "object") {
          data.agent402_router = { category: routedCategory, served: data.model || model };
        }
        if (input.cache === true) {
          try { promptCacheStore(promptCacheKey(tierSlug, input), data); } catch { /* never fail a served response over the cache */ }
        }
        return data;
      } catch (e) {
        if (![502, 503, 504].includes(e?.statusCode)) throw e;
        lastErr = e;
      }
    }
    throw lastErr;
  };
}

const SHARED_TAGS = ["llm", "ai", "inference", "chat", "gateway", "openai-compatible", "openrouter"];
const EXAMPLE = { model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 5 };
const EXAMPLE_OUT = {
  id: "gen-…", object: "chat.completion", created: 1750000000, model: "openai/gpt-4o-mini",
  choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
};

const INPUT_SCHEMA = {
  properties: {
    model: { type: "string", description: "Model id — OpenRouter form (openai/gpt-4o-mini) or bare OpenAI form (gpt-4o-mini). GET /v1/models lists the allowlist per tier." },
    messages: { type: "array", description: "OpenAI chat messages: [{role, content}] — text and image_url content blocks supported" },
    max_tokens: { type: "number", description: "Output token cap (clamped to the tier maximum)" },
  },
  required: ["model", "messages"],
};

const AUTO_INPUT_SCHEMA = {
  properties: {
    messages: INPUT_SCHEMA.properties.messages,
    model: { type: "string", description: 'Optional — omit (or send "auto") for eval-ranked server-side routing. An explicit model from the auto ranking is honored at the auto caps.' },
    max_tokens: INPUT_SCHEMA.properties.max_tokens,
  },
  required: ["messages"],
};

export const LLM_GATEWAY_TOOLS = [
  {
    route: "POST /v1/nano/chat/completions",
    name: "Chat completions — nano tier",
    slug: "v1-chat-nano",
    category: "llm",
    price: "$0.003",
    description:
      "OpenAI-compatible chat completions, nano tier: gpt-4.1-nano, gpt-5-nano, gemini flash-lite, small llama/ministral/qwen, deepseek-chat — $0.003 per call in USDC over x402, priced for high-frequency agent loops. Same wire format as /v1/chat/completions with loop-sized caps (12k chars in, 768 tokens out). Streaming supported (stream: true). No API key, no signup.",
    tags: SHARED_TAGS,
    discovery: { bodyType: "json", input: { ...EXAMPLE, model: "openai/gpt-4.1-nano" }, inputSchema: INPUT_SCHEMA, output: { example: { ...EXAMPLE_OUT, model: "openai/gpt-4.1-nano" } } },
    handler: makeHandler("v1-chat-nano"),
  },
  {
    route: "POST /v1/auto/chat/completions",
    name: "Chat completions — auto tier (eval-ranked routing)",
    slug: "v1-chat-auto",
    category: "llm",
    price: "$0.01",
    description:
      'OpenAI-compatible chat completions with server-side model choice: omit "model" (or send "auto") and the gateway routes the prompt to the top-ranked budget model for its task type (code / reasoning / long-context / general) from a fixed eval-derived ranking — deterministic, no LLM in the routing path. Provider errors fail over down the ranking automatically; the response adds agent402_router {category, served} alongside the standard model field. $0.01 per call in USDC over x402, caps 16k chars in / 1024 tokens out. Streaming supported (stream: true). No API key, no signup.',
    tags: [...SHARED_TAGS, "router", "auto"],
    discovery: {
      bodyType: "json",
      input: { messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 5 },
      inputSchema: AUTO_INPUT_SCHEMA,
      output: { example: { ...EXAMPLE_OUT, agent402_router: { category: "general", served: "openai/gpt-4o-mini" } } },
    },
    handler: makeHandler("v1-chat-auto"),
  },
  {
    route: "POST /v1/chat/completions",
    name: "Chat completions (OpenAI-compatible)",
    slug: "v1-chat",
    category: "llm",
    price: "$0.02",
    description:
      "OpenAI-compatible chat completions over x402 — point any OpenAI SDK at base_url https://agent402.tools/v1 and pay per call in USDC (Base, Solana, Polygon, Arbitrum, Stellar), no API key, no signup. Budget/mid models: gpt-4o-mini, claude haiku, gemini flash, deepseek, llama, mistral, qwen. Full wire compatibility incl. tools/function-calling and response_format. GET /v1/models lists every model. Streaming supported (stream: true).",
    tags: SHARED_TAGS,
    discovery: { bodyType: "json", input: EXAMPLE, inputSchema: INPUT_SCHEMA, output: { example: EXAMPLE_OUT } },
    handler: makeHandler("v1-chat"),
  },
  {
    route: "POST /v1/pro/chat/completions",
    name: "Chat completions — pro tier",
    slug: "v1-chat-pro",
    category: "llm",
    price: "$0.10",
    description:
      "OpenAI-compatible chat completions, pro tier: gpt-4o, gpt-4.1, claude sonnet, gemini pro, grok — paid per call in USDC over x402. Same wire format as /v1/chat/completions with higher input/output caps (48k chars in, 4096 tokens out).",
    tags: SHARED_TAGS,
    discovery: { bodyType: "json", input: { ...EXAMPLE, model: "openai/gpt-4o" }, inputSchema: INPUT_SCHEMA, output: { example: { ...EXAMPLE_OUT, model: "openai/gpt-4o" } } },
    handler: makeHandler("v1-chat-pro"),
  },
  {
    route: "POST /v1/premium/chat/completions",
    name: "Chat completions — premium tier",
    slug: "v1-chat-premium",
    category: "llm",
    price: "$0.50",
    description:
      "OpenAI-compatible chat completions, premium tier: gpt-5, o3/o4, claude opus — paid per call in USDC over x402. Same wire format as /v1/chat/completions with the largest caps (64k chars in, 8192 tokens out).",
    tags: SHARED_TAGS,
    discovery: { bodyType: "json", input: { ...EXAMPLE, model: "anthropic/claude-opus-4" }, inputSchema: INPUT_SCHEMA, output: { example: { ...EXAMPLE_OUT, model: "anthropic/claude-opus-4" } } },
    handler: makeHandler("v1-chat-premium"),
  },
  {
    route: "POST /v1/embeddings",
    name: "Embeddings (OpenAI-compatible)",
    slug: "v1-embeddings",
    category: "llm",
    price: "$0.002",
    description:
      "OpenAI-compatible text embeddings over x402 — point any OpenAI SDK at base_url https://agent402.tools/v1 and pay $0.002 per call in USDC, no API key, no signup. Batch up to 64 inputs / 16k chars per request; text-embedding-3-small by default (3-large and ada-002 supported; dimensions and encoding_format pass through). Embeddings are deterministic, so a byte-identical repeat within 10 minutes is served FREE from cache automatically (X-Cache: hit; opt out with cache:false).",
    tags: ["embeddings", "vector", "rag", "semantic-search", ...SHARED_TAGS],
    discovery: {
      bodyType: "json",
      input: { input: "Agent402 is an open-source x402 tool server." },
      inputSchema: {
        properties: {
          input: { type: "string", description: "Text to embed — a string or an array of up to 64 strings (16k chars total)" },
          model: { type: "string", description: `Optional — ${EMBEDDINGS_DEFAULT_MODEL} (default), text-embedding-3-large, or text-embedding-ada-002` },
          dimensions: { type: "number", description: "Optional output dimensions (3-small/3-large only)" },
        },
        required: ["input"],
      },
      output: { example: { object: "list", data: [{ object: "embedding", index: 0, embedding: [0.0023, -0.0091, 0.0152] }], model: EMBEDDINGS_DEFAULT_MODEL, usage: { prompt_tokens: 12, total_tokens: 12 } } },
    },
    handler: embeddingsHandler,
  },
];

/** OpenAI-compatible GET /v1/models payload — free discovery surface. */
export function modelsList() {
  const data = [];
  for (const [slug, tier] of Object.entries(TIERS)) {
    for (const p of tier.prefixes) {
      data.push({
        id: p.endsWith("/") ? `${p}*` : p,
        object: "model",
        owned_by: p.split("/")[0],
        x402: { tier: slug, endpoint: tier.route.split(" ")[1], priceUsd: tier.price, maxTokens: tier.maxTokens, maxInputChars: tier.maxInputChars },
      });
    }
  }
  for (const m of EMBEDDINGS_MODELS) {
    data.push({
      id: m,
      object: "model",
      owned_by: "openai",
      x402: { tier: "v1-embeddings", endpoint: EMBEDDINGS_PATH, priceUsd: 0.002, maxInputChars: EMBEDDINGS_MAX_CHARS, maxItems: EMBEDDINGS_MAX_ITEMS },
    });
  }
  return { object: "list", data, note: "Prefixes ending in /* allow the whole vendor family. Pay per call via x402 (USDC on Base, Solana, Polygon, Arbitrum, Stellar) — no API key. Bare OpenAI-style names (gpt-4o-mini) are accepted and mapped." };
}
