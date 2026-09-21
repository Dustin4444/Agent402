# Before and after

## Numbers reconciled

| Figure | Before | After |
|---|---|---|
| 4,287 | `/marketplace`: "endpoints indexed" · `/revenue`, `/proof`, `/leaderboard`: "seller origins indexed" | "origins indexed" everywhere |
| Hero counter | One label over two different quantities: inbound on-chain transfers, ours included (42,104 + Tempo) or calls served for a stablecoin payment (35,138), depending on whether the ledger had warmed | Label follows the value: "on-chain settlements · all rails · ours included" or "calls served for a stablecoin payment" |
| Router share | "17 of 35,138 paid calls (under 0.1%) came through the router, which is the only path Agent402 earns on. Every other paid call went buyer wallet to seller wallet." | Not published. The clause was also false: those other 35,111 calls are buyers paying **us** for **our** tools. |
| 609 vs "500+" | Read as a contradiction | Confirmed correct by design and written down in `METRICS_SOURCE.md`, so it is not "fixed" by someone later |

Every metric now has one definition and one source in `METRICS_SOURCE.md`.

## Homepage copy

**Seller section**

Before:
> **17** of 35,138 paid calls (under 0.1%) came through the router, which is the
> only path Agent402 earns on. Every other paid call went buyer wallet to seller
> wallet.

After:
> No listing fee and no commission. A buyer pays your wallet directly from your
> own 402, which names your payTo and not ours, so nothing is deducted and
> nothing routes through us unless a buyer asks us to buy on their behalf.

The claim is stronger and checkable: a reader can fetch any 402 on the site and
see the payTo for themselves. No monetization rate published.

**Proof-of-work demo**

| | Before | After |
|---|---|---|
| Lede | "This is not a diagram - press the button and your browser will…" | "Press the button: your browser fetches a real challenge…" |
| Status | `idle` | `ready` |

**Empty state**

| Before | After |
|---|---|
| "Listening for on-chain payments…" | "Settlement count loading" |

Still never renders a fabricated 0, which the test pins in both directions.

## Marketplace seller path

| | Before | After |
|---|---|---|
| Seller entry point near the top | absent | 5% into the body, under the existing "BUYER PATH" card |
| Register block | 95% into the body, after the FAQ | 81%, before the FAQ |
| First `/sell` link | 24%, buried in body copy | offered as an action in the header |

## Nav

Unchanged. The six-dropdown collapse and the per-page 12-chain strip are in
`SITE_AUDIT.md` as recommendations with the reasoning; they touch the shared
chrome on 52 pages and should follow a mock rather than precede one.
