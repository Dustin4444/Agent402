// /v1/.../responses (OpenAI Responses wire) - offline, stub fetch.
process.env.POSTHOG_TEST_CAPTURE = "1";
import { LLM_RESPONSES_TOOLS, validateResponsesRequest, isEmptyIncomplete, RESPONSES_PATH_BY_TIER } from "../src/tools/llm-responses-kit.js";
import { TIERS, createSseUsageScrubber } from "../src/tools/llm-gateway-kit.js";
import { WALLET_ONLY_SLUGS } from "../src/pow.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };
const bySlug = (slug) => LLM_RESPONSES_TOOLS.find((t) => t.slug === slug);
const base = "v1-chat", nanoT = "v1-chat-nano";

ok(LLM_RESPONSES_TOOLS.length === 5 && LLM_RESPONSES_TOOLS.every((t) => t.route === `POST ${RESPONSES_PATH_BY_TIER[t.slug.replace(/-responses$/, "")]}` && WALLET_ONLY_SLUGS.has(t.slug)), "five Responses routes on the tier paths, all wallet-only");

// ---- validation ----
const v = validateResponsesRequest({ model: "openai/gpt-4o-mini", input: "hi", instructions: "terse", max_output_tokens: 99999, temperature: 0.1, text: { format: { type: "text" } } }, base);
ok(v.body.model === "openai/gpt-4o-mini" && v.body.max_output_tokens === TIERS[base].maxTokens && v.body.store === false && v.body.instructions === "terse" && v.body.text.format.type === "text", `valid body: max_output_tokens clamped to the cap (${v.body.max_output_tokens}), store forced false, instructions/text pass`);
ok(validateResponsesRequest({ model: "openai/gpt-4o-mini", input: "hi" }, base).body.max_output_tokens === Math.min(1024, TIERS[base].maxTokens), "max_output_tokens defaults like the chat wire");
for (const [label, body] of [
  ["no input", { model: "openai/gpt-4o-mini" }],
  ["previous_response_id", { model: "openai/gpt-4o-mini", input: "hi", previous_response_id: "resp_1" }],
  ["background", { model: "openai/gpt-4o-mini", input: "hi", background: true }],
  ["server tool web_search", { model: "openai/gpt-4o-mini", input: "hi", tools: [{ type: "web_search_preview" }] }],
  ["server tool mcp", { model: "openai/gpt-4o-mini", input: "hi", tools: [{ type: "mcp", server_label: "x" }] }],
  ["input_file part", { model: "openai/gpt-4o-mini", input: [{ role: "user", content: [{ type: "input_file", file_id: "f" }] }] }],
  ["bad role", { model: "openai/gpt-4o-mini", input: [{ role: "tool", content: "x" }] }],
  ["unknown item type", { model: "openai/gpt-4o-mini", input: [{ type: "computer_call", id: "x" }] }],
  ["bad reasoning effort", { model: "openai/gpt-4o-mini", input: "hi", reasoning: { effort: "ultra" } }],
  ["model on wrong tier", { model: "anthropic/claude-opus-5", input: "hi" }],
  ["too large", { model: "openai/gpt-4o-mini", input: "x".repeat(TIERS[base].maxInputChars + 1) }],
]) {
  let e = null; try { validateResponsesRequest(body, base); } catch (x) { e = x; }
  ok(e?.statusCode === 400, `${label} -> 400 (${String(e?.message || "").slice(0, 70)})`);
}
{
  const r = validateResponsesRequest({ model: "openai/gpt-4o-mini", input: [
    { role: "developer", content: "be terse" },
    { role: "user", content: [{ type: "input_text", text: "what is in this image?" }, { type: "input_image", image_url: "data:image/png;base64," + "A".repeat(100_000) }] },
    { type: "function_call", call_id: "c1", name: "f", arguments: "{}" },
    { type: "function_call_output", call_id: "c1", output: "42" },
  ], tools: [{ type: "function", name: "f", parameters: { type: "object" } }] }, base);
  ok(r.imageCount === 1 && JSON.stringify(r.probe).length < 2000 && r.body.tools.length === 1 && r.body.input.length === 4, "item-list input with an image, function tools and tool outputs validates; probe drops the image payload");
  const auto = validateResponsesRequest({ input: "Write a python function that reverses a list" }, "v1-chat-auto");
  ok(auto.isRouted && auto.routedCategory === "code" && auto.body.model === undefined, `auto tier routes by prompt class (${auto.routedCategory})`);
}
ok(isEmptyIncomplete({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "reasoning", summary: [] }] }) && !isEmptyIncomplete({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "message", content: [{ type: "output_text", text: "partial" }] }] }) && !isEmptyIncomplete({ status: "completed", output: [] }), "isEmptyIncomplete: only max_output_tokens + nothing said");

