// Sales ledger — offline unit tests. Throwaway DB via SALES_LEDGER_DB (set
// BEFORE import), no network: exercises the internal/external classification
// (synthetic flag, heartbeat rail, burner payer), the revenue math (money
// rails only — PoW counts as usage, never revenue), the merchant summary
// shape, and the settle-receipt tx parser.
//
// The accounting tests read the ITEMIZED shape (detailed:true) because that is
// where the per-tool and per-payer rows live. The last block is a LEAK test on
// the DEFAULT (public) shape - it must stay aggregate-only.
//
//   node scripts/test-sales-ledger.js
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "a402-sales-"));
process.env.SALES_LEDGER_DB = join(dir, "test-sales.db");
const { recordSale, salesSummary, topByBuyers, txFromPaymentResponse, mppTxHashes, mppSales } = await import("../src/sales-ledger.js");
const { OUR_EVM_WALLETS } = await import("../src/revenue-live.js");

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`ok - ${msg}`); }
  else { failed++; console.error(`FAIL - ${msg}`); }
};

const BUYER = "0x07FBCA218b0A0a35244e0025A036fA85A6dc97dC"; // checksummed on purpose — must match lowercased
const BURNER = [...OUR_EVM_WALLETS][0];

// --- empty ledger ----------------------------------------------------------------
let s = salesSummary({ detailed: true });
ok(s.totals.external.sales === 0 && s.topExternal.length === 0 && s.recordingSince === null, "empty ledger → zero totals, null since");

// --- external USDC sale ------------------------------------------------------------
recordSale({ slug: "code-run-pro", priceUsd: 0.05, rail: "usdc", network: "base", payer: BUYER, tx: "0xabc", synthetic: false });
s = salesSummary({ detailed: true });
ok(s.totals.external.sales === 1 && s.totals.external.revenueUsd === 0.05, `external usdc sale counts as revenue (got $${s.totals.external.revenueUsd})`);
ok(s.topExternal[0]?.slug === "code-run-pro" && s.topExternal[0]?.sales === 1, "top external names the slug");
ok(s.recentExternal[0]?.payer === BUYER.toLowerCase() && s.recentExternal[0]?.tx === "0xabc", "recent sale keeps lowercased payer + settle tx");

// --- internal classification: synthetic, heartbeat rail, burner payer -------------
recordSale({ slug: "hash", priceUsd: 0.001, rail: "usdc", network: "base", payer: BUYER, tx: null, synthetic: true });
recordSale({ slug: "hash", priceUsd: 0.001, rail: "heartbeat", network: null, payer: null, tx: null, synthetic: false });
recordSale({ slug: "stock-quote", priceUsd: 0.01, rail: "usdc", network: "base", payer: BURNER.toUpperCase().replace("0X", "0x"), tx: "0xdef", synthetic: false });
s = salesSummary({ detailed: true });
ok(s.totals.internal.sales === 3, `synthetic + heartbeat + burner-payer all classify internal (got ${s.totals.internal.sales})`);
ok(s.totals.external.sales === 1, "none of them leaked into external");
ok(!s.topExternal.some((r) => r.slug === "stock-quote"), "burner (canary-style) buy never appears in top external");

// --- PoW is usage, not revenue ------------------------------------------------------
recordSale({ slug: "qr", priceUsd: 0.001, rail: "pow", network: null, payer: null, tx: null, synthetic: false });
s = salesSummary({ detailed: true });
ok(s.totals.external.sales === 2 && s.totals.external.revenueUsd === 0.05, "pow adds a sale but not revenue");
ok(!s.topExternal.some((r) => r.slug === "qr"), "topExternal is money rails only");
ok(s.totals.byRail["external:pow"] === 1, "rail split exposes pow usage");

// --- marketplace rail is revenue ----------------------------------------------------
recordSale({ slug: "search", priceUsd: 0.02, rail: "marketplace", network: null, payer: null, tx: null, synthetic: false });
s = salesSummary({ detailed: true });
ok(s.totals.external.revenueUsd === 0.07, `marketplace revenue counts (got $${s.totals.external.revenueUsd})`);

// --- repeat buyers ------------------------------------------------------------------
recordSale({ slug: "tts", priceUsd: 0.05, rail: "usdc", network: "base", payer: BUYER, tx: "0x123", synthetic: false });
s = salesSummary({ detailed: true });
ok(s.repeatBuyers[0]?.payer === BUYER.toLowerCase() && s.repeatBuyers[0]?.sales === 2 && s.repeatBuyers[0]?.revenueUsd === 0.1,
  `repeat buyer aggregates by wallet (got ${JSON.stringify(s.repeatBuyers[0])})`);

