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
// Static import (not agent-kit's lazy pattern): validateRequest must stay
// synchronous because promptCacheKey — called from the pre-paywall cache
// middleware — normalizes through it.
import { countTokens } from "gpt-tokenizer/model/gpt-4o";
// cl100k tokenizer for the embeddings margin clamp — all three supported
// embeddings models bill cl100k input tokens, not o200k. Static import for
// the same reason as above: embeddingsCacheKey (pre-paywall) must stay sync.
import { countTokens as countEmbeddingTokens } from "gpt-tokenizer/model/text-embedding-3-small";
import { redactSecrets } from "./redact.js";

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
// daily paid canary proves alive.
//
// The `quality` knob picks the BAND (fast / balanced / best); all three stay
// inside the flat $0.01 price — a per-request price can't exist under x402's
// fixed per-route quote, so quality trades latency/depth, never what the
// buyer pays. Worst-case upstream at the auto caps (~4k tokens in / 1024
// out): fast tops out at gemini-2.0-flash (~$0.0008, 12x headroom), balanced
// at deepseek-chat (~$0.0022, >4x), best at gemini-2.5-flash (~$0.0038,
// ~2.6x) — the thinnest band is documented, deliberate, and still >2x.
export const AUTO_QUALITIES = ["fast", "balanced", "best"];
export const AUTO_RANKINGS = {
  // fast — cheapest/snappiest serving; right for high-frequency loop turns.
  fast: {
    code: ["google/gemini-2.0-flash-001", "qwen/qwen-2.5-coder-32b-instruct", "openai/gpt-4o-mini"],
    reasoning: ["google/gemini-2.0-flash-001", "openai/gpt-4o-mini", "deepseek/deepseek-chat"],
    long: ["google/gemini-2.0-flash-001", "openai/gpt-4o-mini", "deepseek/deepseek-chat"],
    general: ["google/gemini-2.0-flash-001", "openai/gpt-4o-mini", "deepseek/deepseek-chat"],
  },
  // balanced — the default; identical to the pre-knob rankings so existing
  // buyers' routing does not change out from under them.
  balanced: {
    code: ["deepseek/deepseek-chat", "qwen/qwen-2.5-coder-32b-instruct", "openai/gpt-4o-mini"],
    reasoning: ["deepseek/deepseek-chat", "google/gemini-2.0-flash-001", "openai/gpt-4o-mini"],
    long: ["google/gemini-2.0-flash-001", "openai/gpt-4o-mini", "deepseek/deepseek-chat"],
    general: ["openai/gpt-4o-mini", "google/gemini-2.0-flash-001", "deepseek/deepseek-chat"],
  },
  // best — strongest models that still clear the price with ≥2.5x headroom.
  best: {
    code: ["deepseek/deepseek-chat", "google/gemini-2.5-flash", "openai/gpt-4o-mini"],
    reasoning: ["google/gemini-2.5-flash", "deepseek/deepseek-chat", "openai/gpt-4o-mini"],
    long: ["google/gemini-2.5-flash", "google/gemini-2.0-flash-001", "openai/gpt-4o-mini"],
    general: ["google/gemini-2.5-flash", "openai/gpt-4o-mini", "deepseek/deepseek-chat"],
  },
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
//
// `maxPrice` (USD per 1M tokens, {prompt, completion}) rides to OpenRouter as
// provider.max_price — a HARD upstream price filter. These are CATASTROPHE
// BOUNDS, not tight budgets: each sits ~1.5-2x above the priciest allowlisted
// model's list price, so they never affect normal serving. What they block is
// the silent failure mode where one of a model's providers charges multiples
// of list (or a provider reprices) — OpenRouter then refuses that provider
// instead of us quietly eating the margin. A model with NO provider under the
// bound errors upstream, which the failover chain already treats as walkable.
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
    maxPrice: { prompt: 0.5, completion: 1.5 }, // priciest allowlisted: deepseek-chat ~$0.27/$1.10
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
    maxPrice: { prompt: 2.5, completion: 8 }, // family prefixes reach mistral-large ~$2/$6, qwen-max ~$1.6/$6.4
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
    maxPrice: { prompt: 6, completion: 20 }, // priciest allowlisted: claude sonnet / grok ~$3/$15
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
    maxPrice: { prompt: 20, completion: 100 }, // priciest allowlisted: claude opus ~$15/$75
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
    maxPrice: { prompt: 0.6, completion: 3 }, // priciest ranked: gemini-2.5-flash ~$0.30/$2.50
    router: true,
    fallbacks: ["openai/gpt-4o-mini"],
    prefixes: [...new Set(Object.values(AUTO_RANKINGS).flatMap((byCategory) => Object.values(byCategory).flat()))],
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
const MAX_N = 4; // `n` multiplies output cost — bounded and priced in the margin clamp

// ---------------------------------------------------------------------------
// Margin clamp — the flat tier price must ALWAYS cover the metered upstream
// bill. Char caps alone can't guarantee that: token-dense text (CJK packs
// 4-8x more tokens per char than English), giant tool schemas, `n`
// completions, and expensive model families (opus, o3-pro) can push the
// worst case past the price. So every request is priced BEFORE it goes
// upstream: estimate input tokens on the full outbound body, look up the
// model family's list price, and clamp max_tokens so
// input + output ≤ MARGIN × tier price. Cheap models never feel it (the
// affordable output exceeds the tier cap); pricey models get proportionally
// tighter output — and a request whose INPUT alone busts the budget gets a
// self-explaining 400 instead of a useless clamp.
//
// Upstream list prices (USD per 1M tokens) by canonical-id prefix, longest
// prefix wins. Rounded UP — this table only needs to never UNDERestimate.
// Effective cost is elementwise-min'd with the tier's provider max_price
// bound (OpenRouter refuses pricier providers), so an overestimate here
// can't reject traffic the provider bound already makes safe.
export const MODEL_COST = [
  ["openai/o3-pro", { prompt: 20, completion: 80 }],
  ["openai/o3-mini", { prompt: 1.1, completion: 4.4 }],
  ["openai/o3", { prompt: 2, completion: 8 }],
  ["openai/o4-mini", { prompt: 1.1, completion: 4.4 }],
  ["openai/o4", { prompt: 20, completion: 80 }], // unreleased flagship — assume pro-tier pricing until known
  ["openai/gpt-5-nano", { prompt: 0.05, completion: 0.4 }],
  ["openai/gpt-5-mini", { prompt: 0.25, completion: 2 }],
  ["openai/gpt-5", { prompt: 1.25, completion: 10 }],
  ["openai/gpt-4o-mini", { prompt: 0.15, completion: 0.6 }],
  ["openai/gpt-4o", { prompt: 2.5, completion: 10 }],
  ["openai/gpt-4.1-nano", { prompt: 0.1, completion: 0.4 }],
  ["openai/gpt-4.1-mini", { prompt: 0.4, completion: 1.6 }],
  ["openai/gpt-4.1", { prompt: 2, completion: 8 }],
  ["anthropic/claude-opus", { prompt: 15, completion: 75 }],
  ["anthropic/claude-sonnet", { prompt: 3, completion: 15 }],
  ["anthropic/claude-3.5-sonnet", { prompt: 3, completion: 15 }],
  ["anthropic/claude-3.7-sonnet", { prompt: 3, completion: 15 }],
  ["anthropic/claude", { prompt: 1, completion: 5 }], // haiku family
  ["google/gemini-2.5-pro", { prompt: 2.5, completion: 15 }],
  ["google/gemini-pro", { prompt: 2.5, completion: 15 }],
  ["google/gemini", { prompt: 0.4, completion: 2.5 }], // flash family
  ["x-ai/grok", { prompt: 3, completion: 15 }],
  ["deepseek/", { prompt: 0.6, completion: 2.5 }],
  ["meta-llama/", { prompt: 3.5, completion: 3.5 }],
  ["mistralai/", { prompt: 2, completion: 6 }],
  ["qwen/", { prompt: 1.6, completion: 6.4 }],
];

/** Upstream list price for a model (longest matching prefix), or null when
 *  the family is unknown — callers fall back to the tier's max_price bound. */
export function costFor(model) {
  const id = canonicalModel(model).toLowerCase();
  let best = null;
  for (const [prefix, cost] of MODEL_COST) {
    if (id.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) best = { prefix, cost };
  }
  return best ? best.cost : null;
}

export const MARGIN = 0.7;   // worst-case upstream ≤ 70% of the tier price
const MIN_OUT_TOKENS = 64;   // a clamp below this is useless — reject with guidance instead
const IMAGE_TOKENS = 1600;   // conservative flat per-image input estimate (high-detail tiling)
const TOKEN_SAFETY = 1.15;   // headroom for BPE drift across vendors

function estimateInputTokens(body, imageCount) {
  // Price the ENTIRE outbound body — messages, tools, response_format, stop
  // sequences — so a giant tool schema is input like any other input. Image
  // URLs are excluded from the text count (a data: URL is not prompt text)
  // and billed flat per image instead. Exact-BPE via gpt-tokenizer (o200k);
  // deterministic, so the prompt-cache key stays stable.
  const probe = { ...body };
  delete probe.max_tokens;
  const text = JSON.stringify(probe, (k, v) => (k === "image_url" ? undefined : v));
  return Math.ceil(countTokens(text) * TOKEN_SAFETY) + imageCount * IMAGE_TOKENS;
}

/** Worst-case upstream bill (USD) for an outbound body at this tier:
 *  exact-BPE input pricing plus the full output cap × n, against the model's
 *  list cost elementwise-min'd with the tier's provider max_price bound.
 *  This is THE pricing function the margin clamp uses — the pricing-margin
 *  CI test (scripts/test-pricing-margin.js) imports it so the test and the
 *  runtime can never disagree on the math. */
export function worstCaseUpstreamCost(body, tier, imageCount = 0) {
  const listed = costFor(body.model) || tier.maxPrice;
  const cost = {
    prompt: Math.min(listed.prompt, tier.maxPrice.prompt),
    completion: Math.min(listed.completion, tier.maxPrice.completion),
  };
  const inTokens = estimateInputTokens(body, imageCount);
  const inUsd = (inTokens / 1e6) * cost.prompt;
  const n = body.n || 1;
  const outUsd = ((Number(body.max_tokens) || 0) / 1e6) * cost.completion * n;
  return { inTokens, inUsd, outUsd, totalUsd: inUsd + outUsd, cost };
}

/** Shrinks body.max_tokens so the worst-case upstream bill stays ≤ MARGIN ×
 *  the tier price; throws a self-explaining 400 when the INPUT alone busts
 *  the budget. Exported for the failover chain walk (each fallback model is
 *  re-clamped at its own cost) and for the pricing-margin CI test. */
export function clampToMargin(body, tier, imageCount) {
  const { inUsd, inTokens, cost } = worstCaseUpstreamCost(body, tier, imageCount);
  const budgetUsd = tier.price * MARGIN;
  const n = body.n || 1;
  const affordableOut = Math.floor(((budgetUsd - inUsd) * 1e6) / cost.completion / n);
  if (affordableOut < MIN_OUT_TOKENS) {
    throw bad(
      `Input is too large for "${body.model}" at this tier's price (est. ${inTokens} input tokens). ` +
      `Shrink the input, lower "n", or use a cheaper model — GET /v1/models lists every model and its tier.`
    );
  }
  if (body.max_tokens > affordableOut) body.max_tokens = affordableOut;
}

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
    // Auto tier, no model (or model:"auto") → deterministic eval-ranked pick
    // from the requested quality band (default balanced). Resolving HERE (not
    // in the handler) keeps promptCacheKey correct: the resolved model is
    // part of the normalized body, so cached entries invalidate cleanly when
    // the ranking table changes — and two qualities that resolve to the same
    // model rightly share one cache entry.
    const quality = input.quality === undefined ? "balanced" : String(input.quality);
    if (!AUTO_QUALITIES.includes(quality)) {
      throw bad(`"quality" must be one of: ${AUTO_QUALITIES.join(", ")} (default balanced)`);
    }
    model = AUTO_RANKINGS[quality][classifyPrompt(input.messages)][0];
  } else if (tier.router === true && input.quality !== undefined) {
    throw bad('"quality" applies only when the gateway picks the model — omit "model" (or send "auto") to use it');
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
  if (body.n !== undefined) {
    const n = parseInt(body.n, 10);
    if (Number.isNaN(n) || n < 1 || n > MAX_N) throw bad(`"n" must be an integer between 1 and ${MAX_N} — each completion is metered output`);
    body.n = n;
  }
  if (input.stream === true) {
    body.stream = true;
    if (input.stream_options !== undefined) body.stream_options = input.stream_options;
  }
  // Zero-data-retention routing: an OpenRouter provider preference, accepted
  // top-level or as provider.zdr. This is the ONLY provider field a buyer may
  // set — everything else (notably max_price) stays server-owned. Part of the
  // normalized body, so zdr and non-zdr responses never share a cache entry.
  if (input.zdr === true || input.provider?.zdr === true) body.zdr = true;
  clampToMargin(body, tier, totalImages);
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
  // Redact the FULL body BEFORE slicing/parsing — a secret straddling the
  // 200-char cut would otherwise leave an unredactable prefix. The route binder
  // returns err.message verbatim to buyers and logs it, so this must be clean.
  const safe = redactSecrets(text);
  let msg = safe.slice(0, 200);
  try { msg = JSON.parse(safe).error?.message || msg; } catch { /* keep raw slice */ }
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
// Gateway credits status — the /v1 tiers settle the buyer's USDC BEFORE the
// handler runs, so an empty OpenRouter balance turns every gateway call into
// "charged but failed". This probe lets the heartbeat alarm BEFORE that
// happens. Deliberately bucketed ("ok"/"low"/"unknown") — the exact balance
// is operator information and never leaves the server. Cached 5 minutes so
// the public endpoint can't be used to hammer OpenRouter through us.
const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";
const CREDITS_CACHE_MS = 5 * 60 * 1000;
const LOW_CREDITS_USD = () => Number(process.env.OPENROUTER_LOW_CREDITS_USD) || 5;
let creditsCache = null; // { at, result }

export async function gatewayCreditsStatus() {
  const key = OPENROUTER_KEY();
  if (!key) return { configured: false, status: "unconfigured" };
  if (creditsCache && Date.now() - creditsCache.at < CREDITS_CACHE_MS) return creditsCache.result;
  let result;
  try {
    const res = await fetch(OPENROUTER_CREDITS_URL, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    const body = res.ok ? await res.json() : null;
    const total = Number(body?.data?.total_credits);
    const used = Number(body?.data?.total_usage);
    if (Number.isFinite(total) && Number.isFinite(used)) {
      result = { configured: true, status: total - used < LOW_CREDITS_USD() ? "low" : "ok" };
    } else {
      // Shape surprise or upstream error — "unknown", never a false page.
      result = { configured: true, status: "unknown" };
    }
  } catch {
    result = { configured: true, status: "unknown" };
  }
  creditsCache = { at: Date.now(), result };
  return result;
}

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
export const EMBEDDINGS_PRICE = 0.002;
// Upstream list prices (USD per 1M input tokens, OpenAI published rates).
// Like MODEL_COST: only needs to never UNDERestimate.
const EMBEDDINGS_COST = {
  "text-embedding-3-small": 0.02,
  "text-embedding-3-large": 0.13,
  "text-embedding-ada-002": 0.10,
};

/** Exact upstream bill for a validated embeddings body — cl100k tokens per
 *  item (embeddings bill input tokens only, and cl100k is what all three
 *  models meter) × the model's list rate. Used by the margin clamp below and
 *  imported by the pricing-margin CI test so they can never disagree. */
export function embeddingsUpstreamCost(body) {
  let tokens = 0;
  for (const it of body.input) tokens += countEmbeddingTokens(it);
  return { tokens, totalUsd: (tokens / 1e6) * EMBEDDINGS_COST[body.model] };
}

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
  // Margin clamp — same discipline as the chat tiers. The char cap alone
  // can't bound the bill: token-dense scripts pack ~2 cl100k tokens per char
  // (rare CJK), so 16k chars ≈ 32k tokens — $0.0042 on 3-large, over the
  // $0.002 price. There is no output knob to shrink here, so an over-budget
  // input gets a self-explaining 400 BEFORE any upstream spend. Exact-BPE and
  // sync → deterministic, so embeddingsCacheKey stays stable.
  const { tokens } = embeddingsUpstreamCost(body);
  const maxTokens = Math.floor((EMBEDDINGS_PRICE * MARGIN * 1e6) / EMBEDDINGS_COST[model]);
  if (tokens > maxTokens) {
    throw bad(
      `Input is too token-dense for ${model} at this price (est. ${tokens} tokens, max ${maxTokens}). ` +
      `Send fewer or shorter inputs${model === EMBEDDINGS_DEFAULT_MODEL ? "" : `, or use ${EMBEDDINGS_DEFAULT_MODEL}`}.`
    );
  }
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

async function embeddingsHandler(input, req) {
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
  // by the store's own per-entry byte cap. FR4-01 class: defer the write to
  // AFTER settlement (the route binder commits on a final 200) so an unsettled
  // 200 isn't cached and served free on a repeat; direct write for non-HTTP.
  try {
    const w = { key: embeddingsCacheKey(input), body: data };
    if (req) (req.__deferredCache ??= []).push(w); else promptCacheStore(w.key, w.body);
  } catch { /* never fail a served response over the cache */ }
  return data;
}

// ---------------------------------------------------------------------------
// /v1/images/generations — OpenAI wire-path image generation over OpenRouter.
// OpenRouter serves image models through chat/completions with
// modalities: ["image","text"]; this route translates the OpenAI images API
// to that shape and back, so any OpenAI SDK's images.generate() works by
// changing base_url. The model is locked and n is locked to 1 — image output
// is metered upstream, so every knob that multiplies cost is server-owned
// (same discipline as image-gen's locked size/quality). Sampling is
// non-deterministic → never cached; no streaming.
//
// Margin (two layers, same scheme as the chat tiers): flash-image output is
// ~1300 completion tokens per image at ~$30/M list (~$0.04/image) against
// the $0.08 price; IMAGES_MAX_TOKENS bounds the response and
// IMAGES_MAX_PRICE rides upstream as provider.max_price so a repriced or
// hijacked provider is refused instead of quietly eating the margin. Usage
// accounting reports the exact bill to PostHog on every call.
export const IMAGES_PATH = "/v1/images/generations";
const IMAGES_MODEL = "google/gemini-2.5-flash-image";
export const IMAGES_PRICE = 0.08;
export const IMAGES_MAX_PROMPT_CHARS = 4_000;
export const IMAGES_MAX_TOKENS = 1_600; // one image (~1300 tok) + a little text headroom
// Worst case at these bounds: 1600 tok × $35/M = $0.056 ≤ 70% of the price.
// `request` is deliberately near-zero: the locked model's providers charge no
// per-request fee (OpenRouter lists prompt/completion/image-output pricing
// only), so this bound never rejects a real provider — but a generous value
// here would be a standing ALLOWANCE for a fee-charging provider to stack
// $0.05/request on top of the token bill and invert the margin. Exported
// (with the caps above) for the pricing-margin CI test.
export const IMAGES_MAX_PRICE = { prompt: 1, completion: 35, image: 0.05, request: 0.005 };

export function validateImagesRequest(input) {
  if (input == null || typeof input !== "object") throw bad("Request body must be a JSON object");
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) throw bad('"prompt" is required — a text description of the image to generate');
  if (prompt.length > IMAGES_MAX_PROMPT_CHARS) throw bad(`Prompt too long (${prompt.length} chars). Maximum is ${IMAGES_MAX_PROMPT_CHARS}`);
  if (input.model !== undefined) {
    const m = canonicalModel(input.model);
    if (m !== IMAGES_MODEL) throw bad(`"model" is fixed to ${IMAGES_MODEL} on this endpoint (omit it, or send that id)`);
  }
  if (input.n !== undefined && parseInt(input.n, 10) !== 1) {
    throw bad('"n" is locked to 1 — the flat price is per image; call again for more');
  }
  if (input.response_format !== undefined && input.response_format !== "b64_json") {
    throw bad('"response_format" must be "b64_json" — generated images are returned inline, not hosted');
  }
  // size/quality/style have no upstream meaning for this model and no cost
  // impact — ignored for drop-in friendliness rather than rejected.
  const body = { prompt };
  if (input.zdr === true || input.provider?.zdr === true) body.zdr = true;
  return body;
}

async function imagesHandler(input) {
  const { prompt, zdr } = validateImagesRequest(input);
  const upstreamBody = {
    model: IMAGES_MODEL,
    messages: [{ role: "user", content: prompt }],
    modalities: ["image", "text"],
    max_tokens: IMAGES_MAX_TOKENS,
    provider: { max_price: IMAGES_MAX_PRICE, ...(zdr ? { zdr: true } : {}) },
    usage: { include: true },
  };
  const res = await fetchOpenRouter(upstreamBody, { timeoutMs: 120_000 });
  if (!res.ok) await throwUpstreamError(res);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw bad("Upstream returned non-JSON", 502); }

  const images = data?.choices?.[0]?.message?.images;
  if (!Array.isArray(images) || images.length === 0) {
    throw bad("Upstream returned no image — retry, or rephrase the prompt", 502);
  }

  // Exact upstream bill → operator telemetry, stripped before the response.
  const usage = data.usage && typeof data.usage === "object" ? data.usage : null;
  if (usage) {
    const upstreamUsd = typeof usage.cost === "number" ? usage.cost : null;
    delete usage.cost;
    delete usage.cost_details;
    delete usage.is_byok;
    try {
      const { capturePostHogGatewayUsage } = await import("../posthog.js");
      capturePostHogGatewayUsage({
        tier: "v1-images",
        model: data.model || IMAGES_MODEL,
        priceUsd: IMAGES_PRICE,
        upstreamUsd,
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
      });
    } catch { /* telemetry must never fail a served response */ }
  }

  // Translate back to the OpenAI images wire: data URI → b64_json.
  const out = images.map((im) => {
    const url = typeof im?.image_url?.url === "string" ? im.image_url.url : "";
    const m = /^data:(image\/[\w.+-]+);base64,(.+)$/s.exec(url);
    if (!m) throw bad("Upstream returned an image in an unexpected format", 502);
    return { b64_json: m[2], media_type: m[1] };
  });
  return {
    created: Math.floor(Date.now() / 1000),
    model: data.model || IMAGES_MODEL,
    data: out,
    ...(usage ? { usage } : {}),
  };
}

