#!/usr/bin/env node
// Pay ONE outside x402 seller endpoint once with the CI burner and print what
// came back: status, the settle receipt, and the body. Built 2026-09-03 for the
// outreach kit (the seller's OpenAPI documents inputs but not outputs, and
// "request contracts runtimeVerified:false" was the research's own caveat):
// before a kit relays a seller's response, one real paid call shows its shape.
// Dispatch-only (.github/workflows/external-seller-probe.yml); never in CI.
//
//   BURNER_KEY=0x... PROBE_URL=https://seller/route PROBE_METHOD=POST \
//   PROBE_BODY='{"...":"..."}' PROBE_MAX_USD=0.01 node scripts/external-seller-probe.js
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const pk = (process.env.BURNER_KEY || "").trim();
const url = String(process.env.PROBE_URL || "").trim();
const method = String(process.env.PROBE_METHOD || "POST").toUpperCase();
const maxUsd = Number(process.env.PROBE_MAX_USD || 0.01);
if (!pk || !/^https:\/\//.test(url)) { console.error("need BURNER_KEY and an https PROBE_URL"); process.exit(2); }
let body;
if (process.env.PROBE_BODY) { try { body = JSON.parse(process.env.PROBE_BODY); } catch { console.error("PROBE_BODY is not JSON"); process.exit(2); } }

const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
const { x402Client, wrapFetchWithPayment } = await import("@x402/fetch");
const { registerExactEvmScheme } = await import("@x402/evm/exact/client");
const client = new x402Client();
registerExactEvmScheme(client, { signer: account });

// Refuse before signing when the seller's quote exceeds the cap: read the bare
// 402 first, and only then let the paying fetch retry.
const bare = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
console.log(`bare: HTTP ${bare.status}`);
if (bare.status !== 402) { console.log((await bare.text()).slice(0, 2000)); process.exit(bare.status === 200 ? 0 : 1); }
const pr = bare.headers.get("payment-required");
const accepts = pr ? JSON.parse(Buffer.from(pr, "base64").toString("utf8")).accepts : [];
const baseAccept = accepts.find((a) => a.network === "eip155:8453" && a.scheme === "exact");
if (!baseAccept) { console.error("no exact/eip155:8453 accept:", JSON.stringify(accepts).slice(0, 500)); process.exit(1); }
const quoteUsd = Number(baseAccept.amount) / 1e6;
console.log(`quote: $${quoteUsd} to ${baseAccept.payTo} (maxTimeoutSeconds ${baseAccept.maxTimeoutSeconds})`);
if (quoteUsd > maxUsd) { console.error(`quote $${quoteUsd} exceeds PROBE_MAX_USD ${maxUsd}; not paying`); process.exit(1); }

let receipt = null;
const payFetch = wrapFetchWithPayment(async (input, init) => {
  const res = await fetch(input, init);
  const rh = res.headers.get("payment-response");
  if (rh) { try { receipt = JSON.parse(Buffer.from(rh, "base64").toString("utf8")); } catch { /* keep null */ } }
  return res;
}, client);
const t0 = Date.now();
const res = await payFetch(url, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
const text = await res.text();
console.log(`paid: HTTP ${res.status} in ${Date.now() - t0} ms, content-type ${res.headers.get("content-type")}`);
console.log(`receipt: ${JSON.stringify(receipt)}`);
console.log("body:");
console.log(text.slice(0, 6000));
process.exit(res.status === 200 ? 0 : 1);
