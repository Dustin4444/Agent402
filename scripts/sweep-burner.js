// Bounded burner -> treasury sweep. The SOR external router settles route-execute
// on BASE to the burner (the x402 spending wallet) so its float pays itself; this
// keeps that hot wallet BOUNDED by moving everything above a working float back to
// the treasury. Base only (that is the self-funding chain). Uses only the BURNER
// key — hot -> cold, never the treasury key.
//
// Gasless: the burner holds no native ETH, so we can't do a direct ERC-20
// transfer. Instead it BUYS one of our own $0.50 tools (skill-company-dossier,
// treasury payTo) repeatedly, facilitator-sponsored — each settled buy moves
// ~$0.50 burner -> treasury. We read the on-chain balance first and buy only
// enough to bring it down to the float, so a low-volume burner is left alone.
//
//   KEY_FILE=/path/to/burner-key TARGET_URL=https://agent402.tools \
//     SWEEP_FLOAT_USD=5 node scripts/sweep-burner.js
//
// Prints the derived burner ADDRESS and the balance BEFORE moving any money.
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";

const TARGET = (process.env.TARGET_URL || "https://agent402.tools").replace(/\/$/, "");
const KEY_FILE = process.env.KEY_FILE || "/tmp/burner-key";
const FLOAT_USD = Number(process.env.SWEEP_FLOAT_USD || "5");     // working float to leave in the burner
const DENOM_USD = 0.5;                                            // skill-company-dossier price
const MAX_CALLS = parseInt(process.env.MAX_CALLS, 10) || 200;     // backstop
const CALL_TIMEOUT_MS = 45000;
const BASE_CAIP2 = "eip155:8453";
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const BASE_RPC = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const DENOM_URL = `${TARGET}/api/skill-company-dossier`;

async function baseUsdcBalance(addr) {
  const data = `0x70a08231000000000000000000000000${addr.slice(2).toLowerCase()}`;
  const res = await fetch(BASE_RPC, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: USDC_BASE, data }, "latest"] }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await res.json();
  if (!j.result || j.result === "0x") throw new Error(`balance read failed: ${JSON.stringify(j).slice(0, 120)}`);
  return Number(BigInt(j.result)) / 1e6;
}

const pk = readFileSync(KEY_FILE, "utf8").trim();
const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
console.log(`Burner:  ${account.address}`);

const before = await baseUsdcBalance(account.address);
console.log(`Balance: $${before.toFixed(4)} USDC on Base · float $${FLOAT_USD.toFixed(2)}`);
const excess = before - FLOAT_USD;
const toMove = Math.floor(excess / DENOM_USD);
if (toMove < 1) { console.log(`Nothing to sweep (excess $${Math.max(0, excess).toFixed(4)} < one $${DENOM_USD} denomination). Done.`); process.exit(0); }
console.log(`Sweeping ~$${(toMove * DENOM_USD).toFixed(2)} (${toMove} x $${DENOM_USD}) Base -> treasury, leaving ~$${FLOAT_USD.toFixed(2)} float.\n`);

const client = new x402Client();
registerExactEvmScheme(client, { signer: account });
const httpc = new x402HTTPClient(client);
const denomInit = (i) => ({
  method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
  body: JSON.stringify({ company: `Sweep Co ${i}`, domain: "example.com" }),
  signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
});

async function payOnBase(url, init) {
  const bare = await fetch(url, init);
  if (bare.status !== 402) return { settled: false, reason: `no-402 (HTTP ${bare.status})` };
  const body = await bare.json().catch(() => undefined);
  const pr = httpc.getPaymentRequiredResponse((n) => bare.headers.get(n), body);
  const accepts = (pr.accepts || []).filter((a) => String(a.network || "") === BASE_CAIP2);
  if (!accepts.length) return { settled: false, reason: "base-not-offered" };
  const payload = await client.createPaymentPayload({ ...pr, accepts });
  const payHeaders = httpc.encodePaymentSignatureHeader(payload);
  const paid = await fetch(url, { ...init, headers: { ...(init.headers || {}), ...payHeaders }, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  return { settled: paid.status !== 402, status: paid.status };
}

let settled = 0, fails = 0;
for (let i = 0; i < toMove && i < MAX_CALLS; i++) {
  let r;
  try { r = await payOnBase(DENOM_URL, denomInit(i)); }
  catch (e) { r = { settled: false, reason: String(e.message).slice(0, 60) }; }
  if (r.settled) { settled++; fails = 0; process.stdout.write(`.`); }
  else if (++fails >= 3) { console.log(`\nstopping: ${r.reason || "settlement failed"} (balance may be at float, or facilitator unavailable)`); break; }
}

const after = await baseUsdcBalance(account.address).catch(() => null);
console.log(`\n\n============ SWEEP COMPLETE ============`);
console.log(`Moved ~$${(settled * DENOM_USD).toFixed(2)} burner -> treasury (${settled} settled).`);
if (after != null) console.log(`Burner balance now: $${after.toFixed(4)} USDC on Base.`);
console.log(`Treasury tally: ${TARGET}/api/stats`);
process.exit(0);
