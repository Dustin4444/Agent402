// Offline test for src/gateway-settle-breaker.js and its wiring into every
// LLM gateway handler.
//
// The hole: @x402/express settles AFTER the handler, so a payment that verifies
// and then fails to settle costs us the upstream call with nothing charged. The
// breaker refuses a wallet (429) or every tier (503) BEFORE any upstream call
// once settle failures pile up, and a >= 400 cancels settlement, so nobody pays
// for the refusal. Nothing here touches the network: every fetch is a stub, and
// the stub that must NOT be reached fails the run if it is.
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";

// Thresholds are set before the module loads (it reads env at import, like
// the composite guard). Short window so expiry is testable in-process.
process.env.GATEWAY_SETTLE_BREAKER_MAX = "3";
process.env.GATEWAY_SETTLE_BREAKER_WINDOW_MS = "900";
process.env.GATEWAY_SETTLE_BREAKER_GLOBAL_MAX = "6";
process.env.POSTHOG_TEST_CAPTURE = "1";

const b = await import("../src/gateway-settle-breaker.js");
const { LLM_GATEWAY_TOOLS } = await import("../src/tools/llm-gateway-kit.js");
const { LLM_MESSAGES_TOOLS } = await import("../src/tools/llm-messages-kit.js");
const { LLM_RESPONSES_TOOLS } = await import("../src/tools/llm-responses-kit.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ADDR = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01";
const paymentHeader = (from) => Buffer.from(JSON.stringify({ payload: { authorization: { from } } })).toString("base64");
function fakeRes() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res._headers = {};
  res.getHeader = (n) => res._headers[String(n).toLowerCase()];
  res.setHeader = (n, v) => { res._headers[String(n).toLowerCase()] = v; };
  return res;
}
function fakeReq({ from = null, tempo = null, ip = "203.0.113.7", withRes = true } = {}) {
  const hdr = from ? paymentHeader(from) : null;
  const req = {
    header: (n) => (String(n).toLowerCase() === "payment-signature" ? hdr || undefined : undefined),
    headers: {}, ip,
  };
  if (tempo) req.mppTempoPayer = tempo;
  if (withRes) req.res = fakeRes();
  return req;
}

// --- key derivation: the composite guard's rule ------------------------------
ok(b.gatewaySettleBreakerKey(fakeReq({ from: ADDR })) === ADDR.toLowerCase(), "signed EVM payer is the key, lowercased");
ok(b.gatewaySettleBreakerKey(fakeReq({ tempo: "0xTempoPayer" })) === "tempo:0xTempoPayer", "a Tempo buyer keys on the tempo payer");
ok(b.gatewaySettleBreakerKey(fakeReq()) === "ip:203.0.113.7", "otherwise the client IP - nobody is unkeyed");
ok(b.gatewaySettleBreakerKey(undefined) === null && b.gatewaySettleBreakerKey({}) === null, "no request (in-process caller) -> null key");

// --- per-key counting ----------------------------------------------------------
{
  b._gatewaySettleBreakerReset();
  const K = "0xkey1";
  b.recordGatewaySettleFailure(K); b.recordGatewaySettleFailure(K);
  ok(!b.gatewaySettleBreakerBlocked(K).blocked, "two settle failures inside the window do not block");
  b.recordGatewaySettleFailure(K);
  const s = b.gatewaySettleBreakerBlocked(K);
  ok(s.blocked && s.fails === 3 && s.until > Date.now(), `the third blocks, with a lift time in the future (got ${JSON.stringify(s)})`);
  b.recordGatewaySettleSuccess(K);
  ok(!b.gatewaySettleBreakerBlocked(K).blocked, "a settled 200 clears the key at once");
  b.recordGatewaySettleFailure(null);
  ok(!b.gatewaySettleBreakerBlocked(null).blocked, "a null key is never blocked per key (it still counts globally)");
}

