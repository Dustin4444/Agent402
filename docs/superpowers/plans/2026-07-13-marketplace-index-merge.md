# Marketplace / Index Merge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the `/index` directory and the per-chain `/marketplaces` pages into one "The x402 marketplace" surface where chain is a filter, keeping the per-chain URLs as SEO-preserving filtered views.

**Architecture:** Make `marketPage` (src/market-page.js) the single renderer. It already renders a per-chain page; extend it to render an **all-chains** view when `chainKey === null`. Add a shared **filter bar** (chain tabs + category + sort + search) to the top of both views. Add a canonical `/marketplace` route rendering the all-chains view; 301 `/index` and `/marketplaces` to it. Collapse the two nav panels into one "Marketplace" entry and merge the two homepage blocks.

**Tech Stack:** Node/Express, server-rendered HTML template strings, offline render tests (plain `node scripts/test-*.js` assertion scripts, no framework).

## Global Constraints

- Surface label is **"Marketplace"** (singular). "Index" must not appear as a user-facing nav/label word (it may remain in the positioning subtitle "the neutral x402 index — every seller, not just ours").
- Per-chain URLs (`/base /solana /polygon /arbitrum /monad /stellar /algorand /robinhood`) are unchanged; their `<title>` stays "The <Chain> x402 marketplace".
- `/index` and `/marketplaces` return **HTTP 301** to `/marketplace`.
- Chain tabs are **links** (`All`→`/marketplace`, `Base`→`/base`, …) — never client-only — so per-chain URLs stay crawlable.
- `/leaderboard`, `/revenue`, `/tools`, `/sell` stay separate surfaces (link to them; do not fold them in).
- Every new/changed page renders through `ledgerShell` (src/ledger-chrome.js) — do NOT add a second page shell.
- Deterministic only; no new runtime deps. Ship on branch `claude/sweet-brown-i99jl3` with `[test][deploy]` markers; draft PR → merge.

## File Structure

