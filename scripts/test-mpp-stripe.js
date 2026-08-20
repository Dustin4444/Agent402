// Native MPP stripe/charge gate (src/mpp-stripe.js) — offline, injected
// validate/settle stubs. Proves the settlement-ordering invariant precisely:
// the handler runs BEFORE settle, a failed handler never charges the card, a
// settle failure after a successful handler answers 402 (never a 200 with a
// broken receipt), the binding check gates before any Stripe call, and the
// challenge is offered ONLY on routes >= the $0.50 card minimum.
//
// The wire shape (decimal amount -> cents, paymentMethodTypes, networkId in
// methodDetails) is the shape `npx mppx validate --yes` accepted end to end
// against Stripe sandbox on 2026-08-20 (Payment [stripe] successful). This
// file proves OUR gate logic; the live sandbox run proved the Stripe API leg.
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_fakekey";
process.env.STRIPE_PROFILE_ID = process.env.STRIPE_PROFILE_ID || "profile_test_fake";
process.env.BASE_URL = "https://agent402.tools";

import express from "express";
import { createHmac } from "node:crypto";
import Stripe from "stripe";
import { Challenge, Credential } from "mppx";
import { stripe as stripeMethods } from "mppx/server";
import {
  stripeEnabled, mintStripeChallenge, checkStripeCredentialBinding,
  createStripeGate, createStripeChallengeAppender,
} from "../src/mpp-stripe.js";

let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { console.error("FAIL:", m); process.exit(1); } };
const REALM = "agent402.tools";
const PROFILE = process.env.STRIPE_PROFILE_ID;
// The gate/binding default to the Stripe-derived signing secret; mirror it.
const SECRET = createHmac("sha256", process.env.STRIPE_SECRET_KEY).update("mpp-challenge-signing").digest("base64");
const priceFor = (m, p) => p === "/paid" ? { priceUsd: 0.50, identityBound: false } : p === "/premium" ? { priceUsd: 5.00, identityBound: false } : p === "/id" ? { priceUsd: 1.00, identityBound: true } : p === "/cheap" ? { priceUsd: 0.001, identityBound: false } : null;

// A stripe method purely for building test challenges (no API call in mint).
const testMethod = stripeMethods.charge({ client: new Stripe("sk_test_fakekey"), networkId: PROFILE, paymentMethodTypes: ["card"], livemode: false });

// ---- mint ----
ok(stripeEnabled(), "stripeEnabled true with both env vars");
ok(typeof mintStripeChallenge({ priceUsd: 0.50, realm: REALM }) === "string", "mint: $0.50 route yields a challenge");
ok(mintStripeChallenge({ priceUsd: 0.25, realm: REALM }) === null, "mint: below the $0.50 card minimum mints nothing");

function credFor({ priceUsd = 0.50, realm = REALM, secretKey = SECRET, networkId = PROFILE, spt = "spt_test_123" } = {}) {
  const challenge = Challenge.fromMethod(testMethod, {
    realm, expires: new Date(Date.now() + 60_000),
    request: { amount: priceUsd.toFixed(2), currency: "usd", decimals: 2, networkId, paymentMethodTypes: ["card"] },
    secretKey,
  });
  return Credential.serialize({ challenge, payload: { type: "spt", spt } });
}

// ---- binding ----
ok(checkStripeCredentialBinding(credFor(), { secretKey: SECRET, realm: REALM, priceFor, method: "POST", path: "/paid" }).ok === true, "binding: our own $0.50 challenge on the $0.50 route binds");
ok(/HMAC-verify/.test(checkStripeCredentialBinding(credFor({ secretKey: "wrongsecret" }), { secretKey: SECRET, realm: REALM, priceFor, method: "POST", path: "/paid" }).reason), "binding: a challenge signed with another secret is refused");
ok(/networkId/.test(checkStripeCredentialBinding(credFor({ networkId: "profile_test_other" }), { secretKey: SECRET, realm: REALM, priceFor, method: "POST", path: "/paid" }).reason), "binding: a challenge for a different Stripe profile is refused");
ok(/below this route's price/.test(checkStripeCredentialBinding(credFor({ priceUsd: 0.50 }), { secretKey: SECRET, realm: REALM, priceFor, method: "POST", path: "/premium" }).reason), "binding: a $0.50 challenge does not buy the $5.00 route");
ok(/identity bound/.test(checkStripeCredentialBinding(credFor({ priceUsd: 1.00 }), { secretKey: SECRET, realm: REALM, priceFor, method: "POST", path: "/id" }).reason), "binding: an identity-bound route refuses stripe credentials");
ok(/card minimum/.test(checkStripeCredentialBinding(credFor(), { secretKey: SECRET, realm: REALM, priceFor, method: "POST", path: "/cheap" }).reason), "binding: a sub-$0.50 route is not stripe-offered");

// ---- gate end to end (injected validate/settle) ----
const listen = (app) => new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r({ s, url: `http://127.0.0.1:${s.address().port}` })); });
const GATE = { secretKey: SECRET, realm: REALM, priceFor };

