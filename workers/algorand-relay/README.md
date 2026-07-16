# agent402-algorand-relay

Cloudflare Worker that proxies Nodely's keyless Algorand **algod** and
**indexer** APIs. Exists because Nodely returns HTTP 403 to Railway's shared
egress IP range (verified in-container 2026-07-16, any User-Agent) — and both
of the server's direct fallback hostnames are the same provider, so endpoint
walking can't recover. Routing through Cloudflare moves the egress to CF's IP
range. Same pattern as `../yfinance-relay` and `../nasdaq-relay`.

## Surface

- `GET /algod/v2/*` → `https://mainnet-api.4160.nodely.dev/v2/*`
- `GET /idx/v2/*` → `https://mainnet-idx.4160.nodely.dev/v2/*`
- Everything else 403s (not a general-purpose proxy).
- Auth: `Authorization: Bearer <RELAY_TOKEN>` (Worker secret), 401 otherwise.

## Deploy

```sh
npx wrangler deploy
npx wrangler secret put RELAY_TOKEN   # any long random string
```

Then set on Railway (both required; unset pair = direct Nodely, which works
everywhere except Railway):

- `ALGORAND_RELAY_URL` — the workers.dev URL printed by deploy
- `ALGORAND_RELAY_TOKEN` — the same token

Consumers: `src/revenue-live.js` (balance card + 30-day activity on /revenue)
and `src/revenue-ledger.js` (all-time sync). Both walk the relay FIRST, then
the direct Nodely bases.
