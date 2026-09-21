# Site audit

Crawl of 72 routes (52 pages, 19 machine surfaces + sitemap) against live
production on 2026-09-21, plus every distinct internal link and same-page
anchor. Raw crawl and per-page evidence reproduced by
`scratchpad/crawl.mjs`.

**Headline: the structural problems are real and the link layer is clean.** No
404s, no broken anchors, no dead internal links. What is wrong is metric
labelling, repetition, and one figure the site did not need to publish.

## What I did not do, and why

This brief is a redesign. I did the parts that are **provably wrong** and
documented the parts that are **judgment calls about how the site should look**,
because doing those blind in one pass is how a redesign becomes a regression.
Specifically not attempted here: collapsing the six-dropdown nav, restructuring
the homepage section order, and introducing a new token system. Those need your
eye on a mock before they touch 52 pages. Everything under "Design / mobile"
below is findings, not diffs.

## Accuracy

| ID | Location | Issue | Fix | Status |
|---|---|---|---|---|
| A-1 | `market-page.js` stat card | `sellers.length` labelled **"endpoints indexed"**. `standing.js` calls the same figure "seller origins indexed" on `/revenue`, `/proof` and `/leaderboard`, so the site contradicted itself about what 4,287 counts. Sitting beside "3,320 distinct payees" made a wrong label read as a considered pair. | Relabelled "origins indexed" | **Fixed** |
| A-2 | `ledger-home.js` hero | `heroCount = settledOnChain \|\| viaUsdc` puts **two different quantities** under one label: inbound on-chain transfers, ours included (42,104 + Tempo) versus calls served for a stablecoin payment (35,138). Which one a visitor sees depends on whether the ledger has warmed since the last deploy. | Label follows the value | **Fixed** |
| A-3 | `ledger-home.js:257` | "Listening for on-chain payments…" is a widget's waiting state rendered as served copy | Replaced; empty state still never fabricates a 0 | **Fixed** |
| A-4 | `ledger-home.js:330` | `idle` rendered as human copy under a button | "ready" | **Fixed** |
| A-5 | `ledger-home.js:315` | "This is not a diagram - press the button" argues with a doubt the reader has not had | Removed | **Fixed** |
| A-6 | `/leaderboard` | 1,816 appears twice in one strip, as "sellers ranked" and "wallets queried". Probably the same population by construction, but it reads as a copy-paste and nothing says they are the same. | Not changed; needs a one-line clarification or a second figure | Open |
| A-7 | site-wide | "500+ tools" (static copy) vs "609" (runtime surfaces) | **No change, by design.** Runtime derives the exact count; static copy stays evergreen so adding a tool needs no doc sweep, and `sync-count.js --check` proves the claim in CI. Hardcoding 609 into copy is the failure this rule prevents. | Not a defect |

`METRICS_SOURCE.md` defines each metric once so these cannot drift again.

## Data exposure

| ID | Location | Issue | Fix | Status |
|---|---|---|---|---|
| D-1 | homepage seller section | Published the share of our own traffic that the router monetizes. A previous commit made it accurate; accurate was not the problem. It hands a competitor our monetization rate and answers a question no seller asked, on the page meant to persuade them. | Figure removed entirely. The architectural claim is kept and is checkable from any 402 on the site, which names the seller's own payTo. Pinned as an absence. | **Fixed** |
| D-2 | `/revenue` hero | Lifetime external revenue headlined as an absolute | **Not changed.** CLAUDE.md records an explicit operator decision (2026-09-01) to lead with counts and never remove the revenue split. Reversing that is your call, not mine to make silently. | Needs your decision |
| D-3 | `/revenue` hero | Buyer concentration ("top 5 = N% of their payments") and exact distinct-buyer counts | **Not changed**, same reason: the code comment beside it argues a buyer count means nothing without concentration. Flagged so the choice is explicit. | Needs your decision |
| D-4 | `/leaderboard` | Other sellers' revenue, calls and buyers, named | **Already correct.** Factual, sourced to on-chain data, host excluded from its own ranking, and a correction path exists on both leaderboards and (since this week) in the `/api/index` legend and the marketplace FAQ. | No action |

## Privacy and identity

