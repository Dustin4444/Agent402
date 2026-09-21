# Canonical source for every public number

Written because the same figure was appearing on different pages with different
labels, and two different figures were appearing under the same one. The rule
from here: **a number on a page names the endpoint it came from, and no page
computes its own version of a number another page already publishes.**

## The four call-shaped metrics, and why they differ

These are the ones that read as interchangeable and are not. All four are true.

| Metric | Canonical source | Counts | Typical value |
|---|---|---|---|
| `toolCallsServed.total` | `/api/stats` | Every call this server served, paid or free | 70,505 |
| `toolCallsServed.viaUSDC` | `/api/stats` | Calls served **for a stablecoin payment** | 35,138 |
| `allTime.allTimeInboundCount` | `/api/revenue` | **Inbound on-chain transfers** to our wallets, ours included | 42,104 |
| `allTime.allTimeExternalCount` | `/api/revenue` | The subset of those from **outside** wallets | 8,857 |

A transfer is not a call. `viaUSDC` is what our server did; `allTimeInboundCount`
is what the chain shows arriving. They diverge because inbound includes sweeps
between our own wallets, canary and volume runs, and transfers that do not map
one-to-one onto a served call. Neither is more correct; they answer different
questions, and any page showing both must say which is which.

**Throughput** (`railThroughput`, `/revenue` hero) is
`allTimeInboundCount + mpp.rails.tempo.count`. It is deliberately ours-included
and is labelled that way. It is **not** a call count and must never be labelled
one, which is the defect this document was written after.

## Revenue

| Metric | Source | Counts |
|---|---|---|
| `allTime.allTimeExternalUsd` | `/api/revenue` | Lifetime USD from outside wallets, on-chain |
| `sales.totals.external` | `/api/revenue` | Sale rows recorded by the ledger (all rails incl. card) |
| `mppSales()` | `/api/revenue/mpp` | MPP-wire settlements; aggregate is public, itemized rows are operator-only |

The chain scan and the sales ledger count different events and will not match.
On-chain is the verifiable one and is what `/revenue` headlines.

## Index

| Metric | Source | Counts | Label that must be used |
|---|---|---|---|
| `totals.sellers` | `/api/index` | Distinct seller **origins** crawled | "seller origins indexed" |
| roster length | `/marketplace` | Distinct **payees** after collapsing origins that share a payTo | "distinct payees" |
| `totals.tools` | `/api/index` | Advertised **tool listings** across all sellers | "tool listings" |
| catalog size | `/api/pricing` | **Our own** priced endpoints | "tools" |

Origins and payees are different populations and the marketplace shows both on
purpose, because one operator can run several origins. Neither may be called
"endpoints".

## Our own tool count: 609 exact, "500+" evergreen

Not a contradiction, and deliberately so. Runtime surfaces that derive the count
live (`/api/pricing`, `/openapi.json`, `/health`, `/docs`) publish the exact
number. Static and marketing copy says "500+" so that adding a tool never
requires a documentation sweep, and `scripts/sync-count.js --check` proves in CI
that the claim is honest against the booted server. Do not "reconcile" these by
hardcoding 609 into copy; that is the failure mode the rule exists to prevent.

## Rules

1. **One source per metric.** A page that needs a figure reads the endpoint in
   this table. It does not recompute it from parts.
2. **The label names what is counted.** "Calls", "transfers", "settlements",
   "origins", "payees" and "listings" are not interchangeable.
3. **Ours-included is stated where it is true.** Throughput and
   `allTimeInboundCount` include our own canary and volume traffic. Every
   surface showing them says so in the same breath.
4. **A fallback that changes the metric changes the label.** The homepage hero
   falls back from the chain figure to the served-call figure while the ledger
   warms; the label follows the value.
5. **A figure that cannot be read is omitted, never guessed.** The standing band
   suppresses itself below `MIN_SELLERS_TO_FRAME` rather than publish a cold
   cache's "1 seller origin indexed".
