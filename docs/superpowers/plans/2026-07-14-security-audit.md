# Security & Pricing Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-verify the entire attack surface of the 500-entry catalog and cover everything added since the 2026-06-25 audit, fixing each confirmed finding with a permanent regression test in the same pass.

**Architecture:** Seven attack-domain tasks (D1–D7). Each runs a find→verify→fix loop: enumerate the surface, adversarially probe, verify a finding is real with a concrete repro, then fix and lock it with a regression test wired into `.github/workflows/deploy.yml`. Every task ALSO adds pre-specified *invariant* tests (below) that assert known-good behavior holds — these catch regressions even where the audit finds nothing. Findings are discovered, so a task's discovery loop is open-ended, but its invariant tests and surface are fully specified here.

**Tech Stack:** Node.js ESM, Express, undici, plain `node scripts/test-*.js` harnesses (assert-and-`process.exit(1)`), PoW (HMAC-SHA256), x402 v2 (EIP-3009), PostHog telemetry.

## Global Constraints

- **Fix-as-we-go:** each CONFIRMED finding is remediated immediately with a regression test; a plausible-but-unverified finding is NOT fixed (adversarial-reviewer gate).
- **Batch deploy:** all commits are `[test]`-only on branch `claude/sweet-brown-i99jl3`; NO `[deploy]` marker until Task 8. Exception: a CONFIRMED Critical (gate bypass, secret leak, SSRF-to-internal, cross-payer read) is hot-fixed and deployed immediately, flagged to the owner.
- **CI two-key gate:** a `[test]` commit only runs CI if it ALSO touches a `.github/trigger-*` path — bump `.github/trigger-ci` (or the relevant trigger file) in the same commit when CI must run.
- **Commit hygiene:** no session links, AI attribution, chat snippets, or personal info in commits (public repo). Never write a CI marker string in a commit *body* (literal-substring match).
- **Every new test wires into `deploy.yml`:** add a `run: node scripts/test-<name>.js` step in the unit-test job (pattern: lines ~719–797) so the invariant is guarded forever.
- **Errors-are-our-fault:** an upstream 4xx/5xx that a handler mishandles is OUR bug (schema/validation/retry), not partner flakiness.
- **Severity:** Critical / High / Medium / Low. Critical triggers the hot-fix exception.
- **Test harness pattern:** each `scripts/test-*.js` is a standalone ESM script that imports the kit/module directly, runs assertions, prints `ok - …` / `FAIL - …`, and `process.exit(fail ? 1 : 0)`. Follow the existing `scripts/test-security.js` shape.

---

### Task 1 (D1): SSRF / egress integrity

