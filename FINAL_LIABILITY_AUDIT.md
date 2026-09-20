# Final liability audit (second pass, independent)

**Operator:** Havok Holdings LLC · **Date:** 2026-09-20 · **Counsel:** none, and none coming.

This pass re-audited the repository independently and then compared against the first pass.
**Nothing here is legal advice.** Where a question needed a lawyer, the conservative engineering
option is recommended over a disclaimer, because a disclaimer does not cure a feature.

> **This document must not stay in a public repository.** See F-14 and `REPO_STRATEGY.md`.

---

## Delta vs. the first pass

### MISSED - the largest money path in the product
**F-13.** The first pass audited *inbound* stored value (prepaid credits) and never examined
**outbound payment**. `route-execute` accepts a buyer's payment and then **pays an external
seller from a Havok-controlled hot wallet**, on four chains, with all four keys live in
production and `SOR_EXTERNAL_ENABLED=true`. That is the single highest-exposure path in the
codebase and it was absent from the first report. 276 calls, 5 buyers, 90 days, last used
2026-09-19.

### NEW EXPOSURE created by the first pass
**F-14.** The first pass committed `LEGAL_RISK_AUDIT.md` and `SECRETS_TO_ROTATE.md` to a
**public** repository. That is a signed, dated, self-authored catalogue of the company's own
legal weak points, naming a credential still in history and stating that terms of a named third
party were knowingly exceeded. In litigation this is the first document opposing counsel would
reach for, and publishing it waives any argument that the issues were not known. The analysis
was right; publishing it was the error.

### WRONG or overstated
- **F-07 "no unsupported marketing absolutes."** Under-tested. It grepped a handful of words on
  `src/*.js` and drew a repo-wide conclusion. Not re-verified here either - marked UNVERIFIED
  rather than re-asserted.
- **F-11 gambling/CFTC "Low".** The reasoning (we resell market data, we offer no contracts)
  holds, but it cited no primary source. Still Low; now marked UNVERIFIED.

### INADEQUATE
- **F-05 credential.** First pass wrote the rotation doc but recorded the value as "reported
  rotated" without testing it. Verified this pass only that `.remember` **is still in history**
  (`git log --all -- .remember` returns commits), so no purge occurred. Rotation itself remains
  **UNKNOWN**.
- **F-01 postal address.** Correctly built and correctly fails open, but the first pass reported
  it as fixed while the value was unset. It is set in production now
  (`COMPANY_POSTAL_ADDRESS`), though the **code that renders it is still unmerged**.

### CONFIRMED sound
F-02 (credit sales gated off, redemption preserved), F-03, F-04 (Nasdaq removed after measuring
usage), F-06. Dependency audit 0 vulnerabilities. gitleaks over full history: no leaks.

---

## Findings

