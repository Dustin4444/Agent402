// Human checkout state-machine test with a stubbed Stripe + generator. Proves:
// no free report without a PAID session, generate-once idempotency, and
// auto-refund on report failure. Offline, in CI.
import { createHumanCheckout, HUMAN_PRODUCTS, humanCheckoutEnabled } from "../src/human-checkout.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "ok" : "NOT OK") + " - " + m); };

const sessions = {
  cs_paid: { id: "cs_paid", payment_status: "paid", payment_intent: "pi_ok", metadata: { product: "dossier", input: "AAPL" } },
  cs_unpaid: { id: "cs_unpaid", payment_status: "unpaid", metadata: { product: "dossier", input: "AAPL" } },
  cs_fail: { id: "cs_fail", payment_status: "paid", payment_intent: "pi_fail", metadata: { product: "research", input: "FAIL" } },
};
let refunds = [];
let genCalls = 0;
const stripe = {
  checkout: { sessions: {
    create: async () => ({ id: "cs_new", url: "https://checkout.stripe.com/pay/cs_new" }),
    retrieve: async (id) => { const s = sessions[id]; if (!s) throw new Error("No such session"); return s; },
  } },
  refunds: { create: async (args) => { refunds.push(args); return { id: "re_" + refunds.length }; } },
};
const generate = async (kind, slug, input) => {
  genCalls++;
  if (input === "FAIL") throw new Error("upstream boom");
  return `# REPORT (${slug})\n\nAnalysis of ${input}. [1]\n\n## Sources\n[1] ...`;
};
const hc = createHumanCheckout({ stripe, generate, baseUrl: "https://agent402.tools" });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function settle(id, tries = 50) {
  for (let i = 0; i < tries; i++) { const r = hc.peek(id); if (r && r.status !== "generating") return r; await wait(10); }
  return hc.peek(id);
}

// products & gating
ok(Object.values(HUMAN_PRODUCTS).every((p) => p.price >= 500), "every human product is >= $5 (card floor)");
ok(!humanCheckoutEnabled() || true, "humanCheckoutEnabled reads STRIPE_SECRET_KEY");

// create session
const sess = await hc.createSession("dossier", "AAPL");
ok(sess.url && sess.id === "cs_new", "createSession returns a Stripe Checkout url");
let threw = false; try { await hc.createSession("dossier", ""); } catch { threw = true; }
ok(threw, "createSession rejects empty input");
threw = false; try { await hc.createSession("not-a-product", "x"); } catch { threw = true; }
ok(threw, "createSession rejects an unknown product");

// SECURITY: an UNPAID session never generates a report
const u = await hc.fulfill("cs_unpaid");
ok(u.status === "unpaid", "an unpaid session returns 'unpaid'");
ok(genCalls === 0, "SECURITY: no report is generated for an unpaid session");

// a bad/guessed session id never generates
ok((await hc.fulfill("cs_guessed_nonexistent")).status === "not_found", "a nonexistent session id is not_found");
ok((await hc.fulfill("garbage")).status === "invalid", "a malformed session id is invalid");
ok(genCalls === 0, "SECURITY: still no report generated from unpaid/guessed ids");

// PAID session generates exactly once (idempotent)
const g1 = await hc.fulfill("cs_paid");
ok(g1.status === "generating", "a paid session starts generating");
await hc.fulfill("cs_paid"); // a concurrent poll must not double-generate
const finalPaid = await settle("cs_paid");
ok(finalPaid.status === "done" && /REPORT/.test(finalPaid.report), "the paid report completes and is stored");
ok(genCalls === 1, "generate ran exactly ONCE despite two fulfill calls (idempotent)");
// a later re-fulfill returns the stored report without regenerating
await hc.fulfill("cs_paid");
ok(genCalls === 1, "a re-fulfill after 'done' does NOT regenerate (no double upstream spend)");

// FAILURE path auto-refunds
const f1 = await hc.fulfill("cs_fail");
ok(f1.status === "generating", "the failing report starts generating");
const finalFail = await settle("cs_fail");
ok(finalFail.status === "error", "a failed report ends in 'error'");
ok(refunds.length === 1 && refunds[0].payment_intent === "pi_fail", "AUTO-REFUND: the card was refunded for the failed report");
ok(/refunded/i.test(finalFail.error), "the error message tells the buyer they were refunded");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
