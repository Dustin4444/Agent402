import { toolList, CATEGORIES } from "./pages.js";
import { isComputePayable, POW_DIFFICULTY } from "./pow.js";
import { guideSlugs } from "./guides.js";
import { skillSlugs, SKILL_PACKS } from "./skills.js";
import { BLOG_POSTS } from "./blog.js";
import { ADAPTERS } from "./adapter-docs.js";
import { RAILS, RAILS_OR } from "./rails.js";
import { CHAIN_PAGES } from "./market-page.js";

export function robotsTxt(baseUrl) {
  // Explicitly welcome AI/agent crawlers and search engines; point them at the
  // machine-readable surfaces. Disallow only the wallet-scoped memory endpoints.
  const agents = [
    "GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-Web", "anthropic-ai",
    "PerplexityBot", "Google-Extended", "Googlebot", "Bingbot", "Applebot", "Applebot-Extended",
    "CCBot", "Bytespider", "Amazonbot", "cohere-ai", "Meta-ExternalAgent", "DuckDuckBot",
  ];
  const blocks = agents.map((a) => `User-agent: ${a}\nAllow: /`).join("\n\n");
  return `${blocks}

User-agent: *
Allow: /
Disallow: /api/memory

# Machine-readable catalogs for agents: ${baseUrl}/llms.txt , ${baseUrl}/openapi.json , ${baseUrl}/api/pricing , ${baseUrl}/api/cacheable , ${baseUrl}/.well-known/x402 , ${baseUrl}/api/reliability , ${baseUrl}/api/find?q={task} , ${baseUrl}/api/route , ${baseUrl}/api/leaderboard
Sitemap: ${baseUrl}/sitemap.xml
Sitemap: ${baseUrl}/sitemapindex.xml
`;
}

