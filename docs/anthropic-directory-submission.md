# Anthropic Connector Directory - submission package

Submit at: **https://claude.com/docs/connectors/building/submission**
(Anthropic account required - this is the one step only a human can do.)

Everything below is ready to paste. All technical requirements are already
live: tool titles + read-only safety annotations on every tool, a stable
privacy policy, public docs, and a no-auth streamable-HTTP endpoint.

---

## Basic information

| Field | Value |
|---|---|
| Server name | Agent402 |
| Server URL | `https://agent402.tools/mcp` |
| Transport | Streamable HTTP |
| Auth type | None (anonymous; no account, no API key) |
| Read/write | Mostly read-only; `request_tool` and `write_memory` are the only writers (`readOnlyHint: false`). All other tools carry `readOnlyHint: true`. |
| Website | https://agent402.tools |
| Public docs | https://agent402.tools/llms.txt (also /tools and /openapi.json) |
| Privacy policy | https://agent402.tools/privacy |
| Support contact | https://github.com/MikeyPetrillo/Agent402/issues |
| Maintainer | Havok Holdings LLC - https://github.com/MikeyPetrillo/Agent402 |
| Source code | https://github.com/MikeyPetrillo/Agent402 (AGPL-3.0 server, MIT packages; fully open source) |

## Tagline (short)

> Live web search and cited answers for Claude, plus a 500+ tool catalog behind find. No signup, no API key.

## Description

> Agent402 is a deterministic tools layer for Claude: search the web and get
> cited answers as first-class MCP tools, then reach 500+ pay-per-call utilities
> (render, data, memory, encoding, conversions, and more) via find_tool /
> search_tools / call_tool. There is no account and no API key. Pure-CPU tools
> run free on the hosted connector (rate-limited); flagship egress tools are
> listed and return paid-path setup unless you run the npm server with a funded
> wallet. No LLM is involved in serving deterministic tools: same input, same
> output, with full input schemas. Open source. Also reachable over the x402
> payment protocol for autonomous agents with their own wallets.

## Tools exposed (~15, each with title + safety annotations)

Flagship demand tools first, then meta discovery for the long catalog.

1. **search_web** - "Live web search". Ranked results (title, URL, snippet).
   Wallet-required on this authless host (returns paid-access setup). Open-world.
2. **answer_question** - "Cited answer". Grounded answer from live search.
   Wallet-required on this authless host. Open-world.
3. **search_news** - "News search". Wallet-required on this authless host.
4. **render_page** - "Render page". Headless Chromium → markdown.
   Wallet-required on this authless host.
5. **get_stock_quote** - "Stock quote". Wallet-required on this authless host.
6. **transcribe_audio** - "Transcribe audio". Wallet-required on this authless host.
7. **read_memory** - "Read durable memory". Wallet-required (wallet = identity).
8. **write_memory** - "Write durable memory". Writer; wallet-required.
9. **search_tools** - "Search the Agent402 tool catalog". Browse 500+ tools by
   description; returns slugs, prices, and input schemas. Read-only.
10. **find_tool** - "Resolve a task to the one best Agent402 tool". Returns the
    single best-matching tool call-ready: slug, price, input schema, and a worked
    example. Read-only.
11. **call_tool** - "Run an Agent402 tool". Executes a catalog tool by slug.
    On this hosted connector the pure-CPU, deterministic tools execute (200+ of
    them); wallet-only tools return guidance instead of running. Read-only for
    free tools.
12. **get_payment_info** - "Payment and wallet setup". Explains the free vs paid
    split, wallet setup, spend caps, and settlement rails. Static guidance,
    read-only.
13. **describe_server** - "About this Agent402 connector". Flagship-first
    orientation, Claude/Cursor/npm install one-liners, free vs paid, discovery
    URLs. Free, read-only. Also returned in initialize.instructions.
14. **request_tool** - "Request a missing tool". Writer; records demand.
15. **list_top_sellers** - "List top x402 sellers". Ranked sellers from the on-chain
    settlement leaderboard. Free, read-only.

## Connection requirements

None. Anonymous streamable HTTP; stateless (every JSON-RPC message is
self-contained). Per-client rate limit: 20 calls/min, 120/hour.

## Example prompts (use cases)

- "Search the web for x402 adoption in 2026."
- "Answer: what is the Sahm Rule, with citations."
- "Render https://example.com and summarize the page."
- "Find a tool that hashes text with sha256, then run it."
- "What payment rails does Agent402 accept?"
- "Decode this JWT and tell me when it expires." (via find_tool → call_tool)

## Reliability / review notes

- Every endpoint is re-tested against its own documented example in CI before
  any deploy; the MCP connector itself has an end-to-end JSON-RPC test gating
  both CI and the production rollout.
- A heartbeat probes production every 15 minutes (health, catalog, paid call,
  MCP initialize). Live status: https://agent402.tools/status
- Errors are structured and human-readable (each tool returns a specific
  message naming the missing/invalid field, never a bare 500).
- No data collection: no accounts, no cookies, no trackers. IPs are used only
  for rate limiting (in-memory, ≤1 h). See /privacy.
