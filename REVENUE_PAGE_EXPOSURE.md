# Revenue page exposure review

Scope: `https://agent402.tools/revenue`, `/api/revenue`, `/api/revenue/daily`,
`/api/revenue/mpp`, `/api/revenue/tempo-daily`, `/api/calls/daily`, and the data
layer behind them (`src/revenue-live.js`, `src/revenue-ledger.js`,
`src/sales-ledger.js`, `src/leaderboard.js`, `src/payments.js`).
Reviewed 2026-09-20 against live production and the tree at `origin/main`.

The page is deliberately transparent and that is the product. Nothing here asks
it to publish less on-chain evidence. Every fix below either removes something
that was never meant to be public, or adds a frame around something that was.

## A note on scale

This business has published lifetime external revenue in the low hundreds of
dollars. Treating that as a securities or advertising-law exposure would be
inflating it, and this review does not. What the small number does **not**
reduce is fund security or personal safety: a hot wallet is worth stealing at
any balance, and the linkage between a published address and a named individual
is worth the same to someone hostile whether the address holds $40 or $40,000.
The severities below are set on that basis.

## Findings

| ID | Category | What is exposed | Realistic risk | Severity | Location | Fix | Confidence |
|----|----------|-----------------|----------------|----------|----------|-----|------------|
| **F-1** | Fund security / API | Raw upstream error text on an unauthenticated endpoint. Eleven of the RPC endpoints the rail scanners walk carry `ALCHEMY_API_KEY` **in the URL path**, and an upstream that echoes its own request inside an error body publishes it. The identical leak occurred on `/api/leaderboard` in Aug 2026 and was fixed in four modules; this one was missed. | Credential theft, then billed usage on our Alchemy account | **High** | `src/revenue-live.js` 13 `out.error` sites, `getJsonAcross`, `rpcCall` via `describeError` | **Fixed on this branch.** All public error text goes through `pubErr()`, which redacts **before** truncating. Guard `scripts/test-revenue-redaction.js`, 6 mutations killed, wired into CI. | High. Reproduced with a planted key. |
| **F-2** | Fund security | `ALCHEMY_API_KEY` was reachable through the path in F-1 for an unknown period | Same as F-1 | **High** | Railway env | **Owner action: rotate.** No evidence it leaked; the correct response to "was reachable" is to assume it did. | High |
| **F-3** | Fund security | The SOR spending wallet's address is published on every `route-execute*` 402 challenge as the Base payTo (`0x7706…4121`), and the AVM one as the Algorand payTo. Its sweeps to the treasury are visible on-chain, so the two are linkable. | Targeting: an attacker can watch the hot wallet's balance and time an attempt for when it is funded | **Medium** | `src/payments.js` `acceptsForItem` / `SELF_FUNDING_SLUGS` | **Not fixable by hiding.** A payTo must be published to be paid, and the self-funding loop is what stops the wallet needing manual top-ups. Mitigate by bounding the balance instead: see `WALLET_ISOLATION_PLAN.md`. | High |
| **F-4** | API / competitive | `/api/revenue` publishes up to ~96 payer wallet addresses at a time in `rails[].recent[].from` (78 distinct in one sample). `/api/revenue/daily` deliberately does not, with the reason written in the code: "a per-day roster of who pays us is a customer list." | Customer-list harvesting; a competitor learns exactly who buys | **Low-Medium** | `src/revenue-live.js` recent-transfer feed | **Deliberately not removed.** Each `from` is one click from the `txHash` published beside it, and the hash is the verification primitive that cannot be withheld, so dropping the field would be cosmetic. Bounded instead by F-5. | High |
| **F-5** | API | No rate limit on any of the six transaction surfaces. Responses are cached 30-300s, so this is not a load problem; it is a bulk-scraping problem for the feed in F-4. | Buyer-roster harvesting at speed | **Medium** | `src/server.js` | **Fixed on this branch.** Own bucket, 60/min and 600/hour, mounted before the handlers, `Retry-After` on refusal, HTML refusal on `/revenue` so a crawler does not lose the page. Pinned from source. | High |
| **F-6** | Identity | The public source link spells out a URL containing a **personal account name**, in the footer of every page, six `Organization` JSON-LD `sameAs` blocks, `/company`, `/terms`, `/security`, `/why`, the MCP connector copy agents read, the discovery manifest, and the crawler `User-Agent` other operators see in their logs. | **Doxxing.** Published wallets to a named individual to a home address via public records. This is the finding with real personal-safety weight. | **High** | 91 sites across 43 modules | **Half fixed.** All 91 now read one constant (`src/repo-link.js`, `AGENT402_REPO_URL` to override), verified by diffing 15 rendered pages before and after: only `/revenue` differs, and only by the intended copy. **The other half is an owner action on GitHub** (move the repo to an org, then set the env var). Guard `scripts/test-repo-link.js`. | High |
| **F-7** | Fund security / Identity | One EVM address receives on nine chains and holds the float, so its balance is the company's full liquid position and is readable by anyone | Targeting; and a competitor reads the treasury | **Medium** | `WALLET_ADDRESS` | **Owner decision.** Split receive from reserve; the receive address stays published so verification is unaffected. `WALLET_ISOLATION_PLAN.md`. | High |
| **F-8** | Claims | The card figure sat directly after "revenue, settled on-chain" with nothing between them, so a card purchase read as an on-chain settlement. Card settlements are real revenue with no explorer link. | Deceptive-practice hygiene | **Low** | `revenuePage` hero | **Fixed on this branch.** The clause now says "by card, not on-chain". | High |
| **F-9** | Claims | Performance figures with no frame. Revenue vs throughput vs internal was already distinguished in five places; what was never said is what the figures are *for*. | A reader supplies their own reading | **Low** | `revenuePage` | **Fixed on this branch.** One line: information only, not an offer, solicitation, recommendation or investment advice, not a projection. `/transparency` already carried the equivalent. | High |
| **F-10** | Third-party | The correction path for an indexed seller existed only as prose at the bottom of two HTML leaderboards. A seller reading `/api/index`, `/api/index?seller=` or `/api/route`, which is how most find their row, had no way to learn one exists. | Seller dispute escalating because no channel was visible | **Low-Medium** | `dispatchLegend`, marketplace FAQ | **Fixed on this branch.** In the machine legend beside the verdicts it qualifies, and in the FAQ array that renders both the visible questions and the `FAQPage` JSON-LD. | High |
| **F-11** | Identity | `duns: "142233542"` in the `/company` `Organization` JSON-LD, with `addressRegion: NC` | Marginal. A DUNS record is already publicly searchable and names the business, not the person. | **Informational** | `src/company.js` | No change recommended. Correct entity, correct level of disclosure. | High |
| **F-12** | Identity | `src/tools/enrich-kit.js` uses this repository as the documented example input for the `github-repo` tool, so the handle appears in `/openapi.json` and `/llms.txt` | Marginal, but it is a served surface | **Informational** | `enrich-kit.js` | Left alone deliberately and exempted with a reason in the guard: the CI example check drives that tool against the live API, so the repo named there is test data and changing it means changing a published example and its expected output. Revisit when the repo moves. | High |
| **F-13** | Claims | Buyer concentration ("top 5 = N% of their payments") and exact distinct-buyer counts are published | Competitive intelligence, not a legal risk | **Informational** | `revenuePage` hero, `/api/revenue/daily` | **Flagged, not changed.** This looks intentional: the code comment beside it says a buyer count "means nothing if one wallet is most of the volume", which is a transparency argument, and the figures are counts with no addresses. Raised here only so the choice is explicit. | High |

