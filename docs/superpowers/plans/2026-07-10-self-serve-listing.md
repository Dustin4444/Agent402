# Self-Serve Listing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `POST /api/index/register` (validated, rate-limited, SSRF-safe self-serve origin submission with persistent seeds) plus a "List your API" form on /stellar.

**Architecture:** A `registerOrigin()` helper inside `src/x402-index.js` reuses the existing `crawlSeller()` (all fetching stays behind the crawler's `safeFetch` SSRF guard) and persists accepted origins to `/data/submitted-seeds.json`, loaded on boot into the crawler's seed set. The server route does validation + rate limiting only — zero direct fetches. The /stellar form posts to it with a small inline script. Spec: `docs/superpowers/specs/2026-07-10-self-serve-listing-design.md`.

**Tech Stack:** Node ESM, no new dependencies.

## Global Constraints

- The route performs NO direct fetches; all probing goes through `crawlSeller()` → `safeFetch`.
- Validation rejects: non-https, any path beyond `/`, query, hash, userinfo, any port other than default 443, hostnames without a dot, and our own origin. Normalize to `https://` + lowercased host.
- Rate limits: 5 submissions/IP/hour AND 30 new-origin probes/hour globally → HTTP 429.
- Persistence: `/data/submitted-seeds.json`; silent in-memory fallback when `/data` is absent.
- Response contract: 200 `{ listed, origin, seller?, error? }` for handled outcomes; 400 invalid; 429 limited.
- Free surface: no catalog/count/pow changes. Commits plain until the ship commit; no AI attribution.
- **Do not push until instructed** — an unrelated PR is open on the branch; the ship task handles sequencing.

---

### Task 1: registerOrigin + seed persistence in the index (offline-tested)

**Files:**
- Modify: `src/x402-index.js`
- Create: `scripts/test-index-register.js`

**Interfaces:**
- Consumes (existing, module-internal): `crawlSeller(originUrl)` (~line 265), `discoveredSeeds` Set (~line 46), `cache` Map, `healthScore(v)`, `isRoutable(v)`.
- Produces (Task 2 relies on): `export function validateOriginInput(raw) -> { origin } | { error }`, `export async function registerOrigin(origin, { crawl } = {}) -> { listed, origin, seller?, error? }`, `export function loadSubmittedSeeds()` (called from `startCrawler`), constant `SUBMITTED_SEEDS_FILE`.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-index-register.js`:

```js
// Offline unit tests for self-serve listing: origin validation + the
// registerOrigin flow with an injected fake crawler. No network, no /data.
import { validateOriginInput, registerOrigin, __testResetSubmitted } from "../src/x402-index.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

// --- validation ---
ok(validateOriginInput("https://example.com").origin === "https://example.com", "plain https origin accepted");
ok(validateOriginInput("https://Example.COM/").origin === "https://example.com", "trailing slash + case normalized");
ok(validateOriginInput("http://example.com").error != null, "http rejected");
ok(validateOriginInput("https://example.com/api").error != null, "path rejected");
ok(validateOriginInput("https://example.com?x=1").error != null, "query rejected");
ok(validateOriginInput("https://user:pw@example.com").error != null, "userinfo rejected");
ok(validateOriginInput("https://example.com:8443").error != null, "non-443 port rejected");
ok(validateOriginInput("https://localhost").error != null, "dotless host rejected");
ok(validateOriginInput("not a url").error != null, "garbage rejected");
ok(validateOriginInput("https://agent402.tools", { selfOrigin: "https://agent402.tools" }).error != null, "own origin rejected");

// --- registerOrigin with injected crawler ---
__testResetSubmitted();
let crawled = [];
const goodCrawl = async (o) => { crawled.push(o); return { manifest: { name: "Ext" }, tools: [{ slug: "a" }], error: null, history: [true] }; };
const badCrawl = async (o) => { crawled.push(o); return { error: "no manifest, no openapi, no bazaar entries", history: [false] }; };

let r = await registerOrigin("https://newseller.example", { crawl: goodCrawl });
ok(r.listed === true && r.origin === "https://newseller.example", "successful probe lists the origin");
ok(r.seller && typeof r.seller.toolCount === "number", "response carries a seller summary");
ok(crawled.length === 1, "crawler invoked once for unknown origin");

r = await registerOrigin("https://deadseller.example", { crawl: badCrawl });
ok(r.listed === false && typeof r.error === "string", "failed probe returns honest error, not listed");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run to verify failure**

Run: `node scripts/test-index-register.js`
Expected: FAIL — named exports missing.

- [ ] **Step 3: Implement in `src/x402-index.js`**

Add near the seed declarations (after `const discoveredSeeds = new Set();`):

```js
// --- self-serve listing (POST /api/index/register) ---------------------------
// Origins submitted through the public register endpoint. Persisted to /data
// so a submission survives redeploys; silent in-memory fallback without the
// volume (same posture as stats). All probing goes through crawlSeller() —
// this module never fetches a submitted origin directly.
export const SUBMITTED_SEEDS_FILE = "/data/submitted-seeds.json";
const submittedSeeds = new Set();

export function loadSubmittedSeeds() {
  try {
    const arr = JSON.parse(readFileSync(SUBMITTED_SEEDS_FILE, "utf8"));
    for (const o of Array.isArray(arr) ? arr : []) {
      if (typeof o === "string") { submittedSeeds.add(o); discoveredSeeds.add(o); }
    }
  } catch { /* absent file / no volume — in-memory only */ }
}

function persistSubmittedSeeds() {
  try {
    writeFileSync(SUBMITTED_SEEDS_FILE, JSON.stringify([...submittedSeeds], null, 2));
  } catch { /* best-effort — no volume in local/dev */ }
}

/** Test hook: clear submitted-seed state between test cases. */
export function __testResetSubmitted() { submittedSeeds.clear(); }

/** Validate a raw submitted origin. Returns { origin } (normalized) or { error }. */
export function validateOriginInput(raw, { selfOrigin } = {}) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch { return { error: "origin must be a valid URL" }; }
  if (u.protocol !== "https:") return { error: "origin must be https" };
  if (u.username || u.password) return { error: "origin must not contain credentials" };
  if (u.port && u.port !== "443") return { error: "origin must use the default https port" };
  if ((u.pathname && u.pathname !== "/") || u.search || u.hash) return { error: "submit the bare origin (no path or query)" };
  if (!u.hostname.includes(".")) return { error: "origin must be a public hostname" };
  const origin = `https://${u.hostname.toLowerCase()}`;
  if (selfOrigin && origin === String(selfOrigin).toLowerCase()) return { error: "this host is already the local catalog" };
  return { origin };
}

