# Tools, reports and integrations inventory

Derived from the **booted catalog** (`/api/pricing`, 595 entries) and the code, not from docs.
Entries are grouped by liability character rather than listed one by one: 595 rows individually
would obscure the distinction that matters, which is **which code paths move value or act on an
external system**.

**Date:** 2026-09-20 · **Operator:** Havok Holdings LLC

---

## Table 1 - Tools, by liability class

| Class | Count | Moves money? | Acts on an external system? | Autonomous? | Evidence |
|---|---|---|---|---|---|
| **Pays a third party from Havok's wallet** | 5 (`route-execute`, `-plus`, `-pro`, `-max`, and Blockscout's paid legs) | **YES - outbound** | Yes, pays external x402/MPP sellers | Yes, an agent can invoke it unattended | `src/tools/route-execute.js:408` (`payExternal`), gate `src/server.js:927` |
| **Writes to a public blockchain** | 1 (`attest`) | Spends gas only, moves no value | Yes, writes an EAS attestation on Base | Yes | `src/tools/attest-kit.js`; cap `ATTEST_MAX_GAS_USD` |
| **Takes/holds value from buyers** | credits (sales now gated OFF), Stripe card products | **YES - inbound** | Stripe, x402 facilitators | No, human checkout | `src/credits.js`, `src/human-checkout.js` |
| **Model-backed generated output** | 67 | No | LLM providers | Yes | `modelBacked` on every `/api/pricing` row |
| **Read-only third-party data** | ~430 | No | Yes, reads only | Yes | crypto 115, data 105, web 40, network 18 |
| **Pure compute, no egress** | ~90 | No | No | Yes | PoW-eligible set, `src/pow.js` |
| **Skill packs (compose the above)** | 85 | Inherit their steps | Inherit | Yes | `src/skills.js`, `src/tools/skill-runner.js` |

**The row that matters is the first one.** Everything else is a normal API business. Detail in
`FINAL_LIABILITY_AUDIT.md` F-13.

## Table 2 - Reports and generated outputs

| Output | Based on | Could someone act financially on it? | Disclaimer | Evidence |
|---|---|---|---|---|
| `dossier`, `ticker-pack` | SEC filings + XBRL + one LLM synthesis | **Yes** - company due-diligence | Added this pass | `src/tools/dossier-kit.js` |
| `research`, `market-brief` | Web search + page bodies + LLM | **Yes** | Added this pass | `src/tools/research-deep-kit.js` |
| `token-risk`, `token-brief` | On-chain probes + LLM | **Yes** - token risk | Pre-existing | `src/tools/token-risk-kit.js` |
| `insider-report`, `filing-report`, `fund-report` | EDGAR Forms 4/13F/periodic | **Yes** | Pre-existing | `src/tools/insider-flow-kit.js` |
| `crypto-indicators` | Public candles, deterministic math | **Yes** - reads as a trade signal | Added this pass | `src/tools/crypto-signals-kit.js` |
| `recall-report` | openFDA enforcement records | Health decisions, not financial | Added this pass | `src/tools/recall-report-kit.js` |
| `seller-dossier`, `seller-trust`, leaderboards | Our own crawl + chain reads | Commercial decisions about **named third parties** | None | `src/tools/seller-dossier.js` |
| `linkedin-article` | Research pipeline + image gen | Published under the buyer's name | None | `src/tools/linkedin-article-kit.js` |

## Table 3 - Integrations

| Integration | What leaves the system | Terms risk | Evidence |
|---|---|---|---|
| **Spending wallets** (Base, Solana, Algorand, Tempo) | Signed payments from Havok hot wallets | **The money-transmission question** | `X402_*_BUYER_KEY`, all four SET in prod |
| Stripe | Card data (Stripe-hosted), buyer email | Standard merchant terms | `src/human-checkout.js` |
| x402 facilitators (CDP, PayAI, Solvador, Naven, GoPlausible, self-hosted Stellar) | Payment payloads, payer addresses | Each has its own terms; unreviewed | `src/payments.js` |
| OpenRouter | **Buyer prompt content** | Buyer data to a third-party LLM router | `src/tools/llm-gateway-kit.js` |
| OpenAI | Prompts, audio, images | Same | `src/tools/llm-kit.js`, `stt-kit.js` |
| PostHog | Server telemetry (anonymous), browser events | Disclosed in privacy policy | `src/posthog.js` |
| Sentry | Error traces | Disclosed | privacy policy |
| ZeptoMail / Resend | Subscriber email addresses | Disclosed | `src/email.js` |
| Brave, CoinGecko, Alchemy, DefiLlama, Hyperliquid, Deribit, EDGAR, openFDA, FRED, NWS, DexScreener, RugCheck, Jupiter, Blockscout, GoPlus, X, Neynar/Warpcast | Query terms only | Per-provider; **only FRED and FEC were checked against primary terms this pass** | various kits |
| ~~Nasdaq~~ | - | **REMOVED this pass** (F-04) | - |

### What this inventory does NOT establish
Third-party terms were reviewed for **FRED, FEC and Nasdaq only**. The remaining ~18 data
providers are listed as integrations, not cleared. Each is an open question, not a finding.
