# agent402-openclaw

Agent402 as an [OpenClaw](https://openclaw.ai) model provider: auto-routed and
explicit frontier models at a **flat per-call price**, paid **by card** (a prepaid
credits key, no wallet) or in **USDC over x402** from a wallet. The same key and
gateway reach Agent402's 500+ pay-per-call tools.

Guide: https://agent402.tools/guides/openclaw-model-provider

## Install

```bash
openclaw plugins install agent402-openclaw
AGENT402_CREDITS_KEY=a402_... agent402-openclaw setup --write   # key by env (or `--credits-key -` on stdin); buy one by card at https://agent402.tools/credits
openclaw gateway restart
```

`setup` stores the key under `~/.openclaw/agent402/credits.key` (0600) and prints
the `openclaw.json` block; add `--write` to merge it in (`agent402/auto` becomes
the primary model). The plugin starts a loopback proxy (`127.0.0.1:8412`) that
pays Agent402 and forwards; OpenClaw only ever sees a local OpenAI-compatible URL.

No OpenClaw? `agent402-openclaw proxy` runs the proxy alone; point any OpenAI
client at `http://127.0.0.1:8412/v1` with model `auto`.

## Pay from a wallet instead

```bash
npm i @x402/fetch @x402/evm viem
export AGENT402_WALLET_KEY=0x...     # an EVM key holding USDC on Base
```

With no credits key present the proxy signs an x402 payment per call from that
wallet. The key never leaves the machine.

## Models

`auto` (routed per prompt) plus every id from `GET https://agent402.tools/v1/models`,
each routed to its home tier. Prices are per call, not per token, so OpenClaw's
per-token cost fields are zero. A model sent to the wrong tier is answered with a
400 naming the right one; nothing is charged. A client-supplied `Idempotency-Key`
is passed through (an x402 retry with the same key replays the paid answer);
without one, each call is its own payment.

The proxy answers native clients on loopback only: requests carrying a browser
`Origin` header or a non-loopback `Host` are refused, so a web page cannot spend
the key.

## Commands

- `agent402-openclaw setup [--credits-key K | --credits-key - (stdin) | AGENT402_CREDITS_KEY env] [--write] [--port N]`
- `agent402-openclaw proxy [--port N] [--upstream URL]`
- `agent402-openclaw doctor`

Zero dependencies. MIT. Maintained by Havok Holdings LLC.
