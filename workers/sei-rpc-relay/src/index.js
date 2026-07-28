// sei-rpc-relay — Cloudflare Worker that proxies Sei's public EVM JSON-RPC.
// Same reason as algorand-relay/yfinance-relay: evm-rpc.sei-apis.com serves
// residential clients fine but errors every eth_getLogs from Railway's shared
// egress IP range (verified 2026-07-28: 28/28 scan windows failed from prod
// while the identical query succeeded from a residential IP), and the only
// public alternative archive-gates getLogs outright. Routing through
// Cloudflare moves the egress to CF's IP range.
//
// Surface (deliberately narrow):
//   • POST / only — JSON-RPC rides POST; nothing else is needed.
//   • Single requests only (no batches) with a READ-ONLY method allowlist,
//     so this Worker can never be repurposed as a tx-broadcast proxy or a
//     generic tunnel (which would get CF's IPs rate-limited and break everyone).
//   • Bearer auth: Authorization: Bearer <token> must match the RELAY_TOKEN
//     Worker secret.
//   • 16 KB body cap — the server's scan requests are a few hundred bytes.

const UPSTREAM = "https://evm-rpc.sei-apis.com";
const ALLOWED_METHODS = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_getLogs",
  "eth_getBlockByNumber",
  "eth_getBalance",
  "eth_chainId",
  "net_version",
]);
const MAX_BODY_BYTES = 16 * 1024;

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }
    const expected = env.RELAY_TOKEN;
    if (!expected) {
      return new Response("relay not configured", { status: 503 });
    }
    const auth = request.headers.get("Authorization") || "";
    const got = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!constantTimeEqual(got, expected)) {
      return new Response("unauthorized", { status: 401 });
    }

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return new Response("body too large", { status: 413 });
    }
    let body;
    try { body = JSON.parse(raw); } catch {
      return new Response("invalid JSON", { status: 400 });
    }
    if (Array.isArray(body)) {
      return new Response("batch requests not allowed", { status: 403 });
    }
    if (!ALLOWED_METHODS.has(body?.method)) {
      return new Response(`method not allowed (read-only allowlist)`, { status: 403 });
    }

    let upstream;
    try {
      upstream = await fetch(UPSTREAM, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: raw,
      });
    } catch (e) {
      return new Response(`upstream fetch failed: ${e.message}`, { status: 502 });
    }

    const out = new Headers();
    for (const [k, v] of upstream.headers) {
      const lower = k.toLowerCase();
      if (lower === "set-cookie" || lower === "server" || lower === "x-served-by") continue;
      out.set(k, v);
    }
    out.set("X-Relay", "agent402-sei-rpc-relay");

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: out,
    });
  },
};

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const len = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}
