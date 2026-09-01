#!/usr/bin/env node
// LIVE proof of the Solana spending wallet: a buyer pays US on Solana for a
// task that resolves to an EXTERNAL Solana seller, and route-and-execute pays
// that seller from SOLANA_UPSTREAM_BUYER_KEY's wallet and relays the result.
// Chain-matched (a Solana buyer reaches Solana sellers), real money both legs:
// the canary burner pays our route price, the spending wallet pays the seller.
// Asserts: a solana accept on the 402, a 200 with receipt.external === true,
// settleNetwork = mainnet CAIP-2, the payload delivered, and the spending
// wallet's USDC balance dropping by at least the seller's price.
// Dispatch-only (solana-sor-live.yml). A 404/409 from the router (no candidate
// cleared the pay-time proven-seller gate) exits 1 with the router's own words
// - that is a truthful "not proven yet", not a harness failure.
const TARGET = (process.env.TARGET_URL || "https://agent402.tools").replace(/\/+$/, "");
const RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SPENDER = process.env.SOLANA_SPENDING_ADDRESS || "8KqQG8MefNvQEQmp9gBjov39DXcWsUpSeqjL9pPCGKKE";
const ROUTE_ALLOWED = new Set(["/api/route/execute", "/api/route/execute-plus", "/api/route/execute-pro"]);
const ROUTE = process.env.ROUTE || "/api/route/execute";
if (!ROUTE_ALLOWED.has(ROUTE)) { console.error(`refusing ROUTE=${JSON.stringify(ROUTE)}: not one of ${[...ROUTE_ALLOWED].join(", ")}`); process.exit(2); }
const TASK = process.env.TASK || "list supported rpc chains";
const PARAMS = process.env.PARAMS ? JSON.parse(process.env.PARAMS) : {};
const EXPECT_TEXT = process.env.EXPECT_TEXT || "solana";
import { createHmac } from "node:crypto";
const raw = (process.env.SOLANA_BURNER_KEY || "").trim();
if (!raw) { console.error("need SOLANA_BURNER_KEY"); process.exit(2); }

const rpc = async (method, params) => {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result;
};
const usdcOf = async (owner) => {
  const res = await rpc("getTokenAccountsByOwner", [owner, { mint: USDC_MINT }, { encoding: "jsonParsed" }]).catch(() => null);
  return res ? Number(res?.value?.[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0) : null;
};
const secret = (process.env.POW_SECRET || "").trim();
const hb = () => secret ? { "X-Heartbeat-Token": createHmac("sha256", secret).update(`heartbeat:${Math.floor(Date.now() / 60_000)}`).digest("base64url").slice(0, 32) } : {};

const [{ x402Client }, { registerExactSvmScheme }, { wrapFetchWithPayment }, kit] = await Promise.all([
  import("@x402/core/client"), import("@x402/svm/exact/client"), import("@x402/fetch"), import("@solana/kit"),
]);
const bytes = raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : new Uint8Array(kit.getBase58Encoder().encode(raw));
const signer = await kit.createKeyPairSignerFromBytes(bytes);
console.log(`buyer (burner): ${signer.address}`);
const before = await usdcOf(SPENDER);
console.log(`spending wallet ${SPENDER} USDC before: ${before}`);

const synthFetch = (u, init = {}) => fetch(u, { ...init, headers: { ...(init.headers || {}), ...hb() } });
const pay = wrapFetchWithPayment(synthFetch, registerExactSvmScheme(new x402Client(), { signer }));
const url = `${TARGET}${ROUTE}`;
if (new URL(url).origin !== new URL(TARGET).origin) { console.error("refusing: target origin changed"); process.exit(2); }
const body = JSON.stringify({ task: TASK, include: "external", params: PARAMS });

// Sight check first: the bare 402 must OFFER solana, or nothing below means anything.
const bare = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...hb() }, body });
const prHdr = bare.headers.get("payment-required") || "";
let offersSolana = false;
try { offersSolana = JSON.parse(Buffer.from(prHdr, "base64").toString("utf8")).accepts.some((a) => String(a.network || "").startsWith("solana:")); } catch { /* checked below */ }
console.log("bare:", bare.status, "solana accept offered:", offersSolana);
if (bare.status !== 402 || !offersSolana) { console.error("NOT PROVEN: the route's 402 offers no solana accept"); process.exit(1); }

const paid = await pay(url, { method: "POST", headers: { "content-type": "application/json" }, body });
const out = await paid.json().catch(() => ({}));
console.log("paid:", paid.status, JSON.stringify(out?.receipt || out).slice(0, 500));
const resultText = JSON.stringify(out?.result ?? null);
console.log("result excerpt:", resultText.slice(0, 600));
const payloadOk = resultText.toLowerCase().includes(EXPECT_TEXT.toLowerCase());
console.log(`result contains ${JSON.stringify(EXPECT_TEXT)}:`, payloadOk, `(result ${resultText.length} chars)`);
try { const { writeFileSync } = await import("node:fs"); writeFileSync(process.env.RESPONSE_OUT || "solana-sor-response.json", JSON.stringify(out)); } catch { /* best-effort */ }
const r = out?.receipt || {};
await new Promise((res) => setTimeout(res, 6000));
const after = await usdcOf(SPENDER);
console.log(`spending wallet USDC after: ${after} (delta ${before != null && after != null ? (after - before).toFixed(6) : "?"}); receipt:`, JSON.stringify(r).slice(0, 400));
const ok = paid.status === 200 && r.external === true && String(r.settleNetwork || "") === "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
  && out.result && payloadOk
  && before != null && after != null && before - after >= Number(r.underlyingPriceUsd || 0) - 1e-6 && before - after > 0;
if (ok) console.log(`PROVEN: Solana buyer -> route-execute -> external Solana seller ${r.seller} paid from the spending wallet (seller $${r.underlyingPriceUsd}${r.settleTx ? `, tx https://solscan.io/tx/${r.settleTx}` : ""}); payload delivered (${resultText.length} chars)`);
else console.error(`NOT PROVEN${paid.status === 404 || paid.status === 409 ? ` - router said: ${JSON.stringify(out?.error || out).slice(0, 300)}` : ""}`);
process.exit(ok ? 0 : 1);
