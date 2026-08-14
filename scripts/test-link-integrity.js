// Site-wide link integrity: every sitemap.xml URL resolves, and every
// internal href referenced across a broad crawl of real pages resolves too
// - the second check catches links pointing somewhere NOT in the sitemap,
// which sitemap-only coverage misses entirely.
//
// Requires a booted server (same TARGET_URL convention as test-mcp-http.js /
// test-docs-truth.js):
//   FREE_MODE=true PORT=3000 node src/server.js
//   TARGET_URL=http://localhost:3000 node scripts/test-link-integrity.js
//
// Deliberately internal-only: external hrefs (github.com, solscan.io, real
// crawled third-party seller domains, ...) are collected and reported but
// never fetched - checking hundreds of third-party sites on every CI run
// would be slow and flaky for failures that are never ours to fix. A
// separate, ad-hoc pass against the live site is the right tool for that.
//
// Real bug this locks in (found 2026-08-14 via exactly this kind of sweep):
// the homepage's "for agents" machine-readable-surfaces strip rendered
// /mcp as a real <a href="/mcp">, styled identically to the three other
// links in the same row (/openapi.json, /.well-known/x402, /api/pricing) -
// which all correctly GET 200. /mcp is a stateless MCP endpoint that
// deliberately 405s on GET per spec (POST-only JSON-RPC) - correct endpoint
// behavior, wrong presentation: a prominent homepage link that always
// errors for a human click or a crawler follow. Fixed by rendering it as
// plain text (matching how the same page already shows the connector URL
// in a <pre> code block elsewhere), not a link.
import { docsSlugs } from "../src/docs.js";

const BASE = process.env.TARGET_URL || "http://localhost:3000";
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

// Chain seller-activity views (?seller=) trigger a cold, bounded on-chain RPC
// scan the first time a given wallet is looked up (src/revenue-live.js -
// every RPC call already carries its own 6-8s timeout and a maxPages/maxTx
// loop cap, so this always finishes, just sometimes slowly) - a genuinely
// slow-but-working page, not a broken link, so it gets a longer allowance
// instead of being excluded from the check entirely.
const SLOW_TIMEOUT_MS = 90000;
function timeoutFor(path) {
  return /[?&]seller=/.test(path) ? SLOW_TIMEOUT_MS : 20000;
}

async function status(path) {
  try {
    const r = await fetch(`${BASE}${path}`, { redirect: "follow", signal: AbortSignal.timeout(timeoutFor(path)) });
    return r.status;
  } catch (e) {
    return `ERR:${e.message}`;
  }
}

// --- Phase 1: sitemap.xml coverage -------------------------------------------
const sitemapXml = await (await fetch(`${BASE}/sitemap.xml`)).text();
const sitemapUrls = [...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace(/^https?:\/\/[^/]+/, ""));
ok(sitemapUrls.length > 400, `sitemap.xml lists a substantial URL set (got ${sitemapUrls.length})`);

const CONCURRENCY = 20;
async function checkAll(paths, label) {
  const broken = [];
  const queue = [...paths];
  async function worker() {
    while (queue.length) {
      const path = queue.pop();
      const s = await status(path);
      if (typeof s === "string" || s >= 400) broken.push({ path, status: s });
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  ok(broken.length === 0, `${label}: 0 broken out of ${paths.length}${broken.length ? ` - broken: ${broken.slice(0, 10).map((b) => `${b.path} (${b.status})`).join(", ")}${broken.length > 10 ? ` +${broken.length - 10} more` : ""}` : ""}`);
  return broken;
}

await checkAll(sitemapUrls, "sitemap.xml URLs all resolve");

// --- Phase 2: crawl a broad seed set, extract every unique internal href,
// verify each one resolves too (catches links to targets NOT in the
// sitemap - fragments, query-param views, anything hand-authored). --------
const seeds = [
  "/", "/what-is-x402", "/what-is-mpp", "/sell", "/tools", "/leaderboard", "/marketplace",
  "/skills", "/docs", "/docs/adapters", "/docs/webhooks", "/docs/api", "/docs/api/explorer",
  "/pricing", "/playground", "/sdk-playground", "/quickstart", "/faq", "/status", "/revenue",
  "/analytics", "/badges", "/shop", "/compare", "/community", "/contribute", "/changelog", "/blog",
  "/contact", "/privacy", "/terms", "/transparency", "/integrations", "/workflows",
  "/base", "/solana", "/polygon", "/arbitrum", "/monad", "/celo", "/avalanche", "/sei",
  "/optimism", "/stellar", "/algorand", "/robinhood",
  "/marketplace/tools", "/tools/bestsellers", "/tools/category/llm",
  "/guides", "/guides/smart-order-router", "/guides/x402-in-5-minutes",
  ...docsSlugs().slice(0, 5).map((s) => `/docs/${s}`),
];

const hrefsByPage = new Map();
await Promise.all(seeds.map(async (path) => {
  const s = await status(path);
  if (typeof s === "string" || s >= 400) { hrefsByPage.set(path, { error: s }); return; }
  const html = await (await fetch(`${BASE}${path}`)).text();
  hrefsByPage.set(path, { hrefs: [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]) });
}));

const brokenSeeds = [...hrefsByPage.entries()].filter(([, v]) => v.error);
ok(brokenSeeds.length === 0, `all ${seeds.length} seed pages load (0 broken)${brokenSeeds.length ? ` - broken: ${brokenSeeds.map(([p, v]) => `${p} (${v.error})`).join(", ")}` : ""}`);

const internalPaths = new Set();
for (const [, v] of hrefsByPage) {
  if (!v.hrefs) continue;
  for (const h of v.hrefs) {
    if (!h || h.startsWith("#") || h.startsWith("mailto:") || h.startsWith("javascript:") || h.startsWith("tel:")) continue;
    if (h.startsWith("http://") || h.startsWith("https://")) {
      if (!h.startsWith(BASE) && !h.startsWith("https://agent402.tools")) continue; // external - out of scope, see header note
      internalPaths.add(h.replace(/^https?:\/\/[^/]+/, ""));
    } else if (h.startsWith("/")) {
      internalPaths.add(h.split("#")[0]);
    }
  }
}
ok(internalPaths.size > 50, `crawl surfaced a substantial set of unique internal links (got ${internalPaths.size})`);
await checkAll([...internalPaths], "every unique internal href found across the crawl resolves");

// --- Regression: /mcp must never render as a real <a href> anywhere -----------
// The endpoint's own 405-on-GET is correct (stateless MCP server, POST-only
// per spec) - the bug was presenting it as a browsable link at all.
{
  let mcpLinked = false;
  for (const [, v] of hrefsByPage) {
    if (v.hrefs && v.hrefs.some((h) => h === "/mcp" || h === `${BASE}/mcp` || h === "https://agent402.tools/mcp")) mcpLinked = true;
  }
  ok(!mcpLinked, "/mcp (a stateless, POST-only endpoint that correctly 405s on GET) never renders as a real <a href> - shown as plain text instead, matching how the connector URL is already presented elsewhere on the page");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
