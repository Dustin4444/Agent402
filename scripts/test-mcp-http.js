// Exercise the remote MCP connector end to end over real HTTP JSON-RPC:
// initialize → tools/list → search_tools → call_tool (free CPU tool, exact
// output) → call_tool on a wallet-only tool (must refuse with guidance, not
// execute). Run against a server started with FREE_MODE or paid mode — the
// /mcp endpoint sits before the paywall either way.
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

const list = await rpc("tools/list", {});
const names = (list.result?.tools ?? []).map((t) => t.name).sort();
// The connector exposes a deliberately TIGHT, curated surface: MCP directories
// (Glama) score a well-scoped server at 3-15 tools, and the full 500-tool
// catalog lives behind search_tools/find_tool/call_tool by design. Names are
// uniformly verb_noun (action-first) — the pattern Glama's naming-consistency
// rubric names as the target. Every prior spelling still routes.
//
// Now 17, not 15: about_agent402 and top_x402_sellers had working handlers but
// were absent from tools/list, which is the ONLY surface an MCP client can
// discover from — and the service manifest already advertised
// top_x402_sellers, so it was promised and unreachable. Listing them trades
// two tools of directory-scoring headroom for capabilities that were being
// paid for in documentation and not delivered. Keep this list tight: anything
// further belongs behind call_tool.
const EXPECTED_LIST = [
  "search_tools", "find_tool", "call_tool", "get_payment_info",
  "generate_hash", "convert_units", "generate_qr", "format_json", "decode_jwt", "convert_base64", "generate_uuid", "parse_csv", "convert_timezone",
  "get_wallet_balances", "get_wallet_transactions",
  "about_agent402", "top_x402_sellers",
].sort();
assert(
  names.length === EXPECTED_LIST.length && EXPECTED_LIST.every((n) => names.includes(n)),
  `tools/list is the curated set (got ${names.length}: ${names.join(",")})`
);
assert(
  (list.result?.tools ?? []).every((t) => t.title && t.annotations?.readOnlyHint === true),
  "every tool carries a title + read-only safety annotations (directory requirement)"
);

// Renames must never break an existing caller: the current verb_noun name, the
// 2026-07-16 noun_verb name, the toSnake form, and the raw kebab slug all route
// to the same tool. base64: convert_base64 (current) / base64_convert (prior) / base64 (slug).
for (const alias of ["convert_base64", "base64_convert", "base64"]) {
  const enc = await rpc("tools/call", { name: alias, arguments: { text: "hi", mode: "encode" } });
  const encText = enc.result?.content?.[0]?.text ?? "";
  assert(!enc.result?.isError && encText.includes("aGk="), `curated tool routes via "${alias}" (got ${encText.slice(0, 80)})`);
}
// get_payment_info accepts its prior name too.
for (const alias of ["get_payment_info", "payment_info"]) {
  const pi = await rpc("tools/call", { name: alias, arguments: {} });
  assert(!pi.result?.isError && (pi.result?.content?.[0]?.text ?? "").includes("freeTier"), `payment info routes via "${alias}"`);
}
const tz = await rpc("tools/call", { name: "convert_timezone", arguments: { datetime: "2026-06-23T14:00:00", from: "America/New_York", to: "Asia/Tokyo" } });
assert(!tz.result?.isError && (tz.result?.content?.[0]?.text ?? "").includes("Tokyo"), "convert_timezone answers its documented example");

const privacy = await fetch(`${BASE}/privacy`);
assert(privacy.ok && (await privacy.text()).includes("Privacy policy"), "/privacy serves the policy (directory requirement)");

const search = await rpc("tools/call", { name: "search_tools", arguments: { query: "convert kilometers to miles" } });
const searchText = search.result?.content?.[0]?.text ?? "";
assert(searchText.includes("unit-convert"), "search_tools finds unit-convert for a unit-conversion task");

// find_tool: resolve a plain-language task to a ready-to-call tool.
const find = await rpc("tools/call", { name: "find_tool", arguments: { task: "convert kilometers to miles", limit: 3 } });
const findText = find.result?.content?.[0]?.text ?? "";
assert(!find.result?.isError && findText.includes("unit-convert") && findText.includes("callWith"), "find_tool resolves a task with a ready call_tool invocation");
// Discovery prominence: top result carries `required` (always array) and the
// actionable fields (callWith / example / required) come before description.
const findParsed = (() => { try { return JSON.parse(findText); } catch { return null; } })();
const findTop = findParsed?.results?.[0];
assert(findTop && Array.isArray(findTop.required), `find_tool top result carries required:[] (got ${JSON.stringify(findTop?.required)})`);
const findKeys = findTop ? Object.keys(findTop) : [];
assert(findKeys.indexOf("callWith") < findKeys.indexOf("description") && findKeys.indexOf("example") < findKeys.indexOf("description"), `callWith + example come before description (keys: ${findKeys.join(",")})`);

const call = await rpc("tools/call", {
  name: "call_tool",
  arguments: { slug: "unit-convert", params: { value: 42, from: "kilometers", to: "miles" } },
});
const callText = call.result?.content?.[0]?.text ?? "";
assert(!call.result?.isError && callText.includes("26.097590074"), `free CPU tool executes with exact output (got ${callText.slice(0, 120)})`);

// LLM clients often stringify object args — params as a JSON string must still work.
const callStr = await rpc("tools/call", {
  name: "call_tool",
  arguments: { slug: "unit-convert", params: '{"value": 42, "from": "kilometers", "to": "miles"}' },
});
const callStrText = callStr.result?.content?.[0]?.text ?? "";
assert(!callStr.result?.isError && callStrText.includes("26.097590074"), `call_tool accepts params as a JSON string (got ${callStrText.slice(0, 120)})`);

const paid = await rpc("tools/call", { name: "call_tool", arguments: { slug: "render", params: { url: "https://example.com" } } });
const paidText = paid.result?.content?.[0]?.text ?? "";
assert(paid.result?.isError === true, "wallet-only tool (render) is refused on the free tier");
assert(paidText.includes("agent402-mcp") && paidText.includes("AGENT_KEY"), "refusal explains the paid path (agent402-mcp + AGENT_KEY)");
assert(!paidText.includes("<html"), "wallet-only tool did NOT execute");

// about_agent402 and top_x402_sellers were removed from the curated 15-tool
// surface (directory-legibility trim). The x402-seller leaderboard still lives
// at /api/leaderboard and /leaderboard for agents that want it.

console.log("\nremote MCP connector: all checks passed");
