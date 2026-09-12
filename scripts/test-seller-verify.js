#!/usr/bin/env node
// The judgement half of the seller sweep, tested without spending anything.
//
// The sweep pays real money to strangers and then publishes a verdict about
// them, so the verdict has to be right for reasons that survive someone
// disagreeing with it. Every case here is a shape observed on a live seller's
// own 402 on 2026-09-12, or a shape this repo has shipped itself and been
// caught by.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { readOutputContract, missingGuaranteedPaths, missingPromisedKeys, emptyPromisedArrays, missingSchemaProperties, verdictFor, VERDICTS } from "./seller-verify-core.mjs";

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); n++; };

// --- reading the contract out of a real challenge ----------------------------
{
  // The shape agentoracle.co actually publishes (bazaar extension, example).
  const withExample = { accepts: [{ scheme: "exact", network: "eip155:8453", extra: {} }],
    extensions: { bazaar: { schema: { properties: { output: { type: "json", example: { summary: "…", key_facts: ["a"], sources: [{ title: "x" }] } } } } } } };
  const c1 = readOutputContract(withExample);
  eq(c1.kind, "example", "an output EXAMPLE nested anywhere in the challenge is found (31 of 46 live sellers publish this shape)");
  eq(Object.keys(c1.value).sort(), ["key_facts", "sources", "summary"], "...with its promised keys");

  // The shape api.vibe.airforce publishes (properties, no example).
  const withSchema = { accepts: [{}], extensions: { bazaar: { output: { type: "object", properties: { data: { type: "object" } } } } } };
  eq(readOutputContract(withSchema).kind, "schema", "an output SCHEMA is found too (5 of 46)");

  // The spec field wins when anyone sets it.
  const spec = { accepts: [{ outputSchema: { properties: { a: {} } } }], extensions: { bazaar: { output: { properties: { b: {} } } } } };
  eq(Object.keys(readOutputContract(spec).value.properties), ["a"], "accepts[].outputSchema is preferred over the extension - it is the field the spec defines, even though no live seller set it");

  eq(readOutputContract({ accepts: [{ scheme: "exact" }] }), null, "a seller publishing nothing about its output reads null, not an empty contract (10 of 46)");
  eq(readOutputContract(null), null, "garbage in is null, never a throw - this runs against strangers' documents");
}

// --- the graders -------------------------------------------------------------
{
  const ex = { summary: "…", key_facts: ["a", "b"], sources: [{ title: "x" }] };
  eq(missingPromisedKeys(ex, { summary: "hi", key_facts: ["p"], sources: [{ title: "y" }] }), [], "a complete answer is missing nothing");
  eq(missingPromisedKeys(ex, { summary: "hi" }), ["key_facts", "sources"], "keys the seller promised and did not send are named");
  eq(emptyPromisedArrays(ex, { summary: "hi", key_facts: [], sources: [] }), ["key_facts", "sources"],
     "THE HOLLOW 200: every promised key present and every promised array empty. This passes a status check, a keys check and any payability check ever written, and it is the shape our own demand-radar sold for six weeks");
  eq(emptyPromisedArrays(ex, { summary: "hi", key_facts: ["p"], sources: [{}] }), [], "a populated answer is not hollow");
  eq(missingPromisedKeys(ex, "a string"), [], "a non-object body grades as nothing rather than everything - it is a different failure and paid_no_answer covers it");
  eq(emptyPromisedArrays({ a: [] }, { a: [] }), [], "an example whose own array is EMPTY promises nothing about that array, so an empty answer is not a breach");

  const sch = { properties: { data: {}, meta: {} }, required: ["data"] };
  eq(missingSchemaProperties(sch, { data: 1 }), [], "a schema's REQUIRED list governs when it has one");
  eq(missingSchemaProperties(sch, { meta: 1 }), ["data"], "...and a missing required property is named");
  eq(missingSchemaProperties({ properties: { a: {}, b: {} } }, { a: 1 }), ["b"], "with no required list, the declared properties are the promise");
  eq(missingSchemaProperties({ type: "object" }, { a: 1 }), [], "a schema declaring no properties promises nothing checkable");
}

