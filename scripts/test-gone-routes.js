// A route the seller retired (410 Gone) leaves the index. A registry row is
// minted by a settled payment and never retired upstream, so before this a
// seller who removed a route kept it in our listing through the Bazaar merge,
// and re-registering could not clear it. Pinned offline against a stubbed fetch:
//   1. a 410 on the row's own verb drops the row and marks it gone;
//   2. the mark keeps the next crawl's rebuild from restoring it;
//   3. a 410 on a different verb, a 404 and a 402 drop nothing;
//   4. the mark lapses after GONE_ROUTE_TTL_MS.
import assert from "node:assert/strict";
process.env.X402_INDEX_CRAWL = "off";
const { enrichLiveQuotes, dropGoneRoutes, isRouteGone, markRouteGone, _resetGoneRoutes, GONE_ROUTE_TTL_MS } = await import("../src/x402-index.js");

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); };
const ORIGIN = "https://example.com"; // resolves: the SSRF guard checks the host before the (stubbed) fetch
const accepts = { x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", payTo: "0x9fb365E4E9385E2a39FeBAd70368267e6f571d9A", amount: "1000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }] };
const header = Buffer.from(JSON.stringify(accepts)).toString("base64");
const stub = (rules) => async (url, init = {}) => {
  const u = new URL(String(url)); const m = String(init.method || "GET").toUpperCase();
  const status = rules[`${m} ${u.pathname}`] ?? 404;
  const headers = new Headers(status === 402 ? { "payment-required": header } : {});
  return new Response("{}", { status, headers });
};
const row = (route, method = "POST", extra = {}) => ({ seller: "example.com", route, method, slug: route.slice(1).replace(/\//g, "-"), price: 0.01, paid: true, networks: ["eip155:8453"], ...extra });
const logs = [];
const origLog = console.log; console.log = (...a) => { logs.push(a.join(" ")); };
const orig = globalThis.fetch;

try {
  _resetGoneRoutes();
  // --- 1. a 410 on the row's own verb drops it (re-registration makes a priced Bazaar row a candidate)
  globalThis.fetch = stub({ "POST /v1/jobs": 410, "POST /v1/web/read": 402 });
  const tools = [row("/v1/jobs"), row("/v1/web/read")];
  const same = tools;
  await enrichLiveQuotes(tools, ORIGIN, { ignoreBudget: true });
  ok(same.length === 1 && same[0].route === "/v1/web/read", `the 410 row leaves the array in place (got ${same.map((t) => t.route).join(",")})`);
  ok(isRouteGone(ORIGIN, "POST", "/v1/jobs"), "and is marked gone");
  ok(logs.some((l) => /live-410: .*\/v1\/jobs answered POST 410 Gone; dropped the row/.test(l)), "and logged");

  // --- 2. the next crawl's rebuild (the Bazaar row again) does not restore it
  globalThis.fetch = async () => { throw new Error("a marked route must not be probed"); };
  const rebuilt = [row("/v1/jobs"), row("/v1/web/read", "POST", { quoteObservedAt: Date.now() })];
  await enrichLiveQuotes(rebuilt, ORIGIN);
  ok(rebuilt.length === 1 && rebuilt[0].route === "/v1/web/read", "a rebuilt registry row for a gone route is dropped before any probe");
  ok(!isRouteGone("https://other.example", "POST", "/v1/jobs"), "the mark is per origin");
  ok(!isRouteGone(ORIGIN, "GET", "/v1/jobs"), "and per verb");

  // --- 3. nothing else drops a row
  _resetGoneRoutes();
  globalThis.fetch = stub({ "GET /v1/a": 410, "POST /v1/a": 402, "POST /v1/b": 404 });
  const others = [row("/v1/a"), row("/v1/b")];
  await enrichLiveQuotes(others, ORIGIN, { ignoreBudget: true });
  ok(others.length === 2, `a 410 on another verb and a 404 drop nothing (got ${others.length} rows)`);
  ok(!isRouteGone(ORIGIN, "POST", "/v1/a") && !isRouteGone(ORIGIN, "POST", "/v1/b"), "and mark nothing");

  // --- 4. the mark lapses
  markRouteGone(ORIGIN, "POST", "/v1/old", Date.now() - GONE_ROUTE_TTL_MS - 1000);
  const back = [row("/v1/old")];
  ok(dropGoneRoutes(back, ORIGIN) === 0 && back.length === 1, "a mark older than the TTL no longer hides the route");
  markRouteGone(ORIGIN, "POST", "/v1/old");
  ok(dropGoneRoutes(back, ORIGIN) === 1 && back.length === 0, "a fresh mark does");
} finally {
  globalThis.fetch = orig;
  console.log = origLog;
  _resetGoneRoutes();
}
console.log(`test-gone-routes: ${n} passed`);
