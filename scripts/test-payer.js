// Regression test for payerFromRequest — locks the fix for the header bug that
// silently attributed every standard-X-PAYMENT buyer to null, which broke
// wallet-keyed memory (400 after charging) and nulled payer analytics. The
// existing suites can't catch it: test-memory injects `actor` directly and
// never goes through the HTTP header. Pure-function, offline.
import { payerFromRequest } from "../src/payer.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const req = (headers) => ({ header: (k) => headers[String(k).toLowerCase()] ?? null });
const enc = (from) => Buffer.from(JSON.stringify({ payload: { authorization: { from } } })).toString("base64");
const A = "0xAbC0000000000000000000000000000000000001";
const B = "0xDdD0000000000000000000000000000000000002";

ok(payerFromRequest(req({ "x-payment": enc(A) })) === A.toLowerCase(),
  "reads the standard X-PAYMENT header (the bug returned null here)");
ok(payerFromRequest(req({ "payment-signature": enc(A) })) === A.toLowerCase(),
  "still reads the legacy payment-signature header");
ok(payerFromRequest(req({ "x-payment": enc(A), "payment-signature": enc(B) })) === A.toLowerCase(),
  "X-PAYMENT takes precedence over the legacy header");
ok(payerFromRequest(req({})) === null, "no payment header → null");
ok(payerFromRequest(req({ "x-payment": "not-base64-json!" })) === null, "garbage header → null, no throw");
ok(payerFromRequest(req({ "x-payment": Buffer.from(JSON.stringify({ payload: { authorization: { from: "0xNOTHEX" } } })).toString("base64") })) === null,
  "well-formed payload with an invalid address → null");
ok(payerFromRequest(req({ "x-payment": Buffer.from(JSON.stringify({ from: A })).toString("base64") })) === null,
  "top-level `from` (unsigned field) is NOT accepted — only authorization.from");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