## Part-by-part answers

**1.1 Hot/cold separation.** Confirmed separate addresses and separate keys.
`X402_UPSTREAM_BUYER_KEY` (Base), `ALGORAND_UPSTREAM_BUYER_MNEMONIC`,
`SOLANA_UPSTREAM_BUYER_KEY` and `TEMPO_UPSTREAM_BUYER_KEY` are each distinct
from `WALLET_ADDRESS` and from the CI canary burners, and the code comments say
so as a rule ("NEVER the treasury or the CI burner"). The addresses are
published, unavoidably, as F-3 explains. `/api/revenue` shows the **treasury**
balance per rail, not the spending wallet's.

**1.2 Address reuse.** F-7. Tradeoff documented in `WALLET_ISOLATION_PLAN.md`.

**1.3 Spend controls.** Verified in code, and better than the brief assumes:

- Per-tx cap re-checked against **the single accept about to be signed**, not
  `accepts[0]` and not the seller's advertised catalogue price
  (`quoteWithinCap` in `payX402`).
- Per-payer unsettled ceiling, `EXTERNAL_MAX_UNSETTLED_USD` (default $6), which
  exists because settlement happens *after* the handler has already paid the
  seller (`src/external-spend-guard.js`).
- Per-chain-wallet rolling 24h ceiling, `SOR_WALLET_DAILY_MAX_USD` (default
  $25), which **survives a restart** because it is persisted, so the bound
  cannot be reset by cycling the process.
- Destination binding: the address that earned proven-ness must be the address
  paid, checked against the live accept, refusing only on a positive mismatch.