// --- never throws on garbage --------------------------------------------------------
recordSale({});
recordSale({ slug: null, priceUsd: NaN, rail: undefined, payer: 42, tx: {}, synthetic: null });
s = salesSummary({ detailed: true });
ok(true, "garbage input never throws");
ok(s.totals.external.sales >= 2, "ledger still readable after garbage rows");

// --- days window: old rows age out of the aggregations ------------------------------
{
  const Database = (await import("better-sqlite3")).default;
  const raw = new Database(process.env.SALES_LEDGER_DB);
  raw.prepare("INSERT INTO sales (ts, slug, price_usd, rail, network, payer, tx, internal) VALUES (?,?,?,?,?,?,?,0)")
    .run(Date.now() - 40 * 86_400_000, "ancient-tool", 0.9, "usdc", "base", "0x" + "1".repeat(40), "0xold");
  raw.close();
  s = salesSummary({ days: 30, detailed: true });
  ok(!s.topExternal.some((r) => r.slug === "ancient-tool"), "40-day-old sale is outside the 30d window");
  const wide = salesSummary({ days: 90, detailed: true });
  ok(wide.topExternal.some((r) => r.slug === "ancient-tool"), "…but inside a 90d window");
}

// --- topByBuyers: distinct verified wallets per tool (the /index demand widget) -----
{
  const P1 = "0x1111111111111111111111111111111111111111";
  const P2 = "0x2222222222222222222222222222222222222222";
  recordSale({ slug: "dns-lookup", priceUsd: 0.005, rail: "usdc", network: "base", payer: P1, tx: "0xa1", synthetic: false });
  recordSale({ slug: "dns-lookup", priceUsd: 0.005, rail: "usdc", network: "base", payer: P1, tx: "0xa2", synthetic: false }); // repeat: same wallet
  recordSale({ slug: "dns-lookup", priceUsd: 0.005, rail: "usdc", network: "base", payer: P2, tx: "0xa3", synthetic: false });
  recordSale({ slug: "dns-lookup", priceUsd: 0.005, rail: "usdc", network: "base", payer: BURNER, tx: "0xa4", synthetic: false }); // internal: must not count
  const buyers = topByBuyers({ days: 30, limit: 8 });
  const dns = buyers.find((r) => r.slug === "dns-lookup");
  ok(dns && dns.buyers === 2 && dns.sales === 3, `distinct buyers counts unique wallets, excludes burner (got ${JSON.stringify(dns)})`);
  ok(buyers[0]?.slug === "dns-lookup", "ranked by distinct buyers desc (dns-lookup leads with 2)");
  ok(!buyers.some((r) => r.buyers === 0), "no zero-buyer rows");
  ok(!buyers.some((r) => r.slug === "search" || r.slug === "qr"), "payer-null sales (marketplace/pow) excluded from the buyer ranking");
}

// --- MPP wire -> tx hashes (the join key for the revenue chart's wire filter) -------
{
  const MPP_PAYER = "0x1111111111111111111111111111111111111111";
  const H_MPP = "0xAbCdEf0000000000000000000000000000000000000000000000000000000001"; // mixed-case hex, as an explorer renders it
  const H_SOL = "5Kd3NBUAdUnhyzhWCbNCcMzTPFtLBUAdUnhyzhWCbNCc"; // base58: case-SENSITIVE, must stay verbatim
  recordSale({ slug: "uuid", priceUsd: 0.001, rail: "usdc", network: "base", payer: MPP_PAYER, tx: H_MPP, synthetic: false, wire: "mpp" });
  recordSale({ slug: "uuid", priceUsd: 0.001, rail: "usdc", network: "solana", payer: null, tx: H_SOL, synthetic: false, wire: "mpp" });
  recordSale({ slug: "uuid", priceUsd: 0.001, rail: "usdc", network: "base", payer: MPP_PAYER, tx: "0x0402", synthetic: false, wire: "x402" });
  recordSale({ slug: "uuid", priceUsd: 0.001, rail: "usdc", network: "base", payer: MPP_PAYER, tx: "0x0f00", synthetic: false });
  const hashes = mppTxHashes();
  ok(hashes.has(H_MPP) && hashes.has(H_SOL), "MPP-wire sales expose their tx hashes");
  ok(!hashes.has("0x0402"), "x402-wire sales are excluded");
  ok(!hashes.has("0x0f00"), "sales recorded before the wire column (null wire) are excluded");
  // EVM hex is case-insensitive, so both forms join; base58 is NOT, so it is
  // never case-folded (a lowercased Solana signature is a different signature).
  ok(hashes.has(H_MPP.toLowerCase()), "EVM hashes are carried in lowercase form too");
  ok(!hashes.has(H_SOL.toLowerCase()), "base58 signatures are never lowercased");
  ok(mppSales({ limit: 10 }).count === 2, "mppSales agrees with the hash set");
}