// --- the handler refuses BEFORE any upstream call ------------------------------
process.env.OPENROUTER_API_KEY = "test-key";
process.env.OPENAI_API_KEY = "test-key";
const realFetch = globalThis.fetch;
let fetchCalls = 0;
const okChat = (init) => {
  const body = JSON.parse(init.body);
  return { ok: true, status: 200, text: async () => JSON.stringify({ id: "gen-1", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] }), headers: { get: () => "application/json" } };
};
globalThis.fetch = async (url, init) => { fetchCalls++; return okChat(init); };
const nano = LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-chat-nano");
const chatBody = { model: "mistralai/ministral-8b-2512", messages: [{ role: "user", content: "hi" }], max_tokens: 5 };

{
  // CONTROL FIRST: with the breaker open the same stub IS reached. This is what
  // turns the refusal cases below into a mutation check - if the consult line
  // were removed from the handler, the tripped case would call fetch and fail.
  b._gatewaySettleBreakerReset();
  fetchCalls = 0;
  const req = fakeReq({ from: ADDR });
  const out = await nano.handler(chatBody, req);
  ok(out?.choices?.[0]?.message?.content === "OK" && fetchCalls === 1, "control: an unblocked wallet is served and the stubbed upstream is reached exactly once");
  ok(req.__gatewaySettleBreakerArmed === true, "the consult armed the finish listener on req.res");
}
{
  // Below the threshold: two failures, still served.
  b._gatewaySettleBreakerReset();
  const key = ADDR.toLowerCase();
  b.recordGatewaySettleFailure(key); b.recordGatewaySettleFailure(key);
  fetchCalls = 0;
  const out = await nano.handler(chatBody, fakeReq({ from: ADDR }));
  ok(out?.choices?.[0]?.message?.content === "OK" && fetchCalls === 1, "below the threshold the wallet is still served");
}
{
  // At the threshold: refused 429 before fetch. The stub here FAILS THE TEST if reached.
  b._gatewaySettleBreakerReset();
  const key = ADDR.toLowerCase();
  for (let i = 0; i < 3; i++) b.recordGatewaySettleFailure(key);
  globalThis.fetch = async () => { ok(false, "upstream was called for a blocked wallet - the breaker did not fire before spend"); throw new Error("must not be called"); };
  let err = null;
  const req = fakeReq({ from: ADDR });
  try { await nano.handler(chatBody, req); } catch (e) { err = e; }
  ok(err?.statusCode === 429, `at the threshold the chat handler refuses 429 before any upstream call (got ${err?.statusCode})`);
  ok(/failed to settle/i.test(err?.message || "") && /retry/i.test(err?.message || "") && /Nothing was charged/.test(err?.message || ""), `the refusal explains itself (got: ${String(err?.message).slice(0, 120)})`);
  ok(String(req.res.getHeader("Retry-After") || "").match(/^\d+$/), "a Retry-After header rides the refusal");
  ok(req.__gatewaySettleBreakerArmed !== true, "a refused request arms no listener (nothing to record)");

  // Every other gateway wire refuses the same wallet the same way, before fetch.
  const others = [
    ["messages", LLM_MESSAGES_TOOLS.find((t) => t.slug === "v1-chat-nano-messages"), { model: "anthropic/claude-haiku-4.5", max_tokens: 5, messages: [{ role: "user", content: "hi" }] }],
    ["responses", LLM_RESPONSES_TOOLS.find((t) => t.slug === "v1-chat-nano-responses"), { model: "openai/gpt-5-nano", input: "hi", max_output_tokens: 5 }],
    ["embeddings", LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-embeddings"), { model: "text-embedding-3-small", input: "hi" }],
    ["rerank", LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-rerank"), { query: "q", documents: ["a", "b"] }],
    ["images", LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-images"), { prompt: "a cat" }],
    ["speech", LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-audio-speech"), { input: "hello", voice: "alloy" }],
    ["metered chat", LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-chat-metered"), { model: "anthropic/claude-haiku-4.5", messages: [{ role: "user", content: "hi" }], max_tokens: 5 }],
  ];
  for (const [name, tool, body] of others) {
    ok(!!tool, `${name} tool is registered`);
    if (!tool) continue;
    let e2 = null;
    try { await tool.handler(body, fakeReq({ from: ADDR })); } catch (e) { e2 = e; }
    ok(e2?.statusCode === 429 && /failed to settle/i.test(e2?.message || ""), `${name} handler refuses the blocked wallet 429 before any upstream call (got ${e2?.statusCode}: ${String(e2?.message).slice(0, 60)})`);
  }

  // A different wallet is unaffected by one wallet's block.
  globalThis.fetch = async (url, init) => { fetchCalls++; return okChat(init); };
  fetchCalls = 0;
  const out = await nano.handler(chatBody, fakeReq({ from: "0x1111111111111111111111111111111111111111" }));
  ok(out?.choices?.[0]?.message?.content === "OK" && fetchCalls === 1, "another wallet is served while the first is blocked");
}
{
  // Window expiry re-admits.
  b._gatewaySettleBreakerReset();
  const key = ADDR.toLowerCase();
  for (let i = 0; i < 3; i++) b.recordGatewaySettleFailure(key);
  ok(b.gatewaySettleBreakerBlocked(key).blocked, "blocked right after the third failure");
  await sleep(950);
  ok(!b.gatewaySettleBreakerBlocked(key).blocked, "the block lifts once the failures age out of the window");
  fetchCalls = 0;
  const out = await nano.handler(chatBody, fakeReq({ from: ADDR }));
  ok(out?.choices?.[0]?.message?.content === "OK" && fetchCalls === 1, "and the wallet is served again");
}

// --- the global breaker --------------------------------------------------------
{
  b._gatewaySettleBreakerReset();
  for (let i = 0; i < 5; i++) b.recordGatewaySettleFailure(`0xrotating${i}`);
  ok(!b.gatewaySettleBreakerGlobalPaused().paused, "five failures across five keys: below the global threshold of six");
  b.recordGatewaySettleFailure(null);
  ok(b.gatewaySettleBreakerGlobalPaused().paused, "the sixth (any key, even unkeyed) trips the global pause");
  globalThis.fetch = async () => { ok(false, "upstream was called during the global pause"); throw new Error("must not be called"); };
  let err = null;
  const req = fakeReq({ from: "0x2222222222222222222222222222222222222222" });
  try { await nano.handler(chatBody, req); } catch (e) { err = e; }
  ok(err?.statusCode === 503 && /paused/i.test(err?.message || "") && /Nothing was charged/.test(err?.message || ""), `a fresh wallet is refused 503 during the global pause (got ${err?.statusCode}: ${String(err?.message).slice(0, 80)})`);
  let e3 = null;
  try { await nano.handler(chatBody); } catch (e) { e3 = e; }
  ok(e3?.statusCode === 503, "an in-process caller with no request is covered by the global pause too");
  const st = b.gatewaySettleBreakerStatus();
  ok(st.globalPaused === true && st.globalTrips === 1 && typeof st.globalPausedUntil === "string", `status reports the pause (got ${JSON.stringify(st)})`);
  ok(!/0x|203\.0\.113|tempo:/.test(JSON.stringify(st)), "status carries counts only - never a key, address or IP");
  await sleep(950);
  ok(!b.gatewaySettleBreakerGlobalPaused().paused, "the global pause lifts after the window");
  globalThis.fetch = async (url, init) => { fetchCalls++; return okChat(init); };
  fetchCalls = 0;
  const out = await nano.handler(chatBody, fakeReq({ from: ADDR }));
  ok(out?.choices?.[0]?.message?.content === "OK" && fetchCalls === 1, "tiers serve again after the pause");
}

// --- the finish listener reads the FINAL outcome -------------------------------
{
  b._gatewaySettleBreakerReset();
  const key = ADDR.toLowerCase();
  // Three served requests whose FINAL status is 402 (the settlement-failure
  // rewrite): each one counts, the third blocks.
  for (let i = 0; i < 3; i++) {
    const req = fakeReq({ from: ADDR });
    await nano.handler(chatBody, req);
    req.res.statusCode = 402;
    req.res.emit("finish");
  }
  ok(b.gatewaySettleBreakerBlocked(key).blocked, "three served-then-402 responses (settle failed after the handler) block the wallet");
  b._gatewaySettleBreakerReset();
  // A settle receipt saying success:false counts whatever the status says.
  {
    const req = fakeReq({ from: ADDR });
    await nano.handler(chatBody, req);
    req.res.statusCode = 200;
    req.res.setHeader("PAYMENT-RESPONSE", Buffer.from(JSON.stringify({ success: false, errorReason: "insufficient_funds" })).toString("base64"));
    req.res.emit("finish");
    ok(b.gatewaySettleBreakerBlocked(key).fails === 1, "a settle receipt with success:false counts as a failure");
  }
  // A settled 200 clears.
  {
    const req = fakeReq({ from: ADDR });
    await nano.handler(chatBody, req);
    req.res.statusCode = 200;
    req.res.emit("finish");
    ok(b.gatewaySettleBreakerBlocked(key).fails === 0, "a settled 200 clears the wallet's count");
  }
  // A handler-side 502 (never settled, not the wallet's doing) neither counts nor clears.
  {
    b.recordGatewaySettleFailure(key);
    const req = fakeReq({ from: ADDR });
    await nano.handler(chatBody, req);
    req.res.statusCode = 502;
    req.res.emit("finish");
    ok(b.gatewaySettleBreakerBlocked(key).fails === 1, "a 5xx the handler threw is neither a failure nor a success for the breaker");
  }
  // One listener per request; no res = nothing armed, no throw.
  {
    const req = fakeReq({ from: ADDR });
    ok(b.armGatewaySettleBreaker(req, key) === true && b.armGatewaySettleBreaker(req, key) === false, "a request is armed once");
    ok(b.armGatewaySettleBreaker(fakeReq({ withRes: false }), key) === false, "a request without a response object arms nothing and does not throw");
    ok(req.res.listenerCount("finish") === 1, "exactly one finish listener per request");
  }
}

globalThis.fetch = realFetch;
delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENAI_API_KEY;

// --- source pins ---------------------------------------------------------------
// The runtime checks above prove the wiring for the handlers they drive; these
// pin the PLACEMENT (first statement, before validation and any fetch) and the
// invariant the finish listener rests on: no gateway handler throws a 402 of
// its own, so a post-arm 402 is always a settlement that failed.
{
  const kit = await readFile(new URL("../src/tools/llm-gateway-kit.js", import.meta.url), "utf8");
  const msg = await readFile(new URL("../src/tools/llm-messages-kit.js", import.meta.url), "utf8");
  const rsp = await readFile(new URL("../src/tools/llm-responses-kit.js", import.meta.url), "utf8");
  const firstStatementIs = (src, sigRe) => {
    const m = src.match(sigRe);
    if (!m) return false;
    const after = src.slice(m.index + m[0].length).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//"));
    return after[0] === "gatewaySettleBreakerCheck(req);";
  };
  ok(firstStatementIs(kit, /function makeHandler\(tierSlug\) \{\n\s*return async \(input, req\) => \{/), "chat tiers: the consult is the handler's first statement");
  ok(firstStatementIs(kit, /async function embeddingsHandler\(input, req\) \{/), "embeddings: consult first");
  ok(firstStatementIs(kit, /async function rerankHandler\(input, req\) \{/), "rerank: consult first");
  ok(firstStatementIs(kit, /async function imagesHandler\(input, req\) \{/), "images: consult first");
  ok(firstStatementIs(kit, /async function speechHandler\(input, req\) \{/), "speech: consult first (the handler now takes the request the binder already passes)");
  ok(firstStatementIs(msg, /return async function messagesHandler\(input, req\) \{/), "Messages wire: consult first");
  ok(firstStatementIs(rsp, /return async function responsesHandler\(input, req\) \{/), "Responses wire: consult first");
  const throws402 = (src) => /bad\([^;]*,\s*402\s*\)/.test(src) || /statusCode\s*=\s*402\b/.test(src);
  ok(!throws402(kit) && !throws402(msg) && !throws402(rsp), "no gateway kit throws a 402 of its own - a post-arm 402 is a settlement failure, which the finish listener relies on");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
