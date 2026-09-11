# Listing the ecosystem dataset on Snowflake and Databricks

What we publish, what each platform needs from us, and the exact steps to load
a day into either one.

The dataset is the dated record written by `src/dataset-snapshot.js` to
`datasets/v1/dt=YYYY-MM-DD/` in the backup bucket. Read that file's header
before changing anything here: the four rules it enforces (immutable days,
column allowlist, first-party only, counts never rosters) are what make the
data publishable at all.

## What is in a day

| Table | Grain | Why a buyer wants it |
|---|---|---|
| `sellers` | one row per crawled x402/MPP origin | the directory: who exists, on which chains, healthy or not, and whether our router will actually pay them |
| `routes` | one row per endpoint | **the differentiator.** Price with *provenance*: whether the origin declared it or we learned it from a live 402, when it was observed, whether it was carried forward from an older crawl |
| `settlement_base` | one row per Base payee | settled call counts, distinct buyer counts, USD |
| `settlement_solana` | one row per Solana payTo | inbound USDC credits over the window |
| `settlement_mpp` | one row per Tempo recipient | transfers, volume, payer counts |

Scale as of 2026-09-11: 3,935 origins, 101,530 endpoints, 93,256 of them paid.

**The routes table is the thing that is not free anywhere else.** Our own
public `/api/route` carries a price; it does not carry where the price came
from, when it was last seen, or whether it disagrees with what the origin
advertises. That provenance only exists because we crawl and re-probe on a
schedule, and it is what makes a time series of this data worth buying rather
than scraping once.

## Provider profile fields (both platforms ask for these)

Both marketplaces require the same identity block. Use these, which are the
canonical published surfaces and are kept current by CI:

| Field | Value |
|---|---|
| Provider name | Havok Holdings LLC |
| Product name | Agent402 x402 / MPP Ecosystem Dataset |
| Website | https://agent402.tools |
| About / company | https://agent402.tools/company |
| Business + support email | mike@agent402.tools |
| Terms of service | https://agent402.tools/terms |
| Privacy policy | https://agent402.tools/privacy |
| Security | https://agent402.tools/security |
| Logo | https://agent402.tools/logo.png |

Never type the operating entity into a listing field by hand from memory - read
it off `/company`, which is the one canonical answer.

## Description copy

> A daily, immutable record of the agent-payments ecosystem: every x402 and MPP
> endpoint we can discover, what it charges, on which chains it settles, and
> who is actually being paid.
>
> Each day carries five tables. `sellers` is the directory of crawled origins
> with health and payment networks. `routes` carries per-endpoint pricing with
> provenance - whether the origin declared the price or it was read from a live
> 402 challenge, when it was last observed, and whether it disagrees with the
> origin's own published figure. Three settlement tables carry counts of
> settled calls and distinct payers per payee on Base, Solana and Tempo.
>
> First-party: our own crawl, our own live probes, and public chain reads.
> Third-party measurements are excluded and named in each day's manifest.
> Seller payout addresses are published as the join key across tables; buyer
> identities are never published, and buyer figures are counts only.

## Loading a day

Download the day first (needs the `BACKUP_S3_*` credentials):

    node scripts/dataset-export.mjs --day 2026-09-11 --out ./export

That writes `export/dt=2026-09-11/*.ndjson` plus `manifest.json`, decompressed
and ready to stage.

- **Snowflake:** `snowflake.sql` in this directory.
- **Databricks:** `databricks.sql` in this directory.

## Platform requirements, verified 2026-09-11

**Snowflake.** A full account - not a trial, not a Reader account. ORGADMIN
must accept the combined Provider and Consumer Terms. Create the provider
profile in Provider Studio and submit it; review is *"approximately 1 business
day"*, and listing metadata review is the same. For a PAID listing you must
also set up a Stripe Express connected account and contact a Snowflake business
development partner or file a case with Marketplace Operations **before**
creating the listing - that step has no published SLA, which is the real
unknown in the schedule. A free listing can realistically be live in about two
business days.

**Databricks.** Premium plan or above, a Unity Catalog-enabled workspace, and
account-admin to sign up, then a Marketplace admin for ongoing management. A
private exchange is self-service and immediate. A **public** listing requires
applying through the Databricks Data Partner Program, and the partner team
contacts you - no published SLA.

Know before ranking Databricks: **it does not process payment for data
listings.** Provider and consumer agree terms off-platform and the data is then
shared over Delta Sharing. Databricks takes no cut and also collects no money,
so a paid listing there is a lead form, not a checkout. List it for reach, not
revenue.

## Delta Sharing without the marketplace

Delta Sharing is an open protocol. The `databricks.sql` share created below can
be served from our own infrastructure with the open-source reference server,
and a recipient on Databricks, Snowflake, Spark or pandas reads it natively -
no platform account, no listing review, no revenue share. That is the fastest
route to "usable on Databricks" and the work is not wasted if a listing follows.
