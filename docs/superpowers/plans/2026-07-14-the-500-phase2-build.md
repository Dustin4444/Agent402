# The 500 — Phase 2 (Build) + Phase 3 (Invariant) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** Implement the owner-approved 30 tools + 8 skill packs (shortlist: `docs/superpowers/specs/2026-07-14-the-500-additions-shortlist.md` — THE requirements source: slugs, prices, upstreams, categories per its tables), taking the catalog 462 → exactly 500 (400 tools + 100 packs), then land the CI cap.

**Architecture:** Tools grouped into 6 kit tasks (each self-contained in one kit file + its test), then packs, then the invariant + count sweep. Sequential tasks (shared surfaces: pow.js WALLET_ONLY_SLUGS, test-all NETWORK set, find.js).

## Global Constraints

- **DEPLOY POLICY: `[test]`-only pushes. NO `[deploy]` until the v2.0.0 launch.**
- Every tool: shape per CLAUDE.md conventions; deterministic; discovery example answers against the REAL upstream (verified by a live FREE_MODE curl in the task, and by `test-all.js`); price EXACTLY as the shortlist says; egress → `WALLET_ONLY_SLUGS` (src/pow.js) + test-all NETWORK-lenient set where flaky-upstream appropriate; keyless upstreams only (the three owner-flagged exceptions resolve as: github-repo ships KEYLESS with the documented 60/hr shared limit + optional GITHUB_TOKEN env-gated enhancement; search-videos verifies the Brave video endpoint against the existing BRAVE_API_KEY before implementation and is SWAPPED for an alternate from the shortlist's not-selected list if unsupported; options-chain adds the Yahoo options path to the relay whitelist in the same task).
- Every pack: composes only tools existing at its build time; runs end-to-end in the pack CI pattern; priced per shortlist.
- Each task ends with: its kit test green + the new examples answering live + `node scripts/test-market-pages.js` unaffected + commit (NO CI markers).
- Never rename/reprice an existing tool in these tasks.

### Task 1: Contract/EVM kit — contract-source, contract-abi, solidity-scan, calldata-decode, selector-lookup, tx-simulate, address-label (7)
Files: Create `src/tools/contract-kit.js`; Modify `src/server.js` (mount), `src/pow.js` (egress slugs), `scripts/test-all.js` (NETWORK set); Test: Create `scripts/test-contract-kit.js`.
Read the shortlist rows for upstreams (Sourcify/Blockscout, openchain/4byte, RPC-based simulate via existing publicJsonRpc in chain-kit). calldata-decode + selector caching pure-CPU where possible (calldata-decode WITH a provided ABI = pure CPU → PoW-eligible; without = uses selector lookup = egress). solidity-scan = deterministic heuristic rules (no LLM). TDD per tool; live curls for each example.

### Task 2: Market micro-feeds — options-chain, premarket-quote, stock-dividends, dividend-calendar, crypto-orderbook, stablecoin-peg (6)
Files: Modify `src/tools/finance-kit.js` (or crypto-kit for the crypto pair — follow each kit's domain), relay whitelist (`workers/yfinance-relay/` if options path needed — flag if the deployed Worker needs a manual update: code change here, deploy note in report), pow.js, test-all.js; Tests: extend `scripts/test-*` matching kits.
Yahoo endpoints via the existing jsonGet + relay fallback pattern; crypto-orderbook + stablecoin-peg via keyless CoinGecko/exchange public endpoints per shortlist. Prices per shortlist.

### Task 3: Entity/enrichment — lei-lookup, wikidata-entity, gravatar-check, github-repo, favicon-grab (5)
Files: Create `src/tools/enrich-kit.js` (+ mount, pow.js, test-all); Test: `scripts/test-enrich-kit.js`.
GLEIF, Wikidata, Gravatar (hash check — pure CPU + optional HEAD), GitHub REST (keyless + optional GITHUB_TOKEN env-gated), favicon via safeFetch. SSRF guard (fetch-guard) on any user-URL input.

### Task 4: Web/content — archive-snapshot, search-videos, feed-parse, unshorten-url (4)
Files: Modify `src/tools/search.js` (search-videos beside Web/News/Images) + Create or extend an appropriate kit for the rest; pow.js; test-all; Tests: extend/create matching.
FIRST verify Brave video endpoint with BRAVE_API_KEY via railway run; if unsupported, swap per the plan's constraint and say so. archive-snapshot = web.archive.org availability API (keyless). unshorten-url = bounded redirect-follow via safeFetch (SSRF-guarded, max 5 hops). feed-parse = RSS/Atom via safeFetch + pure parse.

### Task 5: Media/format — image-exif, image-dominant-color, image-crop, json-schema-infer, srt-convert (5)
Files: Modify `src/tools/image-kit.js` (sharp available? verify how existing image tools process — reuse), a util kit for the two pure-CPU; pow.js only for egress ones (image tools fetch URLs → egress); Tests: extend matching.
json-schema-infer + srt-convert are pure CPU (PoW-eligible — do NOT add to WALLET_ONLY).

### Task 6: Locale/time — ics-parse, public-holidays, country-info (3)
Files: extend an appropriate kit (data-kit); Nager.Date + restcountries keyless; ics-parse pure CPU. Same conventions.

### Task 7: The 8 skill packs
Files: `src/skills.js` + `src/tools/skill-runner.js` (follow the existing 92's structure exactly); Test: the pack CI pattern (`scripts/test-mcp-prompts.js` expectations 92→100 + whatever validates pack steps).
Packs per the shortlist table (composing tools + price). Every pack must run end-to-end against a FREE_MODE boot (steps that need wallet-only tools: follow how existing packs handle that — verify pattern first).

### Task 8: Finale — exactly 500 + THE CAP (Phase 3)
1. Full battery: boot + `TARGET_URL node scripts/test-all.js` (every example answers), all kit tests, mcp-all (expect 500), find/market/static/index/sell suites.
2. `node scripts/sync-count.js` at 500; then implement the invariant in `sync-count.js --check`: assert tools===400 AND packs===100 exactly; failure message: "The catalog is capped at 500 (400 tools + 100 skill packs). For a new tool to enter, one must leave." Add the policy line to CLAUDE.md conventions + README + wiki Home.
3. Verify `--check` green at 500/400/100; commit; controller pushes `[test]`.
4. STOP: Phases 4-5 (brand sweep + launch) get their own plan after the owner sees 500 green.
