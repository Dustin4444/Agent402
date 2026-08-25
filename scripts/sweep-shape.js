// Shared by the two catalog sweeps (test-all.js, test-non-metered-examples.js):
// "does a 200 carry every key its documented example promises?" Lives here so
// the strict sweep can take over the routes it covers from the lenient one
// without either losing the shape check - one endpoint, one hit, both checks.
export const SHAPE_HAPPY_PATH_ONLY = new Set([
  "/api/x402-quote",   // example shows 402-detected case; placeholder URL may not 402
  "/api/x402-audit",   // example shows a graded 402; live target's grade/checks vary by seller
  "/api/tx-status",    // example shows success; 0x0…0 hash returns {status:"not_found"}
  "/api/x402-verify",  // example shows verified settlement; 0x0…0 hash returns {status:"not_found"}
  "/api/mev-block-payment", // example shows found=true; placeholder block 22000000 returns {found:false}
  "/api/x402-market-pulse", // example shows populated providers/categories; a cold test boot (crawler + leaderboard not warm) returns empty arrays
]);

/** Documented top-level keys of the 200 example that the body lacks ([] when
 *  there is nothing to compare: no example, non-object body, opted-out path). */
export function missingDocumentedKeys(path, op, body) {
  if (SHAPE_HAPPY_PATH_ONLY.has(path)) return [];
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const example = op?.responses?.["200"]?.content?.["application/json"]?.example;
  if (!example || typeof example !== "object" || Array.isArray(example)) return [];
  const expected = Object.keys(example);
  if (!expected.length) return [];
  const actual = Object.keys(body);
  return expected.filter((k) => !actual.includes(k));
}
