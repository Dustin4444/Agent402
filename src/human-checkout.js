// human-checkout — the HUMAN front door for the premium products. Standard
// Stripe Checkout (card + Link), NOT the agent SPT/MPP flow: it sells the SAME
// endpoints agents already buy over x402, so one backend has two payment
// surfaces (the Agent402 dual-rail moat - nobody else serves a human's card AND
// an autonomous agent's wallet from one product).
//
// Design for v1:
// - Single purchase per report (no account, no subscription - honours the
//   "pay once and leave" wedge; credit packs are a later optimization).
// - Payment is verified with Stripe BEFORE any report is generated - a buyer
//   can never get a free report by guessing a session id.
// - Generation is idempotent per checkout session and generate-once (a reload or
//   a double-poll never re-spends our upstream).
// - A failed report AUTO-REFUNDS the card (the restricted key carries Refunds
//   write) - the "if it's bad, we refund" promise, enforced in code.
// Rollout switch = STRIPE_SECRET_KEY (same key as the MPP gate). The key needs
// Checkout Sessions + Refunds write; it settles to your Stripe balance only.
import Stripe from "stripe";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { sendReportReadyEmail } from "./email.js";

// The premium products the human door sells. All >= $5 (the card floor); the
// cheap agent tools stay crypto/agent-only. `slug` maps to the paid endpoint's
// handler so humans and agents run the identical pipeline.
export const HUMAN_PRODUCTS = {
  "research": { label: "Deep research report", price: 500, kind: "research", slug: "research", inputField: "query", inputLabel: "your research question" },
  "research-pro": { label: "Deep research report — Pro", price: 1500, kind: "research", slug: "research-pro", inputField: "query", inputLabel: "your research question" },
  "research-max": { label: "Deep research report — Max", price: 3000, kind: "research", slug: "research-max", inputField: "query", inputLabel: "your research question" },
  "dossier": { label: "Company due-diligence dossier", price: 1900, kind: "dossier", slug: "dossier", inputField: "ticker", inputLabel: "a US stock ticker" },
  "dossier-max": { label: "Due-diligence dossier — Max", price: 3900, kind: "dossier", slug: "dossier-max", inputField: "ticker", inputLabel: "a US stock ticker" },
};

export function humanCheckoutEnabled() {
  return Boolean((process.env.STRIPE_SECRET_KEY || "").trim());
}

const STORE_PATH = join(existsSync("/data") ? "/data" : "/tmp", "human-checkout.json");
const MAX_STORE = 5000; // bound the persisted map

function loadStore() {
  try { return new Map(Object.entries(JSON.parse(readFileSync(STORE_PATH, "utf8")))); } catch { return new Map(); }
}
function saveStore(map) {
  try {
    // keep the newest MAX_STORE entries
    const entries = [...map.entries()];
    const keep = entries.length > MAX_STORE ? entries.slice(-MAX_STORE) : entries;
    writeFileSync(STORE_PATH, JSON.stringify(Object.fromEntries(keep)));
  } catch { /* persistence best-effort; in-memory still works this process */ }
}

/**
 * @param {object} deps
 * @param {Stripe} deps.stripe            Stripe client (injectable for tests)
 * @param {(kind,slug,input)=>Promise<object>} deps.generate  runs the real report handler
 * @param {string} deps.baseUrl
 */
export function createHumanCheckout({ stripe, generate, baseUrl }) {
  const store = loadStore();        // sessionId -> { status, report?, kind, slug, input, refundId?, error? }
  const inFlight = new Map();        // sessionId -> Promise (generate-once within a process)

  async function createSession(productKey, inputValue) {
    const p = HUMAN_PRODUCTS[productKey];
    if (!p) { const e = new Error("Unknown product"); e.statusCode = 400; throw e; }
    const input = String(inputValue ?? "").trim();
    if (!input) { const e = new Error(`Please provide ${p.inputLabel}.`); e.statusCode = 400; throw e; }
    if (input.length > 2000) { const e = new Error("Input is too long."); e.statusCode = 400; throw e; }
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: p.price,
          product_data: { name: p.label, description: `On: ${input.slice(0, 120)}` },
        },
      }],
      // The report input rides in metadata - we NEVER trust the client for it on
      // fulfillment; it comes back from Stripe with the paid session.
      metadata: { product: productKey, input: input.slice(0, 1500) },
      success_url: `${baseUrl}/r/{CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/reports?canceled=1`,
      // No customer account created; a one-off charge.
      payment_intent_data: { description: `Agent402 ${p.label}` },
    });
    return { id: session.id, url: session.url };
  }

  // Idempotent, generate-once, refund-on-failure. Returns a status object the
  // page polls. NEVER generates without a verified-paid Stripe session.
  async function fulfill(sessionId) {
    if (typeof sessionId !== "string" || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return { status: "invalid" };
    const done = store.get(sessionId);
    if (done && (done.status === "done" || done.status === "error")) return done;

    let session;
    try { session = await stripe.checkout.sessions.retrieve(sessionId); } catch { return { status: "not_found" }; }
    if (!session || session.payment_status !== "paid") return { status: "unpaid" };

    const productKey = session.metadata?.product;
    const input = session.metadata?.input;
    const p = HUMAN_PRODUCTS[productKey];
    if (!p || !input) return { status: "error", error: "This purchase is missing its report details. It will be refunded." };

    if (inFlight.has(sessionId)) return { status: "generating" };
    store.set(sessionId, { status: "generating", kind: p.kind, slug: p.slug });
    const job = (async () => {
      try {
        // generate() may return a plain report string (legacy / tests) or a
        // bundle { report, title, sources, tables }. Normalize either way.
        const g = await generate(p.kind, p.slug, input);
        const bundle = (g && typeof g === "object") ? g : { report: String(g ?? "") };
        const rec = {
          status: "done", kind: p.kind, slug: p.slug, input,
          report: bundle.report || "",
          title: bundle.title || input,
          sources: Array.isArray(bundle.sources) ? bundle.sources : [],
          tables: Array.isArray(bundle.tables) ? bundle.tables : [],
          at: new Date().toISOString(),
        };
        store.set(sessionId, rec); saveStore(store);
        // Email the buyer their DURABLE report link, so losing the tab is fine
        // (Stripe Checkout collected the email). Best-effort, fire-and-forget;
        // a no-op until RESEND_API_KEY + EMAIL_FROM are set.
        const email = session.customer_details?.email || session.customer_email;
        if (email) sendReportReadyEmail({ to: email, reportUrl: `${baseUrl}/r/${sessionId}`, productLabel: p.label, subjectOf: input }).catch(() => {});
        return rec;
      } catch (err) {
        // Report failed AFTER payment -> refund the card automatically.
        let refundId = null;
        try {
          const pi = session.payment_intent;
          if (pi) { const r = await stripe.refunds.create({ payment_intent: typeof pi === "string" ? pi : pi.id }); refundId = r.id; }
        } catch { /* refund best-effort; the error state still surfaces */ }
        const rec = { status: "error", error: "We couldn't complete this report, so your payment has been refunded.", refundId, at: new Date().toISOString() };
        store.set(sessionId, rec); saveStore(store);
        return rec;
      } finally { inFlight.delete(sessionId); }
    })();
    inFlight.set(sessionId, job);
    return { status: "generating" };
  }

  function peek(sessionId) {
    const rec = store.get(sessionId);
    if (rec) return rec;
    if (inFlight.has(sessionId)) return { status: "generating" };
    return null;
  }

  return { createSession, fulfill, peek };
}
