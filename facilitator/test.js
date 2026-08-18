// End-to-end test of the facilitator: spawns the real server as a child
// process, drives it through REAL signed Stellar testnet payments (no
// mocks), and independently confirms via Horizon that transactions actually
// landed on-chain - the step that proves the whole point of this package
// (a facilitator whose reported success is independently verifiable,
// closing the gap the OpenZeppelin channel-service race leaves open in
// production).
//
// Also regression-tests a real bug found by live-probing this exact
// facilitator: two concurrent /settle calls raced on the single signer's
// Stellar sequence number and one was rejected before it ever reached a
// ledger (confirmed via both Horizon and the Soroban RPC returning
// NOT_FOUND for the losing transaction). Fixed by serializing settlement
// through queue.js - see step 9 below for the regression test.
//
// Step 17 regression-tests a second real bug, found live in PRODUCTION
// (2026-08-14, this facilitator's first full day on mainnet): a /settle
// call hung for exactly 300s with no timeout anywhere, until the calling
// side gave up and closed the connection - Railway logged it as a 499,
// which surfaced upstream as an opaque 502. Neither the buyer's account nor
// this facilitator's own signer showed any transaction from that window, so
// the underlying RPC call stalled before ever submitting anything. Fixed
// with a bounded timeout on both /verify and /settle (timeout.js), plus
// best-effort payer recovery on a settle timeout/dispatch error - without
// that second part, src/stellar-confirm.js's "ask the chain before
// believing a failure" safety net in the main app reads an undefined payer
// from our own facilitator's error responses and silently never fires.
//
// A third real bug, found live in PRODUCTION (2026-08-15, the day after the
// timeout fix shipped): a genuine, fast (1.4s, not a hang) settle rejection
// with no diagnostic value at all - @x402/stellar reduces any
// sendTransaction() rejection to one bucket, errorReason "settle_exact_
// stellar_transaction_submission_failed", discarding the RPC's actual
// response (status, errorResultXdr - the real reason: bad sequence,
// insufficient fee, a specific operation-level failure). Fixed with
// rpc-diagnostics.js, a diagnostics-only patch on the Stellar SDK's
// rpc.Server.prototype (the vendor scheme constructs its own RPC client
// internally per-call, so this is the only interception point available)
// that logs the decoded rejection reason without altering what the caller
// sees. Step "0c" below unit-tests the XDR decoder against real,
// self-encoded xdr.TransactionResult objects (not hand-authored base64).
//
//   node test.js          (run from facilitator/, after `npm install`)
//
// One real manual setup step is required and CANNOT be automated: Circle's
// testnet USDC faucet is CAPTCHA-gated in the browser, so this test cannot
// mint itself fresh testnet USDC on every run. Instead it uses a persistent
// payer account you fund ONCE - see README.md "Running the tests" for the
// three-step recipe (Stellar Laboratory account + trustline, then Circle
// Faucet). The facilitator's own signer, by contrast, only ever needs XLM
// (native, friendbot-fundable, zero manual steps), so those accounts are
// generated fresh and funded automatically on every run.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  Keypair, Asset, Operation, TransactionBuilder, BASE_FEE, Networks, xdr,
} from "@stellar/stellar-sdk";
import {
  createEd25519Signer, ExactStellarScheme, USDC_TESTNET_ADDRESS, getHorizonClient,
} from "@x402/stellar";
import { invalidVerify, invalidSettle, normalizeVerify, normalizeSettle } from "./shape.js";
import { withTimeout, TimeoutError } from "./timeout.js";
import { decodeErrorResultXdr } from "./rpc-diagnostics.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const NETWORK = "stellar:testnet";
const PORT = 4099;
const AUTH_PORT = 4100;
const BASE_URL = `http://localhost:${PORT}`;
const AUTH_BASE_URL = `http://localhost:${AUTH_PORT}`;
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"; // Circle testnet USDC
const USDC_ASSET = new Asset("USDC", USDC_ISSUER);
const AMOUNT = "10000"; // 0.001 USDC at 7 decimals

const fail = (msg) => { console.error("FAIL:", msg); process.exitCode = 1; throw new Error(msg); };
let passed = 0;
const ok = (cond, msg) => { if (!cond) fail(msg); else { passed++; console.log("ok -", msg); } };

