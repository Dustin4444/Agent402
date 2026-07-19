// F13: unit tests for the idempotent render-credit ledger (offline, no server).
//   node scripts/test-render-credit.js
import { createRenderCreditLedger, bodyHashFor, mintCreditToken } from "../src/render-credit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

const META = { route: "POST /api/render", bodyHash: bodyHashFor({ url: "https://example.com" }) };
const OTHER_BODY = { route: "POST /api/render", bodyHash: bodyHashFor({ url: "https://evil.com" }) };
const OTHER_ROUTE = { route: "GET /api/screenshot?url=x", bodyHash: META.bodyHash };

// --- token secrecy / shape -------------------------------------------------
{
  const a = mintCreditToken(), b = mintCreditToken();
  ok(typeof a === "string" && a.length >= 43, "minted token is a long (256-bit) URL-safe string");
  ok(a !== b, "each minted token is unique (unguessable bearer secret)");
  ok(bodyHashFor(undefined) === "-" && bodyHashFor({}) === "-", "empty/absent body → '-' sentinel");
}

// --- issue / valid / single-use consume ------------------------------------
{
  const L = createRenderCreditLedger({ ttlMs: 1000 });
  const tok = L.issue(META, 0);
  ok(typeof tok === "string" && tok.length >= 43, "issue returns the bearer token");
  ok(L.valid(tok, META, 0) === true, "the token is valid for the exact request it was issued for");
  ok(L.consume(tok, 0) === true, "consume reports the live credit");
  ok(L.valid(tok, META, 0) === false, "single-use — token is gone after consume");
  ok(L.consume(tok, 0) === false, "a consumed token cannot be spent again (no double-spend)");
}

// --- forgery / cross-request resistance ------------------------------------
{
  const L = createRenderCreditLedger({ ttlMs: 1000 });
  const tok = L.issue(META, 0);
  ok(L.valid("not-a-real-token", META, 0) === false, "a guessed/forged token is rejected");
  ok(L.valid(tok, OTHER_BODY, 0) === false, "a valid token cannot be spent on a DIFFERENT body (no upgrade to another render)");
  ok(L.valid(tok, OTHER_ROUTE, 0) === false, "a valid token cannot be spent on a DIFFERENT route");
  ok(L.valid(null, META, 0) === false && L.valid(undefined, META, 0) === false, "missing token → not valid");
}

// --- TTL expiry ------------------------------------------------------------
{
  const L = createRenderCreditLedger({ ttlMs: 1000 });
  const tok = L.issue(META, 0);
  ok(L.valid(tok, META, 999) === true, "valid within the TTL");
  ok(L.valid(tok, META, 1000) === false, "expires at the TTL boundary");
  const tok2 = L.issue(META, 0);
  ok(L.consume(tok2, 5000) === false, "consuming past the TTL reports false (expired)");
}

// --- capacity refusal: survives repeated 503, consumed only on success -----
{
  const L = createRenderCreditLedger({ ttlMs: 10_000 });
  const tok = L.issue(META, 0);            // paid call 503'd -> token minted
  ok(L.valid(tok, META, 100) === true, "retry #1 sees the credit (would bypass the paywall)");
  ok(L.valid(tok, META, 200) === true, "credit persists across a repeated capacity refusal");
  ok(L.consume(tok, 300) === true, "retry #2 succeeds -> credit consumed exactly once");
  ok(L.valid(tok, META, 400) === false, "no free renders after the one paid delivery");
}

// --- FIFO eviction at capacity ---------------------------------------------
{
  const L = createRenderCreditLedger({ ttlMs: 10_000, maxEntries: 2 });
  const a = L.issue(META, 0), b = L.issue(META, 1);
  const c = L.issue(META, 2);              // evicts the oldest (a)
  ok(L.valid(a, META, 5) === false, "oldest credit evicted when the ledger is full");
  ok(L.valid(b, META, 5) && L.valid(c, META, 5), "newer credits retained");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