// --- settle receipt tx parser --------------------------------------------------------
const rcpt = Buffer.from(JSON.stringify({ transaction: "0xfeed", network: "eip155:8453" })).toString("base64");
ok(txFromPaymentResponse(rcpt) === "0xfeed", "tx extracted from PAYMENT-RESPONSE receipt");
ok(txFromPaymentResponse("not-base64-json") === null && txFromPaymentResponse("") === null && txFromPaymentResponse(undefined) === null,
  "garbage receipts parse to null");

// --- PUBLIC SHAPE: aggregate only, no customer list, no per-tool ranking -------
// /api/sales is public. Three things must never appear in the default shape:
// payer addresses (a customer list, however public the chain is - the /revenue
// Buyers metric is counts-only for the same reason), per-call rows, and the
// per-tool ranking (that is what the PAID bestsellers tool sells; serving it
// free undercut our own product). This is a leak test, so it asserts on the
// SERIALIZED payload, not just the field names - a nested address would slip
// past a key check.
{
  const BUYER = "0x1111111111111111111111111111111111111111";
  const SVM_BUYER = "TeStKWyNre9PW8XbLfvuBm9f6EnTBYqS5GXTzciCnHw";
  recordSale({ slug: "leak-probe", priceUsd: 0.002, rail: "usdc", network: "base", payer: BUYER, tx: "0xleak1", synthetic: false });
  recordSale({ slug: "leak-probe", priceUsd: 0.002, rail: "usdc", network: "solana", payer: SVM_BUYER, tx: "sigleak", synthetic: false });

  const pub = salesSummary();
  const json = JSON.stringify(pub);
  ok(!json.includes(BUYER) && !json.includes(BUYER.toLowerCase()), "public summary leaks no EVM payer address");
  ok(!json.includes(SVM_BUYER), "public summary leaks no base58 payer address");
  ok(!/0x[0-9a-f]{40}/i.test(json), "public summary contains no EVM-address-shaped string anywhere");
  for (const field of ["recentExternal", "recentInternal", "repeatBuyers", "topExternal"]) {
    ok(!(field in pub), `public summary omits ${field}`);
  }
  ok(!json.includes("0xleak1") && !json.includes("sigleak"), "public summary leaks no settlement tx hashes");
  ok(!json.includes("leak-probe"), "public summary names no individual tool");
  // What it SHOULD carry: proof the market is real, in counts and totals.
  ok(pub.totals?.external?.sales >= 2, "public summary still reports external sale totals");
  ok(pub.distinctExternalBuyers >= 2, `public summary reports a distinct-buyer COUNT (got ${pub.distinctExternalBuyers})`);
  ok(pub.distinctToolsSoldExternal >= 1, "public summary reports a distinct-tools-sold count");
  ok(pub.recordingSince !== undefined, "public summary still states when recording began");

  // Operator mode keeps everything - the itemized view still has to work.
  const op = salesSummary({ detailed: true });
  ok(Array.isArray(op.repeatBuyers) && op.repeatBuyers.some((r) => r.payer === BUYER), "detailed mode still itemizes repeat buyers");
  ok(op.repeatBuyers.some((r) => r.payer === SVM_BUYER), "detailed mode never case-folds a base58 payer");
  ok(Array.isArray(op.topExternal) && op.topExternal.some((r) => r.slug === "leak-probe"), "detailed mode still ranks tools");
  ok(op.recentExternal.some((r) => r.tx === "0xleak1"), "detailed mode still carries per-call rows");
  // Counts must agree across modes, or the public beacon is lying.
  ok(op.repeatBuyers.length === pub.distinctExternalBuyers, "the public buyer COUNT equals the detailed roster length");
  ok(op.topExternal.length === pub.distinctToolsSoldExternal, "the public tool count equals the detailed ranking length");
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
