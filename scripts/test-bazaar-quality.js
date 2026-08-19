// Bazaar quality ingestion (2026-08-19): Coinbase-measured 30-day calls /
// distinct payers ride from the Bazaar feed into the index (per resource + per
// origin), into /api/find external results (field + tiebreak), and into the
// SOR gate as positive evidence (folded as MAX in server.js). Offline.
import { routeQuery, bazaarItemToTool, bazaarQualityFor, bazaarQualityEntries, _setBazaarQualityForTest, _cacheForTests, indexSnapshot } from "../src/x402-index.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };

// 1. per-resource quality on the synthesized tool
const item = { resource: "https://q.example/api/ocr", description: "OCR an image", accepts: [{ network: "eip155:8453", amount: "3000", payTo: "0x" + "1".repeat(40), extra: { name: "USD Coin" } }], quality: { l30DaysTotalCalls: 931, l30DaysUniquePayers: 927, lastCalledAt: "2026-08-19T13:00:07.39Z" } };
const t = bazaarItemToTool(item, "https://q.example");
ok(t && t.quality && t.quality.calls30d === 931 && t.quality.payers30d === 927 && t.quality.lastCalledAt === "2026-08-19T13:00:07.39Z", "bazaarItemToTool carries the resource's 30-day quality");
ok(bazaarItemToTool({ ...item, quality: undefined }, "https://q.example").quality === null, "no quality object -> null, never a fake zero");

// 2. per-origin fold: calls summed, payers MAX (never a double-counting sum)
_setBazaarQualityForTest("https://q.example", null);
ok(bazaarQualityFor("https://q.example") === null, "unknown origin -> null");
_setBazaarQualityForTest("https://a.example", { calls30d: 10, payers30d: 2, lastCalledAt: "2026-08-10T00:00:00Z" });
_setBazaarQualityForTest("https://b.example", { calls30d: 3, payers30d: 50, lastCalledAt: "2026-08-18T00:00:00Z" });
ok(bazaarQualityFor("https://b.example/").payers30d === 50 && bazaarQualityEntries().some(([o]) => o === "https://a.example"), "origin lookup tolerates a trailing slash; entries enumerate");

// 3. routeQuery: equal match + equal health -> more Bazaar payers first; field rides on external rows only
const cache = _cacheForTests(); cache.clear();
const seed = (origin, slug) => cache.set(origin, { manifest: { name: origin, homepage: origin }, openapiSummary: null, tools: [{ seller: origin, method: "POST", route: `/api/${slug}`, slug, name: slug, description: "ocr a thing", category: "vision", tags: ["ocr"], price: 0.003 }], fetchedAt: Date.now(), error: null, history: [1, 1, 1, 1, 1] });
seed("https://a.example", "ocr"); seed("https://b.example", "ocr");
const ctx = { baseUrl: "https://agent402.tools", catalog: { "POST /api/ocr-local": { name: "OCR", slug: "ocr-local", category: "vision", price: "$0.01", description: "ocr a thing" } }, prices: { "ocr-local": 0.01 }, network: "base", toolCount: 1, walletName: "agent402.base.eth" };
const r = routeQuery({ query: "ocr", top: 10, include: "external", ...ctx });
const ext = r.results.filter((x) => x.seller !== "agent402.tools" && x.seller.startsWith("https://"));
ok(ext.length === 2 && ext[0].seller === "https://b.example", `equal match + health: the seller more wallets paid this month ranks first (got ${ext.map((x) => x.seller).join(", ")})`);
ok(ext[0].bazaar?.payers30d === 50 && ext[1].bazaar?.payers30d === 2, "external rows carry the Bazaar quality object");
const local = routeQuery({ query: "ocr", top: 10, ...ctx }).results.find((x) => x.slug === "ocr-local");
ok(local && local.bazaar === undefined, "local rows never carry a bazaar object");
const snap = indexSnapshot(ctx);
const b = (snap.sellers || []).find((s) => s.origin === "https://b.example");
ok(b && b.bazaar?.payers30d === 50 && b.bazaar?.calls30d === 3, "index snapshot sellers expose bazaar quality");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
