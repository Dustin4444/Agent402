# /stellar — the Stellar x402 marketplace page

**Date:** 2026-07-10
**Status:** approved design, pre-implementation
**Surfaces:** new `src/stellar-page.js` + a route in `src/server.js`; no new state, no new crawlers

## Background

No Stellar-side x402 marketplace or directory exists (verified 2026-07-10 across
stellar.org/x402, the official Stellar docs, `stellar/x402-stellar`, and an X sweep).
Agent402 already runs the machinery a marketplace needs: the x402 Index (health-routed
seller discovery, `src/x402-index.js`), a Smart Order Router with a **working
`?network=` filter** (`/api/route?q=…&network=stellar`), per-tool `networks` recorded
from discovery `accepts`, and live Stellar settlement receipts via `stellarRail()`
(`src/revenue-live.js`). This page is the face on top of that machinery: it claims the
"Stellar x402 marketplace" position with real data on day one and grows automatically
as Stellar sellers appear in discovery.

## Decision

Approach chosen: **live page backed by the existing index** (rejected: static
marketing page — hollow claim; full sub-marketplace with onboarding/executing router —
that is the separate B2 project, premature until external Stellar sellers exist).

## Page: `GET /stellar`

Free, unpaywalled, server-rendered in the ledger chrome (`ledgerShell`), canonical
`https://agent402.tools/stellar`.

**Title:** `The Stellar x402 marketplace — pay-per-call tools for AI agents` (the
phrase "Stellar x402 marketplace" appears verbatim in title, h1, and meta description;
that query currently has zero competition).

### Sections

1. **Hero + live proof.** One-line pitch, then receipts: the most recent real Stellar
   settlement from `stellarRail()` (amount + stellar.expert tx link + time) and a line
   noting the daily paid canary settles USDC on Stellar (wallet
   `GDNJ…WWRL`, facilitator OpenZeppelin). If Horizon is unreachable at render time,
   show "live receipts temporarily unavailable" — never a stale or invented receipt.
2. **Browse Stellar-payable tools.** Rendered from the live index snapshot filtered to
   tools whose `networks` include a `stellar:`-prefixed entry OR that belong to the
   local catalog (every local tool settles on Stellar — the 402 challenge offers
   `stellar:pubnet` when `PAYMENT_NETWORKS` includes stellar). Grouped by category,
   showing name, price, seller. Cap the visible list (top ~12 categories, "N more"
   rollups) — the page is a storefront, not a dump; `/tools` remains the full catalog.
   Machine pointer: `GET /api/route?q=<task>&network=stellar` shown as a copyable
   snippet.
3. **Sellers settling on Stellar.** Every index seller (local + crawled) with ≥1
   stellar-network tool: display name, homepage, tool count, health state — the same
   fields the index page renders. HONESTY RULE: while Agent402 is the only entry, the
   section says so plainly ("1 seller live — discovery is open, external sellers are
   added automatically") rather than dressing the count up.
4. **Sell on Stellar.** How a seller gets listed: implement x402 with a
   `stellar:pubnet` accept (facilitator: OpenZeppelin at channels.openzeppelin.com/x402;
   SDK `@x402/stellar`; or `agent402-tollbooth` for site owners), serve
   `/.well-known/x402`, and the index crawler picks them up — listing is automatic and
   free, ranking is health-based. Link the seed-request path (GitHub issue) for
   origins that want a guaranteed crawl.
5. **Machine-readable footer.** Links: `/api/route?network=stellar`,
   `/.well-known/x402`, `/openapi.json`, `/api/reliability`, this page's JSON-LD.

### SEO

- JSON-LD: `CollectionPage` + `OfferCatalog` (aggregate offer over the Stellar-payable
  tools, low/high price from the live snapshot).
- Meta description ≤160 chars containing "Stellar x402 marketplace" and "USDC".
- Added to the sitemap's static-page list and the site nav footer (where /economy,
  /leaderboard live). IndexNow re-submission happens automatically on deploy.

## Data flow

`stellarPage(baseUrl, { snapshot, rail })` is a pure renderer:

- `snapshot` = the existing index snapshot (`indexSnapshot()` / the same source
  `/index` uses). Filtering helper `stellarTools(snapshot)` and `stellarSellers(snapshot)`
  are exported pure functions (unit-testable offline with a fixture snapshot).
- `rail` = `stellarRail(wallet)` result, fetched at request time with the same
  cache/timeout discipline the /revenue page uses; `null` renders the unavailable line.
- No new persistent state, no new intervals, no schema changes.

## Testing

- Offline unit test (`scripts/test-stellar-page.js`): fixture snapshot with (a) local
  tools, (b) an external seller with a stellar network, (c) an external seller without
  one → `stellarTools`/`stellarSellers` include exactly (a)+(b); rendered HTML contains
  the title phrase, the honesty line when sellers==1, the JSON-LD block, and the
  route-filter snippet; `rail: null` renders the unavailable line, a fixture rail
  renders the tx link.
- Wire the test into deploy.yml's offline test steps.
- The page is a free surface — no WALLET_ONLY/pow changes, no tool-count changes
  (sync-count untouched).

## Out of scope

- B2 cross-seller executing router (payments through us for external sellers).
- Seller onboarding forms/accounts — discovery-based listing only.
- A separate domain or brand; this lives at agent402.tools/stellar.
- Any change to ranking/health logic — the page consumes the index as-is.
