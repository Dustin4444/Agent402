// Tempo relay bug reproducer — ZERO seller code, ZERO AWS SDK in the path.
//
// Takes a captured AgentCore/Privy MPP credential (see capture-402.mjs +
// capture_credential_buy.py) and POSTs it straight to Tempo's relay over
// plain fetch, exactly as mppx's Relay.js would (toRelayInput: the challenge
// with `request` DECODED, plus payload and source; idempotency-key =
// mpp_<keccak256(signature)>). Then it hashes the signed transaction two ways
// and checks the chain for either landing.
//
// The point: it isolates the relay. If broadcast reports
// `invalid_payment: "Broadcast transaction hash does not match the signed
// transaction"` while one of the candidate txids is on-chain with status 0x1,
// the relay verified by keccak(submitted bytes) instead of the node-returned
// canonical txid — and those diverge whenever the signer uses recovery-id v
// (0x00/0x01) that the node normalizes to 27/28. This is the exact evidence
// sent to Tempo (see ../../../../ the tempo-evidence file in the bug report).
//
//   TEMPO_API_KEY=<mpp:write key>  CREDENTIAL_FILE=/path/to/captured.txt \
//     node relay_raw_repro.mjs
//
// The credential expires with its challenge (~5 min), so it is not replayable
// and is safe to hand to Tempo. Requires `viem` on the path (npm i viem).
import { readFileSync } from "node:fs";
import { keccak256 } from "viem";

const key = (process.env.TEMPO_API_KEY || "").trim();
const file = process.env.CREDENTIAL_FILE;
const rpcUrl = process.env.TEMPO_RPC_URL || "https://rpc.tempo.xyz";
const apiBase = (process.env.TEMPO_API_BASE_URL || "https://api.tempo.xyz").replace(/\/$/, "");
if (!key || !file) { console.error("set TEMPO_API_KEY and CREDENTIAL_FILE"); process.exit(1); }

const cred = JSON.parse(Buffer.from(readFileSync(file, "utf8").trim().replace(/^Payment\s+/i, ""), "base64url").toString());
// mppx Relay.js toRelayInput: request DECODED, not the base64url wire string.
let request = cred.challenge.request;
if (typeof request === "string") request = JSON.parse(Buffer.from(request, "base64url").toString());
const input = { challenge: { ...cred.challenge, request }, payload: cred.payload, ...(cred.source ? { source: cred.source } : {}) };
const sig = cred.payload.signature;
const idem = "mpp_" + keccak256(sig);

const post = async (path, headers = {}) => {
  const r = await fetch(`${apiBase}/v1/mpp/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "tempo-api-key": key, ...headers },
    body: JSON.stringify(input),
  });
  const body = await r.text();
  console.log(`${path} -> HTTP ${r.status} ${body.slice(0, 300)}`);
  return { status: r.status, body };
};

const rpc = async (method, params) => {
  const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await r.json()).result;
};

console.log(`signature v byte: 0x${sig.slice(-2)} (0x00/0x01 = recovery-id style; canonical on-chain is 0x1b/0x1c)`);
const submitted = keccak256(sig);
const swapByte = { "00": "1b", "01": "1c", "1b": "00", "1c": "01" }[sig.slice(-2)];
const swapped = swapByte ? keccak256(sig.slice(0, -2) + swapByte) : null;
console.log(`candidate txids: submitted=${submitted}${swapped ? ` v-swapped=${swapped}` : ""}`);

await post("validate");
await post("broadcast", { "idempotency-key": idem });

await new Promise((r) => setTimeout(r, 8000));
for (const [label, h] of [["submitted", submitted], ...(swapped ? [["v-swapped", swapped]] : [])]) {
  const receipt = await rpc("eth_getTransactionReceipt", [h]);
  console.log(`chain ${label} ${h.slice(0, 12)}… -> ${receipt ? `LANDED status ${receipt.status}` : "not on chain"}`);
}
console.log("\nIf validate=success, broadcast=invalid_payment, and the v-swapped tx LANDED with status 0x1,\nthe relay verified by the submitted-bytes hash instead of the node's canonical txid.");
