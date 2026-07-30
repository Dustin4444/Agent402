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
| Read/write | Read-only (all tools carry `readOnlyHint: true`; nothing destructive) |
| Website | https://agent402.tools |
| Public docs | https://agent402.tools/llms.txt (also /tools and /openapi.json) |
| Privacy policy | https://agent402.tools/privacy |
| Support contact | https://github.com/MikeyPetrillo/Agent402/issues |
| Maintainer | Havok Holdings LLC - https://github.com/MikeyPetrillo/Agent402 |
| Source code | https://github.com/MikeyPetrillo/Agent402 (AGPL-3.0 server, MIT packages; fully open source) |

## Tagline (short)

> The headless browser, live web search, and durable memory your agent's sandbox doesn't have - plus 200+ instant utilities. No signup, no API key.

## Description

> Agent402 gives Claude a catalog of 500+ small, deterministic web tools it
> can call instantly: encoding and hashing, unit and data conversions, JSON/CSV
> wrangling, text processing, date/cron math, validators, and more. There is no
> account, no API key, and no setup - the pure-CPU tools run free on the hosted
> connector (rate-limited). No LLM is involved in serving: same input, same
> output, with full input schemas. The server is open source, and the catalog
> is also reachable programmatically over the x402 payment protocol for
> autonomous agents with their own wallets.

## Tools exposed (17, each with title + safety annotations)

Six meta-tools drive the whole catalog, and eleven popular tools are listed
first-class by name so a directory listing shows what an agent can actually run
without a discovery round-trip.

1. **search_tools** - "Search the Agent402 tool catalog". Finds tools by
   description across the full catalog; returns slugs, prices, and input
   schemas. Read-only.
2. **find_tool** - "Resolve a task to the one best Agent402 tool". Returns the
   single best-matching tool call-ready: slug, price, input schema, and a worked
   example. Read-only.
3. **call_tool** - "Run an Agent402 tool". Executes a catalog tool by slug.
   On this hosted connector only the pure-CPU, deterministic tools execute
   (200+ of them); network/browser/storage tools return guidance instead of
   running. Read-only, idempotent, no external side effects.
4. **get_payment_info** - "Payment and wallet setup". Explains the free vs paid
   split, how to configure a wallet with per-call and budget spend caps, the
   settlement rails, and where to read a wallet's balance and history. Static
   guidance, read-only.
5. **generate_hash** - "Hash". sha256 and friends. Free, pure-CPU.
6. **convert_units** - "Unit convert". Length, mass, temperature and more. Free,
   pure-CPU.
7. **generate_qr** - "QR code". Free, pure-CPU.
8. **format_json** - "JSON validate & format". Free, pure-CPU.
9. **decode_jwt** - "JWT decode". Header and claims, no signature verification.
   Free, pure-CPU.
10. **convert_base64** - "Base64". Encode or decode. Free, pure-CPU.
11. **generate_uuid** - "UUID generator". Free, pure-CPU.
12. **parse_csv** - "CSV to JSON". Free, pure-CPU.
13. **convert_timezone** - "Timezone convert". Free, pure-CPU.
14. **get_wallet_balances** - "Wallet token balances (indexed)". Wallet-required;
    on this authless connector it returns paid-access setup instead of a live
    result.
15. **get_wallet_transactions** - "Wallet transaction history". Wallet-required;
    same authless behaviour as above.
16. **about_agent402** - "About this Agent402 connector". What this connector is
    and how to pay for the tools it fronts: catalog size, the free compute tier
    and its limits, the payment rails accepted, and the machine-readable
    discovery URLs. Free, read-only.
17. **top_x402_sellers** - "Top x402 sellers". Ranked sellers from the on-chain
    settlement leaderboard (settled call counts, USDC totals, distinct buyers per
    seller), for finding other services in the open x402 ecosystem. Free,
    read-only.

## Connection requirements

None. Anonymous streamable HTTP; stateless (every JSON-RPC message is
self-contained). Per-client rate limit: 20 calls/min, 120/hour.

## Example prompts (use cases)

- "Decode this JWT and tell me when it expires."
- "Convert 250 horsepower to kilowatts."
- "Generate a UUID and its sha256 hash."
- "When will the cron expression `0 9 * * MON` fire next?"
- "Dedupe and sort these 200 lines."
- "Validate these 5 email addresses' syntax."

## Reliability / review notes

- Every endpoint is re-tested against its own documented example in CI before
  any deploy; the MCP connector itself has an end-to-end JSON-RPC test gating
  both CI and the production rollout.
- A heartbeat probes production every 15 minutes (health, catalog, paid call,
  MCP initialize).
- Errors are structured and human-readable (each tool returns a specific
  message naming the missing/invalid field, never a bare 500).
- No data collection: no accounts, no cookies, no trackers. IPs are used only
  for rate limiting (in-memory, ≤1 h). See /privacy.