// A) valid credential + 200 handler -> settled, receipt attached, ordering.
{
  const order = [];
  const app = express();
  app.use(createStripeGate({ ...GATE,
    validate: async () => { order.push("validate"); return { ok: true, validation: {} }; },
    settle: async () => { order.push("settle"); return { ok: true, receipt: { method: "stripe", status: "success", reference: "pi_test_123", timestamp: new Date().toISOString() } }; },
  }));
  app.post("/paid", (req, res) => { order.push("handler"); res.status(200).json({ result: "ok" }); });
  const { s, url } = await listen(app);
  const res = await fetch(`${url}/paid`, { method: "POST", headers: { Authorization: credFor() } });
  const body = await res.json();
  ok(res.status === 200 && body.result === "ok", "gate A: valid credential + 200 handler -> served");
  ok(order.join(",") === "validate,handler,settle", `gate A: strict order validate->handler->settle (got ${order.join(",")})`);
  ok(!!res.headers.get("payment-receipt"), "gate A: Payment-Receipt attached");
  s.close();
}
// B) handler fails -> card NEVER charged.
{
  let settleCalled = false;
  const app = express();
  app.use(createStripeGate({ ...GATE, validate: async () => ({ ok: true }), settle: async () => { settleCalled = true; return { ok: true, receipt: {} }; } }));
  app.post("/paid", (req, res) => res.status(500).json({ error: "boom" }));
  const { s, url } = await listen(app);
  const res = await fetch(`${url}/paid`, { method: "POST", headers: { Authorization: credFor() } });
  ok(res.status === 500 && settleCalled === false, "gate B: a failed handler is NEVER settled (card not charged)");
  s.close();
}
// C) settle fails after a 200 -> 402, handler body discarded.
{
  const app = express();
  app.use(createStripeGate({ ...GATE, validate: async () => ({ ok: true }), settle: async () => ({ ok: false, error: "card_declined", reason: "your card was declined" }) }));
  app.post("/paid", (req, res) => res.status(200).json({ result: "secret" }));
  const { s, url } = await listen(app);
  const res = await fetch(`${url}/paid`, { method: "POST", headers: { Authorization: credFor() } });
  const body = await res.json();
  ok(res.status === 402 && body.result === undefined, "gate C: settle failure after a 200 -> 402, handler body discarded");
  ok(body.type === "https://paymentauth.org/problems/verification-failed", "gate C: RFC 9457 verification-failed problem");
  s.close();
}
// D) invalid credential -> falls through to the next middleware's own 402.
{
  const app = express();
  let downstream = false;
  app.use(createStripeGate({ ...GATE, validate: async () => ({ ok: false, error: "expired", reason: "expired" }) }));
  app.post("/paid", (req, res) => { downstream = true; res.status(402).json({ fell: "through" }); });
  const { s, url } = await listen(app);
  const res = await fetch(`${url}/paid`, { method: "POST", headers: { Authorization: credFor() } });
  ok(res.status === 402 && downstream === true, "gate D: a validate-rejected credential falls through untouched");
  s.close();
}
// E) appender adds a stripe challenge to a >= $0.50 route's 402, not a cheap one.
{
  const app = express();
  app.use(createStripeChallengeAppender({ ...GATE }));
  app.post("/paid", (req, res) => res.status(402).json({}));
  app.post("/cheap", (req, res) => res.status(402).json({}));
  const { s, url } = await listen(app);
  const r1 = await fetch(`${url}/paid`, { method: "POST" });
  const r2 = await fetch(`${url}/cheap`, { method: "POST" });
  ok(/method="stripe"/.test(r1.headers.get("www-authenticate") || ""), "gate E: $0.50 route's 402 carries a stripe/charge challenge");
  ok(!/method="stripe"/.test(r2.headers.get("www-authenticate") || ""), "gate E: sub-$0.50 route's 402 does NOT carry a stripe challenge");
  s.close();
}

// ---- wiring pin: server.js MUST bypass the x402 paywall for a validated
// stripe request, exactly like req.tempoSettling. Without it a real card
// payment is 402'd by the paywall and never served (the gate here runs with
// no paywall in front, so it cannot catch this — hence a source scan). Caught
// by the 2026-08-20 security review. ----
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/req\.tempoSettling\s*\|\|\s*req\.stripeSettling/.test(src) || /req\.stripeSettling\s*\|\|\s*req\.tempoSettling/.test(src), "wiring: server.js bypasses the x402 paywall for req.stripeSettling (like req.tempoSettling)");
}

console.log(`\n${pass} passed, 0 failed`);
process.exit(0);