**Files:**
- Audit: `src/tools/fetch-guard.js` (already hardened — verify, don't rewrite), and the 19 kits with a raw `fetch(`: `b20-kit, cdp-kit, chain-kit, contract-kit, dex-kit, embed-kit, image-gen-kit, llm-gateway-kit, llm-kit, memory, mev-and-l2-kit, moderate-kit, nft-market-kit, onchain-identity-kit, prediction-market-kit, price-feed-kit, search, tts-kit, x402-kit` (all under `src/tools/`).
- Test: `scripts/test-fetch-guard.js` (EXISTS — extend it).

**Interfaces:**
- Consumes: `safeFetch(rawUrl, opts)`, `assertPublicUrl(rawUrl)`, `isSsrfBlock(err)`, `hostIsPublic(hostname)` from `src/tools/fetch-guard.js`.
- Produces: nothing new for later tasks (self-contained).

**The triage rule (apply per call-site, not per file):** a raw `fetch()` whose host is a **fixed upstream the buyer cannot influence** (OpenAI `api.openai.com`, OpenRouter `openrouter.ai`, a relay `*_RELAY_URL`, CDP, Alchemy, Brave, Neynar, FRED) is ACCEPTABLE. A raw `fetch()` whose **host or path derives from buyer input** MUST go through `safeFetch`/`assertPublicUrl` or a strict allowlist. The finding is: a buyer-influenced URL reaching a raw `fetch`.

- [ ] **Step 1: Enumerate every raw-fetch call-site.** For each of the 19 files, grep the `fetch(` call and trace its URL argument to source. Classify each: `FIXED-UPSTREAM` (ok) or `BUYER-INFLUENCED` (must be guarded). Record the table in the task report. Command: `grep -nE "fetch\(" src/tools/<file>.js` then read the surrounding function.
- [ ] **Step 2: Add invariant tests to `scripts/test-fetch-guard.js`** asserting the guard blocks each class. These are known-good and must pass now:

```js
import { assertPublicUrl } from "../src/tools/fetch-guard.js";
// isPrivateIp is intentionally not exported — probe it via assertPublicUrl,
// which throws an Error with statusCode 400 when a URL resolves private.
const blocks = async (url) => {
  try { await assertPublicUrl(url); return false; } catch (e) { return e.statusCode === 400; }
};
// cloud metadata + private + loopback + link-local must all reject
for (const u of [
  "http://169.254.169.254/latest/meta-data/",      // AWS/GCP metadata
  "http://[fd00::1]/",                               // IPv6 unique-local
  "http://[::ffff:169.254.169.254]/",               // v4-mapped metadata
  "http://127.0.0.1:6379/",                          // loopback redis
  "http://10.0.0.5/", "http://192.168.1.1/", "http://172.16.0.1/",
  "http://100.64.0.1/",                              // CGNAT
  "http://user:pass@169.254.169.254/",              // userinfo-smuggled
  "ftp://example.com/",                              // non-http scheme
]) {
  if (!(await blocks(u))) { console.error("FAIL - guard let through", u); process.exit(1); }
  console.log("ok - blocked", u);
}
// a real public host must PASS (guard is not over-broad — gravatar regression)
try { await assertPublicUrl("https://gravatar.com/avatar/abc"); console.log("ok - public host allowed"); }
catch (e) { console.error("FAIL - blocked a public host", e.message); process.exit(1); }
```

- [ ] **Step 3: Run it — expect PASS** (the guard already handles these; a FAIL here is itself a Critical finding): `node scripts/test-fetch-guard.js`. Expected tail: all `ok -` lines, exit 0.
- [ ] **Step 4: For any BUYER-INFLUENCED raw fetch found in Step 1**, verify the finding is real (can a buyer actually set the host to an internal IP?), then fix by routing through `safeFetch` and add a per-file assertion to the test. If Step 1 found none, note "no buyer-influenced raw fetch — all raw calls are fixed-upstream" in the report.
- [ ] **Step 5: Wire + commit.** Confirm `deploy.yml` line ~731 already runs `test-fetch-guard.js` (it does). Bump `.github/trigger-ci`. Commit: `audit(D1): SSRF guard invariants + egress triage [test]`.

---

### Task 2 (D2): Input validation / injection / DoS

**Files:**
- Audit: all 500 handlers, concentrated on parsers/regex/recursion in `kit.js, kit2.js, data-kit.js, convert-gen.js, pdf-kit.js, enrich-kit.js, web-kit.js, contract-kit.js`.
- Test: `scripts/test-security.js` (EXISTS — extend it).

**Interfaces:**
- Consumes: handlers via `KIT`/`KIT2` slug maps (pattern already in `test-security.js`).
- Produces: nothing for later tasks.

**Invariant:** hostile input yields a thrown `Error` with `.statusCode` in the 4xx range, never an unhandled 500, never a hang (>2s on a small input = ReDoS finding).

- [ ] **Step 1: Prototype-pollution sweep.** Enumerate every handler that merges/sets/unflattens object keys (grep `unflatten|__proto__|set-path|deep|merge` across `src/tools/`). `test-security.js` already covers `json-flatten`; extend to every other path-setting tool found. Add to `scripts/test-security.js`:

```js
// Every object-building tool must reject __proto__/constructor.prototype keys
const POLLUTERS = [{ "__proto__.x": 1 }, { "constructor.prototype.y": 1 }];
for (const slug of ["json-flatten", /* + any others found in Step 1 */]) {
  for (const p of POLLUTERS) {
    let threw = false;
    try { await call(slug, { json: p, mode: "unflatten" }); } catch (e) { threw = e.statusCode === 400; }
    if (!threw) fail(`${slug} must 400 on ${JSON.stringify(p)}`);
  }
}
if (({}).x !== undefined || ({}).y !== undefined) fail("Object.prototype polluted!");
console.log("proto-pollution blocked across all path-setting tools ✓");
```

- [ ] **Step 2: ReDoS + unbounded-input sweep.** For each tool taking free-text/regex input, feed a 1MB string and a known catastrophic-backtracking pattern; assert it returns/throws within 2s. Add a timing guard:

```js
const start = Date.now();
try { await call("<regex-tool>", { input: "a".repeat(50000) + "!", pattern: "(a+)+$" }); } catch {}
if (Date.now() - start > 2000) fail("<regex-tool> ReDoS: >2s on hostile input");
```

- [ ] **Step 3: Path-traversal sweep.** For tools taking a name/path/owner (github-owner class already fixed once), assert `..`, absolute paths, and encoded traversal are rejected with 400. Add per-tool assertions.
- [ ] **Step 4: For every confirmed finding, fix** (size cap before work / reject unsafe key / anchor or bound the regex / validate the path component) and keep the assertion. Run `node scripts/test-security.js` — expect exit 0.
- [ ] **Step 5: Wire + commit.** `deploy.yml` line ~725 already runs `test-security.js`. Bump `.github/trigger-ci`. Commit: `audit(D2): input-validation + ReDoS + traversal invariants [test]`.

---

### Task 3 (D3): Payment-gate integrity

**Files:**
- Audit: `src/payments.js`, `src/pow.js`, `src/server.js` (route binder, idempotency hook, `__sse`/`__binary`/`raw` sentinels).
- Test: `scripts/audit-deep.mjs` (EXISTS, needs a booted paid-mode server) + `scripts/test-idempotency.js` (EXISTS).

**Interfaces:**
- Consumes: PoW challenge/verify from `src/pow.js`; the paywall middleware from `src/payments.js`.
- Produces: nothing for later tasks.

**Invariants:** (a) no route returns paid output before settlement; (b) a PoW solution is single-use, HMAC-bound to its slug, and cannot be replayed or cross-slug-reused; (c) the idempotency cache key includes method + path + gate-credential, so replaying `Idempotency-Key` with a DIFFERENT body cannot return a prior paid result; (d) streamed responses are never idempotency-replayable.

- [ ] **Step 1: Trace the gate.** Read `src/payments.js` end-to-end; confirm every tool route mounts behind the paywall/PoW middleware and no handler writes the paid body on an unsettled request. Verify the `__sse`/`__binary` sentinels are only emitted AFTER the settlement point in the route binder (`src/server.js`). Record the settlement-ordering proof in the report.
- [ ] **Step 2: PoW abuse tests.** Extend `scripts/audit-deep.mjs` (it already boots a paid server) with: replay the same solution twice (second must 402/reject), submit a slug-A solution to slug-B (must reject), tamper one byte of the signed challenge (must reject). Assert each.
- [ ] **Step 3: Idempotency cross-body test.** In `scripts/test-idempotency.js`, POST a paid call with `Idempotency-Key: k` and body A (settle), then POST the SAME key with body B; assert the response reflects body B's gate outcome (a fresh 402/charge), NOT body A's cached result. Assert a streamed route is never served from cache.
- [ ] **Step 4: Fix any confirmed bypass** (a Critical → hot-fix exception applies). Re-run `BASE_URL=… node scripts/audit-deep.mjs` and `node scripts/test-idempotency.js` — expect all OK.
- [ ] **Step 5: Wire + commit.** Ensure both scripts run in `deploy.yml` (idempotency runs in the paid-mode job; add `audit-deep.mjs` to a booted-server step if not present). Bump the trigger. Commit: `audit(D3): payment-gate + PoW replay + idempotency invariants [test]`.

---

### Task 4 (D4): Attribution & memory isolation

**Files:**
- Audit: `src/payer.js` (already hardened — verify), `src/tools/memory.js`.
- Test: `scripts/test-memory.js` (EXISTS — extend it).

**Interfaces:**
- Consumes: `payerFromRequest(req)`, `normalizePayerAddress(from)`, `payerFromPaymentResponse(header)` from `src/payer.js`.
- Produces: nothing for later tasks.

**Invariants:** (a) `payerFromRequest` reads ONLY the signed `payload.payload.authorization.from` and returns EVM-only (a Solana/Stellar/Algorand address or a top-level unsigned `from` returns null — no signature-free namespace); (b) memory reads/writes are scoped to the derived payer namespace with no cross-namespace access; (c) per-namespace quota (10k keys AND `MEMORY_MAX_NS_BYTES` byte budget) returns 413 when full; (d) base58/Stellar/Algorand addresses are never lowercased.

- [ ] **Step 1: Spoofing invariant tests** in `scripts/test-memory.js`:

```js
import { payerFromRequest, normalizePayerAddress } from "../src/payer.js";
const mkReq = (obj) => ({ header: (h) => h.toLowerCase() === "x-payment"
  ? Buffer.from(JSON.stringify(obj)).toString("base64") : undefined });
// top-level unsigned `from` must NOT be honored (only authorization.from)
if (payerFromRequest(mkReq({ from: "0x" + "a".repeat(40) })) !== null)
  { console.error("FAIL - honored unsigned top-level from"); process.exit(1); }
// a valid signed EVM from IS honored, lowercased
const evm = "0x" + "A".repeat(40);
if (payerFromRequest(mkReq({ payload: { authorization: { from: evm } } })) !== evm.toLowerCase())
  { console.error("FAIL - did not attribute signed EVM from"); process.exit(1); }
// non-EVM authorization.from → null (no signature-free namespace via this path)
if (payerFromRequest(mkReq({ payload: { authorization: { from: "GABC" + "A".repeat(52) } } })) !== null)
  { console.error("FAIL - minted a non-EVM namespace"); process.exit(1); }
// Algorand/Stellar never lowercased by normalizePayerAddress
const algo = "A".repeat(58);
if (normalizePayerAddress(algo) !== algo) { console.error("FAIL - lowercased Algorand"); process.exit(1); }
console.log("ok - payer attribution cannot be spoofed");
```

- [ ] **Step 2: Namespace-isolation + quota tests.** Exercise `memory.js` handlers: write under payer A, attempt to read that key while attributed as payer B (must miss/deny); fill a namespace past the byte budget and assert a 413. Follow the existing `test-memory.js` call pattern.
- [ ] **Step 3: Fix any confirmed leak** (cross-namespace read = Critical) and keep the assertions. Run `node scripts/test-memory.js` — expect exit 0.
- [ ] **Step 4: Wire + commit.** `deploy.yml` line ~719 already runs `test-memory.js`. Bump the trigger. Commit: `audit(D4): payer-spoofing + namespace-isolation invariants [test]`.

---

### Task 5 (D5): Secret / data leak

**Files:**
- Audit: `src/tools/llm-gateway-kit.js` (cost-stripping), `src/tools/crypto-kit.js` (`sendCgKey` host-gating), the error middleware in `src/server.js`, all ~30 `process.env.*_KEY/_TOKEN/_SECRET` reads.
- Test: `scripts/test-leak-guard.js` (NEW).

**Interfaces:**
- Consumes: LLM gateway handlers (via the `/v1/*` route handlers or their exported builders), the global error handler.
- Produces: nothing for later tasks.

**Invariants:** (a) no configured secret VALUE appears in any buyer response body, cache entry, error message, or log line; (b) the LLM-gateway strips `cost`/`cost_details`/`is_byok` (and never leaks the upstream bill) before caching or returning; (c) a wrong/failing upstream key surfaces as a clean 502 that does NOT echo the key or the raw upstream error verbatim.

- [ ] **Step 1: git-history secret re-scan.** Run a fast scan for committed secrets: `git log -p --all -S 'sk-' -- '*.js' | head` and grep for `OPENAI_API_KEY=`, `POW_SECRET=`, `CDP_API_KEY_SECRET=` literals in tracked files. Expect none. Record result.
- [ ] **Step 2: Write `scripts/test-leak-guard.js`** — boot handlers with DUMMY secret values (`process.env.OPENAI_API_KEY = "sk-LEAKCANARY-DO-NOT-EMIT"` etc.), invoke each upstream-cost handler with an input that forces an upstream error (unreachable/invalid), and assert the canary string never appears in the thrown error message or any returned field:

```js
process.env.OPENAI_API_KEY = "sk-LEAKCANARY0000";
process.env.OPENROUTER_API_KEY = "sk-or-LEAKCANARY0000";
const CANARIES = ["LEAKCANARY"];
const scan = (obj) => JSON.stringify(obj ?? "");
// for each gateway/stt/image handler: call with a body that errors upstream,
// capture both the resolved value and any thrown error, assert no canary
for (const { slug, input } of GATEWAY_CASES) {
  let out;
  try { out = await call(slug, input); } catch (e) { out = { err: e.message, ...e }; }
  for (const c of CANARIES) if (scan(out).includes(c)) { console.error(`FAIL - ${slug} leaked secret`); process.exit(1); }
  console.log(`ok - ${slug} no secret leak`);
}
```

- [ ] **Step 3: Cost-strip assertion.** For a mocked successful gateway response carrying `cost`/`cost_details`/`is_byok`, assert those keys are absent from the buyer-facing return and from the cache entry. (Mock the upstream fetch or use a recorded fixture — no live spend.)
- [ ] **Step 4: Fix any leak** (secret in a response = Critical hot-fix; upstream-error echo = High) and keep the assertions. Run `node scripts/test-leak-guard.js` — expect exit 0.
- [ ] **Step 5: Wire + commit.** Add `run: node scripts/test-leak-guard.js` to `deploy.yml` beside the other unit tests (~line 725). Bump the trigger. Commit: `audit(D5): secret-leak guard for gateway/error paths [test]`.

---

### Task 6 (D6): Pricing / margin + 410-telemetry

**Files:**
- Audit: `src/tools/llm-gateway-kit.js` (margin clamp, `MODEL_COST`, `maxPrice`), `stt-kit.js` (`maxMinutes`), `image-gen-kit.js` (`IMAGES_MAX_PRICE`), `search.js`, the teaching-410 handlers in `src/server.js`.
- Test: `scripts/test-pricing-margin.js` (NEW).

**Interfaces:**
- Consumes: the gateway margin-clamp helper (`validateRequest` / the exact-BPE pricing path) and per-tier `maxPrice`/`MODEL_COST` tables from `llm-gateway-kit.js`; `assertWithinDurationCap`/`probeDurationSeconds` from `stt-kit.js`.
- Produces: a `tool_gone` PostHog event shape (route + replacement) emitted from the 410 handlers.

**Invariant:** for every upstream-cost tool, worst-case upstream spend on a real outbound body is strictly less than the tool's price (margin positive). The clamp math is computed offline (BPE tokenizer + `MODEL_COST`) — NO live upstream calls.

- [ ] **Step 1: Build the pricing table.** For each priced tier (nano/auto/base/pro/premium, embeddings, images) compute worst-case upstream cost on a max-size body (tool schemas present, `n` at its cap, images flat-1600 tokens) using the same `MODEL_COST`/BPE path the clamp uses. Assert `worstCaseUpstream < price` in `scripts/test-pricing-margin.js`:

```js
import { TIERS, MODEL_COST, worstCaseUpstreamCost } from "../src/tools/llm-gateway-kit.js";
for (const tier of TIERS) {
  const wc = worstCaseUpstreamCost(tier, /* max-size body */);
  if (!(wc < tier.price)) { console.error(`FAIL - ${tier.name} margin inverted: upstream ${wc} >= price ${tier.price}`); process.exit(1); }
  console.log(`ok - ${tier.name} margin +${((1 - wc/tier.price)*100).toFixed(0)}%`);
}
```
(If `worstCaseUpstreamCost` is not already exported, export the existing internal helper the clamp uses — do not duplicate the math.)

- [ ] **Step 2: Cap-before-spend assertion.** For STT and images, assert the local cap (`assertWithinDurationCap`, `IMAGES_MAX_PRICE`) throws BEFORE any fetch when the input exceeds the cap — feed an over-cap duration/size and assert the throw, with no upstream call made.
- [ ] **Step 3: 410-telemetry fix.** In the teaching-410 handlers (`src/server.js`), emit a lightweight PostHog `tool_gone` event carrying `{ route, replacement }` (reuse the existing posthog capture helper; lazy-load as elsewhere). Add an assertion that hitting a retired route calls the capture with the right shape (spy/stub the capture fn):

```js
// test: a GET/POST to a retired convert route fires tool_gone with route+replacement
```

- [ ] **Step 4: Fix any margin inversion** found in Step 1 (reprice or tighten the clamp) and keep the table assertion. Run `node scripts/test-pricing-margin.js` — expect exit 0.
- [ ] **Step 5: Wire + commit.** Add `run: node scripts/test-pricing-margin.js` to `deploy.yml`. Bump the trigger. Commit: `audit(D6): margin-inversion guard + 410 tool_gone telemetry [test]`.

---

### Task 7 (D7): Correctness spot-check + canary backlog

**Files:**
- Audit: `scripts/test-all.js` (coverage set), `scripts/paid-canary.js` (stale price + missing leg).
- Test: coverage assertion in `scripts/test-all.js` or a small new `scripts/test-canary-coverage.js`.

**Interfaces:**
- Consumes: the CATALOG slug list; the canary leg list in `paid-canary.js`.
- Produces: nothing for later tasks.

- [ ] **Step 1: New-tool coverage check.** Confirm the 30 new tools' slugs (contract-* , options-chain, country-info, feed-parse, evm-rpc, enrich-*, web-*, market-* …) are each exercised by `test-all.js` (answers-own-example) and none sits only in a lenient/NETWORK skip set. Assert the new-tool slugs ⊆ the swept set. Record any silently-skipped tool as a finding.
- [ ] **Step 2: Canary stale-price fix.** In `scripts/paid-canary.js` (~line 86), the stock-quote leg's `priceUsd: 0.005` is stale — prod advertises `0.003`. Update it to `0.003`. This is cosmetic (the leg reads prod's real price for settlement; the field is display-only).
- [ ] **Step 3: Add the options-chain canary leg.** Append an `options-chain` leg to the canary leg list mirroring an existing finance leg's shape (slug, input example, expected-shape assertion), so the deployed relay path is continuously proven. Use the tool's own discovery example as the input.
- [ ] **Step 4: Verify offline.** Run `node scripts/test-paid-canary.js` (the offline test of the canary harness) — expect exit 0. Do NOT run the live canary here (that happens in Task 8 post-deploy).
- [ ] **Step 5: Commit.** Bump the trigger. Commit: `audit(D7): new-tool coverage assert + canary options-chain leg + price fix [test]`.

