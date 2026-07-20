// One REAL paid buy of a named tool over a PINNED chain — the capture step
// for announcement demo cards ("real output, never a fixture"). Same
// negotiation as the paid canary's pinned EVM legs: take the live 402, filter
// its accepts down to ONE CAIP-2 chain, pay exactly that, and print what a
// buyer actually gets — the quote, the full result JSON, and the settle
// receipt (network + on-chain tx).
//
// Usage (BURNER_KEY = a funded EVM test wallet, never a prod key):
//   BURNER_KEY=0x… node scripts/paid-demo.js \
//     --path "/api/company-financials?ticker=NVDA" \
//     [--method GET] [--body '{"text":"hi"}'] \
//     [--chain eip155:42220] [--out demo-result.json]
//
// --out writes {tool, method, chain, quote, receipt, result} for a card
// renderer to consume. Exit 1 on usage, 2 on a failed buy.
import { writeFileSync } from "node:fs";

const TARGET = (process.env.TARGET_URL || "https://agent402.tools").replace(/\/$/, "");
const args = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const PATH = arg("--path");
const METHOD = (arg("--method", "GET") || "GET").toUpperCase();
const BODY = arg("--body");
const CHAIN = arg("--chain", "eip155:8453");
const OUT = arg("--out");
if (!PATH || !PATH.startsWith("/")) {
  console.error('usage: BURNER_KEY=0x… node scripts/paid-demo.js --path "/api/…" [--method GET] [--body json] [--chain eip155:…] [--out file.json]');
  process.exit(1);
}
const pk = (process.env.BURNER_KEY || "").trim();
if (!pk) { console.error("paid-demo: no BURNER_KEY — cannot buy"); process.exit(1); }

const [{ privateKeyToAccount }, { x402Client, x402HTTPClient }, { registerExactEvmScheme }] = await Promise.all([
  import("viem/accounts"), import("@x402/core/client"), import("@x402/evm/exact/client"),
]);
const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
const client = new x402Client();
registerExactEvmScheme(client, { signer: account });
const http = new x402HTTPClient(client);

const reqInit = {
  method: METHOD,
  headers: { "Content-Type": "application/json", Accept: "application/json" },
  ...(BODY ? { body: BODY } : {}),
  signal: AbortSignal.timeout(60000),
};
const url = `${TARGET}${PATH}`;
console.log(`$ ${METHOD} ${url}`);
const bare = await fetch(url, reqInit);
if (bare.status !== 402) {
  console.error(`paid-demo: expected a 402 challenge, got HTTP ${bare.status}`);
  process.exit(2);
}
let paymentRequired;
try {
  const bareBody = await bare.json().catch(() => undefined);
  paymentRequired = http.getPaymentRequiredResponse((n) => bare.headers.get(n), bareBody);
} catch (e) {
  console.error(`paid-demo: could not parse the 402 challenge: ${e?.message || e}`);
  process.exit(2);
}
const accepts = (paymentRequired.accepts || []).filter((a) => String(a.network || "") === CHAIN);
if (!accepts.length) {
  console.error(`paid-demo: ${CHAIN} not among the live accepts (${(paymentRequired.accepts || []).map((a) => a.network).join(", ")})`);
  process.exit(2);
}
const quote = {
  network: accepts[0].network,
  asset: accepts[0].asset,
  amount: accepts[0].amount ?? accepts[0].maxAmountRequired,
  usd: Number(accepts[0].amount ?? accepts[0].maxAmountRequired) / 1e6,
};
console.log(`→ HTTP 402 · quote $${quote.usd} on ${quote.network} (payer ${account.address})`);

const payload = await client.createPaymentPayload({ ...paymentRequired, accepts });
const payHeaders = http.encodePaymentSignatureHeader(payload);
const paid = await fetch(url, {
  ...reqInit,
  headers: { ...reqInit.headers, ...payHeaders, "Access-Control-Expose-Headers": "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE" },
});
const result = await paid.json().catch(() => ({}));
let receipt = null;
const receiptHdr = paid.headers.get("payment-response") || paid.headers.get("x-payment-response");
if (receiptHdr) {
  try { receipt = JSON.parse(Buffer.from(receiptHdr, "base64").toString("utf8")); } catch { /* best-effort */ }
}
if (paid.status !== 200) {
  console.error(`paid-demo: buy did NOT settle — HTTP ${paid.status} ${JSON.stringify(result).slice(0, 200)}`);
  process.exit(2);
}
console.log(`→ HTTP 200 · settled${receipt?.transaction ? ` · tx ${receipt.transaction}` : ""}${receipt?.network ? ` · network ${receipt.network}` : ""}`);
console.log("\n--- result JSON ---");
console.log(JSON.stringify(result, null, 2));
if (OUT) {
  writeFileSync(OUT, JSON.stringify({ tool: PATH, method: METHOD, chain: CHAIN, quote, receipt, result }, null, 2));
  console.log(`\nwrote ${OUT}`);
}
