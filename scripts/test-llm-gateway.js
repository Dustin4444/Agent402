// Unit tests for the OpenAI-compatible x402 LLM gateway — the pure validation
// layer that gates what reaches the paid OpenRouter upstream: model → tier
// routing (incl. bare-name mapping and self-correcting cross-tier errors),
// input/output caps, stream rejection, and the env-gated 503. No network.
import { TIERS, canonicalModel, tierAllows, tierFor, validateRequest, modelsList, LLM_GATEWAY_TOOLS, stableStringify, promptCacheKey, promptCacheGet, promptCacheStore, GATEWAY_TIER_BY_PATH, AUTO_RANKINGS, classifyPrompt, validateEmbeddingsRequest, embeddingsCacheKey, EMBEDDINGS_PATH } from "../src/tools/llm-gateway-kit.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };
const throws = (fn, substr, msg) => {
  try { fn(); ok(false, `${msg} (did not throw)`); }
  catch (e) { ok(String(e.message).includes(substr), `${msg} (got: ${String(e.message).slice(0, 90)})`); }
};

const msg1 = (content = "hi") => [{ role: "user", content }];

// Bare OpenAI-style names map to OpenRouter ids — drop-in SDK compatibility.
ok(canonicalModel("gpt-4o-mini") === "openai/gpt-4o-mini", "bare gpt name maps to openai/");
ok(canonicalModel("claude-opus-4") === "anthropic/claude-opus-4", "bare claude name maps to anthropic/");
ok(canonicalModel("gemini-2.5-flash") === "google/gemini-2.5-flash", "bare gemini name maps to google/");
ok(canonicalModel("o3-mini") === "openai/o3-mini", "bare o3 name maps to openai/");
ok(canonicalModel("deepseek/deepseek-chat") === "deepseek/deepseek-chat", "OpenRouter ids pass through");

// Tier routing.
ok(tierAllows("v1-chat", "gpt-4o-mini"), "gpt-4o-mini allowed on base tier");
ok(tierAllows("v1-chat", "deepseek/deepseek-chat"), "vendor-family prefix (deepseek/) allowed on base tier");
ok(!tierAllows("v1-chat", "openai/gpt-4o"), "gpt-4o NOT on base tier");
ok(tierAllows("v1-chat-pro", "openai/gpt-4o"), "gpt-4o on pro tier");
ok(tierAllows("v1-chat-premium", "claude-opus-4"), "claude opus on premium tier");
ok(tierFor("openai/gpt-4o") === "v1-chat-pro", "tierFor routes gpt-4o to pro");
ok(tierFor("not-a-real/model") === null, "tierFor null for unknown models");

// gpt-4o must not leak onto the base tier via the gpt-4o-mini prefix rules.
ok(!tierAllows("v1-chat", "openai/gpt-4o-2024-08-06"), "dated gpt-4o snapshot NOT on base tier");
ok(tierAllows("v1-chat", "openai/gpt-4o-mini-2024-07-18"), "dated gpt-4o-mini snapshot on base tier");

// validateRequest — happy path clamps and passthrough.
const v = validateRequest({ model: "gpt-4o-mini", messages: msg1(), max_tokens: 999999, temperature: 0.2, stream: false }, "v1-chat");
ok(v.model === "openai/gpt-4o-mini", "request model canonicalised");
ok(v.max_tokens === TIERS["v1-chat"].maxTokens, "max_tokens clamped to tier cap");
ok(v.temperature === 0.2, "temperature passed through");
ok(!("stream" in v), "stream:false dropped from upstream body");

// Self-correcting cross-tier error names the right endpoint + price.
throws(() => validateRequest({ model: "gpt-4o", messages: msg1() }, "v1-chat"), "/v1/pro/chat/completions", "cross-tier error points at the pro endpoint");
throws(() => validateRequest({ model: "gpt-4o", messages: msg1() }, "v1-chat"), "$0.10", "cross-tier error names the pro price");
throws(() => validateRequest({ model: "made-up-model-9000", messages: msg1() }, "v1-chat"), "/v1/models", "unknown model error points at the models list");