- Sanctions screening on the accept's `payTo` before signing.
- EIP-712 domain check, so a wrong-domain Base accept is refused unsigned.
- Kill switch: `SIGNING_HALTED`, consulted as the **first statement of every
  signing path** (five modules), **fails closed by construction** (only an
  explicit off-value permits signing, so a typo stops spending).

Covered by `test-external-spend-guard.js`, `test-signing-halt.js` (including a
source pin that every signing file consults the halt), `test-self-funding.js`
and `test-x402-spend-controls.js`. **No new spend-control code was needed, so
no new spend-control tests were added.** Writing some would have been theatre.

**1.4 Keys.** No private key, mnemonic or keystore in the tree, in `src/`, in
client-shipped code, or in git history. Every wallet secret is a Railway env var
or a GitHub Actions secret. The only `BEGIN ... PRIVATE KEY` string in `src/` is
a documentation placeholder in a guide. `SECRETS_TO_ROTATE.md` appears in
history and never contained a literal value (checked with a pattern scan across
every revision of that path). Nothing to rotate on this finding; rotate
`ALCHEMY_API_KEY` for F-2.

**1.5 Self-funding loop abuse.** The drain the brief describes is real and is
already the documented reason `external-spend-guard.js` exists: list a seller,
buy from yourself, let your own settlement fail, and every drained dollar lands
back in your pocket. It is bounded four ways, and the binding one is the
per-payer unsettled ceiling, because it is the only one that bounds *whether we
get paid* rather than *what we pay*. Routing eligibility additionally requires
50 settlements and 3 distinct payers on the seller's own advertised address
(`dispatchEligibility`). The one deliberate hole is the unproven Solana tier,
capped at `SOR_SVM_UNPROVEN_MAX_USD` (default $0.01) and tried only after every
proven candidate. **Residual: the per-payer ceiling is keyed on payer identity,
so rotating wallets walks around it.** That is exactly what the per-chain daily
ceiling is for, and it is the reason that ceiling must stay set.

**3. Claim discipline.** Every figure on `/revenue` traces to the source it
cites: rail counts and dollars to `ledgerSummary` over the settlement ledger,
throughput to `railThroughput`, buyers to `ledgerBuyerConcentration`, MPP to
`mppSales`, card to `cardSales`. Nothing was found that cannot be reproduced.
Revenue vs throughput is distinguished in the hero, the rail-table intro, the
MPP section, the API `note` and `/transparency`. F-8 and F-9 are the two gaps
and both are fixed. The entity is `Havok Holdings LLC` consistently; no stale
naming found.

**4. Third-party sellers.** Labels are factual, sourced and neutrally worded.
The strongest adverse label in the system is `delivery_failing`, and its own
legend entry already explains that the **verdict** is published because it is a
statement about what this host does, while the underlying observation is
deliberately withheld as "a specific adverse claim about a named third party".
That is the right instinct and needed nothing. Non-chain sources were checked
against their terms in prior work (recorded in project memory); the one
unlicensed redistribution found there, Yahoo Finance, was already replaced with
a licensed feed. F-10 is the only gap and is fixed.

**5. Public API.** Rate limiting was absent (F-5, fixed). No internal wallet
labels, spending-wallet addresses or debug fields leak: `rails[].wallet` is the
treasury, `error` and `scanNote` are now redacted, and itemized MPP rows are
operator-gated behind `operatorAuthed`. No enumeration risk found: there are no
sequential ids on these surfaces, and the buyer addresses in F-4 are a published
feed rather than an enumerable space.

## What is in the diff

| File | Change |
|------|--------|
| `src/revenue-live.js` | `pubErr()` helper; 13 error sites and `describeError` routed through it; card wording; informational line |
| `src/server.js` | `REVENUE_READ_PATHS` + `revenueReadLimiter`, mounted before the handlers |
| `src/repo-link.js` | New. `REPO_URL` / `REPO_SLUG` / `REPO_NAMESPACE` / `repoUrl()`, `AGENT402_REPO_URL` to override |
| 40 served modules | 91 hardcoded source links replaced by the constant |
| `src/dispatch-eligibility.js` | `corrections` in the machine legend |
| `src/market-page.js` | Correction path in the FAQ array (visible + `FAQPage` JSON-LD) |
| `scripts/test-revenue-redaction.js` | New. 31 assertions, control first, 6 mutations killed |
| `scripts/test-repo-link.js` | New. 24 assertions, sweeps 316 modules, control first |
| `scripts/test-marketplace-index-page.js` | FAQ count pin changed to the pairing it was protecting |
| `.github/workflows/deploy.yml` | Both guards wired beside the sibling redaction guard |