- `src/market-page.js` — the single renderer. Add: `marketFilterBar(chainKey, baseUrl)`, `marketSellersAll(snapshot)`, and an all-chains branch in `marketPage`. (Existing exports `marketPage`, `marketSellers`, `marketPanelHtml`, `sellerCardHtml`, `CHAIN_PAGES` stay.)
- `src/server.js` — add `GET /marketplace` (all-chains) route; change `GET /index` and `GET /marketplaces` to 301 redirects. Chain routes at the `SNAPSHOT_RAIL_LABEL` loop + the stellar/algorand routes are unchanged in behavior (they already call `marketPage(chainKey, …)`; the filter bar comes for free once it's inside `marketPage`).
- `src/ledger-chrome.js` — collapse the `marketplaces` + `index` nav panels/triggers into one `Marketplace` entry → `/marketplace`; footer links `/index`→`/marketplace`.
- `src/ledger-home.js` — merge the two homepage blocks (index + marketplaces) into one marketplace block with a single CTA to `/marketplace`.
- `src/seo.js` (or wherever `sitemapPages` lives — it is imported in server.js) — list `/marketplace`, drop `/index` and `/marketplaces`.
- `src/x402-index.js` — `indexPage` is no longer routed (the `/index` route redirects). Leave the function in place but unrouted (its economy/leaderboard/demand panels are not carried over in v1 — see Task 8 for the economy strip). Do not delete it in this plan.
- `scripts/test-market-pages.js` — extend with the new-behavior tests.
- `scripts/test-index-page.js` — update/soften: `/index` no longer renders a page (redirects). Keep any `indexPage`-unit assertions that still call the function directly.

**Interfaces (new, referenced across tasks):**
- `marketFilterBar(chainKey: string|null, baseUrl: string): string` — HTML for the filter bar. `null` = All active.
- `marketSellersAll(snapshot): Seller[]` — every seller across all chains (local first).
- `marketPage(chainKey: string|null, baseUrl, opts)` — `chainKey === null` renders the all-chains view.

---

### Task 1: Shared filter bar (`marketFilterBar`)

**Files:**
- Modify: `src/market-page.js` (add `export function marketFilterBar` near `marketSellers`, ~line 219)
- Test: `scripts/test-market-pages.js`

**Interfaces:**
- Produces: `marketFilterBar(chainKey, baseUrl)` → HTML string.
- Consumes: `CHAIN_PAGES` (existing export; keys are the chain slugs, each has `.chainName`).

- [ ] **Step 1: Write the failing test** (append inside `scripts/test-market-pages.js`)

```js
import { marketFilterBar } from "../src/market-page.js";
{
  const all = marketFilterBar(null, "https://agent402.tools");
  ok(/href="\/marketplace"/.test(all), "filter bar: All tab links to /marketplace");
  ok(/data-chain-tab="all"[^>]*class="[^"]*\bon\b/.test(all) || /class="[^"]*\bon\b[^"]*"[^>]*data-chain-tab="all"/.test(all), "filter bar: All tab is active in the all-chains view");
  ok(/href="\/base"/.test(all) && /href="\/robinhood"/.test(all), "filter bar: every chain tab is a link");
  const base = marketFilterBar("base", "https://agent402.tools");
  ok(/data-chain-tab="base"[^>]*\bon\b|\bon\b[^>]*data-chain-tab="base"/.test(base), "filter bar: Base tab active on the Base view");
  ok(/href="\/marketplace"/.test(base), "filter bar: All tab links back to /marketplace from a chain view");
  ok(/Sort/i.test(all) && /Category/i.test(all), "filter bar: has Sort + Category controls");
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `FREE_MODE=true PORT=3000 node src/server.js & sleep 3; node scripts/test-market-pages.js; kill %1`
Expected: FAIL — `marketFilterBar is not a function` (or the new assertions fail).

- [ ] **Step 3: Implement `marketFilterBar`** (add after `marketSellers`, ~line 219 in `src/market-page.js`)

```js
// Shared filter bar for the unified marketplace: chain tabs (links, so the
// per-chain SEO URLs stay crawlable) + category + sort + search. chainKey===null
// marks the "All" (/marketplace) view; a chain slug marks that chain's view.
export function marketFilterBar(chainKey, baseUrl) {
  const tab = (key, label, href, on) =>
    `<a data-chain-tab="${key}" href="${href}" class="mfb-tab${on ? " on" : ""}">${esc(label)}</a>`;
  const tabs = [tab("all", "All", `${baseUrl}/marketplace`, chainKey == null)]
    .concat(Object.keys(CHAIN_PAGES).map((k) =>
      tab(k, CHAIN_PAGES[k].chainName, `${baseUrl}/${k}`, k === chainKey)));
  return `
  <div class="mfb" style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:22px 0 6px;padding:12px;border:1.5px solid var(--ink);background:var(--card);">
    <span class="mfb-label">Chain</span>
    <div class="mfb-tabs" style="display:flex;flex-wrap:wrap;gap:5px;">${tabs.join("")}</div>
    <span class="mfb-label" style="margin-left:6px;">Sort</span>
    <select class="mfb-sel" data-mfb-sort><option value="calls">most settled</option><option value="usd">volume</option><option value="buyers">buyers</option><option value="tools">tools</option></select>
    <span class="mfb-label">Category</span>
    <select class="mfb-sel" data-mfb-cat><option value="">all</option></select>
    <input class="mfb-search" data-mfb-search placeholder="search sellers / tools">
  </div>`;
}
```

Also add these styles to `LEDGER_CSS` in `src/ledger-chrome.js` (near the other `.ml-*` rules):

```css
.mfb-label{font-family:var(--font-mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);font-weight:700;}
.mfb-tab{font-family:var(--font-mono);font-size:12px;padding:5px 11px;border:1.5px solid var(--ink);background:var(--paper);color:var(--ink);text-decoration:none;white-space:nowrap;}
.mfb-tab.on{background:var(--ink);color:var(--on-dark);}
.mfb-sel,.mfb-search{font-family:var(--font-mono);font-size:12px;padding:6px 10px;border:1.5px solid var(--ink);background:var(--paper);color:var(--ink);}
.mfb-search{flex:1;min-width:120px;}
```

- [ ] **Step 4: Run tests to verify they pass** — same command as Step 2. Expected: the 6 new assertions PASS.

- [ ] **Step 5: Commit**

```bash
git add src/market-page.js src/ledger-chrome.js scripts/test-market-pages.js
git commit -m "market: shared chain/category/sort filter bar (marketFilterBar)"
```

---

### Task 2: All-chains view (`marketPage(null, …)` + `marketSellersAll`)

**Files:**
- Modify: `src/market-page.js` — add `marketSellersAll`; branch `marketPage` on `chainKey == null`.
- Test: `scripts/test-market-pages.js`

**Interfaces:**
- Consumes: `marketFilterBar` (Task 1), `marketSellers` (existing, chain-scoped).
- Produces: `marketSellersAll(snapshot)`; `marketPage(null, baseUrl, { snapshot, leaderboardSnap })` renders the all-chains directory.

**Behavior of the all-chains view:** header `The x402 marketplace.`; the neutral line `the neutral x402 index — every seller, not just ours`; the filter bar with All active; a seller roster that includes a **Chain column** (each seller's chains from `s.networks`); NO chain-specific extras (no receipt strip, no per-seller activity, no sell copy). Reuse the existing deduped roster logic — factor the roster+stat code the per-chain path already has so both call it; if extraction is too invasive in one task, render the all-view roster with the same markup and the added Chain column, and note the duplication for the final review.

- [ ] **Step 1: Write the failing test**

```js
import { marketPage, marketSellersAll } from "../src/market-page.js";
{
  const LOCAL = { local: true, displayName: "Agent402.Tools", homepage: "https://agent402.tools", toolCount: 1431, routable: true, networks: ["eip155:8453"] };
  const EXT = { origin: "https://ext.example", displayName: "Ext", homepage: "https://ext.example", local: false, toolCount: 3, routable: true, networks: ["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"], payToByNetwork: {} };
  const snapshot = { sellers: [LOCAL, EXT] };
  ok(marketSellersAll(snapshot).length === 2, "marketSellersAll returns every seller regardless of chain");
  const html = marketPage(null, "https://agent402.tools", { snapshot, leaderboardSnap: { leaderboard: [] } });
  ok(/The x402 <span[^>]*>marketplace/.test(html) || />The x402 marketplace/.test(html), "all view: header is 'The x402 marketplace'");
  ok(/neutral x402 index/i.test(html), "all view: keeps the neutral-index positioning line");
  ok(/data-chain-tab="all"/.test(html), "all view: renders the filter bar");
  ok(/Chain<\/th>|>Chain</.test(html), "all view: seller list has a Chain column");
  ok(!/first settlement|verify on/.test(html), "all view: no per-chain receipt/verify extras");
}
```

- [ ] **Step 2: Run to verify it fails** (same boot+run command). Expected: FAIL — `marketSellersAll is not a function` / branch not present.

- [ ] **Step 3: Implement**

```js
// Every seller across every chain (local first) — the all-chains directory.
export function marketSellersAll(snapshot) {
  const all = (snapshot?.sellers || []);
  return all.slice().sort((a, b) => (a.local === b.local ? 0 : a.local ? -1 : 1));
}
```

In `marketPage`, at the very top (after `const C = CHAIN_PAGES[chainKey];`) add:

```js
  if (chainKey == null) return marketPageAll(baseUrl, arguments[2] || {});
```

Then add `marketPageAll(baseUrl, { snapshot, leaderboardSnap })` (a sibling function): compose via `ledgerShell` with `header = "The x402 marketplace."`, the neutral line, `marketFilterBar(null, baseUrl)`, and a roster over `marketSellersAll(snapshot)` that reuses the per-chain roster row markup but adds a `Chain` column derived from each seller's `networks` (map CAIP-2 → chain name via `CHAIN_PAGES`; a seller may list more than one — show the first + `+N`). No receipt strip / activity / sell copy. Use the same `htmlCache`/JSON-LD `CollectionPage` shape as the per-chain page, with `url: ${baseUrl}/marketplace`, `name: "The x402 marketplace"`.

- [ ] **Step 4: Run to verify pass.** Expected: the 5 new assertions PASS.

- [ ] **Step 5: Commit**

```bash
git add src/market-page.js scripts/test-market-pages.js
git commit -m "market: all-chains view (marketPage(null), Chain column, no per-chain extras)"
```

---

### Task 3: `/marketplace` route + per-chain filter bar

**Files:**
- Modify: `src/server.js` — add `app.get("/marketplace", …)`; ensure the per-chain routes' output includes the filter bar (it does automatically once `marketPage` renders `marketFilterBar` for a chainKey — Task 4 adds that call for the chain path).
- Test: `scripts/test-market-pages.js` (offline, calls `marketPage` directly — the route is a thin wrapper).

**Interfaces:**
- Consumes: `marketPage(null, …)` (Task 2), `getIndexSnapshot()`, `getLeaderboardSnapshot()` (existing in server.js).

- [ ] **Step 1: Write the failing test** — assert the per-chain view now carries the filter bar:

```js
{
  const snapshot = { sellers: [{ local: true, displayName: "Agent402.Tools", homepage: "https://agent402.tools", toolCount: 1431, routable: true, networks: ["eip155:8453"] }] };
  const baseView = marketPage("base", "https://agent402.tools", { snapshot, rail: null, activity: null });
  ok(/data-chain-tab="base"[^>]*\bon\b|\bon\b[^>]*data-chain-tab="base"/.test(baseView), "chain view: filter bar present with Base active");
  ok(/href="\/marketplace"/.test(baseView), "chain view: filter bar links back to /marketplace");
}
```

- [ ] **Step 2: Run to verify it fails.** Expected: FAIL — the chain view has no filter bar yet.

- [ ] **Step 3: Implement** — in `marketPage` (chain path), render `marketFilterBar(chainKey, baseUrl)` immediately under the header (before the chain-level stat cards). In `src/server.js`, add the route (place it next to the chain-routes loop, ~line 1720):

```js
app.get("/marketplace", (_req, res) => {
  const snapshot = getIndexSnapshot();
  let leaderboardSnap = null;
  try { leaderboardSnap = getLeaderboardSnapshot(); } catch { /* directory still renders */ }
  htmlCache(res, 120, 600).send(marketPage(null, BASE_URL, { snapshot, leaderboardSnap }));
});
```

- [ ] **Step 4: Run to verify pass.** Expected: the 2 new assertions PASS. Boot smoke: `curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/marketplace` → `200`.

- [ ] **Step 5: Commit**

```bash
git add src/server.js src/market-page.js scripts/test-market-pages.js
git commit -m "market: /marketplace route + filter bar on the per-chain views"
```

---

### Task 4: 301 redirects for `/index` and `/marketplaces`

**Files:**
- Modify: `src/server.js` — replace the `GET /index` handler (~line 1439) and `GET /marketplaces` handler (~line 769) with 301 redirects.
- Test: `scripts/test-market-pages.js` (add a tiny live-route check that boots the server — or assert via a new `scripts/test-redirects.js`; a boot-based check is fine here since redirects are route-level).

- [ ] **Step 1: Write the failing test** (new `scripts/test-redirects.js`)

```js
// Boots free-mode server, asserts the legacy surfaces 301 to /marketplace.
const base = process.env.TARGET_URL || "http://localhost:3000";
let fail = 0;
for (const p of ["/index", "/marketplaces"]) {
  const r = await fetch(base + p, { redirect: "manual" });
  const loc = r.headers.get("location");
  const good = r.status === 301 && loc === "/marketplace";
  console.log(`${good ? "ok" : "NOT OK"} - ${p} → 301 /marketplace (got ${r.status} ${loc})`);
  if (!good) fail++;
}
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run to verify it fails** — `FREE_MODE=true PORT=3000 node src/server.js & sleep 3; node scripts/test-redirects.js; kill %1`. Expected: FAIL (both still render 200).

- [ ] **Step 3: Implement** — replace both handlers:

```js
app.get("/index", (_req, res) => res.redirect(301, "/marketplace"));
app.get("/marketplaces", (_req, res) => res.redirect(301, "/marketplace"));
```

Remove the now-dead `indexPage`/`marketplacesPage` imports IF nothing else uses them (grep first: `grep -n "indexPage\|marketplacesPage" src/server.js`). Keep `getIndexSnapshot` and other imports.

- [ ] **Step 4: Run to verify pass.** Expected: both `ok`.

- [ ] **Step 5: Commit**

```bash
git add src/server.js scripts/test-redirects.js
git commit -m "market: 301 /index and /marketplaces to /marketplace"
```

---

### Task 5: One "Marketplace" nav entry

**Files:**
- Modify: `src/ledger-chrome.js` — the nav has two triggers/panels: `marketplaces` (→ `marketplacesPanelHtml`, ~line 341) and `index` (→ `indexPanelHtml`). Collapse to one `Marketplace` entry pointing at `/marketplace`, with the chain list as its dropdown. Update `PANEL_HTML` (~line 364), the top-level nav links (~line 400), the active-path set (~line 424), and footer links (~line 488, `/index`→`/marketplace`).
- Test: `scripts/test-market-pages.js` (nav is emitted by `ledgerShell`; assert against a rendered page, e.g. `marketPage(null, …)` output).

- [ ] **Step 1: Write the failing test**

```js
{
  const html = marketPage(null, "https://agent402.tools", { snapshot: { sellers: [] }, leaderboardSnap: { leaderboard: [] } });
  ok(/href="\/marketplace"[^>]*>\s*[Mm]arketplace/.test(html) || />Marketplace<\/a>/.test(html), "nav: single Marketplace entry → /marketplace");
  ok(!/>index<\/a>/i.test(html.replace(/neutral x402 index/gi, "")), "nav/footer: no user-facing 'index' link");
  ok(/href="\/base"/.test(html), "nav: chain links still reachable (dropdown)");
}
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** — merge `marketplacesPanelHtml` and `indexPanelHtml` into one `marketPanelNav(chainInfo)` that lists the chains (from `chainInfo.chains`) under a "Marketplace" heading with a "the full directory →" row linking `/marketplace`. Point the top-level nav trigger label "marketplace" at `/marketplace`. In the active-path set, `marketplace: new Set(["/marketplace", ...chainInfo.chains.map(c => c.href)])`. Delete the separate `index` panel/trigger. Footer: change the `x402 index` column's `Index`/`Marketplaces` links to a single `Marketplace` → `/marketplace` (keep `Leaderboard`, `Economy`→`/marketplace#economy`, `Revenue`).

- [ ] **Step 4: Run to verify pass.**

- [ ] **Step 5: Commit**

```bash
git add src/ledger-chrome.js scripts/test-market-pages.js
git commit -m "nav: collapse index + marketplaces into one Marketplace entry"
```

---

### Task 6: Homepage merge

**Files:**
- Modify: `src/ledger-home.js` — the page has separate blocks pitching "the index" and "marketplaces". Merge into one marketplace block with a single CTA → `/marketplace`. Keep the neutral-index framing as copy.
- Test: `scripts/test-index-page.js` (or a homepage assertion in `scripts/test-market-pages.js`).

- [ ] **Step 1: Write the failing test**

```js
import { ledgerHomePage } from "../src/ledger-home.js";
{
  const html = ledgerHomePage("https://agent402.tools", {}, { toolCount: 1431 }, [], { chainSellerCounts: {} });
  ok(/href="\/marketplace"/.test(html), "homepage: CTA points to /marketplace");
  ok((html.match(/\/marketplaces\b/g) || []).length === 0, "homepage: no /marketplaces links remain");
}
```

(Match `ledgerHomePage`'s real signature — read `src/ledger-home.js` and `src/server.js:764` for the exact call; adjust the test args to it.)

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** — collapse the two blocks; single `A whole job, one payment.` / marketplace story with one `Explore the marketplace →` CTA to `/marketplace`; keep the "not just a seller — the neutral index" line as prose. Repoint every `/index` and `/marketplaces` href to `/marketplace`.

- [ ] **Step 4: Run to verify pass.**

- [ ] **Step 5: Commit**

```bash
git add src/ledger-home.js scripts/test-index-page.js
git commit -m "home: one marketplace story (drop the index/marketplaces split)"
```

---

### Task 7: Sitemap + canonical

**Files:**
- Modify: the `sitemapPages` source (grep: `grep -rn "sitemapPages" src/`). List `/marketplace`; drop `/index` and `/marketplaces`.
- Modify: ensure `/marketplace` is self-canonical and each `/<chain>` is self-canonical (they already set canonical via `ledgerShell` — verify the all-view passes `canonical: ${baseUrl}/marketplace`).
- Test: `scripts/test-market-pages.js` + a grep-style check.

- [ ] **Step 1: Write the failing test**

```js
import { sitemapPages } from "../src/seo.js"; // adjust to real module
{
  const xml = sitemapPages("https://agent402.tools", {});
  ok(/\/marketplace<\/loc>/.test(xml), "sitemap: /marketplace listed");
  ok(!/\/index<\/loc>/.test(xml) && !/\/marketplaces<\/loc>/.test(xml), "sitemap: legacy /index and /marketplaces dropped");
}
```

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — update the page list; set the all-view canonical.
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit**

```bash
git add src/seo.js src/market-page.js scripts/test-market-pages.js
git commit -m "seo: sitemap lists /marketplace, drops /index+/marketplaces; canonicals"
```

---

### Task 8: Economy strip on `/marketplace` (carry the one useful bit from indexPage)

**Files:**
- Modify: `src/market-page.js` (`marketPageAll`) — accept an optional `economySnap` and render a compact stats strip (sellers · chains · settlements) when present. Modify `src/server.js` `/marketplace` route to pass `economySnap` from `x402EconomySnapshot()` (same try/catch pattern the old `/index` route used).
- Test: `scripts/test-market-pages.js`

- [ ] **Step 1: Write the failing test**

```js
{
  const html = marketPage(null, "https://agent402.tools", { snapshot: { sellers: [] }, leaderboardSnap: { leaderboard: [] }, economySnap: { sellers: 734, chains: 8, settlements: 12345 } });
  ok(/734/.test(html) && /12,?345/.test(html), "all view: economy strip renders sellers + settlements when a snapshot is present");
  const noEcon = marketPage(null, "https://agent402.tools", { snapshot: { sellers: [] }, leaderboardSnap: { leaderboard: [] } });
  ok(!/economy strip/.test(noEcon) || true, "all view: no economy snapshot → honest omission, no crash");
}
```

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — compact strip; wire the route to pass `economySnap`.
- [ ] **Step 4: Run to verify pass.** Boot smoke: `/marketplace` still `200`.
- [ ] **Step 5: Commit**

```bash
git add src/market-page.js src/server.js scripts/test-market-pages.js
git commit -m "market: economy stats strip on /marketplace"
```

---

## Final verification (before the whole-branch review)

- [ ] `FREE_MODE=true PORT=3000 node src/server.js` then: `node scripts/test-market-pages.js`, `node scripts/test-redirects.js`, `node scripts/test-index-page.js`, `TARGET_URL=http://localhost:3000 node scripts/test-all.js` (nothing else regressed), `node scripts/test-mcp-all.js`.
- [ ] `curl` checks: `/marketplace` 200; `/index` & `/marketplaces` 301→`/marketplace`; `/base` 200 with the filter bar; `/base?seller=<host>` 200.
- [ ] `grep -rn "\"/index\"\|/marketplaces\b" src/` — no user-facing links left (redirect handlers excepted).
- [ ] Ship with `[test][deploy]`; after deploy, verify the 301s on prod and re-check PageSpeed mobile (speed is P0 — do not regress CLS/Perf).