const horizon = getHorizonClient(NETWORK);

// 0) Offline unit tests for shape.js - fast, deterministic, no network.
{
  ok(invalidVerify("x").isValid === false, "invalidVerify: isValid false");
  ok(invalidVerify("bad_reason").invalidReason === "bad_reason", "invalidVerify: carries reason");
  ok(invalidSettle("x").success === false, "invalidSettle: success false");
  ok(invalidSettle("x").transaction === "", "invalidSettle: transaction is empty string placeholder");
  ok(invalidSettle("x").network === "unknown", "invalidSettle: network falls back to 'unknown'");
  ok(invalidSettle("x", "stellar:testnet").network === "stellar:testnet", "invalidSettle: network passthrough");
  ok(normalizeVerify(undefined).isValid === false, "normalizeVerify: undefined result -> invalid");
  ok(normalizeVerify({ isValid: true, payer: "G..." }).payer === "G...", "normalizeVerify: preserves extra fields");
  ok(normalizeVerify({ isValid: "yes" }).isValid === false, "normalizeVerify: coerces non-boolean isValid to false");
  ok(normalizeSettle(undefined, "stellar:testnet").network === "stellar:testnet", "normalizeSettle: undefined result uses fallback network");
  ok(normalizeSettle({ success: true, transaction: "abc", network: "stellar:testnet" }).transaction === "abc", "normalizeSettle: preserves real transaction");
  ok(normalizeSettle({ success: false }, "stellar:testnet").transaction === "", "normalizeSettle: missing transaction -> empty string");
  console.log("shape.js unit tests ✓");
}

// 0b) Offline unit tests for timeout.js - fast, deterministic, no network.
// Added after a real production incident (2026-08-14): a /settle call hung
// for 300s with no timeout at all, eventually killed by the CALLER giving
// up, which surfaced as an opaque 502. These lock the mechanism that fixes
// it directly, independent of ever reproducing a real RPC stall.
{
  const wt = await withTimeout(Promise.resolve("fast"), 200, "quick");
  ok(wt === "fast", "withTimeout: resolves normally when the promise wins the race");

  let timedOut = false;
  try {
    await withTimeout(new Promise(() => {}), 20, "never-resolves");
  } catch (e) {
    timedOut = e instanceof TimeoutError && e.code === "FACILITATOR_TIMEOUT";
  }
  ok(timedOut, "withTimeout: a promise that never settles rejects with TimeoutError once the timer fires");

  let rejectedFast = false;
  try {
    await withTimeout(Promise.reject(new Error("boom")), 200, "quick-reject");
  } catch (e) {
    rejectedFast = e.message === "boom"; // the ORIGINAL rejection, not a timeout
  }
  ok(rejectedFast, "withTimeout: a promise that rejects before the timer still surfaces its own error, not a timeout");

  // The loser of a lost race must never produce an unhandled rejection -
  // this is what actually crashes/warns a Node process, not just a log line.
  // Constructed so the WRAPPED promise rejects LATE (after the timeout has
  // already won and the caller has already moved on) - the exact shape of
  // an abandoned, still-running /settle call that eventually fails.
  let unhandled = false;
  const onUnhandled = () => { unhandled = true; };
  process.on("unhandledRejection", onUnhandled);
  const slowRejecter = new Promise((_, reject) => setTimeout(() => reject(new Error("late failure")), 40));
  await withTimeout(slowRejecter, 10, "abandoned").catch(() => {});
  await new Promise((r) => setTimeout(r, 80)); // outlive slowRejecter's own 40ms rejection
  process.off("unhandledRejection", onUnhandled);
  ok(!unhandled, "withTimeout: a lost race's eventual rejection never surfaces as an unhandled rejection");

  console.log("timeout.js unit tests ✓");
}