// ---- handler ----
process.env.OPENROUTER_API_KEY = "test-key";
const realFetch = globalThis.fetch;
const fakeReq = { header: (n) => (n === "payment-signature" ? Buffer.from(JSON.stringify({ payload: { authorization: { from: "0xAbCdEf0000000000000000000000000000000004" } } })).toString("base64") : undefined) };
const reply = (model, over = {}) => ({ id: "resp_1", object: "response", status: "completed", model, output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello there.", annotations: [] }] }], usage: { input_tokens: 9, output_tokens: 3, total_tokens: 12, cost: 0.0000021, is_byok: false, cost_details: { upstream_inference_cost: 0.0000021 } }, service_tier: "default", ...over });
let seen = [];
globalThis.fetch = async (url, init) => { const b = JSON.parse(init.body); seen.push({ url: String(url), b }); return { ok: true, status: 200, text: async () => JSON.stringify(reply(b.model)) }; };
const baseTool = bySlug("v1-chat-responses");
const out = await baseTool.handler({ model: "openai/gpt-4o-mini", input: "hi", max_output_tokens: 64, text: { format: { type: "json_schema", name: "a", schema: { type: "object" } } } }, fakeReq);
ok(seen[0].url.endsWith("/api/v1/responses") && seen[0].b.model === "openai/gpt-4o-mini" && seen[0].b.store === false && seen[0].b.max_output_tokens === 64, "upstream call hits OpenRouter /responses with store:false and the cap");
ok(seen[0].b.provider?.max_price && seen[0].b.provider?.require_parameters === true && seen[0].b.session_id === seen[0].b.user && seen[0].b.cache_control?.type === "ephemeral", "server-owned max_price + require_parameters (json_schema) + session_id + cache_control ride");
ok(out.output[0].content[0].text === "Hello there." && !("cost" in out.usage) && !("is_byok" in out.usage), "Responses body passes through with billing fields stripped");
{
  const { _testEventsForTest } = await import("../src/posthog.js");
  const ev = _testEventsForTest().filter((e) => e.event === "gateway_usage").pop();
  ok(ev?.properties.tier === "v1-chat:responses" && ev?.properties.upstreamUsd === 0.0000021 && ev?.properties.promptTokens === 9, "margin telemetry recorded under <tier>:responses");
}
seen = [];
await bySlug("v1-chat-nano-responses").handler({ model: "openai/gpt-5-nano", input: "hi", max_output_tokens: 64 }, fakeReq);
ok(seen[0].b.reasoning?.effort === "minimal" && seen[0].b.provider?.sort === "price" && seen[0].b.service_tier === "flex", "nano + gpt-5-nano: default reasoning effort minimal, price sort, flex-first");
seen = [];
await bySlug("v1-chat-nano-responses").handler({ model: "openai/gpt-5-nano", input: "hi", max_output_tokens: 64, reasoning: { effort: "high" } }, fakeReq);
ok(seen[0].b.reasoning?.effort === "high", "buyer reasoning preference wins");
// failover + paid-empty on nano (has fallbacks)
seen = [];
globalThis.fetch = async (url, init) => { const b = JSON.parse(init.body); seen.push(b.model + (b.service_tier ? ":flex" : "")); return { ok: true, status: 200, text: async () => JSON.stringify(b.model === "openai/gpt-5-nano" ? reply(b.model, { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "reasoning", summary: [] }] }) : reply(b.model)) }; };
const pe = await bySlug("v1-chat-nano-responses").handler({ model: "openai/gpt-5-nano", input: "hi", max_output_tokens: 64 }, fakeReq);
ok(pe.output[0].content[0].text === "Hello there." && seen.join(",") === "openai/gpt-5-nano:flex,deepseek/deepseek-chat", `incomplete-with-nothing-said is never served: chain walked on, same-model default retry skipped (${seen.join(" -> ")})`);
globalThis.fetch = async (url, init) => { const b = JSON.parse(init.body); return { ok: true, status: 200, text: async () => JSON.stringify(reply(b.model, { status: "failed", error: { code: "server_error", message: "boom" } })) }; };
await baseTool.handler({ model: "openai/gpt-4o-mini", input: "hi" }, fakeReq).then(() => ok(false, "failed status must not serve"), (e) => ok(e.statusCode === 502 && /boom/.test(e.message), "status failed -> 502 with the upstream message"));
// stream: nested response.usage scrubbed end to end
{
  const frames = [];
  const completed = 'data: {"type":"response.completed","response":{"id":"r","model":"openai/gpt-4o-mini","status":"completed","output":[],"usage":{"input_tokens":6,"output_tokens":3,"cost":0.0000018,"is_byok":false,"cost_details":{"upstream_inference_cost":0.0000018}}},"sequence_number":11}\n\n';
  globalThis.fetch = async () => ({ ok: true, status: 200, body: { async *[Symbol.asyncIterator]() { yield Buffer.from('data: {"type":"response.created","response":{"id":"r","usage":null},"sequence_number":0}\n\n'); yield Buffer.from('data: {"type":"response.output_text.delta","delta":"Hello","sequence_number":4}\n\n'); yield Buffer.from(completed); } } });
  const res = { headersSent: false, writeHead() { this.headersSent = true; }, flushHeaders() {}, write(c) { frames.push(String(c)); }, end() { this.ended = true; }, on() {} };
  const h = await baseTool.handler({ model: "openai/gpt-4o-mini", input: "hi", stream: true }, fakeReq);
  await h.__sse(res);
  const all = frames.join("");
  ok(res.ended && /response.created/.test(all) && /output_text.delta/.test(all) && /response.completed/.test(all) && /"input_tokens":6/.test(all) && !/cost|is_byok/.test(all), "streamed Responses events pass through end to end; nested response.usage billing scrubbed");
}
globalThis.fetch = realFetch;
delete process.env.OPENROUTER_API_KEY;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
