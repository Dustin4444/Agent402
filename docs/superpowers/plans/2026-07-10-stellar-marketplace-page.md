# /stellar Marketplace Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `GET /stellar` — the "Stellar x402 marketplace" page — rendered live from the existing index snapshot plus real Stellar settlement receipts.

**Architecture:** One new pure-renderer module (`src/stellar-page.js`) with exported filter helpers, consumed by a thin async route in `src/server.js` that reads the memoized index snapshot (`getIndexSnapshot()`) and best-effort `stellarRail()` receipts. Sitemap + footer nav updates make it discoverable; IndexNow re-submission happens automatically on deploy. Spec: `docs/superpowers/specs/2026-07-10-stellar-marketplace-page-design.md`.

**Tech Stack:** Node ESM, server-rendered HTML via the existing `ledgerShell` chrome. No new dependencies, no new state.

## Global Constraints

- The exact phrase `Stellar x402 marketplace` must appear in the `<title>`, the `<h1>`, and the meta description.
- Honesty rules: the sellers section states plainly when Agent402 is the only listed seller; receipts are real (`stellarRail` data with stellar.expert tx links) or an explicit "live receipts temporarily unavailable" line — never invented or stale.
- Free surface: no paywall, no `WALLET_ONLY_SLUGS` change, no tool-count change (`sync-count.js` untouched).
- Remote index sellers carry NO per-tool list in the snapshot (only `toolCount` + `networks` union) — the browse section renders LOCAL tools only; external sellers render at seller level.
- Commit messages: plain, no CI markers until the ship commit, no AI attribution.
- Machine pointer shown on page: `GET /api/route?q=<task>&network=stellar` (this filter already works — do not modify the router).

---

### Task 1: Renderer module + offline tests

**Files:**
- Create: `src/stellar-page.js`
- Create: `scripts/test-stellar-page.js`

**Interfaces:**
- Consumes: `ledgerShell({title, description, canonical, baseUrl, activePath, jsonLd, body})` and `ledgerFooterCompact()` from `./ledger-chrome.js` (existing).
- Produces (Task 2 relies on these exact names): `stellarSellers(snapshot) -> seller[]`, `stellarTools(snapshot) -> tool[]`, `stellarPage(baseUrl, { snapshot, rail }) -> html string`.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-stellar-page.js`:

```js
// Offline unit tests for the /stellar marketplace page renderer. Fixture
// snapshot + fixture rail — no server, no network.
import { stellarSellers, stellarTools, stellarPage } from "../src/stellar-page.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

const localTools = [
  { slug: "hash", name: "Hash", category: "encoding", price: 0.001 },
  { slug: "search", name: "Web search", category: "search", price: 0.01 },
  { slug: "stock-quote", name: "Stock quote", category: "finance", price: 0.01 },
];
const LOCAL = { origin: "self", displayName: "Agent402.Tools", homepage: "https://agent402.tools", local: true, toolCount: 3, tools: localTools };
const EXT_STELLAR = { origin: "https://ext1.example", displayName: "Ext One", homepage: "https://ext1.example", local: false, toolCount: 4, routable: true, networks: ["stellar:pubnet", "eip155:8453"] };
const EXT_EVM = { origin: "https://ext2.example", displayName: "Ext Two", homepage: "https://ext2.example", local: false, toolCount: 2, routable: true, networks: ["eip155:8453"] };

const snapBoth = { sellers: [LOCAL, EXT_STELLAR, EXT_EVM], totals: { sellers: 3 } };
const snapOnlyUs = { sellers: [LOCAL, EXT_EVM], totals: { sellers: 2 } };

// Filter helpers
let s = stellarSellers(snapBoth);
ok(s.length === 2 && s[0].local === true && s[1].origin === "https://ext1.example",
  "stellarSellers keeps local + stellar-network sellers, drops EVM-only");
