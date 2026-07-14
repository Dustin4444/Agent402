# "The 501" Phase 2 — owner-approval shortlist: +30 tools, +8 skill packs

**Status:** Awaiting owner approval (gate before any implementation).
**Date:** 2026-07-14
**Baseline:** post-Phase-1 catalog = 462 entries (370 tools + 92 packs). This list takes it
to exactly 501 (400 + 100).

## Method and evidence quality

Selection mined four sources, in the order the spec requires. (1) **The live wish log**
(`/api/wishes`, backed by `recordWish`/`wishes.jsonl` on the prod /data volume) was
reachable and mined in full: 12 wishes across 10 clusters. It is sparse and two clusters
are self-tests, but it contains one repeated organic signal — **solidity / smart-contract
auditing** (3 find-miss hits across "solidity auditor", "smart contract", "solidity") —
plus single wishes for SRT conversion, JSON-Schema validation (already covered by
`json-validate`; a discoverability gap, see Not selected), and crypto prices (covered).
(2) **PostHog** (project 476347, 30-day window, non-synthetic): USDC settlements by slug
show micro-feeds and cheap deterministic transforms convert the broadest —
`stock-quote` 49 settles / **35 distinct payers**, `compound-interest` 21 payers,
`whois` 8, `json-to-csv` 6, `regex` 5; `transcribe` is the top earner (159 settles,
$4.77). Paywall-quote volume (interest) concentrates on company/finance data
(`company-financials` 526, `edgar-company-lookup` 415, `treasury-yield-curve` 374,
`crypto-price` 340), web capture (`extract` 715, `image-resize` 541, `screenshot` 465),
domain intel (`tech-stack` 491), and onchain (`onchain-sql-schema` 410). Search/find
query *text* is not captured in PostHog (the `discovery` event carries only the surface),
so "search_tools query patterns" could not be mined beyond the wish log; per-slug
`usdc_failed` data was folded into the `_other` rollup bucket (43 events) and yielded no
per-slug signal. (3) The **2026-07-13 deep-dive gaps** (multi-chain RPC siblings,
enrichment, market micro-feeds, search/scrape variants, image utilities) and (4) a
**coverage scan** of the booted post-prune catalog (370 tools; thin in scheduling/locale,
feeds, contract tooling, entity enrichment) fill the rest. Every candidate was deduped
against the live 462-entry catalog. Weighting: wish log > settled-payer breadth >
quote volume > deep-dive gap > coverage gap.

**Constraints honored:** every tool has a deterministic handler whose example answers
against a real upstream or pure CPU; no new Railway env vars (all upstreams keyless, or
reuse `BRAVE_API_KEY`, `COINGECKO_API_KEY`, `YAHOO_RELAY_*`, `NASDAQ_RELAY_*`); every
egress tool goes in `WALLET_ONLY_SLUGS`; prices sit inside the deep-dive competitor
bands (search $0.01–0.04, enrichment $0.06–0.28 — we deliberately undercut with keyless
upstreams, micro-feeds $0.003–0.005, scrape ~$0.0126).

## The 30 tools