// 0c) Offline unit tests for rpc-diagnostics.js's XDR decoder - fast,
// deterministic, no network. Found live in production (2026-08-15): a real
// canary settlement rejection surfaced only as errorReason:
// "settle_exact_stellar_transaction_submission_failed", with @x402/stellar
// discarding the actual RPC response. These construct REAL
// xdr.TransactionResult objects with the Stellar SDK's own encoder (not
// hand-authored base64) and round-trip them through the decoder, so a
// mistaken assumption about the SDK's own union/getter shape fails loudly
// here instead of silently mis-decoding a real production incident later.
{
  const encodeResult = (resultResult) =>
    new xdr.TransactionResult({
      feeCharged: new xdr.Int64(0),
      result: resultResult,
      ext: xdr.TransactionResultExt.fromXDR("00000000", "hex"),
    }).toXDR("base64");

  const badSeq = decodeErrorResultXdr(encodeResult(xdr.TransactionResultResult.txBadSeq()));
  ok(badSeq.code === "txBadSeq", `decodeErrorResultXdr: simple top-level code round-trips (got ${JSON.stringify(badSeq)})`);

  // txFailed with one invokeHostFunction op that hit a resource limit -
  // exercises the three-level unwrap (outer switch -> .tr() -> per-op-type
  // getter) that a bad assumption about the SDK's shape would silently
  // mis-decode rather than throw on.
  const invokeOp = xdr.OperationResult.opInner(
    xdr.OperationResultTr.invokeHostFunction(xdr.InvokeHostFunctionResult.invokeHostFunctionResourceLimitExceeded()),
  );
  const failed = decodeErrorResultXdr(encodeResult(xdr.TransactionResultResult.txFailed([invokeOp])));
  ok(failed.code === "txFailed" && failed.opCodes[0] === "invokeHostFunction:invokeHostFunctionResourceLimitExceeded",
    `decodeErrorResultXdr: per-operation reason unwraps through opInner+tr()+getter (got ${JSON.stringify(failed)})`);

  // A direct op-level error (the operation never ran at all) needs NO
  // further unwrapping - its own top-level switch name IS the reason.
  const badAuthOp = xdr.OperationResult.opBadAuth();
  const badAuth = decodeErrorResultXdr(encodeResult(xdr.TransactionResultResult.txFailed([badAuthOp])));
  ok(badAuth.opCodes[0] === "opBadAuth", `decodeErrorResultXdr: a direct op-level error skips the tr() unwrap (got ${JSON.stringify(badAuth)})`);

  const garbage = decodeErrorResultXdr("not-valid-base64-xdr!!!");
  ok(typeof garbage?.decodeError === "string", `decodeErrorResultXdr: malformed input never throws, falls back to decodeError (got ${JSON.stringify(garbage)})`);

  ok(decodeErrorResultXdr(undefined) === null, "decodeErrorResultXdr: no errorResultXdr at all -> null, not a crash");

  console.log("rpc-diagnostics.js unit tests ✓");
}

async function friendbotFund(publicKey) {
  const res = await fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(publicKey)}`);
  if (!res.ok) {
    // 400 with "createAccountAlreadyExist" is fine - the account just already
    // exists. Any OTHER 400 (friendbot's own failure) used to be swallowed here
    // and the very next loadAccount() then threw Horizon NotFound - which is
    // exactly what happened on the third fresh account of CI run 32171902738
    // (2026-08-18). Read the body and only accept the one benign case.
    const body = await res.text().catch(() => "");
    if (!(res.status === 400 && /createAccountAlreadyExist/i.test(body))) {
      throw new Error(`friendbot funding failed for ${publicKey}: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
  }
  // Friendbot answers when its transaction is SUBMITTED; Horizon serves the
  // account only once that transaction is ingested. Wait for it, bounded, so
  // the caller's loadAccount() cannot race the ledger.
  for (let i = 0; i < 30; i++) {
    try { await horizon.loadAccount(publicKey); return; } catch (e) {
      if (e?.response?.status !== 404 && !/Not Found/i.test(String(e?.message || e))) throw e;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`friendbot funded ${publicKey} but Horizon still does not serve the account after 30s`);
}

async function ensureTrustline(keypair) {
  const account = await horizon.loadAccount(keypair.publicKey());
  const hasLine = account.balances.some(
    (b) => b.asset_type !== "native" && b.asset_code === "USDC" && b.asset_issuer === USDC_ISSUER,
  );
  if (hasLine) return;
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.changeTrust({ asset: USDC_ASSET, limit: "1000000" }))
    .setTimeout(30)
    .build();
  tx.sign(keypair);
  const res = await horizon.submitTransaction(tx);
  if (!res.successful) throw new Error(`trustline tx failed for ${keypair.publicKey()}: ${JSON.stringify(res)}`);
}

