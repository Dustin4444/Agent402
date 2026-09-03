#!/usr/bin/env node
// A seller that declares GET and POST on one path where only POST answers
// (minia2a.uk declares both on ~1,700 paths; the case worth a test is the
// seller whose POST route REJECTS GET). Before this, the live-402 probe
// corrected the declared GET row to POST and left two identical POST rows on
// the path; before 2026-09-02 it published the GET and buyers got 405. Now the
// refused declared row is dropped and its sibling carries the quote. Offline:
// fetch is stubbed; example.com resolves publicly so the SSRF guard is happy.
import assert from "node:assert/strict";

process.env.X402_INDEX_CRAWL = "off";
const { enrichLiveQuotes } = await import("../src/x402-index.js");

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); };
const eq = (a, b, m) => { n++; assert.equal(a, b, m); };

const ORIGIN = "https://example.com";
const accepts = { x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", payTo: "0x9fb365E4E9385E2a39FeBAd70368267e6f571d9A", amount: "500000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2", decimals: 6 } }] };
const header = Buffer.from(JSON.stringify(accepts)).toString("base64");
const orig = globalThis.fetch;
const seen = [];
const stub = (rules) => async (url, init = {}) => {
  const u = new URL(String(url)); const m = String(init.method || "GET").toUpperCase();
  seen.push(`${m} ${u.pathname}`);
  const status = rules[`${m} ${u.pathname}`] ?? 404;
  const headers = new Headers(status === 402 ? { "payment-required": header, "content-type": "application/json" } : { "content-type": "text/plain" });
  return new Response(status === 402 ? "{}" : "nope", { status, headers });
};
const logs = [];
const origLog = console.log; console.log = (...a) => { logs.push(a.join(" ")); };

try {
  // --- 1. declared GET refused (405), declared POST answers: the GET row is dropped, the POST row carries the quote
  globalThis.fetch = stub({ "GET /x402/gas": 405, "POST /x402/gas": 402 });
  const tools = [
    { seller: "example.com", route: "/x402/gas", method: "GET", slug: "x402_gas_get", networks: [] },
    { seller: "example.com", route: "/x402/gas", method: "POST", slug: "x402_gas_post", networks: [] },
  ];
  await enrichLiveQuotes(tools, ORIGIN, { ignoreBudget: true });
  eq(tools.length, 1, "one row remains on the path");
  eq(tools[0].method, "POST", "the answering verb's own row remains");
  eq(tools[0].slug, "x402_gas_post", "the sibling row, not a relabelled GET");
  eq(tools[0].price, 0.5, "the quote landed on the sibling");
  ok(tools[0].networks.includes("eip155:8453") && tools[0].networksVerifiedAt > 0, "sibling networks verified");
  ok(logs.some((l) => /refuses GET and answers POST.*dropping the GET row/.test(l)), "the drop is logged with both verbs");

  // --- 2. control: the seller honours both verbs -> both rows stay, both priced
  seen.length = 0; logs.length = 0;
  globalThis.fetch = stub({ "GET /x402/time": 402, "POST /x402/time": 402 });
  const both = [
    { seller: "example.com", route: "/x402/time", method: "GET", slug: "x402_time_get", networks: [] },
    { seller: "example.com", route: "/x402/time", method: "POST", slug: "x402_time_post", networks: [] },
  ];
  await enrichLiveQuotes(both, ORIGIN, { ignoreBudget: true });
  eq(both.length, 2, "both rows stay when both verbs answer");
  ok(both.every((t) => t.method === (t.slug.endsWith("_get") ? "GET" : "POST")), "verbs untouched");

  // --- 3. a lone declared GET that 405s with no sibling is CORRECTED (today's behaviour), never dropped
  seen.length = 0; logs.length = 0;
  globalThis.fetch = stub({ "GET /only-post": 405, "POST /only-post": 402 });
  const lone = [{ seller: "example.com", route: "/only-post", method: "GET", slug: "only_post", networks: [] }];
  await enrichLiveQuotes(lone, ORIGIN, { ignoreBudget: true });
  eq(lone.length, 1, "lone row kept");
  eq(lone[0].method, "POST", "corrected to the answering verb");
  eq(lone[0].methodCorrectedFrom, "GET", "correction recorded for the carry-forward");
  eq(lone[0].price, 0.5, "priced");

  // --- 4. the drop is IN PLACE: a caller that ignores the return value sees it too
  globalThis.fetch = stub({ "GET /x402/recall": 405, "POST /x402/recall": 402 });
  const arr = [
    { seller: "example.com", route: "/x402/recall", method: "GET", slug: "x402_recall_get", networks: [] },
    { seller: "example.com", route: "/x402/recall", method: "POST", slug: "x402_recall_post", networks: [] },
  ];
  const ret = await enrichLiveQuotes(arr, ORIGIN, { ignoreBudget: true });
  ok(ret === arr && arr.length === 1, "the array passed in is the array trimmed (two call sites read it, not the return)");
} finally {
  globalThis.fetch = orig; console.log = origLog;
}
console.log(`test-live-quote-method-refused: ${n} assertions ok`);
