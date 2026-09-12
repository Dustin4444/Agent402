#!/usr/bin/env node
// Grade what an x402 seller DELIVERED against what its own 402 PROMISED.
//
// Paying a seller proves the payment rail works. It does not prove the tool
// works, and those are different products: a seller that takes $0.02 and
// answers `{}` passes every payability check ever written. This repo has hit
// that shape four times in its OWN catalog - a demand radar that sold an empty
// array for six weeks, four skill packs answering "0/N steps succeeded" as a
// 200 for two months - and each time the fix was to compare the answer against
// the documented example rather than against a status code.
//
// The seller hands us the contract itself. Measured on 46 live Base sellers
// (2026-09-12): 31 publish an output EXAMPLE and 5 an output SCHEMA in the
// bazaar discovery extension of the 402 they give every buyer. 10 publish
// nothing, and those can only ever be graded "unknown" - an honest absence,
// never a failure. Note `accepts[].outputSchema`, the field the x402 spec
// defines for exactly this, was absent on every seller sampled.
//
// PURE. No network, no clock. The driver does the paying; this decides what
// the result means, so the judgement can be tested without spending anything.
//
// These are deliberately NOT scripts/sweep-shape.js's functions, though they
// are modelled on them: those carry SKIP and EMPTY_ARRAY_OK lists keyed by OUR
// route paths, which are excuses we granted ourselves after investigating our
// own tools. Pointing our own excuse list at a stranger would let a seller
// inherit a pass we wrote for ourselves.

