// Exercise the remote MCP connector end to end over real HTTP JSON-RPC:
// initialize → tools/list → search_tools → find_tool → call_tool (free CPU
// tool, exact output) → flagship wallet-only tool by name (must refuse with
// guidance, not execute). Run against a server started with FREE_MODE or paid
// mode — the /mcp endpoint sits before the paywall either way.
import { FLAGSHIP_SLUGS, FLAGSHIP_MCP_NAMES } from "../src/mcp-flagship.js";

const BASE = process.env.TARGET_URL || "http://localhost:3000";

let nextId = 1;
async function rpc(method, params) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  const ct = (res.headers.get("content-type") || "").split(";")[0];
  if (ct === "text/event-stream") {
    const text = await res.text();
    const data = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
    return JSON.parse(data);
  }
  if (!res.ok) throw new Error(`${method} -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function assert(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`ok - ${msg}`);
}

const init = await rpc("initialize", {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "test-mcp-http", version: "0.0.0" },
});
assert(init.result?.serverInfo?.name === "agent402", `initialize returns serverInfo.name=agent402 (got ${JSON.stringify(init.result?.serverInfo)})`);
assert(
  typeof init.result?.instructions === "string" && init.result.instructions.includes("search_web") && init.result.instructions.includes("claude mcp add"),
  "initialize.instructions orients with search_web front door + install one-liners"
);

const list = await rpc("tools/list", {});
const names = (list.result?.tools ?? []).map((t) => t.name).sort();
// Flagship-first surface: meta discovery + demand SKUs. Glama's well-scoped
// band is ~3–15; keep the list tight and SWAP flagships rather than grow.
const META = [
  "search_tools", "find_tool", "call_tool", "get_payment_info",
  "about_agent402", "top_x402_sellers", "request_tool",
];
const FLAGSHIP_NAMES = FLAGSHIP_SLUGS.map((s) => FLAGSHIP_MCP_NAMES[s] || s.replace(/-/g, "_"));
const EXPECTED_LIST = [...META, ...FLAGSHIP_NAMES].sort();
assert(
  names.length === EXPECTED_LIST.length && EXPECTED_LIST.every((n) => names.includes(n)),
  `tools/list is the flagship set (got ${names.length}: ${names.join(",")}; expected ${EXPECTED_LIST.join(",")})`
);
assert(
  names.length <= 16,
  `tools/list stays flagship-sized (<=16), got ${names.length}`
);
assert(
  !names.includes("generate_hash") && !names.includes("convert_units"),
  "old free-utility curated names are no longer listed (still route as aliases)"
);
assert(
  (list.result?.tools ?? []).every((t) => t.title && typeof t.annotations?.readOnlyHint === "boolean"),
  "every tool carries a title + safety annotations (directory requirement)"
);
// Writers: request_tool (wish) + write_memory (durable state). Everything else
// is read-only so clients that trust readOnlyHint are not misled.
const writers = (list.result?.tools ?? []).filter((t) => t.annotations?.readOnlyHint === false).map((t) => t.name).sort();
assert(
  writers.length === 2 && writers.includes("request_tool") && writers.includes("write_memory"),
  `writers are request_tool + write_memory (got ${writers.join(",") || "none"})`
);

// Legacy free-utility aliases still route (not listed, but CallTool works).
for (const alias of ["convert_base64", "base64_convert", "base64"]) {
  const enc = await rpc("tools/call", { name: alias, arguments: { text: "hi", mode: "encode" } });
  const encText = enc.result?.content?.[0]?.text ?? "";
  assert(!enc.result?.isError && encText.includes("aGk="), `legacy alias "${alias}" still routes (got ${encText.slice(0, 80)})`);
}
// get_payment_info accepts its prior name too.
for (const alias of ["get_payment_info", "payment_info"]) {
  const pi = await rpc("tools/call", { name: alias, arguments: {} });
  assert(!pi.result?.isError && (pi.result?.content?.[0]?.text ?? "").includes("freeTier"), `payment info routes via "${alias}"`);
}

const privacy = await fetch(`${BASE}/privacy`);
assert(privacy.ok && (await privacy.text()).includes("Privacy policy"), "/privacy serves the policy (directory requirement)");

const search = await rpc("tools/call", { name: "search_tools", arguments: { query: "convert kilometers to miles" } });
const searchText = search.result?.content?.[0]?.text ?? "";
assert(searchText.includes("unit-convert"), "search_tools finds long-tail unit-convert");

// Front-door bias: search the web → search slug near the top.
const webSearch = await rpc("tools/call", { name: "search_tools", arguments: { query: "search the web for x402 adoption" } });
const webText = webSearch.result?.content?.[0]?.text ?? "";
assert(webText.includes('"slug": "search"') || webText.includes('"slug":"search"'), `search_tools front-door lands on search (got ${webText.slice(0, 200)})`);

// find_tool: resolve a plain-language task to a ready-to-call tool.
const find = await rpc("tools/call", { name: "find_tool", arguments: { task: "convert kilometers to miles", limit: 3 } });
const findText = find.result?.content?.[0]?.text ?? "";
assert(!find.result?.isError && findText.includes("unit-convert") && findText.includes("callWith"), "find_tool resolves a long-tail task with a ready call_tool invocation");
const findParsed = (() => { try { return JSON.parse(findText); } catch { return null; } })();
const findTop = findParsed?.results?.[0];
assert(findTop && Array.isArray(findTop.required), `find_tool top result carries required:[] (got ${JSON.stringify(findTop?.required)})`);
const findKeys = findTop ? Object.keys(findTop) : [];
assert(findKeys.indexOf("callWith") < findKeys.indexOf("description") && findKeys.indexOf("example") < findKeys.indexOf("description"), `callWith + example come before description (keys: ${findKeys.join(",")})`);

// Front-door find: "answer this question with citations" → answer
const findAnswer = await rpc("tools/call", { name: "find_tool", arguments: { task: "answer this question with citations: what is x402?", limit: 3 } });
const findAnswerText = findAnswer.result?.content?.[0]?.text ?? "";
assert(findAnswerText.includes('"slug": "answer"') || findAnswerText.includes('"slug":"answer"'), `find_tool front-door lands on answer (got ${findAnswerText.slice(0, 240)})`);

const call = await rpc("tools/call", {
  name: "call_tool",
  arguments: { slug: "unit-convert", params: { value: 42, from: "kilometers", to: "miles" } },
});
const callText = call.result?.content?.[0]?.text ?? "";
assert(!call.result?.isError && callText.includes("26.097590074"), `free CPU tool executes with exact output (got ${callText.slice(0, 120)})`);

const callStr = await rpc("tools/call", {
  name: "call_tool",
  arguments: { slug: "unit-convert", params: '{"value": 42, "from": "kilometers", "to": "miles"}' },
});
const callStrText = callStr.result?.content?.[0]?.text ?? "";
assert(!callStr.result?.isError && callStrText.includes("26.097590074"), `call_tool accepts params as a JSON string (got ${callStrText.slice(0, 120)})`);

// Flagship wallet-only by name → paid-access guidance (does not execute).
const paid = await rpc("tools/call", { name: "search_web", arguments: { q: "x402" } });
const paidText = paid.result?.content?.[0]?.text ?? "";
assert(paid.result?.isError === true, "flagship wallet-only tool (search_web) is refused on the free tier");
assert(paidText.includes("agent402-mcp") && paidText.includes("AGENT_KEY"), "refusal explains the paid path (agent402-mcp + AGENT_KEY)");
assert(!paidText.includes("<html"), "wallet-only tool did NOT execute");

// about_agent402: flagship-first copy + install one-liners; never names missing tools.
const about = await rpc("tools/call", { name: "about_agent402", arguments: {} });
const aboutText = about.result?.content?.[0]?.text ?? "";
assert(!about.result?.isError, "about_agent402 succeeds");
assert(aboutText.includes("firstJob") && aboutText.includes("search"), "about leads with search/answer front door");
assert(aboutText.includes("Havok Holdings LLC"), "about credits Havok Holdings LLC");
assert(aboutText.includes("claude mcp add") && aboutText.includes("cursorMcpJson"), "about includes install one-liners");
assert(aboutText.includes("500+"), "about uses evergreen 500+ count");
assert(!aboutText.includes("generate_hash"), "about does not advertise removed curated utilities");

console.log("\nremote MCP connector: all checks passed");
