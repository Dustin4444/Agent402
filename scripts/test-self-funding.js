// Self-funding SOR burner economics — offline unit tests.
//   node scripts/test-self-funding.js
import { acceptsForItem, SELF_FUNDING_SLUGS } from "../src/payments.js";
import { buyerPaymentNetwork } from "../src/tools/route-execute.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

const TREASURY = "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0";
const BURNER = "0x77065d81e18ad403BCD6e9A0616b288e16744121";
const rails = {
  evmCaip2: ["eip155:8453", "eip155:137", "eip155:42161"],
  svmCaip2: ["solana:x"], stellarCaip2: [], avmCaip2: [],
  walletAddress: TREASURY, solanaWallet: "SoLwallet", stellarWallet: "", algorandWallet: "",
  upstreamBuyerAddress: BURNER,
};

ok(SELF_FUNDING_SLUGS.has("route-execute") && SELF_FUNDING_SLUGS.has("route-execute-max"), "both route-execute tiers are self-funding slugs");

// route-execute: Base leg -> burner, other EVM + Solana -> treasury
const re = acceptsForItem({ slug: "route-execute", price: "$0.01" }, rails);
const baseAccept = re.find((a) => a.network === "eip155:8453");
const polyAccept = re.find((a) => a.network === "eip155:137");
const solAccept = re.find((a) => a.network === "solana:x");
ok(baseAccept.payTo === BURNER, "route-execute Base leg pays the BURNER (self-funding)");
ok(polyAccept.payTo === TREASURY, "route-execute Polygon leg still pays the treasury");
ok(solAccept.payTo === "SoLwallet", "route-execute Solana leg unchanged (its own wallet)");

// a normal tool: every leg -> treasury (unchanged)
const hash = acceptsForItem({ slug: "hash", price: "$0.001" }, rails);
ok(hash.every((a) => a.network.startsWith("eip155:") ? a.payTo === TREASURY : true), "a normal tool's EVM legs all pay the treasury");

// no burner configured -> route-execute falls back to treasury (safe default)
const noBurner = acceptsForItem({ slug: "route-execute", price: "$0.01" }, { ...rails, upstreamBuyerAddress: "" });
ok(noBurner.find((a) => a.network === "eip155:8453").payTo === TREASURY, "no burner address -> route-execute Base falls back to treasury");

// buyerPaymentNetwork decodes the CAIP-2 from X-PAYMENT
const mk = (net) => ({ header: (n) => n === "x-payment" ? Buffer.from(JSON.stringify({ x402Version: 2, scheme: "exact", network: net })).toString("base64") : null });
ok(buyerPaymentNetwork(mk("eip155:8453")) === "eip155:8453", "buyerPaymentNetwork reads Base");
ok(buyerPaymentNetwork(mk("eip155:137")) === "eip155:137", "buyerPaymentNetwork reads a non-Base chain");
ok(buyerPaymentNetwork({ header: () => null }) === null, "no X-PAYMENT -> null (fail-open)");
ok(buyerPaymentNetwork({ header: () => "not-base64-json!!" }) === null, "malformed X-PAYMENT -> null, no throw");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
