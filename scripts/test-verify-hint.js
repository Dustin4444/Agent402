#!/usr/bin/env node
// A rejected payment is answered in the buyer's language (src/verify-hint.js):
// balance short vs stale authorization, on the 402, with a retry verb. Offline.
import { unclassifiedPaymentHint } from "../src/payment-reject.js";
import { hintFor, balanceBucket, noteVerifyFailure, hintForCredential, credentialKeyOf, credentialKeyFromHeader, verifyHintMiddleware, usdcBalanceOnBase, _testResetForTest, _inflightForTest } from "../src/verify-hint.js";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL: ${m}`); } };
const PAYER = "0xc59e74ed6386b2a12d892fff2509a6965a0498dc";
const REVERT = "[CDP (Base)] invalid_payload: contract call failed: unable to call contract: execution reverted";

// hintFor
const empty = hintFor({ reason: REVERT, balanceUsd: 0, priceUsd: 0.005, network: "eip155:8453", payer: PAYER });
ok(empty.retry === "fund-wallet" && /holds \$0\.0000 USDC on Base and this call costs \$0\.0050/.test(empty.hint) && /sign a NEW authorization/.test(empty.hint), "execution reverted + empty wallet -> fund-wallet, with the balance and the price");
// SUPERSEDED, not deleted (2026-09-19). This used to assert that a balance
// under the price is "fund-wallet" like an empty one. Measured on 30 days of
// production: 6,473 of 6,582 Base verify failures were this exact state - 20
// wallets holding USDC, just less than the price - each retrying the same
// doomed authorization 300-plus times, while a truly EMPTY wallet accounted
// for 10 attempts. "Fund the wallet" is a dead end for a buyer who can already
// afford something; naming what the balance covers is a route they can take
// now. An empty wallet still gets fund-wallet, which the case above pins.
const short = hintFor({ reason: REVERT, balanceUsd: 0.002, priceUsd: 0.005, payer: PAYER });
ok(short.retry === "lower-price-route" && short.wantsAffordable === true && /holds \$0\.0020/.test(short.hint), "a FUNDED wallet under the price is pointed at what it can afford, not told to top up");
ok(/\/api\/pricing/.test(short.hint) && /\/api\/find/.test(short.hint), "and the hint names the two surfaces that answer 'what can I afford'");
const stale = hintFor({ reason: REVERT, balanceUsd: 12.5, priceUsd: 0.005, payer: PAYER });
ok(stale.retry === "fresh-authorization" && /nonce was already spent or its validity window has passed/.test(stale.hint) && /Never re-send/.test(stale.hint), "execution reverted with a funded wallet -> the authorization is stale: sign a fresh one");
ok(hintFor({ reason: REVERT, balanceUsd: null, priceUsd: 0.005 }).retry === "fresh-authorization", "unreadable balance never claims the wallet is empty");
ok(hintFor({ reason: "unsupported network eip155:1" , network: "eip155:1" }).retry === "other-network", "an unsupported network points at accepts");
ok(hintFor({ reason: "authorization expired (validBefore)" }).retry === "fresh-authorization", "expired -> fresh authorization");
ok(balanceBucket(null) === "unknown" && balanceBucket(0, 0.005) === "zero" && balanceBucket(0.001, 0.005) === "under-price" && balanceBucket(1, 0.005) === "covers-price", "balance buckets for telemetry carry no number");

// noteVerifyFailure + hintForCredential (stubbed balance read, controllable clock)
const SIG = "0x" + "11".repeat(65);
const cred = (nonce, from = PAYER) => ({ x402Version: 2, scheme: "exact", network: "eip155:8453", payload: { signature: SIG, authorization: { from, to: "0x000000000000000000000000000000000000dEaD", value: "5000", validAfter: "0", validBefore: "9999999999", nonce } } });
const toHeader = (c) => Buffer.from(JSON.stringify(c)).toString("base64");
const C1 = cred("0x" + "aa".repeat(32));
const K1 = credentialKeyOf(C1);
_testResetForTest();
let t = 1_000_000; const now = () => t;
const noted = await noteVerifyFailure({ paymentPayload: C1, network: "eip155:8453", reason: REVERT, priceUsd: 0.005, now, balanceReader: async () => 0 });
ok(noted.bucket === "zero" && noted.retry === "fund-wallet" && noted.key === K1 && hintForCredential(K1, { now })?.retry === "fund-wallet", "the hook stores the hint under the failed CREDENTIAL's key and reports the bucket");
ok(credentialKeyFromHeader(toHeader(C1)) === K1, "the raw payment header hashes to the same credential key the hook stored under");
ok(credentialKeyOf(cred("0x" + "aa".repeat(32), PAYER.toUpperCase().replace("0X", "0x"))) === K1, "credential key is case-insensitive on the address");
ok(credentialKeyOf(cred("0x" + "bb".repeat(32))) !== K1 && hintForCredential(credentialKeyOf(cred("0x" + "bb".repeat(32))), { now }) === null, "a FRESH authorization from the same wallet is a new key with no inherited hint");
const forged = { ...C1, payload: { ...C1.payload, signature: "0x" + "99".repeat(65) } };
ok(credentialKeyOf(forged) !== K1 && hintForCredential(credentialKeyOf(forged), { now }) === null, "a header naming the same payer with a different signature never sees that payer's hint (no balance oracle by address)");
t += 5 * 60_000 + 1;
ok(hintForCredential(K1, { now }) === null, "a hint expires after five minutes");
ok((await noteVerifyFailure({ payer: "not-an-address", network: "eip155:8453", reason: REVERT, priceUsd: 0.005, now })) === null, "a non-EVM payer gets no balance read and no hint");
let reads = 0;
const C2 = cred("0x" + "cc".repeat(32));
await noteVerifyFailure({ paymentPayload: C2, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", reason: REVERT, priceUsd: 0.005, now, balanceReader: async () => { reads++; return 1; } });
ok(reads === 0 && hintForCredential(credentialKeyOf(C2), { now })?.retry === "fresh-authorization", "a non-Base network never reads the Base balance; the hint still says to sign fresh");

// usdcBalanceOnBase: eth_call shape, cache, unreadable -> null
_testResetForTest();
let calls = [];
const fetchOk = async (url, init) => { calls.push(JSON.parse(init.body)); return { json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x" + (1_250_000).toString(16).padStart(64, "0") }) }; };
const b1 = await usdcBalanceOnBase(PAYER, { fetchImpl: fetchOk, now });
const b2 = await usdcBalanceOnBase(PAYER, { fetchImpl: fetchOk, now });
ok(b1 === 1.25 && b2 === 1.25 && calls.length === 1 && calls[0].method === "eth_call" && calls[0].params[0].to.toLowerCase() === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" && calls[0].params[0].data === "0x70a08231" + PAYER.slice(2).padStart(64, "0"), "balanceOf(payer) on Base USDC, decoded at 6 decimals, cached for a minute");
ok((await usdcBalanceOnBase(PAYER, { fetchImpl: async () => { throw new Error("rpc down"); }, now: () => t + 120_000 })) === null, "an RPC failure reads as unknown, never zero");

// middleware: merge on a 402 that carries the SAME credential only
_testResetForTest();
await noteVerifyFailure({ paymentPayload: C1, network: "eip155:8453", reason: REVERT, priceUsd: 0.005, now: () => Date.now(), balanceReader: async () => 0 });
const mw = verifyHintMiddleware();
const H1 = toHeader(C1);
const mkRes = (status) => { const r = { statusCode: status, headersSent: false, headers: {}, out: null, setHeader(k, v) { this.headers[k] = v; }, json(b) { this.out = b; return this; } }; return r; };
const r1 = mkRes(402); mw({ headers: { "payment-signature": H1 } }, r1, () => {}); r1.json({ x402Version: 2, error: REVERT, accepts: [{ network: "eip155:8453" }] });
ok(r1.out.error === REVERT && r1.out.accepts.length === 1 && r1.out.retry === "fund-wallet" && /holds \$0\.0000/.test(r1.out.hint) && r1.out.payerUsdcOnBase === 0 && r1.headers["Retry-After"] === "60", "a 402 to the retried credential carries error + accepts untouched plus hint, retry, the payer's own balance and Retry-After");
const r2 = mkRes(402); let passed = false; mw({ headers: {} }, r2, () => { passed = true; }); r2.json({ x402Version: 2, accepts: [] });
ok(passed && r2.out.hint === undefined && r2.headers["Retry-After"] === undefined, "a bare 402 (no payment header) is untouched");
const r3 = mkRes(200); mw({ headers: { "payment-signature": H1 } }, r3, () => {}); r3.json({ ok: true });
ok(r3.out.hint === undefined && Object.keys(r3.out).join() === "ok", "a 200 to a paying request is untouched");
const r6 = mkRes(402); mw({ headers: { "payment-signature": toHeader(forged) } }, r6, () => {}); r6.json({ x402Version: 2 });
ok(r6.out.hint === undefined && r6.out.payerUsdcOnBase === undefined, "a forged header naming the same payer gets NO hint and NO balance (the hint is bound to the credential, not the address)");
const r7 = mkRes(402); mw({ headers: { "x-payment": "bm90LWEtcGF5bWVudA" } }, r7, () => {}); r7.json({ x402Version: 2 });
ok(r7.out.hint === undefined, "an undecodable payment header is untouched");
_testResetForTest();
const r5 = mkRes(402); mw({ headers: { "payment-signature": H1 } }, r5, () => {}); r5.json({ x402Version: 2 });
ok(r5.out.hint === undefined, "no remembered failure for this credential -> no hint (never a guess)");

// concurrency bound: the fifth simultaneous balance read answers unknown at once
_testResetForTest();
let release; const gate = new Promise((r) => { release = r; });
const slowFetch = async () => { await gate; return { json: async () => ({ result: "0x0" }) }; };
const addr = (i) => "0x" + String(i).padStart(40, "0");
const pending = [1, 2, 3, 4].map((i) => usdcBalanceOnBase(addr(i), { fetchImpl: slowFetch, now: () => Date.now() }));
const fifthStart = Date.now();
const fifth = await usdcBalanceOnBase(addr(5), { fetchImpl: slowFetch, now: () => Date.now() });
ok(fifth === null && Date.now() - fifthStart < 200 && _inflightForTest() === 4, "with four reads in flight the fifth is refused immediately as unknown (never queued behind the RPC)");
release(); await Promise.all(pending);
ok(_inflightForTest() === 0, "in-flight count returns to zero after the reads settle");

// --- an UNCLASSIFIED refusal is no longer silent to the buyer -------------
// It used to be telemetry only: a developer whose client failed in a way we had
// no name for got an unadorned 402 from the one system that could see exactly
// what they sent. It is also as likely to be our defect as theirs.
{
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
  const paymentHeader = b64({
    x402Version: 2, scheme: "exact", network: "eip155:8453",
    accepted: { amount: "1000", asset: "0xAAAA" },
    payload: { authorization: { from: "0xF00D", to: "0xBEEF", value: "1000", nonce: "0xdead" }, signature: "0xSIGNATURE" },
  });
  const paymentRequiredHeader = b64({
    x402Version: 2,
    accepts: [{ scheme: "exact", network: "eip155:8453", amount: "1000", asset: "0xAAAA", payTo: "0xBEEF", maxTimeoutSeconds: 300, extra: { name: "USD Coin" } }],
  });
  const h = unclassifiedPaymentHint({ paymentHeader, paymentRequiredHeader });
  ok(h && h.reason === "unclassified", "a decodable payment that matches nothing produces a buyer-facing hint");
  ok(/top level: accepted, network, payload, scheme, x402Version/.test(h.detail), "it names the top-level field NAMES the client sent");
  ok(/authorization: from, nonce, to, value/.test(h.detail), "and the authorization field names, sorted");
  ok(/amount, asset, maxTimeoutSeconds, network, payTo, scheme/.test(h.detail), "and what one accepts entry actually carries, so the two can be compared");

  // The rule that makes this safe to print: a payment header is a credential.
  for (const secret of ["0xSIGNATURE", "0xdead", "0xF00D", "0xAAAA", "1000"]) {
    ok(!h.detail.includes(secret), `no VALUE is echoed (${secret})`);
  }
  ok(/the fault may be ours/.test(h.detail), "it invites a report, because an unclassified refusal is as likely to be our defect");

  ok(unclassifiedPaymentHint({ paymentHeader: "not-base64", paymentRequiredHeader }) === null, "an undecodable header is left to the malformed-header class");
  ok(unclassifiedPaymentHint({ paymentHeader, paymentRequiredHeader: null }) === null, "with no advertised requirements there is nothing to compare against, so it stays quiet");
}

// --- the published reason table cannot drift from the classifier ----------
// /x402-test teaches developers this vocabulary. A class the classifier can
// emit and the table does not document is a developer reading a page that does
// not describe the server answering them.
{
  const { readFileSync } = await import("node:fs");
  const { REJECTION_REASONS } = await import("../src/payment-reject.js");
  const src = readFileSync(new URL("../src/payment-reject.js", import.meta.url), "utf8");
  const emitted = new Set([...src.matchAll(/reason:\s*"([a-z-]+)"/g)].map((m) => m[1]));
  const documented = new Set(REJECTION_REASONS.map((r) => r.reason));
  const undocumented = [...emitted].filter((r) => !documented.has(r));
  ok(undocumented.length === 0, `every reason the classifier emits is documented${undocumented.length ? ` - missing: ${undocumented.join(", ")}` : ""}`);
  const phantom = [...documented].filter((r) => !emitted.has(r));
  ok(phantom.length === 0, `and the table documents nothing the classifier cannot emit${phantom.length ? ` - phantom: ${phantom.join(", ")}` : ""}`);
  ok(REJECTION_REASONS.every((r) => typeof r.means === "string" && r.means.length > 30), "each documented reason explains itself in a sentence, not a restated slug");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
