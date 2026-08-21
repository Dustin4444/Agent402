// Subscription engine test with a stubbed Stripe. Proves: subscription checkout
// creation + validation, paid-session provisioning, webhook signature discipline
// (refuses without a secret; verifies with one) and lifecycle transitions.
// Offline, in CI.
import { createStripeSubscriptions, MONITOR_PRODUCTS } from "../src/stripe-subscriptions.js";
import { rmSync } from "node:fs";
import { join } from "node:path";

const STORE = join("/tmp", `test-subs-${process.pid}.json`);
try { rmSync(STORE); } catch { /* first run */ }

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "ok" : "NOT OK") + " - " + m); };

const sessions = {
  cs_paid: { id: "cs_paid", mode: "subscription", payment_status: "paid", status: "complete", subscription: "sub_1", customer: "cus_1", customer_details: { email: "a@b.com" }, metadata: { product: "domain-monitor", target: "example.com" } },
  cs_unpaid: { id: "cs_unpaid", mode: "subscription", payment_status: "unpaid", status: "open", subscription: "sub_2", customer: "cus_2", metadata: { product: "domain-monitor", target: "x.com" } },
  cs_notsub: { id: "cs_notsub", mode: "payment", payment_status: "paid", status: "complete" },
};
const stripe = {
  checkout: { sessions: {
    create: async (args) => { stripe._lastCreate = args; return { id: "cs_new", url: "https://checkout.stripe.com/pay/cs_new" }; },
    retrieve: async (id) => { const s = sessions[id]; if (!s) throw new Error("No such session"); return s; },
  } },
  billingPortal: { sessions: { create: async () => ({ url: "https://billing.stripe.com/p/session_x" }) } },
  webhooks: { constructEvent: (body, sig, secret) => { if (sig !== "goodsig" || secret !== "whsec_test") throw new Error("bad signature"); return JSON.parse(body.toString()); } },
};

const subs = createStripeSubscriptions({ stripe, baseUrl: "https://agent402.tools", storePath: STORE });

// products
ok(Object.values(MONITOR_PRODUCTS).every((p) => p.price >= 500 && p.kind), "every monitor product is >= $5 and has a kind");

// createCheckout
const c = await subs.createCheckout("domain-monitor", "example.com");
ok(c.url === "https://checkout.stripe.com/pay/cs_new", "createCheckout returns a Stripe checkout url");
ok(stripe._lastCreate.mode === "subscription", "checkout is subscription mode");
ok(stripe._lastCreate.line_items[0].price_data.recurring.interval === "month", "price is monthly recurring");
ok(stripe._lastCreate.subscription_data.metadata.target === "example.com", "target rides on subscription metadata");
let threw = false; try { await subs.createCheckout("nope", "x"); } catch { threw = true; }
ok(threw, "createCheckout rejects an unknown product");
threw = false; try { await subs.createCheckout("domain-monitor", ""); } catch { threw = true; }
ok(threw, "createCheckout rejects empty target");

// recordFromSession (belt-and-suspenders provisioning)
const r1 = await subs.recordFromSession("cs_paid");
ok(r1.status === "active" && r1.target === "example.com" && r1.customer === "cus_1", "a paid subscription session provisions active");
ok(subs.get("sub_1")?.status === "active", "the subscription is stored active");
ok((await subs.recordFromSession("cs_unpaid")).status === "unpaid", "an unpaid session is not provisioned");
ok((await subs.recordFromSession("cs_notsub")).status === "invalid", "a non-subscription session is invalid");
ok((await subs.recordFromSession("garbage")).status === "invalid", "a malformed session id is invalid");
ok((await subs.recordFromSession("cs_missing")).status === "not_found", "a nonexistent session id is not_found");

// webhook: refuses without a secret (never trusts an unsigned body)
delete process.env.STRIPE_WEBHOOK_SECRET;
let code = 0; try { await subs.handleWebhook(Buffer.from("{}"), "sig"); } catch (e) { code = e.statusCode; }
ok(code === 401, "SECURITY: the webhook refuses (401) when no signing secret is configured");

// webhook: with a secret, a bad signature is rejected
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
code = 0; try { await subs.handleWebhook(Buffer.from("{}"), "badsig"); } catch (e) { code = e.statusCode; }
ok(code === 400, "SECURITY: a bad signature is rejected (400)");

// webhook lifecycle: subscription.updated then .deleted
const evUpdated = JSON.stringify({ type: "customer.subscription.updated", data: { object: { id: "sub_1", customer: "cus_1", status: "active", metadata: { product: "domain-monitor", target: "example.com" }, current_period_end: 1893456000, cancel_at_period_end: false } } });
await subs.handleWebhook(Buffer.from(evUpdated), "goodsig");
ok(subs.get("sub_1")?.currentPeriodEnd === 1893456000, "webhook updates the subscription period");
ok(subs.listActive("domain").some((x) => x.subId === "sub_1"), "listActive('domain') includes the active sub");

const evDeleted = JSON.stringify({ type: "customer.subscription.deleted", data: { object: { id: "sub_1", customer: "cus_1" } } });
await subs.handleWebhook(Buffer.from(evDeleted), "goodsig");
ok(subs.get("sub_1")?.status === "canceled", "webhook marks a deleted subscription canceled");
ok(!subs.listActive("domain").some((x) => x.subId === "sub_1"), "a canceled sub is no longer active");

try { rmSync(STORE); } catch { /* ignore */ }
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
