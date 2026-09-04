// The buyer behind a Solana x402 payment is read from the transaction it
// signed, so verify_failed's payer id groups one wallet's retries.
//
// Measured 2026-09-03/04: ~200 Solana verify failures an hour, every one the
// token program's InsufficientFunds, and 197 distinct payer ids for 197 events
// - because the SVM fallback keyed on the credential, and a Solana credential
// is a fresh transaction (new memo nonce) per attempt. One empty wallet looping
// and two hundred wallets hitting a fault of ours were indistinguishable.
//
// Transactions here are built by @solana/kit itself (the same builder the
// scheme client and solana-buyer.js use), never hand-assembled, so the walk is
// proven against the real wire layout for BOTH message versions.
//   node scripts/test-svm-payer.js
import { readFile } from "node:fs/promises";
import { svmRequiredSigners, svmPayerFromPayload, base58Encode } from "../src/svm-payer.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const kit = await import("@solana/kit");

// --- base58, against kit's own codec ------------------------------------------
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
ok(base58Encode(kit.getAddressEncoder().encode(kit.address(USDC))) === USDC, "base58 round-trips a real address through kit's encoder");
ok(base58Encode(new Uint8Array(32)) === "1".repeat(32), "leading zero bytes become leading 1s");

// --- a real partially-signed transaction, both message versions ----------------
const feePayer = await kit.generateKeyPairSigner();   // the facilitator's key, unsigned by the buyer
const buyer = await kit.generateKeyPairSigner();      // the wallet whose USDC moves
const bystander = await kit.generateKeyPairSigner();  // a non-signer account in the instruction
const blockhash = { blockhash: kit.blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 0n };
async function build(version) {
  const ix = {
    programAddress: kit.address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
    accounts: [
      { address: bystander.address, role: kit.AccountRole.READONLY },
      { address: buyer.address, role: kit.AccountRole.READONLY_SIGNER, signer: buyer },
    ],
    data: new TextEncoder().encode("agent402 test"),
  };
  const msg = kit.pipe(
    kit.createTransactionMessage({ version }),
    (m) => kit.setTransactionMessageFeePayer(feePayer.address, m),
    (m) => kit.setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => kit.appendTransactionMessageInstruction(ix, m),
  );
  const signed = await kit.partiallySignTransactionMessageWithSigners(msg);
  return kit.getBase64EncodedWireTransaction(signed);
}
for (const version of [0, "legacy"]) {
  const tx = await build(version);
  const signers = svmRequiredSigners(tx);
  ok(Array.isArray(signers) && signers.length === 2 && signers[0] === feePayer.address && signers[1] === buyer.address,
    `${version} message: required signers are [feePayer, buyer] in account order (${JSON.stringify(signers)})`);
  ok(!signers.includes(bystander.address), `${version} message: a non-signer account is never reported as a signer`);
  const payload = { x402Version: 2, payload: { transaction: tx }, accepted: { extra: { feePayer: feePayer.address } } };
  ok(svmPayerFromPayload(payload, { feePayer: feePayer.address }) === buyer.address, `${version} message: the buyer is the signer that is not the fee payer`);
  ok(svmPayerFromPayload(payload) === buyer.address, `${version} message: with no fee payer named, the second signer is the buyer`);
  ok(svmPayerFromPayload(payload, { feePayer: buyer.address }) === feePayer.address, `${version} message: exclusion is by address, not position`);
}

// --- shape guards: null, never a throw, never a guess --------------------------
for (const junk of [null, undefined, "", "!!!", "AAAA", "gA==", Buffer.alloc(300).toString("base64"), { payload: {} }, { payload: { transaction: 42 } }]) {
  let out;
  try { out = typeof junk === "object" && junk !== null ? svmPayerFromPayload(junk) : svmRequiredSigners(junk); } catch (e) { out = `threw ${e.message}`; }
  ok(out === null, `junk input ${String(JSON.stringify(junk)).slice(0, 30)} -> null`);
}
// A signature count that disagrees with the header is not a transaction we understand.
{
  const tx = Buffer.from(await build(0), "base64");
  tx[0] = 3; // claims three signatures; the header still says two
  ok(svmRequiredSigners(tx.toString("base64")) === null, "a signature count that contradicts the header is refused");
}

// --- the wiring in payments.js is pinned from source ---------------------------
const payments = await readFile("src/payments.js", "utf8");
const derive = payments.slice(payments.indexOf("let payerKey = null;"), payments.indexOf("capturePostHogVerifyFailed({"));
ok(/svmPayerFromPayload\(ctx\?\.paymentPayload, \{ feePayer: ctx\?\.requirements\?\.extra\?\.feePayer \}\)/.test(derive),
  "recordVerifyFailure asks svm-payer.js with the accept's fee payer");
ok(/basis = `svm-payer:\$\{svm\}`/.test(derive), "the SVM buyer becomes the HMAC basis");
ok(derive.indexOf("svm-payer:") < derive.indexOf("credentialKeyOf"), "and it is tried BEFORE the per-credential fallback, else every retry is a new id");
ok(!/svm\)\.toLowerCase|svm\.toLowerCase/.test(derive), "base58 is never case-folded");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