// Hard rejections.
{
  const v = validateRequest({ model: "gpt-4o-mini", messages: msg1(), stream: true, stream_options: { include_usage: true } }, "v1-chat");
  ok(v.stream === true && v.stream_options?.include_usage === true, "stream:true accepted and carried to the upstream body (with stream_options)");
  const nv = validateRequest({ model: "gpt-4o-mini", messages: msg1() }, "v1-chat");
  ok(nv.stream === undefined, "non-stream requests carry no stream flag");
}
throws(() => validateRequest({ model: "gpt-4o-mini", messages: [] }, "v1-chat"), "non-empty", "empty messages rejected");
throws(() => validateRequest({ messages: msg1() }, "v1-chat"), "required", "missing model rejected");
throws(() => validateRequest({ model: "gpt-4o-mini", messages: msg1("x".repeat(40_000)) }, "v1-chat"), "Input too large", "input char cap enforced");
throws(() => validateRequest({ model: "gpt-4o-mini", messages: Array.from({ length: 101 }, () => ({ role: "user", content: "x" })) }, "v1-chat"), "Too many messages", "message count cap enforced");

// Env-gated 503 before any network I/O (no OPENROUTER_API_KEY in this test env).
delete process.env.OPENROUTER_API_KEY;
const gatewayTool = LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-chat");
await gatewayTool.handler({ model: "gpt-4o-mini", messages: msg1(), max_tokens: 5 }).then(
  () => ok(false, "handler without key must throw"),
  (e) => ok(e.statusCode === 503, `handler without key throws 503 (got ${e.statusCode})`)
);

// Models list — OpenAI-compatible envelope, every tier represented, priced.
const list = modelsList();
ok(list.object === "list" && Array.isArray(list.data) && list.data.length > 10, "models list has OpenAI shape");
ok(list.data.every((m) => m.object === "model" && m.x402?.priceUsd > 0 && m.x402?.endpoint?.startsWith("/v1")), "every model entry carries x402 tier metadata");
ok(new Set(list.data.map((m) => m.x402.tier)).size === 6, "all five chat tiers + embeddings represented");

// Catalog invariants: wallet-only-priced routes at OpenAI wire paths.
ok(LLM_GATEWAY_TOOLS.length === 6, "six gateway routes");

// Nano tier — priced for loops; nano models keep working on the base tier
// (drop-in callers can overpay) but tierFor leads with the cheapest home.
ok(TIERS["v1-chat-nano"].price === 0.003, "nano tier priced at $0.003");
ok(tierAllows("v1-chat-nano", "gpt-4.1-nano"), "gpt-4.1-nano allowed on nano tier");
ok(tierAllows("v1-chat", "gpt-4.1-nano"), "gpt-4.1-nano STILL allowed on base tier (non-breaking)");
ok(tierFor("openai/gpt-4.1-nano") === "v1-chat-nano", "tierFor leads with the nano tier");
ok(!tierAllows("v1-chat-nano", "openai/gpt-4o"), "gpt-4o NOT on nano tier");
ok(tierAllows("v1-chat-nano", "deepseek/deepseek-chat"), "deepseek-chat on nano tier");
{
  const v = validateRequest({ model: "gpt-4.1-nano", messages: [{ role: "user", content: "hi" }], max_tokens: 99999 }, "v1-chat-nano");
  ok(v.max_tokens === TIERS["v1-chat-nano"].maxTokens, "nano output cap clamps");
}
ok(LLM_GATEWAY_TOOLS.every((t) => t.route.startsWith("POST /v1/")), "routes live at OpenAI wire paths");

