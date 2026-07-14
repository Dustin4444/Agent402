# The 500 — Phase 4 (Brand Sweep) + Phase 5 (Launch v2.0.0) Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** Flip the entire external footprint from "1,432 tools" to "**500 tools · 100 skill packs**, CI-capped" — website, SEO, GitHub, every registry, and all images — then ship the single atomic **v2.0.0** launch deploy with on-chain proof of every new tool. Spec: `docs/superpowers/specs/2026-07-13-the-500-overhaul-design.md` (Phases 4-5), whose Phase 4 sub-inventory (4a-4e) is the requirements source.

**Architecture:** Text counts are already swept (sync-count, done in Phase 2 T8) and runtime surfaces (`/api/pricing`, `/openapi.json`, the og card `cardSvg` which reads `Object.keys(CATALOG).length`, `/.well-known/glama.json`, docs.js) DERIVE the count — so **the deploy itself updates them**. Phase 4's real work is: (a) the count-adjacent COPY that sync-count doesn't touch (hero framing, pack counts, positioning), (b) rendered image assets, (c) GitHub repo settings, (d) registry re-publish/re-register via CI markers. Phase 5 is the deploy + proof + announcement.

## Global Constraints

- **This is the FIRST phase that deploys.** The v2.0.0 launch is one atomic `[deploy]` — nothing before it touched prod. Before that deploy, prod still serves 1,432; all Phase-4 doc/image/copy work lands on the branch under `[test]` only.
- **The launch narrative** (owner-approved framing): "Only 500. 400 tools + 100 skill packs. Every one tested, priced, and settled on-chain. Nothing else made the cut. Paid in USDC on 8 chains — or free via proof-of-work compute on the pure-CPU ones." Final hero/tweet copy = owner-approved before it ships.
- Images regenerate from the REAL numbers via the committed-font Playwright renderers (`.remember/tmp/*.mjs`) — never mocked. Run renderers from repo root.
- Nothing claims "500" on a live surface until the deploy that makes it true — the sweep/publish/register steps run AFTER or WITH the deploy, never before.
- Announcements (tweet + card) queue for owner approval — nothing posts automatically (CLAUDE.local.md flow).

---

### Task 1: Website copy — the count-adjacent framing sync-count can't touch
**Files:** `src/ledger-home.js` (hero, the "A whole job, one payment" / count blocks, FAQ answers citing counts), `src/market-page.js` (marketplace header/subtitle if it cites totals), `src/ledger-chrome.js` (meta description default), `src/seo.js` (llmsTxt intro if it frames the count), `src/pages.js` (catalog intro). Test: `scripts/test-market-pages.js`, `test-static-pages.js`, `test-index-page.js`, `test-llms-txt.js`.
- [ ] Grep every hardcoded count-narrative string that isn't the bare "N tools" number sync-count owns: `grep -rn "tools\|skill pack\|converter\|deterministic" src/ledger-home.js src/market-page.js src/pages.js | grep -iE "500|400|100|whole|every"`. Update the FRAMING to the curation story ("Only 500. Every one earns its place." + "400 tools + 100 skill packs"). Keep the neutral-index line.
- [ ] The homepage `packCount`/`count` variables already derive from SKILL_PACKS/CATALOG — VERIFY they render 100/400 at runtime (boot smoke), don't hardcode.
- [ ] FAQ + meta descriptions: any "1,431/1,432" narrative → the new framing. Verify the deploy SEO gate strings (FAQPage / GET /faq / AggregateOffer) survive.
- [ ] Boot smoke: homepage renders "500"/"400"/"100" correctly; all suites green. Commit `brand(1): website curation-story copy`.

