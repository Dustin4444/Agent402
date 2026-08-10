# agent402-mcp

MCP server for [Agent402](https://agent402.tools) - a catalog of **500+: 400+ pay-per-call web tools + 100+ curated multi-tool skill packs** for AI agents (every one tested, priced, and settled on-chain; every one earns its place), paid per call in USDC via the [x402 protocol](https://www.x402.org), or **with compute (proof-of-work)** when no wallet is configured. Built by [Havok Holdings LLC](https://github.com/MikeyPetrillo/Agent402).

Your agent gets browser rendering, screenshots, PDF text extraction, URL→markdown, live web search **+ web answers with citations**, live **financial/crypto/macro data** (Yahoo stock quotes, CoinGecko, FRED, ECB FX, World Bank, yield curve), **SEC EDGAR filings** (10-K/10-Q text, XBRL, insider, 13F, IPO calendar), **deterministic stats & forecasting** (Pearson correlation, OLS, Holt-Winters), **compression** (gzip/brotli), DNS/TLS/WHOIS + email-deliverability checks, wallet-keyed shared memory, and 200+ deterministic pure-CPU utilities - plus 100+ **skill packs** like `security-audit`, `trend-analysis`, `structured-scrape`, `decode-blob`, and `forecasting-bake-off` callable as MCP prompts. Payment handled invisibly underneath the MCP calls. No signup, no API key.

## Quick start

**Zero install (hosted connector):** add `https://agent402.tools/mcp` as a remote
MCP server - e.g. claude.ai → Settings → Connectors → Add custom connector. The
pure-CPU tools run free there (rate-limited); for the full catalog and no rate
limit, run this package locally with a wallet:

With a funded wallet (USDC on Base, Polygon, Arbitrum, Monad, or Solana, or USDG on Robinhood Chain - the underlying service accepts 12 chains in total, but this package currently signs only EVM and Solana payments) - every tool available:

```json
{
  "mcpServers": {
    "agent402": {
      "command": "npx",
      "args": ["-y", "agent402-mcp"],
      "env": { "AGENT_KEY": "0xYOUR_PRIVATE_KEY" }
    }
  }
}
```

Without a wallet - the 200+ pure-CPU tools work free via proof-of-work (the network/browser/memory tools will ask for a wallet):

```json
{
  "mcpServers": {
    "agent402": { "command": "npx", "args": ["-y", "agent402-mcp"] }
  }
}
```

Claude Code: `claude mcp add agent402 -- npx -y agent402-mcp`

## How it works

- On startup the server reads the live catalog from `https://agent402.tools/api/pricing` + `/openapi.json`.
- **Flagship tools** (`search`, `answer`, `search-news`, `render`, `stock-quote`, `transcribe`, `memory-read`, `memory-write`) are exposed as first-class MCP tools - search/answer is the front door. Override the set with `AGENT402_TOOLS`.
- The rest of the 500+ endpoint catalog is reachable via `find_tool` / `search_tools` + `call_tool` - keeping your context window small.
- When a call hits HTTP 402: with a wallet key set (`AGENT_KEY` for the EVM chains - Base/Polygon/Arbitrum/Monad plus Robinhood Chain, `SOLANA_AGENT_KEY` for Solana), the server signs an x402 payment on a chain the seller accepts and retries; without a key it solves the tool's proof-of-work challenge (~0.2 s of CPU) on the eligible tools. (The service settles USDC on Base, Solana, Polygon, Arbitrum, Monad, Celo, Avalanche, Sei, Optimism, Stellar and Algorand, plus USDG on Robinhood Chain - 12 chains total - for callers using a raw x402 client rather than this package.)
- `payment_info` tells the model which mode it's in and what a wallet would unlock.
- `top_x402_sellers` returns the live x402 leaderboard - which sellers are settling the most USDC (primarily on Base) in the last ~24h, derived from on-chain transfers. Free to call (no payment, no proof-of-work). Useful for agents discovering the wider x402 economy beyond this single service's catalog.
- `route_and_execute` reaches tools **outside** this catalog in one call: give it a plain-language `task` and Agent402 resolves a proven external x402 seller (one with real on-chain settled volume), pays that seller on your behalf, and relays the result marked `untrustedContent`. Wallet-only. Flat routing fee, cheapest covering tier chosen from `maxUsd`:

  | Underlying seller price | Fee | Route |
  | --- | --- | --- |
  | ≤ $0.005 | $0.01 | `POST /api/route/execute` |
  | ≤ $0.04 | $0.05 | `POST /api/route/execute-plus` |
  | ≤ $0.50 | $0.55 | `POST /api/route/execute-max` |

  A tool priced above the tier's ceiling returns a self-correcting 409 naming its direct route.

## Workflows (skill packs)

For jobs that no single tool covers (e.g. "audit a domain", "build a stock
brief"), Agent402 ships curated multi-tool **skill packs**. They're surfaced
as standard MCP **prompts**, so any MCP-aware client picks them up
automatically:

- `prompts/list` returns each pack with typed arguments.
- `prompts/get { name: "<slug>", arguments: { … } }` returns the rendered
  task template - a Claude-ready plan with the chosen tools wired in.
- `search_tools` also surfaces matching workflows alongside individual tools,
  so a task-shaped query points the agent at the right plan, not just the
  raw tools.

## Configuration

| env | default | meaning |
| --- | --- | --- |
| `AGENT_KEY` | _(unset)_ | Hex private key of an EVM wallet funded with USDC on Base (or Polygon/Arbitrum/Monad), or USDG on Robinhood Chain. |
| `SOLANA_AGENT_KEY` | _(unset)_ | Base58 secret key (or JSON byte array) of a Solana wallet funded with USDC on Solana. |
| `AGENT402_URL` | `https://agent402.tools` | Target service (point at your own deployment). |
| `AGENT402_TOOLS` | curated set | Comma-separated slugs to expose as first-class tools. |
| `AGENT402_MAX_PER_CALL` | unlimited | Refuse any single call priced above this many USD (e.g. `0.01`). |
| `AGENT402_BUDGET` | unlimited | Hard cap on total USDC spent per session (e.g. `1.00`). |
| `AGENT402_NETWORKS` | _(unset)_ | Restrict + order the chains to pay on - e.g. `robinhood` (USDG on Robinhood Chain), `base,solana`, or a raw CAIP-2 like `eip155:4663`. Unset = the client picks (effectively Base on multi-chain sellers). |

Spend controls are enforced **before a payment is signed** - a runaway model is
refused, not billed. `payment_info` reports the caps, what's been spent, and
what remains. With neither key set, the server runs in proof-of-work mode
(pure-CPU tools stay free). Use dedicated low-value wallets for `AGENT_KEY` /
`SOLANA_AGENT_KEY`, funded only with what you intend to spend. Most tools cost
$0.001–$0.02; the priciest single tool is $0.55 (`route-execute-max`) and
multi-tool skill packs run up to $1.50, so set `AGENT402_MAX_PER_CALL` if you
want a hard per-call ceiling.

## Test

From the repo root: `node mcp/test.js` (boots a local paywalled instance and drives the MCP server with a real client; the proof-of-work path settles real challenges).

## Legal

Use of the hosted instance at agent402.tools is subject to its [Terms of Service](https://agent402.tools/terms) (acceptable-use policy included) and [Privacy Policy](https://agent402.tools/privacy). This package is MIT-licensed; the hosted server is AGPL-3.0. Both are provided as-is without warranty, and self-hosted deployments are their operator's responsibility.