| ID | Location | Issue | Status |
|---|---|---|---|
| P-1 | 91 sites across 43 modules | Public source link spelled out a URL containing a personal account name, including six `Organization` JSON-LD `sameAs` blocks, which is exactly what a search engine reads to join an entity to an account | **Code half fixed** (merged): all 91 read `src/repo-link.js`, `AGENT402_REPO_URL` overrides. **Owner half open:** move the repo to an org, then set the variable. |
| P-2 | 402 challenges on `route-execute*` | The SOR spending wallet's address is published as the Base payTo | **Cannot be hidden.** A payTo must be published to be paid; this is the self-funding loop. Mitigation is the balance, not the address. See `WALLET_ISOLATION_PLAN.md`. |
| P-3 | `/api/revenue`, 12 machine surfaces | Swept for the live Alchemy key by literal value, plus the tree and every revision of history. Absent from all, control included. | Clean |
| P-4 | `/company` JSON-LD | `duns` + `addressRegion` | Business record, publicly searchable, correct entity. No action. |
| P-5 | `enrich-kit.js` | This repository is the documented example input for the `github-repo` tool, so the handle reaches `/openapi.json` and `/llms.txt` | Exempted with a reason in `test-repo-link.js`; the CI example check drives it live, so changing it changes a published example. Revisit when the repo moves. |

## Links and structure

| ID | Finding |
|---|---|
| L-1 | **No 404s.** All 72 routes return 200. |
| L-2 | **No broken same-page anchors** across 52 pages. |
| L-3 | **No dead internal links** among 61 distinct non-templated paths probed. |
| L-4 | `/sell#add` is named in the brief. It does not exist **and nothing links to it**, so there is nothing to fix. |
| L-5 | Heading level skips (h1 to h3) on `/reports`, `/monitors`, `/quickstart`. Cosmetic for sighted users, real for screen readers. Open. |
| L-6 | `/what-is-x402` reported as missing an h1 by my first crawl. **False positive in my crawler** (a 90-character cap on heading content, and that h1 has nested markup). The h1 is present. Recorded so the next reader does not re-chase it. |
| L-7 | A "TODO/placeholder" sweep matched 28 pages. **All false positives**: HTML `placeholder` attributes on form inputs. No leftover or debug text found anywhere. |

## Minimalism

| ID | Finding | Recommendation |
|---|---|---|
| M-1 | The 12-chain strip with per-chain seller and tool counts renders on **every page** via the nav dropdown, about 1.4 KB of duplicated content site-wide | Show it richly on `/marketplace` and the chain pages; reduce the nav to chain names without counts. Not done: touches the shared nav on 52 pages. |
| M-2 | Six dense dropdowns in the top nav | Group to a small top-level set, long tail to the footer. Not done: needs a mock. |
| M-3 | The `$ GET /…` eyebrow motif appears 5 times on the homepage (the brief estimated 8) | Keep two, at the agent-facing moments. Not done: part of the homepage restructure. |
| M-4 | Homepage inlines per-rail breakdowns, bestseller lanes and a long FAQ that each have their own page | Progressive disclosure. Not done: same reason. |

## Agent surfaces

Verified consistent and unchanged: `llms.txt`, `openapi.json`,
`.well-known/x402`, `/api/pricing`, `robots.txt`, `sitemap.xml` (1,059 URLs),
`.well-known/glama.json`, `.well-known/agent-registration.json`, the MCP
connector. All 200, all correct content types. The dual human/agent framing is
intact. **No agent surface was touched by this work**, which was deliberate:
they are the strongest part of the property.

## Design and mobile

Not attempted, and I would rather say so than ship a half-done token system.
What a review should cover next, in priority order:

1. One responsive nav. The brief reports a duplicated mobile block rendering
   alongside the desktop nav; worth confirming against a real device before
   restructuring.
2. Tabular numerals everywhere a figure appears. Some surfaces already set
   `font-variant-numeric: tabular-nums`, not all.
3. Tables that reflow or scroll cleanly. The homepage leaderboard already sits
   in a keyboard-reachable horizontal scroller; the rail tables on `/revenue`
   and the roster on `/marketplace` need the same check.
4. `prefers-reduced-motion` on the live counter and any transitions added.
5. Contrast and focus states, which have existing guards
   (`test-faint-contrast`, `test-focus-visible`) currently unrunnable locally
   for want of Chromium.