| # | Slug | Price | Category | What it does | Upstream (keyless?) | Demand evidence | WALLET_ONLY | Risk |
|---|------|-------|----------|--------------|---------------------|-----------------|-------------|------|
| 1 | `contract-source` | $0.005 | crypto | Verified Solidity source + compiler metadata for a contract address (8 EVM chains) | Sourcify (keyless) | Wish log #1 cluster: solidity/smart-contract (3 hits) | y | Unverified contracts → structured "not verified" miss, not an error |
| 2 | `contract-abi` | $0.003 | crypto | Verified ABI for a contract address | Sourcify (keyless) | Wish log #1 cluster | y | Same coverage limit as #1 |
| 3 | `solidity-scan` | $0.01 | crypto | Deterministic static pattern scan of Solidity source (tx.origin, delegatecall, selfdestruct, unchecked call, reentrancy heuristics) → findings list | Pure CPU | Wish log #1 cluster ("solidity auditor") | n (PoW-eligible) | Expectation management: describe as heuristic pattern check, never "audit" |
| 4 | `calldata-decode` | $0.003 | crypto | Decode tx calldata using a supplied/fetched ABI + selector DB fallback | Pure CPU + openchain.xyz (keyless) | Deep-dive: evm-rpc siblings | y | Unknown selectors → partial decode, documented |
| 5 | `selector-lookup` | $0.002 | crypto | 4-byte function selector / event topic → known signatures | openchain.xyz signature DB (keyless) | Deep-dive: evm-rpc siblings | y | Low |
| 6 | `tx-simulate` | $0.005 | crypto | eth_call simulation + gas estimate of a prospective tx on any of our 8 chains | Public RPCs (keyless, same pool as `evm-rpc`) | Deep-dive: "tx-simulation-lite" | y | Public RPC rate limits (already managed for evm-rpc) |
| 7 | `address-label` | $0.002 | crypto | Label known addresses (exchanges, bridges, routers, token contracts) from a curated committed dataset | Pure CPU (committed dataset) | Deep-dive: "address-labels" | n (PoW-eligible) | Dataset staleness — ship a refresh script + provenance field |
| 8 | `options-chain` | $0.005 | data | Option expiries/strikes/bid-ask for a ticker | Yahoo via existing CF relay (`YAHOO_RELAY_*`) | Deep-dive micro-feeds; stock-quote = 35 distinct payers (widest wedge) | y | Relay worker needs the options path added (env unchanged) |
| 9 | `premarket-quote` | $0.003 | data | Pre/post-market price + session for a ticker | Yahoo chart `includePrePost` via relay | Deep-dive micro-feeds sibling | y | Low |
| 10 | `stock-dividends` | $0.003 | data | Dividend + split history for a ticker | Yahoo chart `events=div,split` via relay | Deep-dive micro-feeds sibling | y | Low |
| 11 | `dividend-calendar` | $0.005 | data | Upcoming ex-dividend dates market-wide by date | Nasdaq calendar via existing relay (`NASDAQ_RELAY_*`) | earnings-calendar (same upstream) has real quote volume | y | Same WAF posture as earnings-calendar (relay already solves) |
| 12 | `crypto-orderbook` | $0.003 | crypto | L2 order-book snapshot (bids/asks/spread) for a spot pair | Coinbase Exchange public API (keyless) | Deep-dive: "crypto orderbook snapshots"; crypto-price 340 quotes | y | Pair coverage limited to Coinbase-listed markets |
| 13 | `stablecoin-peg` | $0.003 | crypto | Top stablecoins' live deviation from $1 + 24h range | CoinGecko (existing `COINGECKO_API_KEY`, keyless fallback) | Payments-brand fit; crypto-price quote volume | y | Shared CoinGecko rate limit (429 retry already shipped) |
| 14 | `lei-lookup` | $0.01 | data | Legal-entity search + LEI record (name, jurisdiction, registration status, parents) | GLEIF API (keyless) | Deep-dive enrichment ($0.06–0.28 reseller band — we undercut) | y | Low; official registry |
| 15 | `wikidata-entity` | $0.005 | data | Company/person entity facts by name (aliases, founding, HQ, officers, identifiers) | Wikidata API (keyless) | Deep-dive enrichment | y | Ambiguous names → return ranked matches, deterministic ordering |
| 16 | `gravatar-check` | $0.002 | network | Email → Gravatar existence + public profile signal | gravatar.com (keyless) | Deep-dive people-enrichment | y | Signal-only (existence ≠ identity), documented |
| 17 | `github-repo` | $0.005 | data | Public repo enrichment: stars, license, topics, last push, language mix | api.github.com (keyless) | Coverage gap: dev-research agents; whois shows 8-payer domain-intel appetite | y | **Flag:** 60 req/hr/IP unauthenticated — cache aggressively; optional `GITHUB_TOKEN` would lift it (new env, owner call) |
| 18 | `favicon-grab` | $0.003 | web | Site favicon/logo → base64 data URI + declared sizes | Target site (keyless) | Deep-dive domain-enrichment sibling | y | Reuse fetch-guard (SSRF) |
| 19 | `archive-snapshot` | $0.003 | web | Latest + closest-to-date Wayback Machine snapshot for a URL | archive.org availability API (keyless) | Coverage gap: research/citation agents (skill-search-and-cite sells) | y | Low |
| 20 | `search-videos` | $0.02 | web | Brave video search (title, url, duration, thumbnail) | Brave (existing `BRAVE_API_KEY`) | search = 19 settles; completes Web/News/Images family | y | Verify subscription tier includes the videos endpoint; 503 if not enabled |
| 21 | `feed-parse` | $0.004 | web | Fetch + parse RSS/Atom → normalized JSON items | Feed URL (keyless) | Coverage gap: monitoring agents (skill-price-monitor sells); scrape band ~$0.0126 | y | Malformed feeds → lenient parser + explicit warnings array |
| 22 | `unshorten-url` | $0.002 | web | Follow a redirect chain, return final URL + every hop + status codes | Target URLs (keyless) | Scrape/safety variant; agents pre-flight links | y | SSRF — reuse fetch-guard, cap hops |
| 23 | `image-exif` | $0.003 | web | EXIF/metadata extraction from an image URL (camera, GPS, timestamps) | Image fetch + pure CPU parse | image-resize 541 quotes — image family converts | y | Stripped images → empty result, not error |
| 24 | `image-dominant-color` | $0.003 | web | Dominant colors / palette (hex + ratio) from an image | Image fetch + sharp (existing dep) | Image-family demand; pairs with color tools (16 settles) | y | Low |
| 25 | `image-crop` | $0.005 | web | Crop/rotate/flip an image, return bytes or data URI | Image fetch + sharp (existing dep) | Sibling of image-resize (541 quotes) | y | Low |
| 26 | `json-schema-infer` | $0.002 | validation | Infer a draft-07 JSON Schema from sample JSON document(s) | Pure CPU | Wish log (json-schema preflight); complements existing `json-validate` | n (PoW-eligible) | Inference is heuristic — document merge rules |
| 27 | `srt-convert` | $0.002 | conversion | SRT ↔ VTT ↔ plain text/JSON cue conversion | Pure CPU | Explicit wish ("a tool that converts srt…"); transcribe is #1 earner | n (PoW-eligible) | Low |
| 28 | `ics-parse` | $0.002 | conversion | Parse iCalendar (.ics) → JSON events (RRULE expansion capped) | Pure CPU | skill-meeting-scheduler sells; time tools settle steadily | n (PoW-eligible) | RRULE edge cases — cap expansion window |
| 29 | `public-holidays` | $0.002 | time | Public holidays by country + year (100+ countries) | Nager.Date API (keyless) | business-days converts; extends US-only holiday logic we already ship | y | Community-run upstream — retry + cache |
| 30 | `country-info` | $0.002 | data | Country facts: currency, dialing code, languages, timezones, region | restcountries.com (keyless) | Coverage gap: commerce/ops agents | y | Community-hosted mirror flaps — retry, consider committed fallback dataset |

