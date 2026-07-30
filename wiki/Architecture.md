# Architecture

One Node 22 / Express process serving everything; deliberately boring where possible.

```
                      ┌──────────────────────────────────────────────┐
   agent (buyer) ───▶ │  Express                                     │
                      │   free surfaces: /, /tools, /api/pricing,    │
                      │     /openapi.json, /llms.txt, /api/stats,    │
                      │     /api/pow*, /mcp, /privacy                │
                      │   gate (per request, in order):              │
                      │     HEAD on a catalog GET ──▶ rewritten to   │
                      │              GET so no gate is skipped       │
                      │     MPP shim: Authorization: Payment ──▶     │
                      │              re-encoded as PAYMENT-SIGNATURE │
                      │     Idempotency-Key? ──▶ replay a cached     │
                      │              settled 200 for the same key    │
                      │     valid X-Pow-Solution? ──▶ bypass         │
                      │     else ──▶ x402 paywall (402 quote, then   │
                      │              handler, then verify+settle)    │
                      │   500+ tool handlers (pure fns + kits)      │
                      └──────┬───────────────┬───────────────────────┘
                             │               │
              render worker (separate     SQLite (WAL) on /data volume
              service, no secrets):       (stats · memory · pow replay)
              Playwright Chromium +
              ffmpeg (no shell)
```

The browser/media tier is a **separate service**, not in-process: when
`RENDER_WORKER_URL` + `RENDER_WORKER_TOKEN` are set (`src/worker-client.js`),
`render` / `screenshot` / the media handlers execute in a worker that holds no
payment, DB, operator, or provider secrets and has no `/data` mount, so a
Chromium or ffmpeg parser compromise from hostile input lands somewhere with
nothing worth stealing. Setting exactly one of the two fails the boot loudly;
`RENDER_WORKER_REQUIRED` refuses to boot at all without the worker. Unset both
and everything runs in-process (the self-host default).

The **MPP dual-stack shim** (`src/mpp-shim.js`, mounted when `MPP_SECRET_KEY`
is set) is pure header translation: 402s gain a `WWW-Authenticate: Payment`
challenge per allowed EVM rail, and an inbound `Authorization: Payment`
credential that HMAC-verifies is re-encoded as `PAYMENT-SIGNATURE` before the
paywall sees it. `@x402/express` keeps sole settlement authority, and every
paywall invariant (replay guard, payer attribution, settlement ordering,
idempotency) reads the same header it always did.

## Key pieces

- **Catalog as data.** Every tool is an entry `{ route, slug, price, description, discovery: { inputSchema, example }, handler }`. The paywall, docs pages, OpenAPI spec, llms.txt, sitemap, MCP servers, and CI tests are all *generated from the same catalog* - one source of truth, so a new tool is automatically priced, documented, discoverable, and tested.
- **Payments** (`src/payments.js`): `@x402/express` middleware quoting USDC on Base, Solana, Polygon, Arbitrum, Monad, Celo, Avalanche, Sei, Optimism, Stellar & Algorand. **No single facilitator covers all twelve rails.** Each chain is routed to the facilitator that actually settles it: the **Coinbase CDP facilitator** (`CDP_API_KEY_ID/SECRET`; `FACILITATOR_URL` overrides) settles **Base only**; **PayAI** is primary for Solana, Polygon, Arbitrum, Avalanche and Sei; **Solvador** is primary on Optimism (keyed, network-filtered); Stellar (OpenZeppelin), Algorand (GoPlausible), Monad, Celo and Robinhood Chain each ride their own dedicated facilitator. `PAYMENT_SETTLE_FALLBACK=true` adds a last-resort re-settle chain (PayAI, then Solvador) for a primary that rejects settlement *before* broadcasting, never on a timeout or 5xx, so it cannot double-settle. Multi-chain USDC schemes are registered in code. Monad (EVM chain id 143, native Circle USDC) is opt-in via `PAYMENT_NETWORKS=…,monad` and settles through its own dedicated facilitator (`MONAD_FACILITATOR_URL`, default the molandak-operated public facilitator) since CDP/PayAI don't advertise `eip155:143`. Celo (EVM chain id 42220, native Circle USDC) is likewise opt-in via `PAYMENT_NETWORKS=…,celo` and settles through the Celo-operated facilitator (`CELO_FACILITATOR_URL`, default `api.x402.celo.org`). Avalanche (43114) and Sei (1329) are opt-in the same way and settle through PayAI with on-chain-verified USDC domains (money parsers in code). Optimism (10) is opt-in via `PAYMENT_NETWORKS=…,optimism` and settles through the Solvador facilitator (keyed, `SOLVADOR_KEY`; its per-settlement fee is priced into the chain's quotes via `NETWORK_PRICE_PREMIUMS`). Robinhood Chain (USDG / Global Dollar, chain id 4663) settles through an operator-supplied facilitator (`ROBINHOOD_FACILITATOR_URL`) with a custom USDG money parser.
- **Proof-of-work** (`src/pow.js`): HMAC-signed challenges, difficulty 16 bits, single-use (replay table in SQLite), strictly slug-scoped. A `WALLET_ONLY_SLUGS` set keeps anything that costs real money out of the free tier.
- **Browser tools** (`src/tools/render.js`, executed in the render worker): a shared headless Chromium with max 3 concurrent contexts, self-healing relaunch on crash, and per-request SSRF re-validation of *every* subresource the page loads (see [[Security Model]]).
- **Media tools** (same worker): ffmpeg via `execFile` (no shell), 30 MB cap, 90 s timeout, max 2 concurrent with `429 + Retry-After`.
- **Remote MCP** (`src/mcp-http.js`): stateless streamable-HTTP endpoint mounted *before* the paywall; it meters itself (free set + per-IP rate limit) and feeds the same stats counters.
- **x402 Index + Router** (`src/x402-index.js`): a free, in-memory aggregation layer. Crawls the local catalog + operator seeds + auto-discovered sellers (from public x402 registries, refreshed hourly) every 5 minutes via `safeFetch`. Every crawl outcome lands in a rolling 5-entry history per seller; the Smart Order Router (`POST /api/route`) skips sellers whose recent history shows errors, and tiebreaks on health then price. Public surfaces: `/index` (HTML), `/api/index` (JSON), `/api/route` (router). See [[x402-Index-and-Router]].
- **State**: SQLite (better-sqlite3, WAL) on a Railway persistent volume at `/data` - stats, memory namespaces, PoW replay protection all survive redeploys.
- **Shutdown**: SIGTERM drains in-flight requests before exit, because a hard kill would take an agent's money and return nothing.

## Design positions

- **No LLM in the serving path.** Determinism is the product: schemas, flat prices, reproducible outputs.
- **Payment is identity.** No accounts means no credential database, no signup abuse surface, and memory ownership falls out of the payment protocol for free.
- **Charge-then-fail is unacceptable.** Get the ordering right: the installed `@x402/express` runs the **handler first and settles afterwards**, and it settles **only** a response whose `statusCode` is `< 400`. Any `4xx`/`5xx` (a bad input, a capacity `503`, an upstream `502`) **cancels settlement**, so the buyer is never charged for a failure. A `200` is charged only if settlement then succeeds; if settlement of a `200` fails, the buffered body is discarded and the caller gets a `402` instead. Two consequences the code depends on: anything that caches, credits, or bills must key off the **final, post-settlement** response (`res.on("finish")` with `statusCode === 200`), never the handler's own status; and a tool that cannot be served reliably (e.g. upstreams that block datacenter IPs) gets removed from the catalog rather than monetized, because a steady stream of cancelled settlements is a broken product even though nobody was billed.
