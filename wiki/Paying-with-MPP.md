# Paying with MPP

**MPP** (Machine Payments Protocol) is the open, IETF-track HTTP payment scheme co-authored by Tempo and Stripe: the server answers `402` with `WWW-Authenticate: Payment`, the client replies with `Authorization: Payment`, and a settled response carries a signed `Payment-Receipt`. Spec and tooling: [tempoxyz/mpp](https://github.com/tempoxyz/mpp) · [mpp.dev](https://mpp.dev) · client/server library [`mppx`](https://www.npmjs.com/package/mppx).

Every paid endpoint on Agent402.Tools is **dual-stack**: the same 402 carries an x402 offer *and* an MPP challenge. Same URL, same price - the buyer's client picks the wire.

## What settles, where

| MPP method | Asset | Where it settles | Notes |
|---|---|---|---|
| `evm` charge | USDC | Base, Celo | Same EIP-3009 on-chain settlement as x402, translated by the shim; verifiable on Basescan/Celoscan |
| `tempo` charge | PathUSD | Tempo (chain 4217) | Native TIP-20 settlement through Tempo's hosted MPP relay, no x402 facilitator involved |

The [MPP marketplace](https://agent402.tools/mpp-marketplace) lists other MPP sellers we can verify live, and the [revenue page](https://agent402.tools/revenue) shows every MPP-wire settlement per rail with explorer links.

## JavaScript (mppx)

```js
import { Mppx, tempo, evm } from "mppx/client";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.AGENT_KEY);
// Offer both methods; the client picks the one the 402 advertises that it can pay.
const client = Mppx.create({ methods: [tempo.charge({ account }), evm.charge({ account })] });

const res = await client.fetch("https://agent402.tools/api/uuid");
console.log(res.status, res.headers.get("payment-receipt"));
console.log(await res.json());
```

For `evm` you need USDC on Base or Celo in the paying wallet; for `tempo` you need PathUSD on Tempo mainnet. No API key, no signup: the wallet is the account.

## Verifying a settlement

- `evm`: the `Payment-Receipt` reference is the on-chain tx hash on Base or Celo.
- `tempo`: the reference is the Tempo tx hash, viewable at `https://explore.tempo.xyz/tx/<hash>`.
- Aggregate, machine-readable: [`/api/revenue/mpp`](https://agent402.tools/api/revenue/mpp) (counts, per-rail hashes, no buyer data).

## Accepting MPP on your own API

If you already speak x402, MPP can be added without touching settlement: emit an additional `WWW-Authenticate: Payment` challenge derived from your existing offer, and re-encode inbound `Authorization: Payment` credentials into your existing verification path. Agent402's implementation is open source in this repository (`src/mpp-shim.js` for the evm translation, `src/mpp-tempo.js` for native Tempo). Set `MPP_SECRET_KEY` to enable the shim on your own instance and `TEMPO_API_KEY` (plus a recipient) to offer native Tempo.

## Related

- [[Paying with x402]] - the other wire on the same 402
- [[Paying with Compute]] - the free proof-of-work tier
- [What is MPP](https://agent402.tools/what-is-mpp) - the longer explainer
