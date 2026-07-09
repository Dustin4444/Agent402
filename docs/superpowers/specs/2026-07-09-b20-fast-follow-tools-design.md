# B20 fast-follow tools: b20-new-tokens + b20-memos

**Date:** 2026-07-09
**Status:** approved design, pre-implementation
**Kit:** `src/tools/b20-kit.js` (extends the existing four B20 tools shipped pre-activation)

## Background

Base's B20 native token standard activated on mainnet 2026-07-08 (Activation Registry
`0x8453…0001` returns `true` for `base.b20_asset` and `base.b20_stablecoin`; verified
2026-07-09 00:25 UTC). Coinbase published the B20 event surface at
docs.cdp.coinbase.com/data/sql-api/b20-events, which unblocks log-scanning tools:

- Factory `0xB20f000000000000000000000000000000000000` emits
  `B20Created(address,uint8,string,string,uint8,bytes)`.
- Every B20 token emits standard `Transfer(address,address,uint256)` plus
  `Memo(address,bytes32)`, where a memo log sits at `log_index + 1` of its transfer
  (same tx, same contract) — the pairing CDP's own example join documents.
- Policy Registry `0x8453000000000000000000000000000000000002` emits five policy events
  (out of scope here).

## Backend decision

Direct `eth_getLogs` over the kit's existing RPC ladder (Alchemy-first when
`ALCHEMY_API_KEY` is set, then public Base RPCs). Rejected alternatives:

- **CDP SQL API proxy** — richer history and server-side joins, but adds an
  authenticated third-party data dependency with unpublished pricing and breaks
  self-hostability. Revisit only if users need deeper history than a bounded window.
- **Hybrid** — complexity without a demonstrated need.

Railway constraint (from ops history): free public RPCs often refuse `getLogs`; the
Alchemy lane is the reliable path in prod. Public-RPC fallback stays for small windows
and self-hosters.

## The unknown-ABI problem (shared design constraint)

CDP published event *signatures* but not which parameters are `indexed`. Signature
hashes (`topic0`) are layout-independent, so filtering is always safe — only field
*decoding* is ambiguous. Neither tool guesses:

1. **b20-new-tokens never decodes `B20Created` payloads.** It locates the new token's
   address among the log's topics and 32-byte data words using the `0xb200` address
   prefix as a self-validating oracle (every B20 token address carries the prefix; a
   20-byte value with it is unambiguous). Name/symbol/decimals then come from the
   kit's existing `readToken()` eth_calls — chain state, not event decoding.
2. **b20-memos decodes `Transfer` canonically** (ERC-20 layout is universal:
   from/to indexed, value in data) **and treats `Memo` defensively**: the memo is the
   event's only `bytes32` payload, so take the final 32-byte word whether it landed in
   topics or data.
3. Unit tests cover synthetic logs in **both** plausible indexed layouts per event, so
   whichever layout the official ABI turns out to use, decoding is already tested.
4. When the official ABI publishes, replace the defensive location logic with exact
   decoding (follow-up, not a blocker).

## Tool 1: `GET /api/b20-new-tokens` — $0.005

Recently deployed B20 tokens, via factory `B20Created` logs.

**Input** (all optional):

| field  | type   | default | range     | meaning                          |
|--------|--------|---------|-----------|----------------------------------|
| blocks | number | 50000   | 1–200000  | lookback window (~28h default at 2s blocks) |
| limit  | number | 25      | 1–100     | max tokens returned, newest first |

**Behavior:** scan the factory address for `topic0 = keccak256("B20Created(address,uint8,string,string,uint8,bytes)")`
from `latest - blocks` to `latest`, chunked ≤ 9,000 blocks per `getLogs` call (inside
Alchemy's 10k range cap; small enough that public RPCs tolerate it), newest chunk
first, stopping early once `limit` addresses are found. Each found address is enriched
via `readToken()` (name, symbol, decimals).

**Output:**
```json
{
  "fromBlock": 123, "toBlock": 456, "scannedFromBlock": 123, "truncated": false, "count": 1,
  "tokens": [{ "address": "0xb200…", "name": "…", "symbol": "…",
               "decimals": 18, "txHash": "0x…", "blockNumber": 400 }]
}
```

**Edge cases:** zero deployments in window → `{count: 0, tokens: []}` (an honest
answer, consistent with the kit's pre-activation philosophy). A log whose topics/data
contain no `0xb200`-prefixed word is skipped and counted in a `skipped` field rather
than guessed at. RPC exhaustion → 502 via the kit's existing `rpc()` retry ladder. If
the scan hits the internal log budget before reaching the requested floor, the
response reports the actually-scanned floor as scannedFromBlock with truncated: true —
a bounded answer is labeled as bounded, never passed off as full coverage.

## Tool 2: `GET /api/b20-memos` — $0.005

Payment memos attached to B20 transfers.

**Input:**

| field   | type   | required | meaning                                        |
|---------|--------|----------|------------------------------------------------|
| token   | string | yes      | B20 token address; must match `^0xb200[0-9a-f]{36}$` (enforced, 400 otherwise) |
| tx      | string | no       | tx hash — decode only this transaction (cheap path) |
| address | string | no       | filter: only transfers where from OR to equals this |
| blocks  | number | no       | window scan lookback, default 50000, max 200000 |
| limit   | number | no       | default 50, max 200                             |

**Behavior:** two modes.
- **`tx` mode:** one `eth_getTransactionReceipt`; walk its logs for the token address,
  pair each `Memo` log with the `Transfer` log at `logIndex - 1` (same contract).
- **Window mode:** `getLogs` on the token for `topic0 ∈ {Transfer, Memo}` over the
  chunked window; pair memos to transfers by `(txHash, logIndex + 1)`. Window
  responses carry the same scannedFromBlock/truncated coverage fields as
  b20-new-tokens.

Transfers without a memo are omitted (this is a memo reader, not a transfer lister).
`address` filter applies to the decoded Transfer's from/to.

**Output rows:** `{txHash, blockNumber, from, to, amount, memoHex, memoText}` —
`memoHex` always (0x + 64 hex chars); `memoText` is the UTF-8 decoding with trailing
NULs trimmed, only when the result is printable, else `null`.

## Kit plumbing (both tools)

- **Wallet-only:** both do external RPC I/O → add slugs to `WALLET_ONLY_SLUGS`
  (`src/pow.js`). Hard rule for egress tools.
- Category `payments`, tags including `b20`, `base`, `logs`; `discovery.inputSchema`
  + a small example that answers in CI (`blocks: 1000` windows; empty results are the
  correct current answer and a valid shape).
- Add both slugs to test-all's lenient NETWORK set (upstream flaps must not fail CI).
- Offline unit tests for the decode helpers (synthetic logs, both indexed layouts,
  memo printability edge cases: valid UTF-8, binary junk, all-zero).
- `node scripts/sync-count.js` after adding (1,416 → 1,416 across static surfaces).
- Bazaar/marketplace registration markers on the shipping PR per the usual flow.

## Out of scope

- `createB20` calldata encoder — the factory's *function* ABI is still unpublished
  (only its event signature is known).
- Policy Registry tools (`b20-policy-activity`, allowlist state) — deferred until
  demand or the read-function ABI appears.
- CDP SQL API backend — see Backend decision.
- Historical depth beyond a 200k-block window — bounded by design; an indexer is the
  right tool past that, not `getLogs`.
