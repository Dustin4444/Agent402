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

// --- issue / valid (read-only) ---------------------------------------------
{
  const L = createRenderCreditLedger({ ttlMs: 1000 });
  const tok = L.issue(META, 0);
  ok(typeof tok === "string" && tok.length >= 43, "issue returns the bearer token");
  ok(L.valid(tok, META, 0) === true, "the token is valid for the exact request it was issued for");
  ok(L.valid(tok, META, 0) === true, "valid() is read-only — it does NOT consume (so admission must use claim())");
}

// --- ATOMIC claim: this is what closes the double-spend --------------------
{
  const L = createRenderCreditLedger({ ttlMs: 10_000 });
  const tok = L.issue(META, 0);
  // Simulate a concurrent burst: every retry validates before any finishes, but
  // admission goes through claim(), which removes the token on the FIRST call.
  ok(L.claim(tok, META, 0) === true, "first concurrent retry claims the credit");
  ok(L.claim(tok, META, 0) === false, "a second concurrent retry with the same token is refused (no double-spend)");
  ok(L.claim(tok, META, 0) === false, "and a third — one paid credit yields exactly one delivery");
  // 100 racers, one token:
  const L2 = createRenderCreditLedger({ ttlMs: 10_000 });
  const t2 = L2.issue(META, 0);
  let wins = 0;
  for (let i = 0; i < 100; i++) if (L2.claim(t2, META, 0)) wins++;
  ok(wins === 1, "exactly ONE of 100 concurrent claims of the same token succeeds");
}

// --- claim: forgery / cross-request resistance (and no consume on mismatch) -
{
  const L = createRenderCreditLedger({ ttlMs: 1000 });
  const tok = L.issue(META, 0);
  ok(L.claim("not-a-real-token", META, 0) === false, "a guessed/forged token is rejected");
  ok(L.claim(tok, OTHER_BODY, 0) === false, "a token cannot be claimed for a DIFFERENT body");
  ok(L.claim(tok, OTHER_ROUTE, 0) === false, "a token cannot be claimed for a DIFFERENT route");
  ok(L.claim(tok, META, 0) === true, "the mismatched attempts did NOT consume the credit — it is still claimable for its real request");
  ok(L.claim(null, META, 0) === false && L.claim(undefined, META, 0) === false, "missing token → not claimable");
}

// --- TTL expiry ------------------------------------------------------------
{
  const L = createRenderCreditLedger({ ttlMs: 1000 });
  const tok = L.issue(META, 0);
  ok(L.valid(tok, META, 999) === true, "valid within the TTL");
  ok(L.claim(tok, META, 1000) === false, "cannot claim at/after the TTL boundary (expired)");
  const tok2 = L.issue(META, 2000);
  ok(L.claim(tok2, META, 7000) === false, "claiming past the TTL reports false (expired)");
}

// --- capacity refusal: a failed pre-paid retry re-issues, success does not --
{
  const L = createRenderCreditLedger({ ttlMs: 10_000 });
  const tok = L.issue(META, 0);            // paid call 503'd -> token minted
  ok(L.claim(tok, META, 100) === true, "retry #1 claims the credit (bypasses the paywall)");
  // retry #1 ALSO 503s -> the server re-issues a fresh token; the OLD one is dead
  ok(L.claim(tok, META, 150) === false, "the claimed token is dead even though delivery failed (server re-issues a new one)");
  const tok2 = L.issue(META, 200);         // server's re-issue on the failed retry
  ok(L.claim(tok2, META, 300) === true, "retry #2 with the re-issued token succeeds -> consumed");
  ok(L.claim(tok2, META, 400) === false, "no free renders after the one paid delivery");
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
