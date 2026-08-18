# agent402-strands

Drop-in [Strands Agents](https://strandsagents.com) (TypeScript) tools for
[Agent402](https://agent402.tools) - turn 500+ pay-per-call web tools into
Strands `tool({...})` instances your agent can invoke. Payment is handled
underneath: proof-of-work for the free tier (no wallet), x402 + USDC on Base,
Solana, Polygon, or Arbitrum for wallet-only tools.

> **Agent402 is the applied layer of [Agentic Finance (AIFI)](https://agent402.tools/agentic-finance)** - agents that pay and get paid on their own over the two open wires, [x402](https://agent402.tools/what-is-x402) and [MPP](https://agent402.tools/what-is-mpp) (Machine Payments Protocol). Every paid endpoint answers both on the same 402; wallet-only tools take any payment-wrapped fetch (`@x402/fetch`, or a stock `mppx` fetch).

Built for **AWS Bedrock AgentCore Payments**. AgentCore orchestrates payments
over the [x402 protocol](https://x402.org); Agent402 is an x402-native server.
This adapter is the glue that drops the Agent402 catalog into a Strands agent
running on AgentCore.

## Install

```bash
npm install agent402-strands @strands-agents/sdk zod
```

## Use

```ts
import { Agent } from "@strands-agents/sdk";
import { agent402Tools } from "agent402-strands";

const { tools } = await agent402Tools({
  slugs: ["extract", "hash", "render", "screenshot"],   // pick what you need
});

const agent = new Agent({ tools });
const out = await agent.invoke("Extract the article at https://example.com");
```

That's it. The agent now has those tools available; when it calls one, the
adapter solves a proof-of-work (free tier) or signs an x402 payment (paid
tier) under the hood and returns the result as a structured object.

## On AWS Bedrock AgentCore

If you're using AgentCore Payments + Gateway, the typical setup is:

1. Store CDP API keys in **AgentCore Identity** as a `PaymentCredentialProvider`.
2. Add `https://agent402.tools/mcp` as a Gateway target - instantly get all
   500+ tools via MCP, no adapter needed.
3. Or, for finer control, use this adapter to pull a *curated subset* of
   tools and embed them directly in a Strands agent. The Strands agent runs
   on AgentCore; payment limits and CloudWatch observability are AgentCore's
   concern - you don't have to wire any of that yourself.

See the [AWS Bedrock AgentCore integration guide](https://github.com/MikeyPetrillo/Agent402/wiki/AWS-Bedrock-AgentCore)
for a 5-minute end-to-end recipe.

## API

```ts
agent402Tools(opts?: {
  baseUrl?: string;       // default "https://agent402.tools"
  slugs?: string[];       // restrict to these tool slugs (recommended)
  freeOnly?: boolean;     // default true - only compute-payable tools (no wallet)
  fetch?: typeof fetch;   // an @x402/fetch-wrapped fetch (only for wallet-only tools)
}): Promise<{
  tools:   StrandsTool[];                       // pass to `new Agent({ tools })`
  execute: (name, args) => Promise<unknown>;    // pays under the hood
  client:  Agent402;                            // raw buyer SDK (find()/call()/clearCache())
}>;

agent402Execute(opts?: {
  baseUrl?: string;
  fetch?: typeof fetch;
}): (name, args) => Promise<unknown>;
```

`freeOnly: true` (the default) filters to the 200+ compute-payable tools -
every one of them works with no wallet, paid in seconds of CPU via
proof-of-work. Set `freeOnly: false` and pass an `@x402/fetch`-wrapped
`fetch` to access the 300+ wallet-only tools (the network/disk-touching ones,
plus the skill packs).

## Sibling adapters

Same shape, different framework:

- [`agent402-openai-tools`](https://www.npmjs.com/package/agent402-openai-tools) - OpenAI function-calling
- [`agent402-anthropic-tools`](https://www.npmjs.com/package/agent402-anthropic-tools) - Anthropic Messages
- [`agent402-ai-sdk`](https://www.npmjs.com/package/agent402-ai-sdk) - Vercel AI SDK
- [`agent402-langchain`](https://www.npmjs.com/package/agent402-langchain) - LangChain JS / LangGraph
- [`agent402-llamaindex`](https://www.npmjs.com/package/agent402-llamaindex) - LlamaIndex TS

Source: [`adapters/strands/`](https://github.com/MikeyPetrillo/Agent402/tree/main/adapters/strands).
Issues + PRs welcome on the [main repo](https://github.com/MikeyPetrillo/Agent402).
MIT licensed.
