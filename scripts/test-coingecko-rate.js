#!/usr/bin/env node
// One CoinGecko bucket for both kits. crypto-markets-kit had a private 25/min
// bucket and crypto-kit had none, so together they overran the one Demo key.
// Offline: fetch is stubbed; the bucket is exhausted by hand.
import assert from "node:assert/strict";
process.env.X402_INDEX_CRAWL = "off";
const rate = await import("../src/tools/coingecko-rate.js");
const markets = await import("../src/tools/crypto-markets-kit.js");
const { CRYPTO_TOOLS } = await import("../src/tools/crypto-kit.js");
let n = 0; const ok = (c, m) => { n++; assert.ok(c, m); }; const eq = (a, b, m) => { n++; assert.equal(a, b, m); };

// bucket semantics
rate.resetCgRateLimit();
process.env.COINGECKO_MAX_PER_MIN = "3";
const t0 = 1_000_000;
ok(rate.takeCgToken(t0) && rate.takeCgToken(t0) && rate.takeCgToken(t0), "three tokens at cap 3");
ok(!rate.takeCgToken(t0), "the fourth is refused");
ok(rate.takeCgToken(t0 + 20_001), "a third of a minute later one token has refilled");
ok(!rate.takeCgToken(t0 + 20_001), "and only one");
ok(rate.isCoinGeckoHost("api.coingecko.com") && rate.isCoinGeckoHost("pro-api.coingecko.com") && !rate.isCoinGeckoHost("api.exchange.coinbase.com"), "host test");
eq(markets.resetCgRateLimit, rate.resetCgRateLimit, "crypto-markets-kit re-exports the SHARED reset (one bucket, not two)");

// crypto-kit refuses before fetching when the bucket is empty
const priceTool = CRYPTO_TOOLS.find((t) => t.slug === "crypto-price");
const orig = globalThis.fetch; let fetched = 0;
globalThis.fetch = async () => { fetched++; return new Response("{}", { status: 200, headers: { "content-type": "application/json" } }); };
try {
  rate.resetCgRateLimit();
  while (rate.takeCgToken(Date.now())) { /* drain */ }
  let err = null;
  try { await priceTool.handler({ coins: "BTC" }); } catch (e) { err = e; }
  eq(err?.statusCode, 503, "empty bucket -> 503 before any upstream call");
  ok(/not charged/i.test(String(err?.message)), "the refusal says nobody paid");
  eq(fetched, 0, "no CoinGecko request was made");
} finally { globalThis.fetch = orig; delete process.env.COINGECKO_MAX_PER_MIN; rate.resetCgRateLimit(); }
console.log(`test-coingecko-rate: ${n} assertions ok`);
