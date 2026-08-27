# Get paid by AI agents into a Coinbase Business account

`agent402-tollbooth` in front of an Express API, settling every x402 payment
through Coinbase's facilitator into a Coinbase Business account's USDC (Base)
receive address. Humans browse normally; agents and crawlers pay $0.005 per call.

Guide: https://agent402.tools/guides/coinbase-business-get-paid-by-agents

## Run

```bash
npm install
cp .env.example .env   # fill in the three values
node server.js
```

- `COINBASE_BUSINESS_ADDRESS` - the account's USDC receive address on Base (this is the `payTo` on every 402)
- `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` - a Coinbase Developer Platform API key; the tollbooth signs facilitator calls with it

Then, from any x402 client, `GET http://localhost:8080/api/quote` answers 402
with the USDC quote; a paid retry is served and settles into the account. The
same thing with no code at all:

```bash
TOLLBOOTH_PAYTO=$COINBASE_BUSINESS_ADDRESS TOLLBOOTH_CDP_API_KEY_ID=... TOLLBOOTH_CDP_API_KEY_SECRET=... \
TOLLBOOTH_PRICE='$0.005' TOLLBOOTH_UPSTREAM=http://localhost:9000 npx agent402-tollbooth
```