// Upstream failover: a provider error on the requested model must not become
// the buyer's 502 when the tier has a fallback chain (payment already settled).
{
  process.env.OPENROUTER_API_KEY = "test-key";
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.model);
    if (body.model === "openai/gpt-4.1-nano") {
      return { ok: false, status: 502, text: async () => JSON.stringify({ error: { message: "Provider returned error" } }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: "gen-1", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] }) };
  };
  const nano = LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-chat-nano");
  const res = await nano.handler({ model: "gpt-4.1-nano", messages: [{ role: "user", content: "hi" }], max_tokens: 5 });
  ok(res.choices?.[0]?.message?.content === "OK", "failover serves the buyer despite the requested model's provider error");
  ok(res.model === "deepseek/deepseek-chat", `response discloses the serving model (got ${res.model})`);
  ok(calls.join(",") === "openai/gpt-4.1-nano,deepseek/deepseek-chat", `tried requested model first, then the chain (got ${calls.join(",")})`);

  // Validation errors must NOT trigger the chain — the buyer's input is wrong.
  calls.length = 0;
  let threw = null;
  try { await nano.handler({ model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] }); } catch (e) { threw = e; }
  ok(threw?.statusCode === 400 && calls.length === 0, "tier-allowlist 400 throws before any upstream call — no silent substitution");
  globalThis.fetch = realFetch;
  delete process.env.OPENROUTER_API_KEY;
}

// Streaming: stream:true returns an __sse writer; SSE passes through verbatim
// with correct headers; pre-stream provider errors walk the failover chain.
{
  process.env.OPENROUTER_API_KEY = "test-key";
  const realFetch = globalThis.fetch;
  const sseBody = (lines) => ({
    async *[Symbol.asyncIterator]() { for (const l of lines) yield Buffer.from(l); },
  });
  const fakeRes = () => {
    const r = {
      headersSent: false, headers: null, chunks: [], ended: false, listeners: {},
      writeHead(status, headers) { r.headersSent = true; r.status = status; r.headers = headers; },
      flushHeaders() {},
      write(c) { r.chunks.push(String(c)); },
      end() { r.ended = true; },
      on(ev, cb) { r.listeners[ev] = cb; },
    };
    return r;
  };
  const nano = LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-chat-nano");

  // Happy path — deepseek streams (it's in the nano allowlist).
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    ok(body.stream === true, "stream flag reaches the upstream body");
    return { ok: true, status: 200, body: sseBody(['data: {"choices":[{"delta":{"content":"O"}}]}\n\n', "data: [DONE]\n\n"]) };
  };
  const streamResult = await nano.handler({ model: "deepseek/deepseek-chat", messages: [{ role: "user", content: "hi" }], stream: true });
  ok(typeof streamResult.__sse === "function", "stream:true returns the __sse writer sentinel");
  const res1 = fakeRes();
  await streamResult.__sse(res1);
  ok(res1.status === 200 && res1.headers["Content-Type"].startsWith("text/event-stream"), "SSE headers written");
  ok(res1.chunks.join("").includes("[DONE]") && res1.ended, "chunks pass through verbatim and the stream ends");

  // Pre-stream failover: requested model 502s before any bytes → fallback streams.
  const tried = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    tried.push(body.model);
    if (body.model === "openai/gpt-4.1-nano") return { ok: false, status: 502, text: async () => "provider down" };
    return { ok: true, status: 200, body: sseBody(["data: [DONE]\n\n"]) };
  };
  const res2 = fakeRes();
  await (await nano.handler({ model: "gpt-4.1-nano", messages: [{ role: "user", content: "hi" }], stream: true })).__sse(res2);
  ok(tried.join(",") === "openai/gpt-4.1-nano,deepseek/deepseek-chat" && res2.ended, `pre-stream failover walks the chain (tried ${tried.join(",")})`);

  // Validation still precedes everything: wrong-tier model rejects with 400.
  let threw = null;
  try { await nano.handler({ model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }], stream: true }); } catch (e) { threw = e; }
  ok(threw?.statusCode === 400, "stream requests still validate before any upstream call");
  globalThis.fetch = realFetch;
  delete process.env.OPENROUTER_API_KEY;
}

