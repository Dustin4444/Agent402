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
// The connector exposes a deliberately TIGHT, curated 15-tool surface: MCP
// directories (Glama) score a well-scoped server at 3-15 tools, and the full
// 500-tool catalog lives behind search_tools/find_tool/call_tool by design.
// Names are uniformly two-word snake_case (Glama's naming-consistency rubric
// dinged the old base64/qr/uuid single-word mix); timezone_convert replaced
// markdown_to_html to cover the called-out date/time gap at the same count.
const EXPECTED_15 = [
  "search_tools", "find_tool", "call_tool", "payment_info",
  "hash_generate", "unit_convert", "qr_generate", "json_format", "jwt_decode", "base64_convert", "uuid_generate", "csv_to_json", "timezone_convert",
  "wallet_balances", "wallet_transactions",
].sort();
assert(
  names.length === 15 && EXPECTED_15.every((n) => names.includes(n)),
  `tools/list is the curated 15 (got ${names.length}: ${names.join(",")})`
);
assert(
  (list.result?.tools ?? []).every((t) => t.title && t.annotations?.readOnlyHint === true),
  "every tool carries a title + read-only safety annotations (directory requirement)"
);

// The 2026-07-16 renames must never break an existing caller: the new name,
// the legacy pre-rename name, and the raw kebab slug all route to the tool.
for (const alias of ["base64_convert", "base64"]) {
  const enc = await rpc("tools/call", { name: alias, arguments: { text: "hi", mode: "encode" } });
  const encText = enc.result?.content?.[0]?.text ?? "";
  assert(!enc.result?.isError && encText.includes("aGk="), `curated tool routes via "${alias}" (got ${encText.slice(0, 80)})`);
}
const tz = await rpc("tools/call", { name: "timezone_convert", arguments: { datetime: "2026-06-23T14:00:00", from: "America/New_York", to: "Asia/Tokyo" } });
assert(!tz.result?.isError && (tz.result?.content?.[0]?.text ?? "").includes("Tokyo"), "timezone_convert answers its documented example");

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
