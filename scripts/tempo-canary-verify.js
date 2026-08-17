// One-off LIVE verification: a real mppx client, signed by the existing EVM
// canary burner (0x902dCf34E53695bDEA2fFB354b1a2e58bD598256 — GitHub Actions
// secret BURNER_KEY, the SAME wallet paid-canary.js already uses for its
// other EVM legs, now also funded with 2 PathUSD on Tempo mainnet), makes
// ONE real purchase against agent402.tools's live tempo/charge challenge.
//
// This exists because scripts/test-mpp-tempo-shim.js only proves OUR OWN
// logic (challenge minting + settlement ordering) against injected
// validate/broadcast stubs — Tempo's real relay wire format was explicitly
// left unverified in that PR. This is that verification, run once via
// workflow_dispatch, not (yet) folded into the daily 32-leg paid-canary.js.
//
// Marked synthetic via the same X-Heartbeat-Token mechanism paid-canary.js
// uses (HMAC(POW_SECRET, UTC minute)), so this doesn't pollute the sales
// ledger / PostHog settlement stream as fake external demand.
import { createHmac } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { Mppx, tempo } from "mppx/client";

const TARGET = process.env.TARGET_URL || "https://agent402.tools";
const pk = (process.env.BURNER_KEY || "").trim();
if (!pk) {
  console.error("tempo-canary-verify: no BURNER_KEY — cannot run");
  process.exit(2);
}

const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
console.log(`buyer: ${account.address}`);

const secret = (process.env.POW_SECRET || "").trim();
if (!secret) console.warn("WARN  POW_SECRET not set — this buy will record as EXTERNAL demand in the sales ledger");

const mppxClient = Mppx.create({ methods: [tempo.charge({ account })] });

let sawChallenge = false;
let sawCredential = false;
let paymentFailure = null;
mppxClient.onChallengeReceived(() => { sawChallenge = true; console.log("challenge received"); });
mppxClient.onCredentialCreated(() => { sawCredential = true; console.log("credential created (signed by the burner)"); });
mppxClient.onPaymentFailed((e) => {
  paymentFailure = e;
  console.error("PAYMENT FAILED event:", JSON.stringify(e, (_, v) => (typeof v === "bigint" ? v.toString() : v)).slice(0, 800));
});
mppxClient.onPaymentResponse(() => console.log("payment response received"));

const headers = {};
if (secret) {
  const minute = Math.floor(Date.now() / 60_000);
  headers["X-Heartbeat-Token"] = createHmac("sha256", secret).update(`heartbeat:${minute}`).digest("base64url").slice(0, 32);
}

let res;
try {
  res = await mppxClient.fetch(`${TARGET}/api/uuid`, { headers });
} catch (e) {
  console.error("FAIL: fetch threw:", e?.message || e);
  process.exit(1);
}

const bodyText = await res.text();
console.log(`status: ${res.status}`);
console.log(`payment-receipt header: ${res.headers.get("payment-receipt") || "(none)"}`);
console.log(`body: ${bodyText.slice(0, 500)}`);

if (!sawChallenge) {
  console.error("FAIL: never saw a 402 challenge — client may not have reached the paywall at all");
  process.exit(1);
}
if (!sawCredential) {
  console.error("FAIL: never created a signed credential — challenge selection or signing failed");
  process.exit(1);
}
if (paymentFailure) {
  console.error("FAIL: mppx reported a payment.failed event");
  process.exit(1);
}
if (res.status !== 200) {
  console.error(`FAIL: final status ${res.status}, expected 200`);
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(bodyText);
} catch {
  console.error("FAIL: response body isn't valid JSON");
  process.exit(1);
}
if (!Array.isArray(parsed?.uuids) || parsed.uuids.length === 0) {
  console.error("FAIL: response doesn't look like a real uuid-generator payload");
  process.exit(1);
}

console.log("\nPASS — real Tempo settlement round trip confirmed live against production.");
