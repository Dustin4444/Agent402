# Agent402.Tools — Full Security & Pricing Audit (v2.0.0 catalog)

**Date:** 2026-07-14
**Status:** Design approved, plan pending
**Scope:** Re-verify the entire attack surface of the 500-entry catalog (400 tools + 100 skill
packs) and cover the 30 tools + 8 packs added since the last audit (2026-06-25); add a
pricing/margin dimension the prior audit did not perform.

## Goal

Prove that no buyer (or hostile input) can (a) obtain paid output without settling, (b) read
another payer's data, (c) reach internal/private network resources, (d) extract a secret,
upstream cost, or internal header, (e) crash or hang a handler, or (f) buy a tool priced below
its own upstream cost. Every CONFIRMED finding is fixed and locked with a permanent regression
test in the same pass.

## Non-goals

- Not a rebuild of functional CI. The answers-own-example sweep (`test-all.js`, all 500), the
  MCP sweep (`test-mcp-all.js`), and the 26-leg paid canary already prove functional
  correctness. The audit verifies those gates *cover the new tools* and spot-checks new tools
  live on prod — it does not independently re-test all 500 against upstreams.
- Not a systematic price pass over pure-CPU / free-data tools (zero marginal cost). Those get an
  obvious-error spot-check only.
- Not an infra/dependency-CVE sweep beyond confirming the known upstream npm advisories
  (ws/form-data via viem→x402) are unchanged and unreachable in the serving path.

## Baseline (what the 2026-06-25 audit already established)

Confirmed clean then: no secrets in git history, SQL parameterized, `fetch-guard.js` SSRF
protection thorough, payment flow un-bypassable, PoW HMAC-signed/single-use/timing-safe, error
handling never leaks stack traces, PostHog/Sentry strip PII. Fixed then: SSRF in `stt-kit.js`
(now `safeFetch`). This audit re-verifies those hold AND extends coverage to everything shipped
since.

## Decisions (owner-approved, 2026-07-14)

1. **Fix policy:** fix-as-we-go. Each CONFIRMED finding is remediated immediately with a
   regression test, then the audit continues. Owner still approves anything risky/destructive.
2. **Pricing depth:** upstream-cost tools only (LLM gateway tiers, STT, images, search,
   finance/crypto with paid keys). Pure-CPU/free-data = obvious-error spot-check only.
3. **Deploy cadence:** batch. All fixes land on `claude/sweet-brown-i99jl3` under `[test]`
   only; one atomic `[deploy]` when the audit is green, then a full 8-chain canary as proof.
   **Exception:** a CONFIRMED critical/exploitable finding (gate bypass, secret leak,
   SSRF-to-internal) is hot-fixed and deployed immediately, flagged to the owner.
4. **Correctness bar:** lean on existing gates + verify they cover the 30 new tools + live prod
   spot-check of new tools. No rebuild of CI-guaranteed correctness.

## Methodology

Each attack domain runs the same loop: **enumerate the surface → adversarially probe → verify
the finding is real → fix + add a regression test to the permanent suite.** Findings that
survive verification become tests wired into `.github/workflows/deploy.yml`, so the hole fails
CI if it ever reopens (the model `test-security.js` already uses).

**Execution:** subagent-driven (superpowers:subagent-driven-development). One implementer
subagent per domain (fresh context, adversarial prompt) → an adversarial reviewer that must
confirm each finding is real *before* any fix is written (a plausible-but-wrong "vulnerability"
that gets fixed is wasted work and added risk) → a fix subagent with the covering test named.
All subagents on the **fable** model.

**Severity scale:** Critical (exploitable now: gate bypass, secret leak, SSRF-to-internal,
cross-payer read) → High (exploitable with effort / DoS) → Medium (defense-in-depth gap) → Low
(hygiene). Critical triggers the hot-fix exception.

## Attack domains

### D1 — SSRF / egress integrity
**Surface:** 30 tool files make outbound `fetch`; 22 route through `safeFetch`. **Task:** triage
every raw-`fetch` file — a fetch to a **fixed upstream** the buyer cannot influence (OpenAI,
OpenRouter, CDP, a relay URL) is acceptable; a fetch whose **host/path derives from buyer
input** must go through `safeFetch` or an equivalent allowlist. Re-verify `fetch-guard.js`
blocks: RFC-1918 private ranges, loopback, link-local (169.254/16), the narrowed 192.0.0.x
special-use range, IPv6 private/mapped, and **redirect-to-private** (a public URL 30x-ing to
an internal one). DNS-rebinding note: confirm the guard resolves-then-pins or re-checks post
redirect.
**Files:** `src/tools/fetch-guard.js`; the 19 kits with at least one raw `fetch`
(b20/cdp/chain/contract/dex/embed/image-gen/llm-gateway/llm/memory/mev-and-l2/moderate/
nft-market/onchain-identity/prediction-market/price-feed/search/tts/x402). Note: a file may
appear here *and* use `safeFetch` elsewhere — the raw call to a fixed upstream is fine; the
triage is per call-site, not per file.
**Regression home:** new `scripts/test-ssrf-guard.js` (extends the existing fetch-guard probe).

### D2 — Input validation / injection / DoS
**Surface:** all 500 handlers, but concentrated on parsers and anything with regex, recursion,
or unbounded input. **Checks:** prototype pollution (all merge/unflatten/set-path paths, not
just json-flatten), ReDoS (catastrophic-backtracking regex on buyer input), path traversal
(the github-owner/`..` class already found once), unbounded input → memory/time DoS (size caps
before work), template/format injection. **Invariant:** hostile input yields a clean 4xx with
`statusCode`, never a 500, never a hang.
**Regression home:** extend `scripts/test-security.js`.