| ID | Category | Sev | Status | Money/Autonomy | Evidence | Primary source | Confidence |
|---|---|---|---|---|---|---|---|
| F-13 | Outbound payment for others | **Critical** | **OPEN** | **MONEY + AUTONOMOUS** | `route-execute.js:408`; `SOR_EXTERNAL_ENABLED=true` in prod; 4 wallet keys SET | [31 CFR 1010.100(ff)](https://www.law.cornell.edu/cfr/text/31/1010.100), [FinCEN FIN-2019-G001](https://www.fincen.gov/system/files/2019-05/FinCEN%20Guidance%20CVC%20FINAL%20508.pdf) | Medium - see analysis |
| F-14 | Self-incriminating public docs | **High** | **OPEN** | No | `LEGAL_RISK_AUDIT.md`, `SECRETS_TO_ROTATE.md` committed publicly | n/a | High |
| F-01 | CAN-SPAM address | High | FIXED-UNVERIFIED | No | `src/email.js`; var set in prod; **code unmerged** | [15 U.S.C. 7704(a)(5)](https://www.law.cornell.edu/uscode/text/15/7704) | High |
| F-02 | Stored value | High | RESTRICTED | MONEY (inbound) | `CREDITS_SALES` off by default; redemption preserved | [31 CFR 1010.100(ff)](https://www.law.cornell.edu/cfr/text/31/1010.100) | Medium |
| F-03 | Advice disclaimers | Medium | FIXED-VERIFIED | No | 4 kits; corpus 269/0 | UNVERIFIED | Medium |
| F-04 | Third-party terms (Nasdaq) | Medium | REMOVED | No | tools + relay deleted; 85 pack prices re-derived | vendor terms | High |
| F-05 | Credential in history | Medium | **OPEN** | No | `.remember` still reachable | n/a | High |
| F-06 | Accessibility | Medium | FIXED-VERIFIED | No | 6/6 inputs named on `/digest` | [ADA Title III](https://www.ada.gov/resources/web-guidance/) | Medium |
| F-15 | Reports on named third parties | Medium | OPEN | No | `seller-dossier`, leaderboards publish commercial assessments of named companies | n/a | Medium |
| F-07 | Marketing absolutes | Low | **UNVERIFIED** | No | first-pass grep too narrow | n/a | Low |
| F-11 | Gambling / CFTC | Low | **UNVERIFIED** | No | data resale only; no contracts offered | not retrieved | Low |

## F-13 analysis - the one that matters

**What happens:** buyer pays Agent402 → Agent402 selects a seller → Agent402 pays that seller
from its own hot wallet → Agent402 returns the result.

**Why it is probably NOT money transmission.** FinCEN defines it as accepting value from one
person and transmitting it *to another person*. Here the buyer never names a payee: the input is
a `task` or a `slug` (`route-execute.js:203-206`), Agent402 chooses the seller, sets the price
cap, and **bears the loss when a seller takes payment and fails** (a >=400 cancels the buyer's
settlement, so Havok eats it). That is buying an input for one's own account and reselling -
procurement, like paying AWS.

**Why that is not a safe conclusion.** The payment-processor exemption in
[31 CFR 1010.100(ff)(5)](https://www.law.cornell.edu/cfr/text/31/1010.100) is *unavailable*
here regardless: FinCEN conditions it on operating "through clearance and settlement systems
that admit only BSA-regulated financial institutions," and a public blockchain is not one. So
if a regulator reads the flow as transmission, there is no processor safe harbour to fall back
on. State law varies independently of FinCEN, and money-transmitter analysis is fact-specific.

**Verdict: genuinely unclear, and money is involved.** Under the stated rule - unclear + money
→ conservative engineering option - the recommendation is to set `SOR_EXTERNAL_ENABLED=false`
until the question is answered. The flag already exists and defaults off in code
(`server.js:927`); only production turns it on. **Not flipped by this pass: that is a live
revenue decision, and flipping a production flag is the owner's call.** See
`OWNER_ACTION_ITEMS.md` item 1.

## Data-flow map vs. the policies

| Collected | Stored | Sent to | Policy says | Match |
|---|---|---|---|---|
| Wallet address (payer) | Sales ledger, memory keys | Facilitators | Disclosed | ✅ |
| Email (alerts, monitors, digest, card) | `/data` stores | ZeptoMail/Resend, Stripe | Disclosed | ✅ |
| Prompt content on `/v1` | Not retained by us | **OpenRouter / OpenAI** | Disclosed in general terms | ⚠️ named providers not enumerated |
| Client IP | Rate limits, hashed wish fingerprints | Not shared | Disclosed | ✅ |
| Browser events | PostHog | PostHog | Disclosed | ✅ |
| Report inputs (ticker, domain, question) | Stripe metadata, report record | Stripe | Disclosed | ✅ |

One mismatch, minor: the policy describes model providers generically. Buyers sending prompts
should be told **which** third party receives them.

## Not verified by this pass
axe/pa11y/Lighthouse were not run (only structural checks). ~18 data-provider terms unreviewed.
Old credential not tested for revocation. Local gitleaks is 8.30.1 while CI pins 8.21.2, so a
local clean scan is not equivalent to CI's.
