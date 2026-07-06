// LIVE paid test of the agent402-client spending-cap 402-inspection, against PROD
// with the real Base burner (BURNER_KEY). The offline suite proves the preflight
// LOGIC; this proves the added preflight does NOT break a real settle against a
// live facilitator (the one box the offline test can't check) and that the cap
// gates end-to-end. Spends a few cents of burner USDC. Skips cleanly with no key,
// so it never fails CI without a signer. Marks itself internal (heartbeat token)
// so the buy doesn't pollute the external sales ledger.
import { existsSync, readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { Agent402, SpendingLimitError } from "../client/index.js";

const TARGET = process.env.TARGET_URL || "https://agent402.tools";
const KEY_FILE = process.env.KEY_FILE || "/tmp/agent-key";
const pk = (process.env.BURNER_KEY || "").trim() || (existsSync(KEY_FILE) ? readFileSync(KEY_FILE, "utf8").trim() : "");
if (!pk) { console.log("SKIP: no BURNER_KEY / KEY_FILE — live paid test needs a signer"); process.exit(0); }

const [{ privateKeyToAccount }, { x402Client }, { registerExactEvmScheme }, { wrapFetchWithPayment }] = await Promise.all([
  import("viem/accounts"), import("@x402/core/client"), import("@x402/evm/exact/client"), import("@x402/fetch"),
]);
const account = privateKeyToAccount(pk);
const client = new x402Client();
registerExactEvmScheme(client, { signer: account });

// Same internal-traffic marker the canary uses (HMAC(POW_SECRET, UTC minute)).
const secret = (process.env.POW_SECRET || "").trim();
const synthFetch = !secret ? fetch : (url, init = {}) => {
  const token = createHmac("sha256", secret).update(`heartbeat:${Math.floor(Date.now() / 60000)}`).digest("base64url").slice(0, 32);
  const headers = new Headers(init.headers || {});
  headers.set("X-Heartbeat-Token", token);
  return fetch(url, { ...init, headers });
};
const payFetch = wrapFetchWithPayment(synthFetch, client);

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };

// Choose a reliable, cheap, wallet-only tool that's present in the live catalog.
const probe = new Agent402({ baseUrl: TARGET, fetch: payFetch, fetchImpl: synthFetch });
const cat = await probe._loadCatalog();
const KNOWN = [
  { slug: "whois", input: { domain: "example.com" } },
  { slug: "gas-snapshot", input: {} },
  { slug: "edgar-company-lookup", input: { ticker: "AAPL" } },
  { slug: "stock-quote", input: { symbol: "AAPL" } },
];
let chosen = null;
for (const k of KNOWN) { const t = cat.get(k.slug); if (t && !t.computePayable) { chosen = { slug: k.slug, t, input: k.input }; break; } }
if (!chosen) { console.log("SKIP: no known wallet-only tool in the live catalog"); process.exit(0); }
const price = parseFloat(String(chosen.t.price).replace(/[^0-9.]/g, "")) || 0;
console.log(`live target: "${chosen.slug}" @ $${price} on ${TARGET} (payer ${account.address})`);

// TEST A — cap ABOVE price: the preflight runs, then the real payment must SETTLE.
// This is the live proof the added preflight doesn't break production payments.
try {
  const a = new Agent402({ baseUrl: TARGET, fetch: payFetch, fetchImpl: synthFetch, maxPerCallUsd: price + 0.02 });
  const res = await a.call(chosen.slug, chosen.input, { cache: false });
  ok(res && typeof res === "object", "cap ABOVE price: preflight + real x402 settle SUCCEEDED");
  console.log(`  settled spend recorded: $${a.spendingSummary().dailyUsd}`);
} catch (e) {
  ok(false, `cap ABOVE price: settle FAILED — ${e.message}`);
}

// TEST B — cap BELOW price: refused before signing, no funds move.
try {
  const b = new Agent402({ baseUrl: TARGET, fetch: payFetch, fetchImpl: synthFetch, maxPerCallUsd: Math.max(price / 2, 0.0001) });
  await b.call(chosen.slug, chosen.input, { cache: false });
  ok(false, "cap BELOW price: should have refused, but the call went through");
} catch (e) {
  ok(e instanceof SpendingLimitError || e?.name === "SpendingLimitError", `cap BELOW price: refused before paying (${e?.name || "error"})`);
}

console.log(`\n${failed ? "FAILED" : "OK"}: ${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