### Task 2: SEO surfaces + sitemap + IndexNow
**Files:** verify `sitemapPages` (converter pages already dropped in prune), canonical/JSON-LD in market-page + ledger-chrome, `src/seo.js` llms.txt, `scripts/indexnow-submit.js`. Test: `test-sitemap-coverage.js`, `test-discovery.js`, `test-x402-manifest.js`.
- [ ] Confirm JSON-LD `numberOfItems`/`offerCount` derive from the live catalog (they read tools.length — verify, don't hardcode).
- [ ] llms.txt: intro/section counts derive or get the new framing.
- [ ] Note (DEPLOY-TIME): `scripts/indexnow-submit.js` ping fires AFTER the deploy (Phase 5) so Bing/Copilot/DDG re-crawl the live 500 — add it to the Phase-5 checklist, do not run now.
- [ ] Suites green. Commit `brand(2): SEO/JSON-LD/llms.txt reflect 500` (if any non-derived change; else skip with a note).

### Task 3: Rendered images (all from real numbers)
**Files:** new/updated `.remember/tmp/*.mjs` renderers; output PNGs to a known path. NOT committed to the repo unless a renderer's output is a served asset — most are for X/social/GitHub upload (manual).
- [ ] **X header**: redo the dark 8-chain header at "500 · 100" (base the renderer on the existing header renderer — grep `.remember/tmp/header*.mjs`). Output to Downloads or scratch; the owner uploads to X manually.
- [ ] **GitHub social preview** (1280×640): the site's own `cardSvg(1280,640)` already derives the count → after deploy it's live at `/og?w=1280&h=640` (verify the route); render/screenshot it OR rasterize the SVG. Owner uploads to repo Settings → Social preview (or note it's auto-served if GitHub reads og:image).
- [ ] **Launch announcement card**: "The 500" card (before/after 1,432→500, or the invariant story) via the eightchain-card renderer style — REAL numbers. For the owner-approved tweet.
- [ ] Verify each renders uncropped/legible (Read the PNG). Report the output paths. NO commit unless a served asset changed (the og card is code-derived — no image file to commit).

### Task 4: GitHub repo metadata
**Files:** `README.md` (hero/badges — counts already swept, verify framing), repo description + topics (via `gh repo edit`), GitHub release notes draft.
- [ ] `gh repo edit MikeyPetrillo/Agent402 --description "500 pay-per-call tools + 100 skill packs for AI agents, paid in USDC over x402 (or free via proof-of-work). CI-capped, self-hostable, MCP-native."` — and topics if any cite counts. (This is a live GitHub change — do it in Phase 5 WITH the launch, not before, so the description matches prod. Stage the exact command in the report.)
- [ ] README hero + the curation-story blockquote (the cap policy line is already there from T8 — verify). Any screenshot showing an old count → note for regen.
- [ ] Draft `docs/` release notes for **v2.0.0**: the prune→build→cap story, the 30 tools + 8 packs, the on-chain-proof claim. Commit the draft: `brand(4): v2.0.0 release notes draft + repo-metadata commands staged`.

### Task 5: Registry re-publish plan (staged, fires in Phase 5)
**Files:** `docs/ecosystem-listings.md` (copy-paste text for manual directory forms → update to 500/100), verify npm/PyPI package descriptions (swept by sync-count — confirm), `mcp/server.json` (MCP registry metadata — count derives or swept).
- [ ] Update `docs/ecosystem-listings.md` + any pending-submission copy (Cline #1849) to the new numbers/framing.
- [ ] Verify npm package.json descriptions + keywords (agent402-mcp, agent402-client, tollbooth, 8 adapters) reflect 500 (sync-count should have — confirm, fix any it missed).
- [ ] STAGE (do not fire) the Phase-5 CI markers: `[publish]` (npm + MCP registry — versions already bumped: mcp 0.11.5, client 0.6.1), `[bazaar-refresh]` (CDP Bazaar metadata re-observe). Document each in the report as a Phase-5 dispatch.
- [ ] Commit `brand(5): registry listing copy + staged publish/register markers`.

### Task 6 (Phase 5): THE LAUNCH — atomic v2.0.0 deploy + proof
This is the one that flips prod. Owner confirms GO before this task's deploy push.
- [ ] Final pre-flight: full local battery green (`test-all` 400-tool sweep, mcp-all 500, cap check, all suites); branch merged up to date with main; `sync-count --check` exit 0 at 400+100.
- [ ] Push the launch commit with `[test][deploy]`. Watch CI test → deploy. The deploy-quiet-gate protects live buyers (waits for no external traffic before the Railway upsert).
- [ ] Post-deploy prod verification (the checklist): `/api/pricing` endpoints=500; `/health` toolCount; og card at `/og` shows 500; `/.well-known/x402` + glama.json + llms.txt + sitemap all reflect 500; `/index`+`/marketplaces` still 301; the 8-chain marketplace renders; a spot-check of 5 new tools answering live on prod (contract-source, options-chain, country-info, feed-parse, evm-rpc); PageSpeed mobile bar holds (Perf 99 / A11y 100 / BP 100 / SEO 100).
- [ ] **On-chain proof sweep**: dispatch `bazaar-sweep` (the batched Base settlement) over the NEW tools so each has a real on-chain receipt before we advertise it; verify a sample settles.
- [ ] Fire the staged registry markers: `[publish]`, `[marketplace]`, `[bazaar-refresh]`; run `indexnow-submit.js`; `gh repo edit` the description; **wrangler deploy the yfinance-relay** (the deferred options-chain path) + add the options-chain canary leg.
- [ ] GitHub release v2.0.0 (tag + notes).
- [ ] Draft the launch tweet + attach the card → QUEUE for owner approval (do not post). Include the demo card per the standing flow.
- [ ] Update CLAUDE.md follow-ups + memory: The 500 shipped, cap live, Phase-4/5 done.

## Risks / mitigations
- **Partial brand state** (some surfaces say 500, some 1,432 mid-rollout): mitigated by running all count-flipping AFTER/WITH the single deploy; runtime surfaces flip atomically on deploy, docs were pre-swept, images + registries fire in the Phase-5 checklist immediately post-deploy.
- **A new tool 502s on prod** (upstream differs from local): the post-deploy 5-tool spot-check + the canary catch it; roll-forward fix, don't roll back the whole catalog.
- **yfinance-relay options path** still undeployed → options-chain 504s (charged) on prod until the wrangler deploy in the Phase-5 checklist — that step is explicit and gated.
- **Announcement accuracy**: the card shows real on-chain receipts from the proof sweep, not the local build — render it AFTER the sweep.