/**
 * Probe + list a submitted origin. `crawl` is injectable for tests; defaults
 * to the real crawlSeller. Known origins return their current state without
 * a fetch. Successful probes persist the origin as a seed.
 */
export async function registerOrigin(origin, { crawl } = {}) {
  const existing = cache.get(origin);
  if (existing && !existing.error) {
    return { listed: true, origin, seller: sellerSummary(origin, existing) };
  }
  const doCrawl = crawl || (async (o) => { await crawlSeller(o); return cache.get(o); });
  let v;
  try { v = await doCrawl(origin); } catch (e) { v = { error: String(e?.message || e) }; }
  // Injected test crawlers return the entry directly; the real path re-reads cache.
  if (v && !v.error && (v.tools?.length || v.manifest)) {
    submittedSeeds.add(origin);
    discoveredSeeds.add(origin);
    persistSubmittedSeeds();
    if (!cache.has(origin) && crawl) cache.set(origin, { ...v, fetchedAt: Date.now() });
    return { listed: true, origin, seller: sellerSummary(origin, cache.get(origin) || v) };
  }
  return { listed: false, origin, error: String(v?.error || "no x402 surface found (manifest, OpenAPI, or Bazaar entry)") };
}

function sellerSummary(origin, v) {
  return {
    displayName: v.manifest?.name || origin.replace(/^https?:\/\//, ""),
    toolCount: v.tools?.length || 0,
    networks: [...new Set([...(v.tools || []).flatMap((t) => t.networks || []), ...(bazaarToolsByOrigin.get(origin) || []).flatMap((t) => t.networks || [])])],
    routable: isRoutable(v),
    health: healthScore(v),
  };
}
```

Also: add `readFileSync, writeFileSync` to the existing `node:fs` import in x402-index.js (check the current import line and extend it — if the module has no fs import, add `import { readFileSync, writeFileSync } from "node:fs";` at the top). And in `startCrawler()`, call `loadSubmittedSeeds();` as the first line.

- [ ] **Step 4: Run tests to green**

Run: `node scripts/test-index-register.js`
Expected: PASS — `15 passed, 0 failed`. Also run `node scripts/test-stellar-page.js` (must stay 24/24 — same module tree) and `node --check src/x402-index.js`.

- [ ] **Step 5: Commit (NO push)**

```bash
git add src/x402-index.js scripts/test-index-register.js
git commit -m "Index: self-serve origin registration with persistent submitted seeds"
```

---

### Task 2: Route with rate limits + /stellar form + CI wiring

**Files:**
- Modify: `src/server.js` (route near the other /api/index routes)
- Modify: `src/stellar-page.js` (List your API card in the Sell on Stellar section)
- Modify: `scripts/test-stellar-page.js` (form-presence assertion)
- Modify: `.github/workflows/deploy.yml` (offline test step after the Stellar page tests step)

**Interfaces:**
- Consumes: Task 1's `validateOriginInput`, `registerOrigin`, `loadSubmittedSeeds` (already wired into startCrawler); existing `BASE_URL`, express `app`.
- Produces: `POST /api/index/register` live; a form with id `list-api` on /stellar.

- [ ] **Step 1: The route**

In `src/server.js`, extend the x402-index import with `validateOriginInput, registerOrigin`, then add near `app.get("/api/index", …)`:

```js
// Self-serve listing: validate + rate-limit here; ALL probing happens inside
// the crawler behind safeFetch (SSRF guard). 5/IP/hour, 30 new probes/hour
// globally — a public crawl trigger must not become a fetch amplifier.
const REG_WINDOW_MS = 3600_000;
const regByIp = new Map();
let regGlobal = [];
app.post("/api/index/register", express.json({ limit: "2kb" }), async (req, res) => {
  const now = Date.now();
  const ip = req.ip || "?";
  const mine = (regByIp.get(ip) || []).filter((t) => now - t < REG_WINDOW_MS);
  if (mine.length >= 5) return res.status(429).json({ error: "rate limit: 5 submissions per hour per IP" });
  const v = validateOriginInput(req.body?.origin, { selfOrigin: BASE_URL });
  if (v.error) return res.status(400).json({ error: v.error });
  regGlobal = regGlobal.filter((t) => now - t < REG_WINDOW_MS);
  if (regGlobal.length >= 30) return res.status(429).json({ error: "rate limit: registration is busy, try again later" });
  mine.push(now); regByIp.set(ip, mine); regGlobal.push(now);
  const result = await registerOrigin(v.origin);
  res.json(result);
});
```

(If the tool routes already apply a global `express.json()`, keep the per-route parser anyway — it enforces the 2kb cap for this endpoint.)

- [ ] **Step 2: The form on /stellar**

In `src/stellar-page.js`, inside the Sell on Stellar section (after the existing paragraph), add:

```js
  const formHtml = `
  <div id="list-api" style="border:1.5px solid var(--ink);background:var(--card);padding:18px 20px;margin-top:16px;max-width:640px;">
    <div style="font-weight:800;font-size:15px;margin-bottom:8px;">List your API</div>
    <div style="display:flex;gap:10px;">
      <input id="reg-origin" type="url" placeholder="https://api.yourdomain.com" style="flex:1;font-family:var(--font-mono);font-size:13px;padding:9px 12px;border:1.5px solid var(--ink);background:var(--paper);color:var(--ink);">
      <button id="reg-go" style="background:var(--ink);color:var(--cream);font-family:var(--font-mono);font-weight:700;font-size:13px;border:none;padding:9px 16px;cursor:pointer;">SUBMIT</button>
    </div>
    <div id="reg-out" style="font-family:var(--font-mono);font-size:12.5px;color:var(--muted);margin-top:8px;">Free, no account — we probe your origin's x402 surface and list you if it answers. Ranking is health-based.</div>
  </div>
  <script>
  document.getElementById("reg-go").addEventListener("click", async () => {
    const out = document.getElementById("reg-out");
    out.textContent = "probing…";
    try {
      const r = await fetch("/api/index/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ origin: document.getElementById("reg-origin").value }) });
      const j = await r.json();
      out.textContent = j.listed ? ("Listed — " + (j.seller?.displayName || j.origin) + " (" + (j.seller?.toolCount || 0) + " tools). Stellar sellers appear on this page; all sellers appear on /index.") : ("Not listed: " + (j.error || "unknown error"));
    } catch { out.textContent = "submission failed — try again"; }
  });
  </script>`;
```

and render `${formHtml}` directly after the Sell on Stellar paragraph in the body template.

- [ ] **Step 3: Tests + CI**

Append to `scripts/test-stellar-page.js` before the summary lines:

```js
// Self-serve form present
ok(html.includes('id="list-api"') && html.includes("/api/index/register"), "List your API form renders");
```

`.github/workflows/deploy.yml`: after the "Stellar marketplace page tests" step add:

```yaml
      - name: Index self-serve registration tests (offline)
        run: node scripts/test-index-register.js
```

- [ ] **Step 4: Verify against a live boot**

```bash
FREE_MODE=true PORT=3121 node src/server.js > /tmp/reg-boot.log 2>&1 &
sleep 10
curl -s -X POST http://localhost:3121/api/index/register -H "Content-Type: application/json" -d '{"origin":"http://nope.example"}'
curl -s -X POST http://localhost:3121/api/index/register -H "Content-Type: application/json" -d '{"origin":"https://example.com/path"}'
curl -s http://localhost:3121/stellar | grep -c 'id="list-api"'
PID=$(netstat -ano | grep ":3121" | grep LISTEN | awk '{print $NF}' | head -1); [ -n "$PID" ] && taskkill //F //PID $PID
```

Expected: first two return 400 JSON with the specific validation errors; grep = 1. (Do NOT submit a real external origin from the local boot — that fires a real crawl.)

- [ ] **Step 5: Commit (NO push)**

```bash
git add src/server.js src/stellar-page.js scripts/test-stellar-page.js .github/workflows/deploy.yml
git commit -m "Self-serve listing: /api/index/register route + List your API form"
```

---

### Task 3: Ship (sequenced behind the open marketplace PR)

- [ ] **Step 1:** Wait for the open marketplace-UI PR to be merged (the controller handles this — do not push while it is open).
- [ ] **Step 2:** Marker commit + push + draft PR:

```bash
date -u +"%Y-%m-%dT%H:%M:%SZ" >> .github/trigger-test
date -u +"%Y-%m-%dT%H:%M:%SZ" >> .github/trigger-deploy
git add .github/trigger-test .github/trigger-deploy
git commit -m "Self-serve listing on the x402 index [test][deploy]"
git push origin claude/sweet-brown-i99jl3
gh pr create --draft --title "Self-serve listing: POST /api/index/register" --body "Paste-your-origin listing per docs/superpowers/specs/2026-07-10-self-serve-listing-design.md: validated (https-only bare origins, no credentials/ports/paths), rate-limited (5/IP/hour + 30 global/hour), all probing behind the crawler's existing safeFetch SSRF guard, accepted origins persisted to /data/submitted-seeds.json across redeploys. List your API form on /stellar. 15 new offline assertions + form test; live-boot verified 400s on invalid input."
```

- [ ] **Step 3:** Merge on green; post-deploy verify: POST an invalid origin to prod (expect 400), confirm the form renders on https://agent402.tools/stellar.