ok(stellarSellers(snapOnlyUs).length === 1, "stellarSellers is 1 when only local qualifies");
ok(stellarTools(snapBoth).length === 3 && stellarTools(snapBoth)[0].slug === "hash",
  "stellarTools returns the local catalog's tools");

// Page render — rail present
const rail = { balance: 0.042, recent: [
  { tx: "https://stellar.expert/explorer/public/tx/abc123", when: "2026-07-10T04:15:00Z", usd: 0.001, from: "GBA2DDJ4X", external: false, internal: true },
] };
let html = stellarPage("https://agent402.tools", { snapshot: snapOnlyUs, rail });
ok(html.includes("Stellar x402 marketplace"), "title phrase present");
ok((html.match(/Stellar x402 marketplace/g) || []).length >= 3, "phrase appears in title, h1 and description");
ok(html.includes("stellar.expert/explorer/public/tx/abc123"), "real receipt tx link rendered");
ok(html.includes("1 seller live"), "honesty line rendered when only local seller");
ok(html.includes("network=stellar"), "machine route-filter snippet present");
ok(html.includes("application/ld+json"), "JSON-LD present");
ok(html.includes("OfferCatalog"), "OfferCatalog JSON-LD type present");

// Page render — rail unavailable
html = stellarPage("https://agent402.tools", { snapshot: snapOnlyUs, rail: null });
ok(html.includes("temporarily unavailable"), "rail=null renders the unavailable line");
ok(!html.includes("stellar.expert/explorer/public/tx/"), "no receipt link invented without rail");

// Two sellers → no honesty line, seller row rendered
html = stellarPage("https://agent402.tools", { snapshot: snapBoth, rail: null });
ok(!html.includes("1 seller live"), "honesty line absent with an external stellar seller");
ok(html.includes("Ext One"), "external stellar seller rendered");
ok(!html.includes("Ext Two"), "EVM-only seller not rendered");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-stellar-page.js`
Expected: FAIL — import error (`src/stellar-page.js` does not exist).

- [ ] **Step 3: Implement the renderer**

Create `src/stellar-page.js`:

```js
// /stellar — the Stellar x402 marketplace page. Pure renderer over the
// existing index snapshot + stellarRail() receipts; no state of its own.
// Honesty rules (spec): never invent receipts, say plainly when Agent402 is
// the only listed seller. Listing for external sellers is automatic — the
// index crawler picks up any origin whose 402s advertise a stellar network.
import { ledgerShell, ledgerFooterCompact } from "./ledger-chrome.js";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const usd = (n) => `$${Number(n).toFixed(Number(n) < 0.01 ? 3 : 2).replace(/\.?0+$/, (m) => (m.includes(".") ? "" : m))}`;

const isStellarNet = (n) => typeof n === "string" && n.startsWith("stellar");

/** Sellers with a Stellar rail: the local catalog always qualifies (every
 *  local tool's 402 offers stellar:pubnet); remote sellers qualify when their
 *  crawled 402s advertise a stellar network. */
export function stellarSellers(snapshot) {
  return (snapshot?.sellers || []).filter((s) => s.local === true || (s.networks || []).some(isStellarNet));
}

/** Tools purchasable over Stellar. Remote snapshot entries carry no per-tool
 *  list, so this is the local catalog; external sellers render seller-level. */
export function stellarTools(snapshot) {
  const local = (snapshot?.sellers || []).find((s) => s.local === true);
  return local?.tools || [];
}

function categoryGroups(tools, { maxCategories = 12, maxPerCategory = 6 } = {}) {
  const byCat = new Map();
  for (const t of tools) {
    if (!byCat.has(t.category)) byCat.set(t.category, []);
    byCat.get(t.category).push(t);
  }
  return [...byCat.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, maxCategories)
    .map(([category, list]) => ({ category, shown: list.slice(0, maxPerCategory), more: Math.max(0, list.length - maxPerCategory) }));
}