// Prompt cache: explicit opt-in, normalized keying, opt-in-only writes.
{
  ok(stableStringify({ b: 1, a: [{ y: 2, x: 1 }] }) === stableStringify({ a: [{ x: 1, y: 2 }], b: 1 }), "stableStringify is key-order independent");

  const msgs = [{ role: "user", content: "hi" }];
  const k1 = promptCacheKey("v1-chat-nano", { model: "gpt-4.1-nano", messages: msgs, cache: true });
  const k2 = promptCacheKey("v1-chat-nano", { cache: true, messages: msgs, model: "openai/gpt-4.1-nano" });
  ok(k1 && k1 === k2, "model alias + field order collapse to one cache key");
  const k3 = promptCacheKey("v1-chat-nano", { model: "gpt-4.1-nano", messages: msgs, temperature: 0.7, cache: true });
  ok(k3 !== k1, "sampling params (temperature) change the key");
  ok(promptCacheKey("v1-chat-nano", { model: "gpt-4.1-nano", messages: msgs, stream: true, cache: true }) === null, "streamed requests are never cacheable");

  promptCacheStore(k1, { id: "gen-cached", choices: [] });
  ok(promptCacheGet(k1)?.id === "gen-cached", "store/get roundtrip");
  ok(promptCacheGet(k3) === null, "different key misses");

  ok(GATEWAY_TIER_BY_PATH["/v1/nano/chat/completions"] === "v1-chat-nano", "path -> tier map covers nano");
  ok(Object.keys(GATEWAY_TIER_BY_PATH).length === 5, "path -> tier map covers all five tiers");

  // The handler writes the cache ONLY when the buyer opted in.
  process.env.OPENROUTER_API_KEY = "test-key";
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    ok(body.cache === undefined, "cache flag never rides to the upstream");
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: "gen-fresh", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] }) };
  };
  const nano = LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-chat-nano");
  const optIn = { model: "deepseek/deepseek-chat", messages: [{ role: "user", content: "cache me" }], cache: true };
  await nano.handler(optIn);
  ok(promptCacheGet(promptCacheKey("v1-chat-nano", optIn))?.id === "gen-fresh", "opted-in success is stored under the normalized key");
  const noOpt = { model: "deepseek/deepseek-chat", messages: [{ role: "user", content: "do not cache me" }] };
  await nano.handler(noOpt);
  ok(promptCacheGet(promptCacheKey("v1-chat-nano", { ...noOpt, cache: true })) === null, "without cache:true nothing is stored");
  globalThis.fetch = realFetch;
  delete process.env.OPENROUTER_API_KEY;
}