export function sitemapXml(baseUrl, catalog) {
  // lastmod reflects the deploy that regenerated this sitemap (the pages are
  // server-rendered, so a deploy is the freshness signal crawlers should see).
  const lastmod = new Date().toISOString().slice(0, 10);
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
    { loc: `${baseUrl}/index`, priority: "0.8" },
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
    { loc: `${baseUrl}/revenue`, priority: "0.6" },
    { loc: `${baseUrl}/blog`, priority: "0.8" },
    { loc: `${baseUrl}/compare`, priority: "0.8" },
    { loc: `${baseUrl}/community`, priority: "0.7" },
    { loc: `${baseUrl}/contribute`, priority: "0.7" },
    { loc: `${baseUrl}/workflows`, priority: "0.8" },
    { loc: `${baseUrl}/uptime`, priority: "0.6" },
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
  const lastmod = new Date().toISOString().slice(0, 10);
  const subs = ["sitemap-pages.xml", "sitemap-tools.xml", "sitemap-guides.xml", "sitemap-skills.xml"];
  const entries = subs.map((s) => `  <sitemap><loc>${baseUrl}/${s}</loc><lastmod>${lastmod}</lastmod></sitemap>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</sitemapindex>`;
}
export function sitemapPages(baseUrl, catalog) {
  const lastmod = new Date().toISOString().slice(0, 10);
  const urls = [
    { loc: `${baseUrl}/`, priority: "1.0" },
    { loc: `${baseUrl}/tools`, priority: "0.9" },
    { loc: `${baseUrl}/shop`, priority: "0.9" },
    { loc: `${baseUrl}/quickstart`, priority: "0.9" },
    { loc: `${baseUrl}/pricing`, priority: "0.8" },
    { loc: `${baseUrl}/integrations`, priority: "0.8" },
    { loc: `${baseUrl}/use-cases`, priority: "0.8" },
    { loc: `${baseUrl}/faq`, priority: "0.8" },
    { loc: `${baseUrl}/index`, priority: "0.8" },
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
    { loc: `${baseUrl}/uptime`, priority: "0.6" },
    { loc: `${baseUrl}/badges`, priority: "0.5" },
    { loc: `${baseUrl}/docs/api/explorer`, priority: "0.8" },
    { loc: `${baseUrl}/docs/adapters`, priority: "0.8" },
    { loc: `${baseUrl}/docs/webhooks`, priority: "0.7" },
    ...BLOG_POSTS.map((p) => ({ loc: `${baseUrl}/blog/${p.slug}`, priority: "0.7" })),
    ...ADAPTERS.map((a) => ({ loc: `${baseUrl}/docs/adapters/${a.slug}`, priority: "0.7" })),
    { loc: `${baseUrl}/privacy`, priority: "0.4" },
    { loc: `${baseUrl}/terms`, priority: "0.4" },
    { loc: `${baseUrl}/contact`, priority: "0.5" },
  ];
  return subSitemap(urls, lastmod);
}
export function sitemapTools(baseUrl, catalog) {
  const lastmod = new Date().toISOString().slice(0, 10);
  return subSitemap(toolList(catalog).map((t) => ({ loc: `${baseUrl}/tools/${t.slug}`, priority: "0.8" })), lastmod);
}
export function sitemapGuides(baseUrl) {
  const lastmod = new Date().toISOString().slice(0, 10);
  return subSitemap([{ loc: `${baseUrl}/guides`, priority: "0.8" }, ...guideSlugs().map((s) => ({ loc: `${baseUrl}/guides/${s}`, priority: "0.8" }))], lastmod);
}
export function sitemapSkills(baseUrl) {
  const lastmod = new Date().toISOString().slice(0, 10);
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
      if (inCat.length > 40) {
        return `## Tools — ${label}\n\n- [${inCat.length} ${label} endpoints](${baseUrl}/api/pricing): all \`GET /api/convert/{from}-to-{to}?value=N\` at ${inCat[0].price}/call; full list in the OpenAPI spec and pricing JSON`;
      }
      const items = inCat.map(
        (t) => `- [${t.name}](${baseUrl}/tools/${t.slug}): ${t.price}/call. ${t.description}`
      );
      return `## Tools — ${label}\n\n${items.join("\n")}`;
    })
    .filter(Boolean)
    .join("\n\n");

  const packItems = SKILL_PACKS
    .map((p) => `- [${p.title}](${baseUrl}/skills/${p.slug}): ${p.tagline} (\`${p.slug}\`, ${p.toolSlugs.length} tools, one x402 payment)`)
    .join("\n");

  const chainItems = Object.entries(CHAIN_PAGES)
    .map(([key, c]) => `- [${c.chainName}](${baseUrl}/${key}): ${c.asset} via ${c.facilitatorLabel} (\`${c.caip2}\`)`)
    .join("\n");

  return `# Agent402.Tools

> Pay-per-call web tools for AI agents. Call an endpoint, receive an HTTP 402 with exact payment requirements, and settle from your own wallet in USDC via the x402 protocol — or, on ${powCount} of the ${tools.length} tools, pay with proof-of-work (CPU) and skip the wallet entirely. No human, no signup, no API key: the payment is the identity. Prices $0.001–$0.02 per call.

Base URL: ${baseUrl}

**Open source and two-sided.** Agent402 is an open-source, self-hostable x402 + MCP server: ${tools.length} deterministic pay-per-call tools for agents to buy (browser rendering, web search, PDFs, OCR, images, live financial / crypto / macro data, SEC EDGAR, wallet-keyed memory), a neutral cross-seller index and on-chain leaderboard for the whole x402 ecosystem, and \`agent402-tollbooth\` for API sellers to charge AI crawlers per request. Read every line and run it yourself: https://github.com/MikeyPetrillo/Agent402

**This is machine-to-machine commerce, and you can verify it.** Run the full loop with no human and no funds — \`node scripts/demo-payment.js\` discovers the catalog, gets quoted over HTTP 402, pays with compute, and uses the result. Every USDC call settles on-chain to agent402.base.eth on Base, verifiable on Basescan; live economy stats are at ${baseUrl}/api/stats and a machine-readable reliability report (each claim with a verification URL) at ${baseUrl}/api/reliability.

**Why agents use this instead of building it themselves.** You cannot sign up for anything: the useful web hides behind signups, captchas, API keys, and credit cards, none of which an autonomous agent can obtain — every capability here needs only the credential an agent already holds (its wallet, or its CPU). Capabilities your sandbox lacks (a headless browser, network egress, durable disk) are here because agents cannot self-host them mid-task. State survives the session and even crosses owners via wallet-keyed \`/api/memory\`. One x402-wrapped fetch (or the MCP server) covers the whole catalog — deterministic outputs, flat per-call prices, tested before every deploy, billed verifiably on-chain.

**No wallet? Pay with compute (proof-of-work).** ${powCount} of the ${tools.length} tools accept a sha256 proof-of-work puzzle (a fraction of a second of CPU) instead of USDC — no money and no AI tokens (there is no LLM in the serving path). Get a challenge at \`${baseUrl}/api/pow/challenge?slug=hash\`, find an integer nonce so that \`sha256(challenge + ":" + nonce)\` has at least ${POW_DIFFICULTY} leading zero bits, then resend the request with header \`X-Pow-Solution: <token>:<nonce>\`. The network / browser / storage tools that need wallet-bound identity or live egress stay wallet-only.

**Pay with USDC (x402).** Wrap fetch with \`@x402/fetch\`, register the exact EVM scheme with your signer, and call normally — the 402 is decoded, paid, and the result returned. Settlement uses ${RAILS_OR}; gas is sponsored by the facilitator on EVM chains, so callers need only hold the stablecoin. Send an \`Idempotency-Key\` header for safe retries: replaying the same key with the same payment/PoW credential returns the original result without paying again.

## Key machine surfaces
- [/api/find](${baseUrl}/api/find): resolve a plain-language task to the best-matching tools with route, price, input schema, and a ready example (GET \`?q={task}\` or POST \`{"task":"..."}\`)
- [/api/route](${baseUrl}/api/route): Smart Order Router — rank tools across every x402 seller crawled from public registries; \`include:"external"\` excludes Agent402 for neutral cross-seller discovery
- [/api/index](${baseUrl}/api/index): JSON snapshot of every seller indexed (health, routable flag, crawl history)
- [/api/leaderboard](${baseUrl}/api/leaderboard): public on-chain ranking of x402 sellers by Base USDC settled volume (pipeline: Bazaar discovery → \`eth_getLogs\` on Base USDC → per-call ceiling filter → aggregate by payTo; params \`?sort=usd|calls\`, \`?top=N\`, \`?include=external|all\`) — same data as the MCP tool \`top_x402_sellers\` and the \`agent402-client\` SDK method \`topSellers()\`
- [/.well-known/x402](${baseUrl}/.well-known/x402): one-fetch service manifest (identity, payment options, capability map, MCP, trust signals)
- [/api/reliability](${baseUrl}/api/reliability): structured reliability / SLA report with a verification URL per claim
- [/api/pricing](${baseUrl}/api/pricing): machine-readable catalog (every endpoint, price, category, docs URL)
- [/openapi.json](${baseUrl}/openapi.json): full OpenAPI 3.1 spec with input / output schemas for every tool
- [/api/wishes](${baseUrl}/api/wishes): request a tool we do not have yet (clustered by demand; repeated asks get built)
- [/health](${baseUrl}/health): health check

## Connect via MCP
- [Hosted MCP connector](${baseUrl}/mcp): add \`${baseUrl}/mcp\` as a remote MCP server (streamable HTTP, no auth) in claude.ai, Claude Code, Cursor, ChatGPT, or VS Code — free pure-CPU tools via \`search_tools\` + \`call_tool\`, plus \`top_x402_sellers\` to discover the live x402 economy
- [agent402-mcp](https://www.npmjs.com/package/agent402-mcp): npm MCP server exposing the full catalog with payment underneath (\`AGENT_KEY\` for USDC via x402, or proof-of-work without a key)

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
- [GitHub repository](https://github.com/MikeyPetrillo/Agent402): full source, MIT, self-hostable
- [agent402-tollbooth](${baseUrl}/tollbooth): open-source, self-hostable x402 pay-per-crawl gate for your own site
- [Skill packs JSON](${baseUrl}/api/skill-packs.json): machine-readable pack index
- [Tool docs](${baseUrl}/tools): human-readable documentation per tool
- [Maintainer](https://github.com/MikeyPetrillo): Mike Petrillo, mike@agent402.tools
`;
}
