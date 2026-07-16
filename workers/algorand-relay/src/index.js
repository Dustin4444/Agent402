// algorand-relay — Cloudflare Worker that proxies Nodely's keyless Algorand
// algod + indexer APIs. Same pattern as yfinance-relay/nasdaq-relay: exists
// because Nodely 403s Railway's shared egress IP range outright (verified
// 2026-07-16 from inside the container: both mainnet-api.algonode.cloud and
// mainnet-api.4160.nodely.dev return 403 regardless of User-Agent — an
// IP-level block, and both hostnames are the same provider, so the fallback
// walk cannot recover). Routing through Cloudflare moves the egress to CF's
// IP range, which Nodely serves normally.
//
// Surface (deliberately narrow):
//   • GET only — every read the server makes is a GET; nothing else needed.
//   • Path allowlist: /algod/v2/* → algod, /idx/v2/* → indexer. Anything
//     else 403s so this Worker can't be repurposed as a generic proxy
//     (which would get Cloudflare's IPs rate-limited and break everyone).
//   • Bearer auth: Authorization: Bearer <token> must match the
//     RELAY_TOKEN Worker secret.

const ALGOD_UPSTREAM = "https://mainnet-api.4160.nodely.dev";
const INDEXER_UPSTREAM = "https://mainnet-idx.4160.nodely.dev";
const ALLOWED_PATH = /^\/(algod|idx)\/(v2\/[A-Za-z0-9/._~-]*)$/;

export default {
  async fetch(request, env) {
    if (request.method !== "GET") {
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

    const url = new URL(request.url);
    const m = ALLOWED_PATH.exec(url.pathname);
    if (!m) {
      return new Response("path not allowed (only /algod/v2/* and /idx/v2/*)", { status: 403 });
    }
    const upstreamHost = m[1] === "algod" ? ALGOD_UPSTREAM : INDEXER_UPSTREAM;

    const upstreamUrl = `${upstreamHost}/${m[2]}${url.search}`;
    let upstream;
    try {
      upstream = await fetch(upstreamUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
        redirect: "follow",
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
    out.set("X-Relay", "agent402-algorand-relay");

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: out,
    });
  },
};

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
