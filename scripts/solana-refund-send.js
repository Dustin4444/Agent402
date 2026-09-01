// One-time SPL USDC transfer on Solana, for refunds the refund runner cannot
// pay. `senders.solana` is hardcoded false in scripts/refund-run.js (no SVM
// spending wallet), so debts on that chain are recorded and held. This sends
// one, deliberately, under the same discipline the runner uses.
//
// Dry by default: it prints what it would do and exits. --send is the only
// thing that broadcasts.
//
//   SOLANA_BURNER_KEY=... node scripts/solana-refund-send.js --to <addr> --usd 1.60
//   ... --send        # actually broadcast
//
// Guards, each of which refuses rather than guesses:
//   * the destination must ALREADY hold a USDC token account. We are refunding
//     someone who paid us in USDC on Solana, so they have one; needing to
//     create it would mean the address is wrong.
//   * a hard ceiling (--max, default $5) no single run may exceed
//   * the burner must hold the amount plus a SOL fee reserve
//   * the transfer amount is integer base units, never a float
import { createHash } from "node:crypto";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

const arg = (n, d = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const SEND = process.argv.includes("--send");
const TO = String(arg("to", "")).trim();
const USD = Number(arg("usd", "0"));
const MAX = Number(arg("max", "5"));

if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(TO)) { console.error("--to must be a base58 Solana address"); process.exit(2); }
if (!(USD > 0)) { console.error("--usd must be positive"); process.exit(2); }
if (USD > MAX) { console.error(`--usd ${USD} exceeds the ceiling $${MAX}; raise --max deliberately if that is intended`); process.exit(2); }

const rpc = async (method, params) => {
  const r = await fetch(RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
};

const raw = (process.env.SOLANA_BURNER_KEY || "").trim();
if (!raw) { console.error("SOLANA_BURNER_KEY is required"); process.exit(2); }

const kit = await import("@solana/kit");
const bytes = raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : new Uint8Array(kit.getBase58Encoder().encode(raw));
const signer = await kit.createKeyPairSignerFromBytes(bytes);
const FROM = String(signer.address);

const units = BigInt(Math.round(USD * 1e6)); // USDC is 6dp; integer base units only
console.log(`from: ${FROM}`);
console.log(`to:   ${TO}`);
console.log(`send: ${USD} USDC (${units} base units)  ceiling $${MAX}`);

const accountsOf = async (owner) =>
  (await rpc("getTokenAccountsByOwner", [owner, { mint: USDC_MINT }, { encoding: "jsonParsed" }])).value;

const [srcAccts, dstAccts] = await Promise.all([accountsOf(FROM), accountsOf(TO)]);
if (!srcAccts.length) { console.error("the burner holds no USDC token account"); process.exit(1); }
if (!dstAccts.length) {
  // Refusing rather than creating one: the recipient paid us in USDC on
  // Solana, so an absent account means the destination is not who we think.
  console.error("the destination holds no USDC token account - refusing (a payer of USDC would have one; check the address)");
  process.exit(1);
}
const src = srcAccts[0], dst = dstAccts[0];
const have = BigInt(src.account.data.parsed.info.tokenAmount.amount);
console.log(`burner USDC: ${src.account.data.parsed.info.tokenAmount.uiAmountString} (ata ${src.pubkey})`);
console.log(`dest   USDC: ${dst.account.data.parsed.info.tokenAmount.uiAmountString} (ata ${dst.pubkey})`);
if (have < units) { console.error(`burner holds ${have} base units, needs ${units}`); process.exit(1); }

const lamports = await rpc("getBalance", [FROM]);
console.log(`burner SOL:  ${(lamports.value ?? lamports) / 1e9}`);
if ((lamports.value ?? lamports) < 1_000_000) { console.error("burner SOL is too low to pay the fee"); process.exit(1); }

if (!SEND) { console.log("\nDRY RUN - nothing broadcast. Re-run with --send to transfer."); process.exit(0); }

const { getTransferInstruction } = await import("@solana-program/token");
const rpcClient = kit.createSolanaRpc(RPC);
const { value: blockhash } = await rpcClient.getLatestBlockhash().send();

const ix = getTransferInstruction({
  source: kit.address(src.pubkey),
  destination: kit.address(dst.pubkey),
  authority: signer,
  amount: units,
});
const message = kit.pipe(
  kit.createTransactionMessage({ version: 0 }),
  (m) => kit.setTransactionMessageFeePayerSigner(signer, m),
  (m) => kit.setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
  (m) => kit.appendTransactionMessageInstruction(ix, m),
);
const signed = await kit.signTransactionMessageWithSigners(message);
const sig = kit.getSignatureFromTransaction(signed);
const wire = kit.getBase64EncodedWireTransaction(signed);
await rpc("sendTransaction", [wire, { encoding: "base64", skipPreflight: false, maxRetries: 3 }]);
console.log(`SENT ${USD} USDC -> ${TO}`);
console.log(`signature: ${sig}`);
console.log(`https://solscan.io/tx/${sig}`);
console.log(`digest(for the ledger note): sha256:${createHash("sha256").update(String(sig)).digest("hex").slice(0, 16)}`);
