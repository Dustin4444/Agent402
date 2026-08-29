// Typed 200 response schemas for /openapi.json, derived from each tool's own
// documented example.
//
// Every JSON tool used to declare `schema: { type: "object" }` with a rich
// `example` beside it. A human reads the example; a MACHINE reads the schema,
// and an untyped object promises nothing - an outside audit of
// /api/unemployment-rate on 2026-08-29 reported `properties_missing` +
// `required_fields_missing` and could not confirm the response carries the
// `current`, `history` and `source` fields our own example shows. That was a
// fair finding about all 560 routes, not one of them.
//
// `required` is a PROMISE, so it is only made where CI already keeps it: the
// catalog sweeps assert that every 200 carries its documented top-level keys
// (missingDocumentedKeys), with SHAPE_HAPPY_PATH_ONLY excusing the handful of
// tools whose shape legitimately varies with the outcome. Those declare typed
// properties and require nothing. Nested objects are typed but never required -
// only the top level is CI-enforced.

// Paths whose documented example is the HAPPY PATH and whose live shape varies
// (a lookup that finds nothing, a probe whose target behaves differently). The
// catalog sweeps skip the shape check here, so we must not promise `required`.
export const SHAPE_HAPPY_PATH_ONLY = new Set([
  "/api/x402-quote",   // example shows 402-detected case; placeholder URL may not 402
  "/api/x402-audit",   // example shows a graded 402; live target's grade/checks vary by seller
  "/api/tx-status",    // example shows success; 0x0…0 hash returns {status:"not_found"}
  "/api/x402-verify",  // example shows verified settlement; 0x0…0 hash returns {status:"not_found"}
  "/api/mev-block-payment", // example shows found=true; placeholder block 22000000 returns {found:false}
  "/api/x402-market-pulse", // example shows populated providers/categories; a cold test boot (crawler + leaderboard not warm) returns empty arrays
]);

const MAX_DEPTH = 4;      // deep enough for our shapes, shallow enough to bound the doc
const MAX_PROPS = 40;     // a wide map (per-chain totals, per-model rows) is data, not shape
const MAX_ARRAY_PROBE = 1; // items are homogeneous in every example we ship

/** JSON Schema for one example value. Types only: no enums, no formats, no
 *  constraints - anything we cannot guarantee at runtime is not declared. */
export function schemaFromExample(value, depth = 0) {
  if (value === null || value === undefined) return {}; // unconstrained: the example says nothing about the type
  if (Array.isArray(value)) {
    const schema = { type: "array" };
    if (value.length && depth < MAX_DEPTH) {
      const item = schemaFromExample(value[0], depth + 1);
      if (Object.keys(item).length) schema.items = item;
    }
    return schema;
  }
  const t = typeof value;
  if (t === "string") return { type: "string" };
  if (t === "boolean") return { type: "boolean" };
  if (t === "number") return Number.isInteger(value) ? { type: "integer" } : { type: "number" };
  if (t !== "object") return {};
  const schema = { type: "object" };
  if (depth >= MAX_DEPTH) return schema;
  const keys = Object.keys(value).slice(0, MAX_PROPS);
  if (!keys.length) return schema;
  const properties = {};
  for (const k of keys) {
    const sub = schemaFromExample(value[k], depth + 1);
    properties[k] = Object.keys(sub).length ? sub : {};
  }
  schema.properties = properties;
  return schema;
}

/** The 200 schema for a tool: typed properties from its example, and a
 *  `required` list only where the sweeps enforce it. */
export function responseSchemaFor(path, example) {
  if (!example || typeof example !== "object" || Array.isArray(example)) return { type: "object" };
  const schema = schemaFromExample(example);
  if (schema.type !== "object" || !schema.properties) return { type: "object" };
  if (SHAPE_HAPPY_PATH_ONLY.has(path)) return schema;
  // Only keys whose example value is non-null: a null example value tells us
  // the field exists but not that it always carries a value, and requiring it
  // would promise more than the example shows.
  const required = Object.keys(schema.properties).filter((k) => example[k] !== null && example[k] !== undefined);
  if (required.length) schema.required = required;
  return schema;
}
