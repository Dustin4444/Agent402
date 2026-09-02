#!/usr/bin/env node
// accepts[0].outputSchema on our 402 (src/accept-output-schema.js): pure
// rewrite of the PAYMENT-REQUIRED header, one copy on the first accept only,
// unchanged when there is nothing to add, mounted after the MPP shim.
import { readFileSync } from "node:fs";
import { withOutputSchemaOnFirstAccept } from "../src/accept-output-schema.js";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const dec = (s) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));
const schema = { type: "object", properties: { hex: { type: "string" } }, required: ["hex"] };
const pr = { x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", amount: "1000" }, { scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", amount: "1000" }], extensions: { bazaar: { info: {}, schema: { properties: { output: { properties: { example: schema } } } } } } };
{
  const r = withOutputSchemaOnFirstAccept(enc(pr));
  const out = dec(r.encoded);
  ok(r.changed && JSON.stringify(out.accepts[0].outputSchema) === JSON.stringify(schema), "the first accept gains the extension's typed output schema");
  ok(out.accepts[1].outputSchema === undefined, "the second accept carries none (one copy, the buyer echoes the challenge back)");
  ok(JSON.stringify(out.extensions) === JSON.stringify(pr.extensions) && out.accepts[0].amount === "1000", "everything else is byte-for-byte the same");
  const again = withOutputSchemaOnFirstAccept(r.encoded);
  ok(again.changed === false && again.encoded === r.encoded, "idempotent: an accept that already carries one is left alone");
}
{
  const none = withOutputSchemaOnFirstAccept(enc({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453" }], extensions: {} }));
  ok(none.changed === false, "no extension schema -> unchanged (a schema is never invented)");
  const bad = withOutputSchemaOnFirstAccept("not base64 json");
  ok(bad.changed === false && bad.encoded === "not base64 json", "an undecodable header is passed through untouched, never a failed 402");
  const empty = withOutputSchemaOnFirstAccept(enc({ ...pr, accepts: [] }));
  ok(empty.changed === false, "no accepts -> unchanged");
}
{
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(src.indexOf("app.use(mppShim);") > 0 && src.indexOf("app.use(createOutputSchemaAppender());") > src.indexOf("app.use(mppShim);"), "mounted AFTER the MPP shim (LIFO writeHead wrappers: this one runs first, the shim mints its challenge from the enriched accept)");
  const between = src.slice(src.indexOf("app.use(mppShim);"), src.indexOf("app.use(createOutputSchemaAppender());"));
  ok(!/app\.use\(/.test(between.replace("app.use(mppShim);", "")), "and directly after it (nothing else mounts in between)");
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
