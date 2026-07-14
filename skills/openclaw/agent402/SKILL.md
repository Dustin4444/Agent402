---
name: agent402
description: "Pay-per-call access to Agent402.Tools: 500+ deterministic web tools (browser rendering, web search, PDFs, OCR, finance, SEC EDGAR, crypto/macro data, an OpenAI-compatible LLM gateway, stats/forecasting, ~210 pure-CPU utilities) plus a neutral Smart Order Router across the wider x402 ecosystem. Discover with GET /api/find?q=<task>, pay per call in USDC on Base (six other chains also accepted) or free via proof-of-work with no wallet at all, dispatch one-shot with POST /api/route/execute. Use when the agent needs a specific deterministic capability instead of reasoning it out itself: scrape a URL, hash a string, look up a stock quote, OCR an image, query SEC EDGAR, run a chat/embeddings/image call through an OpenAI-compatible wire, or pay a small USDC amount for any of the above. Do NOT activate for open-ended reasoning or tasks with no matching tool; POST /api/wish first in that case."
homepage: https://github.com/MikeyPetrillo/Agent402
metadata:
  openclaw:
    emoji: "🧰"
    homepage: "https://github.com/MikeyPetrillo/Agent402"
    primaryEnv: EVM_PRIVATE_KEY
---

# Agent402.Tools

500+ deterministic web tools an agent can call over plain HTTP, paid per call.
No LLM sits in the serving path on Agent402's side; every response is a
straight function call, so it's cheap, fast, and reproducible. Open-source and
self-hostable (this skill points at the hosted instance).

Base URL for every path below: `https://agent402.tools`

## Prerequisites

**Browse only, zero keys needed:**
```bash
curl "https://agent402.tools/api/find?q=hash a string"
curl "https://agent402.tools/api/pricing"
```

**To pay for a tool, pick one (both work with no signup):**

1. **Wallet, USDC on Base**: set `EVM_PRIVATE_KEY` in `.env` to a Base wallet
   funded with USDC (bridge at bridge.base.org or buy at coinbase.com). This is
   the native rail for OpenClaw agents on Virtuals/Base.
2. **No wallet at all**: solve a proof-of-work puzzle instead of paying. About
   210 of the 500+ tools are pure-CPU and PoW-eligible; no money, no signup,
   no funding step. See "Free tier" below.

Never hardcode a price. Treat the runtime `402 Payment Required` response as
the source of truth: prices can change between releases.

## When to Activate This Skill

Activate when the agent needs to:
- find or call a deterministic tool (scraping, PDFs, OCR, finance/EDGAR/crypto/macro
  data, encoding/hashing, stats, forecasting, barcodes, images)
- run a chat completion, embedding, or image generation through an
  OpenAI-compatible wire without standing up its own inference account
- pay a small USDC amount over x402 for any of the above
- resolve "what tool does X" without burning tokens reading docs

Do not activate for open-ended reasoning, or for a task with no matching tool
(use `POST /api/wish`, described below, once nothing in `/api/find` fits).

## Discover: `GET /api/find?q=<task>`

Free, no keys. Send a plain-language task description; get back the
best-matching tool(s) with route, price, input schema, and a ready-to-run
example.

```bash
curl "https://agent402.tools/api/find?q=hash a string"
```
```json
{
  "query": "hash a string",
  "count": 5,
  "results": [
    {
      "slug": "hash",
      "route": "POST /api/hash",
      "price": "$0.001",
      "callExample": { "method": "POST", "path": "/api/hash", "body": { "text": "hello world", "algo": "sha256" } },
      "inputSchema": { "properties": { "text": { "type": "string" }, "algo": { "type": "string" } }, "required": ["text"] },
      "computePayable": true,
      "docs": "https://agent402.tools/tools/hash"
    }
  ]
}
```

`callExample` is pre-assembled (method, path, body or query) so the agent
doesn't have to guess whether the tool takes a body or query string. When
`computePayable` is `true`, the tool is also reachable free via proof-of-work.

For the whole catalog at once (name, route, price, schema, per tool), pull
`GET /api/pricing` is useful for building a local index instead of round-tripping
`/api/find` per task.

## Pay per call: x402 on Base USDC

Send the request normally. A priced tool answers `402 Payment Required` with a
`payment-required` header (base64 x402 v2 payload) until a valid payment
accompanies the retry. Verified live:

```bash
curl -i -X POST https://agent402.tools/api/extract \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com"}'
# HTTP/1.1 402 Payment Required
# payment-required: eyJ4NDAyVmVyc2lvbiI6Mi...   <- base64 x402 v2 challenge
```

Decoded, the challenge's `accepts[]` array lists every rail this tool takes.
Base is first and is the native rail for an OpenClaw/Base wallet, but the same
call can also settle on Polygon, Arbitrum, Solana, Stellar, Algorand, or
Robinhood Chain (USDG) if that's what the agent's wallet is funded with:

```json
{
  "accepts": [
    { "scheme": "exact", "network": "eip155:8453",  "asset": "0x8335...913", "payTo": "0xaBF4...9D0" },
    { "scheme": "exact", "network": "eip155:137",   "asset": "0x3c49...359" },
    { "scheme": "exact", "network": "eip155:42161", "asset": "0xaf88...831" },
    { "scheme": "exact", "network": "eip155:4663",  "asset": "0x5fc5...168", "extra": { "name": "Global Dollar" } },
    { "scheme": "exact", "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" },
    { "scheme": "exact", "network": "stellar:pubnet" },
    { "scheme": "exact", "network": "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=" }
  ]
}
```

