# Cloudflare Agents + Agent402 - integration guide

Cloudflare's Agents SDK has native x402 support (`withX402`, `paidTool`,
`x402-hono` middleware). Agent402 is an x402 seller - 500+ pay-per-call
tools at `https://agent402.tools`. This guide shows how a Cloudflare Worker
or Agent can discover and call Agent402 tools, paying per request in USDC.

Cloudflare x402 docs: https://developers.cloudflare.com/agents/agentic-payments/x402/

---

## 1. Calling Agent402 from a Cloudflare Worker

A minimal Worker that calls Agent402's `/api/stock-quote` endpoint using
`@x402/fetch` for automatic payment:

```ts
// src/index.ts - Cloudflare Worker
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Set up x402 client with your agent's private key (stored in Worker secret)
    const client = new x402Client();
    registerExactEvmScheme(client, {
      signer: privateKeyToAccount(env.AGENT_PRIVATE_KEY as `0x${string}`),
    });
    const payFetch = wrapFetchWithPayment(fetch, client);

    // Call Agent402 - the 402 challenge + USDC payment happen transparently
    const res = await payFetch(
      "https://agent402.tools/api/stock-quote?symbol=AAPL"
    );
    const data = await res.json();

    return Response.json(data);
  },
};

interface Env {
  AGENT_PRIVATE_KEY: string;
}
```

The Worker receives a 402 response from Agent402, signs a USDC payment on
Base (or Solana/Polygon/Arbitrum/Monad/Celo/Avalanche/Sei/Optimism/Stellar/Algorand,
or USDG on Robinhood Chain), and replays the request with a valid
payment header - all handled by `@x402/fetch`.

---

## 2. Using Agent402 from a Cloudflare Agent (`withX402`)

If you are building with the Cloudflare Agents SDK, use the built-in
`withX402` wrapper so your agent can call any x402-protected endpoint:

```ts
import { Agent, withX402 } from "agents";

const MyAgent = withX402(
  class extends Agent {
    async onMessage(msg: string) {
      // Discover the right tool first (free, no payment)
      const findRes = await fetch(
        `https://agent402.tools/api/find?q=${encodeURIComponent(msg)}&k=1`
      );
      // /api/find returns { query, count, results: [...] } - take the top hit.
      const { results } = await findRes.json();
      const tool = results[0];
      if (!tool) return { error: "no matching tool" };

      // callExample carries the exact method, path and body/query to use.
      const { method, path, body, query } = tool.callExample;
      const url = new URL(path, "https://agent402.tools");
      for (const [k, v] of Object.entries(query ?? {})) {
        url.searchParams.set(k, String(v));
      }

      // Call it - withX402 handles the payment challenge automatically
      const res = await this.fetch(url.toString(), {
        method,
        ...(method === "POST"
          ? {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body ?? {}),
            }
          : {}),
      });
      return await res.json();
    }
  },
  { network: "base" }
);
```

---

## 3. Connecting Agent402 via MCP

Agent402 exposes a hosted MCP endpoint at:

```
https://agent402.tools/mcp
```

This is a streamable-HTTP MCP server. Four meta-tools drive it - `search_tools`
(browse candidates), `find_tool` (resolve a task to one pick), `call_tool` (run
by slug) and `get_payment_info` (how paying and spend caps work) - alongside a
handful of popular tools listed first-class by name. Any Cloudflare Agent that
supports remote MCP servers can connect directly.

In your `wrangler.jsonc` (or equivalent config):

```jsonc
{
  "mcp_servers": [
    {
      "name": "agent402",
      "transport": "streamable-http",
      "url": "https://agent402.tools/mcp"
    }
  ]
}
```

The MCP surface handles discovery and invocation - `call_tool` solves
proof-of-work automatically for free-tier tools. For wallet-only tools
(search, browser, PDF, memory), pass your x402 payment header via the
`payment` field in the `call_tool` input.

---

## 4. Tollbooth - charge Workers that crawl your content

Site owners who want to charge AI agents (including Cloudflare Workers) for
crawling their content can deploy `agent402-tollbooth`. It is a lightweight
middleware that returns a 402 challenge to bot traffic and settles USDC via
x402 before serving the page. Works with any origin - Express, Next.js,
Cloudflare Workers, or Docker. See
[github.com/MikeyPetrillo/Agent402/tree/main/tollbooth](https://github.com/MikeyPetrillo/Agent402/tree/main/tollbooth)
for the npm package and deploy templates.

---

## Quick reference

| Surface | URL | Auth |
|---------|-----|------|
| Tool discovery | `GET /api/find?q=...` | None (free) |
| Pricing catalog | `GET /api/pricing` | None (free) |
| OpenAPI spec | `GET /openapi.json` | None (free) |
| MCP endpoint | `POST /mcp` | None (free tier) / x402 (paid) |
| Any paid tool | `GET\|POST /api/{slug}` | x402 (USDC) |
| x402 manifest | `GET /.well-known/x402` | None |

Prices: most tools $0.001–$0.02 per call; the priciest single tool is $0.55 and
multi-tool skill packs run up to $1.50. Networks: Base, Solana, Polygon,
Arbitrum, Monad, Celo, Avalanche, Sei, Optimism, Stellar and Algorand (USDC),
plus Robinhood Chain (USDG) - 12 in total.