---

### Task 8: Launch — batched audit deploy + 8-chain canary proof

This is the ONLY task that touches prod. It ships all D1–D7 fixes atomically. (Any Critical already hot-fixed earlier is already live; this deploys the batched remainder.)

- [ ] **Step 1: Full local battery green.** Boot free mode (`FREE_MODE=true PORT=3000 node src/server.js`) and run: `TARGET_URL=http://localhost:3000 node scripts/test-all.js`, `scripts/test-mcp-all.js`, then every new/extended audit test (`test-fetch-guard`, `test-security`, `test-memory`, `test-idempotency`, `test-leak-guard`, `test-pricing-margin`, `test-paid-canary`, `audit-deep.mjs` against a paid-mode server). All exit 0.
- [ ] **Step 2: Merge branch up to date with main;** confirm `node scripts/sync-count.js --check` exits 0 at the current floor (the audit changed no tool counts — expect no drift).
- [ ] **Step 3: Push the launch commit** with `[test][deploy]` and a trigger bump. Watch CI: test job green → deploy job. The deploy-quiet-gate protects live buyers (waits for no external USDC traffic before the Railway upsert).
- [ ] **Step 4: Post-deploy prod verification.** `/api/pricing` endpoints unchanged (audit added no tools); a signed spot-check of 3 hardened tools still answers; `/health` green; PageSpeed mobile bar holds (Perf 99 / A11y 100 / BP 100 / SEO 100).
- [ ] **Step 5: Dispatch the full paid canary** (`paid-canary.yml`, workflow_dispatch, ref main) — now including the options-chain leg — and confirm all legs settle across all 8 chains. The verdict is the job log tail.
- [ ] **Step 6: Update memory + spec status.** Supersede `project_security_audit_2026_06_25` with a `project_security_audit_2026_07_14` memory (findings summary, fixes, new tests). Mark the spec `Status: shipped`. Update `CLAUDE.md` follow-ups if any finding changed a documented invariant.

## Risks / mitigations

- **False-positive fix wastes effort / adds risk** → adversarial-reviewer gate: no fix without a verified concrete repro.
- **A Critical sits on the branch during the batch** → hot-fix exception ships it immediately, out of band.
- **A hardening fix breaks a tool's own example** → every fix re-runs the covering test AND that tool's answers-own-example check before the task closes; the Task-8 canary catches integration-level breakage.
- **Pricing check accidentally spends upstream** → the margin math is offline (BPE + `MODEL_COST`); no live upstream call is made to verify the clamp.
- **A new test is flaky on CI** → each test is deterministic (no network in the unit tests; dummy secrets for D5; offline math for D6). The only networked proof is the Task-8 canary, which already tolerates one transient leg.
