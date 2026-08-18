// Tempo relay verdicts must be VISIBLE (src/mpp-tempo.js relayFetch).
//
// mppx's Relay.js discards the whole response body whenever Tempo's relay
// answers non-2xx (`if (!response.ok) throw failure();` — argument-less), and
// Tempo's relay puts its actual verdict there: `{"error":{"code":
// "api_key_invalid",...}}` on 401, "does not grant MPP relay access" on 403,
// a validation error on 400 (measured live 2026-08-18). Through three straight
// live rejections our log said only "Payment verification failed.
// details=(none)" — indistinguishable from a bad credential, a dead relay, or
// a mis-scoped key, which need three different fixes. This drives the REAL
// mppx relay path (no stubbed validate/broadcast) against a local stub relay
// that answers non-2xx with a structured body and asserts the status AND body
// reach the error string, on validate and on broadcast, and that two
// concurrent requests each see their own verdict (AsyncLocalStorage, not a
// module-level "last error"). Mutation-checked: dropping `fetch: relayFetch`
// from the relay config fails at the first path/status assertion (the error
// degrades to "no relay verdict"), so a silent regression cannot pass.
import { createServer } from "node:http";
import { Challenge, Credential } from "mppx";

let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error("FAIL:", m); process.exit(1); } };

// Stub relay: every call answers 403 with Tempo's structured error shape and
// echoes a per-request marker so concurrent traces can be told apart.
let hits = 0;
let mode = "403"; // flipped to "200-rejected" for the second scenario
const relay = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    hits++;
    let realm = "?";
    try { realm = JSON.parse(body).challenge.realm; } catch { /* leave ? */ }
    if (mode === "200-rejected") {
      // The EXACT live shape measured 2026-08-18: HTTP 200, success:false,
      // code "unknown" (outside mppx's details allowlist), reason in message.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "unknown", message: `Payment verification failed: Invalid transaction: no matching payment call found (realm ${realm})` }, success: false }));
      return;
    }
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "api_key_scope_missing", message: `The API key does not grant MPP relay access (realm ${realm})` }, requestId: `r-${hits}` }));
  });
});
await new Promise((r) => relay.listen(0, r));

process.env.TEMPO_API_BASE_URL = `http://127.0.0.1:${relay.address().port}`;
process.env.TEMPO_API_KEY = "test-key";
process.env.WALLET_ADDRESS = "0x000000000000000000000000000000000000dEaD";
const { validateTempoCredential, broadcastTempoCredential, tempoEnabled } = await import("../src/mpp-tempo.js");
ok(tempoEnabled(), "tempo enabled for the test (key + recipient set)");

function credentialFor(realm) {
  const challenge = Challenge.from({
    realm, method: "tempo", intent: "charge", expires: new Date(Date.now() + 60_000),
    request: { amount: "1000", currency: "0x20c0000000000000000000000000000000000000", decimals: 6, recipient: process.env.WALLET_ADDRESS },
    secretKey: "test-secret",
  });
  return Credential.serialize({ challenge, payload: { hash: `0x${"ab".repeat(32)}`, type: "hash" } });
}

// Two concurrent validations + one broadcast, each with a distinct realm so
// the relay's echoed verdict identifies WHICH request it belongs to.
const [a, b, c] = await Promise.all([
  validateTempoCredential(credentialFor("alpha.test")),
  validateTempoCredential(credentialFor("beta.test")),
  broadcastTempoCredential(credentialFor("gamma.test")),
]);
ok(hits >= 3, `stub relay was actually hit (${hits} calls) — the real mppx relay path ran, nothing was stubbed in-process`);
for (const [name, r] of [["validate a", a], ["validate b", b], ["broadcast c", c]]) {
  ok(!r.ok, `${name}: rejected (relay said 403)`);
  ok(/relay \/v1\/mpp\/(validate|broadcast) HTTP 403 /.test(r.error), `${name}: error names the relay path + HTTP status (got: ${r.error.slice(0, 120)})`);
  ok(/api_key_scope_missing/.test(r.error), `${name}: the relay's structured error code survives into the log line`);
}
ok(/realm alpha\.test/.test(a.error) && /realm beta\.test/.test(b.error) && /realm gamma\.test/.test(c.error), "concurrent requests each carry THEIR OWN relay verdict (no cross-request bleed)");
ok(!/details=\(none/.test(a.error), "the old blind 'details=(none)' wording is gone when a relay verdict exists");

// Scenario 2: HTTP 200 + success:false + an error code OUTSIDE mppx's
// allowlist. mppx surfaces NO details for this (safeDetails("unknown") is
// undefined) and never the message — the live relay's real reason lived only
// there, through four straight rejections.
mode = "200-rejected";
const d = await validateTempoCredential(credentialFor("delta.test"));
relay.close();
ok(!d.ok, "200-rejected: still rejected (mppx sees success:false)");
ok(/relay \/v1\/mpp\/validate HTTP 200 /.test(d.error), `200-rejected: a 2xx success:false body is captured too (got: ${d.error.slice(0, 100)})`);
ok(/no matching payment call found \(realm delta\.test\)/.test(d.error), "200-rejected: the relay's human-readable reason (message) survives — the field mppx drops");

console.log(`\nAll ${pass} assertions passed`);
process.exit(0);
