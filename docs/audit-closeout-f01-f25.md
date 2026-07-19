# 3rd security audit (A402-F01..F25) — closeout ledger

Final disposition of every finding from `Agent402-Final-Security-Reaudit`. Status
is one of: **Fixed** (shipped in code, live), **Accepted** (won't-fix with
rationale), or **Owner action** (cannot be closed from this repo — needs a
GitHub-admin, DNS/registrar, or product decision; exact steps below).

As of this writing, 22 of 25 are Fixed (F13 flag-gated OFF), 1 is Accepted, and 2 need owner action
(plus the owner half of F01).

## Ledger

| ID | Sev | Status | Where |
|---|---|---|---|
| F01 | High | Fixed (code) + **Owner action** (repo rulesets/env) | `.github/CODEOWNERS`, deploy/publish `environment:` refs |
| F02 | High | Fixed | secretless worker live (`worker/server.js`, `RENDER_WORKER_URL`) |
| F03 | High | Fixed | CDP actual-byte counting (`src/tools/render.js`) |
| F04 | High | Fixed | validate+pin egress proxy (`worker/egress-proxy.js`) |
| F05 | High | Fixed | tollbooth Durable-Object atomic replay (OSS pkg) |
| F06 | High | Fixed | media parsing in the secretless worker |
| F07 | High | Fixed | CI: untrusted `npm ci` step runs secretless |
| F08 | Med | Fixed | narrowed Gitleaks excludes |
| F09 | Med | Fixed | untrusted-content provenance on router + MCP |
| F10 | Med | Fixed | waitlist drops PII fallback, fails closed |
| F11 | Med | Fixed | route-aware Postgres TLS (`src/db-ssl.js`) |
| F12 | Med | Fixed | E2B output cap + concurrency ceiling |
| F13 | Med | Fixed (code, flag-gated OFF) | idempotent render credit (`src/render-credit.js`); enable with `RENDER_CREDIT_ENABLED` |
| F14 | Med | Fixed | MCP abort + await-before-release |
| F15 | Med | Fixed | PostHog proxy timeout + concurrency + byte cap |
| F16 | Med | Fixed | `Dockerfile.mcp` digest-pinned + non-root |
| F17 | Med | **Owner action** (DNS) | DMARC — steps below |
| F18 | Low | Fixed | tollbooth PoW origin+method binding (OSS pkg) |
| F19 | Low | Fixed | tollbooth `verifyX402` AbortSignal (OSS pkg) |
| F20 | Low | Fixed | operator dashboard `no-store` |
| F21 | Low | Fixed | bounded rate maps + global waitlist ceiling (`src/rate-sweep.js`) |
| F22 | Low | **Accepted** (won't-fix) | CSP inline — rationale below |
| F23 | Low | Fixed | dormant renderer href scheme guard |
| F24 | Low | Fixed | log-injection stripping |
| F25 | Low | **Owner action** (DNS) | DNSSEC/CAA/MTA-STS/www — steps below |

---

## Owner-action items — exact steps

These need an owner action from outside the repo (GitHub-admin, DNS/registrar, or
flipping a reviewed prod flag). Each is copy-paste ready. F13 is fully built and
only needs its flag enabled; F01 (owner half), F17, and F25 are the genuine
external actions.

### F01 (owner half) — GitHub branch rulesets + protected environment

Do this in the GitHub UI or via `gh api`. **Two guardrails so this does not
break the working CI/deploy flow:**
- The deployment-branch policy on the environment MUST allow the dev branch
  `claude/sweet-brown-i99jl3` (deploys run from it), not only `main`.
- Do **not** require signed commits unless you start GPG/SSH-signing — current
  commits are unsigned, so the rule would block every push.
- Do **not** enable "require review from someone other than the last pusher"
  while you are the sole maintainer — it would make every PR unmergeable.

Ruleset on `main` (and optionally the dev branch): require a pull request before
merging, require status checks to pass (`test`, `gitleaks`, `markers`), require
review from Code Owners, block force-pushes and deletions.

Protected environment `agent402 / production` (referenced by deploy/publish
jobs): add a required reviewer (yourself is fine), set the deployment-branch
policy to allow `main` **and** `claude/sweet-brown-i99jl3`, and move the
deploy/publish secrets to env scope.

### F13 — render capacity refused after settlement — BUILT (approach B), flag-gated OFF

Approach **B (idempotent durable credit)** is implemented in `src/render-credit.js`
and wired into the paywall in `src/server.js`, **flagged OFF by default** so
billing is byte-identical until enabled. On a capacity refusal (503) of a
*settled* paid render/screenshot, the server mints a one-time **credit token** (a
256-bit bearer secret) returned only in that buyer's own 503 response
(`X-Render-Credit` header + JSON `renderCredit`), bound to the exact request
(route + body). A retry presenting the token via `X-Render-Credit` skips the gate
(PoW + replay guard + USDC paywall) and is served without a second charge; the
credit is consumed only on successful delivery and survives repeated 503s for
another retry. 10-minute TTL, FIFO-capped.

Security: the token is unguessable and is delivered only to the paying caller, so
knowing a (public) wallet cannot forge or steal it; it is bound to route+body so
it can't be spent on a different or costlier render. Verified live that a forged
token still 402s (no free bypass). Unit-tested (`scripts/test-render-credit.js`,
21 cases: single-use, forgery/cross-request rejection, TTL expiry,
capacity-refusal persistence, eviction).

**To turn it on (owner, after review):** set `RENDER_CREDIT_ENABLED=true` on the
main Railway service. Rollback = unset it (billing reverts, no data). Approach A
(reserve-before-settle) writeup remains in `docs/f13-capacity-options.md` if the
ordering-change route is ever preferred.

### F17 — publish DMARC (DNS)

MX is Zoho; SPF is currently `~all` (soft-fail) with no DMARC.

1. In the Zoho mail admin, confirm DKIM is enabled and publish the selector TXT
   record Zoho provides for every sending domain.
2. Publish DMARC at `_dmarc.agent402.tools` (TXT), start in monitor mode:
   `v=DMARC1; p=none; rua=mailto:dmarc@agent402.tools; fo=1; adkim=s; aspf=s`
3. Watch the aggregate (`rua`) reports ~2 weeks, confirm all legit senders align,
   then tighten: `p=quarantine` → `p=reject`.
4. Only after every authorized sender is confirmed, change SPF `~all` → `-all`.

### F25 — DNS/mail transport hardening (DNS/registrar)

None of DS, CAA, MTA-STS, TLS-RPT, or `www` are present.

- **DNSSEC:** enable at the DNS provider and publish the DS record at the
  registrar.
- **CAA:** restrict issuance to the CA the platform actually uses. Railway
  fronts TLS with Let's Encrypt, so:
  `agent402.tools CAA 0 issue "letsencrypt.org"` and
  `agent402.tools CAA 0 iodef "mailto:security@agent402.tools"`.
  **Verify the CA before publishing** — a wrong CAA breaks cert renewal.
- **MTA-STS:** host `https://mta-sts.agent402.tools/.well-known/mta-sts.txt`
  (`version: STSv1`, `mode: testing` first, Zoho MX hosts, `max_age`), and
  publish `_mta-sts.agent402.tools TXT "v=STSv1; id=<timestamp>"`.
- **TLS-RPT:** `_smtp._tls.agent402.tools TXT "v=TLSRPTv1; rua=mailto:tls@agent402.tools"`.
- **www:** either add a `www` record with a TLS-covered redirect to the apex, or
  document the domain as apex-only. HSTS is `includeSubDomains`, so any future
  `www` endpoint must serve a valid cert from first use.

---

## Accepted (won't-fix)

### F22 — CSP still permits inline script/style

`script-src`/`style-src` keep `'unsafe-inline'`. **Accepted at Low** because:
output is escaped on every served surface, no live XSS is reachable (the audit
confirms this), and removing `'unsafe-inline'` requires per-response nonces
threaded through every page renderer (`ledger-home`, `market-page`, catalog,
guides, …) — a broad change with real breakage risk on live pages for a Low
finding.

If we later choose to close it: add a per-request nonce, remove `'unsafe-inline'`
from `script-src` first (styles second), and roll out behind
`Content-Security-Policy-Report-Only` to catch misses before enforcing.
