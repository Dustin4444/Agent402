import { toolList, CATEGORIES } from "./pages.js";
import { isComputePayable, POW_DIFFICULTY } from "./pow.js";
import { guideSlugs } from "./guides.js";
import { skillSlugs, SKILL_PACKS, PACK_PRICES } from "./skills.js";
import { BLOG_POSTS } from "./blog.js";
import { ADAPTERS } from "./adapter-docs.js";
import { RAILS, RAILS_OR } from "./rails.js";
import { CHAIN_PAGES } from "./market-page.js";

// Computed ONCE when this module loads (i.e. once per deploy, since Railway
// restarts the process), not per-request. Every sitemap lastmod below reuses
// this so it genuinely reflects "the deploy that regenerated this sitemap" -
// previously each call recomputed new Date() fresh, so hitting /sitemap.xml
// on day N+1 of the same deploy claimed everything had "just changed," a
// signal crawlers learn to discount.
const BOOT_DATE = new Date().toISOString().slice(0, 10);

export function robotsTxt(baseUrl) {
  // Explicitly welcome AI/agent crawlers and search engines; point them at the
  // machine-readable surfaces. Disallow the wallet-scoped memory endpoints and
  // the token-gated operator dashboard (already 404 without the token — this
  // just keeps well-behaved crawlers from probing the path at all).
  const agents = [
    "GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-Web", "anthropic-ai",
    "PerplexityBot", "Google-Extended", "Googlebot", "Bingbot", "Applebot", "Applebot-Extended",
    "CCBot", "Bytespider", "Amazonbot", "cohere-ai", "Meta-ExternalAgent", "DuckDuckBot",
    // Smithery registry scanner (User-Agent SmitheryBot/1.0) - needs to read
    // homepage + /llms.txt for the listing backlink check; never Disallow it.
    "SmitheryBot",
  ];
  // COST, not secrecy, is why the seller-scoped market views are disallowed.
  // `/<chain>?seller=<host>` and `/api/market/<chain>/panel` run a per-wallet
  // on-chain activity scan, and on Base that scan is a PAID CDP SQL query -
  // two of them per distinct wallet. With ~2,300 indexed sellers, one crawler
  // walking the seller roster costs ~4,600 billed queries, and every crawler
  // above is explicitly welcomed. July 2026 billed 29,589 SQL queries
  // ($245.59) against roughly $50 of revenue in the same month; the seller
  // roster is the only surface that multiplies a page view by a paid query.
  //
  // The pages themselves stay indexable - only the seller-SCOPED variants are
  // disallowed, so /base, /solana and /marketplace keep all their SEO value
  // while the parameter that costs money per crawl does not.
  const costly = [
    "Disallow: /*?seller=",
    "Disallow: /api/market/",
  ].join("\n");
  const blocks = agents.map((a) => `User-agent: ${a}\nAllow: /\n${costly}`).join("\n\n");
  return `${blocks}

User-agent: *
Allow: /
Disallow: /api/memory
Disallow: /__operator
${costly}

# Machine-readable catalogs for agents: ${baseUrl}/llms.txt , ${baseUrl}/openapi.json , ${baseUrl}/api/pricing , ${baseUrl}/api/cacheable , ${baseUrl}/.well-known/x402 , ${baseUrl}/api/reliability , ${baseUrl}/api/find?q={task} , ${baseUrl}/api/route , ${baseUrl}/api/leaderboard
Sitemap: ${baseUrl}/sitemap.xml
Sitemap: ${baseUrl}/sitemapindex.xml
`;
}

