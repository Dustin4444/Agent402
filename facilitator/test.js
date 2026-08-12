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
  Keypair, Asset, Operation, TransactionBuilder, BASE_FEE, Networks,
} from "@stellar/stellar-sdk";
import {
  createEd25519Signer, ExactStellarScheme, USDC_TESTNET_ADDRESS, getHorizonClient,
} from "@x402/stellar";
import { invalidVerify, invalidSettle, normalizeVerify, normalizeSettle } from "./shape.js";

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

async function friendbotFund(publicKey) {
  const res = await fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(publicKey)}`);
  if (!res.ok && res.status !== 400) throw new Error(`friendbot funding failed for ${publicKey}: HTTP ${res.status}`);
  // 400 with "createAccountAlreadyExist" is fine - the account just already exists.
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
console.log(`\n${passed} assertions passed.`);
