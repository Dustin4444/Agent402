# elizaos-plugin-agent402

[Agent402](https://agent402.tools) as an [elizaOS](https://github.com/elizaOS/eliza)
plugin: pay-per-call web tools (web search, page render, PDFs, OCR, market and
crypto data, SEC filings, DNS/TLS checks) your agent can find and call, paid by
prepaid card credits or in USDC over x402 or MPP. Free-tier tools pay with
proof-of-work and need neither. Agentic Finance for elizaOS agents: every paid
call is quoted before it is paid and bounded by the ceilings you set.

## Install

```bash
elizaos plugins add elizaos-plugin-agent402
# or: bun add elizaos-plugin-agent402
```

Character config:

```json
{
  "plugins": ["elizaos-plugin-agent402"],
  "settings": {
    "AGENT402_CREDITS_KEY": "a402_...",
    "AGENT402_MAX_PER_CALL_USD": "1"
  }
}
```

`AGENT402_CREDITS_KEY` is a prepaid card-credits key from
https://agent402.tools/credits (shown once, emailed). To pay from a wallet
instead, set `AGENT402_WALLET_KEY` (an EVM key holding USDC on Base) and
install the optional peers `@x402/fetch @x402/evm viem`. With neither, the
free tier still works.

## Actions

| Action | What it does | Cost |
|---|---|---|
| `AGENT402_FIND` | Plain-language task in, best-matching tools out: slug, price, whether payment is needed, a ready example input. Parameters: `task` (required), `k`. | Free |
| `AGENT402_CALL` | Runs one tool and returns its JSON. Parameters: `slug`, `params` (both optional: with neither, the tool is chosen from the message and the last `AGENT402_FIND` result, see below). Proof-of-work for free-tier tools; the credits key or wallet for wallet-only tools, never above `AGENT402_MAX_PER_CALL_USD` (default $1) or the rolling `AGENT402_DAILY_LIMIT_USD`. | $0.001 and up, quoted in every 402 |
| `AGENT402_ABOUT` | What Agent402 is, how it is paid, live tool counts. | Free |

A provider (`AGENT402`) tells the agent on every turn that the catalog exists,
how to use the two actions, and which payment mode is configured. Keys never
appear in action results or provider text.

### How `AGENT402_CALL` gets its input

In order:

1. `options.parameters` - what a 2.x runtime extracts from the planner's tool
   call and validates against the action's declared `parameters`.
2. `slug` / `params` on the message content (a test, or another plugin,
   handing a pre-shaped call).
3. The previous `AGENT402_FIND` result in the same action run.
4. The message text (the 1.x path, where the runtime hands the handler nothing
   structured): the catalog is searched (free) and the runtime's own model
   (`OBJECT_SMALL`, then `TEXT_SMALL`) is asked to pick ONE of the offered
   candidates and shape its input from their declared examples. A pick that
   names a tool that was not offered is refused, never called.

`validate()` admits every message: the planner can only choose an action the
`ACTIONS` provider lists, and that provider lists what `validate()` admits.

### What the model sees

elizaOS renders an action result's `text` (and `values`, and `error`) into the
next prompt; `data` is kept but not rendered. So the tool's COMPLETE result
JSON rides in `text`, up to `AGENT402_MAX_RESULT_CHARS` (default 12,000);
past that the text says how much was cut and that `data.result` holds it
whole. Error detail is never truncated on the way to the model (the seller's
own `error` text, up to 2,000 characters).

### Spend ceilings hold across calls

The plugin keeps ONE client per runtime for the runtime's lifetime, so
`AGENT402_DAILY_LIMIT_USD` is measured against everything that runtime has
already paid, and a settings change carries the ledger over. A refused call
sends no request. `spendingSummaryFor(runtime)` reports the ledger.

## Verified against the real runtime

`node test-runtime.js` packs this package, installs it with `@elizaos/core`,
`@elizaos/plugin-sql` and `@elizaos/plugin-bootstrap` (`latest`, or
`ELIZA_CORE_VERSION=beta` for the 2.x line), boots a real `AgentRuntime`, and
drives the runtime's own dispatcher (`processActions` on 1.x; on 2.x the
executor is not exported, so its path is mirrored with core's exported
`validateActionParams`) with a plain user message and no slug. The model is a
stub that always answers the same way (CI has no LLM); everything else is the real runtime. It
asserts: the `ACTIONS` provider lists the call action; the tool is chosen and
paid; the complete result is in the `ACTION_STATE` text the model reads next;
a $0.003 tool under a $0.005 daily ceiling settles once and is refused the
second time with no request sent; a per-call ceiling refuses with none; an
upstream error arrives whole. No wallet is funded: the paid cases run against
a stub seller with a credits key.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `AGENT402_CREDITS_KEY` | | prepaid card credits (`a402_...`) |
| `AGENT402_WALLET_KEY` | | EVM private key paying USDC over x402 |
| `AGENT402_BASE_URL` | `https://agent402.tools` | self-hosters point this at their instance |
| `AGENT402_MAX_PER_CALL_USD` | `1` | refuse any single paid call above this |
| `AGENT402_DAILY_LIMIT_USD` | | refuse once the runtime's rolling 24h paid spend would exceed this |
| `AGENT402_MAX_RESULT_CHARS` | `12000` | longest result JSON placed in the action text for the model |

Every paid call carries an `Idempotency-Key`, so a retried call replays the
paid answer instead of paying twice. What the same key buys beyond tools:
https://agent402.tools/why. Other hosts: https://agent402.tools/guides/agent-hosts.

## License

This plugin is **MIT** (Havok Holdings LLC) - see the [LICENSE](LICENSE) in this directory, which is what npm's `license` field declares. It lives in the Agent402 monorepo, whose **server** is AGPL-3.0; GitHub's repository-level license badge reports that one, not the plugin's. Every published Agent402 package (`agent402-client`, which this plugin depends on, included) is MIT the same way.
