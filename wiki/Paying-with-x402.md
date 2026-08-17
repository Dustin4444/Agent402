# Paying with x402 (USDC)

[x402](https://x402.org) is an open HTTP payment standard (the `402 Payment Required` status, finally used). Settlement infrastructure exists from **Coinbase** (CDP facilitator — what this service uses) and **Stripe**.

## The flow

1. Client calls a paid endpoint.
2. Server replies `402` with a machine-readable quote: price, asset (USDC), network (`eip155:8453` = Base mainnet), and the pay-to address.
3. Client signs a USDC `transferWithAuthorization` from its own wallet (no gas needed — the facilitator sponsors it) and retries with the payment header.
4. Facilitator verifies + settles on-chain; the server serves the result. End-to-end this is seconds.

The payer needs **only USDC on Base, Solana, Polygon, Arbitrum, Monad, Celo, Avalanche, Sei, Optimism, Stellar, or Algorand** — no ETH, no account, no API key. (Sellers can also settle **USDG on Robinhood Chain** when the operator enables it.)

## JavaScript (x402 v2 SDKs)

```js
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(process.env.AGENT_KEY) });
const payFetch = wrapFetchWithPayment(fetch, client);

const res = await payFetch("https://agent402.tools/api/extract", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url: "https://example.com/article" }),
});
console.log(await res.json());
```

## Paying over MPP instead (dual-stack)

Every paid endpoint also speaks **MPP** (Machine Payments Protocol — the
IETF-track `Payment` HTTP auth scheme from [tempoxyz/mpp](https://github.com/tempoxyz/mpp)),
and now offers TWO MPP methods: `evm` (below, same URL, same price, same
on-chain USDC settlement as x402, just a different HTTP dialect) and `tempo`
(native settlement via [Tempo](https://tempo.xyz)'s own relay, TIP-1034/
TIP-20, no x402 facilitator, a genuinely different mechanism; use
`tempo.charge` from `mppx/client` the same way `evm.charge` is used below).
MPP responses add a signed `Payment-Receipt` header either way. With the
reference [`mppx`](https://www.npmjs.com/package/mppx) client:

```js
import { Fetch, evm } from "mppx/client";
import { privateKeyToAccount } from "viem/accounts";

const payFetch = Fetch.from({
  methods: [evm.charge({
    account: privateKeyToAccount(KEY),
    currencies: [evm.assets.base.USDC],
    maxAmount: "1.00",
  })],
});
const res = await payFetch("https://agent402.tools/api/uuid"); // 402 -> sign -> paid retry -> 200
console.log(res.headers.get("payment-receipt"));               // signed MPP receipt
```

The buyer's client picks the dialect: mppx prefers the native MPP challenge and
pays via `Authorization: Payment`; x402 clients keep using `PAYMENT-SIGNATURE`.
An MPP `evm`-method buyer and an x402 buyer settle the identical EIP-3009
authorization; an MPP `tempo`-method buyer settles via Tempo's own relay
instead - different mechanism, same price.

## Command line: Stripe's `purl`

Stripe's open-source [purl](https://github.com/stripe/purl) ("curl for paid endpoints") works against Agent402 out of the box — our CI proves it on demand with a real settled payment:

```bash
purl wallet add --name me --type evm -k 0xYOUR_KEY -p yourpass --set-active=true
purl --dry-run "https://agent402.tools/api/dns?name=example.com&type=A"  # see the quote
purl "https://agent402.tools/api/dns?name=example.com&type=A"            # pay + get result
```

## Spend controls

Client-side caps belong on the buyer:

- **purl:** `PURL_MAX_AMOUNT` (atomic units; 1000 = $0.001 USDC).
- **agent402-mcp:** `AGENT402_MAX_PER_CALL` (refuse any single call above this USD price) and `AGENT402_BUDGET` (hard session cap) — both enforced **before** a payment is signed, so a confused model cannot drain the wallet.

## Verifying you weren't cheated

Every settled call is an on-chain USDC transfer to **`agent402.base.eth`** (a Base name resolving to the public revenue wallet) — auditable by anyone at [Basescan](https://basescan.org/address/0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0#tokentxns). The service also publishes served-call counters at [`/api/stats`](https://agent402.tools/api/stats); the chain, not the counter, is the source of truth.