export function sitemapXml(baseUrl, catalog) {
  // lastmod reflects the deploy that regenerated this sitemap (the pages are
  // server-rendered, so a deploy is the freshness signal crawlers should see).
  const lastmod = BOOT_DATE;
  const staticUrls = [
    { loc: `${baseUrl}/`, priority: "1.0" },
    { loc: `${baseUrl}/tools`, priority: "0.9" },
    { loc: `${baseUrl}/shop`, priority: "0.9" },
    // Every x402 marketplace page (one per CHAIN_PAGES entry) — new chain
    // page = new sitemap entry, zero edits here.
    ...Object.keys(CHAIN_PAGES).map((key) => ({ loc: `${baseUrl}/${key}`, priority: "0.8" })),
    { loc: `${baseUrl}/faq`, priority: "0.8" },
    { loc: `${baseUrl}/llms.txt`, priority: "0.8" },
    { loc: `${baseUrl}/openapi.json`, priority: "0.7" },
    { loc: `${baseUrl}/api/pricing`, priority: "0.7" },
    { loc: `${baseUrl}/api/find`, priority: "0.7" },
    { loc: `${baseUrl}/.well-known/x402`, priority: "0.7" },
    { loc: `${baseUrl}/api/reliability`, priority: "0.6" },
    { loc: `${baseUrl}/api/stats`, priority: "0.6" },
    // Unified marketplace surface (the old /index and /marketplaces 301 here —
    // a sitemap must never list URLs that redirect).
    { loc: `${baseUrl}/marketplace`, priority: "0.9" },
    // Third-party tool index. Listed at a lower priority than our own catalog
    // on purpose: it is other people's endpoints reproduced with their own
    // descriptions, so it should never outrank the tools we actually operate.
    { loc: `${baseUrl}/marketplace/tools`, priority: "0.6" },
    { loc: `${baseUrl}/api/index`, priority: "0.6" },
    { loc: `${baseUrl}/sell`, priority: "0.8" },
    { loc: `${baseUrl}/api/route`, priority: "0.7" },
    { loc: `${baseUrl}/leaderboard`, priority: "0.8" },
    { loc: `${baseUrl}/api/leaderboard`, priority: "0.7" },
    { loc: `${baseUrl}/analytics`, priority: "0.7" },
    { loc: `${baseUrl}/api/analytics`, priority: "0.6" },
    { loc: `${baseUrl}/api/cacheable`, priority: "0.6" },
    { loc: `${baseUrl}/api/cache-stats`, priority: "0.5" },
    { loc: `${baseUrl}/tollbooth`, priority: "0.7" },
    { loc: `${baseUrl}/tollbooth/cloud`, priority: "0.7" },
    { loc: `${baseUrl}/integrations`, priority: "0.8" },
    { loc: `${baseUrl}/pricing`, priority: "0.8" },
    { loc: `${baseUrl}/changelog`, priority: "0.7" },
    { loc: `${baseUrl}/use-cases`, priority: "0.8" },
    { loc: `${baseUrl}/quickstart`, priority: "0.9" },
    { loc: `${baseUrl}/what-is-x402`, priority: "0.9" },
    { loc: `${baseUrl}/what-is-mpp`, priority: "0.9" },
    { loc: `${baseUrl}/revenue`, priority: "0.6" },
    { loc: `${baseUrl}/blog`, priority: "0.8" },
    { loc: `${baseUrl}/compare`, priority: "0.8" },
    { loc: `${baseUrl}/community`, priority: "0.7" },
    { loc: `${baseUrl}/contribute`, priority: "0.7" },
    { loc: `${baseUrl}/workflows`, priority: "0.8" },
    { loc: `${baseUrl}/status`, priority: "0.7" },
    { loc: `${baseUrl}/badges`, priority: "0.5" },
    { loc: `${baseUrl}/sdk-playground`, priority: "0.7" },
    { loc: `${baseUrl}/docs/api/explorer`, priority: "0.8" },
    { loc: `${baseUrl}/docs/adapters`, priority: "0.8" },
    { loc: `${baseUrl}/docs/webhooks`, priority: "0.7" },
    { loc: `${baseUrl}/playground`, priority: "0.8" },
    ...BLOG_POSTS.map((p) => ({ loc: `${baseUrl}/blog/${p.slug}`, priority: "0.7" })),
    ...ADAPTERS.map((a) => ({ loc: `${baseUrl}/docs/adapters/${a.slug}`, priority: "0.7" })),
  ];
  const guideUrls = [
    { loc: `${baseUrl}/guides`, priority: "0.8" },
    ...guideSlugs().map((s) => ({ loc: `${baseUrl}/guides/${s}`, priority: "0.8" })),
  ];
  const skillUrls = [
    { loc: `${baseUrl}/skills`, priority: "0.8" },
    ...skillSlugs().map((s) => ({ loc: `${baseUrl}/skills/${s}`, priority: "0.8" })),
  ];
  const toolUrls = toolList(catalog).map((t) => ({ loc: `${baseUrl}/tools/${t.slug}`, priority: "0.8" }));
  const entries = [...staticUrls, ...guideUrls, ...skillUrls, ...toolUrls]
    .map((u) => `  <url><loc>${u.loc}</loc><lastmod>${lastmod}</lastmod><changefreq>weekly</changefreq><priority>${u.priority}</priority></url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>
`;
}

// Sitemap index — splits the single sitemap into sub-sitemaps so crawlers
// don't have to parse 1,400+ URLs in one file. /sitemap.xml stays as the
// monolith for backwards compat; /sitemapindex.xml points to the splits.
function subSitemap(urls, lastmod) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${u.loc}</loc><lastmod>${lastmod}</lastmod><changefreq>weekly</changefreq><priority>${u.priority}</priority></url>`).join("\n")}\n</urlset>`;
}
export function sitemapIndex(baseUrl) {
  const lastmod = BOOT_DATE;
  const subs = ["sitemap-pages.xml", "sitemap-tools.xml", "sitemap-guides.xml", "sitemap-skills.xml"];
  const entries = subs.map((s) => `  <sitemap><loc>${baseUrl}/${s}</loc><lastmod>${lastmod}</lastmod></sitemap>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</sitemapindex>`;
}
export function sitemapPages(baseUrl, catalog) {
  const lastmod = BOOT_DATE;
  const urls = [
    { loc: `${baseUrl}/`, priority: "1.0" },
    { loc: `${baseUrl}/tools`, priority: "0.9" },
    { loc: `${baseUrl}/shop`, priority: "0.9" },
    { loc: `${baseUrl}/quickstart`, priority: "0.9" },
    { loc: `${baseUrl}/what-is-x402`, priority: "0.9" },
    { loc: `${baseUrl}/what-is-mpp`, priority: "0.9" },
    { loc: `${baseUrl}/pricing`, priority: "0.8" },
    { loc: `${baseUrl}/integrations`, priority: "0.8" },
    { loc: `${baseUrl}/use-cases`, priority: "0.8" },
    { loc: `${baseUrl}/faq`, priority: "0.8" },
    // Unified marketplace surface (the old /index and /marketplaces 301 here).
    { loc: `${baseUrl}/marketplace`, priority: "0.9" },
    // Third-party tool index. Listed at a lower priority than our own catalog
    // on purpose: it is other people's endpoints reproduced with their own
    // descriptions, so it should never outrank the tools we actually operate.
    { loc: `${baseUrl}/marketplace/tools`, priority: "0.6" },
    { loc: `${baseUrl}/sell`, priority: "0.8" },
    { loc: `${baseUrl}/leaderboard`, priority: "0.8" },
    { loc: `${baseUrl}/docs`, priority: "0.8" },
    // Every x402 marketplace page (one per CHAIN_PAGES entry).
    ...Object.keys(CHAIN_PAGES).map((key) => ({ loc: `${baseUrl}/${key}`, priority: "0.8" })),
    { loc: `${baseUrl}/revenue`, priority: "0.6" },
    { loc: `${baseUrl}/changelog`, priority: "0.7" },
    { loc: `${baseUrl}/analytics`, priority: "0.7" },
    { loc: `${baseUrl}/tollbooth`, priority: "0.7" },
    { loc: `${baseUrl}/tollbooth/cloud`, priority: "0.7" },
    { loc: `${baseUrl}/playground`, priority: "0.8" },
    { loc: `${baseUrl}/sdk-playground`, priority: "0.7" },
    { loc: `${baseUrl}/blog`, priority: "0.8" },
    { loc: `${baseUrl}/compare`, priority: "0.8" },
    { loc: `${baseUrl}/community`, priority: "0.7" },
    { loc: `${baseUrl}/contribute`, priority: "0.7" },
    { loc: `${baseUrl}/workflows`, priority: "0.8" },
    { loc: `${baseUrl}/status`, priority: "0.7" },
    { loc: `${baseUrl}/badges`, priority: "0.5" },
    { loc: `${baseUrl}/docs/api/explorer`, priority: "0.8" },
    { loc: `${baseUrl}/docs/adapters`, priority: "0.8" },
    { loc: `${baseUrl}/docs/webhooks`, priority: "0.7" },
    ...BLOG_POSTS.map((p) => ({ loc: `${baseUrl}/blog/${p.slug}`, priority: "0.7" })),
    ...ADAPTERS.map((a) => ({ loc: `${baseUrl}/docs/adapters/${a.slug}`, priority: "0.7" })),
    { loc: `${baseUrl}/privacy`, priority: "0.4" },
    { loc: `${baseUrl}/terms`, priority: "0.4" },
    { loc: `${baseUrl}/transparency`, priority: "0.4" },
    { loc: `${baseUrl}/contact`, priority: "0.5" },
  ];
  return subSitemap(urls, lastmod);
}
export function sitemapTools(baseUrl, catalog) {
  const lastmod = BOOT_DATE;
  return subSitemap(toolList(catalog).map((t) => ({ loc: `${baseUrl}/tools/${t.slug}`, priority: "0.8" })), lastmod);
}
export function sitemapGuides(baseUrl) {
  const lastmod = BOOT_DATE;
  return subSitemap([{ loc: `${baseUrl}/guides`, priority: "0.8" }, ...guideSlugs().map((s) => ({ loc: `${baseUrl}/guides/${s}`, priority: "0.8" }))], lastmod);
}
export function sitemapSkills(baseUrl) {
  const lastmod = BOOT_DATE;
  return subSitemap([{ loc: `${baseUrl}/skills`, priority: "0.8" }, ...skillSlugs().map((s) => ({ loc: `${baseUrl}/skills/${s}`, priority: "0.8" }))], lastmod);
}

export function llmsTxt(baseUrl, catalog) {
  const tools = toolList(catalog);
  const powCount = tools.filter(isComputePayable).length;

  // The llms.txt spec (llmstxt.org) wants: an H1, one summary blockquote, then
  // free-form "info" prose (NO headings), then H2 sections whose bodies are
  // lists of `[name](url): notes` markdown links. So all narrative lives in the
  // info block (bold leads, not headings), and every `##` section below is a
  // pure link list. Per-category tool sections list each tool as a link;
  // oversized generated families collapse to one summary link.
  const toolSections = Object.entries(CATEGORIES)
    .map(([key, { label }]) => {
      const inCat = tools.filter((t) => t.category === key);
      if (!inCat.length) return "";
      // Large categories drop the DESCRIPTIONS, not the tools. Collapsing them
      // to a single summary link made 165 endpoints unfindable by name in the
      // agent-readable catalog - including tools added specifically to be
      // discoverable. Name, link and price per line keeps every endpoint
      // listed at roughly a tenth of the bytes; the pointer below still leads
      // to the full schemas.
      if (inCat.length > 40) {
        const compact = inCat.map((t) => `- [${t.name}](${baseUrl}/tools/${t.slug}): ${t.price}/call`).join("\n");
        return `## Tools - ${label}\n\n${compact}\n\n- [Full input schemas for all ${inCat.length} ${label} endpoints](${baseUrl}/api/pricing)`;
      }
      const items = inCat.map(
        (t) => `- [${t.name}](${baseUrl}/tools/${t.slug}): ${t.price}/call. ${t.description}`
      );
      return `## Tools - ${label}\n\n${items.join("\n")}`;
    })
    .filter(Boolean)
    .join("\n\n");

  // Name the CALLABLE route and the price, not just the page. An agent reading
  // llms.txt could see that a pack existed but had to make another hop to learn
  // what it cost or how to invoke it, so the one-call purchase was a paragraph
  // of prose instead of an address.
  const packItems = SKILL_PACKS
    .map((p) => {
      const price = PACK_PRICES[p.slug] ?? 0.05;
      return `- [${p.title}](${baseUrl}/skills/${p.slug}): ${p.tagline} (\`${p.slug}\`, ${p.toolSlugs.length} tools in one call: \`POST ${baseUrl}/api/skill/${p.slug}\`, $${price.toFixed(price < 0.1 ? 3 : 2)}, one x402 payment)`;
    })
    .join("\n");

  const chainItems = Object.entries(CHAIN_PAGES)
    .map(([key, c]) => `- [${c.chainName}](${baseUrl}/${key}): ${c.asset} via ${c.facilitatorLabel} (\`${c.caip2}\`)`)
    .join("\n");

  return `# Agent402.Tools

> Pay-per-call web tools for AI agents. **First job: search the web and answer questions** (\`/api/search\`, \`/api/answer\`, \`/api/search-news\`) — then the long catalog of 500+ deterministic tools via \`/api/find\`. Call an endpoint, receive an HTTP 402 with exact payment requirements, and settle from your own wallet in USDC via the x402 protocol - or, on ${powCount} of the ${tools.length} tools, pay with proof-of-work (CPU) and skip the wallet entirely. No human, no signup, no API key: the payment is the identity. Flat per-call prices from $0.001 - most tools $0.001–$0.02, with premium AI, media and multi-tool packs higher (up to $1.50); every price is in /api/pricing and quoted in the 402.

Base URL: ${baseUrl}

**Open source and two-sided.** Agent402 is an open-source, self-hostable x402 + MCP server: 500+ deterministic pay-per-call tools for agents to buy (live web search + cited answers, browser rendering, PDFs, OCR, images, live financial / crypto / macro data, SEC EDGAR, wallet-keyed memory), a neutral cross-seller index and on-chain leaderboard for the whole x402 ecosystem, and \`agent402-tollbooth\` for API sellers to charge AI crawlers per request. Positioned as the tools layer beside LLM gateways - not a competing chat router. Maintainer: Havok Holdings LLC. Read every line and run it yourself: https://github.com/MikeyPetrillo/Agent402

**This is machine-to-machine commerce, and you can verify it.** Run the full loop with no human and no funds - \`node scripts/demo-payment.js\` discovers the catalog, gets quoted over HTTP 402, pays with compute, and uses the result. Every USDC call settles on-chain to agent402.base.eth on Base, verifiable on Basescan; live economy stats are at ${baseUrl}/api/stats and a machine-readable reliability report (each claim with a verification URL) at ${baseUrl}/api/reliability.

**Why agents use this instead of building it themselves.** You cannot sign up for anything: the useful web hides behind signups, captchas, API keys, and credit cards, none of which an autonomous agent can obtain - every capability here needs only the credential an agent already holds (its wallet, or its CPU). Capabilities your sandbox lacks (a headless browser, network egress, durable disk) are here because agents cannot self-host them mid-task. State survives the session and even crosses owners via wallet-keyed \`/api/memory\`. One x402-wrapped fetch (or the MCP server) covers the whole catalog - deterministic outputs, flat per-call prices, tested before every deploy, billed verifiably on-chain.

**No wallet? Pay with compute (proof-of-work).** ${powCount} of the ${tools.length} tools accept a sha256 proof-of-work puzzle (a fraction of a second of CPU) instead of USDC - no money and no AI tokens (there is no LLM in the serving path). Get a challenge at \`${baseUrl}/api/pow/challenge?slug=hash\`, find an integer nonce so that \`sha256(challenge + ":" + nonce)\` has at least ${POW_DIFFICULTY} leading zero bits, then resend the request with header \`X-Pow-Solution: <token>:<nonce>\`. **The response has two different fields and you use both: hash the \`challenge\` (32 hex chars), submit the \`token\` (the longer signed string).** Submitting the challenge you just hashed returns a 402 that looks exactly like an unpaid request, so this is the one step worth reading twice. The network / browser / storage tools that need wallet-bound identity or live egress stay wallet-only.

**Pay with USDC (x402).** Wrap fetch with \`@x402/fetch\`, register the exact EVM scheme with your signer, and call normally - the 402 is decoded, paid, and the result returned. Settlement uses ${RAILS_OR}; gas is sponsored by the facilitator on EVM chains, so callers need only hold the stablecoin. Send an \`Idempotency-Key\` header for safe retries: replaying the same key with the same payment/PoW credential returns the original result without paying again.

**A failed call is not charged - structurally, and you can check it per response rather than trust us.** Settlement runs AFTER the tool handler and only completes for a successful (under-400) response: an error, a capacity 503, or an upstream 502 cancels settlement inside the payment middleware itself, so no money moves and there is nothing to claim.

Determine it from the response you already hold, without asking us:

- **No \`PAYMENT-RESPONSE\` header** - nothing settled. You were not charged. Safe to retry.
- **\`PAYMENT-RESPONSE\` present, receipt \`success: false\`** - settlement was attempted and REJECTED (a facilitator declining produces a 402 with this shape). You were not charged. Safe to retry with a fresh authorization.
- **\`PAYMENT-RESPONSE\` present, receipt not \`success: false\`, status under 400** - charged and served. Normal.
- **\`PAYMENT-RESPONSE\` present, receipt not \`success: false\`, status 400 or above** - the residual case: a settlement completed without a successful response. Do NOT blind-retry; this is the one shape where money may have moved without service. We count and alarm on it as an incident rather than claim it cannot happen.

Every x402 authorization is single-use, so any retry needs a fresh signature. Send an \`Idempotency-Key\` header and a retry of an already-served paid call replays the original result instead of charging again.

We state it this way deliberately: the honest guarantee is "settlement ordering makes an error non-chargeable, and here is how to verify it yourself", not "this can never happen". A contract you can check beats one you have to believe.

**MPP clients are first-class (dual-stack).** Every paid endpoint also speaks MPP (Machine Payments Protocol, the IETF-track \`Payment\` HTTP auth scheme): the same 402 carries a \`WWW-Authenticate: Payment\` challenge (evm charge, EIP-3009 USDC), \`Authorization: Payment\` credentials settle on-chain identically to x402, and settled responses return a signed \`Payment-Receipt\` header. An \`mppx\` client (\`Fetch.from\` with \`evm.charge\`) works out of the box - same URL, same price, same settlement as x402, whichever dialect your client speaks.

## Key machine surfaces
- [/api/search](${baseUrl}/api/search): **front door** - live web search (title, URL, snippet). Start here to discover pages; follow with extract or answer
- [/api/answer](${baseUrl}/api/answer): **front door** - cited answer grounded in live web search results
- [/api/search-news](${baseUrl}/api/search-news): live news search for current events / headlines
- [/api/find](${baseUrl}/api/find): resolve a plain-language task to the best-matching tools with route, price, input schema, and a ready example (GET \`?q={task}\` or POST \`{"task":"..."}\`) - long-tail discovery behind the flagships
- [/api/route](${baseUrl}/api/route): Smart Order Router - rank tools across every x402 seller crawled from public registries; \`include:"external"\` excludes Agent402 for neutral cross-seller discovery
- [/api/route/execute](${baseUrl}/api/route/execute): the SOR that also PAYS. Send a task, and Agent402 resolves the best-matching tool, pays the seller over x402 on your behalf (any proven seller in the open index, not just ours), and relays the result with a receipt - one payment, one request, one wallet. You never hold a wallet on their chain or sign up with them. \`{"task":"...","include":"external"}\`. Proportional tiers: $0.01 covers tools <= $0.005, \`/api/route/execute-plus\` at $0.05 covers <= $0.04, \`/api/route/execute-max\` at $0.55 covers <= $0.50 - an over-cap task gets a self-correcting 409 naming the tier that fits
- [/api/index](${baseUrl}/api/index): JSON snapshot of every seller indexed (health, routable flag, crawl history)
- [/api/leaderboard](${baseUrl}/api/leaderboard): public on-chain ranking of x402 sellers by Base USDC settled volume (pipeline: Bazaar discovery → \`eth_getLogs\` on Base USDC → per-call ceiling filter → aggregate by payTo; params \`?sort=usd|calls\`, \`?top=N\`, \`?include=external|all\`) - same data as the MCP tool \`sellers.list\` and the \`agent402-client\` SDK method \`topSellers()\`
- [/.well-known/x402](${baseUrl}/.well-known/x402): one-fetch service manifest (identity, payment options, capability map, MCP, trust signals)
- [/api/reliability](${baseUrl}/api/reliability): structured reliability / SLA report with a verification URL per claim
- [/api/pricing](${baseUrl}/api/pricing): machine-readable catalog (every endpoint, price, category, docs URL)
- [/openapi.json](${baseUrl}/openapi.json): full OpenAPI 3.1 spec with input / output schemas for every tool
- [/api/wishes](${baseUrl}/api/wishes): request a tool we do not have yet (clustered by demand; repeated asks get built)
- [/terms](${baseUrl}/terms): terms of service + acceptable-use policy - using the service (including programmatically) constitutes acceptance
- [/health](${baseUrl}/health): health check

## Connect via MCP
- [Hosted MCP connector](${baseUrl}/mcp): flagship-first remote MCP (search/answer/render/data/transcribe/memory + catalog.find / catalog.call for the 500+ long tail). Install one-liners:
  - Claude Code: \`claude mcp add --transport http agent402 ${baseUrl}/mcp\`
  - Cursor: add to \`~/.cursor/mcp.json\` → \`{"mcpServers":{"agent402":{"url":"${baseUrl}/mcp"}}}\`
  - Smithery: listed at https://smithery.ai/servers/mike-kq9d/agent402 (paste \`${baseUrl}/mcp\` at https://smithery.ai/new)
- [agent402-mcp](https://www.npmjs.com/package/agent402-mcp): npm MCP server with payment underneath (\`npx -y agent402-mcp\`, optional \`AGENT_KEY\` for USDC via x402). Claude Code: \`claude mcp add agent402 -s user -- npx -y agent402-mcp@latest\`

## Framework adapters (zero-dependency npm)
- [agent402-openai-tools](https://www.npmjs.com/package/agent402-openai-tools): OpenAI function-calling (chat.completions / Assistants / Responses)
- [agent402-anthropic-tools](https://www.npmjs.com/package/agent402-anthropic-tools): Anthropic Messages API \`tool_use\`
- [agent402-ai-sdk](https://www.npmjs.com/package/agent402-ai-sdk): Vercel AI SDK (\`streamText\` / \`generateText\`)
- [agent402-langchain](https://www.npmjs.com/package/agent402-langchain): LangChain JS / LangGraph
- [agent402-llamaindex](https://www.npmjs.com/package/agent402-llamaindex): LlamaIndex TS
- [agent402-google-adk](https://www.npmjs.com/package/agent402-google-adk): Google ADK (Gemini agents)
- [agent402-strands](https://www.npmjs.com/package/agent402-strands): AWS Strands agent runtime

## Skill packs (a whole job, one payment)
${packItems}

## Settlement chains
${chainItems}

${toolSections}

## Optional
- [GitHub repository](https://github.com/MikeyPetrillo/Agent402): full source, AGPL-3.0, self-hostable
- [agent402-tollbooth](${baseUrl}/tollbooth): open-source, self-hostable x402 pay-per-crawl gate for your own site
- [Skill packs JSON](${baseUrl}/api/skill-packs.json): machine-readable pack index
- [Tool docs](${baseUrl}/tools): human-readable documentation per tool
- [Maintainer](https://github.com/MikeyPetrillo/Agent402): Havok Holdings LLC, mike@agent402.tools
`;
}