// ---------------------------------------------------------------------------
// /v1/audio/speech — OpenAI wire-path text-to-speech over OpenRouter's audio
// API (raw audio bytes out, exactly like OpenAI's endpoint, so any SDK's
// audio.speech.create() works by changing base_url — served via the route
// binder's { __binary } sentinel). OpenRouter's TTS catalog carries NO
// OpenAI models (their docs still advertise openai/gpt-4o-mini-tts-2025-12-15;
// the live ?output_modalities=speech list — and a real paid probe of every
// entry, 2026-07-16 — says otherwise), so the tier serves a FIVE-model
// failover chain across five independent providers, every link proven with
// a real buy. Payment settles BEFORE this handler runs, so a provider
// outage must never become the buyer's 502: the chain walks on ANY upstream
// failure (5xx, network error, empty audio), and only exhausting all five
// links surfaces an error. Buyers keep the OpenAI wire: the 11 OpenAI voice
// names map per-model to each provider's own voice ids, and any native id
// (en_paul_cheerful…) is accepted too — remapped to its OpenAI-name
// equivalent (or the link's alloy) if the chain walks past its model.
// TTS bills per INPUT character upstream, so the char cap bounds the
// worst-case bill deterministically per link — see costPerChar below:
// $0.032 (53% of the $0.06 price) on Voxtral down to $0.0012 (2%) on
// Kokoro; even the deepest fallback (MAI-Voice-2, $0.044 = 73%) clears the
// price. Binary responses carry no usage accounting and are never cached
// (sampled output).
export const SPEECH_PATH = "/v1/audio/speech";
const OPENROUTER_SPEECH_URL = "https://openrouter.ai/api/v1/audio/speech";
const SPEECH_PRICE = 0.06;
const SPEECH_MAX_CHARS = 2_000;
const SPEECH_FORMATS = { mp3: "audio/mpeg", pcm: "audio/pcm" };
const OPENAI_SPEECH_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer", "verse"];
// Chain order = failover order. `map` translates the OpenAI wire voice
// names to the provider's ids (closest gender/accent/tone available);
// `voices` is the provider's full native set (accepted directly, listed on
// GET /v1/models); `aliases` are the bare/family spellings accepted in
// `model`. Voice ids and per-char prices come from OpenRouter's models API
// (?output_modalities=speech) — the probe workflow re-verifies all of this
// live (.github/workflows/openrouter-tts-probe.yml).
export const SPEECH_MODELS = [
  {
    id: "mistralai/voxtral-mini-tts-2603",
    aliases: ["mistralai/voxtral-mini-tts", "voxtral-mini-tts", "voxtral-mini-tts-2603"],
    costPerChar: 0.000016,
    map: { alloy: "en_paul_neutral", ash: "en_paul_confident", ballad: "gb_oliver_neutral", coral: "gb_jane_neutral", echo: "en_paul_happy", fable: "gb_oliver_cheerful", onyx: "gb_oliver_confident", nova: "gb_jane_confident", sage: "gb_jane_neutral", shimmer: "gb_jane_curious", verse: "en_paul_cheerful" },
    voices: new Set([
      "en_paul_sad", "en_paul_neutral", "en_paul_happy", "en_paul_frustrated", "en_paul_excited", "en_paul_confident", "en_paul_cheerful", "en_paul_angry",
      "gb_oliver_neutral", "gb_oliver_sad", "gb_oliver_excited", "gb_oliver_curious", "gb_oliver_confident", "gb_oliver_cheerful", "gb_oliver_angry",
      "gb_jane_sarcasm", "gb_jane_confused", "gb_jane_shameful", "gb_jane_sad", "gb_jane_neutral", "gb_jane_jealousy", "gb_jane_frustrated", "gb_jane_curious", "gb_jane_confident",
      "fr_marie_sad", "fr_marie_neutral", "fr_marie_happy", "fr_marie_excited", "fr_marie_curious", "fr_marie_angry",
    ]),
  },
  {
    id: "x-ai/grok-voice-tts-1.0",
    aliases: ["grok-voice-tts-1.0", "grok-voice-tts"],
    costPerChar: 0.000015,
    map: { alloy: "eve", ash: "rex", ballad: "leo", coral: "ara", echo: "rex", fable: "leo", onyx: "rex", nova: "ara", sage: "eve", shimmer: "ara", verse: "sal" },
    voices: new Set(["eve", "ara", "rex", "sal", "leo"]),
  },
  {
    id: "hexgrad/kokoro-82m",
    aliases: ["kokoro-82m", "kokoro"],
    costPerChar: 0.00000062,
    map: { alloy: "af_alloy", ash: "am_adam", ballad: "bm_george", coral: "af_bella", echo: "am_echo", fable: "bm_fable", onyx: "am_onyx", nova: "af_nova", sage: "af_sarah", shimmer: "af_sky", verse: "am_liam" },
    voices: new Set([
      "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
      "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx", "am_puck", "am_santa",
      "bf_alice", "bf_emma", "bf_isabella", "bf_lily", "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
      "ef_dora", "em_alex", "em_santa", "ff_siwis", "hf_alpha", "hf_beta", "hm_omega", "hm_psi", "if_sara", "im_nicola",
      "jf_alpha", "jf_gongitsune", "jf_nezumi", "jf_tebukuro", "jm_kumo", "pf_dora", "pm_alex", "pm_santa",
      "zf_xiaobei", "zf_xiaoni", "zf_xiaoxiao", "zf_xiaoyi", "zm_yunjian", "zm_yunxi", "zm_yunxia", "zm_yunyang",
    ]),
  },
  {
    id: "zyphra/zonos-v0.1-hybrid",
    aliases: ["zonos-v0.1-hybrid", "zonos"],
    costPerChar: 0.000007,
    map: { alloy: "american_female", ash: "american_male", ballad: "british_male", coral: "american_female", echo: "american_male", fable: "british_male", onyx: "american_male", nova: "american_female", sage: "british_female", shimmer: "american_female", verse: "american_male" },
    voices: new Set(["american_female", "american_male", "british_female", "british_male", "random"]),
  },
  {
    // Single English voice — every OpenAI name lands on Harper. Priciest
    // link (73% of the price) and single-voice, hence last.
    id: "microsoft/mai-voice-2",
    aliases: ["mai-voice-2"],
    costPerChar: 0.000022,
    map: Object.fromEntries(OPENAI_SPEECH_VOICES.map((v) => [v, "en-US-Harper:MAI-Voice-2"])),
    voices: new Set(["en-US-Harper:MAI-Voice-2", "es-MX-Valeria:MAI-Voice-2", "fr-FR-Soleil:MAI-Voice-2", "de-DE-Klaus:MAI-Voice-2"]),
  },
];

