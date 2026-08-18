# agent402-client

A tiny buyer-side client for [Agent402](https://agent402.tools) (and any Agent402
instance). **Resolve a task to a tool, then call it — with payment handled for
you.** Free pure-CPU tools settle with a built-in proof-of-work (no wallet, zero
dependencies); wallet-only tools settle via an x402-wrapped fetch you provide.
Results are cached, and retries reuse an `Idempotency-Key` so a lost response
never double-charges.

```bash
npm install agent402-client
```

Runnable copy of the free-tier quickstart below: [`examples/hello-agent402.js`](https://github.com/MikeyPetrillo/Agent402/blob/main/examples/hello-agent402.js) — discover a tool and call it in ~15 lines, no wallet.

## Free tier (proof-of-work, no wallet)

```js
import { Agent402 } from "agent402-client";

const a = new Agent402();                       // → https://agent402.tools

// Don't know the slug? Resolve a task in one call.
const matches = await a.find("extract the article from a url");
// → [{ slug: "extract", route, price, inputSchema, example, … }]

// Call it — proof-of-work is solved automatically for free tools.
const out = await a.call("hash", { text: "hello world", algo: "sha256" });
console.log(out.hex);
```

## Paid tools: x402 or MPP, your choice of wire

Wallet-only tools settle in USDC. The SDK never touches your key: pass a
payment-aware `fetch` and it pays 402s for you. Two wires work out of the box,
because every paid route on Agent402 carries both offers on the same 402:

**Over MPP** (Machine Payments Protocol) with the [`mppx`](https://www.npmjs.com/package/mppx) client - USDC on Base/Celo (`evm`), or natively on Tempo (`tempo`):

```js
import { Fetch, evm, tempo } from "mppx/client";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.AGENT_KEY);
const mppFetch = Fetch.from({ methods: [tempo.charge({ account }), evm.charge({ account })] });

const a = new Agent402({ fetch: mppFetch, maxPerCallUsd: 0.05 });
const verdict = await a.call("sql-guard", { sql: "UPDATE users SET plan = 'pro' WHERE id = 42" });
```

The SDK's spending caps, reservations and caching apply identically on the MPP
path (pinned by `scripts/test-client-mpp.js` in the parent repo, which buys
through the SDK with a real mppx client).

**Over x402** with [`@x402/fetch`](https://www.npmjs.com/package/@x402/fetch) - USDC on any of the 12 x402 chains:

```js
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(process.env.AGENT_KEY) });
const payFetch = wrapFetchWithPayment(fetch, client);

const a = new Agent402({ fetch: payFetch });
const article = await a.call("extract", { url: "https://example.com/article" });
```

## Workflows (skill packs)

For jobs that no single tool covers — e.g. "audit a domain", "build a stock
brief" — Agent402 ships curated multi-tool **skill packs**: 5–7 catalog tools
composed into a Claude-ready task template. Discover them the same way you'd
discover a tool:

```js
const packs = await a.findWorkflows("security audit");
// → [{ slug: "security-audit", title, tagline, toolSlugs, score, url, promptName }]

// Render the full prompt with arguments substituted in (same output as MCP prompts/get).
const { messages } = await a.getWorkflowPrompt("security-audit", { domain: "stripe.com" });
// → feed messages straight to any LLM
```

## Discover the live x402 economy

Want to see who's actually getting paid on x402 right now — not just what tools
this service exposes? `topSellers()` returns the live leaderboard of sellers
settling USDC (primarily on Base) in the last ~24h, derived from on-chain transfers. Free
to call (no payment, no proof-of-work):

```js
const { window, asOf, results, totalSellers } = await a.topSellers({ limit: 10 });
// → { window: "24h", asOf, totalSellers, results: [{ rank, name, wallet, totalUsd, callsSettled, uniqueBuyers, ... }] }

// Rank by call volume instead of USDC, and include the host's own wallet:
await a.topSellers({ sort: "calls", include: "all" });
```

## API

| Method | What |
|---|---|
| `new Agent402({ baseUrl?, fetch?, cache?, fetchImpl?, maxPerCallUsd?, dailyLimitUsd?, maxPerHostUsd? })` | `fetch` is your x402-wrapped fetch for paid tools (optional); `cache` (default `true`) memoizes deterministic results; the three USD caps set optional spending limits (see below) |
| `await a.find(task, { k = 5 })` | Resolve a plain-language task to the best-matching tools (route, price, schema, example) |
| `await a.findWorkflows(task, { k = 2 })` | Resolve a task to matching multi-tool workflow templates (skill packs) |
| `await a.getWorkflowPrompt(slug, args)` | Fetch the rendered prompt messages for a skill pack with arguments substituted in |
| `await a.topSellers({ limit?, sort?, include? })` | Live x402 leaderboard: which sellers are settling the most USDC (primarily on Base) in the last ~24h (free, no payment) |
| `await a.call(slug, params, { idempotencyKey?, cache? })` | Call a tool; auto-pays (PoW for free tools, x402 for wallet-only); returns the JSON result |
| `Agent402.solvePow(pow)` | Solve a proof-of-work challenge object → an `X-Pow-Solution` value |
| `a.spendingSummary()` | Rolling-24h paid spend so far: `{ dailyUsd, calls, byHost, limits }` |
| `a.clearCache()` | Drop the in-memory result cache |

## Spending caps (never overpay)

By default the client pays whatever a tool costs. Set optional hard ceilings and a
call that would exceed one is **refused before any payment is signed** (it throws
`SpendingLimitError` — no funds move):

```js
import { Agent402, SpendingLimitError } from "agent402-client";

const a = new Agent402({
  fetch: payFetch,
  maxPerCallUsd: 0.05,   // reject any single call priced above $0.05
  dailyLimitUsd: 5,      // rolling-24h ceiling across all sellers
  maxPerHostUsd: 1,      // rolling-24h ceiling per seller host
});

try {
  await a.call("some-expensive-tool", { … });
} catch (e) {
  if (e instanceof SpendingLimitError) console.log(e.limit, e.priceUsd, e.cap);
}
```

Only **settled** paid calls count against the rolling window — a blocked or failed
call never consumes budget. Free proof-of-work calls are never counted. Omit a cap
(or leave it `null`) for no limit; with none set, behavior is unchanged.

**What the caps check.** When a cap is set, the client preflights the `402` and
checks the ceiling against the **larger** of the advertised price (from the
seller's `/api/pricing`) and the amount the `402` challenge actually quotes — so a
server that under-advertises and then quotes more in the `402` is refused *before*
your wallet fetch signs anything. If the `402` can't be read (FREE_MODE, or an
unrecognized challenge shape) it falls back to the advertised price rather than
block a legitimate payment. Caps hold under **concurrency** too: each call reserves
its amount synchronously, so N simultaneous calls can't each pass against the same
pre-commit total. (The `402` amount is derived assuming stablecoin settlement —
`atomic / 10^decimals ≈ USD` — which matches x402's USDC/USDG rails.)

- **Zero dependencies** for the free/proof-of-work path (uses `node:crypto`).
- **Non-custodial:** paid settlement is your `@x402/fetch` + wallet; this client never sees your key.
- MIT licensed. Part of [Agent402](https://github.com/MikeyPetrillo/Agent402).

## Pick the settlement chain (`withNetworkPreference`)

Multi-chain sellers list Base first, so an unmodified x402 client effectively
always settles there. To pin a chain — e.g. **USDG on Robinhood Chain** —
wrap your client before building the fetch:

```js
import { withNetworkPreference } from "agent402-client";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";

const client = new x402Client();
registerExactEvmScheme(client, { signer });
withNetworkPreference(client, ["robinhood"]);   // or ["base","solana"], or ["eip155:4663"]
const payFetch = wrapFetchWithPayment(fetch, client);
```

Short names map to CAIP-2 (`base`, `solana`, `polygon`, `arbitrum`,
`robinhood`); unknown entries pass through verbatim so future chains work
without a package update. If the preference matches none of a seller's
payment options it throws **before** any payment is signed.

## Legal

Use of the hosted instance at agent402.tools is subject to its [Terms of Service](https://agent402.tools/terms) (acceptable-use policy included) and [Privacy Policy](https://agent402.tools/privacy). This package is MIT-licensed; the hosted server is AGPL-3.0. Both are provided as-is without warranty, and self-hosted deployments are their operator's responsibility.
