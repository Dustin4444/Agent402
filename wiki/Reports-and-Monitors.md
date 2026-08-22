# Reports, Monitors and Credits

> **Payment wires:** every paid endpoint accepts **x402** and **MPP** (Machine Payments Protocol) on the same 402 - see [[Paying with x402]] and [[Paying with MPP]]. Agent402 is the applied layer of [[Agentic Finance]]: agents that pay and get paid on their own.

Beside the 500+ per-call tools, Agent402 sells **outcome-priced report products** (one payment, one finished report), **monthly monitors** that re-run a report when something changes, and **prepaid card credits** that let a buyer without a wallet spend on every tool. The same report endpoint serves two front doors:

- **Agents** call the `/v1/...` route directly and pay on the 402 - USDC over x402 or MPP, or a prepaid credits key.
- **People** buy the same report by card at [`/reports`](https://agent402.tools/reports), subscribe to a monitor at [`/monitors`](https://agent402.tools/monitors), or load credits at [`/credits`](https://agent402.tools/credits).

All of it is optional and env-gated on a self-hosted instance (see [[Self-Hosting]]); without the Stripe keys the `/v1` report routes still sell over x402 / MPP, and the card pages simply are not mounted.

## Report products (agent path)

Each report is a `POST` with a JSON body; the price is the whole outcome, not a per-call meter. The evidence stage is deterministic (live web search, SEC EDGAR, openFDA, DNS/TLS probes, on-chain reads), and the synthesis stage writes a cited report that is checked against the evidence it was given; the IPO digest has no synthesis stage at all. A run that cannot gather enough evidence fails with an error instead of shipping a thin report, and because settlement happens **after** the handler, an error is never charged (see [[Architecture]]).

| Route | Price | Input | What you get |
|---|---|---|---|
| `POST /v1/research` | $5 | `{ query, focus?, recency?, format? }` | Deep research report: sub-questions planned, multiple live web searches, sources reranked, a ~1,500-word report with inline `[n]` citations and a source list |
| `POST /v1/research/pro` | $15 | same | Deeper tier: more sub-questions and searches, wider source set, ~2,200 words |
| `POST /v1/research/max` | $30 | same | Exhaustive tier, ~2,800 words |
| `POST /v1/research/market-brief` | $15 | `{ query }` | Market / competitor brief on a category or company, same pipeline with a competitive-intelligence frame |
| `POST /v1/dossier` | $19 | `{ ticker, focus?, format? }` | Company due-diligence dossier: SEC EDGAR filings (10-K / 10-Q / 8-K), Form 4 filing metadata, a live quote and grounded web research, ~2,400 words |
| `POST /v1/dossier/max` | $39 | same | More filings, a full year of Form 4 activity, wider research, ~2,800 words with a full source table |
| `POST /v1/fund` | $9 | `{ manager \| cik \| ticker, format? }` | 13F portfolio report: what the manager holds and what they bought, added, trimmed and exited last quarter, diffed from their two most recent 13F-HR filings, with a holdings appendix |
| `POST /v1/fund/max` | $19 | same | Full holdings table, wider change analysis, longer report |
| `POST /v1/domain-audit` | $5 | `{ domain, format? }` | Graded domain security and email-deliverability audit: SPF, DMARC, DKIM, MX, security headers, TLS, each from a live probe, with a letter grade and a prioritized fix list |
| `POST /v1/domain-audit/pro` | $9 | same | Plus attack surface from Certificate Transparency logs, detected tech stack and registration data |
| `POST /v1/recall-report` | $5 | `{ query, scope? }` | FDA recall report across the drug, food and device enforcement feeds (openFDA): firm, class, status, reason, distribution, date, with a records appendix |
| `POST /v1/insider-report` | $9 | `{ ticker \| cik, days? }` | Insider flow: every Form 4 in the window with the transactions parsed from the filings, open-market buys and sells separated from awards, exercises and withholding, per insider and net |
| `POST /v1/token-risk` | $5 | `{ address, chain, format? }` | Token and contract risk report from on-chain evidence: source verification, holder concentration (pools and contracts told apart from wallets), supply and market context. Evidence, never a "safe" verdict |
| `POST /v1/token-risk/pro` | $12 | same | Plus a deterministic static-pattern scan of the verified source and a web reputation check |
| `POST /v1/ipo-report` | $0.05 | `{ days?, keyword? }` | Deterministic IPO pipeline digest: every 424B4 (priced) and S-1 (registering) on SEC EDGAR in the window, optional keyword filter on the filer's name. No synthesis, filing facts only |

Every report route is wallet-only (no proof-of-work tier) and is listed in [`/api/pricing`](https://agent402.tools/api/pricing), `/openapi.json` and on its own `/tools/{slug}` page with a sample output. They are not cached: each call is a fresh run.

```bash
# Any x402 or MPP client pays the 402 the same way it pays a $0.001 tool;
# a prepaid credits key pays it with one header.
curl -X POST https://agent402.tools/v1/domain-audit \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer a402_…' \
  -d '{"domain":"example.com"}'
```

Over the MCP connector, `catalog.find` resolves a task like "audit example.com's email security" to the report slug and `catalog.call` runs it; the hosted connector can be paid over MPP right in the call (see [[MCP Connector]]).

## Reports for people (`/reports`)

[`/reports`](https://agent402.tools/reports) sells the same products by card through Stripe Checkout: pick a product, type the input (a question, a ticker, a fund, a domain, a recall term), pay, and the report renders at a private link `/r/<session>` (also emailed when the instance has email configured). Listed there: research ($5 / $15 / $30), market brief ($15), dossier ($19 / $39), fund report ($9 / $19), domain audit ($5 / $9), FDA recall report ($5) and insider flow report ($9). The token-risk and IPO reports are agent-facing routes and are not on the card page.

Guarantees enforced in code rather than promised in copy:

- No report is generated without a Stripe-verified paid session, and a session generates **once** (reloading the page re-serves the same report).
- A run that fails is **refunded automatically**; a refund that could not be issued is recorded as owed and retried, never reported as done.
- Report pages are private links (`noindex`, no listing anywhere); the link is the bearer.

## Monitors (`/monitors`, $9 per month each)

A monitor is a Stripe subscription that keeps one report fresh for one target. The scheduler (`src/monitor-scheduler.js`) does a cheap, free check on a cadence and spends a full paid run only when the cadence says so or something actually changed, then emails a durable report link (`/m/<id>`).

| Monitor | Target | Cadence |
|---|---|---|
| Domain security monitor (`domain-monitor`) | a domain | Welcome audit on first sight; a free daily re-probe of the same checks the paid audit grades; a full re-audit and alert email on a change (grade, SPF/DMARC/DKIM/MX, header set), when the certificate is inside 14 days of expiry (once per certificate), or every 30 days |
| Fund 13F watch (`fund-monitor`) | a fund name, ticker or CIK | Daily check of the manager's latest 13F-HR accession on EDGAR; a full holdings + changes report only when a new filing lands |
| FDA recall watch (`recall-monitor`) | a drug, food, brand or device | Daily probe of the drug, food and device recall feeds; a fresh cited report the moment a new recall number appears |
| Insider flow watch (`insider-monitor`) | a US ticker | Daily probe for new Form 4 filings; a fresh insider-flow report on each new accession |
| IPO pipeline watch (`ipo-monitor`) | a keyword, or `all` | Weekly digest of priced IPOs (424B4) and new S-1s; no email on an empty week |

Operational bounds: a target is validated at checkout (the domain must parse, the manager must resolve on EDGAR); paid re-runs are capped per subscription per 30 days (alerts keep coming); a failing run backs off (1h doubling to 24h) and never sends an email, and a target that keeps failing tells the subscriber once. Billing is Stripe's recurring invoice and the Customer Portal (the manage link in every monitor email) cancels or updates it; subscription status is re-read from Stripe before every paid run, so a canceled monitor stops being fulfilled.

## Prepaid credits (`/credits`)

For buyers with a card and no wallet: load **$20, $50 or $100** at [`/credits`](https://agent402.tools/credits), claim the key once on the thanks page (it is also emailed; a second claim returns `claimed`, never the key again), then spend it on **any priced catalog route**:

```bash
curl -H 'Authorization: Bearer a402_…' 'https://agent402.tools/api/whois?domain=example.com'
# 200 … X-Credits-Balance: 19.999   (list price held before the call, debited only on a final 200)
```

- **Debited only on success.** The gate holds the list price before the handler runs and converts the hold to a debit only when the final response is `200`; any error, client abort or settlement failure releases it. Amounts are exact to the micro-dollar, so a $0.001 tool costs exactly $0.001.
- **Credits never expire**, and `GET /api/credits/balance` (same header) returns the remaining balance. An insufficient or unknown key answers `402` with `{ reason, balanceUsd, topup }`.
- **Identity-bound tools refuse credits.** The memory tools and `my-usage` use the payer's signed wallet as identity; a credits key carries no verified wallet, so those routes answer `402` with `reason: "identity-bound"` and must be paid over an x402 rail.
- Keys are stored hashed; a refund or dispute on the purchase disables the key.
- **In the SDKs:** `agent402-mcp` 0.13.0 reads `AGENT402_CREDITS_KEY` and pays wallet-only tools through it; `agent402-client` 0.7.0 accepts `{ creditsKey }`. Both keep their per-call and budget caps in front of the key.

Credits are the card-native equivalent of a wallet for the long tail; the report products above accept them too.

## How this fits the rest

| | Per-call tools | Report products | Monitors |
|---|---|---|---|
| Price | $0.001 and up per call | $5 to $39 per report ($0.05 for the IPO digest) | $9 per month per target |
| Pay with | x402, MPP, proof-of-work (pure-CPU), credits | x402, MPP, credits, or card at `/reports` | card subscription at `/monitors` |
| Who | agents | agents and people | people (agents call the underlying report directly) |
| Serving path | deterministic, no language model | deterministic evidence + grounded synthesis (IPO digest: deterministic only) | the same report kits on a schedule |

Related: [[Tool Catalog]] · [[Paying with x402]] · [[Paying with MPP]] · [[MCP Connector]] · [[Self-Hosting]] (the env that enables the card paths).