Category totals added: crypto +9, data +8, web +7, network +1, validation +1,
conversion +2, time +1 — weighted toward the categories PostHog shows converting
(micro-feeds, web capture, domain/company intel, cheap transforms).

## The 8 skill packs

Composed only from post-Phase-2 tools (existing 370 + the 30 above). Priced in line
with the existing pack band ($0.05–$0.50), each ≥ sum of underlying + margin.

| Pack slug | The job | Composing tools | Price |
|-----------|---------|-----------------|-------|
| `skill-contract-audit` | Triage a smart contract before an agent interacts with it: source, heuristic scan, known-address check, dry-run | `contract-source` + `solidity-scan` + `selector-lookup` + `address-label` + `tx-simulate` | $0.15 |
| `skill-tx-forensics` | Explain what a transaction actually does: status, decoded calldata, labeled counterparties | `tx-status` + `calldata-decode` + `selector-lookup` + `address-label` + `evm-rpc` | $0.10 |
| `skill-market-open` | Full pre-trade snapshot for one ticker: live + pre-market quote, options surface, dividend posture, next earnings | `stock-quote` + `premarket-quote` + `options-chain` + `stock-dividends` + `earnings-calendar` | $0.12 |
| `skill-entity-enrich` | Company name → verified identity + web footprint dossier | `wikidata-entity` + `lei-lookup` + `edgar-company-lookup` + `whois` + `tech-stack` + `favicon-grab` | $0.15 |
| `skill-feed-watch` | Monitor an RSS/Atom feed: parse, extract new items, keyword them, diff against last run | `feed-parse` + `extract` + `keywords` + `text-diff` | $0.08 |
| `skill-schema-guard` | Contract-test a JSON payload: validate against schema, infer schema drift, produce a normalized diff | `json-validate` + `json-schema-infer` + `json-diff` + `json-format` | $0.05 |
| `skill-subtitle-pipeline` | Audio → finished subtitles in any format, with stats | `transcribe` + `srt-convert` + `text-stats` | $0.10 |
| `skill-locale-brief` | "Can I reach this counterparty this week?" — country facts, holidays, working days, local time | `country-info` + `public-holidays` + `business-days` + `timezone-convert` | $0.05 |

## Not selected (with reasons)

- **`json-schema-validate`** — already shipped as `json-validate` (draft-07 subset). The
  wish is a *discoverability* failure: fix `src/find.js` ranking/tags for "json schema
  validator" instead of duplicating the tool.
- **`obol` (wish)** — n=1 find-miss for a single staking protocol; no keyless
  deterministic surface; too niche for a capped catalog.
- **`bounty` (wish)** — one vague find-miss with no definable capability.
- **`token-holders` / `wallet-pnl`** — requires an indexer API key (Alchemy/Covalent
  class) — violates the no-new-env constraint.
- **`crypto-funding-rates`** — the usable keyless upstreams geo-block US datacenter
  egress; the tool could not reliably answer its own example from Railway.
- **Company firmographics (headcount/revenue)** — no keyless upstream exists since the
  Clearbit-style APIs went paid-only; the $0.06–0.28 reseller band there runs on
  licensed data. `skill-entity-enrich` covers the keyless-feasible subset.
- **`google-trends`** — no official API; scraping is nondeterministic and ToS-risky.
- **`airport-lookup`** — needs a multi-MB committed dataset for zero observed demand.
- **`pdf-form-fill`** — heavy dependencies, output renders nondeterministically across
  viewers; fails the answers-its-own-example bar.
- **Streaming STT and video generation** — excluded by the Phase 2 spec (own projects).

## Open flags for the owner

1. `github-repo` (#17) is keyless but IP-rate-limited (60/hr unauthenticated); an
   optional `GITHUB_TOKEN` env would lift it to 5k/hr — the only candidate where a new
   (optional, env-gated no-op) var is worth considering.
2. `search-videos` (#20) assumes the current Brave subscription includes the videos
   endpoint — verify with one keyed curl before implementation.
3. `options-chain` (#8) needs the Yahoo relay worker to whitelist the options path
   (code change in `workers/yfinance-relay/`, no env change).
