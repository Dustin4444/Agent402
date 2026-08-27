#!/usr/bin/env node
// LIVE proof of agent402-agentkit against production: a real AgentKit wallet
// provider (ViemWalletProvider over the canary burner on Base mainnet) drives
// agent402_find, then agent402_call on a wallet-only tool, which must pay a
// real x402 USDC micropayment and return the tool's result. Asserts the
// settled PAYMENT-RESPONSE receipt (success, payer = burner, tx hash) captured
// from the paid retry. Dispatch-only (.github/workflows/agentkit-live.yml).
// Run from a scratch dir where @coinbase/agentkit and agent402-agentkit are
// installed (the workflow does that); AGENTKIT_ADAPTER points at the adapter.
import { createHmac } from "node:crypto";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const TARGET = process.env.TARGET_URL || "https://agent402.tools";
const pk = (process.env.BURNER_KEY || "").trim();
if (!pk) { console.error("need BURNER_KEY"); process.exit(2); }
// AgentKit phones home when a wallet provider is constructed
// (dist/analytics/sendAnalyticsEvent.js) and throws on a non-2xx from its
// endpoint as an UNHANDLED rejection (measured 2026-08-27: HTTP 400 killed the
// run before any Agent402 call). Their telemetry must not decide our proof.
process.on("unhandledRejection", (e) => console.warn("ignored unhandled rejection (third-party):", String(e?.message || e).slice(0, 120)));
const { ViemWalletProvider } = await import("@coinbase/agentkit");
const { agent402Actions } = await import(process.env.AGENTKIT_ADAPTER || "agent402-agentkit");

const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
const walletProvider = new ViemWalletProvider(createWalletClient({ account, chain: base, transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org") }));

// Mark the buy as internal (heartbeat token, minute-scoped HMAC) exactly like
// the paid canary, so the sales ledger files it as ours; capture the receipt.
const secret = (process.env.POW_SECRET || "").trim();
let lastReceipt = null, paidRetries = 0;
const fetchImpl = async (input, init) => {
  const req = new Request(input, init);
  if (secret) req.headers.set("X-Heartbeat-Token", createHmac("sha256", secret).update(`heartbeat:${Math.floor(Date.now() / 60_000)}`).digest("base64url").slice(0, 32));
  if (req.headers.get("payment-signature") || req.headers.get("x-payment")) paidRetries++;
  const res = await fetch(req);
  const rh = res.headers.get("payment-response");
  if (rh) { try { lastReceipt = JSON.parse(Buffer.from(rh, "base64").toString("utf8")); } catch { /* keep null */ } }
  return res;
};

const [find, call, about] = await agent402Actions({ baseUrl: TARGET, fetchImpl, maxPerCallUsd: 0.01 });
const ab = JSON.parse(await about.invoke(about.schema.parse({})));
console.log("about:", ab.tools, "tools,", ab.freeTier, "free-tier");
const found = JSON.parse(await find.invoke(find.schema.parse({ task: "geolocate an IP address", k: 5 })));
const row = found.results.find((r) => r.slug === "ip-info");
console.log("find:", found.results.map((r) => `${r.slug} ${r.price}${r.walletRequired ? " (wallet)" : ""}`).join(", "));
if (!row) { console.error("agent402_find did not surface ip-info"); process.exit(1); }
const params = row.example && typeof row.example === "object" ? row.example : { ip: "8.8.8.8" };
const out = JSON.parse(await call.invoke(walletProvider, call.schema.parse({ slug: "ip-info", params })));
console.log("call:", JSON.stringify(out).slice(0, 200));
console.log("receipt:", JSON.stringify(lastReceipt), "paid retries:", paidRetries);
const ok = out && typeof out === "object" && !out.error && paidRetries >= 1 && lastReceipt?.success === true
  && /^0x[0-9a-f]{64}$/i.test(lastReceipt?.transaction || "") && String(lastReceipt?.payer || "").toLowerCase() === account.address.toLowerCase();
if (ok) console.log(`PROVEN: agent402_call paid ${row.price} over x402 from an AgentKit ViemWalletProvider, tx https://basescan.org/tx/${lastReceipt.transaction}`);
else console.error("NOT PROVEN");
process.exit(ok ? 0 : 1);
