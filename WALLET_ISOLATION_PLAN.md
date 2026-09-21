# Wallet isolation: what should and should not be published

Companion to `REVENUE_PAGE_EXPOSURE.md` (F-3, F-7). The constraint throughout is
that "verify us on-chain" has to stay true, so every address a reader needs in
order to check a published figure stays published.

## What exists today

| Wallet | Role | Key lives | Published? | Balance readable? |
|--------|------|-----------|-----------|-------------------|
| `WALLET_ADDRESS` `0xaBF4…a9D0` | Receives on 9 EVM chains, and holds the float | Owner's wallet only | Yes, and correctly: it is the payTo on almost every 402 | Yes |
| Solana / Stellar / Algorand payTo | Receive on their rails | Owner's wallet only | Yes, correctly | Yes |
| `X402_UPSTREAM_BUYER_KEY` `0x7706…4121` | **Autonomous spend** on Base, and receives the Base leg of `route-execute*` | Railway env | Yes: it is the payTo on four tiers' 402s | Yes |
| `ALGORAND_UPSTREAM_BUYER_ADDRESS` `W4GZ…67UOE` | Same, Algorand | Railway env | Yes, same reason | Yes |
| `SOLANA_UPSTREAM_BUYER_KEY` | Autonomous spend, Solana | Railway env | Only as a payer in its own transactions | Yes, by anyone who finds it |
| `TEMPO_UPSTREAM_BUYER_KEY` `0xaF13…D5A6` | Autonomous spend, Tempo/MPP | Railway env | Same | Same |
| `TEMPO_SUBSCRIPTION_FEE_PAYER_KEY` `0x130C…F30D` | Sponsors subscription gas | Railway env | Same | Same |
| Stellar facilitator signer | Pays Stellar settlement fees | Separate service | On `/health` of that service | Yes |
| CI canary burners | Test buys | GitHub Actions only | Yes, in `OUR_*_WALLETS` in source | Yes |

Keys are already separated correctly. Every spending wallet has its own key,
none is the treasury, and none is a CI burner. **The gap is not key separation.
It is that balances and relationships are all readable, and one of the
readable addresses holds everything.**

## The three things worth changing

### 1. The treasury holds the float. It should not.

`0xaBF4…a9D0` is both the receive address and the reserve. Publishing it is
required: it is the payTo, and a reader checking `/revenue` needs to see
settlements arriving somewhere. Publishing the **reserve** is not required by
anything.

Split them:

- `WALLET_ADDRESS` keeps receiving, stays published, keeps a small working
  balance.
- A **cold reserve** address, never published, never a payTo, never in
  `OUR_WALLETS`, receives a periodic manual sweep from the receive address.
- Every figure on `/revenue` still reconciles, because the figures are built
  from **inbound transfers to the receive address**, not from its balance. The
  one number that changes meaning is `totalUsd`, which is a balance sum and is
  already labelled as including our own test money; it becomes "what is on the
  rails right now", which is a more honest thing for it to be anyway.

Cost: one address, one periodic transaction. No code change beyond wherever
`totalUsd` is described.

### 2. The hot wallets should hold days, not months.

They are published (F-3) and cannot be unpublished, so the defence is the
balance, not the address. The self-funding loop already helps: buyers top the
Base wallet up as they pay, so it does not need a large float to keep working.

- Set a target working balance of roughly a week of external spend, and sweep
  the excess to the reserve. `scripts/sweep-burner.js` already does the sweep.
- `SOR_WALLET_DAILY_MAX_USD` (default $25 per chain) is the loss ceiling for a
  compromised **router**; the balance is the ceiling for a compromised **key**.
  Those are different attacks and need both bounds.
- The existing low-water alarms page for a top-up, so a small float does not
  turn into an outage.

### 3. Future spending wallets should not be linkable to the treasury.

The existing ones are, through the sweep transactions, and that cannot be
undone for history. It can be avoided going forward: sweep a new spending
wallet to the **reserve**, never to the published receive address, so a reader
of the 402 learns the hot address and nothing about what sits behind it.

## What must stay published

- Every receive address that appears as a payTo. Withholding one would break
  the only claim this page makes.
- Every settlement transaction hash. This is the verification primitive; the
  payer address is derivable from it, which is why removing the `from` field
  would be cosmetic rather than protective (F-4).
- The rail-by-rail inbound counts and external dollars.

## What should not be published, and is not

- Any private key, mnemonic or keystore. Confirmed absent from the tree, from
  `src/`, from client-shipped code and from git history.
- The spending wallets' **balances**, on our own surfaces. `/api/revenue` shows
  the treasury per rail. `/api/gateway-status` reports the spending wallets as
  bucketed status words (`ok` / `low` / `unknown`) and never a number, which is
  the right pattern and should be kept for any wallet added later.
- Buyer addresses on `/api/revenue/daily`. Counts only, with the reasoning
  already written beside the code.
- Itemized MPP settlement rows. Operator-gated.

## Explicitly not recommended

- **Hiding the spending wallet's payTo.** It has to be published to be paid.
  The self-funding loop is what removed a recurring manual top-up and a one-way
  drain; unwinding it to hide an address that a single 402 request reveals would
  cost real operational reliability for no privacy.
- **Rotating the treasury address.** Every historical settlement points at it,
  the leaderboards and third-party indexers key on it, and the linkage it would
  break is already public. The cost is high and the benefit is zero.
- **Removing `from` from the recent-transfer feed.** One click from the tx hash
  published beside it. Bounded by the rate limit instead.
