# x402 Index & Smart Order Router

Agent402 is not only a seller of 500+ tools — it's also a **routing layer for
the whole x402 ecosystem**. It crawls public x402 sellers, tracks their health,
and lets a buyer ask *"find me the cheapest healthy tool that does X"* across
every seller it knows about.

Three surfaces, all **free** (mounted outside the paywall — discovery primitives
shouldn't cost money, by the same logic as `/api/find`):

| Surface | What it returns |
|---|---|
| `GET /index` | HTML dashboard: every seller indexed, tool count, network, last-fetched time, rolling health, discovery sources |
| `GET /api/index` | JSON snapshot of the same data: per-seller `health`, `routable`, rolling `history`, totals |
| `POST /api/route` | Smart Order Router / neutral x402 discovery API: `{ query, top, include }` → top-N matching tools across sellers, ranked by match score, then health, then price. `include` = `all` (default) / `external` (exclude Agent402 itself) / `local` |
| `GET /api/leaderboard` | On-chain ranking of every seller by **Base USDC settled volume** — see [[x402-Leaderboard]] |

And one **paid** executing surface built on the same resolver:

| Surface | What it does |
|---|---|
| `POST /api/route/execute` ($0.01) | Resolve a task description (or explicit slug) to the best-matching catalog tool and run it in the same call. Returns `{result, receipt}` — the receipt names the dispatched slug, its price (capped at $0.005 underlying), and how it was resolved. Underlying tool errors pass through with their own status codes. Wallet-only. |
| `POST /api/route/execute-plus` ($0.05) | Same contract, mid budget: underlying tools priced up to $0.04 - the proportional rung, so a $0.02 tool costs $0.05 through the router rather than $0.55. |
| `POST /api/route/execute-max` ($0.55) | Same contract, top budget: underlying tools priced up to $0.50. `POST /api/route` quotes which tier a task needs via `executeVia` in its response, and a too-expensive tool returns a self-correcting 409 naming the exact tier that covers it (or its direct route). |

### External execution: run any proven x402 seller in one call

With `include: "external"`, route-execute goes beyond this host's catalog: it resolves the best **external** x402 seller for the task, pays them from Agent402's own spending wallet over x402, and relays the result. One payment from you, one request, cross-vendor settlement underneath.

The reliability filter is the point. The open x402 ecosystem is full of endpoints that answer a 402 but never deliver a paid result, so route-execute only considers sellers with **proven settled volume** (on Base: on-chain completed deliveries on the [[x402-Leaderboard]]; on Algorand: verification counts witnessed by the GoPlausible facilitator) and then probes the candidate for a live 402 before committing. External settlement is **chain-matched**: pay on Base and the router pays a Base seller from its Base spending wallet; pay on Algorand and it pays an Algorand seller from its AVM wallet — the chain you fund is the chain it spends. A payment on a chain without a spending wallet gets an honest 409 naming the supported chains, and a 4xx/5xx always cancels your settlement, so you are never charged for a failure. Relayed bodies are marked `untrustedContent` (the seller's output, not ours). Default remains local-only: external routing is an explicit opt-in.

The full walkthrough — tiers, selection mechanics, chain matching, and a real production receipt with both on-chain settlement transactions — is the [Smart Order Router guide](https://agent402.tools/guides/smart-order-router).

## How a seller gets into the Index

1. **Local catalog** — the Agent402 server's own tools are always present (no network).
2. **Operator seeds** — origins listed in the `X402_INDEX_SEEDS` env (comma-separated) get crawled every 5 minutes.
3. **Auto-discovery** — every hour, the indexer pulls public x402 registries (currently the [Coinbase CDP Bazaar](https://docs.cdp.coinbase.com/x402/docs/bazaar)) and adds new origins to the crawl set, capped at 50,000 sellers as a sanity guard. Crawls run through a worker pool with a concurrency limit (`CRAWL_CONCURRENCY = 25`) so a large seed list never floods outbound.

Each crawl fetches `<origin>/.well-known/x402` plus the seller's `openapi.json`
when present, runs every request through the SSRF guard (`safeFetch`), caps
response sizes, and records the outcome in a **rolling 5-entry history** per
seller.

## Health-aware routing

A buyer routed to a dead seller wastes money. The router takes that seriously:

- **Excluded:** a seller whose last `HEALTH_WINDOW` (5) crawl outcomes include any errors is **not routable** and is skipped by `/api/route`.
- **Brand new:** sellers with no history yet *are* routable — benefit of the doubt for newcomers.
- **Ranked:** at equal match score, healthier sellers rank first. Then cheaper wins.
- **Snapshot:** `GET /api/index` exposes every seller's `health` (0..1), `routable` flag, and rolling `history` so an operator can audit the decisions.

The unit tests for these guarantees live in [`scripts/test-router-health.js`](https://github.com/MikeyPetrillo/Agent402/blob/main/scripts/test-router-health.js)
(six scenarios, offline — they seed the in-memory cache directly via a test
escape hatch).

## Calling the router

```bash
# Default — include everything (local + crawled remotes), pick the cheapest healthy match
curl -X POST https://agent402.tools/api/route \
  -H 'content-type: application/json' \
  -d '{"query":"ocr image to text","top":5}'

# Neutral discovery: rank only OTHER x402 sellers (exclude Agent402 itself)
curl -X POST https://agent402.tools/api/route \
  -H 'content-type: application/json' \
  -d '{"query":"ocr image to text","top":5,"include":"external"}'

# Local-only escape hatch (Agent402's catalog only)
curl -X POST https://agent402.tools/api/route \
  -H 'content-type: application/json' \
  -d '{"query":"ocr image to text","top":5,"include":"local"}'
```

Returns an array of `{ seller, route, slug, name, price, health, score }` entries.
`seller` is `"self"` for the local catalog or the origin URL for remote sellers,
so a buyer can address the right seller directly. The response echoes back the
resolved `include` value (invalid values fall back to `all`).

## Why this matters — the router as the x402 front door

- **Neutral discovery layer.** `include:"external"` lets buyers explicitly route to non-Agent402 sellers. We list because we trust the ranking, not because we'd rig it for ourselves — and that makes the same endpoint usable as a public discovery API for the whole protocol, not just our catalog.
- **One integration, the whole ecosystem.** A buyer that integrates Agent402's `agent402-client` SDK or the hosted `/mcp` connector already has access to 500+ local tools *and* can route across every other x402 seller without per-seller wiring.
- **Discoverability that compounds.** Sellers don't have to register with Agent402 — appearing in any public x402 registry is enough. The Index pulls them in automatically.
- **Trust signals are checkable.** Health scores are derived from real crawl outcomes, not self-reports. The full `history` is in `/api/index` for anyone to verify. Agent402 advertises this surface in its own [`/.well-known/x402` manifest](https://agent402.tools/.well-known/x402) under the `discovery` field so other indexes and agents can find the router programmatically.

## Related

- [[Architecture]] — where the indexer sits in the request flow
- [[Operations]] — 3-rail attribution (USDC / PoW / Heartbeat) on the operator dashboard
- [[x402-Leaderboard]] — on-chain ranking using the same Bazaar walk
- [`/api/find`](https://agent402.tools/api/find) — local-only resolver (older, simpler)
