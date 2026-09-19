// Google's native generateContent wire (src/tools/llm-gemini-kit.js) - offline.
//
// This wire is a TRANSLATION, not a relay: OpenRouter answers 404 on every
// spelling of /v1beta/models/<model>:generateContent (probed live 2026-09-18),
// so the kit maps Gemini's shape onto the chat wire and back. That makes the
// translation the whole product, and the two things worth pinning are that it
// is FAITHFUL (a Google SDK's request survives the round trip) and that it is
// DETERMINISTIC (the metered gate and the handler's own belt both quote the
// translated body, so a translation that wobbled would refuse a call rather
// than mis-charge it - but it must not wobble).
//
//   node scripts/test-llm-gemini-kit.js
const {
  LLM_GEMINI_TOOLS, GEMINI_PATH_BY_TIER, GEMINI_TIER_BY_PATH,
  geminiToChat, chatToGemini, meteredGeminiQuoteUsd,
} = await import("../src/tools/llm-gemini-kit.js");
const { TIERS } = await import("../src/tools/llm-gateway-kit.js");
const { repointToGeminiWire } = await import("../src/tools/llm-gemini-kit.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };
const throws = (fn, frag, m) => { let e = null; try { fn(); } catch (x) { e = x; } ok(e && String(e.message).includes(frag), `${m} (${e ? String(e.message).slice(0, 90) : "no throw"})`); };
const M = "openai/gpt-4o-mini";

// ---- registration ----
ok(LLM_GEMINI_TOOLS.length === 6, "six tools, one per chat tier");
ok(Object.keys(GEMINI_PATH_BY_TIER).at(-1) === "v1-chat-metered", "metered is LAST (the TIERS ordering rule)");
ok(LLM_GEMINI_TOOLS.every((t) => t.category === "llm" && typeof t.handler === "function" && t.discovery?.inputSchema?.required?.includes("contents")), "every tool is an llm route with a handler and a contents-required schema");
ok(LLM_GEMINI_TOOLS.filter((t) => typeof t.quote === "function").length === 1, "only the metered tier carries a per-request quote function");
ok(Object.entries(GEMINI_TIER_BY_PATH).every(([p, t]) => GEMINI_PATH_BY_TIER[t] === p), "the path<->tier maps are inverses");
ok(LLM_GEMINI_TOOLS.every((t) => !/—/.test(t.description + t.name)), "no em dashes in tool copy");

// ---- request translation ----
{
  const { chat } = geminiToChat({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }, M);
  ok(chat.messages.length === 1 && chat.messages[0].role === "user" && chat.messages[0].content === "hi", "a plain user turn becomes one OpenAI user message");
}
{
  const { chat } = geminiToChat({ contents: [{ parts: [{ text: "hi" }] }] }, M);
  ok(chat.messages[0].role === "user", "a turn with no role defaults to user, as Gemini does");
}
{
  const { chat } = geminiToChat({
    systemInstruction: { parts: [{ text: "be terse" }] },
    contents: [{ role: "user", parts: [{ text: "a" }] }, { role: "model", parts: [{ text: "b" }] }, { role: "user", parts: [{ text: "c" }] }],
  }, M);
  ok(chat.messages.map((m) => m.role).join(",") === "system,user,assistant,user", "systemInstruction leads and `model` maps to `assistant`");
}
{
  const { chat } = geminiToChat({ contents: [{ role: "user", parts: [{ text: "hi" }] }], generationConfig: {
    maxOutputTokens: 64, temperature: 0.2, topP: 0.9, stopSequences: ["END"], responseMimeType: "application/json",
  } }, M);
  ok(chat.max_tokens === 64 && chat.temperature === 0.2 && chat.top_p === 0.9, "generationConfig maps onto the chat fields");
  ok(JSON.stringify(chat.stop) === '["END"]' && chat.response_format.type === "json_object", "stopSequences and a JSON responseMimeType carry through");
}
{
  const { chat } = geminiToChat({ contents: [{ role: "user", parts: [{ text: "hi" }] }], generationConfig: { responseSchema: { type: "object" } } }, M);
  ok(chat.response_format?.type === "json_schema" && chat.response_format.json_schema.schema.type === "object", "responseSchema becomes a json_schema response_format");
}
{
  const { chat, images } = geminiToChat({ contents: [{ role: "user", parts: [{ text: "what is this" }, { inlineData: { mimeType: "image/png", data: "AAA" } }] }] }, M);
  ok(images === 1 && Array.isArray(chat.messages[0].content) && chat.messages[0].content[1].image_url.url === "data:image/png;base64,AAA", "inline image data becomes a data-URI image part and is COUNTED (the clamp bills images flat)");
}
{
  const { chat } = geminiToChat({
    contents: [{ role: "user", parts: [{ text: "weather?" }] },
      { role: "model", parts: [{ functionCall: { name: "get_weather", args: { city: "NYC" } } }] },
      { role: "function", parts: [{ functionResponse: { name: "get_weather", response: { f: 70 } } }] }],
    tools: [{ functionDeclarations: [{ name: "get_weather", description: "w", parameters: { type: "object" } }] }],
    toolConfig: { functionCallingConfig: { mode: "ANY" } },
  }, M);
  ok(chat.messages[1].tool_calls[0].function.name === "get_weather" && chat.messages[1].tool_calls[0].function.arguments === '{"city":"NYC"}', "a functionCall turn becomes an assistant tool_call with JSON arguments");
  ok(chat.messages[2].role === "tool" && chat.messages[2].tool_call_id === "get_weather", "a functionResponse turn becomes a tool message keyed by the function NAME (Gemini has no call id)");
  ok(chat.tools[0].function.name === "get_weather" && chat.tool_choice === "required", "functionDeclarations become tools and mode ANY becomes tool_choice required");
}

// ---- refusals: a dropped field is a buyer believing they set something ----
throws(() => geminiToChat({ contents: [] }, M), "non-empty array", "empty contents refused");
throws(() => geminiToChat({ contents: [{ parts: [{ text: "x" }] }], safetySettings: [{}] }, M), "safetySettings", "safetySettings refused by name, not ignored");
throws(() => geminiToChat({ contents: [{ parts: [{ text: "x" }] }], generationConfig: { topK: 5 } }, M), "topK", "topK refused");
throws(() => geminiToChat({ contents: [{ parts: [{ text: "x" }] }], generationConfig: { candidateCount: 2 } }, M), "candidateCount", "candidateCount > 1 refused (it multiplies upstream cost)");
throws(() => geminiToChat({ contents: [{ parts: [{ text: "x" }] }], generationConfig: { thinkingConfig: {} } }, M), "thinkingConfig", "thinkingConfig refused with a pointer to the tiers");
throws(() => geminiToChat({ contents: [{ parts: [{ text: "x" }] }], generationConfig: { responseMimeType: "text/csv" } }, M), "responseMimeType", "an unsupported responseMimeType is refused");
throws(() => geminiToChat({ contents: [{ parts: [{ inlineData: { mimeType: "audio/mp3", data: "A" } }] }] }, M), "image/", "non-image inlineData refused");
throws(() => geminiToChat({ contents: [{ parts: [{ text: "x" }] }], tools: [{ googleSearch: {} }] }, M), "functionDeclarations", "a Google server tool is refused: this wire serves client function tools only");
throws(() => geminiToChat({ contents: [{ parts: [{ text: "x" }] }], cachedContent: "x" }, M), "cachedContent", "server-side context caching refused");

// ---- response translation ----
{
  const g = chatToGemini({ choices: [{ message: { content: "yo" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }, model: "srv" }, M);
  ok(g.candidates[0].content.role === "model" && g.candidates[0].content.parts[0].text === "yo", "content becomes a model turn with a text part");
  ok(g.candidates[0].finishReason === "STOP" && g.usageMetadata.promptTokenCount === 3 && g.usageMetadata.totalTokenCount === 5, "finishReason and usageMetadata carry Gemini's own names");
  ok(g.modelVersion === "srv", "modelVersion reports what actually served, not what was asked for");
}
{
  const g = chatToGemini({ choices: [{ message: { content: null, tool_calls: [{ function: { name: "f", arguments: '{"a":1}' } }] }, finish_reason: "tool_calls" }] }, M);
  ok(g.candidates[0].content.parts[0].functionCall.name === "f" && g.candidates[0].content.parts[0].functionCall.args.a === 1, "tool_calls become functionCall parts with parsed args");
  ok(g.candidates[0].finishReason === "STOP", "a tool-call finish is STOP on this wire, as Gemini reports it");
}
ok(chatToGemini({ choices: [{ message: { content: "x" }, finish_reason: "length" }] }, M).candidates[0].finishReason === "MAX_TOKENS", "length maps to MAX_TOKENS");
ok(chatToGemini({ choices: [{ message: { content: "x" }, finish_reason: "content_filter" }] }, M).candidates[0].finishReason === "SAFETY", "content_filter maps to SAFETY");
ok(chatToGemini({}, M).candidates[0].finishReason === "FINISH_REASON_UNSPECIFIED", "an unreadable upstream shape yields Gemini's own unspecified reason, never an invented STOP");
{
  const g = chatToGemini({ choices: [{ message: { content: "x" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2, cost: 0.004, is_byok: false } }, M);
  ok(!JSON.stringify(g).includes("0.004") && !JSON.stringify(g).includes("is_byok"), "the upstream bill never reaches the buyer through this wire");
}

// ---- metered quoting is deterministic and matches the chat wire ----
{
  const body = { contents: [{ role: "user", parts: [{ text: "hi" }] }], model: "openai/gpt-4o" };
  const a = meteredGeminiQuoteUsd(body), b = meteredGeminiQuoteUsd(body);
  ok(a.usd === b.usd && a.usd > 0, `the same body quotes the same price twice ($${a.usd})`);
  const big = meteredGeminiQuoteUsd({ contents: [{ role: "user", parts: [{ text: "word ".repeat(4000) }] }], model: "openai/gpt-4o" });
  ok(big.usd > a.usd, "a longer prompt quotes more (the price is read from the body, not the route)");
  ok(meteredGeminiQuoteUsd({ contents: [] }).invalid === true && meteredGeminiQuoteUsd({ contents: [] }).usd === TIERS["v1-chat-metered"].price,
    "an invalid body quotes the floor and never throws: the handler's own 400 refuses it, uncharged");
}
{
  // The model in the body is what the alias rewrite folds in from the path.
  const withModel = meteredGeminiQuoteUsd({ contents: [{ role: "user", parts: [{ text: "hi" }] }], model: "openai/gpt-4o" });
  const noModel = meteredGeminiQuoteUsd({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });
  ok(withModel.usd !== noModel.usd || TIERS["v1-chat-metered"].defaultModel === "openai/gpt-4o",
    "the path's model drives the quote (a different model quotes a different price)");
}

// ---- streaming is refused by name, not silently served non-streamed ----
{
  let e = null;
  try { await LLM_GEMINI_TOOLS[0].handler({ contents: [{ parts: [{ text: "x" }] }], stream: true }, null); } catch (x) { e = x; }
  ok(e && /Streaming is not served/.test(e.message), "a streaming request is refused with a pointer to a wire that streams");
}

// ---- a cross-tier error must not send a Google SDK to a wire it cannot speak ----
// Found by driving the real wire against a real upstream: asking the nano tier
// for a base-tier model answered "call /v1/chat/completions", which is correct
// about the tier and useless to a caller holding a Google client.
{
  const msg = 'Model "google/gemini-2.5-flash" is served by the v1-chat tier - call /v1/chat/completions (price $0.02/call), or /v1/metered/chat/completions (the same model, quoted per request from $0.001) instead.';
  const out = repointToGeminiWire(msg);
  ok(out.includes("/v1/gemini") && out.includes("/v1/metered/gemini"), "both chat paths are re-pointed at the same tier's Gemini route");
  ok(!out.includes("chat/completions"), "no chat path survives in a message this wire returns");
  ok(repointToGeminiWire("nothing to rewrite") === "nothing to rewrite", "a message naming no chat path is returned unchanged");
  ok(repointToGeminiWire("try /v1/grounded/chat/completions").includes("/v1/grounded/chat/completions"),
    "a tier with NO Gemini twin keeps its chat path: that is genuinely the only place the model is served");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
