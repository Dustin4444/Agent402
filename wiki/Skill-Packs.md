# Skill Packs

**92 curated multi-tool workflows.** Each pack solves a real job that no single tool covers — auditing a domain, working up a time series, decoding an opaque blob, pulling the macro backdrop — and ships as a single MCP **prompt**. An agent calls `prompts/get { name: "<pack>", arguments: { … } }` and gets back a ready-to-run plan with the right Agent402 tools wired in (in the right order, with the right inputs).

- **Browse on the live site:** [`agent402.tools/skills`](https://agent402.tools/skills) (full templates, arguments, examples)
- **MCP discovery:** every MCP-aware client picks them up via `prompts/list` → `prompts/get`
- **Find-by-task:** [`/api/find?q=<task>`](https://agent402.tools/api/find?q=audit+a+domain) also recommends a matching pack alongside individual tools, so a task-shaped query points at the workflow, not just the raw tools.

## How to call a pack

```jsonc
// MCP (any MCP-aware client — Claude Desktop, Cline, etc.)
prompts/get { "name": "security-audit", "arguments": { "domain": "stripe.com" } }

// HTTP (plain GET — no wallet needed to render a template)
GET https://agent402.tools/skills/security-audit?domain=stripe.com
```

The template is the **plan** — the agent then executes each step. Payment (USDC via x402 or free proof-of-work) only happens when the agent actually calls each tool.

---

## Security & trust (10)

| Pack | What it solves |
|---|---|
| [**security-audit**](https://agent402.tools/skills/security-audit) | Enumerate a domain's external attack surface: certs, DNS posture, email auth, HTTP headers, tech stack. |
| [**email-deliverability**](https://agent402.tools/skills/email-deliverability) | Diagnose why a domain's email lands in spam: SPF, DMARC, DKIM strength, MX, composite score. |
| [**fraud-signals**](https://agent402.tools/skills/fraud-signals) | Is this domain a phishing site / typosquat / scam? Pull the reputation signals before you click. |
| [**jwt-forensics**](https://agent402.tools/skills/jwt-forensics) | "Is this JWT valid?" Decode, render the time claims, compute expiry, then HMAC-verify against the secret. |
| [**domain-intel**](https://agent402.tools/skills/domain-intel) | Full domain security + SEO intel: WHOIS, DNS, TLS, headers, tech stack, robots, certificate transparency. |
| [**ssl-audit**](https://agent402.tools/skills/ssl-audit) | TLS/SSL posture: live certificate inspection, HTTP security headers, and CAA DNS records. |
| [**email-security**](https://agent402.tools/skills/email-security) | Full email auth posture: SPF, DMARC, DKIM, and a composite deliverability score. |
| [**brand-protection**](https://agent402.tools/skills/brand-protection) | Is this domain legitimate? WHOIS age, DNS, scam/phishing search, and HTTP headers for a trust read. |
| [**domain-age**](https://agent402.tools/skills/domain-age) | How old and legit is this domain? WHOIS registration, DNS resolution, and TLS certificate in one pass. |
| [**password-audit**](https://agent402.tools/skills/password-audit) | Score a password's strength (entropy, crack time, weaknesses) and generate a strong replacement. |

## Web extraction & document intelligence (8)

| Pack | What it solves |
|---|---|
| [**content-extraction**](https://agent402.tools/skills/content-extraction) | Turn arbitrary URLs and PDFs into clean structured text — articles, page metadata, PDF pages, OCR. |
| [**structured-scrape**](https://agent402.tools/skills/structured-scrape) | Pull structured data out of any page deterministically — articles, tables, elements by CSS selector. |
| [**any-to-markdown**](https://agent402.tools/skills/any-to-markdown) | "I have a URL but it might be HTML, PDF, or an image — give me clean markdown either way." |
| [**document-intel**](https://agent402.tools/skills/document-intel) | Turn any PDF or image URL into structured data — metadata, text, page ranges, OCR, barcodes. |
| [**link-preview**](https://agent402.tools/skills/link-preview) | Turn a URL into a card-shaped preview — OpenGraph/Twitter metadata + normalized social image + thumbnail. |
| [**pdf-pipeline**](https://agent402.tools/skills/pdf-pipeline) | Full PDF pipeline — metadata, markdown conversion, and first-page extraction in one call. |
| [**url-inspector**](https://agent402.tools/skills/url-inspector) | Quick URL health + metadata — parse the structure, verify reachability, and pull page metadata. |
| [**content-grade**](https://agent402.tools/skills/content-grade) | Grade a page's content quality — extract the readable content then analyze keyword density. |

## SEO & site audit (5)

| Pack | What it solves |
|---|---|
| [**seo-audit**](https://agent402.tools/skills/seo-audit) | Can search engines and AI crawlers index this page? Reachability, TLS, robots, sitemap, meta/OG, link graph. |
| [**page-audit**](https://agent402.tools/skills/page-audit) | Full page SEO + security audit: content, metadata, HTTP headers, robots policy, and sitemap health. |
| [**competitor-scan**](https://agent402.tools/skills/competitor-scan) | What's a competitor running? Tech stack, HTTP headers, WHOIS, and page metadata in one call. |
| [**status-snapshot**](https://agent402.tools/skills/status-snapshot) | "Is this site healthy, addressable, and crawlable — right now?" DNS → HTTP → headers → TLS → robots. |
| [**content-quality**](https://agent402.tools/skills/content-quality) | Readability scores, keyword density, and a URL-ready slug from a block of text. |

## Finance (11)

| Pack | What it solves |
|---|---|
| [**financial-research**](https://agent402.tools/skills/financial-research) | SEC filings + real-time quotes + history + macro context for a single ticker. |
| [**financial-analysis**](https://agent402.tools/skills/financial-analysis) | Quick company snapshot: live quote, 9 key financial metrics, and upcoming earnings. |
| [**loan-comparison**](https://agent402.tools/skills/loan-comparison) | Compare two or more loan offers on one rubric — monthly payment, total interest, NPV, effective rate. |
| [**investment-decision**](https://agent402.tools/skills/investment-decision) | Run a capital-allocation decision — NPV at your hurdle rate, IRR, opportunity cost, levered cashflow. |
| [**retirement-planning**](https://agent402.tools/skills/retirement-planning) | Will my plan work? Project accumulation with compound interest, then model the drawdown phase. |
| [**savings-goal**](https://agent402.tools/skills/savings-goal) | How much to save each month to hit $X in N years? Pin down the required contribution. |
| [**company-dossier**](https://agent402.tools/skills/company-dossier) | Comprehensive company research in one call: quote, financials, filings, insider trades, news. |
| [**earnings-watch**](https://agent402.tools/skills/earnings-watch) | Is this company reporting soon and what's the consensus? Earnings calendar, quote, recent results. |
| [**insider-alert**](https://agent402.tools/skills/insider-alert) | Insider buying/selling for a stock: Form 4 trades, live quote, and recent SEC filings. |
| [**price-monitor**](https://agent402.tools/skills/price-monitor) | Side-by-side snapshot of a stock and a crypto asset: live quotes, 1-year history, date-stamped compare. |
| [**finance-calc**](https://agent402.tools/skills/finance-calc) | Compound interest, amortization schedule, and loan payment — the three calculators agents need most. |

## Macro & SEC (10)

| Pack | What it solves |
|---|---|
| [**macro-economics**](https://agent402.tools/skills/macro-economics) | Pull the canonical US macro dataset — yield curve, CPI, unemployment, fed funds, Sahm rule. |
| [**macro-context**](https://agent402.tools/skills/macro-context) | "Is the economic backdrop you're modeling against still current?" — refresh the macro snapshot. |
| [**sec-filings-deep-dive**](https://agent402.tools/skills/sec-filings-deep-dive) | Full EDGAR picture of one company: filings, key financial time series, insider trades, full-text search. |
| [**regulatory-watch**](https://agent402.tools/skills/regulatory-watch) | "Who just filed / bought / IPO'd?" — EDGAR full-text search, recent filings, Form 4s, 13F, IPO calendar. |
| [**ipo-watch**](https://agent402.tools/skills/ipo-watch) | What's going public? Recent S-1/IPO filings from EDGAR plus a web search for IPO news. |
| [**yield-dashboard**](https://agent402.tools/skills/yield-dashboard) | Current yield-curve snapshot: full Treasury curve, key spreads, and average rates. |
| [**inflation-check**](https://agent402.tools/skills/inflation-check) | Is the economy in recession territory? CPI, fed funds, unemployment, and Sahm rule. |
| [**fx-monitor**](https://agent402.tools/skills/fx-monitor) | Major currency snapshot: EUR/USD, GBP/USD, JPY/USD plus the full FX dashboard. |
| [**fred-snapshot**](https://agent402.tools/skills/fred-snapshot) | Key Fed indicators — fed funds rate, unemployment, and CPI — in one call. |
| [**world-data**](https://agent402.tools/skills/world-data) | GDP and population for a country — two key World Bank indicators. |

## Time series & forecasting (4)

| Pack | What it solves |
|---|---|
| [**trend-analysis**](https://agent402.tools/skills/trend-analysis) | Take any numeric series and run the full workup — descriptives, moving averages, trend, outliers, forecast. |
| [**forecasting-bake-off**](https://agent402.tools/skills/forecasting-bake-off) | Backtest all four methods (naive/drift, SES, Holt, Holt-Winters), rank by RMSE, forecast with the winner. |
| [**number-crunch**](https://agent402.tools/skills/number-crunch) | Descriptive statistics, correlation analysis, and outlier detection on a single dataset. |
| [**math-suite**](https://agent402.tools/skills/math-suite) | Calculate an expression, summarize a dataset, and compute percentages — bundled. |

## Crypto & onchain (10)

| Pack | What it solves |
|---|---|
| [**market-brief**](https://agent402.tools/skills/market-brief) | Quick crypto snapshot: price for a coin, trending coins, and global market stats in one call. |
| [**crypto-research**](https://agent402.tools/skills/crypto-research) | Live price, market structure, OHLC history, trending status, global context, and news for a coin. |
| [**crypto-dossier**](https://agent402.tools/skills/crypto-dossier) | Everything about a coin: live price, 90-day history, trending status, market context, news + top article. |
| [**defi-dashboard**](https://agent402.tools/skills/defi-dashboard) | DeFi overview: total TVL, ETH price, Base gas, and global crypto stats. |
| [**nft-portfolio**](https://agent402.tools/skills/nft-portfolio) | NFT + wallet snapshot: NFT holdings, native balance, and ETH price for an address. |
| [**wallet-audit**](https://agent402.tools/skills/wallet-audit) | Full wallet review: balance, recent transactions, and token metadata for an address. |
| [**wallet-readiness**](https://agent402.tools/skills/wallet-readiness) | "Can this wallet pay right now?" USDC on Base + Solana, live Base gas, and an Onramp funding link. |
| [**onchain-analyst**](https://agent402.tools/skills/onchain-analyst) | Ask Base anything in SQL — your query runs against Coinbase's indexed, decoded chain data. |
| [**gas-optimizer**](https://agent402.tools/skills/gas-optimizer) | Find the cheapest gas: Base gas, Ethereum gas, Base fee estimate, and ETH price for USD conversion. |
| [**cheapest-rail**](https://agent402.tools/skills/cheapest-rail) | Where should an agent transact this minute? Live gas across L2s, a fee estimate, and ETH spot. |

## Network, DevOps & API work (5)

| Pack | What it solves |
|---|---|
| [**dns-network-ops**](https://agent402.tools/skills/dns-network-ops) | End-to-end DNS health check: records, multi-resolver propagation, WHOIS, ASN, robots.txt, reachability. |
| [**api-investigation**](https://agent402.tools/skills/api-investigation) | Point at an unknown API and figure out how to use it: auth, content type, version, rate limits, schema. |
| [**schema-evolution**](https://agent402.tools/skills/schema-evolution) | "Did this API contract change in a way that breaks us?" — diff two OpenAPI snapshots, lint, validate. |
| [**api-health**](https://agent402.tools/skills/api-health) | Is this API endpoint healthy? Liveness check, response headers, and TLS certificate status. |
| [**openapi-audit**](https://agent402.tools/skills/openapi-audit) | Lint an OpenAPI spec and validate a sample payload against it — catch schema errors in one pass. |

## Data engineering & RAG (7)

| Pack | What it solves |
|---|---|
| [**csv-profile**](https://agent402.tools/skills/csv-profile) | Hand it a CSV and get a column-by-column profile: stats, outliers, correlations, baseline regression. |
| [**data-interchange**](https://agent402.tools/skills/data-interchange) | Bring data in from any format, normalize through JSON, merge, diff, and fan out to CSV/YAML/JSON. |
| [**text-hygiene**](https://agent402.tools/skills/text-hygiene) | Turn dirty text into something downstream code can trust — measure, redact PII, dedupe, sort, extract. |
| [**rag-prep**](https://agent402.tools/skills/rag-prep) | Turn a raw document into a vector-DB-ready JSONL dataset — chunk, token-count, attach metadata, validate. |
| [**json-pipeline**](https://agent402.tools/skills/json-pipeline) | Validate, pretty-print, and convert JSON to CSV — the complete JSON processing workflow. |
| [**data-convert**](https://agent402.tools/skills/data-convert) | CSV → JSON → YAML — convert tabular data through the common interchange formats in one chain. |
| [**xml-json**](https://agent402.tools/skills/xml-json) | Convert XML to JSON and pretty-print it — the "legacy API response to modern format" workflow. |

## Decoding & inspection (6)

| Pack | What it solves |
|---|---|
| [**decode-blob**](https://agent402.tools/skills/decode-blob) | Hand the agent an opaque string — JWT, base64 JSON, gzipped response — and identify + unwrap it layer by layer. |
| [**webhook-debug**](https://agent402.tools/skills/webhook-debug) | A webhook hit your endpoint — confirm it's authentic, valid, and safe to log. |
| [**jwt-toolkit**](https://agent402.tools/skills/jwt-toolkit) | Decode and verify a JWT in one pass — see the payload and check the signature. |
| [**checksum-suite**](https://agent402.tools/skills/checksum-suite) | All checksums at once — SHA-256, CRC32, and Adler-32 for one input. |
| [**hash-verify**](https://agent402.tools/skills/hash-verify) | All major hash algorithms at once — SHA-256, SHA-512, and MD5 for any input. |
| [**encoding-suite**](https://agent402.tools/skills/encoding-suite) | Encode text in all common formats at once — Base64, hex, and URL encoding. |

## Identity & onboarding (4)

| Pack | What it solves |
|---|---|
| [**user-onboarding**](https://agent402.tools/skills/user-onboarding) | Take a signup form and run onboarding deterministically — validate, score, mint ID, slug, hash, verify 2FA. |
| [**identity-mint**](https://agent402.tools/skills/identity-mint) | Server-side identity issuance — UUIDv4 + deterministic UUIDv5 + slug + recovery password + session JWT. |
| [**contact-verify**](https://agent402.tools/skills/contact-verify) | Verify an email is deliverable — syntax validation plus MX record check on the domain. |
| [**uuid-suite**](https://agent402.tools/skills/uuid-suite) | Generate all common ID formats — UUIDv4 (random), ULID (time-sortable), UUIDv5 (namespace-based). |

## Location & time (6)

| Pack | What it solves |
|---|---|
| [**location-intel**](https://agent402.tools/skills/location-intel) | Point at an address and assemble the brief — coords, address, nearby, weather, NWS alerts, seismic. |
| [**meeting-scheduler**](https://agent402.tools/skills/meeting-scheduler) | Schedule across timezones without round-tripping — convert, verify working days, present the slot. |
| [**trip-planner**](https://agent402.tools/skills/trip-planner) | Plan a multi-stop journey — geocode each stop, sum pairwise distances, add travel time, pull weather. |
| [**weather-brief**](https://agent402.tools/skills/weather-brief) | Full weather briefing for a location: current conditions, 7-day forecast, and air quality. |
| [**timezone-planner**](https://agent402.tools/skills/timezone-planner) | Timezone conversion, business-day calculation, and cron schedule preview — scheduling in one pass. |
| [**date-math**](https://agent402.tools/skills/date-math) | Date calculations in one pass — difference between dates, add time, and age from a birthdate. |

## Media & accessibility (4)

| Pack | What it solves |
|---|---|
| [**media-pipeline**](https://agent402.tools/skills/media-pipeline) | "User uploaded a thing, normalize it before storing." Probe → decode → resize → thumbnail → convert. |
| [**a11y-audit**](https://agent402.tools/skills/a11y-audit) | Deterministic WCAG 2.x audit of an HTML page from a string and a fg/bg color pair. |
| [**color-palette**](https://agent402.tools/skills/color-palette) | Full color analysis — parse any format, check WCAG contrast, and simulate color blindness. |
| [**qr-gen**](https://agent402.tools/skills/qr-gen) | Generate a QR code and validate the URL in one pass — the encoded image plus a parsed URL breakdown. |

## Text & content utilities (8)

| Pack | What it solves |
|---|---|
| [**text-analyze**](https://agent402.tools/skills/text-analyze) | Full text analysis — word/sentence stats, keyword extraction, and token count. |
| [**content-clean**](https://agent402.tools/skills/content-clean) | Clean and deduplicate text — redact PII, remove duplicate lines, and sort. |
| [**text-transform**](https://agent402.tools/skills/text-transform) | Convert text to all common cases — camelCase, slug-form, and snake_case. |
| [**markdown-convert**](https://agent402.tools/skills/markdown-convert) | Markdown → HTML and back — a round-trip that proves fidelity and yields both formats. |
| [**lorem-gen**](https://agent402.tools/skills/lorem-gen) | Generate placeholder text and immediately size it — words, characters, estimated tokens. |
| [**regex-test**](https://agent402.tools/skills/regex-test) | Test a regular expression against text and get matches plus text statistics. |
| [**semver-check**](https://agent402.tools/skills/semver-check) | Compare two semantic versions and see the structural diff — major/minor/patch and what changed. |
| [**validator-suite**](https://agent402.tools/skills/validator-suite) | Validate common identifiers — ISBN (book), IBAN (bank account), and credit card (Luhn). |

## Search & citations (2)

| Pack | What it solves |
|---|---|
| [**search-and-cite**](https://agent402.tools/skills/search-and-cite) | Research a question, return an answer with citations — synthesized take + SERP + news, verified by fetch. |
| [**article-digest**](https://agent402.tools/skills/article-digest) | Quick research brief on any topic — web search results plus an AI-generated answer. |

---

## Why packs and not just tools

A single tool answers a question. A pack answers a **job**.

When an agent says *"audit a domain"*, picking one tool (whois? dns? tls-cert? cert-transparency?) is a guess — the right answer is "all of them in the right order, then synthesize." That's what a pack encodes:

- **The plan is in the template, not in the model.** Same pack, same plan, every time — no token-spending discovery loop.
- **The tools are pinned.** When a new better tool ships, the pack template gets updated server-side; agents calling `prompts/get` always get the current best plan.
- **Pricing is transparent.** Each tool's price is deterministic; the pack template lists every call so total cost is predictable before the first call.
- **No LLM in the serving path.** The pack rendering itself is deterministic — no hidden inference, no surprise dependencies.

## Adding a pack

Packs live in [`src/skills.js`](https://github.com/MikeyPetrillo/Agent402/blob/main/src/skills.js). A pack is `{ slug, title, tagline, useCase, toolSlugs[], arguments[], workflow[], notes[] }` — see the existing entries for the shape. CI's "answers its own example" check covers the underlying tools; pack templates are validated by `scripts/test-mcp-all.js` (`prompts/list` returns N typed entries; `prompts/get` renders each one without throwing).

## See also

- [[Tool Catalog]] — the underlying 1,428 tools the packs orchestrate
- [[MCP Connector]] — how to wire the connector into Claude / Cline / any MCP-aware client
- [[Getting Started]] — your first call (free, no wallet) in 60 seconds
- [[x402-Index-and-Router]] — what Agent402 looks like inside the wider x402 ecosystem
