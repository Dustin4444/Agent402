// stripe-subscriptions — the recurring engine (Phase 2 foundation). Sells
// MONITORING subscriptions (re-run a report on a cadence, alert on change) via
// Stripe Checkout in subscription mode, tracks subscribers in a durable store,
// keeps the store in sync through a signature-verified webhook, and hands
// subscribers the Stripe Customer Portal to self-manage.
//
// Design:
// - Checkout uses inline price_data with recurring:{interval:"month"}, so no
//   pre-created Price objects are needed (matches the one-shot flow).
// - Provisioning is belt-and-suspenders: the success page records the sub
//   immediately (so it works even before the webhook secret is set), AND the
//   webhook keeps status/renewals/cancellations in sync (the reliable path).
// - The webhook is only VERIFIED when STRIPE_WEBHOOK_SECRET is set; until then
//   it refuses unverified events (never trusts an unsigned body).
// Rollout switch = STRIPE_SECRET_KEY (same key as the one-shot checkout).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// The monitoring products. Each subscribes to a `target` (a domain, a fund,
// etc.) and re-runs a report kind on a cadence (the scheduler is Phase 2b).
// price is in cents, billed monthly.
export const MONITOR_PRODUCTS = {
  "domain-monitor": {
    label: "Domain security monitor", price: 900, kind: "domain",
    inputField: "domain", inputLabel: "a domain, e.g. example.com",
    blurb: "Monthly re-audit of your domain's email auth, TLS and security headers, with an alert the moment your certificate is expiring or your config drifts.",
  },
  "fund-monitor": {
    label: "Fund 13F watch", price: 900, kind: "fund",
    inputField: "manager", inputLabel: "a fund name, ticker, or CIK",
    blurb: "We watch this manager's SEC 13F filings and email you a fresh holdings + changes report each time they file.",
  },
};

export function subscriptionsEnabled() {
  return Boolean((process.env.STRIPE_SECRET_KEY || "").trim());
}
const webhookSecret = () => (process.env.STRIPE_WEBHOOK_SECRET || "").trim();

const STORE_PATH = () => join(existsSync("/data") ? "/data" : "/tmp", "stripe-subscriptions.json");
const MAX_STORE = 20000;

function loadStore(path) {
  try { return new Map(Object.entries(JSON.parse(readFileSync(path, "utf8")))); } catch { return new Map(); }
}
function saveStore(path, map) {
  try {
    const entries = [...map.entries()];
    const keep = entries.length > MAX_STORE ? entries.slice(-MAX_STORE) : entries;
    writeFileSync(path, JSON.stringify(Object.fromEntries(keep)));
  } catch { /* best-effort */ }
}

/**
 * @param {object} deps
 * @param {import("stripe")} deps.stripe
 * @param {string} deps.baseUrl
 * @param {string} [deps.storePath]  override for tests
 */
export function createStripeSubscriptions({ stripe, baseUrl, storePath }) {
  const path = storePath || STORE_PATH();
  const store = loadStore(path);          // subId -> record

  function upsert(subId, patch) {
    if (!subId) return;
    const prev = store.get(subId) || {};
    store.set(subId, { ...prev, ...patch, updatedAt: new Date().toISOString() });
    saveStore(path, store);
  }

  // Create a subscription Checkout Session for a monitor product + target.
  async function createCheckout(productKey, targetValue) {
    const p = MONITOR_PRODUCTS[productKey];
    if (!p) { const e = new Error("Unknown monitor product"); e.statusCode = 400; throw e; }
    const target = String(targetValue ?? "").trim();
    if (!target) { const e = new Error(`Please provide ${p.inputLabel}.`); e.statusCode = 400; throw e; }
    if (target.length > 200) { const e = new Error("Input is too long."); e.statusCode = 400; throw e; }
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: p.price,
          recurring: { interval: "month" },
          product_data: { name: p.label, description: `Monitoring: ${target.slice(0, 120)}` },
        },
      }],
      // metadata rides on BOTH the session and the subscription, so either the
      // success page or the webhook can recover product + target.
      metadata: { product: productKey, target: target.slice(0, 180) },
      subscription_data: { metadata: { product: productKey, target: target.slice(0, 180) } },
      success_url: `${baseUrl}/monitors/thanks?session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/monitors?canceled=1`,
      allow_promotion_codes: true,
    });
    return { id: session.id, url: session.url };
  }

  // Called by the success page: verify the session is a PAID subscription and
  // record it immediately (does not depend on the webhook being configured).
  async function recordFromSession(sessionId) {
    if (typeof sessionId !== "string" || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return { status: "invalid" };
    let session;
    try { session = await stripe.checkout.sessions.retrieve(sessionId); } catch { return { status: "not_found" }; }
    if (!session || session.mode !== "subscription") return { status: "invalid" };
    if (session.payment_status !== "paid" && session.status !== "complete") return { status: "unpaid" };
    const subId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
    if (!subId) return { status: "pending" };
    const rec = {
      subId, customer: session.customer, status: "active",
      product: session.metadata?.product || null,
      target: session.metadata?.target || null,
      email: session.customer_details?.email || session.customer_email || null,
      createdAt: store.get(subId)?.createdAt || new Date().toISOString(),
    };
    upsert(subId, rec);
    const p = MONITOR_PRODUCTS[rec.product];
    return { status: "active", subId, customer: rec.customer, product: rec.product, label: p?.label || "monitor", target: rec.target };
  }

  // Signature-verified webhook. Never trusts an unverified body: without the
  // secret it refuses (401), and a bad signature 400s.
  async function handleWebhook(rawBody, signature) {
    const secret = webhookSecret();
    if (!secret) { const e = new Error("Webhook not configured (STRIPE_WEBHOOK_SECRET unset)"); e.statusCode = 401; throw e; }
    let event;
    try { event = stripe.webhooks.constructEvent(rawBody, signature, secret); }
    catch (err) { const e = new Error(`Webhook signature verification failed: ${err.message}`); e.statusCode = 400; throw e; }
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object;
        if (s.mode === "subscription" && s.subscription) {
          upsert(typeof s.subscription === "string" ? s.subscription : s.subscription.id, {
            customer: s.customer, status: "active",
            product: s.metadata?.product || null, target: s.metadata?.target || null,
            email: s.customer_details?.email || s.customer_email || null,
          });
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object;
        upsert(sub.id, {
          customer: sub.customer, status: sub.status,
          product: sub.metadata?.product || store.get(sub.id)?.product || null,
          target: sub.metadata?.target || store.get(sub.id)?.target || null,
          currentPeriodEnd: sub.current_period_end || null,
          cancelAtPeriodEnd: !!sub.cancel_at_period_end,
        });
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        upsert(sub.id, { status: "canceled" });
        break;
      }
      default: break; // ignore unrelated events
    }
    return { received: true, type: event.type };
  }

  // Stripe-hosted Customer Portal for self-serve manage/cancel.
  async function portalSession(customerId) {
    if (!customerId) { const e = new Error("No customer"); e.statusCode = 400; throw e; }
    const s = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: `${baseUrl}/monitors` });
    return { url: s.url };
  }

  // Active subscriptions for a given product kind (the scheduler in 2b reads these).
  function listActive(kind) {
    const out = [];
    for (const rec of store.values()) {
      if (rec.status === "active" && (!kind || MONITOR_PRODUCTS[rec.product]?.kind === kind)) out.push(rec);
    }
    return out;
  }
  const get = (subId) => store.get(subId) || null;

  return { createCheckout, recordFromSession, handleWebhook, portalSession, listActive, get, _store: store };
}
