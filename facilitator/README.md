# agent402-facilitator

Open-source, self-hostable x402 facilitator for Stellar. Verify and settle
`exact`-scheme USDC payments on Soroban yourself, with correct on-chain
settlement confirmation. No third-party facilitator, no signup.

**Status: Phase 1 — testnet only.** This wires the official
[`@x402/core`](https://www.npmjs.com/package/@x402/core) orchestration to the
official [`@x402/stellar`](https://www.npmjs.com/package/@x402/stellar)
facilitator scheme, which already implements Soroban simulation/auth-entry
validation and on-chain settlement confirmation internally — this package is
glue, not a payment protocol reimplementation. The network is hardcoded to
`stellar:testnet`; there is no code path to mainnet yet.

## Why

Third-party Stellar facilitators can report a settlement failure moments
before the transfer actually confirms on-chain — Stellar closes ledgers
about every 5 seconds, and a facilitator's own timeout can fire just before
that close. That's a buyer charged and told they weren't. Running your own
facilitator means you control that reliability directly.

## Install

```bash
cd facilitator
npm install
```

## Run

```bash
FACILITATOR_STELLAR_SECRET=S... npm start
```

- `FACILITATOR_STELLAR_SECRET` — required. The facilitator's own Stellar
  secret seed (starts with `S`). This account pays transaction fees for
  every settlement — generate a fresh testnet keypair and fund it for free
  via [Friendbot](https://friendbot.stellar.org/?addr=YOUR_PUBLIC_KEY).
  **Testnet only in this phase — never put a mainnet secret here.**
- `PORT` — optional, defaults to `4021`.
- `FACILITATOR_AUTH_TOKEN` — optional. When set, `/verify`, `/settle`, and
  `/supported` all require `Authorization: Bearer <token>`. When unset, those
  three endpoints are open (permissive default for local/dev use — a clear
  warning is logged at startup so this is never silently invisible).
- `FACILITATOR_ALLOWED_PAYTO` — optional, comma-separated Stellar addresses.
  When set, `/verify` and `/settle` reject any payment whose `payTo` isn't on
  the list, before doing any simulation work. When unset, any `payTo` is
  accepted (same startup-warning treatment as auth) — worth knowing an open
  facilitator can otherwise be used by anyone as a free Stellar gas sponsor.
- `FACILITATOR_LOW_BALANCE_XLM` — optional, default `5`. Threshold for the
  `low` flag on `GET /health`.

The server exposes the three standard x402 facilitator endpoints —
`GET /supported`, `POST /verify`, `POST /settle` — plus an always-open,
unauthenticated `GET /health` (`{ signerAddress, xlmBalance, low }`) for
external monitoring. `/settle` calls are serialized internally: the
facilitator's single signer account has one Stellar sequence number, and
concurrent settlements racing on it is a real failure mode (proven live —
see `test.js` step 10), not a theoretical one.

## Running the tests

```bash
npm test
```

The facilitator's own signer is generated fresh and funded automatically
every run (XLM only, free via Friendbot — no manual step). The **payer**
account is different: it needs to actually hold testnet USDC, and Circle's
testnet faucet is CAPTCHA-gated in the browser, so it can't be scripted.
Set up a persistent payer account once:

1. [Stellar Laboratory](https://lab.stellar.org/account/create) → generate a
   keypair → fund it with Friendbot. Copy the `Secret` key.
2. [Fund Account](https://lab.stellar.org/account/fund) → paste your public
   key → Add USDC Trustline → sign with your secret key.
3. [Circle Faucet](https://faucet.circle.com/) → select Stellar (testnet) →
   request USDC to that public key.

Then run the tests with:

```bash
TEST_PAYER_STELLAR_SECRET=S... npm test
```

The test spawns the real server, builds and signs a real testnet payment,
drives it through `/verify` and `/settle`, and independently confirms via
Horizon that the transaction actually landed — the step that proves the
whole point of this package.

## License

MIT
