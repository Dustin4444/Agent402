# nasdaq-relay  ⚠️ DEPRECATED — not the fix, and now the broken path

A Cloudflare Worker that proxies Nasdaq's keyless calendar endpoint. Kept
only as a fallback; the primary path is now a direct request from the
Agent402 server (see below).

## ⚠️ What was actually wrong (confirmed 2026-07-06)

The original premise here was **wrong**. Railway's egress is **not** IP-blocked
by Nasdaq. Verified by running the fetch from inside the Railway prod container
(`railway ssh`): `api.nasdaq.com` returns **HTTP 200** to a browser
`User-Agent`, and **times out** for the old `Agent402/1.0` UA. The problem was
always the **User-Agent** — Nasdaq tar-pits non-browser UAs — not the IP.

The relay only ever "worked" because it happened to send a Chrome UA. It has
since become the *broken* path: Nasdaq now blocks Cloudflare's Worker egress
IPs and returns **HTTP 520** through it, which is what took `earnings-calendar`
to 100% failure.

**The fix** was to send a browser UA and go direct (`financeUserAgent()` +
`fetchNasdaq()` direct-first in `src/tools/finance-kit.js`). This Worker is no
longer the primary path and can be retired along with the `NASDAQ_RELAY_URL` /
`NASDAQ_RELAY_TOKEN` env vars once you're confident direct holds.

(Note: `yfinance-relay` is a *genuine* IP null-route — Railway→Yahoo really does
`ETIMEDOUT` for every UA — so keep that one.)

## Surface

- **GET only** — Nasdaq's calendar API is GET; nothing else is allowed.
- **Path allowlist** — only `/api/calendar/<type>` (e.g., `earnings`).
  Refuses anything else with 403.
- **Bearer auth required** — `Authorization: Bearer <token>` must match
  the `RELAY_TOKEN` Worker secret.

## Deploy

```bash
cd workers/nasdaq-relay
npx wrangler deploy
openssl rand -hex 32 | wrangler secret put RELAY_TOKEN
```

The deploy prints a URL like `https://agent402-nasdaq-relay.<account>.workers.dev`.

## Wire it into the Agent402 server

Set two env vars on the Agent402 deployment (e.g., Railway):

- `NASDAQ_RELAY_URL` — the Worker URL (no trailing slash)
- `NASDAQ_RELAY_TOKEN` — the same value you set as `RELAY_TOKEN` above

When both are set, finance-kit routes Nasdaq calls through the relay.
When either is unset, finance-kit hits Nasdaq directly.

## Verifying

After deploy, check `/health` — the `flags.nasdaqRelay` field should
be `true`. Then call `/api/earnings-calendar` — it should return data
instead of a 504 timeout.
