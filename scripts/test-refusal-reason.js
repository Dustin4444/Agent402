// The CLASS of a 4xx, and the promise that the caller's words never ride with it
// (src/refusal-reason.js).
//
// Built after a question telemetry could not answer. The metered chat tier read
// as refusing 89% of callers over twenty days; it was two bursts from bot
// clients, every other day clean, and the first reading was wrong because a
// `tool_call` row records the STATUS and nothing else - a scanner sending
// garbage and a buyer who mistyped one field are the same row. The whole point
// of this module is to make that one GROUP BY, so the two things it must get
// right are: the vocabulary is closed, and no buyer text escapes.
//
//   node scripts/test-refusal-reason.js
const { refusalReason, REFUSAL_REASONS } = await import("../src/refusal-reason.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };

// Real messages, copied from the kits that throw them.
const CASES = [
  ['"model" is required', "missing_required"],
  ['"contents" must be a non-empty array', "missing_required"],
  ['each function declaration needs a "name"', "missing_required"],
  ["code must be 8-14 digits (a UPC/EAN barcode)", "wrong_type"],
  ["Request body must be a JSON object", "wrong_type"],
  ['"generationConfig" must be an object', "wrong_type"],
  ['"parts" is capped at 64', "out_of_range"],
  ['Model "x" is not in the gateway allowlist. GET /v1/models lists every supported model and its tier.', "model_not_allowed"],
  ['Model "google/gemini-2.5-flash" is served by the v1-chat tier - call /v1/gemini (price $0.02/call) instead.', "model_wrong_tier"],
  ["This request was quoted at $0.001 but the body being served quotes $0.4. Nothing was charged; resend the request exactly as it should be served.", "quote_mismatch"],
  ["This request would cost $8.1000 metered, above the $2 per-call cap of /v1/metered/messages - lower max_tokens or the input.", "over_cap"],
  ['"safetySettings" is not supported on this route - this wire cannot honour a safety threshold it does not control upstream.', "unsupported_field"],
  ['"generationConfig.responseMimeType" must be "text/plain" or "application/json" (got text/csv)', "unknown_field_value"],
];
let hit = 0;
for (const [msg, want] of CASES) { const got = refusalReason(msg, 400); if (got === want) hit++; else console.log(`   MISS ${want} != ${got}: ${msg.slice(0, 70)}`); }
ok(hit === CASES.length, `every real refusal message classifies as expected (${hit}/${CASES.length})`);

// The closed-vocabulary promise. This is the one that keeps buyer text out of
// an analytics pipeline: a message we do not recognise must become "other",
// never itself. A 400 routinely quotes what the caller sent.
{
  const secrets = [
    'code must be 8-14 digits, got "sk-live-4f9a2b7c0e1d"',
    "unrecognised: user said 'my password is hunter2'",
    "Bearer a402_deadbeefcafe is not valid",
    "0xAbCdEf0123456789 is not a contract on this chain",
  ];
  let leaked = 0, allInVocab = true;
  for (const s of secrets) {
    const r = refusalReason(s, 400);
    if (!REFUSAL_REASONS.includes(r)) allInVocab = false;
    if (typeof r === "string" && (r.includes("sk-live") || r.includes("hunter2") || r.includes("a402_") || r.includes("0xAbCdEf"))) leaked++;
  }
  ok(leaked === 0, "no caller text, key or address can survive into the reason");
  ok(allInVocab, "every answer is a member of the published vocabulary");
  ok(refusalReason("something we have never seen before", 400) === "other", "an unrecognised message is `other`, so a NEW error string cannot start exporting words");
}

// Only a refusal has a reason. A 5xx is our fault or the upstream's and says
// nothing about the caller's input, so tagging one would invite a GROUP BY that
// reads server errors as user error.
ok(refusalReason("upstream error", 502) === null, "a 5xx carries no reason");
ok(refusalReason("anything", 200) === null, "a success carries no reason");
ok(refusalReason("", 400) === "other", "an empty message still classifies rather than throwing");
ok(refusalReason(undefined, 400) === "other", "a missing message still classifies");
ok(refusalReason("x", 413) === "too_large" && refusalReason("x", 404) === "not_found", "the statuses that speak for themselves are read from the status");

// The vocabulary is a closed set a query can GROUP BY.
ok(new Set(REFUSAL_REASONS).size === REFUSAL_REASONS.length && REFUSAL_REASONS.includes("other"), "the vocabulary is unique and always has a fallback");
ok(Object.isFrozen(REFUSAL_REASONS), "the vocabulary is frozen, so a caller cannot widen it at runtime");

// Wired where it is actually needed: the dispatcher classifies, and the
// telemetry carries the class and not the message.
{
  const { readFileSync } = await import("node:fs");
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/refusalClass = refusalReason\(err\?\.message, status\)/.test(server), "the dispatcher classifies the error it caught (source pin)");
  ok(/capturePostHogToolCall\([^)]*refusalReason: refusalClass/.test(server), "and passes the CLASS to telemetry, never err.message (source pin)");
  const ph = readFileSync(new URL("../src/posthog.js", import.meta.url), "utf8");
  ok(/\.\.\.\(refusalReason \? \{ refusalReason \} : \{\}\)/.test(ph), "tool_call carries the reason only when there is one (source pin)");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
