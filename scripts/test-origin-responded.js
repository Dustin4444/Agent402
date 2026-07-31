#!/usr/bin/env node
// A registry listing about a seller is not the seller answering.
//
//   node scripts/test-origin-responded.js
//
// WHY: ~32% of our index (742 of 2,296 crawled origins) reached us only as
// `bazaar-fallback` — the manifest fetch failed AND the OpenAPI fetch failed,
// so every field was synthesised from a third-party registry row. The crawl was
// still recorded as successful, because it completed, so those origins sat at
// health 1 / routable true and the marketplace rendered them "healthy". Sampling
// 60 live: 28 returned 404 or 301, several of them marked perfectly healthy.
//
// This is the exact defect we diagnosed in a third party the same day — a seller
// at health 1 with dead paid routes — at scale, in our own data, on a public
// page. A crawl completing is not a seller answering.
import { loadPersistedIndexCache, indexSnapshot, sellerDetail, routableSellerSummaries } from "../src/x402-index.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const tool = (o) => ({ slug: "t", price: 0.002, method: "GET", seller: o, route: "/api/t", networks: ["eip155:8453"] });
const entry = (o, extra) => [o, { origin: o, fetchedAt: Date.now(), history: [1], tools: [tool(o)], ...extra }];

const dir = mkdtempSync(join(tmpdir(), "a402-resp-"));
const file = join(dir, "cache.json");
writeFileSync(file, JSON.stringify({ entries: [
  entry("https://answered.test", { originResponded: true }),
  entry("https://registryonly.test", { originResponded: false, source: "bazaar-fallback" }),
  entry("https://legacy.test", {}), // predates the field
]}));
loadPersistedIndexCache(file);

const snap = indexSnapshot({ baseUrl: "https://agent402.tools", catalog: {}, prices: {}, network: "base", toolCount: 0, walletName: "x" });
const row = (o) => (snap.sellers || []).find((s) => s.origin === o);

// --- the core rule ---------------------------------------------------------
ok(row("https://registryonly.test")?.routable === false,
  "a registry-only origin is NOT routable — we have no evidence it works");
ok(row("https://answered.test")?.routable === true, "an origin that answered stays routable");

// --- absence of the field must not demote anyone ---------------------------
// Entries predating this field carry no signal either way. Demoting them would
// punish sellers for a gap in OUR data, the same rule the payTo match follows.
ok(row("https://legacy.test")?.routable === true,
  "an entry predating the field keeps the old behaviour rather than being demoted");

// --- the field must reach EVERY accessor a consumer reads ------------------
// It was added to two of three first, and totals silently counted every seller
// as responded. A field present on some accessors is the inert-signal defect.
ok(row("https://registryonly.test")?.originResponded === false,
  "indexSnapshot carries originResponded (read by /api/index and the market pages)");
ok(sellerDetail("registryonly.test")?.originResponded === false,
  "sellerDetail carries it (read by seller-trust)");
// routableSellerSummaries filters on isRoutable, so a registry-only origin is
// now ABSENT from it entirely — the router never even considers it. That is
// stronger than carrying the flag, and it is the property that matters: the
// spend gate cannot pick a seller we have never heard answer.
ok(!routableSellerSummaries().some((s) => s.origin === "https://registryonly.test"),
  "a registry-only origin is absent from the router's candidate pool entirely");
const answered = routableSellerSummaries().find((s) => s.origin === "https://answered.test");
ok(Boolean(answered) && answered.originResponded === true,
  "and a seller that answered is present, carrying the flag");

// --- the published count must exclude registry-only records ----------------
ok(snap.totals.respondedOrigins === snap.totals.sellers - 1,
  `respondedOrigins excludes the registry-only record (${snap.totals.respondedOrigins} of ${snap.totals.sellers})`);

rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
