// An Express API that AI agents pay for, with every payment settling into a
// Coinbase Business account. The tollbooth gates the routes (humans free,
// agents pay), @x402/express verifies + settles through Coinbase's facilitator,
// and the payTo is the account's USDC receive address on Base.
import express from "express";
import { createTollbooth } from "agent402-tollbooth";
import { paymentMiddleware } from "@x402/express";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createFacilitatorConfig } from "@coinbase/x402";

const PAY_TO = process.env.COINBASE_BUSINESS_ADDRESS;
const { CDP_API_KEY_ID, CDP_API_KEY_SECRET } = process.env;
if (!PAY_TO || !CDP_API_KEY_ID || !CDP_API_KEY_SECRET) {
  console.error("Set COINBASE_BUSINESS_ADDRESS, CDP_API_KEY_ID and CDP_API_KEY_SECRET (see .env.example)");
  process.exit(1);
}

// Coinbase's facilitator: verify + settle on Base, fee-free, Bazaar-indexed.
const facilitator = new HTTPFacilitatorClient(createFacilitatorConfig(CDP_API_KEY_ID, CDP_API_KEY_SECRET));
const server = new x402ResourceServer(facilitator).register("eip155:8453", new ExactEvmScheme());

// Price per route. Anything not listed here is free.
const x402 = paymentMiddleware(
  {
    "GET /api/quote": { accepts: [{ scheme: "exact", network: "eip155:8453", payTo: PAY_TO, price: "$0.005" }] },
    "POST /api/summarize": { accepts: [{ scheme: "exact", network: "eip155:8453", payTo: PAY_TO, price: "$0.02" }] },
  },
  server
);

const app = express();
app.use(express.json());
// The gate: known AI crawlers and x402/MPP clients pay; browsers pass.
// mode: "all" would charge every caller instead.
app.use(createTollbooth({ x402 }));

app.get("/api/quote", (_req, res) => res.json({ symbol: "EXAMPLE", price: 42.0, asOf: new Date().toISOString() }));
app.post("/api/summarize", (req, res) => {
  const text = String(req.body?.text || "");
  res.json({ words: text.split(/\s+/).filter(Boolean).length, summary: text.slice(0, 120) });
});

const port = Number(process.env.PORT || 8080);
app.listen(port, () => console.log(`paid API on :${port}; payments settle to ${PAY_TO} via Coinbase's facilitator`));