// Auto tier — eval-ranked routing: deterministic classification, optional
// model, ranking-as-failover-chain, disclosure, and the tier-ordering lock.
{
  ok(TIERS["v1-chat-auto"].price === 0.01, "auto tier priced at $0.01");
  ok(Object.values(AUTO_RANKINGS).every((list) => list.includes("openai/gpt-4o-mini")), "every ranking contains the canary-proven terminal model");

  // Classification is lexical and deterministic.
  ok(classifyPrompt([{ role: "user", content: "Refactor this function:\n```js\nreturn 1\n```" }]) === "code", "code prompts classify as code");
  ok(classifyPrompt([{ role: "user", content: "Solve the equation 3x + 5 = 20 step by step" }]) === "reasoning", "math prompts classify as reasoning");
  ok(classifyPrompt([{ role: "user", content: "x".repeat(9000) }]) === "long", "big plain prompts classify as long");
  ok(classifyPrompt([{ role: "user", content: `Refactor this function:\n\`\`\`js\nreturn 1\n\`\`\`\n${"x".repeat(9000)}` }]) === "code", "code signal outranks raw length");
  ok(classifyPrompt([{ role: "user", content: "What is the capital of France?" }]) === "general", "plain prompts classify as general");
  ok(classifyPrompt("not-an-array") === "general", "malformed messages tolerate as general (validation 400s right after)");

  // Model resolution: omitted or "auto" routes; explicit ranked models honored.
  const noModel = validateRequest({ messages: msg1("What is the capital of France?") }, "v1-chat-auto");
  ok(noModel.model === AUTO_RANKINGS.general[0], `missing model resolves to the general ranking head (got ${noModel.model})`);
  const autoModel = validateRequest({ model: "auto", messages: msg1("Solve the equation 3x + 5 = 20 step by step") }, "v1-chat-auto");
  ok(autoModel.model === AUTO_RANKINGS.reasoning[0], "model:'auto' resolves via the classifier");
  ok(validateRequest({ model: "gpt-4o-mini", messages: msg1() }, "v1-chat-auto").model === "openai/gpt-4o-mini", "explicit ranked model honored on the auto tier");
  throws(() => validateRequest({ model: "openai/gpt-4o", messages: msg1() }, "v1-chat-auto"), "/v1/pro/chat/completions", "off-ranking model still self-corrects to its home tier");
  {
    const v = validateRequest({ messages: msg1(), max_tokens: 99999 }, "v1-chat-auto");
    ok(v.max_tokens === TIERS["v1-chat-auto"].maxTokens, "auto output cap clamps");
  }

  // Ordering lock: the auto tier is listed LAST, so tierFor keeps resolving
  // explicit models to their pre-existing home tiers.
  ok(tierFor("openai/gpt-4o-mini") === "v1-chat", "tierFor: gpt-4o-mini's home stays the base tier");
  ok(tierFor("deepseek/deepseek-chat") === "v1-chat-nano", "tierFor: deepseek-chat's home stays the nano tier");

  // Handler: routed request uses the category ranking as the failover chain
  // and discloses the decision; explicit-model requests stay unannotated.
  process.env.OPENROUTER_API_KEY = "test-key";
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.model);
    if (body.model === AUTO_RANKINGS.code[0]) return { ok: false, status: 502, text: async () => "provider down" };
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: "gen-a", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] }) };
  };
  const auto = LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-chat-auto");
  const routed = await auto.handler({ messages: [{ role: "user", content: "Refactor this function:\n```js\nreturn 1\n```" }], max_tokens: 5 });
  ok(routed.agent402_router?.category === "code", `routed response discloses the category (got ${routed.agent402_router?.category})`);
  ok(routed.agent402_router?.served === AUTO_RANKINGS.code[1], `provider error walks DOWN the ranking (served ${routed.agent402_router?.served})`);
  ok(calls.join(",") === AUTO_RANKINGS.code.slice(0, 2).join(","), `chain follows the ranking order (got ${calls.join(",")})`);

  calls.length = 0;
  const explicit = await auto.handler({ model: "gpt-4o-mini", messages: msg1(), max_tokens: 5 });
  ok(explicit.agent402_router === undefined, "explicit-model requests carry no router annotation");
  ok(calls.join(",") === "openai/gpt-4o-mini", `explicit model goes straight upstream (got ${calls.join(",")})`);
  globalThis.fetch = realFetch;
  delete process.env.OPENROUTER_API_KEY;

  // Prompt cache composes: model-less requests key on the RESOLVED model, so
  // identical routed requests collapse to one entry and ranking-table changes
  // invalidate cleanly.
  const kAuto1 = promptCacheKey("v1-chat-auto", { messages: msg1("hello there"), cache: true });
  const kAuto2 = promptCacheKey("v1-chat-auto", { cache: true, messages: msg1("hello there") });
  ok(kAuto1 && kAuto1 === kAuto2, "auto-tier cache key is stable without a model field");
  ok(kAuto1 === promptCacheKey("v1-chat-auto", { model: AUTO_RANKINGS.general[0], messages: msg1("hello there"), cache: true }), "routed and explicit-equivalent requests share one cache entry");
  ok(GATEWAY_TIER_BY_PATH["/v1/auto/chat/completions"] === "v1-chat-auto", "path -> tier map covers auto");
}

