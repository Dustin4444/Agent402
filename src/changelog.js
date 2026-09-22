import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

const ENTRIES = [
  {
    date: "2026-09-22",
    title: "Five explorer-backed tools retired, and token-risk reads its facts from keyless probes",
    items: [
      "contract-inspect, address-profile, token-info, token-holders and tx-inspect are retired. Each route answers 410 naming its replacement where there is one: contract-inspect to contract-source, address-profile to wallet-balance, token-info to token-metadata, tx-inspect to tx-receipt. token-holders names none, because nothing in the catalog reads a holder list for an arbitrary token.",
      "token-risk and token-risk-pro read every token fact from keyless probes instead: name, symbol, supply, holder count and the top holders with their share come from the token-security probe, the market from the deepest DEX pair that has the token as its base, and source verification from Sourcify. The advertised chains are now exactly the ones that probe serves, so celo is gone and bsc arrives.",
      "A token-security source that does not answer (a rate limit, an upstream error, a timeout) refuses 502 or 503 saying so, rather than a 422 telling the buyer to check an address that is correct. Nothing is charged either way.",
      "The /api/chain/proxy verb is gone with the tool it pointed at; chain-storage reads the same implementation slot by its key. Every other verb in the namespace still resolves.",
    ],
  },
  {
    date: "2026-09-21",
    title: "Typed judgments, a router that says who it is, and a leaderboard that reads the seller's own prices",
    items: [
      "POST /v1/judge ($0.001): a typed judgment over supplied state - a choice from your named options with a probability for each, a position on levels you describe, or a yes/no as a probability. Model-backed, declared as such, input bounded by bytes so the worst case is knowable before the call.",
      "The router identifies itself on every paid call it makes on a buyer's behalf: User-Agent Mozilla/5.0 (compatible; Agent402-Router/1.0; +https://agent402.tools/crawler) and X-Agent402-Via: router; /crawler documents both.",
      "A seller origin on a non-default port is accepted at x402 registration, MPP registration and MPP discovery, and the port is carried through every later fetch.",
      "Seller leaderboard: a transfer that matches a price the seller publishes counts as a settlement above the flat $0.75 ceiling, up to a $25 price-match ceiling; rows carry settlementsAbovePerCallCeiling and transfersSkippedOverCeiling, and GET /api/leaderboard accepts ?limit= as an alias of ?top=.",
      "priceKnown on every /api/index seller row, /api/route row and seller detail: whether the published price could be read as a number. priceUsd is unchanged.",
      "unit-convert accepts the other spelling of a unit (plural or singular, British spellings, spaces, the statute- prefix); an unknown unit is still a 400.",
      "Heading order fixed on /reports, /monitors, /quickstart and /transparency; /leaderboard no longer prints the same figure twice; about 6 KB of repeated nav style removed from every page.",
    ],
  },
  {
    date: "2026-09-20",
    title: "Equities on a licensed feed, five tools and a pack retired, credits sales paused",
    items: [
      "stock-quote and stock-history read Databento DBEQ.BASIC (four venues, consolidated per session): volume is reported as venueVolume, stock-history takes up to 250 sessions, and the 52-week high/low fields are gone. options-chain, premarket-quote, stock-dividends, earnings-calendar, dividend-calendar and the market-open skill pack are removed.",
      "Prepaid card credits are no longer sold; existing keys keep redeeming.",
      "Google's native generateContent wire on every gateway tier; POST /v1/audio/transcriptions (OpenAI transcription wire, multipart); service_tier \"priority\" on the pro and premium tiers at 2x list.",
      "New tools: perp-dexs, perp-dex-markets and perp-dex-limits (Hyperliquid HIP-3 dexs); kalshi-live-data and kalshi-weather-index; edgar-13f-datasets ($0.003) and edgar-13f-dataset-head ($0.005). sol-token-holders restored.",
      "CORS on the machine surfaces (/api/, /v1/, /mcp, /.well-known/, /openapi.json, /llms.txt) with the payment headers exposed; an under-funded buyer's 402 points at what its balance covers; input aliases for 20 more required parameter names.",
      "An A2A AgentCard at /.well-known/agent-card.json and the ERC-8004 registration file at /.well-known/agent-registration.json.",
    ],
  },
  {
    date: "2026-09-18",
    title: "Settlement evidence read from the chain on every rail we pay on, an identity of our own, and a monthly view",
    items: [
      "Settlement evidence no longer depends on a third party's registry. The Base scan seeds its wallet list from our OWN crawl as well as Coinbase's Bazaar: an origin we indexed ourselves, payTo read from its own live 402, could settle any volume on chain and stay settled:null, which the router reads as settlement_required forever. Reported by a seller whose payTo appears in none of the 15,636 Bazaar rows. It stays a seed and never evidence - the chain decides what settled, and the payTo binding that stops a seller inheriting another wallet's volume is untouched",
      "Algorand was the same shape and worse: its candidates AND its proof both came from one facilitator catalog, so a seller we crawled ourselves was not even a candidate. Candidates now come from our index and proof from the chain (inbound USDC-ASA transfers to the payTo the seller advertises, self-transfers excluded), and a crawl-only route enters unproven so the router's floor still refuses it. Solana and Tempo already read their own chains, so all four chains we can spend on now prove settlement from the chain",
      "Two seller-facing fixes, both found by sellers: the index detail view echoes a seller's own description and tags, so the surface you check after editing your OpenAPI can actually confirm the edit landed; and re-registering an origin re-reads its documents instead of only re-pricing, clearing that origin's crawl backoff and our cached validators first",
      "An A2A AgentCard of our own at /.well-known/agent-card.json and /.well-known/agent.json, judged by the same validator we sell as a tool. It declares HTTP+JSON rather than the spec's default JSONRPC, because that default implies a JSON-RPC endpoint we do not run, and its capability flags are false rather than aspirational",
      "An ERC-8004 identity: agent 94639 on Base, owned by the wallet our 402s name as payTo, pointing at /.well-known/agent-registration.json. The file carries every way to reach us with x402Support declared, and no supportedTrust, because without it the standard is discovery only and discovery is all we are claiming",
      "/revenue takes a Monthly bucket beside Daily and Weekly. Dollars and transaction counts fold client-side; buyers do not, because a distinct count is not additive - a buyer paying on the 3rd and the 20th is one monthly buyer - so the month's union is computed server-side like the weekly one",
    ],
  },
  {
    date: "2026-09-18",
    title: "@x402 2.26 with our own boot handshake, Astra and Fable on premium, effort on the Messages wire, and a router that indexes",
    items: [
      "@x402/* 2.22.0 -> 2.26.0 on the server, the Stellar facilitator and agent402-mcp: the vendor client's spend controls (a $1 pegged-assets cap, default on since 2.23) are switched off on every client we build because our own bounds already hold the line (the buyer's maxAtomic re-check, the spend guard, the canary legs), and the facilitator handshake is driven by src/x402-boot-init.js so a facilitator that is dead at boot leaves paid routes answering 500 until a retry succeeds instead of exiting the process; every buyer workflow's client pin moved with it",
      "@solana/kit 5.5.1 -> 8.3.0 (token 0.16.1, compute-budget 0.18.1) with overrides for @x402/svm's kit-5-peered program packages, pinned against svm's own import list",
      "Premium tier admits openai/gpt-6-astra and anthropic/claude-fable-5.1 ($10/$50 headline, 1M context, reasoning mandatory); MODEL_COST rows now carry the dearest default-tier endpoint a call can route to rather than the catalog headline (gpt-5.6-sol's regional endpoints bill 2.75x its headline); the live model guard reads every admitted model's endpoint list and fails on any tier default or OpenClaw primary pick that carries an expiration date upstream",
      "Messages wire: top-level effort (low to max) on Claude 4.7+, validated against the model's own effort list; speed other than standard refused (the priority endpoint bills 2x list); Fable 5.1 refuses a forced tool_choice with the fix named; GPT-6 Astra refuses temperature and top_p instead of the upstream dropping them silently",
      "transcribe moved off gpt-4o-mini-transcribe onto gpt-transcribe ahead of its 2027-02-26 shutdown, cap 5 -> 4 minutes so the worst case stays under 70% of the price; the two tiers now differ only in cap and price",
      "Settle fallback: Solvador first on the networks it advertises (free tier), then PayAI (gas x 1.3 in prepaid credits), Solvador as the last resort elsewhere",
      "/api/route answers from a candidate index instead of a full scan of the seller pool (ranking byte-identical to the full scan on a prod-sized golden); the crawler reads every OpenAPI payment-annotation dialect through one reader; Polymarket price history on the Data API; Exa categories validated against the current list (retired names refused, research paper -> publication)",
      "agent402-mcp 0.13.2, agent402-openclaw 0.4.3 (gemini-2.5-flash left the preferred primaries: it carries an upstream expiration date), elizaos-plugin-agent402 0.2.3, agent402-agentkit 0.1.3; base image on Node 22.23.2 (the 2026-07-29 security release); every workflow runner pinned to ubuntu-24.04",
    ],
  },
  {
    date: "2026-09-02",
    title: "Typed 402s, tokenized assets, MPP on the edge, and two alarms that stopped lying",
    items: [
      "Every 402 now carries the typed output schema as accepts[0].outputSchema (one copy, first accept) as well as in the bazaar extension; our own MPP shim and mppx's x402 codec both strip undeclared fields from the echoed accept, so the match seam restores the advertised schema onto a stripped echo - a stock x402 client, a native MPP buyer and an mppx x402 buyer all still settle",
      "Five tokenized real-world-asset tools on the CoinGecko key we already hold: rwa-list, rwa-markets, rwa-asset, rwa-issuers, rwa-issuer - 649 tokenized stocks, ETFs and commodities with onchain market data and the 33 issuers behind them ($0.003 to $0.006)",
      "agent402-tollbooth 0.10.0: the edge build (Workers, Next.js edge, Deno, Bun) takes MPP through the same verifyX402 callback - a WWW-Authenticate: Payment challenge beside the x402 quote, HMAC- and resource-bound credentials translated to PAYMENT-SIGNATURE; the wire codec is a runtime-agnostic module shared with the Node build",
      "/api/route rows: executeVia appears only on rows the router will pay now (executeViaCallableNow); non-eligible rows carry executeViaWhenEligible; every row and index seller carries routerDispatchEligible and routerDispatchReason, and a manifest-priced route is read live once and then weekly so the chains its 402 offers reach the row even when the seller's manifest lags",
      "Tempo subscriptions: a renewal that fails on a slow RPC retries in minutes, not an hour, and a send that timed out is settled by reading the chain (the transfer's memo is bound to the subscription and period) before anything is signed again - never a second charge for a landed transfer",
      "mppx 0.9.2; a refused MCP credential answers the spec's -32043 (unpaid stays -32042); gpt-4.1-nano and the openai/o4 prefix retired ahead of OpenAI's dates (gpt-5.6-luna is the nano default, gpt-5-nano stays, gpt-5.6-terra on premium); /v1/images/fast fails over to gpt-5-image-mini",
      "Solana seller leaderboard scanned incrementally (one signatures read per payTo per cycle, cursor + dedupe), Base chain-truth on a refused payment (EIP-3009 nonce state), in-flight report composites cut off on SIGTERM so a deploy never spends and then discards, every skill pack runs every tool it advertises, feed-watch walks the newest feed items",
      "Two alarms fixed at the source: the Postgres reachability check no longer confirms a failure against its own 60 s cache (a failed reading is re-pinged), and the daily paid canary now proves the Tempo subscription rail after a deploy; fast-uri 3.1.7 and qs 6.16.0 overrides clear four same-day CVEs and three Dependabot alerts",
    ],
  },
  {
    date: "2026-08-26",
    title: "Why pay here, settle-actual for every buyer, and a client that routes",
    items: [
      "agent402-client 0.8.2: the User-Agent header now carries the package version and the test pins it to package.json so it cannot drift again (0.8.1 still sent 0.7.0). Contributed by epistemedeus (PR #985).",
      "agent402-client 0.8.1: route(task, { k, include, network }) ranks tools across the host's current x402/MPP index over the free /api/route, read-only and wallet-free, with executeVia tier hints for route-execute. Contributed by epistemedeus (PR #974).",
      "/why: seven first-party differences, each linked to the surface that proves it; the same points in /llms.txt, the MCP instructions, the README and the OpenClaw guide",
      "Metered gateway: credits and card buyers settle actual usage x 1.15 like upto buyers; agent402-openclaw 0.3.x pays upto when the wallet holds a Permit2 allowance (permit2-approve), proven daily by the canary's metered-upto leg; the quote is priced from the same object the handler serves",
      "Stellar facilitator: second and third Soroban RPC on transport failures, OpenZeppelin as settle fallback",
      "Report inputs: XBRL operating-to-net bridge and verbatim filing excerpts in the dossier, 13F amendments folded, Schedule 13G holders, derivative Form 4s, GoPlus and DexScreener in token risk, DNS posture and recursive SPF in domain audits, page bodies and a citation audit in research; LinkedIn article package with LinkedIn-sized images",
      "Wiki accuracy pass across 19 pages, generated from the live catalog and product tables",
    ],
  },
  {
    date: "2026-08-18",
    title: "Agentic Finance, the MPP leaderboard, and a tollbooth that settles from env",
    items: [
      "Positioned under Agentic Finance: /agentic-finance defines the category (DefinedTerm + FAQ structured data), /glossary is one canonical DefinedTermSet for the vocabulary (x402, MPP, 402, facilitator, EIP-3009, receipts, settlement, rails, dual-stack, PoW tier, SOR, tollbooth), and /blog/what-is-agentic-finance-aifi is the long form",
      "MPP leaderboard on /mpp-marketplace: verified MPP sellers ranked by inbound USDC.e transfers on Tempo to the recipient their live challenge names, read from the chain by us (window, rolling 7d/30d, distinct payers, volume; routable rows are the ones the router will pay). Machine-readable at /api/mpp-index and /api/mpp-leaderboard",
      "Smart Order Router pays MPP sellers on Tempo (chain-matched: an MPP/tempo buyer's payment funds a Tempo purchase), gated up front by that leaderboard and at pay time by on-chain proof",
      "Native MPP settlement on Tempo (tempo/charge via Tempo's relay) alongside the Base/Celo evm method; TEMPO_CURRENCY accepts a CSV of currencies",
      "agent402-tollbooth 0.8.0: the reverse-proxy CLI settles x402 AND MPP from env alone (TOLLBOOTH_PAYTO + TOLLBOOTH_FACILITATOR_URL); 0.7.0 added the x402: middleware mode that settles after the handler and MPP on the same 402",
      "agent402-client pays MPP sellers with a stock mppx fetch; every package and identity surface names both wires",
    ],
  },
  {
    date: "2026-07-24",
    title: "MPP dual-stack - every endpoint speaks two payment protocols",
    items: [
      "Every paid endpoint now answers MPP (Machine Payments Protocol, the IETF-track Payment HTTP auth scheme) alongside x402, from the same URL at the same price",
      "402 responses carry a WWW-Authenticate: Payment challenge (EIP-3009 USDC on Base and Celo); Authorization: Payment credentials settle identically to x402; settled responses return a signed Payment-Receipt",
      "Proven live daily: the paid canary buys over the native MPP wire on Base and Celo, receipts on-chain",
      "Listed on MPPScan; /openapi.json now serves MPP discovery metadata (per-operation offers + service info)",
      "MPP adoption is public: toolCallsServed.viaMPPWire at /api/stats",
      "HEAD requests on paid routes now return the same 402 challenges as GET",
      "Explainer: what-is-x402 now covers how x402 and MPP compare",
    ],
  },
  {
    date: "2026-07-23",
    title: "Smart Order Router - Algorand external settlement",
    items: [
      "POST /api/route/execute now settles on the buyer's chain: Algorand buyers are routed to proven AVM sellers and pay in USDC on Algorand",
      "Algorand payment validity windows are checked before execution, so slower tools can't strand a payment",
    ],
  },
  {
    date: "2026-07-21",
    title: "Smart Order Router - external execution",
    items: [
      "POST /api/route/execute ($0.01) can buy from external x402 sellers on the buyer's behalf: one payment in, result plus receipt out",
      "Only sellers with verified on-chain settlement history are eligible - unproven or unhealthy sellers are never routed to",
    ],
  },
  {
    date: "2026-07-20",
    title: "On-chain intelligence tools + Celo rail",
    items: [
      "contract-inspect ($0.005) and address-profile ($0.005): verified contract source, ABI, and address token/transaction profiles across major EVM chains",
      "USDC on Celo joins the accepted settlement rails",
    ],
  },
  {
    date: "2026-07-17",
    title: "More settlement rails - USDG on Robinhood Chain, USDC on Avalanche",
    items: [
      "USDG (Global Dollar) on Robinhood Chain accepted for every paid endpoint",
      "USDC on Avalanche accepted for every paid endpoint",
      "Every rail is exercised by a daily paid canary with real settlements",
    ],
  },
  {
    date: "2026-07-16",
    title: "Text-to-speech returns to the /v1 gateway",
    items: [
      "/v1/audio/speech ($0.06): OpenAI TTS wire format, mp3/pcm output, 2k-character cap",
      "Served by a five-model failover chain - a provider outage never becomes the buyer's error",
      "OpenAI voice names map automatically; native voice ids listed on /v1/models",
    ],
  },
  {
    date: "2026-06-24",
    title: "LLM vision, structured output, and content moderation",
    items: [
      "Vision: send up to 2 image URLs to any LLM tier - screenshot analysis, chart reading, image Q&A",
      "Structured output: response_format with json_object or json_schema for schema-enforced JSON",
      "Content moderation: /api/moderate ($0.002) - check text for harmful content across 13 categories",
      "All guardrails enforced server-side: image count limits, schema size caps, data: URI blocking",
    ],
  },
  {
    date: "2026-06-24",
    title: "Full AI suite - TTS, STT, embeddings via x402",
    items: [
      "Text-to-speech: /api/tts ($0.05) and /api/tts-hd ($0.10) - 10 voices, 6 audio formats",
      "Speech-to-text: /api/transcribe ($0.03) and /api/transcribe-pro ($0.10) - URL-based audio input",
      "Embeddings: /api/embed ($0.005) and /api/embed-large ($0.01) - 1536 or 3072 dimensions for RAG and search",
      "No API key needed - pay per call with USDC on Base, Solana, Polygon & Arbitrum",
      "Self-hosters: bring your own upstream key to run these for free",
    ],
  },
  {
    date: "2026-06-24",
    title: "Code execution sandbox - Python/JS via x402",
    items: [
      "Run Python or JavaScript in isolated cloud sandboxes: /api/code-run ($0.02) and /api/code-run-pro ($0.05)",
      "Returns stdout, stderr, expression result, and error traceback",
      "Pro tier: 60s timeout and 50k char code limit for longer computations",
      "Each call runs in a fresh, isolated VM - nothing persists between calls",
    ],
  },
  {
    date: "2026-06-24",
    title: "Image generation gateway - 3-tier GPT Image via x402",
    items: [
      "Generate images: /api/image-gen ($0.03), /api/image-gen-hd ($0.10), /api/image-gen-premium ($0.30)",
      "Text-to-image - no API key needed, pay per call, returns base64 PNG",
      "Three quality tiers from fast drafts to high-fidelity output",
    ],
  },
  {
    date: "2026-06-24",
    title: "LLM proxy gateway - 3-tier inference via x402",
    items: [
      "Chat completions: /api/llm ($0.01), /api/llm-pro ($0.10), /api/llm-premium ($0.50)",
      "OpenAI-format interface - no API key needed, pay per call",
      "Models: GPT-4o-mini, GPT-4o, GPT-4.1, o3, o3-mini",
    ],
  },
  {
    date: "2026-06-23",
    title: "Reliability improvements and observability",
    items: [
      "Per-tool analytics: every call now tracked with latency, cache, and error metrics",
      "Improved upstream reliability for finance and government data tools",
      "Automatic retry on transient network failures for market data endpoints",
    ],
  },
  {
    date: "2026-06-23",
    title: "Developer experience and SEO improvements",
    items: [
      "Proper caching headers on static and discovery routes for faster loads",
      "/health endpoint now reports tool count, uptime, and mode",
      "Expanded sitemap with blog posts, adapter docs, and webhook pages",
      "Wiki and docs navigation updated with new developer resources",
    ],
  },
  {
    date: "2026-06-23",
    title: "Crypto-hash, string, and calendar kits - 15 new tools",
    items: [
      "Crypto-hash kit: PBKDF2, scrypt, HKDF, constant-time compare, CRC32/Adler32 checksums",
      "String kit: Jaccard similarity, case conversion, fuzzy matching, character frequency, word wrap",
      "Calendar kit: ISO week numbers, leap year check, Easter date, epoch conversion, day-of-year",
      "Google ADK adapter published - agent402-google-adk on npm",
    ],
  },
  {
    date: "2026-06-22",
    title: "Validation, encoding, and math kits - 15 new tools",
    items: [
      "Validation kit: phone formatting, XML validation, CSV linting, base detection, IPv6 expansion",
      "Encoding kit: Punycode, NATO phonetic, Soundex, binary-text, Braille conversion",
      "Math kit: Roman numerals, Fibonacci, primality check, GCD/LCM, number base conversion",
    ],
  },
  {
    date: "2026-06-21",
    title: "Decode-blob and trend-analysis skill packs",
    items: [
      "decode-blob skill pack - automatically detect and decode JWT, gzip, brotli, base64, or hex blobs",
      "trend-analysis skill pack - fetch data, summarize, smooth, detect trends, flag anomalies, benchmark",
      "Compression kit: 5 tools for gzip, brotli, and deflate compression/decompression",
      "Stats kit: 5 tools for summary statistics, correlation, regression, moving averages, and outlier detection",
    ],
  },
  {
    date: "2026-06-20",
    title: "Security-audit and structured-scrape skill packs",
    items: [
      "security-audit skill pack - 7-tool domain audit covering DNS, TLS, WHOIS, HTTP, headers, SPF, and robots.txt",
      "structured-scrape skill pack - render a page and extract structured data in one workflow",
      "HTML kit: 5 tools for extracting text, elements, links, tables, and headings from HTML",
    ],
  },
  {
    date: "2026-06-19",
    title: "x402 economy dashboard and leaderboard",
    items: [
      "/economy - daily x402 ecosystem volume, concentration, and network breakdown",
      "/leaderboard - public on-chain ranking of x402 sellers by Base USDC settled volume",
      "/api/leaderboard - machine-readable seller rankings",
      "Smart Order Router (/api/route) - find the cheapest healthy tool across the x402 ecosystem",
    ],
  },
  {
    date: "2026-06-18",
    title: "Docs hub, analytics dashboard, and caching",
    items: [
      "/docs - wiki content rendered on-site with sidebar navigation",
      "/analytics - live tool-level call counts, error rates, and latency percentiles",
      "Server-side response caching with cache-hit headers for supported routes",
      "Idempotency support - Idempotency-Key header prevents double-charging on retries",
    ],
  },
  {
    date: "2026-06-17",
    title: "Tollbooth Cloud and framework adapters",
    items: [
      "Tollbooth Cloud - hosted multi-site pay-per-crawl dashboard",
      "8 framework adapters on npm: OpenAI, Anthropic, Vercel AI SDK, LangChain, LlamaIndex, Google ADK, OpenAI Agents, AWS Strands",
      "agent402-client SDK - find() + call() with auto-payment",
    ],
  },
];