// --- the verdict is narrow on purpose ----------------------------------------
{
  const base = { challengeReadable: true, baseAccept: {}, quoteUsd: 0.01, capUsd: 0.02, settled: true, status: 200 };
  eq(verdictFor({ ...base, body: { summary: "x", key_facts: ["a"] }, contract: { kind: "example", value: { summary: "…", key_facts: ["a"] } } }).verdict, "paid_delivers", "paid and the shape matches");
  const hollow = verdictFor({ ...base, body: { summary: "x", key_facts: [] }, contract: { kind: "example", value: { summary: "…", key_facts: ["a"] } } });
  eq(hollow.verdict, "paid_hollow", "paid and hollow is its own verdict - the finding nobody else can produce");
  eq(hollow.emptyArrays, ["key_facts"], "...naming what was empty, so the seller can check it themselves");
  eq(verdictFor({ ...base, body: { a: 1 }, contract: null }).verdict, "paid_ungraded", "a seller that publishes nothing is UNGRADED, never failed - an honest absence is not a defect, and calling it one would be the same error we refuse everywhere else");
  eq(verdictFor({ ...base, body: {} }).verdict, "paid_no_answer", "an empty body is its own verdict, before any grading");
  eq(verdictFor({ ...base, settled: false, status: 402 }).verdict, "payment_refused", "a payment that did not settle is not a delivery judgement at all");
  eq(verdictFor({ ...base, quoteUsd: 5 }).verdict, "over_cap", "a quote above the cap is reported, never paid");
  eq(verdictFor({ challengeReadable: false }).verdict, "no_challenge", "no readable 402, nothing to say");
  eq(verdictFor({ challengeReadable: true, baseAccept: null }).verdict, "no_base_accept", "no signable Base accept, nothing to say");

  // Ordering: a cheap seller that refuses payment must not be graded on shape.
  eq(verdictFor({ ...base, settled: false, body: { summary: "x" }, contract: { kind: "example", value: { summary: "…" } } }).verdict, "payment_refused",
     "settlement is checked BEFORE shape: an unpaid response is not evidence about delivery");
}

// --- every verdict is documented, and none of them accuses anyone ------------
{
  const used = ["no_challenge", "no_base_accept", "over_cap", "payment_refused", "paid_no_answer", "paid_hollow", "paid_ungraded", "paid_delivers"];
  for (const v of used) ok(VERDICTS[v], `${v} carries a published sentence explaining it`);
  eq(Object.keys(VERDICTS).sort(), used.sort(), "the vocabulary is closed: a verdict the driver can emit is a verdict a reader can look up");
  const blob = JSON.stringify(VERDICTS).toLowerCase();
  for (const w of ["broken", "bad", "scam", "fraud", "fake", "unreliable"])
    ok(!blob.includes(w), `no verdict calls a seller "${w}" - every sentence describes what WE observed when WE paid, which is the only thing we can defend`);
  ok(/cannot be checked against anything/.test(VERDICTS.paid_ungraded), "the ungraded sentence says why it is unknown rather than implying fault");
  // The claim must stop at shape. A response can carry every promised key and
  // wrong values in all of them, and nothing here can see that.
  const src = readFileSync(new URL("./seller-verify-core.mjs", import.meta.url), "utf8");
  ok(/delivered the shape it promised/.test(src), "the source states the limit of the claim: shape, never correctness");
}

// --- the guaranteed-paths grader, which is the primary contract -------------
// Our crawler already extracts responseContract.guaranteedPaths from each
// seller's own OpenAPI. The row beside it says runtimeVerified:false, and has
// on every row since it shipped, because nothing had ever paid a seller to
// find out. These are the real paths from a live seller (agentoracle.co).
{
  const paths = ["confidence", "query", "result", "result.confidence_score", "result.key_facts", "result.sources", "result.summary"];
  eq(missingGuaranteedPaths(paths, { confidence: 1, query: "q", result: { confidence_score: 1, key_facts: [], sources: [], summary: "" } }), [],
     "every guaranteed path resolving is a pass, even where the values are empty - a guaranteed field that is present and empty was still delivered");
  eq(missingGuaranteedPaths(paths, { confidence: 1, query: "q" }), ["result"],
     "a missing PARENT is reported alone: naming its five children too would be five findings about one fact");
  eq(missingGuaranteedPaths(paths, { confidence: 1, query: "q", result: { summary: "x" } }).sort(),
     ["result.confidence_score", "result.key_facts", "result.sources"],
     "and a partially-delivered parent names exactly the children that are missing");
  eq(missingGuaranteedPaths(["a.b"], { a: { b: null } }), [], "present-and-null RESOLVES: null is an answer, and calling it a breach would fail every honest empty result");
  eq(missingGuaranteedPaths(["rows.id"], { rows: [{ id: 1 }] }), [], "a path under an array is checked against its first element");
  eq(missingGuaranteedPaths([], { a: 1 }), [], "no guaranteed paths promises nothing");
  eq(missingGuaranteedPaths(["a"], null), [], "and a missing body grades as nothing - paid_no_answer covers that case");
  eq(verdictFor({ challengeReadable: true, baseAccept: {}, quoteUsd: 0.01, capUsd: 0.02, settled: true, status: 200,
    body: { confidence: 1, query: "q" }, contract: { kind: "paths", value: paths } }).verdict, "paid_hollow",
    "a paid answer missing a guaranteed path is hollow, graded against the seller's OWN OpenAPI");
}

console.log(`test-seller-verify: ${n} assertions OK`);