// /v1/embeddings — wire-path validation, default model, batching caps,
// default-ON cache (deterministic output), and the wire-shape passthrough.
{
  ok(EMBEDDINGS_PATH === "/v1/embeddings", "embeddings path constant");
  const v = validateEmbeddingsRequest({ input: "hello" });
  ok(v.model === "text-embedding-3-small", "model defaults to text-embedding-3-small");
  ok(Array.isArray(v.input) && v.input.length === 1 && v.input[0] === "hello", "string input normalizes to a one-item array");
  ok(validateEmbeddingsRequest({ input: "x", model: "openai/text-embedding-3-large" }).model === "text-embedding-3-large", "openai/ prefix accepted and stripped");
  ok(validateEmbeddingsRequest({ input: ["a", "b"], dimensions: 256 }).dimensions === 256, "dimensions passes through");
  throws(() => validateEmbeddingsRequest({ input: "x", model: "text-embedding-9000" }), "must be one of", "off-allowlist model rejected");
  throws(() => validateEmbeddingsRequest({ model: "text-embedding-3-small" }), "required", "missing input rejected");
  throws(() => validateEmbeddingsRequest({ input: [] }), "required", "empty array rejected");
  throws(() => validateEmbeddingsRequest({ input: ["a", 42] }), "non-empty string", "non-string item rejected");
  throws(() => validateEmbeddingsRequest({ input: Array.from({ length: 65 }, () => "x") }), "Too many inputs", "item-count cap enforced");
  throws(() => validateEmbeddingsRequest({ input: "x".repeat(17_000) }), "Input too large", "char cap enforced");
  throws(() => validateEmbeddingsRequest({ input: "x", model: "text-embedding-ada-002", dimensions: 256 }), "not supported", "dimensions rejected on ada-002");
  throws(() => validateEmbeddingsRequest({ input: "x", encoding_format: "hex" }), "encoding_format", "bad encoding_format rejected");

  // Cache policy: DEFAULT-ON, cache:false opts out, keys are normalized.
  const k1 = embeddingsCacheKey({ input: "same text" });
  const k2 = embeddingsCacheKey({ input: ["same text"], model: "openai/text-embedding-3-small" });
  ok(k1 && k1 === k2, "string vs [string] vs explicit-default-model collapse to one cache key");
  ok(embeddingsCacheKey({ input: "same text", cache: false }) === null, "cache:false opts out (returns null)");
  ok(embeddingsCacheKey({ input: "same text", model: "text-embedding-3-large" }) !== k1, "model changes the key");
  ok(embeddingsCacheKey({ input: "same text", dimensions: 256 }) !== k1, "dimensions change the key");

  // Handler: 503 without the key; upstream body carries the normalized
  // request; success is stored under the default-on cache key.
  const embed = LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-embeddings");
  delete process.env.OPENAI_API_KEY;
  await embed.handler({ input: "hi" }).then(
    () => ok(false, "embeddings handler without key must throw"),
    (e) => ok(e.statusCode === 503, `embeddings handler without key throws 503 (got ${e.statusCode})`)
  );
  process.env.OPENAI_API_KEY = "test-key";
  const realFetch = globalThis.fetch;
  let upstreamBody = null, authHeader = null;
  globalThis.fetch = async (url, init) => {
    upstreamBody = JSON.parse(init.body);
    authHeader = init.headers.Authorization;
    ok(String(url).includes("api.openai.com/v1/embeddings"), "embeddings go to the OpenAI upstream");
    return { ok: true, status: 200, text: async () => JSON.stringify({ object: "list", data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }], model: upstreamBody.model, usage: { prompt_tokens: 2, total_tokens: 2 } }) };
  };
  const out = await embed.handler({ input: "cache me by default" });
  ok(out.object === "list" && Array.isArray(out.data[0].embedding), "OpenAI wire shape passes through untouched");
  ok(authHeader === "Bearer test-key", "upstream call carries the OpenAI bearer");
  ok(upstreamBody.model === "text-embedding-3-small" && Array.isArray(upstreamBody.input), "upstream body is the normalized request");
  ok(upstreamBody.cache === undefined, "cache flag never rides to the upstream");
  ok(promptCacheGet(embeddingsCacheKey({ input: "cache me by default" }))?.object === "list", "success stored WITHOUT any opt-in (default-on)");
  await embed.handler({ input: "do not cache me", cache: false });
  ok(promptCacheGet(embeddingsCacheKey({ input: "do not cache me" })) === null, "cache:false skips the store");
  globalThis.fetch = realFetch;
  delete process.env.OPENAI_API_KEY;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