export function changelogRss(baseUrl) {
  const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const items = ENTRIES.map((e) =>
    `  <item>
    <title>${xmlEsc(e.title)}</title>
    <link>${baseUrl}/changelog</link>
    <guid isPermaLink="false">agent402-changelog-${e.date}</guid>
    <pubDate>${new Date(e.date + "T12:00:00Z").toUTCString()}</pubDate>
    <description>${xmlEsc(e.items.join(". ") + ".")}</description>
  </item>`
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>Agent402 Changelog</title>
  <link>${baseUrl}/changelog</link>
  <description>Recent additions to Agent402: new tools, skill packs, framework adapters, and platform features.</description>
  <language>en</language>
  <atom:link href="${baseUrl}/changelog.xml" rel="self" type="application/rss+xml"/>
${items}
</channel>
</rss>`;
}

export function changelogPage(baseUrl) {
  const canonical = `${baseUrl}/changelog`;
  const title = "Changelog - what's new at Agent402";
  const description = "Recent additions to Agent402: new tools, skill packs, framework adapters, and platform features.";

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: title,
    description,
    url: canonical,
    isPartOf: { "@type": "WebSite", url: baseUrl },
  };

  const timelineHtml = ENTRIES.map((entry) => {
    const itemsHtml = entry.items.map((item) => `<li>${esc(item)}</li>`).join("\n              ");
    return `
          <div class="tl-entry">
            <div class="tl-dot"></div>
            <div class="tl-card">
              <span class="tl-date">${esc(entry.date)}</span>
              <h2>${esc(entry.title)}</h2>
              <ul>
              ${itemsHtml}
              </ul>
            </div>
          </div>`;
  }).join("\n");

  const extraCss = `
.cl-wrap{max-width:1180px;margin:0 auto;padding:56px 30px;}
.cl-eyebrow{font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:10px;}
.cl-wrap h1{font-family:var(--font-body);font-weight:800;font-size:58px;line-height:.96;letter-spacing:-.03em;margin:0 0 14px;}
.cl-desc{font-size:15px;line-height:1.55;color:var(--muted);margin:0 0 40px;max-width:640px;}
.cl-rss{font-family:var(--font-mono);font-size:13px;color:var(--accent);text-decoration:none;display:inline-block;margin-bottom:32px;}
.cl-rss:hover{text-decoration:underline;}
.timeline{position:relative;padding-left:28px;}
.timeline::before{content:"";position:absolute;left:7px;top:0;bottom:0;width:1.5px;background:var(--hairline);}
.tl-entry{position:relative;margin-bottom:24px;}
.tl-dot{position:absolute;left:-28px;top:8px;width:16px;height:16px;background:var(--accent);border:3px solid var(--paper);}
.tl-card{background:var(--card);border:1px solid var(--hairline);padding:20px 24px;}
.tl-date{display:inline-block;font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:4px;}
.tl-card h2{font-family:var(--font-body);font-weight:800;font-size:20px;line-height:1.15;letter-spacing:-.02em;margin:4px 0 12px;color:var(--ink);}
.tl-card ul{margin:0;padding-left:20px;color:var(--muted);font-size:15px;line-height:1.55;}
.tl-card li{margin-bottom:5px;}
.tl-card li:last-child{margin-bottom:0;}
@media(max-width:600px){.cl-wrap h1{font-size:40px;}.tl-card{padding:16px 18px;}}
`;

  const body = `<div class="cl-wrap">
  <section>
  <div class="cl-eyebrow">$ GET /changelog</div>
  <h1>Changelog</h1>
  <p class="cl-desc">${esc(description)}</p>
  <a class="cl-rss" href="${baseUrl}/changelog.xml">RSS feed</a>
  </section>
  <section>
  <div class="timeline">
${timelineHtml}
  </div>
  </section>
</div>
${ledgerFooterCompact()}`;

  return ledgerShell({ title, description, canonical, baseUrl, activePath: "__none__", jsonLd, extraCss, body });
}
