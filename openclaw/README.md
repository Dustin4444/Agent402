# agent402-openclaw

Agent402 as an [OpenClaw](https://openclaw.ai) model provider: auto-routed and
explicit frontier models at a **flat per-call price**, paid **by card** (a prepaid
credits key, no wallet) or in **USDC over x402** from a wallet. The same key and
gateway reach Agent402's 500+ pay-per-call tools.

Guide: https://agent402.tools/guides/openclaw-model-provider

## Install

```bash
openclaw plugins install agent402-openclaw
AGENT402_CREDITS_KEY=a402_... npx agent402-openclaw setup --write   # key by env (or `--credits-key -` on stdin); buy one by card at https://agent402.tools/credits
openclaw gateway restart
```

(`openclaw plugins install` copies the plugin into `~/.openclaw/extensions` and
does not link its CLI, hence `npx`.) `setup` stores the key under
`~/.openclaw/agent402/credits.key` (0600) and prints the `openclaw.json` block;
add `--write` to merge it in. The primary model it writes is the cheapest
metered model that can hold OpenClaw's own prompt: OpenClaw sends roughly 70k
characters of system prompt and tool schemas before your first word, and the
routed `auto` tier caps input at 16k, so `auto` stays listed for short one-off
prompts but is never made primary (OpenClaw would refuse every turn as a
context overflow). The plugin starts a loopback proxy (`127.0.0.1:8412`) that
pays Agent402 and forwards; OpenClaw only ever sees a local OpenAI-compatible URL.

Tested in CI against a real `openclaw@latest` install: plugin install, setup,
model listing, gateway boot and one agent turn (`test-real-install.js`).

No OpenClaw? `agent402-openclaw proxy` runs the proxy alone; point any OpenAI
client at `http://127.0.0.1:8412/v1` with model `auto`.

## Pay from a wallet instead

```bash
npm i @x402/fetch @x402/evm viem
export AGENT402_WALLET_KEY=0x...     # an EVM key holding USDC on Base
```

With no credits key present the proxy signs an x402 payment per call from that
wallet. The key never leaves the machine.

## Models and pricing

`auto` (routed per prompt, flat $0.01/call) plus every id from
`GET https://agent402.tools/v1/models`. Explicit models are **metered by default**:
the proxy sends them to the gateway's metered route, where each request is quoted
from its body (exact-BPE input plus your `max_tokens` at the model's list price,
times 1.15, from $0.001, capped at $2 per call), so a short call costs a fraction
of a cent and a long one pays for what it asks. `--flat` (or
`AGENT402_PRICING=flat`) keeps every model on its flat per-call tier instead.
Either way OpenClaw's per-token cost fields stay zero; the price is per call. A model sent to the wrong tier is answered with a
400 naming the right one; nothing is charged. A client-supplied `Idempotency-Key`
is passed through (an x402 retry with the same key replays the paid answer);
without one, each call is its own payment.

The proxy answers native clients on loopback only: requests carrying a browser
`Origin` header or a non-loopback `Host` are refused, so a web page cannot spend
the key.

## Commands

- `agent402-openclaw setup [--credits-key K | --credits-key - (stdin) | AGENT402_CREDITS_KEY env] [--write] [--port N] [--flat]`
- `agent402-openclaw proxy [--port N] [--upstream URL]`
- `agent402-openclaw doctor`

Zero dependencies. MIT. Maintained by Havok Holdings LLC.