/** The provider's voice id for a requested voice on this chain link:
 *  OpenAI name → mapped; the link's own native id → itself; another link's
 *  native id (chain walked past its model) → this link's alloy. */
function speechVoiceFor(entry, requested) {
  return entry.map[requested] || (entry.voices.has(requested) ? requested : entry.map.alloy);
}

export function validateSpeechRequest(input) {
  if (input == null || typeof input !== "object") throw bad("Request body must be a JSON object");
  const text = typeof input.input === "string" ? input.input : "";
  if (!text.trim()) throw bad('"input" is required — the text to speak');
  if (text.length > SPEECH_MAX_CHARS) {
    throw bad(`Input too long (${text.length} chars). /v1/audio/speech allows up to ${SPEECH_MAX_CHARS}`);
  }
  if (input.instructions !== undefined) {
    throw bad('"instructions" is not supported by the serving models — pick an expressive native voice instead (e.g. "en_paul_cheerful"; full list on GET /v1/models)');
  }
  // Explicit model pins that link to the FRONT of the chain — the rest stay
  // as fallbacks (same semantics as the chat tiers: a buyer's pick should
  // not turn a provider outage into their 502).
  let chain = SPEECH_MODELS;
  if (input.model !== undefined) {
    const m = canonicalModel(input.model).toLowerCase();
    const hit = SPEECH_MODELS.find((e) => m === e.id || e.aliases.includes(m));
    if (!hit) {
      throw bad(`"model" must be one of: ${SPEECH_MODELS.map((e) => e.id).join(", ")} (or omit it for the default chain)`);
    }
    chain = [hit, ...SPEECH_MODELS.filter((e) => e !== hit)];
  }
  const voice = input.voice === undefined ? "alloy" : String(input.voice);
  if (!OPENAI_SPEECH_VOICES.includes(voice) && !SPEECH_MODELS.some((e) => e.voices.has(voice))) {
    throw bad(`"voice" must be an OpenAI voice name (${OPENAI_SPEECH_VOICES.join(", ")}) or a native voice id from GET /v1/models`);
  }
  const format = input.response_format === undefined ? "mp3" : String(input.response_format);
  if (!SPEECH_FORMATS[format]) throw bad(`"response_format" must be one of: ${Object.keys(SPEECH_FORMATS).join(", ")}`);
  if (input.speed !== undefined) {
    const s = Number(input.speed);
    // OpenAI's documented range. Upstream bills per input character, so
    // speed is cost-neutral; providers that don't support it ignore it.
    if (!Number.isFinite(s) || s < 0.25 || s > 4) throw bad('"speed" must be between 0.25 and 4');
  }
  const zdr = input.zdr === true || input.provider?.zdr === true;
  const bodies = chain.map((entry) => ({
    model: entry.id,
    input: text,
    voice: speechVoiceFor(entry, voice),
    response_format: format,
    ...(input.speed !== undefined ? { speed: Number(input.speed) } : {}),
    ...(zdr ? { provider: { zdr: true } } : {}),
  }));
  return { bodies, contentType: SPEECH_FORMATS[format] };
}

