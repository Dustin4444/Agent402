# The 10,000-transaction ceiling on seller activity

Traced end to end on 2026-09-20 from the reported symptom
(`/base?seller=win.oneshotagent.com` never showing more than ~10,000
transactions) to the line responsible, then fixed and verified against the
live wallet.

## What the symptom actually was

Production, before the fix:

| | Agent402 reported | Measured independently |
|---|---|---|
| Transactions (30d) | **10,000** | **30,253** |
| Volume (30d) | **$129.90** | **$332.18** |
| Distinct buyers | **22** | **46** |

The seller's own Coinbase Bazaar row, shown on the same page, said **29,296
calls in the last 30 days**. So the page was rendering two counts side by side
that disagreed by 3x, and the smaller one was ours.

This was not specific to that seller or that chain. Every marketplace seller on
every chain page was capped the same way.

## Where the ceiling actually was

The request path is short and none of it is the cause until the last step:

```
GET /base?seller=<host>
  src/server.js            resolveMarketSeller()   -> the seller's advertised Base payTo
  src/server.js            getActivityForChain()   -> 10-minute SWR cache, not a bound
  src/server.js            scanActivity()          -> picks a scanner for the chain
  src/revenue-live.js      evmActivity()           <- the ceiling is here
```

`evmActivity` walked Alchemy's `alchemy_getAssetTransfers` newest-first,
following the response's own `pageKey` cursor, and stopped on whichever came
first: a transfer older than the 30-day cutoff (correct), no further cursor
(correct), or a page count:

```js
export async function evmActivity(chainKey, wallet, { days = 30, maxPages = 10 } = {}) {
  ...
  for (let page = 0; page < maxPages; page++) {
    const params = { ..., maxCount: "0x3e8", order: "desc", ...(pageKey ? { pageKey } : {}) };
```

`maxCount: "0x3e8"` is 1,000 records, `maxPages` is 10. **10 x 1,000 = 10,000**,
exactly the number on the page, for any wallet busier than that, forever.

The paging itself was never broken. The walk was already keyset: each source
follows its own opaque cursor (`pageKey` on Alchemy, `next-token` on the
Algorand indexer, `_links.next` on Horizon, `before` on Solana), never an
offset. There was nothing to convert. The bound was simply placed where a real
figure used to be, and a page count silently becomes a ceiling on the answer.

### It was the whole class, not one function

All four trailing-window scanners in `src/revenue-live.js` carried the same
`maxPages = 10`:

| Scanner | Page size | Old effective ceiling |
|---|---|---|
| `evmActivity` (Base, Polygon, Arbitrum, Robinhood) | 1,000 | 10,000 transfers |
| `algorandActivity` | 1,000 | 10,000 transfers |
| `stellarActivity` | 200 | 2,000 payments |
| `solanaActivity` | 1,000 signatures, but `maxTx = 60` | **60 transactions** |

Solana's was by far the tightest: its cost is per transaction rather than per
page (each signature inside the window needs its own `getTransaction`), so any
Solana seller past sixty transfers in thirty days reported sixty.

### Two things that are NOT the cause, ruled out

**The paid exact scanner is switched off, deliberately.** Base prefers
`baseActivityViaSql`, which answers with server-side aggregates (`count()`,
`sum()`, `uniqExact()`) and therefore has no row ceiling at all. It never runs:
`SQL_SCAN_DAILY_BUDGET` defaults to `0` and is unset in production, so
`paidScanAllowed()` is always false and Base always falls through to the RPC
walker. That default is a documented decision, not an oversight: the queries
cost roughly $60/month to power an activity chart on a free page, against
roughly $50/month of total external revenue. Turning it back on would have
bought exactness with money the chart does not earn, so the fix belongs in the
free scanner and that default is untouched.

**The cache is not involved.** `getActivityForChain` is stale-while-revalidate
with a 10-minute TTL; it stores whatever the scanner returned. It was faithfully
caching a capped number.

## The fix

A page count is a poor bound. It is a proxy for cost that drifts with whatever
page size a source happens to return, and it converts directly into a ceiling
on the reported figure. Bound the **wall clock** instead, which is what a page
load can actually afford and what the cost of a scan is proportional to, and
keep a page ceiling only as a backstop against a cursor that never terminates.

```js
const SCAN_BUDGET_MS = Math.max(1000, Number(process.env.MARKET_SCAN_BUDGET_MS) || 12_000);
const SCAN_MAX_PAGES = 200;   // backstop only
```

Measured before choosing the number, not after: the busiest seller's full
window on Base is **31 pages, 7.0s end to end, median 222ms a page**, so a 12s
budget carries about 1.7x the busiest wallet on the chain and degrades honestly
on a slow provider day instead of lying. Solana's `getTransaction` was measured
at a **65ms median**, so the same clock buys it roughly 180 transactions where
the old hard cap stopped at sixty; `maxTx` stays only as a backstop.

`truncated` now means exactly one thing: **the walk stopped with a cursor still
pending.** It is cleared at the top of every iteration, so any exit path is
honest. That was a real bug in the first cut of this fix, caught by verifying
against the live wallet: a walk that ran cleanly to the edge of the window was
still flagged as a floor, because the flag survived from the previous
iteration.

## Verification against the live wallet

`0x9fb365E4E9385E2a39FeBAd70368267e6f571d9A` (win.oneshotagent.com's advertised
Base payTo), real Alchemy, 30-day window:

```
busy / full budget     tx= 30253   usd=$332.18   buyers=46   truncated=false   7141ms
busy / 1.5s budget     tx=  8000   usd=$107.73   buyers=19   truncated=true    1699ms
quiet wallet           tx=     5   usd=$  2.95   buyers= 2   truncated=false    222ms
```

30,253 matches an independent walk of the same wallet exactly, and sits
alongside Bazaar's 29,296 for the same seller and window (ours counts all
inbound USDC to that payTo, which the page already says includes non-x402
transfers). A starved budget returns an honest partial and says so. A quiet
wallet still completes in a single page.

## Regression test

`scripts/test-scan-cap.js`, 26 assertions, offline against stubbed sources so
it spends nothing and needs no key. Registered in the `test-unit-d` CI lane.

It drives a synthetic seller with **25,000 records** through all four walkers
and asserts the whole window comes back, that distinct buyers and volume are
counted across every page rather than the first ten, that a completed walk is
not flagged truncated, and that a budget-stopped walk is.

**The control runs first.** It holds a walker to the old ten-page bound and
requires the stub's 25,000 records to come back as exactly 10,000. A clean sweep
below it is only believable once the harness has reproduced the defect it was
written to catch; if that control ever stops reporting 10,000, the stub is not
paging and every assertion after it is measuring nothing.

Mutations killed:

| Mutation | Caught by |
|---|---|
| Restore `SCAN_MAX_PAGES = 10` | whole-window total reads 10,000 |
| Carry the pending-cursor flag across iterations | a completed walk reports truncated |
| Drop the deadline check (EVM / Stellar / Algorand) | a starved walk reports truncated false |
| Drop Solana's clock bound | a starved Solana walk reports truncated false |
| Restore Solana `maxTx = 60` | Solana total reads 60 |
| Hardcode `truncated = true` | a completed walk reports truncated |
| Hardcode `truncated = false` | the control's capped walk stops admitting it |

## Operational note

The walk is bounded by time, so the cost of a busy wallet is bounded too: at
most one budget's worth of upstream calls per cache refresh, and the 10-minute
SWR cache means only a cold wallet pays it. `MARKET_SCAN_BUDGET_MS` tightens or
loosens that without a code change. Nothing here spends on a paid API; the paid
exact path stays off by its own separate switch.
