// Buyer usage report — the wallet IS the identity, exactly like the memory
// tools: there is no wallet parameter, no API key, no account. The buyer pays
// for the report via x402 with an EIP-3009 authorization, and the response
// covers the purchase history of the wallet that SIGNED that payment
// (payerFromRequest — the cryptographically verified field, never a loose
// body/header claim). Nobody can browse another wallet's purchase profile:
// the only way to unlock a report is to spend from the wallet it describes.
//
// SVM/Stellar payments carry no signed payer the server can verify, so they
// get a self-explaining 400 instead of a report.
import { payerFromRequest } from "../payer.js";
import { payerUsage } from "../sales-ledger.js";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export const USAGE_TOOLS = [
  {
    route: "POST /api/my-usage",
    name: "My usage (wallet-keyed purchase history)",
    slug: "my-usage",
    category: "payments",
    price: "$0.005",
    description:
      "Your own purchase history, keyed to the wallet that pays for the call — no wallet parameter, no signup: the x402 payment IS the identity, so nobody can read another wallet's profile. Returns totals, per-tool counts, per-chain breakdown, and recent receipts with settle tx hashes (independently verifiable on-chain). Requires an EIP-3009 payment (USDC on Base, Polygon, or Arbitrum); Solana/Stellar payments carry no signed payer the server can verify.",
    tags: ["usage", "receipts", "billing", "audit", "wallet", "x402", "history"],
    discovery: {
      bodyType: "json",
      input: { days: 30 },
      inputSchema: {
        properties: {
          days: { type: "number", description: "Aggregation window in days, 1-365 (default 30). The recent list is always the latest rows regardless." },
          limit: { type: "number", description: "Max recent receipts to return, 1-200 (default 50)" },
        },
        required: [],
      },
      output: {
        example: {
          wallet: "0x902dcf34e53695bdea2ffb354b1a2e58bd598256",
          days: 30,
          persistent: true,
          totals: { calls: 42, paidUsd: 1.234, firstAt: "2026-07-01T00:00:00.000Z", lastAt: "2026-07-09T00:00:00.000Z" },
          byNetwork: { base: { calls: 40, usd: 1.2 }, polygon: { calls: 2, usd: 0.034 } },
          bySlug: [{ slug: "hash", calls: 12, usd: 0.012, lastAt: "2026-07-09T00:00:00.000Z" }],
          recent: [{ at: "2026-07-09T00:00:00.000Z", slug: "hash", priceUsd: 0.001, network: "base", tx: "0x…" }],
          note: "Every USDC row keeps its settle tx — verifiable on-chain.",
        },
      },
    },
    handler: async (input, req) => {
      const wallet = payerFromRequest(req);
      if (!wallet) {
        throw bad(
          "This report is keyed to the wallet that PAYS for it. Pay via x402 with an EIP-3009 authorization (USDC on Base, Polygon, or Arbitrum) and the response covers that wallet's history. Solana/Stellar payments carry no signed payer the server can verify, so they cannot unlock a report."
        );
      }
      const days = input?.days === undefined ? 30 : parseInt(input.days, 10);
      if (Number.isNaN(days) || days < 1 || days > 365) throw bad('"days" must be an integer between 1 and 365 (default 30)');
      const limit = input?.limit === undefined ? 50 : parseInt(input.limit, 10);
      if (Number.isNaN(limit) || limit < 1 || limit > 200) throw bad('"limit" must be an integer between 1 and 200 (default 50)');
      return payerUsage(wallet, { days, limit });
    },
  },
];
