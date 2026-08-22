# Tool Catalog

> **Payment wires:** every paid endpoint accepts **x402** and **MPP** (Machine Payments Protocol) on the same 402 - see [[Paying with x402]] and [[Paying with MPP]]. Agent402 is the applied layer of [[Agentic Finance]]: agents that pay and get paid on their own.

**500+ endpoints + 100+ multi-tool [[Skill Packs|Skill-Packs]].** All deterministic - **no LLM in the serving path**: same input, same output, full input/output schemas. Discover them machine-readably (don't hardcode this page):

- [`/api/find?q={task}`](https://agent402.tools/api/find?q=extract%20article) - **resolve a plain-language task to the right tool** (route, price, schema, ready example) in one call, so an agent skips the token-heavy "search to find a tool" step. Also the `catalog.find` MCP tool on the connector.
- [`/api/pricing`](https://agent402.tools/api/pricing) - slug, route, price, category, description for everything
- [`/openapi.json`](https://agent402.tools/openapi.json) - OpenAPI 3.1 with schemas
- [`/tools`](https://agent402.tools/tools) - human-readable docs, one page per tool with a working example
- x402 Bazaar discovery extension - every 402 response self-describes

## The headline tools (wallet-only)

These exist because an agent mid-task cannot give itself a browser, a paid search index, or a disk:

| Tool | Price | What it does |
|---|---|---|
| `search` | $0.02 | Live web search over a paid index, no signup: the wallet is the credential |
| `answer` | $0.08 | Web answer with inline citations: a one-call "ask the web" the model couldn't reach otherwise |
| `render` | $0.02 | Real headless Chromium, JavaScript executed - reads SPAs that `extract` can't |
| `screenshot` | $0.015 | PNG of any public page (viewport or full-page) |
| `extract` | $0.01 | Main-article extraction → clean markdown (title, byline, word count) |
| `pdf-info`, `pdf-rotate`, `pdf-extract-pages`, `pdf-merge`, `images-to-pdf`, `pdf`, `pdf-to-markdown` | $0.002–$0.01 | Read and manipulate PDFs |
| `media-info`, `audio-convert`, `audio-normalize` | $0.005–$0.02 | Real ffmpeg: probe, transcode to mp3, EBU R128 loudness normalize |
| `memory-*` (11 tools) | $0.001–$0.003 | Durable wallet-keyed state + cross-wallet coordination. See [[Memory and Coordination]] |
| `x402-quote`, `x402-verify`, `usdc-balance`, `tx-status`, `gas-estimate`, `transfer-authorization`, `ens-resolve` | $0.002–$0.004 | **Non-custodial x402 payment toolkit** - decode 402 quotes, verify settlements, read balances/gas/tx, build EIP-3009 authorizations, resolve ENS. Multi-chain: Base, Polygon, Arbitrum, Optimism, Ethereum. See [[Payments and x402]] |
| `dns`, `meta`, `robots-check`, `email-validate`, `ip-info`, `http-check`, `tls-cert`, `sitemap`, `whois` | $0.001–$0.005 | Network truth: metadata, DNS, TLS, liveness |
| `block-number`, `chain-info`, `block-info`, `contract-code`, `erc721-owner`, `event-logs` | $0.001–$0.003 | **Chain reads**: head block and chain metadata, a block by number/hash, deployed bytecode at an address, ERC-721 `ownerOf`, and decoded `eth_getLogs` event queries. Read primitives an agent can call without running a node or holding an RPC key |
| `openapi-diff`, `openapi-lint`, `openapi-extract`, `openapi-to-curl`, `openapi-mock-response`, `openapi-search`, `openapi-validate-payload`, `openapi-redact`, `openapi-resolve-refs`, `openapi-security-summary`, `openapi-required-params` | $0.002 | **API-kit** - work an OpenAPI 3.x / Swagger 2.x spec end-to-end: find the right operation, see its effective auth, know the minimum inputs, build a runnable curl, mock a response, validate a payload, diff two versions, score agent-readiness, shrink for LLM context, inline `$ref`s |
| `fx-rate`, `gov-data`, `weather-forecast`, `weather-alerts`, `earthquakes`, `barcode-lookup` | $0.003–$0.005 | Live keyless data: ECB currency rates, data.gov datasets, NWS weather, USGS quakes, product barcode lookup |
| `stock-quote`, `stock-dividends`, `stock-history`, `earnings-calendar` | $0.003–$0.015 | **finance-kit**: price, dividend history, OHLC history, and the upcoming/recent earnings calendar for any ticker. Fresh, no API key required |
| `crypto-trending`, `crypto-global`, `crypto-price`, `crypto-market`, `crypto-history` | $0.008–$0.015 | **crypto-kit**: prices, market data, OHLC history, trending coins, total market cap. Multi-coin in one call |
| `treasury-*`, `fred-*`, `cpi-yoy`, `fed-funds`, `sahm-rule`, `yield-curve-spread`, `world-bank-*` | $0.005–$0.025 | **macro-kit**: official macro time-series from the St. Louis Fed (FRED v1 + v2 bulk release observations), the US Treasury, and the World Bank |
| `edgar-company-lookup`, `edgar-filings`, `edgar-company-concept`, `edgar-company-facts`, `edgar-xbrl-frame`, `edgar-insider-trades`, `edgar-13f-holdings`, `edgar-recent-ipos`, `edgar-search` | $0.005–$0.025 | **edgar-kit**, SEC EDGAR: ticker→CIK, filings, XBRL company facts and concepts, cross-company XBRL frames, insider Form 4, 13F holdings, recent IPOs, full-text search |
| `image-resize`, `image-convert`, `image-thumbnail`, `barcode-decode` | $0.003–$0.005 | Pure-CPU image transforms + barcode/QR decode (jimp / zxing) |

## Report products (outcome-priced, same 402)

When the job is a whole report rather than a call, the `/v1` report routes sell one finished, cited report per payment - `POST /v1/research` ($5, pro $15, max $30), `/v1/research/market-brief` ($15), `/v1/dossier` ($19, max $39), `/v1/fund` ($9, max $19), `/v1/domain-audit` ($5, pro $9), `/v1/recall-report` ($5), `/v1/insider-report` ($9), `/v1/token-risk` ($5, pro $12), and the deterministic `/v1/ipo-report` digest ($0.05). Same x402 / MPP 402 as every other route, plus prepaid card credits; people buy the same reports by card at `/reports`. Inputs, cadences and the $9/month monitors are on [[Reports, Monitors and Credits|Reports-and-Monitors]].

## The long tail (pure-CPU, also payable with compute)

200+ utilities at mostly **$0.001**: hashing/HMAC, base58/base32/base64, JWT decode+verify, UUIDs, CRC32, morse, HTML entities, `token-count` (exact OpenAI BPE), `text-chunk` (RAG), `json-validate` (JSON Schema), `jsonl`, text stats/dedupe/sort/truncate/diff (Levenshtein), JSON/CSV/YAML conversion and querying, date math and cron calculators, validators (email syntax, IP, IBAN-style checksums…), math/stats, QR codes, and **`unit-convert`** - one parametric endpoint (`POST /api/unit-convert` with `{value, from, to}`) covering every unit pair across length, mass, volume, area, speed, time, data, pressure, energy, power, angle, frequency, temperature.

Why would an agent pay $0.001 instead of writing the code? Because writing, testing, and debugging a CSV parser mid-task burns 10–100× that in tokens - and some sandboxes can't execute code at all.

## SQL execution certificates (`sql-guard` + `sql-cert-verify`)

Two tools that make "an agent is about to run this SQL against production" a checkable gate rather than a hope:

| Tool | Price | What it does |
|---|---|---|
| `POST /api/sql-guard` | $0.004 | Reviews one SQL statement against a fixed, published risk catalogue and returns a verdict (`pass` / `warn` / `block`) with the risks named (unbounded `UPDATE`/`DELETE`, tautological `WHERE`, `DROP`, `TRUNCATE`, `DROP COLUMN`, statement stacking, `COPY … FROM PROGRAM`, `GRANT`/role changes, `session_replication_role` and trigger/constraint bypass, writes to `pg_catalog`). On `pass` it also returns an **Ed25519 certificate** binding that verdict to the SHA-256 of the exact statement. |
| `POST /api/sql-cert-verify` | $0.001 | The gate your database layer calls **before** it obeys the agent. Checks the signature, the certificate version, the expiry, and that the statement's SHA-256 matches the one certified. Returns `{valid, reason, payload}` and never throws on a malformed token, so the executor always gets one uniform answer. Pass `publicKey` to verify a certificate issued by another deployment. |

Three design points worth knowing:

- **The certificate binds a hash, not a statement.** An edited statement, even by one character, no longer matches, so a certificate can't be re-pointed at different SQL.
- **Literals and comments are scrubbed before analysis**, so the word `DROP` inside a string is never a false alarm.
- **Signing is env-gated.** `SQL_CERT_SIGNING_KEY` (a PKCS8 PEM) is the signing identity. Unset, `sql-guard` still returns full verdicts and says plainly that it cannot certify. It never returns an unsigned object shaped like a certificate. Rotating the key invalidates outstanding certificates, which live 5 minutes by default.

**Honest scope:** this is a *lexical* guard over a published catalogue. It catches the shapes that destroy production data. It is not a SQL parser and cannot know that a `WHERE` clause names the wrong tenant.

## Quality guarantees

- Every endpoint is re-tested **against its own documented example** in CI before any deploy reaches production.
- Tools that can't be served honestly get removed rather than left to take money and 502 (this has happened - see [[Operations]]).
- Errors are structured: a specific message naming the invalid field, never a bare 500.