async function usdcBalance(publicKey) {
  const account = await horizon.loadAccount(publicKey);
  const line = account.balances.find(
    (b) => b.asset_type !== "native" && b.asset_code === "USDC" && b.asset_issuer === USDC_ISSUER,
  );
  return line ? Number(line.balance) : 0;
}

function buildRequirements(payTo, amount) {
  return {
    scheme: "exact",
    network: NETWORK,
    asset: USDC_TESTNET_ADDRESS,
    amount,
    payTo,
    maxTimeoutSeconds: 60,
    extra: { areFeesSponsored: true },
  };
}

async function signPayment(payerSigner, requirements) {
  const clientScheme = new ExactStellarScheme(payerSigner);
  const created = await clientScheme.createPaymentPayload(2, requirements);
  return { x402Version: created.x402Version, accepted: requirements, payload: created.payload };
}

async function post(baseUrl, path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function waitForHealthy(baseUrl, path = "/supported") {
  for (let i = 0; i < 20; i++) {
    const up = await fetch(`${baseUrl}${path}`).then((r) => r.ok || r.status === 401).catch(() => false);
    if (up) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// 1) Facilitator signer - fresh every run, XLM only, fully automatable.
const facilitatorKp = Keypair.random();
await friendbotFund(facilitatorKp.publicKey());
console.log(`facilitator signer funded: ${facilitatorKp.publicKey()}`);

// 2) Seller (payTo) - fresh every run. Needs to exist on-ledger and hold a
// trustline to receive the SAC transfer (a brand-new G-account can't hold
// any balance, including a wrapped classic asset, until it exists).
const sellerKp = Keypair.random();
await friendbotFund(sellerKp.publicKey());
await ensureTrustline(sellerKp);
console.log(`seller (payTo) funded + trustline: ${sellerKp.publicKey()}`);

// A second, separately-funded+trustlined seller used ONLY as the
// "disallowed" payTo target in the allowlist test (step 16) - it has to be a
// real, receive-capable account (funded, trustlined) or the CLIENT-side
// Soroban simulation rejects it before the payload even exists, which would
// test the SDK's own trustline check instead of our facilitator's allowlist.
const otherSellerKp = Keypair.random();
await friendbotFund(otherSellerKp.publicKey());
await ensureTrustline(otherSellerKp);
console.log(`other seller (not on allowlist) funded + trustline: ${otherSellerKp.publicKey()}`);

// 3) Payer - PERSISTENT, human-funded once via Circle's faucet (see header
// comment). We only automate the trustline (idempotent, no CAPTCHA) and
// check the balance is real.
const payerSecret = (process.env.TEST_PAYER_STELLAR_SECRET || "").trim();
if (!payerSecret) {
  fail(
    "TEST_PAYER_STELLAR_SECRET is not set. This test needs a persistent testnet " +
    "account that actually holds USDC - Circle's faucet is CAPTCHA-gated and can't " +
    "be scripted. See README.md \"Running the tests\" for the one-time setup.",
  );
}
const payerKp = Keypair.fromSecret(payerSecret);
await friendbotFund(payerKp.publicKey()); // no-op if it already exists
await ensureTrustline(payerKp);
const payerBalance = await usdcBalance(payerKp.publicKey());
if (payerBalance <= 0) {
  fail(
    `Payer account ${payerKp.publicKey()} has a 0 USDC balance. Fund it once via ` +
    "https://faucet.circle.com/ (select Stellar testnet) - see README.md.",
  );
}
console.log(`payer ready: ${payerKp.publicKey()} (USDC balance: ${payerBalance})`);
const payerSigner = createEd25519Signer(payerKp.secret(), NETWORK);

// 4) Spawn the real facilitator server (permissive: no auth, no payTo allowlist).
const proc = spawn(process.execPath, [join(ROOT, "index.js")], {
  cwd: ROOT,
  env: { ...process.env, FACILITATOR_STELLAR_SECRET: facilitatorKp.secret(), PORT: String(PORT) },
  stdio: ["ignore", "inherit", "inherit"],
});
process.on("exit", () => { try { proc.kill("SIGKILL"); } catch { /* already dead */ } });
if (!(await waitForHealthy(BASE_URL))) fail("facilitator did not become healthy");

// 5) GET /supported
{
  const supported = await fetch(`${BASE_URL}/supported`).then((r) => r.json());
  ok(Array.isArray(supported.kinds), "/supported: kinds is an array");
  const kind = supported.kinds.find((k) => k.network === NETWORK && k.scheme === "exact");
  ok(!!kind, "/supported: advertises exact scheme on stellar:testnet");
  ok(!!supported.signers && typeof supported.signers === "object", "/supported: signers is an object");
}

// 6) Build payment requirements + a real signed payload from the payer.
const requirements = buildRequirements(sellerKp.publicKey(), AMOUNT);
const paymentPayload = await signPayment(payerSigner, requirements);

// 7) POST /verify
{
  const { status, body } = await post(BASE_URL, "/verify", { x402Version: 2, paymentPayload, paymentRequirements: requirements });
  ok(status === 200, `/verify: HTTP 200 (got ${status})`);
  ok(body.isValid === true, `/verify: isValid true (got ${JSON.stringify(body)})`);
  ok(body.payer === payerKp.publicKey(), "/verify: payer matches");
}

// 8) POST /settle
let settledTx = "";
{
  const { status, body } = await post(BASE_URL, "/settle", { x402Version: 2, paymentPayload, paymentRequirements: requirements });
  ok(status === 200, `/settle: HTTP 200 (got ${status})`);
  ok(body.success === true, `/settle: success true (got ${JSON.stringify(body)})`);
  ok(/^[0-9a-f]{64}$/i.test(body.transaction || ""), "/settle: transaction looks like a real tx hash");
  ok(body.network === NETWORK, "/settle: network echoed back");
  settledTx = body.transaction;
}

// 9) Independently confirm on Horizon - the step that actually proves the
// founding motivation: our facilitator's reported success corresponds to a
// REAL, independently-verifiable on-chain confirmation.
{
  const tx = await horizon.transactions().transaction(settledTx).call();
  ok(tx.successful === true, "Horizon independently confirms the settled transaction succeeded");
}

// 10) Concurrency regression test - the actual bug this hardening pass
// fixes. Two DISTINCT real signed payments, fired at /settle via
// Promise.all. Before the queue.js fix, one of these reliably failed with
// NOT_FOUND on both Horizon and the Soroban RPC (never reached a ledger) -
// a sequence-number race on the single facilitator signer.
{
  const reqA = buildRequirements(sellerKp.publicKey(), "5000");
  const reqB = buildRequirements(sellerKp.publicKey(), "7000");
  const [payloadA, payloadB] = await Promise.all([
    signPayment(payerSigner, reqA),
    signPayment(payerSigner, reqB),
  ]);
  const [resA, resB] = await Promise.all([
    post(BASE_URL, "/settle", { x402Version: 2, paymentPayload: payloadA, paymentRequirements: reqA }),
    post(BASE_URL, "/settle", { x402Version: 2, paymentPayload: payloadB, paymentRequirements: reqB }),
  ]);
  ok(resA.status === 200 && resB.status === 200, "concurrency: both /settle calls returned HTTP 200");
  ok(resA.body.success === true, `concurrency: settlement A succeeded (got ${JSON.stringify(resA.body)})`);
  ok(resB.body.success === true, `concurrency: settlement B succeeded (got ${JSON.stringify(resB.body)})`);
  ok(resA.body.transaction !== resB.body.transaction, "concurrency: two distinct transaction hashes");
}

// 11) Negative test - corrupted payload must still return HTTP 200, never 4xx.
{
  const corrupted = { ...paymentPayload, payload: { ...paymentPayload.payload, transaction: "not-a-real-transaction" } };
  const { status, body } = await post(BASE_URL, "/verify", { x402Version: 2, paymentPayload: corrupted, paymentRequirements: requirements });
  ok(status === 200, `/verify (corrupted): HTTP 200, not an error status (got ${status})`);
  ok(body.isValid === false, "/verify (corrupted): isValid false");
  ok(typeof body.invalidReason === "string" && body.invalidReason.length > 0, "/verify (corrupted): carries a reason");
}
{
  const corrupted = { ...paymentPayload, payload: { ...paymentPayload.payload, transaction: "not-a-real-transaction" } };
  const { status, body } = await post(BASE_URL, "/settle", { x402Version: 2, paymentPayload: corrupted, paymentRequirements: requirements });
  ok(status === 200, `/settle (corrupted): HTTP 200, not an error status (got ${status})`);
  ok(body.success === false, "/settle (corrupted): success false");
  ok(body.transaction === "", "/settle (corrupted): transaction is the empty-string placeholder");
  ok(body.network === NETWORK, "/settle (corrupted): network still a valid string");
}

// 12) Malformed body at the transport layer.
{
  const res = await fetch(`${BASE_URL}/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not json",
  });
  const body = await res.json();
  ok(res.status === 200, `/settle (malformed JSON): HTTP 200 (got ${res.status})`);
  ok(body.success === false, "/settle (malformed JSON): success false");
}

// 13) GET /health - unauthenticated by design, no secret exposed.
{
  const health = await fetch(`${BASE_URL}/health`).then((r) => r.json());
  ok(health.signerAddress === facilitatorKp.publicKey(), "/health: signerAddress matches");
  ok(typeof health.xlmBalance === "number" && health.xlmBalance > 0, "/health: xlmBalance is a positive number");
  ok(health.low === false, "/health: not low right after friendbot funding");
}

proc.kill("SIGKILL");

// 14) A SECOND facilitator instance, this time with auth + a payTo allowlist
// configured, to test both are actually enforced (the permissive instance
// above deliberately leaves both off, matching its "self-hostable, no
// signup" default).
const hardenedFacilitatorKp = Keypair.random();
await friendbotFund(hardenedFacilitatorKp.publicKey());
const AUTH_TOKEN = "test-secret-token-do-not-use-in-prod";
const authProc = spawn(process.execPath, [join(ROOT, "index.js")], {
  cwd: ROOT,
  env: {
    ...process.env,
    FACILITATOR_STELLAR_SECRET: hardenedFacilitatorKp.secret(),
    FACILITATOR_AUTH_TOKEN: AUTH_TOKEN,
    FACILITATOR_ALLOWED_PAYTO: sellerKp.publicKey(),
    PORT: String(AUTH_PORT),
  },
  stdio: ["ignore", "inherit", "inherit"],
});
process.on("exit", () => { try { authProc.kill("SIGKILL"); } catch { /* already dead */ } });
if (!(await waitForHealthy(AUTH_BASE_URL))) fail("hardened facilitator did not become healthy");

// 15) Auth enforcement.
{
  const noAuth = await fetch(`${AUTH_BASE_URL}/supported`);
  ok(noAuth.status === 401, `auth: /supported with no token -> 401 (got ${noAuth.status})`);
  const wrongAuth = await fetch(`${AUTH_BASE_URL}/supported`, { headers: { Authorization: "Bearer wrong-token" } });
  ok(wrongAuth.status === 401, `auth: /supported with wrong token -> 401 (got ${wrongAuth.status})`);
  const rightAuth = await fetch(`${AUTH_BASE_URL}/supported`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
  ok(rightAuth.status === 200, `auth: /supported with correct token -> 200 (got ${rightAuth.status})`);
}
{
  // /health stays unauthenticated even on the hardened instance - by design.
  const health = await fetch(`${AUTH_BASE_URL}/health`);
  ok(health.status === 200, `auth: /health has no auth requirement (got ${health.status})`);
}

// 16) payTo allowlist enforcement (allowlist = [sellerKp.publicKey()] only).
{
  const allowedReq = buildRequirements(sellerKp.publicKey(), AMOUNT);
  const allowedPayload = await signPayment(payerSigner, allowedReq);
  const { status, body } = await post(AUTH_BASE_URL, "/verify",
    { x402Version: 2, paymentPayload: allowedPayload, paymentRequirements: allowedReq }, AUTH_TOKEN);
  ok(status === 200, `payto allowlist: allowed payTo -> HTTP 200 (got ${status})`);
  ok(body.invalidReason !== "payto_not_allowed", "payto allowlist: allowed payTo is not rejected for that reason");

  const disallowedReq = buildRequirements(otherSellerKp.publicKey(), AMOUNT);
  const disallowedPayload = await signPayment(payerSigner, disallowedReq);
  const rejected = await post(AUTH_BASE_URL, "/verify",
    { x402Version: 2, paymentPayload: disallowedPayload, paymentRequirements: disallowedReq }, AUTH_TOKEN);
  ok(rejected.status === 200, `payto allowlist: disallowed payTo still HTTP 200 (got ${rejected.status})`);
  ok(rejected.body.isValid === false, "payto allowlist: disallowed payTo is invalid");
  ok(rejected.body.invalidReason === "payto_not_allowed", `payto allowlist: disallowed payTo carries the right reason (got ${JSON.stringify(rejected.body)})`);
}

authProc.kill("SIGKILL");

// 17) Settle/verify timeout - regression test for the real production
// incident (2026-08-14): a /settle call hung for 300s with nothing bounding
// it, until the CALLING side gave up and closed the connection, which
// Railway logged as a 499 and which surfaced upstream as an opaque 502. A
// deliberately absurd timeout (1ms) guarantees a REAL, valid settle call
// cannot possibly finish in time - no fault injection or mocked hang
// needed, since a real Stellar round-trip is always slower than 1ms.
const IMPATIENT_PORT = 4101;
const IMPATIENT_BASE_URL = `http://localhost:${IMPATIENT_PORT}`;
const impatientKp = Keypair.random();
await friendbotFund(impatientKp.publicKey());
const impatientProc = spawn(process.execPath, [join(ROOT, "index.js")], {
  cwd: ROOT,
  env: {
    ...process.env,
    FACILITATOR_STELLAR_SECRET: impatientKp.secret(),
    FACILITATOR_SETTLE_TIMEOUT_MS: "1",
    FACILITATOR_VERIFY_TIMEOUT_MS: "1",
    PORT: String(IMPATIENT_PORT),
  },
  stdio: ["ignore", "inherit", "inherit"],
});
process.on("exit", () => { try { impatientProc.kill("SIGKILL"); } catch { /* already dead */ } });
if (!(await waitForHealthy(IMPATIENT_BASE_URL))) fail("impatient facilitator did not become healthy");

{
  const req = buildRequirements(sellerKp.publicKey(), "3000");
  const payload = await signPayment(payerSigner, req);

  const v = await post(IMPATIENT_BASE_URL, "/verify", { x402Version: 2, paymentPayload: payload, paymentRequirements: req });
  ok(v.status === 200, `timeout: /verify HTTP 200 even on timeout (got ${v.status})`);
  ok(v.body.isValid === false, "timeout: /verify isValid false");
  ok(v.body.invalidReason === "verify_timed_out", `timeout: /verify carries its own reason, not a generic one (got ${JSON.stringify(v.body)})`);

  const s = await post(IMPATIENT_BASE_URL, "/settle", { x402Version: 2, paymentPayload: payload, paymentRequirements: req });
  ok(s.status === 200, `timeout: /settle HTTP 200 even on timeout (got ${s.status})`);
  ok(s.body.success === false, "timeout: /settle success false");
  ok(s.body.transaction === "", "timeout: /settle transaction is the empty-string placeholder, never a guess");
  ok(s.body.errorReason === "settle_timed_out", `timeout: /settle carries its own reason, not a generic one (got ${JSON.stringify(s.body)})`);
  // The actual point of this whole test: without payer recovery,
  // src/stellar-confirm.js's settlePayerOf(res) would read undefined here
  // and its "ask the chain before believing a failure" check would never
  // fire for our own facilitator's errors - silently inert, not merely
  // untested.
  ok(s.body.payer === payerKp.publicKey(), `timeout: /settle recovers the real payer despite never getting a vendor result (got ${s.body.payer})`);
}

impatientProc.kill("SIGKILL");
console.log(`\n${passed} assertions passed.`);