async function speechHandler(input) {
  const { bodies, contentType } = validateSpeechRequest(input);
  const key = OPENROUTER_KEY();
  if (!key) throw bad("LLM gateway not configured (OPENROUTER_API_KEY unset)", 503);
  let lastErr;
  for (const body of bodies) {
    try {
      let res;
      try {
        res = await fetch(OPENROUTER_SPEECH_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://agent402.tools",
            "X-Title": "Agent402.Tools x402 gateway",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (e) {
        throw bad(`Upstream request failed: ${e.message}`, 504);
      }
      if (!res.ok) await throwUpstreamError(res);
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length === 0) throw bad("Upstream returned no audio — retry, or rephrase the input", 502);
      return { __binary: buffer, contentType };
    } catch (e) {
      // Walk on anything upstream-shaped (throwUpstreamError maps every
      // upstream failure to 502/503; timeouts and network errors are 504).
      // Our own validation 4xxs were thrown before the loop.
      if (![502, 503, 504].includes(e?.statusCode)) throw e;
      lastErr = e;
    }
  }
  throw lastErr;
}

/** Image blocks in a validated messages array — the margin clamp bills each
 *  a flat IMAGE_TOKENS, so the failover re-clamp needs the same count. */
function countImages(messages) {
  let images = 0;
  for (const m of Array.isArray(messages) ? messages : []) {
    if (Array.isArray(m?.content)) for (const b of m.content) if (b?.type === "image_url") images++;
  }
  return images;
}

function makeHandler(tierSlug) {
  return async (input, req) => {
    const body = validateRequest(input, tierSlug);
    // NB: @x402/express settles AFTER this handler and cancels settlement for a
    // >=400 response, so an upstream failure that we let surface as a 5xx is NOT
    // charged. We still walk the tier's fallback chain on upstream errors
    // (502/503/504) so an equivalent model can serve rather than fail — better
    // UX, and a served 200 only bills if it then settles. Our own validation
    // 4xxs pass through untouched.
    // The response's `model` field discloses which model actually served.
    // (Origin: openai/gpt-4.1-nano returned persistent provider errors on
    // 2026-07-08 — two independent paid runs — and buyers were charged $0.003
    // for 502s. No allowlist can guarantee a provider stays alive; a chain
    // ending in a canary-proven model can.)
    // Auto tier with no explicit model: the routed band+category's full
    // ranking IS the failover chain (body.model is already its head).
    // Explicit-model requests — on any tier — keep the requested model
    // first, then the tier's static fallbacks.
    const isRouted =
      TIERS[tierSlug].router === true && (!canonicalModel(input.model) || canonicalModel(input.model) === "auto");
    const routedCategory = isRouted ? classifyPrompt(input.messages) : null;
    const routedQuality = isRouted ? (input.quality === undefined ? "balanced" : String(input.quality)) : null;
    const chain = routedCategory
      ? [...AUTO_RANKINGS[routedQuality][routedCategory]]
      : [body.model, ...(TIERS[tierSlug].fallbacks || []).filter((m) => m !== body.model)];
    // Hard upstream price cap (see the maxPrice note on TIERS): rides on every
    // call, buyer-invisible, and never part of the cache key (validateRequest
    // output stays the normalized body). A cap-excluded provider surfaces as
    // an upstream error, which the chain below already walks. The buyer's zdr
    // preference (validated into body.zdr) folds in here — sent upstream as
    // provider.zdr, stripped from the top-level body (zdr: undefined below).
    const providerPrefs = {
      ...(TIERS[tierSlug].maxPrice ? { max_price: TIERS[tierSlug].maxPrice } : {}),
      ...(body.zdr === true ? { zdr: true } : {}),
    };
    const provider = Object.keys(providerPrefs).length ? providerPrefs : undefined;
    // Margin holds on EVERY link of the chain, not just the requested model:
    // validateRequest clamped max_tokens against the REQUESTED model's cost,
    // so a cheap-model clamp (often a no-op) would ride unchanged to a
    // pricier fallback and could push the worst-case upstream bill past the
    // flat price (e.g. nano gpt-4.1-nano n=4 at the full output cap failing
    // over to deepseek-chat). Re-clamp each candidate at ITS OWN cost — a
    // no-op for the primary model, tighter output for pricier fallbacks, and
    // a fallback whose input alone busts its budget is skipped (payment
    // settled; serving a shorter answer beats losing money or 502ing).
    const imageCount = countImages(body.messages);
    const outboundFor = (model) => {
      const attempt = { ...body, model };
      clampToMargin(attempt, TIERS[tierSlug], imageCount); // throws 400 → caller skips this candidate
      return { ...attempt, zdr: undefined, ...(provider ? { provider } : {}) };
    };
    if (body.stream === true) {
      // The route binder invokes __sse(res) after the paywall settled.
      // streamOpenRouterTo throws only BEFORE headers are written, so the
      // failover chain is safe: once bytes flow, errors just end the stream.
      return {
        __sse: async (res) => {
          let lastErr;
          for (const model of chain) {
            let outbound;
            try { outbound = outboundFor(model); } catch (e) { if (!lastErr) lastErr = e; continue; }
            try {
              return await streamOpenRouterTo(outbound, res);
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
      let outbound;
      try { outbound = outboundFor(model); } catch (e) { if (!lastErr) lastErr = e; continue; }
      try {
        // usage.include asks OpenRouter for the exact upstream bill on this
        // call — margin telemetry. Injected at call time (like provider), so
        // it is never part of the normalized body or cache keys. Non-stream
        // only: on streams the accounting rides the raw SSE the buyer sees.
        const data = await callOpenRouter({ ...outbound, usage: { include: true } });
        // The exact upstream cost is operator telemetry, never a buyer-visible
        // field — capture it, then strip it before the response is cached or
        // returned. Standard token counts stay (OpenAI wire shape).
        if (data && typeof data === "object" && data.usage && typeof data.usage === "object") {
          const upstreamUsd = typeof data.usage.cost === "number" ? data.usage.cost : null;
          delete data.usage.cost;
          delete data.usage.cost_details;
          delete data.usage.is_byok;
          try {
            const { capturePostHogGatewayUsage } = await import("../posthog.js");
            capturePostHogGatewayUsage({
              tier: tierSlug,
              model: data.model || model,
              priceUsd: TIERS[tierSlug].price,
              upstreamUsd,
              promptTokens: data.usage.prompt_tokens,
              completionTokens: data.usage.completion_tokens,
            });
          } catch { /* telemetry must never fail a served response */ }
        }
        // Routed requests disclose the decision: additive key, OpenAI wire
        // shape otherwise untouched (the standard `model` field already names
        // the server, this adds WHY). Streams pass through unannotated.
        if (routedCategory && data && typeof data === "object") {
          data.agent402_router = { category: routedCategory, quality: routedQuality, served: data.model || model };
        }
        if (input.cache === true) {
          // FR4-01 class: defer the cache write to AFTER settlement. @x402/express
          // settles after this handler, so writing now would cache an
          // unsettled 200. Stash on req; the route binder commits on a final 200.
          // Fall back to a direct write for non-HTTP callers (no settlement).
          try {
            const w = { key: promptCacheKey(tierSlug, input), body: data };
            if (req) (req.__deferredCache ??= []).push(w); else promptCacheStore(w.key, w.body);
          } catch { /* never fail a served response over the cache */ }
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
    zdr: { type: "boolean", description: "Optional — true routes only to zero-data-retention providers (also accepted as provider.zdr). Same price; a model with no ZDR provider errors upstream and walks the failover chain." },
  },
  required: ["model", "messages"],
};

const AUTO_INPUT_SCHEMA = {
  properties: {
    messages: INPUT_SCHEMA.properties.messages,
    model: { type: "string", description: 'Optional — omit (or send "auto") for eval-ranked server-side routing. An explicit model from the auto ranking is honored at the auto caps.' },
    quality: { type: "string", description: 'Optional routing band when the gateway picks the model: "fast" (cheapest/snappiest), "balanced" (default), "best" (strongest under the flat price). Never changes the price.' },
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
      'OpenAI-compatible chat completions with server-side model choice: omit "model" (or send "auto") and the gateway routes the prompt to the top-ranked model for its task type (code / reasoning / long-context / general) from a fixed eval-derived ranking — deterministic, no LLM in the routing path. An optional quality knob picks the band: "fast" (cheapest/snappiest), "balanced" (default), or "best" (strongest models the flat price covers) — same $0.01 either way. Provider errors fail over down the ranking automatically; the response adds agent402_router {category, quality, served} alongside the standard model field. Caps 16k chars in / 1024 tokens out. Streaming supported (stream: true). No API key, no signup.',
    tags: [...SHARED_TAGS, "router", "auto"],
    discovery: {
      bodyType: "json",
      input: { messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 5 },
      inputSchema: AUTO_INPUT_SCHEMA,
      output: { example: { ...EXAMPLE_OUT, agent402_router: { category: "general", quality: "balanced", served: "openai/gpt-4o-mini" } } },
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
  {
    route: "POST /v1/images/generations",
    name: "Image generation (OpenAI-compatible)",
    slug: "v1-images",
    category: "llm",
    price: "$0.080",
    description:
      "OpenAI-compatible image generation over x402 — point any OpenAI SDK's images.generate() at base_url https://agent402.tools/v1 and pay $0.08 per image in USDC, no API key, no signup. Served by Gemini 2.5 Flash Image (nano banana); prompt in (up to 4k chars), inline base64 image out (response_format b64_json). One image per call (n locked to 1). Optional zdr:true routes only to zero-data-retention providers.",
    tags: ["image-generation", "images", "text-to-image", "nano-banana", "gemini", ...SHARED_TAGS],
    discovery: {
      bodyType: "json",
      input: { prompt: "A minimalist watercolor of a fox reading a newspaper in a forest clearing" },
      inputSchema: {
        properties: {
          prompt: { type: "string", description: "Text description of the image to generate (up to 4,000 chars)" },
          zdr: { type: "boolean", description: "Optional — true routes only to zero-data-retention providers" },
        },
        required: ["prompt"],
      },
      output: { example: { created: 1750000000, model: IMAGES_MODEL, data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAA…", media_type: "image/png" }], usage: { prompt_tokens: 14, completion_tokens: 1290, total_tokens: 1304 } } },
    },
    handler: imagesHandler,
  },
  {
    route: "POST /v1/audio/speech",
    name: "Text-to-speech (OpenAI-compatible)",
    slug: "v1-audio-speech",
    category: "llm",
    price: "$0.060",
    description:
      "OpenAI-compatible text-to-speech over x402 — point any OpenAI SDK's audio.speech.create() at base_url https://agent402.tools/v1 and pay $0.06 per call in USDC, no API key, no signup. Served by Voxtral Mini TTS behind a five-model failover chain (xAI Grok Voice, Kokoro, Zonos, MAI-Voice-2), every link proven by a real paid canary — a provider outage never becomes your failure. Up to 2,000 chars in, raw mp3 (default) or pcm bytes out — the same wire shape as OpenAI's endpoint. OpenAI voice names (alloy, nova, …) map per-model; native voice ids (e.g. en_paul_cheerful) work too. zdr:true routes only to zero-data-retention providers.",
    tags: ["tts", "text-to-speech", "speech", "audio", "voice", ...SHARED_TAGS],
    discovery: {
      bodyType: "json",
      input: { input: "Agent402 serves fourteen hundred tools, paid per call.", voice: "alloy" },
      inputSchema: {
        properties: {
          input: { type: "string", description: "Text to speak (up to 2,000 chars)" },
          voice: { type: "string", description: "OpenAI voice name — alloy (default), ash, ballad, coral, echo, fable, onyx, nova, sage, shimmer, verse — or a native voice id from GET /v1/models (e.g. en_paul_cheerful)" },
          response_format: { type: "string", description: '"mp3" (default) or "pcm"' },
          model: { type: "string", description: "Optional — pin a chain model (e.g. mistralai/voxtral-mini-tts-2603); the rest stay as fallbacks" },
          speed: { type: "number", description: "Optional 0.25–4 playback speed (providers that don't support it ignore it)" },
          zdr: { type: "boolean", description: "Optional — true routes only to zero-data-retention providers" },
        },
        required: ["input"],
      },
      output: { example: "(raw mp3 bytes — Content-Type: audio/mpeg)" },
    },
    handler: speechHandler,
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
      x402: { tier: "v1-embeddings", endpoint: EMBEDDINGS_PATH, priceUsd: EMBEDDINGS_PRICE, maxInputChars: EMBEDDINGS_MAX_CHARS, maxItems: EMBEDDINGS_MAX_ITEMS },
    });
  }
  data.push({
    id: IMAGES_MODEL,
    object: "model",
    owned_by: "google",
    x402: { tier: "v1-images", endpoint: IMAGES_PATH, priceUsd: IMAGES_PRICE, maxPromptChars: IMAGES_MAX_PROMPT_CHARS, imagesPerCall: 1 },
  });
  for (const m of SPEECH_MODELS) {
    data.push({
      id: m.id,
      object: "model",
      owned_by: m.id.split("/")[0],
      x402: { tier: "v1-audio-speech", endpoint: SPEECH_PATH, priceUsd: SPEECH_PRICE, maxInputChars: SPEECH_MAX_CHARS, voices: [...m.voices] },
    });
  }
  return { object: "list", data, terms_of_service: "https://agent402.tools/terms", note: "Prefixes ending in /* allow the whole vendor family. Pay per call via x402 (USDC on Base, Solana, Polygon, Arbitrum, Stellar) — no API key. Bare OpenAI-style names (gpt-4o-mini) are accepted and mapped. Use constitutes acceptance of the terms_of_service (acceptable-use policy included)." };
}
