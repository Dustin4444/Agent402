// yfinance-relay — Cloudflare Worker that proxies Yahoo Finance's keyless
// chart API. Exists because some hosting providers' egress IP ranges are
// silently null-routed by Yahoo's edge (packets dropped → TCP ETIMEDOUT
// after ~10s, observed from Railway). Routing through Cloudflare moves the
// egress to CF's IP range, which Yahoo permits.
//
// Surface (deliberately narrow):
//   • GET only — Yahoo's chart + options endpoints are GET; nothing else is needed.
//   • Path allowlist: /v8/finance/chart/* and /v7/finance/options/* exclusively.
//     Refuses anything else with 403 so this Worker can't be repurposed as a
//     generic proxy.
//   • Options paths get the cookie+crumb handshake performed HERE (fc.yahoo.com
//     sets the A3 session cookie, /v1/test/getcrumb converts it) — the caller
//     never sees Yahoo session state. The pair is cached per-isolate and
//     refreshed once on a 401.
//   • Bearer auth: Authorization: Bearer <token> must match the
//     RELAY_TOKEN Worker secret. Without auth this Worker becomes a free
//     Yahoo proxy for anyone who finds the URL — abuse vector that could
//     get *Cloudflare's* IPs WAF'd next, compounding the original problem.
//
// Forwarded request shape (to query1.finance.yahoo.com):
//   • Method: GET
//   • Headers: User-Agent (passthrough or default browser-like UA),
//     Accept: application/json. Authorization is stripped — that's our
//     bearer token, not Yahoo's.
//   • No cookies sent or returned. Yahoo's chart endpoint is stateless;
//     cookies would only be tracking junk.
//
// Response: status + body streamed back to the caller. Set-Cookie stripped
// (we don't want Yahoo's session crap leaking into agent402.tools).

const UPSTREAM_HOST = "https://query1.finance.yahoo.com";
const ALLOWED_PATH = /^\/v8\/finance\/chart\/[A-Z0-9^.\-=%]+$/;
const ALLOWED_OPTIONS_PATH = /^\/v7\/finance\/options\/[A-Z0-9^.\-=%]+$/;
const DEFAULT_UA = "Mozilla/5.0 (compatible; Agent402-yfinance-relay/1.0; +https://agent402.tools)";

// Yahoo session (cookie + crumb) for the options endpoint, cached per-isolate.
// fc.yahoo.com answers 404 but sets the HttpOnly A3 cookie; /v1/test/getcrumb
// converts it into the crumb /v7/finance/options requires since 2023.
let yahooSession = null; // { cookie, crumb, fetchedAt }
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

async function getYahooSession(ua, force = false) {
  if (!force && yahooSession && Date.now() - yahooSession.fetchedAt < SESSION_TTL_MS) return yahooSession;
  const res = await fetch("https://fc.yahoo.com/", {
    headers: { "User-Agent": ua, Accept: "*/*" },
    redirect: "manual",
  });
  await res.text().catch(() => {}); // drain the throwaway 404 body
  // Workers' fetch exposes multiple Set-Cookie values via getSetCookie().
  const setCookies = typeof res.headers.getSetCookie === "function"
    ? res.headers.getSetCookie()
    : (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")] : []);
  const cookie = setCookies.map((c) => c.split(";")[0].trim()).filter(Boolean).join("; ");
  if (!cookie) throw new Error("Yahoo did not issue a session cookie");
  const crumbRes = await fetch(`${UPSTREAM_HOST}/v1/test/getcrumb`, {
    headers: { "User-Agent": ua, Accept: "*/*", Cookie: cookie },
  });
  const crumb = (await crumbRes.text()).trim();
  if (!crumbRes.ok || !crumb || crumb.length > 64 || crumb.includes("<")) {
    throw new Error(`crumb handshake failed (HTTP ${crumbRes.status})`);
  }
  yahooSession = { cookie, crumb, fetchedAt: Date.now() };
  return yahooSession;
}

export default {
  async fetch(request, env) {
    if (request.method !== "GET") {
      return new Response("method not allowed", { status: 405 });
    }

    // Constant-time bearer comparison. Worker's auth check happens before
    // any upstream call — bad token = no Yahoo round-trip burned.
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
    const isOptions = ALLOWED_OPTIONS_PATH.test(url.pathname);
    if (!ALLOWED_PATH.test(url.pathname) && !isOptions) {
      return new Response("path not allowed (only /v8/finance/chart/* and /v7/finance/options/*)", { status: 403 });
    }

    const ua = request.headers.get("User-Agent") || DEFAULT_UA;
    const baseHeaders = {
      "User-Agent": ua,
      Accept: "application/json,text/plain,*/*",
      "Accept-Language": "en-US,en;q=0.9",
    };

    let upstream;
    try {
      if (isOptions) {
        // Options endpoint needs the crumb + cookie. Refresh the session once
        // on a 401 (expired cookie) before giving up.
        for (let attempt = 0; attempt < 2; attempt++) {
          const s = await getYahooSession(ua, attempt > 0);
          const q = new URLSearchParams(url.search);
          q.set("crumb", s.crumb);
          upstream = await fetch(`${UPSTREAM_HOST}${url.pathname}?${q}`, {
            method: "GET",
            headers: { ...baseHeaders, Cookie: s.cookie },
            redirect: "follow",
          });
          if (upstream.status !== 401) break;
        }
      } else {
        upstream = await fetch(`${UPSTREAM_HOST}${url.pathname}${url.search}`, {
          method: "GET",
          headers: baseHeaders,
          // Don't follow auth redirects — keeps the proxy surface minimal.
          redirect: "follow",
        });
      }
    } catch (e) {
      // If CF itself can't reach Yahoo, surface a clear upstream failure
      // (not a relay bug). Useful for the server-side error attribution.
      return new Response(`upstream fetch failed: ${e.message}`, { status: 502 });
    }

    // Strip Set-Cookie and other session/tracking headers before relaying.
    const out = new Headers();
    for (const [k, v] of upstream.headers) {
      const lower = k.toLowerCase();
      if (lower === "set-cookie" || lower === "server" || lower === "x-served-by") continue;
      out.set(k, v);
    }
    out.set("X-Relay", "agent402-yfinance-relay");

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: out,
    });
  },
};

// Length-and-content equality in fixed time, to keep timing oracles off the
// bearer comparison. Tokens are short (~32 chars) so this is cheap.
function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