/** The output contract a seller publishes in its own 402, or null. */
export function readOutputContract(challenge) {
  if (!challenge || typeof challenge !== "object") return null;
  // The spec field first, when anyone ever sets it.
  const accepts = Array.isArray(challenge.accepts) ? challenge.accepts : [];
  for (const a of accepts) {
    const s = a?.outputSchema;
    if (s && typeof s === "object" && (s.properties || s.example)) {
      return s.example ? { kind: "example", value: s.example } : { kind: "schema", value: s };
    }
  }
  // Else the bazaar discovery extension, which is what sellers actually carry.
  const found = [];
  const walk = (v, depth = 0) => {
    if (!v || typeof v !== "object" || depth > 8) return;
    if (v.output && typeof v.output === "object") found.push(v.output);
    for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(challenge);
  for (const o of found) {
    if (o.example && typeof o.example === "object" && !Array.isArray(o.example)) return { kind: "example", value: o.example };
    if (o.properties && typeof o.properties === "object") return { kind: "schema", value: o };
    if (o.schema && typeof o.schema === "object") {
      if (o.schema.example) return { kind: "example", value: o.schema.example };
      if (o.schema.properties) return { kind: "schema", value: o.schema };
    }
  }
  return null;
}

/**
 * Dotted paths a seller's OWN OpenAPI guarantees on success, that the answer
 * does not carry. This is the primary contract: our crawler already extracts
 * it per route as `responseContract.guaranteedPaths`, beside a field named
 * `runtimeVerified` that has been false on every row since the day it shipped,
 * because nothing ever paid a seller to find out. That is the gap this closes.
 *
 * A path is satisfied when it RESOLVES, not when it is truthy: a guaranteed
 * field that is present and null or 0 or "" is still delivered, and calling
 * that a breach would fail every honest empty answer.
 */
export function missingGuaranteedPaths(paths, body) {
  if (!Array.isArray(paths) || !paths.length) return [];
  if (!body || typeof body !== "object") return [];
  body = unwrapForContract(paths.filter((p) => !String(p).includes(".")), body); // same envelope rule, on the top-level names only
  const has = (p) => {
    let cur = body;
    for (const seg of String(p).split(".")) {
      if (Array.isArray(cur)) cur = cur[0];           // a guaranteed path under an array means "on each element"
      if (!cur || typeof cur !== "object" || !(seg in cur)) return false;
      cur = cur[seg];
    }
    return true;
  };
  // A parent that is missing explains its children; report the shallowest.
  const missing = paths.filter((p) => !has(p));
  return missing.filter((p) => !missing.some((q) => q !== p && p.startsWith(q + ".")));
}

/** Keys the example promises that the body does not carry. */
/**
 * An answer may be WRAPPED. The first live run flagged a seller as hollow for
 * returning `{ok, data, settlement}` against a promised
 * `{eth_usd, change_24h, seller, network}` - and the promised fields were
 * almost certainly inside `data`. Comparing top-level keys alone turns a
 * perfectly good envelope into an accusation.
 *
 * So: if the promised keys are not at the top level, look one level down
 * through the body's own object-valued properties and accept the first place
 * they ALL resolve. Only a shape that satisfies the contract nowhere is a
 * breach. Deliberately one level and "all or nothing": a deeper hunt, or
 * accepting a partial match, would find the promised names somewhere in almost
 * any document and grade everything a pass.
 */
export function unwrapForContract(keys, body) {
  if (!Array.isArray(keys) || !keys.length) return body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const satisfies = (o) => o && typeof o === "object" && !Array.isArray(o) && keys.every((k) => k in o);
  if (satisfies(body)) return body;
  for (const v of Object.values(body)) if (satisfies(v)) return v;
  return body;
}

export function missingPromisedKeys(example, body) {
  if (!example || typeof example !== "object" || Array.isArray(example)) return [];
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const inner = unwrapForContract(Object.keys(example), body);
  const actual = Object.keys(inner);
  return Object.keys(example).filter((k) => !actual.includes(k));
}

/** Arrays the example shows NON-EMPTY that came back empty. The hollow-200
 *  shape: every promised key present, every one of them empty. */
export function emptyPromisedArrays(example, body) {
  if (!example || typeof example !== "object" || Array.isArray(example)) return [];
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  body = unwrapForContract(Object.keys(example), body); // same envelope rule as above
  return Object.entries(example)
    .filter(([, v]) => Array.isArray(v) && v.length > 0)
    .filter(([k]) => Array.isArray(body[k]) && body[k].length === 0)
    .map(([k]) => k);
}

/** Required (or, absent a required list, declared) properties a schema
 *  promises that the body does not carry. */
export function missingSchemaProperties(schema, body) {
  if (!schema || typeof schema !== "object") return [];
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const props = schema.properties && typeof schema.properties === "object" ? Object.keys(schema.properties) : [];
  if (!props.length) return [];
  const required = Array.isArray(schema.required) && schema.required.length ? schema.required : props;
  const actual = Object.keys(unwrapForContract(required, body)); // same envelope rule
  return required.filter((k) => props.includes(k) && !actual.includes(k));
}

/**
 * ONE verdict for one seller, from facts the driver observed.
 *
 * The vocabulary is deliberately narrow, and every word of it is defensible
 * from what we did: we paid, or could not, and the answer matched the shape
 * they published, or did not. NOTHING here says a seller is broken, or bad, or
 * that their service does not work - a response can carry every promised key
 * and wrong numbers in all of them, and no shape check can see that. The claim
 * stops at "it delivered the shape it promised".
 */
export const VERDICTS = Object.freeze({
  no_challenge: "the endpoint did not answer a readable 402, so there was nothing to pay",
  no_base_accept: "the 402 named no exact/Base accept a stock client could sign",
  over_cap: "the seller's quote was above this run's per-seller cap, so it was not paid",
  input_rejected: "the seller rejected the REQUEST (a 4xx other than 402/401), so the call never reached the question of payment. Per x402 settlement ordering a >= 400 cancels settlement, so nobody was charged - and this says nothing about whether the seller can be paid. Usually it means the body we sent was not the body they wanted",
  payment_refused: "a stock client's payment was presented and not accepted (402 or 401 on the paid retry), so nothing settled",
  served_no_receipt: "the seller answered 200 but sent no settle receipt, so we cannot show a payment moved. It served us; whether it charged us is not visible from here",
  seller_error: "the seller's own backend failed (5xx). Per settlement ordering nobody was charged",
  paid_no_answer: "the payment settled and the seller returned no usable body",
  paid_hollow: "the payment settled and the answer is missing keys the seller's own 402 promised, or promised arrays came back empty",
  paid_ungraded: "the payment settled and the seller publishes nothing about its output, so the answer cannot be checked against anything",
  paid_delivers: "the payment settled and the answer carries the shape the seller's own 402 promised",
});

export function verdictFor({ challengeReadable, baseAccept, quoteUsd, capUsd, settled, status, body, contract }) {
  if (!challengeReadable) return { verdict: "no_challenge" };
  if (!baseAccept) return { verdict: "no_base_accept" };
  if (Number.isFinite(quoteUsd) && Number.isFinite(capUsd) && quoteUsd > capUsd) return { verdict: "over_cap", quoteUsd };
  // WHY IT DID NOT SETTLE MATTERS, and the first live run proved it: 14 of 21
  // "refusals" were HTTP 400 - the seller rejecting the BODY we sent, which
  // never reaches the question of payment - and one was a plain 200. Reporting
  // those as refused payments would have published a claim about 15 sellers
  // that was really a fact about our request.
  if (!settled) {
    const st = Number(status);
    if (st === 200) return { verdict: "served_no_receipt", status: st };
    if (st >= 500) return { verdict: "seller_error", status: st };
    if (st === 402 || st === 401) return { verdict: "payment_refused", status: st };
    if (st >= 400) return { verdict: "input_rejected", status: st };
    return { verdict: "payment_refused", status: Number.isFinite(st) ? st : null };
  }
  const hasBody = body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length > 0;
  if (!hasBody) return { verdict: "paid_no_answer", status: status ?? null };
  if (!contract) return { verdict: "paid_ungraded", status: status ?? null };
  const missing = contract.kind === "paths" ? missingGuaranteedPaths(contract.value, body)
    : contract.kind === "example" ? missingPromisedKeys(contract.value, body)
    : missingSchemaProperties(contract.value, body);
  const empty = contract.kind === "example" ? emptyPromisedArrays(contract.value, body) : [];
  if (missing.length || empty.length) return { verdict: "paid_hollow", missingKeys: missing, emptyArrays: empty, status: status ?? null };
  return { verdict: "paid_delivers", status: status ?? null };
}

/**
 * The accept filter for ONE seller: Base exact only, at or under the cap, paid
 * to the payee that seller's own bare 402 named.
 *
 * Exported and pure because the sweep's first live run failed 44 of 45 sellers
 * on it. `x402Client.registerPolicy` ACCUMULATES - registering a fresh policy
 * per seller inside the loop left the client holding every previous seller's
 * payee as well, and no accept can be paid to two different addresses, so
 * every seller after the first was structurally unpayable ("All payment
 * requirements were filtered out by policies"). The bug failed CLOSED, so
 * nothing was spent, but the run reported 44 sellers as refusing payment when
 * the refusal was ours.
 *
 * The rule itself was never wrong; the state it lived in was. So it lives here
 * now, as a function of its inputs with nowhere to accumulate, and the driver
 * builds a fresh client per seller.
 */
export function acceptFilterFor({ payTo, maxAtomic }) {
  const want = String(payTo || "").toLowerCase();
  return (r) => {
    if (!want) return false;
    let amt; try { amt = BigInt(String(r?.amount)); } catch { return false; }
    return r?.scheme === "exact" && r?.network === "eip155:8453"
      && String(r?.payTo || "").toLowerCase() === want && amt <= maxAtomic;
  };
}
