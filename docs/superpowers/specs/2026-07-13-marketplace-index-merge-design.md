# Merge "index" and "marketplaces" into one "Marketplace" surface — Design

**Status:** Approved (design). Ready for implementation planning.
**Date:** 2026-07-13
**Owner:** Havok Holdings LLC

## Problem

The site exposes two surfaces that are both **lists of x402 sellers**, built from the
same crawled data (`getIndexSnapshot`):

- **`/index`** — the cross-chain directory: every seller, health, on-chain ranking,
  economy. Nav labels it "all sellers · health / the full directory."
- **`/marketplaces` → `/base`, `/solana`, …** — per-chain pages: "Sellers settling on
  Base," that chain's tool catalog, activity charts, and sell/facilitator copy.

The only real difference is the *slice* — `/index` is "by seller, all chains"; each
marketplace is "by chain." A visitor can't tell which door to use because both open onto
the same room. The owner is confused; a first-time consumer will be too. This is
information-architecture over-segmentation.

**Constraint that shapes the solution:** the per-chain pages (`/base`, `/stellar`, …) are
also **SEO landing pages**, each positioned to own its "<Chain> x402 marketplace" search
term (there is a dedicated spec for the Stellar one). A naive collapse into one filtered
page would surrender those positions.

## Goal

One coherent surface — **"The x402 marketplace"** — where **chain is a filter**, not a
separate concept. Retire "index" and "marketplaces" as competing user-facing ideas.
Preserve the per-chain SEO landing pages as *filtered views* of that one surface.

## Decisions (locked with owner)

1. **Merge scope:** one directory; chain becomes a filter. Keep the per-chain URLs as
   SEO landing pages, framed as filtered states of the directory. Kill the separate
   "marketplaces" concept.
