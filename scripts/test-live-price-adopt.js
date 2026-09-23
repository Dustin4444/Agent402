#!/usr/bin/env node
// A re-probed PRICED row kept its old price (issue #1460, 2026-09-23): the live
// 402 filled an empty price only, so a seller who re-registered at $0.005 still
// showed $0.003 on seven routes. Two rules pinned here offline:
//   1. a live 402 price replaces a held price that differs (logged, both figures);
//   2. an explicit re-registration re-asks every route whose held price differs
//      from the origin's declaration at all; the automatic crawl still waits for
//      a 2x drift.
import assert from "node:assert/strict";
process.env.X402_INDEX_CRAWL = "off";
const { enrichLiveQuotes, adoptLivePrice } = await import("../src/x402-index.js");

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); };
const ORIGIN = "https://example.com"; // resolves: the SSRF guard checks the host before the stubbed fetch
const header = (amount) => Buffer.from(JSON.stringify({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", payTo: "0x9fb365E4E9385E2a39FeBAd70368267e6f571d9A", amount, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }] })).toString("base64");
const seen = [];
const logs = [];
const origLog = console.log; console.log = (...a) => { logs.push(a.join(" ")); };
const orig = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url)); seen.push(`${init.method || "GET"} ${u.pathname}`);
  return new Response("{}", { status: 402, headers: { "payment-required": header("5000") } }); // $0.005 live
};
const row = (extra = {}) => ({ seller: "example.com", route: "/api/base/wallet-balance", method: "POST", slug: "wb", price: 0.003, networks: ["eip155:8453"], networksVerifiedAt: Date.now(), quoteSource: "live-402", quoteObservedAt: Date.now() - 60_000, ...extra });

try {
  // --- 1. pure
  const r = { route: "/x", price: 0.003 };
  adoptLivePrice(r, 0.005, ORIGIN);
  ok(r.price === 0.005, "a differing live price replaces the held one");
  ok(logs.some((l) => /live-402 price: .*\/x 0\.003 -> 0\.005/.test(l)), "and the correction is logged with both figures");
  logs.length = 0;
  const same = { route: "/y", price: "$0.005" };
  adoptLivePrice(same, 0.005, ORIGIN);
  ok(same.price === "$0.005" && !logs.length, "an equal price (even as a display string) is left alone, nothing logged");
  const gap = { route: "/z", price: null };
  adoptLivePrice(gap, 0.002, ORIGIN);
  ok(gap.price === 0.002, "an empty price is still filled");
  const keep = { route: "/w", price: 0.003 };
  adoptLivePrice(keep, null, ORIGIN);
  ok(keep.price === 0.003, "a live read with no usable price changes nothing");

  // --- 2. the reported case: declared $0.005, held $0.003 (1.67x), re-registered
  seen.length = 0;
  const rows = [row({ originDeclaredPrice: 0.005 })];
  await enrichLiveQuotes(rows, ORIGIN, { ignoreBudget: true });
  ok(seen.length > 0, "an explicit re-registration re-asks a route under the 2x drift");
  ok(rows[0].price === 0.005, `and the live price lands (got ${rows[0].price})`);

  // --- control: the automatic crawl leaves a sub-2x gap alone (polite cadence)
  seen.length = 0;
  const auto = [row({ originDeclaredPrice: 0.005 })];
  await enrichLiveQuotes(auto, ORIGIN);
  ok(seen.length === 0 && auto[0].price === 0.003, "the automatic crawl does not re-ask a fresh quote under 2x");

  // --- 3. a STALE learned quote re-asked by the automatic crawl now takes the live price
  seen.length = 0;
  const stale = [row({ quoteObservedAt: Date.now() - 8 * 24 * 3600_000 })];
  await enrichLiveQuotes(stale, ORIGIN);
  ok(seen.length > 0 && stale[0].price === 0.005, `a stale quote is re-read AND corrected (got ${stale[0].price})`);
} finally {
  globalThis.fetch = orig; console.log = origLog;
}
console.log(`test-live-price-adopt: ${n} assertions ok`);
