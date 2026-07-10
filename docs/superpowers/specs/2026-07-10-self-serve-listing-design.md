# Self-serve listing: POST /api/index/register + submit form

**Date:** 2026-07-10
**Status:** approved design, pre-implementation
**Surfaces:** `src/x402-index.js` (register helper + seed persistence), `src/server.js` (route),
`src/stellar-page.js` (form), offline tests

## Background

The index lists sellers via discovery (Bazaar) and seeds; a seller who wants in today waits
for a crawl or opens a GitHub issue. A marketplace needs "paste your origin, appear in
minutes." x402scan's register flow is the reference UX; ours is simpler because listing is
already automatic once the crawler knows an origin.

## Endpoint: `POST /api/index/register`

Free, unpaywalled, JSON body `{ "origin": "https://example.com" }`.

**Validation (before any fetch):**
- `origin` must parse as a URL, `https:` only, no path/query/hash beyond `/`, no userinfo,
  no port other than 443, hostname contains a dot (no bare hosts), not our own origin.
- Normalize to `https://host`.
- Per-IP rate limit: 5 submissions/hour (in-memory sliding window; 429 beyond).
- Global cap: 30 new-origin submissions/hour across all IPs (429 beyond) — a public
  crawl-trigger must not become a fetch amplifier.

**Flow:**
1. Already known to the index (crawler cache) → no fetch; return current listing state.
2. Unknown → probe via the crawler's existing SSRF-guarded path (`crawlOne`, which uses
   `safeFetch` with byte caps and address guards) — never a raw fetch.
3. On successful crawl (manifest, OpenAPI, or Bazaar-fallback): persist the origin as a
   submitted seed and return the seller's snapshot entry.
4. On failed probe: do NOT persist; return `{ listed: false, error: <reason> }` with the
   crawler's honest error string.

**Response shape:** `{ listed: boolean, origin, seller?: {displayName, toolCount, networks,
routable, health}, error?: string }` — status 200 for handled outcomes, 400 for validation
failures, 429 for rate limits.

## Seed persistence

Submitted origins survive redeploys: `/data/submitted-seeds.json` (the existing persistent
volume; same pattern as stats). Load on boot into the crawler's seed set; append on
successful registration (write-through, best-effort — a write failure logs and continues).
Absent volume (self-hosters without /data): in-memory only, documented in the response? No —
silent in-memory fallback, same as stats behave.

## UI: submit form on /stellar

A "List your API" card in the Sell on Stellar section: one input + button, posting JSON to
`/api/index/register` via inline fetch script, rendering the response inline (listed →
"You're in — appearing on this page as soon as your listing is healthy"; error → the honest
error). Note under the form: listing is free and health-ranked; Stellar sellers appear here,
all sellers appear on /index. Also add the same form (or a link to /stellar's) on /index —
minimal: a link "List your API →" from /index to /stellar's form anchor is enough for v1.

## Security notes (the point of this spec)

- All outbound fetching goes through the crawler's existing `safeFetch` (SSRF guard: blocks
  private/loopback/link-local address ranges, byte caps, timeouts). The endpoint itself
  performs zero direct fetches.
- Rate limits above; validation rejects userinfo/ports/paths to keep the probe surface flat.
- The endpoint can only cause: (a) a crawl of a public https origin, (b) a seed-file append.
  No catalog, payment, or count changes. Listing grants no trust — health routing and the
  router's include rules are unchanged.
- Reject origins whose host resolves to a private range — enforced inside safeFetch already;
  the endpoint relies on that single enforcement point rather than duplicating it.

## Testing

- Offline unit tests for validation (URL shapes: http rejected, path rejected, userinfo
  rejected, port 8443 rejected, bare host rejected, self rejected) and the rate limiter
  (6th submission within the window → limited).
- Registration flow tested with an injected fake crawl function (the register helper takes
  the crawler as a dependency for tests).
- Boot check: form present on /stellar; POST with an invalid body → 400.

## Out of scope

- Accounts, API keys, dashboards.
- Verified-seller badges (ownership proofs) — later.
- Seller detail pages, seller analytics — later.
- B2 cross-seller executing router — separate project awaiting explicit scope.
