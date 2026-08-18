# Skill Packs

> **Payment wires:** every paid endpoint accepts **x402** and **MPP** (Machine Payments Protocol) on the same 402 - see [[Paying with x402]] and [[Paying with MPP]]. Agent402 is the applied layer of [[Agentic Finance]] (AIFI): agents that pay and get paid on their own.

**100+ curated multi-tool workflows.** Each pack solves a real job that no single tool covers - auditing a domain, working up a time series, decoding an opaque blob, pulling the macro backdrop - and ships as a single MCP **prompt**. An agent calls `prompts/get { name: "<pack>", arguments: { … } }` and gets back a ready-to-run plan with the right Agent402 tools wired in (in the right order, with the right inputs).

- **Browse on the live site:** [`agent402.tools/skills`](https://agent402.tools/skills) (full templates, arguments, examples)
- **MCP discovery:** every MCP-aware client picks them up via `prompts/list` → `prompts/get`
- **Find-by-task:** [`/api/find?q=<task>`](https://agent402.tools/api/find?q=audit+a+domain) also recommends a matching pack alongside individual tools, so a task-shaped query points at the workflow, not just the raw tools.

## How to call a pack

```jsonc
// MCP (any MCP-aware client - Claude Desktop, Cline, etc.)
prompts/get { "name": "security-audit", "arguments": { "domain": "example.com" } }

// HTTP (plain GET - no wallet needed to render a template)
GET https://agent402.tools/skills/security-audit?domain=example.com
```

The template is the **plan** - the agent then executes each step. Payment (USDC via x402 or free proof-of-work) only happens when the agent actually calls each tool.

Every pack is **also a single paid endpoint**, `POST /api/skill/{slug}`, which runs the whole workflow in one call for one flat price. That price is the **Price** column in the tables below (verifiable in [`/api/pricing`](https://agent402.tools/api/pricing) under the `skill-{slug}` slugs). Rendering the template stays free either way; the flat price is what the bundled run costs.

---

## Security & trust (9)

| Pack | Price | What it solves |
|---|---|---|
| [**security-audit**](https://agent402.tools/skills/security-audit) | $0.12 | Enumerate a domain's external attack surface: certs, DNS posture, email auth, HTTP headers, tech stack. |
| [**email-deliverability**](https://agent402.tools/skills/email-deliverability) | $0.10 | Diagnose why a domain's email lands in spam: SPF, DMARC, DKIM strength, MX, composite score. |
| [**fraud-signals**](https://agent402.tools/skills/fraud-signals) | $0.15 | Is this domain a phishing site / typosquat / scam? Pull the reputation signals before you click. |
| [**jwt-forensics**](https://agent402.tools/skills/jwt-forensics) | $0.050 | "Is this JWT valid?" Decode, render the time claims, compute expiry, then HMAC-verify against the secret. |
| [**domain-intel**](https://agent402.tools/skills/domain-intel) | $0.075 | Full domain security + SEO intel: WHOIS, DNS, TLS, headers, tech stack, robots, certificate transparency. |
| [**ssl-audit**](https://agent402.tools/skills/ssl-audit) | $0.10 | TLS/SSL posture: live certificate inspection, HTTP security headers, and CAA DNS records. |
| [**email-security**](https://agent402.tools/skills/email-security) | $0.10 | Full email auth posture: SPF, DMARC, DKIM, and a composite deliverability score. |
| [**brand-protection**](https://agent402.tools/skills/brand-protection) | $0.20 | Is this domain legitimate? WHOIS age, DNS, scam/phishing search, and HTTP headers for a trust read. |
| [**domain-age**](https://agent402.tools/skills/domain-age) | $0.060 | How old and legit is this domain? WHOIS registration, DNS resolution, and TLS certificate in one pass. |

## Web extraction & document intelligence (8)

| Pack | Price | What it solves |
|---|---|---|
| [**content-extraction**](https://agent402.tools/skills/content-extraction) | $0.30 | Turn arbitrary URLs and PDFs into clean structured text - articles, page metadata, PDF pages, OCR. |
| [**structured-scrape**](https://agent402.tools/skills/structured-scrape) | $0.20 | Pull structured data out of any page deterministically - articles, tables, elements by CSS selector. |
| [**any-to-markdown**](https://agent402.tools/skills/any-to-markdown) | $0.20 | "I have a URL but it might be HTML, PDF, or an image - give me clean markdown either way." |
| [**document-intel**](https://agent402.tools/skills/document-intel) | $0.20 | Turn any PDF or image URL into structured data - metadata, text, page ranges, OCR, barcodes. |
| [**link-preview**](https://agent402.tools/skills/link-preview) | $0.12 | Turn a URL into a card-shaped preview - OpenGraph/Twitter metadata + normalized social image + thumbnail. |
| [**pdf-pipeline**](https://agent402.tools/skills/pdf-pipeline) | $0.060 | Full PDF pipeline - metadata, markdown conversion, and first-page extraction in one call. |
| [**url-inspector**](https://agent402.tools/skills/url-inspector) | $0.060 | Quick URL health + metadata - parse the structure, verify reachability, and pull page metadata. |
| [**content-grade**](https://agent402.tools/skills/content-grade) | $0.080 | Grade a page's content quality - extract the readable content then analyze keyword density. |

## SEO & site audit (5)

| Pack | Price | What it solves |
|---|---|---|
| [**seo-audit**](https://agent402.tools/skills/seo-audit) | $0.070 | Can search engines and AI crawlers index this page? Reachability, TLS, robots, sitemap, meta/OG, link graph. |
| [**page-audit**](https://agent402.tools/skills/page-audit) | $0.12 | Full page SEO + security audit: content, metadata, HTTP headers, robots policy, and sitemap health. |
| [**competitor-scan**](https://agent402.tools/skills/competitor-scan) | $0.15 | What's a competitor running? Tech stack, HTTP headers, WHOIS, and page metadata in one call. |
| [**status-snapshot**](https://agent402.tools/skills/status-snapshot) | $0.070 | "Is this site healthy, addressable, and crawlable - right now?" DNS → HTTP → headers → TLS → robots. |
| [**content-quality**](https://agent402.tools/skills/content-quality) | $0.050 | Readability scores, keyword density, and a URL-ready slug from a block of text. |

## Finance (14)

| Pack | Price | What it solves |
|---|---|---|
| [**financial-research**](https://agent402.tools/skills/financial-research) | $1.50 | SEC filings + real-time quotes + history + macro context for a single ticker. |
| [**financial-analysis**](https://agent402.tools/skills/financial-analysis) | $0.080 | Quick company snapshot: live quote, 9 key financial metrics, and upcoming earnings. |
| [**loan-comparison**](https://agent402.tools/skills/loan-comparison) | $0.050 | Compare two or more loan offers on one rubric - monthly payment, total interest, NPV, effective rate. |
| [**investment-decision**](https://agent402.tools/skills/investment-decision) | $0.050 | Run a capital-allocation decision - NPV at your hurdle rate, IRR, opportunity cost, levered cashflow. |
| [**retirement-planning**](https://agent402.tools/skills/retirement-planning) | $0.050 | Will my plan work? Project accumulation with compound interest, then model the drawdown phase. |
| [**savings-goal**](https://agent402.tools/skills/savings-goal) | $0.050 | How much to save each month to hit $X in N years? Pin down the required contribution. |
| [**company-dossier**](https://agent402.tools/skills/company-dossier) | $0.12 | Comprehensive company research in one call: quote, financials, filings, insider trades, news. |
| [**earnings-watch**](https://agent402.tools/skills/earnings-watch) | $0.10 | Is this company reporting soon and what's the consensus? Earnings calendar, quote, recent results. |
| [**earnings-deep-dive**](https://agent402.tools/skills/earnings-deep-dive) | $0.050 | Everything before a company reports: the upcoming date, latest financials, recent filings, live quote, and fresh news in one pass. |
| [**insider-alert**](https://agent402.tools/skills/insider-alert) | $0.15 | Insider buying/selling for a stock: Form 4 trades, live quote, and recent SEC filings. |
| [**price-monitor**](https://agent402.tools/skills/price-monitor) | $0.080 | Side-by-side snapshot of a stock and a crypto asset: live quotes, 1-year history, date-stamped compare. |
| [**options-analytics**](https://agent402.tools/skills/options-analytics) | $0.050 | Price a European option on a live stock: current quote, volatility from recent history, Black-Scholes fair value plus the full greeks, and catalyst news. |
| [**finance-calc**](https://agent402.tools/skills/finance-calc) | $0.050 | Compound interest, amortization schedule, and loan payment - the three calculators agents need most. |
| [**market-open**](https://agent402.tools/skills/market-open) | $0.12 | Pre-trade snapshot for one ticker before the bell: live quote, pre-market quote, options surface, dividend posture, and today's earnings calendar. |

## Macro & SEC (12)

| Pack | Price | What it solves |
|---|---|---|
| [**macro-economics**](https://agent402.tools/skills/macro-economics) | $0.65 | Pull the canonical US macro dataset - yield curve, CPI, unemployment, fed funds, Sahm rule. |
| [**macro-context**](https://agent402.tools/skills/macro-context) | $0.75 | "Is the economic backdrop you're modeling against still current?" - refresh the macro snapshot. |
| [**sec-filings-deep-dive**](https://agent402.tools/skills/sec-filings-deep-dive) | $0.85 | Full EDGAR picture of one company: filings, key financial time series, insider trades, full-text search. |
| [**regulatory-watch**](https://agent402.tools/skills/regulatory-watch) | $0.70 | "Who just filed / bought / IPO'd?" - EDGAR full-text search, recent filings, Form 4s, 13F, IPO calendar. |
| [**ipo-watch**](https://agent402.tools/skills/ipo-watch) | $0.15 | What's going public? Recent S-1/IPO filings from EDGAR plus a web search for IPO news. |
| [**yield-dashboard**](https://agent402.tools/skills/yield-dashboard) | $0.10 | Current yield-curve snapshot: full Treasury curve, key spreads, and average rates. |
| [**fixed-income-desk**](https://agent402.tools/skills/fixed-income-desk) | $0.050 | Read the rate environment and price a bond in one workflow: live Treasury curve, the recession-signal spread, inflation context, then bond price and yield at current rates. |
| [**inflation-check**](https://agent402.tools/skills/inflation-check) | $0.10 | Is the economy in recession territory? CPI, fed funds, unemployment, and Sahm rule. |
| [**fx-monitor**](https://agent402.tools/skills/fx-monitor) | $0.15 | Major currency snapshot: EUR/USD, GBP/USD, JPY/USD plus the full FX dashboard. |
| [**fred-snapshot**](https://agent402.tools/skills/fred-snapshot) | $0.10 | Key Fed indicators - fed funds rate, unemployment, and CPI - in one call. |
| [**world-data**](https://agent402.tools/skills/world-data) | $0.080 | GDP and population for a country - two key World Bank indicators. |
| [**macro-dashboard**](https://agent402.tools/skills/macro-dashboard) | $0.10 | The full macro plus crypto dashboard in one call: 5 FRED series, 5 Treasury reads, the curve spread, crypto market/trending/global, and live gas. |

## Time series & forecasting (3)

| Pack | Price | What it solves |
|---|---|---|
| [**trend-analysis**](https://agent402.tools/skills/trend-analysis) | $0.20 | Take any numeric series and run the full workup - descriptives, moving averages, trend, outliers, forecast. |
| [**forecasting-bake-off**](https://agent402.tools/skills/forecasting-bake-off) | $0.20 | Backtest all four methods (naive/drift, SES, Holt, Holt-Winters), rank by RMSE, forecast with the winner. |
| [**number-crunch**](https://agent402.tools/skills/number-crunch) | $0.050 | Descriptive statistics, correlation analysis, and outlier detection on a single dataset. |

## Crypto & onchain (13)

| Pack | Price | What it solves |
|---|---|---|
| [**market-brief**](https://agent402.tools/skills/market-brief) | $0.050 | Quick crypto snapshot: price for a coin, trending coins, and global market stats in one call. |
| [**crypto-research**](https://agent402.tools/skills/crypto-research) | $0.70 | Live price, market structure, OHLC history, trending status, global context, and news for a coin. |
| [**crypto-dossier**](https://agent402.tools/skills/crypto-dossier) | $0.12 | Everything about a coin: live price, 90-day history, trending status, market context, news + top article. |
| [**defi-protocol-scanner**](https://agent402.tools/skills/defi-protocol-scanner) | $0.050 | Due-diligence a DeFi protocol: live token price, market context, protocol TVL across chains, and recent news. |
| [**defi-dashboard**](https://agent402.tools/skills/defi-dashboard) | $0.15 | DeFi overview: total TVL, ETH price, Base gas, and global crypto stats. |
| [**nft-portfolio**](https://agent402.tools/skills/nft-portfolio) | $0.15 | NFT + wallet snapshot: NFT holdings, native balance, and ETH price for an address. |
| [**wallet-audit**](https://agent402.tools/skills/wallet-audit) | $0.15 | Full wallet review: balance, recent transactions, and token metadata for an address. |
| [**wallet-readiness**](https://agent402.tools/skills/wallet-readiness) | $0.050 | "Can this wallet pay right now?" USDC on Base + Solana, live Base gas, and an Onramp funding link. |
| [**onchain-analyst**](https://agent402.tools/skills/onchain-analyst) | $0.20 | Ask Base anything in SQL - your query runs against Coinbase's indexed, decoded chain data. |
| [**gas-optimizer**](https://agent402.tools/skills/gas-optimizer) | $0.10 | Find the cheapest gas: Base gas, Ethereum gas, Base fee estimate, and ETH price for USD conversion. |
| [**tx-forensics**](https://agent402.tools/skills/tx-forensics) | $0.10 | Explain what an EVM transaction actually did: confirmation status, the raw transaction, decoded calldata with typed parameters, resolved function signature, and labeled counterparties. |
| [**cheapest-rail**](https://agent402.tools/skills/cheapest-rail) | $0.050 | Where should an agent transact this minute? Live gas across L2s, a fee estimate, and ETH spot. |
| [**contract-audit**](https://agent402.tools/skills/contract-audit) | $0.15 | Triage a smart contract before an agent touches it: verified source, heuristic vulnerability scan, known-address check, selector resolution, and a read-only dry-run of the exact call. |

## Network, DevOps & API work (6)

| Pack | Price | What it solves |
|---|---|---|
| [**dns-network-ops**](https://agent402.tools/skills/dns-network-ops) | $0.080 | End-to-end DNS health check: records, multi-resolver propagation, WHOIS, ASN, robots.txt, reachability. |
| [**api-investigation**](https://agent402.tools/skills/api-investigation) | $0.10 | Point at an unknown API and figure out how to use it: auth, content type, version, rate limits, schema. |
| [**schema-evolution**](https://agent402.tools/skills/schema-evolution) | $0.060 | "Did this API contract change in a way that breaks us?" - diff two OpenAPI snapshots, lint, validate. |
| [**api-health**](https://agent402.tools/skills/api-health) | $0.060 | Is this API endpoint healthy? Liveness check, response headers, and TLS certificate status. |
| [**openapi-audit**](https://agent402.tools/skills/openapi-audit) | $0.060 | Lint an OpenAPI spec and validate a sample payload against it - catch schema errors in one pass. |
| [**schema-guard**](https://agent402.tools/skills/schema-guard) | $0.050 | Contract-test a JSON payload: validate against your schema, infer the schema the payload implies, diff the two to expose drift, and return a normalized pretty-print. |

## Data engineering & RAG (7)

| Pack | Price | What it solves |
|---|---|---|
| [**csv-profile**](https://agent402.tools/skills/csv-profile) | $0.050 | Hand it a CSV and get a column-by-column profile: stats, outliers, correlations, baseline regression. |
| [**data-interchange**](https://agent402.tools/skills/data-interchange) | $0.050 | Bring data in from any format, normalize through JSON, merge, diff, and fan out to CSV/YAML/JSON. |
| [**text-hygiene**](https://agent402.tools/skills/text-hygiene) | $0.050 | Turn dirty text into something downstream code can trust - measure, redact PII, dedupe, sort, extract. |
| [**rag-prep**](https://agent402.tools/skills/rag-prep) | $0.050 | Turn a raw document into a vector-DB-ready JSONL dataset - chunk, token-count, attach metadata, validate. |
| [**json-pipeline**](https://agent402.tools/skills/json-pipeline) | $0.050 | Validate, pretty-print, and convert JSON to CSV - the complete JSON processing workflow. |
| [**data-convert**](https://agent402.tools/skills/data-convert) | $0.050 | CSV → JSON → YAML - convert tabular data through the common interchange formats in one chain. |
| [**xml-json**](https://agent402.tools/skills/xml-json) | $0.050 | Convert XML to JSON and pretty-print it - the "legacy API response to modern format" workflow. |

## Decoding & inspection (4)

| Pack | Price | What it solves |
|---|---|---|
| [**decode-blob**](https://agent402.tools/skills/decode-blob) | $0.050 | Hand the agent an opaque string - JWT, base64 JSON, gzipped response - and identify + unwrap it layer by layer. |
| [**webhook-debug**](https://agent402.tools/skills/webhook-debug) | $0.050 | A webhook hit your endpoint - confirm it's authentic, valid, and safe to log. |
| [**jwt-toolkit**](https://agent402.tools/skills/jwt-toolkit) | $0.050 | Decode and verify a JWT in one pass - see the payload and check the signature. |
| [**webhook-intake**](https://agent402.tools/skills/webhook-intake) | $0.050 | The production ingest path for an incoming webhook: verify the provider signature (constant-time, replay-window enforced), schema-validate the now-trusted body, fingerprint the raw bytes for redelivery dedup, normalize the timestamp, and redact PII before anything is logged. |

## Identity & onboarding (4)

| Pack | Price | What it solves |
|---|---|---|
| [**user-onboarding**](https://agent402.tools/skills/user-onboarding) | $0.050 | Take a signup form and run onboarding deterministically - validate, score, mint ID, slug, hash, verify 2FA. |
| [**identity-mint**](https://agent402.tools/skills/identity-mint) | $0.050 | Server-side identity issuance - UUIDv4 + deterministic UUIDv5 + slug + recovery password + session JWT. |
| [**contact-verify**](https://agent402.tools/skills/contact-verify) | $0.060 | Verify an email is deliverable - syntax validation plus MX record check on the domain. |
| [**entity-enrich**](https://agent402.tools/skills/entity-enrich) | $0.15 | Company name to verified identity plus web footprint: Wikidata facts, the LEI legal-entity record, the SEC filer, domain registration, tech stack, and brand favicon. |

## Location & time (6)

| Pack | Price | What it solves |
|---|---|---|
| [**location-intel**](https://agent402.tools/skills/location-intel) | $0.10 | Point at an address and assemble the brief - coords, address, nearby, weather, NWS alerts, seismic. |
| [**meeting-scheduler**](https://agent402.tools/skills/meeting-scheduler) | $0.050 | Schedule across timezones without round-tripping - convert, verify working days, present the slot. |
| [**trip-planner**](https://agent402.tools/skills/trip-planner) | $0.050 | Plan a multi-stop journey - geocode each stop, sum pairwise distances, add travel time, pull weather. |
| [**weather-brief**](https://agent402.tools/skills/weather-brief) | $0.060 | Full weather briefing for a location: current conditions, 7-day forecast, and air quality. |
| [**timezone-planner**](https://agent402.tools/skills/timezone-planner) | $0.050 | Timezone conversion, business-day calculation, and cron schedule preview - scheduling in one pass. |
| [**locale-brief**](https://agent402.tools/skills/locale-brief) | $0.050 | "Can I reach this counterparty this week?" Country facts, this year's public holidays, working days left this week, and the local time right now. |

## Media & accessibility (3)

| Pack | Price | What it solves |
|---|---|---|
| [**media-pipeline**](https://agent402.tools/skills/media-pipeline) | $0.25 | "User uploaded a thing, normalize it before storing." Probe → decode → resize → thumbnail → convert. |
| [**a11y-audit**](https://agent402.tools/skills/a11y-audit) | $0.050 | Deterministic WCAG 2.x audit of an HTML page from a string and a fg/bg color pair. |
| [**subtitle-pipeline**](https://agent402.tools/skills/subtitle-pipeline) | $0.10 | Audio URL to finished subtitles: transcribe the audio, emit SRT/WebVTT/JSON cues, and report length, reading time, and word count. |

## Text & content utilities (5)

| Pack | Price | What it solves |
|---|---|---|
| [**text-analyze**](https://agent402.tools/skills/text-analyze) | $0.050 | Full text analysis - word/sentence stats, keyword extraction, and token count. |
| [**content-clean**](https://agent402.tools/skills/content-clean) | $0.050 | Clean and deduplicate text - redact PII, remove duplicate lines, and sort. |
| [**markdown-convert**](https://agent402.tools/skills/markdown-convert) | $0.050 | Markdown → HTML and back - a round-trip that proves fidelity and yields both formats. |
| [**regex-test**](https://agent402.tools/skills/regex-test) | $0.050 | Test a regular expression against text and get matches plus text statistics. |
| [**validator-suite**](https://agent402.tools/skills/validator-suite) | $0.050 | Validate common identifiers - ISBN (book), IBAN (bank account), and credit card (Luhn). |

## Search & citations (3)

| Pack | Price | What it solves |
|---|---|---|
| [**search-and-cite**](https://agent402.tools/skills/search-and-cite) | $0.65 | Research a question, return an answer with citations - synthesized take + SERP + news, verified by fetch. |
| [**article-digest**](https://agent402.tools/skills/article-digest) | $0.10 | Quick research brief on any topic - web search results plus an AI-generated answer. |
| [**feed-watch**](https://agent402.tools/skills/feed-watch) | $0.080 | Monitor an RSS/Atom feed: parse it, read the top story in full, extract the keywords driving the cycle, and diff the item list against your last run to isolate what is new. |

---

## Why packs and not just tools

A single tool answers a question. A pack answers a **job**.

When an agent says *"audit a domain"*, picking one tool (whois? dns? tls-cert? cert-transparency?) is a guess - the right answer is "all of them in the right order, then synthesize." That's what a pack encodes:

- **The plan is in the template, not in the model.** Same pack, same plan, every time - no token-spending discovery loop.
- **The tools are pinned.** When a new better tool ships, the pack template gets updated server-side; agents calling `prompts/get` always get the current best plan.
- **Pricing is transparent.** Each tool's price is deterministic; the pack template lists every call so total cost is predictable before the first call.
- **No LLM in the serving path.** The pack rendering itself is deterministic - no hidden inference, no surprise dependencies.

## Adding a pack

Packs live in [`src/skills.js`](https://github.com/MikeyPetrillo/Agent402/blob/main/src/skills.js). A pack is `{ slug, title, tagline, useCase, toolSlugs[], arguments[], workflow[], notes[] }` - see the existing entries for the shape. CI's "answers its own example" check covers the underlying tools; pack templates are validated by `scripts/test-mcp-all.js` (`prompts/list` returns N typed entries; `prompts/get` renders each one without throwing).

## See also

- [[Tool Catalog]] - the underlying 500+ tools the packs orchestrate
- [[MCP Connector]] - how to wire the connector into Claude / Cline / any MCP-aware client
- [[Getting Started]] - your first call (free, no wallet) in 60 seconds
- [[x402-Index-and-Router]] - what Agent402 looks like inside the wider x402 ecosystem
