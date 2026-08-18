// The leaderboard's RPC failure messages reach the PUBLIC /api/leaderboard
// body (rpcCall throws -> refresh catches into cached.lastError ->
// getLeaderboardSnapshot() -> res.json). Its Alchemy RPC entry carries
// ALCHEMY_API_KEY in the URL PATH, and until 2026-08-18 the failure message
// interpolated the full URL — so an ordinary Alchemy outage would have
// published the key on an unauthenticated endpoint. Three sibling loops in
// this repo already redact (b20-kit, x402-kit) or name the host only
// (revenue-live laneName); this pins that leaderboard.js does too.
import { createServer } from "node:http";

let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error("FAIL:", m); process.exit(1); } };

const FAKE_KEY = "alch_LEAKCANARY_0123456789abcdef";
process.env.ALCHEMY_API_KEY = FAKE_KEY;
const { rpcCall } = await import("../src/leaderboard.js");

// Stub "Alchemy": answers a JSON-RPC error that echoes the request URL (an
// upstream can echo anything), plus a non-JSON responder, plus a dead port.
const echo = createServer((req, res) => {
  res.writeHead(429, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 429, message: `rate limited for ${req.url}` } }));
});
const junk = createServer((req, res) => { res.writeHead(502); res.end("<html>bad gateway</html>"); });
await Promise.all([new Promise((r) => echo.listen(0, r)), new Promise((r) => junk.listen(0, r))]);
const urls = [
  `http://127.0.0.1:${echo.address().port}/v2/${FAKE_KEY}`,
  `http://127.0.0.1:${junk.address().port}/v2/${FAKE_KEY}`,
  `http://127.0.0.1:1/v2/${FAKE_KEY}`, // connection refused -> thrown fetch error
];

for (const [label, rpcs] of [["json-rpc error echoing the URL", [urls[0]]], ["non-JSON body", [urls[1]]], ["fetch itself throws", [urls[2]]], ["all three", urls]]) {
  let msg = "";
  try { await rpcCall(rpcs, "eth_blockNumber", [], { passes: 1 }); } catch (e) { msg = String(e?.message || e); }
  ok(msg.startsWith("All RPCs failed for eth_blockNumber"), `${label}: rpcCall throws the failure summary`);
  ok(!msg.includes(FAKE_KEY), `${label}: the API key is NOT in the thrown message (got: ${msg.slice(0, 120)})`);
  // Our OWN naming is host-only; an upstream that echoes its request path
  // (the first stub does, on purpose) still gets its echo redacted, so the
  // path may appear there with the key replaced — the key check above is
  // the invariant, this one pins host-only naming where nothing echoes.
  if (!label.startsWith("json-rpc")) ok(!/\/v2\//.test(msg), `${label}: no URL path in the message (host-only naming)`);
}
echo.close(); junk.close();
console.log(`\nAll ${pass} assertions passed`);
