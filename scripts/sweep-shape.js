// Shared by the two catalog sweeps (test-all.js, test-non-metered-examples.js):
// "does a 200 carry every key its documented example promises?" Lives here so
// the strict sweep can take over the routes it covers from the lenient one
// without either losing the shape check - one endpoint, one hit, both checks.
// The skiplist lives in src/openapi-schema.js and is re-exported here: the
// same set decides which routes may declare `required` in /openapi.json, so a
// route excused from the shape check can never promise a shape in the spec.
export { SHAPE_HAPPY_PATH_ONLY } from "../src/openapi-schema.js";
import { SHAPE_HAPPY_PATH_ONLY as SKIP } from "../src/openapi-schema.js";

/** Documented top-level keys of the 200 example that the body lacks ([] when
 *  there is nothing to compare: no example, non-object body, opted-out path). */
export function missingDocumentedKeys(path, op, body) {
  if (SKIP.has(path)) return [];
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const example = op?.responses?.["200"]?.content?.["application/json"]?.example;
  if (!example || typeof example !== "object" || Array.isArray(example)) return [];
  const expected = Object.keys(example);
  if (!expected.length) return [];
  const actual = Object.keys(body);
  return expected.filter((k) => !actual.includes(k));
}
