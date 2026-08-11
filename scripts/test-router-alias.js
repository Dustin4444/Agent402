// Unit tests for router alias collapse in the x402 Index.
//
// A retired bootstrap host that 308-redirects to the seller's real domain
// stays "healthy" forever (the crawler follows redirects and lands on the
// real manifest), duplicating every route row and doubling the operator's
// per-seller Sybil-cap slots. computeAliasOrigins flags such origins so
// routeQuery drops them; the subset-of-slugs test keeps genuinely distinct
// subdomain sellers ranking.
//
// Offline, no server, no network.
import { computeAliasOrigins, routeQuery, _cacheForTests } from "../src/x402-index.js";

const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
const ok = (c, m) => { if (!c) fail(m); };

const cache = _cacheForTests();
cache.clear();

const ctx = {
  baseUrl: "https://agent402.tools",
  catalog: {},
  prices: {},
  network: "base",
  toolCount: 0,
  walletName: "agent402.base.eth",
};

function tool(seller, slug, name = slug) {
  return { seller, method: "POST", route: `/${slug}`, slug, name, description: "url to markdown converter", category: "other", tags: [], price: 0.005 };
}
function seed(origin, homepage, slugs, { error = null } = {}) {
  cache.set(origin, {
    manifest: { name: "seller", homepage },
    tools: slugs.map((s) => tool(origin, s)),
    fetchedAt: Date.now(),
    error,
    history: [1, 1, 1, 1, 1],
  });
}

// ---- 1. redirect alias collapses; primary keeps ranking ----
seed("https://md.example", "https://md.example", ["url-to-markdown", "extract-web-data"]);
seed("https://old-host.example", "https://md.example", ["url-to-markdown", "extract-web-data"]);
{
  const aliases = computeAliasOrigins(cache);
  ok(aliases.has("https://old-host.example"), "redirect alias is flagged");
  ok(!aliases.has("https://md.example"), "self-canonical primary is not flagged");
  const r = routeQuery({ query: "url to markdown", top: 10, include: "external", ...ctx });
  const sellers = r.results.map((x) => x.seller);
  ok(sellers.includes("https://md.example"), "primary ranks");
  ok(!sellers.includes("https://old-host.example"), "alias produces no route rows");
  ok(r.sellers === 1, `alias does not count as a second seller (got ${r.sellers})`);
}

// ---- 2. subset (not just equal) tool sets still collapse ----
seed("https://old-host.example", "https://md.example", ["url-to-markdown"]);
{
  const aliases = computeAliasOrigins(cache);
  ok(aliases.has("https://old-host.example"), "stale alias with a subset of the primary's tools is flagged");
}

// ---- 3. distinct-tools subdomain is a real seller, not an alias ----
seed("https://foo.example", "https://foo.example", ["ocr-image"]);
seed("https://api.foo.example", "https://foo.example", ["translate-text"]);
{
  const aliases = computeAliasOrigins(cache);
  ok(!aliases.has("https://api.foo.example"), "subdomain with distinct tools keeps ranking");
}

// ---- 4. mutual-pointing pair collapses neither ----
seed("https://a.example", "https://b.example", ["thing"]);
seed("https://b.example", "https://a.example", ["thing"]);
{
  const aliases = computeAliasOrigins(cache);
  ok(!aliases.has("https://a.example") && !aliases.has("https://b.example"), "mutual pointers collapse neither");
}

// ---- 5. no collapse onto an errored primary ----
cache.clear();
seed("https://md.example", "https://md.example", ["url-to-markdown"], { error: "ECONNREFUSED" });
seed("https://old-host.example", "https://md.example", ["url-to-markdown"]);
{
  const aliases = computeAliasOrigins(cache);
  ok(!aliases.has("https://old-host.example"), "alias of a dead primary keeps serving buyers");
}

// ---- 6. homepage pointing at an unlisted host is not an alias ----
cache.clear();
seed("https://bar.example", "https://github.example/bar", ["thing"]);
{
  const aliases = computeAliasOrigins(cache);
  ok(aliases.size === 0, "homepage on an unlisted host never flags");
}

// ---- 7. Sybil cap: alias no longer doubles an operator's slots ----
cache.clear();
seed("https://md.example", "https://md.example", ["url-to-markdown", "url-markdown-pro"]);
seed("https://old-host.example", "https://md.example", ["url-to-markdown", "url-markdown-pro"]);
seed("https://rival.example", "https://rival.example", ["url-to-markdown-fast"]);
{
  const r = routeQuery({ query: "url to markdown", top: 3, include: "external", ...ctx });
  const perSeller = {};
  for (const x of r.results) perSeller[x.seller] = (perSeller[x.seller] || 0) + 1;
  ok(!perSeller["https://old-host.example"], "alias takes zero shortlist slots");
  ok(perSeller["https://rival.example"] >= 1, "rival gets a slot instead of the operator's duplicate");
}

// ---- 8. exact Railway deployment alias collapses onto one custom domain ----
cache.clear();
function paidTool(seller, slug, payTo, price = 0.005) {
  return {
    ...tool(seller, slug),
    price,
    networks: ["eip155:8453"],
    payToByNetwork: { "eip155:8453": payTo },
  };
}
function seedPaid(origin, slugs, payTo) {
  cache.set(origin, {
    manifest: { name: "seller", homepage: origin },
    tools: slugs.map((slug) => paidTool(origin, slug, payTo)),
    fetchedAt: Date.now(),
    error: null,
    history: [1, 1, 1, 1, 1],
  });
}
const sharedPayee = `0x${"1".repeat(40)}`;
seedPaid("https://agents.example.com", ["offer-preflight", "audit"], sharedPayee);
seedPaid("https://seller-production.up.railway.app", ["offer-preflight", "audit"], sharedPayee);
{
  const aliases = computeAliasOrigins(cache);
  ok(aliases.has("https://seller-production.up.railway.app"), "exact Railway deployment origin is flagged");
  ok(!aliases.has("https://agents.example.com"), "durable custom origin keeps ranking");
  const r = routeQuery({ query: "url to markdown", top: 10, include: "external", ...ctx });
  ok(!r.results.some((x) => x.seller === "https://seller-production.up.railway.app"), "Railway duplicate produces no route rows");
}

// ---- 9. same wallet or same routes alone never collapse a real service ----
cache.clear();
seedPaid("https://agents.example.com", ["offer-preflight", "audit"], sharedPayee);
seedPaid("https://different-production.up.railway.app", ["offer-preflight", "distinct"], sharedPayee);
seedPaid("https://other-production.up.railway.app", ["offer-preflight", "audit"], `0x${"2".repeat(40)}`);
{
  const aliases = computeAliasOrigins(cache);
  ok(!aliases.has("https://different-production.up.railway.app"), "shared payee with distinct tools stays independent");
  ok(!aliases.has("https://other-production.up.railway.app"), "identical tools with a distinct payee stay independent");
}

cache.clear();
console.log("router-alias tests passed");
