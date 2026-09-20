# Legal risk audit

**Scope:** everything publicly visible in this repository and on the served site - code, config,
full git history, docs, README, and the ToS/privacy pages. Adversarial read: what would a
plaintiff's attorney or a regulator actually file?

**Date:** 2026-09-20 · **Subject:** Havok Holdings LLC (Agent402.Tools and related packages)

> **THIS DOCUMENT MUST NOT STAY IN A PUBLIC REPOSITORY.** It is a self-authored record of known
> issues; publishing it removes any argument that they were unknown. See `REPO_STRATEGY.md`.
>
> **This is not legal advice.** It is an engineering read of where the code and copy diverge from
> common statutory requirements. Every item marked *Needs counsel* is a judgment call that a
> licensed attorney must make. Items marked *Code* or *Content* are mechanical and were fixed.

---

## Executive summary: the five most likely to actually be filed

1. **CAN-SPAM: no postal address in commercial email (F-01).** Every outbound email carries an
   unsubscribe link and `List-Unsubscribe`, which is most of the work - and none carries the
   physical mailing address the statute requires in *every* commercial message. The day-7
   "another report?" follow-up is unambiguously commercial. This is the single most concrete
   finding: strict liability, per-message statutory exposure, no intent required, and the FTC
   has brought exactly this case many times. **Fixed mechanically; needs a real address.**

2. **Stored value without a licensing determination (F-02). RESOLVED by not selling.** `/credits` sells a prepaid balance
   by card that the company holds until spent, and the terms say credits never expire. Holding
   customer funds for future redemption is the definition of stored value in most state money
   transmitter statutes. Whether an exemption applies (closed-loop / agent-of-payee) is a real
   legal question, not an engineering one. The remedy chosen was the product change: sales are off by
   default, redemption still works, and the ledger confirmed no outside party had ever bought,
   so nothing was held and no refund is owed.

3. **Financial analysis sold without an advice disclaimer (F-03).** Four paid products that
   output investment-shaped analysis carry no "not investment advice" language, while four
   comparable ones do. The inconsistency is the problem: it shows the company knew the
   disclaimer was appropriate and applied it unevenly. **Fixed.**

4. **Third-party terms: Nasdaq (F-04). RESOLVED by removal.** The project's own notes record that Nasdaq's terms are
   "personal non-commercial only," and the earnings-calendar tool still calls `api.nasdaq.com`
   on a commercial service. A written admission of knowledge is the worst posture to be in.
   Both tools and the relay behind them are removed.

5. **A credential is in public git history (F-05).** Disclosed and tracked in `.gitleaks.toml`;
   the value is reported rotated. The residual issue is that a public leak must be assumed
   compromised and the history has never been purged. **Documented in `SECRETS_TO_ROTATE.md`.**

---

## Findings

| ID | Category | Severity | Likely claimant | Legal theory | Evidence | Fix | Type |
|----|----------|----------|-----------------|--------------|----------|-----|------|
| F-01 | Communications | **High** | FTC / state AG / class | CAN-SPAM 15 U.S.C. §7704(a)(5): commercial email must contain a valid physical postal address | `src/free-alerts.js`, `src/followups.js`, `src/wallet-digest.js`, `src/monitor-scheduler.js` - unsubscribe present, address absent | Render a postal address in every email footer | Code + **needs address** |
| F-02 | Payments / stored value | **High** → resolved | State regulator (DFS/DFPI et al.) | Money transmission / stored value; prepaid access rules | `src/credits.js`; `/credits` | **Sales off by default (`CREDITS_SALES`).** No outside party ever bought; the one key was operator-funded and gifted, so nothing was held and nothing is owed. Redemption left working | Code |
| F-03 | AI output / financial | **Medium** | Individual / state AG | UDAP; investment adviser exposure where analysis reads as a recommendation | `dossier-kit.js`, `crypto-signals-kit.js`, `research-deep-kit.js`, `recall-report-kit.js` had none; `token-risk`, `token-brief`, `insider-flow`, `filing-watch` did | Add the same disclaimer used by the others | Content |
| F-04 | Third-party terms | **Medium** → resolved | Nasdaq (rights holder) | Breach of terms; CFAA-adjacent claims are weak post-*Van Buren* but contract is not | `src/tools/finance-kit.js`; `CLAUDE.md` records the terms are non-commercial | **Both tools and the relay removed.** Measured first: ~21 settlements each per 90 days, ~$0.10 revenue apiece | Code |
| F-05 | Security | **Medium** | N/A (exposure, not a claim) | Negligence if the credential were live | `.gitleaks.toml:46-52`, commit `70fcc517` | Confirm rotation; purge history | Documented |
| F-06 | Accessibility | **Medium** | Serial ADA plaintiff | ADA Title III; website accessibility | `/digest`: 6 form inputs with no `id` or `aria-label` | Label every input | Code |
| F-07 | Deceptive practices | **Low** | Competitor / FTC | FTC Act §5 if a claim outruns the code | Swept: "guaranteed" is the `guaranteedPaths` field, "risk-free" is the interest rate. No unsupported marketing absolutes found | None | No action |
| F-08 | Open source | **Low** | Downstream integrator | AGPL virality if an SDK were copyleft | Server is AGPL-3.0-or-later; all 14 published packages are MIT | Correct as-is | No action |
| F-09 | Security | **Low** | N/A | Vulnerable dependencies | `npm audit --omit=dev`: 0 across all severities | None | No action |
| F-10 | Privacy | **Low** | Individual / state AG | CCPA/GDPR disclosure mismatch | Privacy policy exists and was reconciled 2026-08-28; no third-party PII found in tracked files | Re-verify on each new data flow | Monitor |
| F-11 | Gambling / CFTC | **Low** | CFTC / state | Event-contract or gambling exposure | Kalshi/Polymarket tools **resell public market data**; the service offers no contracts, no positions, no payouts | None; do not add order placement | **Needs counsel if that ever changes** |
| F-12 | Corporate hygiene | **Low** | N/A | Missing contract terms | `/terms` carries entity name, warranty disclaimer, limitation of liability, arbitration, governing law | None | No action |

### Explicitly checked and clean
COPPA (no minor-directed content, no age collection) · fake reviews or counters (the one review
system is receipt-bound, one verdict per settlement, and publishes counts only) · auto-renewal
(subscriptions run through Stripe's portal with cancel exposed) · trademark or scraped card/league
art (no third-party marks or images in the tree) · fonts (Geist, OFL, `NOTICE` present) ·
secrets scan (gitleaks clean apart from the disclosed F-05) · `LICENSE`, `NOTICE`, `SECURITY.md`,
`CODE_OF_CONDUCT.md` all present.

### Deliberately not overstated
F-07 through F-12 are theoretical. I looked for the common filings - unsupported "secure" and
"guaranteed" claims, chance-based paid mechanics, scraped IP, missing license - and did not find
them. The three that matter are F-01, F-02 and F-04.


---

## Status after remediation (2026-09-20)

Fixed in `legal-risk-remediation`: **F-01** (postal address in every email, needs the value set),
**F-02** (credit sales off by default), **F-03** (advice disclaimers), **F-04** (Nasdaq tools
removed), **F-06** (form labels).

Still open: **F-05** - confirm the exposed credential is revoked, then decide whether a history
purge is worth what it costs (`SECRETS_TO_ROTATE.md`).

The operator has chosen not to retain counsel. Where a judgement call existed, the safer branch
was taken rather than the one that needed an opinion: the activity was stopped rather than
argued for. That is a defensible posture but it is not the same as advice, and any of these can
be revisited if counsel is ever engaged.