**Negotiation flow:**
1. Send the request normally.
2. On `402`, parse the payment requirements from the `payment-required` header
   (and the response body, where present).
3. Sign a payment payload for whichever `accepts[]` entry matches the agent's
   funded chain and retry with the `X-PAYMENT` header.
4. Continue once the retried request returns `200`.

Any standard x402 client handles this negotiation; here's the shape (Python,
`x402` package, same pattern these skills ship with):

```python
import os
from eth_account import Account
from x402 import x402ClientSync
from x402.http import x402HTTPClientSync
from x402.http.clients import x402_requests
from x402.mechanisms.evm import EthAccountSigner
from x402.mechanisms.evm.exact.register import register_exact_evm_client

account = Account.from_key(os.getenv("EVM_PRIVATE_KEY"))
client = x402ClientSync()
register_exact_evm_client(client, EthAccountSigner(account))
http_client = x402HTTPClientSync(client)

with x402_requests(client) as session:
    r = session.post("https://agent402.tools/api/extract", json={"url": "https://example.com"})
    print(r.status_code, r.text)
```

**Budget guardrail:** if there's no pre-approved spend budget, confirm with the
user before executing paid x402 calls above a few cents.

## Free tier: proof-of-work (no wallet needed)

```bash
curl "https://agent402.tools/api/pow/challenge?slug=hash"
```
```json
{
  "algorithm": "sha256",
  "challenge": "f5cbdd18bb09ddb4666c534f4db2a078",
  "difficulty": 16,
  "rule": "Find an integer nonce such that sha256(\"<challenge>:\" + nonce) has at least 16 leading zero bits.",
  "submitHeader": "X-Pow-Solution",
  "submitFormat": "<token>:<nonce>",
  "token": "f5cbdd18bb09ddb4666c534f4db2a078.1783778609.16.hash.FpT-1yFu..."
}
```

Solve it (a fraction of a second of CPU), then resend the original request
with `X-Pow-Solution: <token>:<nonce>` instead of a payment header. Full spec
and the eligible-tool list at `GET /api/pow`. This is the path to use when the
agent has no funded wallet at all, or when the tool it needs happens to be
pure-CPU.

## LLM gateway: chat, embeddings, images

An OpenAI-compatible wire, five price tiers, same request/response shape as
`/v1/chat/completions` elsewhere:

| Tier | Route | Price | Notes |
|---|---|---|---|
| nano | `POST /v1/nano/chat/completions` | $0.003 | small/fast models, high-frequency loops |
| auto | `POST /v1/auto/chat/completions` | $0.01 | model optional, deterministic quality-ranked routing |
| base | `POST /v1/base/chat/completions` | $0.02 | |
| pro | `POST /v1/pro/chat/completions` | $0.10 | |
| premium | `POST /v1/premium/chat/completions` | $0.50 | |
| embeddings | `POST /v1/embeddings` | $0.002 | batch up to 64 inputs, cached by default |
| images | `POST /v1/images/generations` | $0.08 | returns `b64_json` |

`GET /v1/models` lists the allowlisted model ids per tier. Verified live:
`POST /v1/nano/chat/completions` with no payment answers `402 Payment Required`
the same way any other priced tool does; pay it exactly like `/api/extract`
above.

```bash
curl "https://agent402.tools/v1/models"
```

## One-shot dispatch: `POST /api/route/execute`

Skip the find-then-call round trip. Pay one flat $0.01 and describe the task
(or name the exact slug); Agent402 resolves the best match and runs it in the
same request, covering any underlying tool priced at $0.005 or less.

```bash
curl -i -X POST https://agent402.tools/api/route/execute \
  -H 'content-type: application/json' \
  -d '{"slug":"hash","params":{"text":"agent402","algo":"sha256"}}'
# HTTP/1.1 402 Payment Required (pay it like any other route, then retry)
```

```json
{
  "receipt": { "slug": "hash", "route": "POST /api/hash", "underlyingPriceUsd": 0.001, "paidUsd": 0.01, "routingFeeUsd": 0.009 },
  "result": { "algo": "sha256", "hex": "..." }
}
```

Pass `task` instead of `slug` to let the same ranker behind `/api/find` pick
the tool. A tool priced above $0.005 answers a self-correcting 409 naming its
direct route, so the agent can call it there at list price instead.

## Nothing matches: `POST /api/wish`

If `GET /api/find?q=<task>` returns no strong match, `POST /api/wish` with
`{ "need": "<what the agent needs>", "context": "<why, optional>" }` logs the
gap for a tool to be built against (free, rate-limited; the MCP connector
exposes the same thing as the `request_tool` tool). Demand is public at
`GET /api/wishes`.

## Error handling

| Error | Cause | Fix |
|---|---|---|
| `402 Payment Required` with no `payment-required` header | Free-tier tool, not priced | Nothing to pay, retry with no changes |
| `409` from `/api/route/execute` | Underlying tool priced above the $0.005 cap | Call the named direct route at list price |
| `404` from `/api/find` results (empty `results`) | No lexical match for the query | Broaden the query, or `POST /api/wish` |
| `413` from a memory tool | Namespace over its 10k-key / 32MB quota | Free space or use a new namespace |
| PoW `410`/expired token | Challenge TTL (300s) elapsed before submit | Request a fresh challenge and resolve faster |

## Reference

- `GET /health`: liveness
- `GET /api/pricing`: full priced catalog, one call
- `GET /.well-known/x402`: machine-readable service manifest (every resource + schema)
- `GET /api/reliability`: uptime/error-rate report per tool
- Full docs: https://agent402.tools · Source: https://github.com/MikeyPetrillo/Agent402