### D3 — Payment-gate integrity
**Checks:** no code path emits paid output before settlement; the `raw` / `stream` (`__sse`) /
`__binary` sentinels can't return un-gated content; PoW cannot be replayed, forged, or reused
across a different slug (HMAC scope), and the single-use marker holds under concurrency;
idempotency cache key includes method+path+gate-credential so a replay of a *different* body
can't return a prior paid result; `Idempotency-Key` never bridges two different payers.
**Files:** `src/payments.js`, `src/pow.js`, `src/server.js` (route binder + idempotency hook).
**Regression home:** extend `scripts/audit-deep.mjs` + `scripts/test-idempotency.js`.

### D4 — Attribution & memory isolation
**Checks:** `payerFromRequest` reads only the signed EIP-3009 `authorization.from` (never a
buyer-supplied header) — memory identity cannot be spoofed to read/write another namespace;
per-namespace quotas (10k keys AND 32MB byte budget) enforced at call time with a 413 when
full; base58/Stellar addresses never lowercased (EVM-only normalization). Cross-payer read
attempt must fail closed.
**Files:** `src/payer.js`, `src/tools/memory.js`.
**Regression home:** extend `scripts/test-memory.js`.

### D5 — Secret / data leak
**Checks:** none of the ~30 secrets (CDP, OpenAI, OpenRouter, Alchemy, Brave×3, FRED×2, Neynar,
relay tokens, GITHUB_TOKEN, POW_SECRET) appears in any buyer response, cache entry, error body,
or log line; the LLM-gateway cost-stripping holds (`cost`/`cost_details`/`is_byok` removed
before cache-or-return; usage-accounting fields never leak); CoinGecko key host-gated (only
sent to CoinGecko, verified in the June-era `sendCgKey` fix); git history clean (re-scan);
error handler never returns stack/env. Confirm a wrong API key surfaces as a clean 502, not a
leak of the key or upstream error verbatim.
**Files:** `src/tools/llm-gateway-kit.js`, `src/tools/crypto-kit.js`, error middleware in
`src/server.js`.
**Regression home:** new `scripts/test-leak-guard.js` (response/cache/error body never contains
a configured secret value; run with dummy secrets set).

### D6 — Pricing / margin
**Method:** for each upstream-cost tool, compute worst-case upstream spend on a real outbound
body and confirm price exceeds it with margin. **LLM gateway** (highest value): verify the
margin-clamp actually shrinks `max_tokens` so worst-case upstream ≤70% of tier price on bodies
with tool schemas, `n`>1, and images (flat-1600) — where a crafted input could otherwise invert
the margin. **STT/images/search/finance-crypto:** confirm the local cap (`maxMinutes`,
`IMAGES_MAX_PRICE`, duration/size probe) fires *before* any upstream spend and break-even holds
at the cap. Output: a pricing table (tool → price → worst-case upstream → margin → verdict);
any inversion is a finding.
**Backlog folded in:** the **410-telemetry blind spot** — retired-converter 410s emit no
PostHog event, so residual dead-route demand is invisible; fix by emitting a lightweight
`tool_gone` event (route + replacement).
**Files:** `src/tools/llm-gateway-kit.js`, `stt-kit.js`, `image-gen-kit.js`, `search.js`, the
410 handlers in `src/server.js`.
**Regression home:** new `scripts/test-pricing-margin.js` (asserts each priced tier's
worst-case upstream < price); the 410-telemetry gets a shape assertion.

### D7 — Correctness spot-check
**Checks:** confirm `test-all.js` / `test-mcp-all.js` / `paid-canary.js` actually exercise the
30 new tools (none silently skipped or in a lenient-only set); live prod spot-check of the new
tools (contract-source, options-chain, country-info, feed-parse, evm-rpc, etc.) via a signed
call or the canary; **backlog:** fix the canary stock-quote leg's stale `priceUsd` (0.005 →
0.003, cosmetic) and **add the options-chain canary leg** so the deployed relay path is
continuously proven.
**Files:** `scripts/paid-canary.js`, `scripts/test-all.js` coverage set.
**Regression home:** the canary itself; a coverage assertion that new-tool slugs are in the
sweep set.

## Deliverables

1. Findings ledger — severity-ranked, each with a repro and the fix commit.
2. Pricing table (D6) — upstream-cost tools with margin verdicts.
3. New/extended regression tests wired into `deploy.yml`, guarding every fix forever.
4. One atomic `[deploy]` of the batched fixes + an 8-chain canary run (incl. options-chain) as
   on-chain proof.
5. Updated memory: supersede `project_security_audit_2026_06_25` with the 2026-07-14 results.

## Risks / mitigations

- **False positives waste fix effort and add risk** → the adversarial-reviewer gate: no fix is
  written until a finding is verified real with a concrete repro.
- **A critical finding sitting on the branch during a batch audit leaves prod exposed** → the
  hot-fix exception ships criticals immediately, out of band.
- **A fix breaks a tool's own example (correctness regression)** → every fix subagent re-runs
  the covering test AND that tool's answers-own-example check before the task closes; the final
  canary catches anything integration-level.
- **Pricing check on live keys could incur upstream spend** → margin math is computed on
  request bodies offline (BPE tokenizer, `MODEL_COST` table) — no live upstream calls needed to
  verify the clamp; the canary already proves live settlement separately.