2. **Name:** **"Marketplace"** (singular). "Index" retires as a *user-facing* word (the
   word may still appear in a positioning subtitle — see #7).

## Design

### 1. URL map & redirects

- **`/marketplace`** (new canonical) = the unified all-chains directory. This is what
  `/index` is today, reframed.
- **`/base`, `/solana`, `/polygon`, `/arbitrum`, `/monad`, `/stellar`, `/algorand`,
  `/robinhood`** (all 8 chain pages) = chain-filtered *views* of the same surface. URLs
  unchanged (SEO); titles stay "The <Chain> x402 marketplace."
- **`/index`** → **301** → `/marketplace` (transfers existing SEO equity).
- **`/marketplaces`** (plural hub) → **301** → `/marketplace`.

Canonical tags: `/marketplace` self-canonical; each `/<chain>` self-canonical (they are
distinct, indexable landing pages, not duplicates — they carry chain-specific content).

### 2. One shared layout (the core change)

Today `/index` (`indexPage`, `src/x402-index.js`) and `/<chain>` (`marketPage`,
`src/market-page.js`) are two different renderers — the root of the confusion. Unify them
so both render through **one component** with a `chain` parameter (`null` = all chains,
or a specific chain key):

- **Header:** "The x402 marketplace" (all) / "The <Chain> x402 marketplace" (chain).
- **Filter bar** (the unifying element): `Chain [All · Base · Solana · …]` + `Category` +
  `Sort` + free-text search.
- **Seller list:** the existing deduped roster (`market-page.js`, one row per settling
  wallet with `+N more endpoints`). In the **All** view it shows a **Chain** column; in a
  chain view the chain column is dropped.
- **Chain-only extras** (rendered *below the list*, only when a chain is active): the
  settlement receipt strip, the per-seller activity charts, and the chain-specific
  sell/facilitator copy — the content that already lives on the per-chain pages.

The shared renderer lives in `src/market-page.js` (already the per-chain renderer);
`indexPage`'s all-chains directory becomes the `chain: null` branch of it. `x402-index.js`
keeps the crawl/snapshot/data role; the *page* rendering consolidates into the market
renderer.

### 3. Filter behavior

- **Chain tabs are links** — `All` → `/marketplace`, `Base` → `/base`, etc. Chain
  selection is real navigation so the per-chain URLs stay crawlable for SEO. It uses the
  in-place panel swap already shipped (PR #382): `history.pushState` + fetch the panel,
  no full reload.
- **Category / Sort / search** are in-page filters within the current chain scope. Sort
  options: most settled (default), volume, buyers, tools, health. These may be query
  params (`?cat=`, `?sort=`) for shareability; filtering is client-side over the already-
  rendered roster where possible.

### 4. What folds in vs stays separate

- **Folds into `/marketplace`:** the seller directory (`/index`), the per-chain
  marketplaces, and the entire "marketplaces vs index" nav split.
- **Stays separate, linked from `/marketplace`:** `/leaderboard` (on-chain ranking view),
  `/revenue` (our own settlement ledger), `/tools` (the tool catalog), `/sell` (seller
  onboarding). These are distinct enough not to muddy the merge. The economy stats that
  lived at `/index#economy` move to a compact stats strip on `/marketplace` (or remain a
  section there).

### 5. Navigation

- Replace the two nav panels ("marketplaces" + "index") with **one "Marketplace" entry**
  → `/marketplace`, with the chain list as its dropdown (the chain hrefs already live
  under the marketplaces trigger — see `ledger-chrome.js`).
- Footer + any inline links to `/index` and `/marketplaces` point at `/marketplace` (the
  301s cover stragglers).

### 6. Homepage

The two homepage blocks that separately pitch "the index" and "marketplaces"
(`src/ledger-home.js`) merge into one marketplace story. Keep the neutral-index framing
as copy (see #7), but a single call-to-action to `/marketplace`.

### 7. Keep the neutral positioning

Even with the "Marketplace" label, keep a visible line — **"the neutral x402 index —
every seller, not just ours"** — on `/marketplace` (and the chain views: "every Base
seller, not just ours"). This preserves the strategic third-party stance that the "index"
brand carried, without making "index" a navigational concept.

## Out of scope

- Changing the crawl/discovery pipeline, the leaderboard ranking math, or revenue
  scanners.
- Merging `/leaderboard`, `/revenue`, or `/tools` into the marketplace.
- New filter dimensions beyond chain/category/sort/search.
- Redesigning the seller card or activity charts (recent work; reused as-is).

## SEO & redirect safety

- `/index` and `/marketplaces` return **301** (permanent) to `/marketplace` so link
  equity transfers and crawlers update.
- Per-chain pages keep their exact URLs, titles, and chain-specific copy — the landing
  positions are untouched.
- Update `sitemap-pages.xml` to list `/marketplace` and drop `/index`, `/marketplaces`.
- Update any internal `<link rel=canonical>` / JSON-LD on the affected pages.

## Testing

- **Offline render tests** (extend `scripts/test-market-pages.js`): the shared renderer
  produces the all-chains view (`chain: null`) with a Chain column + filter bar, and each
  chain view (scoped list, no chain column, chain extras present). Assert the filter bar,
  neutral line, and (for chain views) the receipt strip / activity / sell copy.
- **Redirect tests:** `/index` and `/marketplaces` → 301 → `/marketplace`.
- **Nav test:** one "Marketplace" entry; no "index"/"marketplaces" split; chain dropdown
  present.
- **Boot smoke:** `/marketplace`, `/base`, `/base?seller=`, `/api/market/base/panel` all
  200; free-mode fallback intact.
- Run `node scripts/sync-count.js` if any count-bearing surface copy changes.

## Rollout notes

- Single dev-branch PR flow (`claude/sweet-brown-i99jl3`), `[test][deploy]` markers.
- After deploy: verify the 301s and the unified surface on prod; re-check PageSpeed
  mobile (speed is a P0 — do not regress CLS/Perf).
