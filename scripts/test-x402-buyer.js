// x402-buyer hardening tests (F2 accept-pinning, F3 post-spend read, margin cap).
// Mocks global fetch so no wallet/network is needed. The refusal paths throw
// BEFORE any signing, so they run offline with a throwaway key.
import { randomBytes } from "node:crypto";
import { quoteWithinCap, readAfterSpend } from "../src/x402-buyer.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

// --- margin guard edge cases (the F2-adjacent primitive) --------------------
ok(quoteWithinCap("2000", 5000n) === true, "$0.002 <= $0.005 cap");
ok(quoteWithinCap("5000", 5000n) === true, "exact cap ok");
ok(quoteWithinCap("5001", 5000n) === false, "one over cap refused");
ok(quoteWithinCap("499999999", 500000n) === false, "decoy $500 vs $0.50 cap refused");
ok(quoteWithinCap("", 5000n) === false, "empty quote refused (BigInt('') trap closed)");
ok(quoteWithinCap("-1", 5000n) === false, "negative refused");
ok(quoteWithinCap("1.5", 5000n) === false, "decimal refused");
ok(quoteWithinCap("0x10", 5000n) === false, "hex refused");
ok(quoteWithinCap(null, 5000n) === false, "null refused");

// --- F3: readAfterSpend never throws; truncates oversize / wraps non-JSON ----
const mk = (text, throwOnRead = false) => ({ text: async () => { if (throwOnRead) throw new Error("boom"); return text; } });
const j1 = await readAfterSpend(mk(JSON.stringify({ a: 1 })), 1024);
ok(j1 && j1.a === 1 && !j1._truncated, "F3: small JSON returned verbatim");
const bigObj = await readAfterSpend(mk(JSON.stringify({ big: "x".repeat(5000) })), 100);
ok(bigObj && bigObj._truncated === true, "F3: oversize JSON flagged _truncated, no throw");
const nonJson = await readAfterSpend(mk("<html>not json</html>"), 1024);
ok(nonJson && typeof nonJson.raw === "string" && nonJson.raw.includes("not json"), "F3: non-JSON wrapped as {raw}");
const bigNonJson = await readAfterSpend(mk("y".repeat(9000)), 100);
ok(bigNonJson && bigNonJson._truncated === true && bigNonJson.raw.length <= 4000, "F3: oversize non-JSON truncated + flagged");
const unreadable = await readAfterSpend(mk("", true), 1024);
ok(unreadable && unreadable.relayError, "F3: unreadable body → relayError, no throw");

// --- F2: payX402 signs the EXACT/Base/USDC accept, cap-checks THAT one -------
// v1 challenge (getPaymentRequiredResponse returns a body with x402Version:1 as-is).
// Ephemeral throwaway key generated at runtime — never a literal in the repo
// (the refusal paths throw before signing; getUpstreamBuyer just needs a
// valid-format key to construct the account).
process.env.X402_UPSTREAM_BUYER_KEY = "0x" + randomBytes(32).toString("hex");
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const origFetch = globalThis.fetch;
const v1entry = (over) => ({ scheme: over.scheme ?? "exact", network: over.network ?? "base", asset: over.asset ?? USDC, maxAmountRequired: over.amt ?? "1000", payTo: "0xabc", resource: "https://seller.example/x", description: "d", maxTimeoutSeconds: 60 });
const challenge = (accepts) => ({ status: 402, headers: { get: () => null }, json: async () => ({ x402Version: 1, accepts }), text: async () => "" });
const { payX402 } = await import("../src/x402-buyer.js");

// decoy: cheap non-exact first, expensive exact/USDC behind → must refuse (cap)
globalThis.fetch = async () => challenge([
  v1entry({ scheme: "upto", amt: "1" }),
  v1entry({ scheme: "exact", amt: "499999999" }),
]);
let t1 = null;
try { await payX402("https://seller.example/x", { maxAtomic: 500000n, trusted: true, method: "POST", body: {} }); } catch (e) { t1 = e; }
ok(t1 && /exceeds the .* cap/.test(t1.message), "F2: decoy-first challenge with $500 exact entry refused by cap (not signed)");

// no USDC/exact/Base entry at all → refuse
globalThis.fetch = async () => challenge([v1entry({ asset: "0xother" })]);
let t2 = null;
try { await payX402("https://seller.example/x", { maxAtomic: 500000n, trusted: true, method: "POST", body: {} }); } catch (e) { t2 = e; }
ok(t2 && /no \w+\/exact\/USDC accept/i.test(t2.message), "F2: non-USDC asset accept refused");

// wrong-chain USDC contract (testnet-style asset) → refuse (asset pin = chain safety)
globalThis.fetch = async () => challenge([v1entry({ asset: "0x036cbd53842c5426634e7929541ec2318f3dcf7e" /* base-sepolia USDC */ })]);
let t3 = null;
try { await payX402("https://seller.example/x", { maxAtomic: 500000n, trusted: true, method: "POST", body: {} }); } catch (e) { t3 = e; }
ok(t3 && /no \w+\/exact\/USDC accept/i.test(t3.message), "F2: non-mainnet-USDC asset refused (chain pinned by asset)");

// --- NEW-1: reserveSpend holds budget, releaseSpend refunds unspent holds -----
{
  const { reserveSpend, releaseSpend, _spentThisWindow } = await import("../src/x402-buyer.js");
  const t = reserveSpend("400000"); // $0.40 held
  ok(_spentThisWindow() === 400000n, "budget: reserve holds $0.40");
  releaseSpend("400000", t);         // paid leg failed pre-response → refund
  ok(_spentThisWindow() === 0n, "budget: release refunds the full hold");
  // over-cap is refused (default $2/min cap = 2000000)
  const held = reserveSpend("2000000");
  let over = null; try { reserveSpend("1"); } catch (e) { over = e; }
  ok(over && over.statusCode === 429, "budget: reserve past the window cap throws 429");
  releaseSpend("2000000", held);
  ok(_spentThisWindow() === 0n, "budget: post-test window drained");
  // stale token (wrong window) is a no-op, never drives the counter negative
  releaseSpend("999", "0"); ok(_spentThisWindow() === 0n, "budget: stale-token release is a no-op");
}

globalThis.fetch = origFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
