# x402 Leaderboard

> **Payment wires:** every paid endpoint accepts **x402** and **MPP** (Machine Payments Protocol) on the same 402 - see [[Paying with x402]] and [[Paying with MPP]]. Agent402 is the applied layer of [[Agentic Finance]]: agents that pay and get paid on their own.

`GET /api/leaderboard` is the **public, on-chain ranking of every x402 seller
by Base USDC settled volume**. It's the third surface in Agent402's open x402
index - alongside [`/api/find`](https://agent402.tools/api/find) (resolve a
task to a tool) and [`/api/route`](https://agent402.tools/api/route) (the
neutral Smart Order Router across every seller).

| Surface | Free | What it returns |
|---|---|---|
| `GET /api/find?q={task}` | ✅ | Best matching tools (route, price, schema, example) |
| `POST /api/route {query, top, include}` | ✅ | Smart Order Router across every x402 seller, ranked by match → health → price |
| `GET /api/leaderboard?top=N&include=all\|external` | ✅ | On-chain ranking of every x402 seller by Base USDC settled volume |

## Why on-chain volume

In an open marketplace, anyone can claim anything in a manifest. **What you
can't fake is settlement on a public chain.** Every x402 paid call leaves a
USDC `Transfer` log on Base. The leaderboard reads those logs directly - no
self-reports, no caches you have to trust, no API keys involved.

## Pipeline

1. **Discovery** - walk every page of the [Coinbase CDP Bazaar](https://docs.cdp.coinbase.com/x402/docs/bazaar)
   `discovery/resources` endpoint (`limit=1000`, page until `pagination.total`
   reached). Extract each seller's `payTo` wallet from listings whose `network`
   is Base mainnet (`eip155:8453` / `base`) and whose asset is USDC.
2. **On-chain scan** - call Base USDC `eth_getLogs` in chunks (`CHUNK_BLOCKS`,
   default `9000` blocks per call; `WALLET_CHUNK`, default `200` wallets per
   call) for the `Transfer(_, payTo, _)` topic across the active window. The
   window is the operator's `SPAN_BLOCKS`; the hosted instance runs a **7d**
   window (`302400` Base blocks at ~2s each), and sellers with bursty traffic
   show real revenue there that a tight scan would miss. Never assume the
   window: the response reports the blocks actually scanned in `scannedBlocks`
   and the human label in `windowLabel` / `windowServed`. A chunk that fails
   after every RPC retry is skipped rather than aborting the scan; only an
   all-chunks-failed outage throws.
3. **Per-call ceiling filter** - keep only transfers whose value is ≤ the
   ceiling reported as `maxCallUsd` (`MAX_CALL_USD`, default **$0.75**).
   Anything larger is funding, a swap, or a treasury move, not a paid x402
   call.
4. **Aggregate** - for each seller: `callsSettled` (count), `totalUsd` (sum),
   `uniqueBuyers` (distinct `from` addresses).
5. **Rank** - by `totalUsd` (then `callsSettled`, then seller name) and assign
   a `rank` 1..N.

The snapshot **refreshes hourly server-side**. Requests hit the cache; if the
refresh ever fails, the last good snapshot is preserved.

## Calling it

```bash
# Top 10, including Agent402 itself (top defaults to 25, clamped to 1..500)
curl 'https://agent402.tools/api/leaderboard?top=10'

# Rank only the rest of the ecosystem (exclude Agent402)
curl 'https://agent402.tools/api/leaderboard?top=25&include=external'

# Rank by call count instead of USD (default sort=usd)
curl 'https://agent402.tools/api/leaderboard?sort=calls'

# Window hint. One cached snapshot is served regardless of what you ask for;
# the response echoes your ask in `windowRequested` and what it actually
# served in `windowServed` / `windowLabel`, so the two can never be confused.
curl 'https://agent402.tools/api/leaderboard?window=24h'
```

Returns (the seller array is **`leaderboard`**, not `rows`):

```json
{
  "spec": "x402-leaderboard/1",
  "asOf": "2026-07-30T03:44:45.814Z",
  "scannedBlocks": 302400,
  "windowLabel": "7d",
  "maxCallUsd": 0.75,
  "scannedSellers": 916,
  "walletsQueried": 916,
  "bazaarTotal": 15289,
  "leaderboard": [
    {
      "rank": 1,
      "name": "…",
      "origins": ["https://…"],
      "homepage": "https://…",
      "endpoints": 12,
      "wallet": "0x…",
      "wallets": ["0x…"],
      "walletCount": 1,
      "network": "base",
      "callsSettled": 412,
      "totalUsd": 1.234,
      "uniqueBuyers": 78
    }
  ],
  "cache": { "cachedAt": "…", "lastTriedAt": "…", "lastError": null, "refreshIntervalMs": 3600000 },
  "include": "all",
  "sortServed": "usd",
  "windowRequested": "24h",
  "windowServed": "7d",
  "totalSellers": 745
}
```

Field notes that matter when you parse it:

- **`leaderboard`** is the array. There is no `rows` key.
- The display name is **`name`**. There is no `serviceName` key.
- **`maxCallUsd`** is the per-call ceiling actually applied, and
  **`scannedBlocks`** / **`windowServed`** are the window actually scanned.
  Read them rather than hardcoding a ceiling or a window.
- One seller can settle to several wallets: `wallet` is the primary, `wallets`
  is the full set, and `walletCount` is its size. `origins` likewise lists
  every host origin collapsed into the row.
- `totalSellers` is the size of the full snapshot before `top` slicing, so you
  can tell "25 rows because I asked for 25" from "25 rows because that's all
  there is".

`include=external` excludes the Agent402 payTo (`SELF_WALLET` in the
operator's env) - same logic as `/api/route?include=external`. We list because
we trust the ranking, not because we'd rig it for ourselves.

## Tests & guarantees

- [`scripts/test-x402-leaderboard.js`](https://github.com/MikeyPetrillo/Agent402/blob/main/scripts/test-x402-leaderboard.js)
  - 70 offline assertions covering the parsers, the asset/network filter, the
  ceiling cutoff, and the deterministic tie-break.
- [`scripts/test-leaderboard-surface.js`](https://github.com/MikeyPetrillo/Agent402/blob/main/scripts/test-leaderboard-surface.js)
  - locks the leaderboard surfacing into robots.txt, sitemap.xml, llms.txt,
  the service manifest, and the landing FAQ JSON-LD so a future deploy can't
  silently drop it.

## Related

- [[x402-Index-and-Router]] - Smart Order Router that uses the same Bazaar walk
- [[Architecture]] - where the leaderboard sits relative to the indexer
- [`/.well-known/x402`](https://agent402.tools/.well-known/x402) - the service
  manifest now advertises the leaderboard in both `machineReadable` and
  `discovery` blocks (`refreshSeconds.leaderboard = 3600`)