export function stellarPage(baseUrl, { snapshot, rail }) {
  const sellers = stellarSellers(snapshot);
  const tools = stellarTools(snapshot);
  const prices = tools.map((t) => Number(t.price)).filter((n) => Number.isFinite(n) && n > 0);
  const low = prices.length ? Math.min(...prices) : 0.001;
  const high = prices.length ? Math.max(...prices) : 0.5;
  const groups = categoryGroups(tools);
  const latest = rail?.recent?.[0] || null;

  const receiptHtml = latest
    ? `<p style="margin:8px 0 0;">Latest settlement: <strong>${usd(latest.usd)} USDC</strong> · <a href="${esc(latest.tx)}" rel="noopener">on-chain receipt</a>${latest.when ? ` · ${esc(latest.when)}` : ""}</p>`
    : `<p style="margin:8px 0 0;color:var(--muted);">live receipts temporarily unavailable — settlements remain verifiable at <a href="https://stellar.expert/explorer/public/account/GDNJXCKW7ZM7GEEVP674TWPU26YJNBQ2FI4ZIPRKTPTNUEJMDHFJWWRL" rel="noopener">stellar.expert</a></p>`;

  const groupsHtml = groups.map((g) => `
    <div style="border:1px solid var(--hairline);padding:14px 16px;">
      <h3 style="margin:0 0 8px;font-size:14px;">${esc(g.category)}</h3>
      ${g.shown.map((t) => `<div style="display:flex;justify-content:space-between;gap:12px;font-size:13.5px;padding:3px 0;"><a href="/tools/${esc(t.slug)}" style="color:var(--ink);text-decoration:none;">${esc(t.name)}</a><span style="color:var(--muted);font-family:var(--font-mono);">${usd(t.price)}</span></div>`).join("")}
      ${g.more ? `<div style="font-size:12px;color:var(--faint);margin-top:6px;">+ ${g.more} more in <a href="/tools" style="color:var(--muted);">the full catalog</a></div>` : ""}
    </div>`).join("");

  const sellersHtml = sellers.map((s) => `
    <div style="display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid var(--hairline);font-size:14px;">
      <span><a href="${esc(s.homepage)}" rel="noopener" style="color:var(--ink);">${esc(s.displayName)}</a>${s.local ? ' <span style="color:var(--faint);font-size:12px;">(this host)</span>' : ""}</span>
      <span style="color:var(--muted);font-family:var(--font-mono);">${s.toolCount || 0} tools</span>
    </div>`).join("");

  const honesty = sellers.length === 1
    ? `<p style="color:var(--muted);font-size:13.5px;">1 seller live — discovery is open, and external sellers are added automatically when their x402 challenges advertise a Stellar network.</p>`
    : "";

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "The Stellar x402 marketplace",
    url: `${baseUrl}/stellar`,
    description: `Pay-per-call tools for AI agents, settled in USDC on Stellar via the x402 protocol. ${tools.length} tools live.`,
    mainEntity: {
      "@type": "OfferCatalog",
      name: "Stellar-payable agent tools",
      numberOfItems: tools.length,
      itemListElement: { "@type": "AggregateOffer", priceCurrency: "USD", lowPrice: String(low), highPrice: String(high), offerCount: tools.length },
    },
  };

  const body = `
<div style="max-width:960px;margin:0 auto;padding:32px 20px;">
  <h1 style="font-size:28px;margin:0 0 6px;">The Stellar x402 marketplace</h1>
  <p style="font-size:16px;color:var(--muted);margin:0;">Pay-per-call tools for AI agents — settled in USDC on Stellar in ~5 seconds, no signup, no API keys. The wallet is the account.</p>
  ${receiptHtml}
  <p style="font-size:13px;color:var(--faint);margin:4px 0 0;">A paid canary buys tools over the Stellar rail daily (facilitator: OpenZeppelin) — uptime proven with real settlements, not pings.</p>

  <h2 style="font-size:20px;margin:32px 0 12px;">Browse Stellar-payable tools</h2>
  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px;">${groupsHtml}</div>
  <p style="font-family:var(--font-mono);font-size:13px;background:#e3dac3;padding:10px 14px;margin:16px 0 0;">agents: GET ${esc(baseUrl)}/api/route?q=&lt;task&gt;&amp;network=stellar</p>

  <h2 style="font-size:20px;margin:32px 0 12px;">Sellers settling on Stellar</h2>
  ${sellersHtml}
  ${honesty}

  <h2 style="font-size:20px;margin:32px 0 12px;">Sell on Stellar</h2>
  <p style="font-size:14.5px;line-height:1.65;">Accept x402 payments with a <code>stellar:pubnet</code> accept in your 402 challenge — the <a href="https://developers.stellar.org/docs/build/agentic-payments/x402/built-on-stellar" rel="noopener">Built on Stellar facilitator</a> (OpenZeppelin) verifies and settles, gas sponsored. Use <a href="https://www.npmjs.com/package/@x402/stellar" rel="noopener"><code>@x402/stellar</code></a> for the wire, or <a href="/tollbooth"><code>agent402-tollbooth</code></a> to paywall an existing site. Then serve <code>/.well-known/x402</code> — the index crawler lists you automatically; ranking is health-based, listing is free. Want a guaranteed crawl? <a href="https://github.com/MikeyPetrillo/Agent402/issues" rel="noopener">Open a seed request</a>.</p>

  <p style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin-top:28px;">machine-readable: <a href="/api/route">/api/route</a> · <a href="/.well-known/x402">/.well-known/x402</a> · <a href="/openapi.json">/openapi.json</a> · <a href="/api/reliability">/api/reliability</a></p>
</div>
${ledgerFooterCompact()}`;

  return ledgerShell({
    title: "The Stellar x402 marketplace — pay-per-call tools for AI agents",
    description: `The Stellar x402 marketplace: ${tools.length} pay-per-call tools for AI agents, settled in USDC on Stellar. No signup, no API keys — the wallet is the account.`,
    canonical: `${baseUrl}/stellar`,
    baseUrl,
    activePath: "/stellar",
    jsonLd,
    body,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/test-stellar-page.js`
Expected: PASS — `15 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/stellar-page.js scripts/test-stellar-page.js
git commit -m "Stellar marketplace page: renderer + filter helpers with offline tests"
```

---

### Task 2: Server route, sitemap, nav, CI wiring

**Files:**
- Modify: `src/server.js` (import + route near the `/index` route, ~line 1287)
- Modify: `src/seo.js` (static sitemap list, after the `/economy` entry ~line 38)
- Modify: `src/ledger-chrome.js` (footer nav column, ~line 176)
- Modify: `.github/workflows/deploy.yml` (offline test step after the B20 decode step)

**Interfaces:**
- Consumes: Task 1's `stellarPage(baseUrl, { snapshot, rail })`; existing `getIndexSnapshot()`, `htmlCache`, `BASE_URL` in server.js; existing `stellarRail(wallet)` export from `./revenue-live.js`.
- Produces: `GET /stellar` live on the server.

- [ ] **Step 1: Add the route**

In `src/server.js`, add to the imports section (near the revenue-live import if present, else with the other page imports):

```js
import { stellarPage } from "./stellar-page.js";
import { stellarRail } from "./revenue-live.js";
```

(If `stellarRail` is already imported for another route, reuse that import — do not duplicate.)

Directly after the `app.get("/index", …)` route (~line 1287), add:

```js
// The Stellar x402 marketplace — the index snapshot filtered to the Stellar
// rail, plus live settlement receipts. stellarRail is best-effort (6s Horizon
// timeouts internally); a flake renders the honest "unavailable" line.
app.get("/stellar", async (_req, res) => {
  let rail = null;
  try {
    const r = await stellarRail((process.env.STELLAR_WALLET_ADDRESS || "").trim());
    if (r && !r.error) rail = r;
  } catch { /* best-effort */ }
  htmlCache(res, 120, 600).send(stellarPage(BASE_URL, { snapshot: getIndexSnapshot(), rail }));
});
```

- [ ] **Step 2: Sitemap + nav**

`src/seo.js` — in `staticUrls`, after the `/economy` line:

```js
    { loc: `${baseUrl}/stellar`, priority: "0.8" },
```

`src/ledger-chrome.js` — in the footer link column that contains Index/Leaderboard/Economy/Revenue/Playground (~line 176), add after the Economy anchor:

```js
<a href="/stellar" style="color:var(--muted);text-decoration:none;">Stellar</a>
```

(Keep the single-line string format of that column — insert inline, matching the existing anchors exactly.)

- [ ] **Step 3: CI wiring**

`.github/workflows/deploy.yml` — after the "B20 decode unit tests" step:

```yaml
      - name: Stellar marketplace page tests (offline, fixture snapshot)
        run: node scripts/test-stellar-page.js
```

- [ ] **Step 4: Verify against a live boot**

```bash
FREE_MODE=true PORT=3117 node src/server.js > /tmp/stellar-boot.log 2>&1 &
sleep 10
curl -s http://localhost:3117/stellar | grep -c "Stellar x402 marketplace"
curl -s http://localhost:3117/sitemap.xml | grep -c "/stellar<"
PID=$(netstat -ano | grep ":3117" | grep LISTEN | awk '{print $NF}' | head -1); [ -n "$PID" ] && taskkill //F //PID $PID
```

Expected: first grep ≥ 3 (title/h1/description), second grep = 1. (The live rail fetch hits Horizon — if it flakes, the page still renders with the unavailable line; both are passes.)

- [ ] **Step 5: Commit**

```bash
git add src/server.js src/seo.js src/ledger-chrome.js .github/workflows/deploy.yml
git commit -m "Stellar marketplace page: /stellar route, sitemap, nav, CI test"
```

---

### Task 3: Ship

**Files:**
- Modify: `.github/trigger-test`, `.github/trigger-deploy` (timestamp bumps — CI's two-key gate)

- [ ] **Step 1: Marker commit + push**

```bash
date -u +"%Y-%m-%dT%H:%M:%SZ" >> .github/trigger-test
date -u +"%Y-%m-%dT%H:%M:%SZ" >> .github/trigger-deploy
git add .github/trigger-test .github/trigger-deploy
git commit -m "Stellar x402 marketplace page at /stellar [test][deploy]"
git push origin claude/sweet-brown-i99jl3
```

- [ ] **Step 2: Draft PR, merge on green**

```bash
gh pr create --draft --title "The Stellar x402 marketplace — /stellar" --body "GET /stellar per docs/superpowers/specs/2026-07-10-stellar-marketplace-page-design.md: live page over the existing index snapshot (network-filtered) + real stellarRail() settlement receipts. Honesty rules enforced in the renderer and pinned by tests (15 offline assertions): no invented receipts, plain '1 seller live' line until external Stellar sellers appear in discovery. Free surface — no catalog/count changes. Sitemap + nav wired; IndexNow re-submits automatically on deploy."
```

Watch the run (`gh run watch <id> --exit-status`), mark ready + merge on green.

- [ ] **Step 3: Post-deploy verification**

```bash
node -e "fetch('https://agent402.tools/stellar').then(r=>r.text()).then(t=>console.log('title phrase:', (t.match(/Stellar x402 marketplace/g)||[]).length, '| receipt or honest line:', /stellar\.expert|temporarily unavailable/.test(t)))"
node -e "fetch('https://agent402.tools/sitemap.xml').then(r=>r.text()).then(t=>console.log('sitemap has /stellar:', t.includes('agent402.tools/stellar<')))"
```

Expected: phrase count ≥ 3, receipt-or-honest true, sitemap true. The deploy's IndexNow step submits the updated sitemap (including /stellar) automatically — check the run log's final step for the HTTP 200.
