// `accepts[0].outputSchema` on our own 402: the x402 v2 field a buyer reads at
// the moment of deciding to pay, carrying the SAME bounded typed schema the
// Bazaar discovery extension already carries (boundedSchemaFromExample,
// 2026-08-29) - one copy, on the first accept only.
//
// Why only one copy, and why here rather than in the route config:
//   * A buyer echoes the whole challenge back inside its payment payload, so
//     thirteen rails x ~400 bytes of schema is structurally unaffordable; the
//     first accept (Base, the rail every stock client takes first) is where
//     the field earns its bytes. Measured 2026-09-02 on prod's widest sampled
//     challenge (11,108 bytes, the nano chat route): +~540 bytes stays under
//     the 12,000-byte ceiling test-challenge-size enforces.
//   * @x402/core's buildPaymentRequirements copies scheme, network, amount,
//     asset, payTo, maxTimeoutSeconds and extra from a route accept and
//     nothing else, so the field cannot be declared upstream; it is added to
//     the built header on the way out, the same seam the MPP shim uses.
//   * Safe for verification: the core matches a buyer's echoed `accepted`
//     entry by scheme + network only, and PaymentRequirementsSchema admits
//     `outputSchema` (Any.optional().nullable()).
//
// MOUNT ORDER: after mppShim. res.writeHead wrappers compose LIFO, so the
// last-registered hook runs first; this one enriches PAYMENT-REQUIRED and
// delegates inward, and the shim then mints its evm challenge from the
// enriched accept (the accept rides the challenge verbatim).
const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";

/** Pure: the encoded header with outputSchema on accepts[0]; unchanged when there is nothing to add. */
export function withOutputSchemaOnFirstAccept(encoded) {
  try {
    const raw = Buffer.from(String(encoded), "base64").toString("utf8");
    const pr = JSON.parse(raw);
    const first = Array.isArray(pr?.accepts) ? pr.accepts[0] : null;
    const schema = pr?.extensions?.bazaar?.schema?.properties?.output?.properties?.example;
    if (!first || !schema || typeof schema !== "object" || first.outputSchema !== undefined) return { encoded: String(encoded), changed: false };
    pr.accepts[0] = { ...first, outputSchema: schema };
    return { encoded: Buffer.from(JSON.stringify(pr), "utf8").toString("base64"), changed: true };
  } catch { return { encoded: String(encoded), changed: false }; }
}

export function createOutputSchemaAppender() {
  return function outputSchemaAppender(_req, res, next) {
    const origWriteHead = res.writeHead;
    res.writeHead = function outputSchemaWriteHead(...args) {
      try {
        if (res.statusCode === 402) {
          const pr = res.getHeader(PAYMENT_REQUIRED_HEADER);
          if (pr) {
            const { encoded, changed } = withOutputSchemaOnFirstAccept(String(pr));
            if (changed) res.setHeader(PAYMENT_REQUIRED_HEADER, encoded);
          }
        }
      } catch { /* a missing field is the pre-2026-09-02 shape, never a failed 402 */ }
      return origWriteHead.apply(this, args);
    };
    next();
  };
}
