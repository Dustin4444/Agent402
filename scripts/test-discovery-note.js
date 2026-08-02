#!/usr/bin/env node
// A gap nobody can see is a gap nobody fixes.
//
//   node scripts/test-discovery-note.js
//
// WHY: in #645 a seller could see us request their /.well-known/x402 686 times
// in a week and take 404 every time; we could see a thin seller. Neither side
// could see the other half. Their catalogue was at /agents.json the whole time.
//
// discoveryNote() is the one line that closes that. These assertions pin the
// two ways it can quietly stop working:
//   * it renders for a seller who IS on the spec path (noise, so it gets
//     ignored, so the real signal is lost with it), or
//   * it says nothing for a seller who is NOT (silence, which is the bug).
import { discoveryNote, WELL_KNOWN_PATH } from "../src/discovery-note.js";
import { normaliseOpenapiTools, normaliseLlmsTxtTools, normaliseManifestTools, mergeManifestIntoTools, synthManifestFromBazaar } from "../src/x402-index.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// --- the note itself ---
ok(discoveryNote({ discoveryPath: WELL_KNOWN_PATH }) === null,
  "a seller on the spec path gets NO note - it must not become decoration");

const agents = discoveryNote({ discoveryPath: "/agents.json" });
ok(agents && agents.includes("/agents.json"),
  "a seller read via /agents.json is told which path we actually read");
ok(agents && agents.includes(WELL_KNOWN_PATH),
  "...and which path they are missing, since that is the actionable half");

const oapi = discoveryNote({ discoveryPath: "/openapi.json" });
ok(oapi && oapi.includes("/openapi.json") && !oapi.includes("/agents.json"),
  "the note names the surface that answered, not a generic 'fallback'");

// `source` collapses both fallbacks to "openapi-fallback", which is exactly the
// ambiguity that would send a seller to fix the wrong file.
ok(agents !== oapi, "the two fallback paths produce DIFFERENT notes");

const listed = discoveryNote({ discoveryPath: null, originResponded: false });
ok(listed && /registry/i.test(listed),
  "a registry-only record says plainly that nothing came from the seller");

ok(discoveryNote({ discoveryPath: null, originResponded: true }) === null,
  "an origin that answered but predates the field is not accused of a gap");
ok(discoveryNote(null) === null && discoveryNote(undefined) === null,
  "a missing entry never throws on a render path");

// --- the /agents.json fallback that made the note necessary ---
// Shape taken from the reporter's real document: an agents.json catalogue is
// an OpenAPI doc, so the existing normaliser must handle it unchanged.
const doc = {
  openapi: "3.0.0",
  info: { title: "Example Compliance Tools" },
  paths: Object.fromEntries(
    Array.from({ length: 17 }, (_, i) => [`/api/tool-${i}`, {
      post: { operationId: `tool-${i}`, summary: `Tool ${i}`, "x-price": "$0.01" },
    }]),
  ),
};
const tools = normaliseOpenapiTools(doc, "https://example.test");
ok(tools.length === 17, `a 17-endpoint agents.json yields 17 tools (got ${tools.length})`);
ok(tools.every((t) => t.route && t.route.startsWith("/api/tool-")),
  "routes survive the normaliser - a thin listing was the symptom we are fixing");
ok(tools.some((t) => /tool-0/.test(t.slug || "")),
  "operationId reaches the slug, so the router can actually rank these");

// --- the /llms.txt fallback, the riskier half of the #645 ask ---
// llms.txt is PROSE. A greedy scrape inflates the index with things nobody can
// buy, which is worse than listing a seller thinly - a thin listing is
// recoverable, a fabricated one is not. So the refusals below matter more than
// the acceptances.
const llms = [
  "# Example Seller",
  "",
  "> Pay-per-call tools. Prices from $0.001.",   // prose w/ a price, no link
  "",
  "## Tools",
  "- [Allowance check](https://seller.test/api/allowance): read-only, $0.002 per call",
  "- [Simulate tx](https://seller.test/api/simulate): decoded revert reason, $0.01",
  "- [Docs](https://seller.test/docs): how it all works",              // no price
  "- [Our blog](https://blog.other.test/post): we wrote about x402, $0.01", // cross-origin
  "- [Manifest](https://seller.test/.well-known/x402): $0.00",         // discovery path
  "- [Logo](https://seller.test/logo.png): our mark, $0.01",           // static asset
  "- [Allowance check](https://seller.test/api/allowance): duplicate, $0.002",
  "Just a sentence mentioning https://seller.test/api/ghost and $0.05.",
].join("\n");
const lt = normaliseLlmsTxtTools(llms, "https://seller.test");

ok(lt.length === 2, `only the two priced, same-origin endpoints are read (got ${lt.length})`);
ok(lt.every((t) => t.route.startsWith("/api/")), "and both are real routes");
ok(!lt.some((t) => /blog|other\.test/.test(t.route + t.name)),
  "a CROSS-ORIGIN link is never listed as this seller's tool");
ok(!lt.some((t) => t.route === "/docs"), "an unpriced link is a doc, not a tool");
ok(!lt.some((t) => /well-known/.test(t.route)), "the discovery path is not itself a tool");
ok(!lt.some((t) => /\.png$/.test(t.route)), "a static asset is not a tool");
ok(new Set(lt.map((t) => t.route)).size === lt.length, "a repeated route is emitted once");
ok(!lt.some((t) => /ghost/.test(t.route)),
  "a bare URL in a sentence is NOT a tool - only the link-list shape is read");
ok(lt[0].price === "$0.002" && lt[1].price === "$0.01", "the stated price survives verbatim");
ok(lt.every((t) => t.paid === true && t.seller === "https://seller.test"),
  "entries are attributed and marked paid, so paid routing can use them");

ok(normaliseLlmsTxtTools("", "https://seller.test").length === 0 &&
   normaliseLlmsTxtTools(null, "https://seller.test").length === 0 &&
   normaliseLlmsTxtTools(llms, "not a url").length === 0,
  "empty, null, and an unparseable origin all yield nothing rather than throwing");

// A seller found ONLY via llms.txt has no openapi document, so the manifest is
// synthesised from the (possibly empty) registry rows. That path must not throw
// on the way to rendering their card.
let threw = null;
try { synthManifestFromBazaar("https://seller.test", []); } catch (e) { threw = e; }
ok(!threw, `manifest synthesis survives an llms.txt-only seller (${threw?.message || "no throw"})`);

// --- the catalogue a seller publishes inside their own manifest ---
// We parsed /.well-known/x402 for identity and payment and threw its tool list
// away. Sampling 44 reachable manifest sellers, 5 advertised more entries than
// we listed, one publishing 14 against our 1. Every dialect below was taken
// from a real manifest, not invented.

// Dialect A: objects with a full-URL endpoint carrying a query template.
const A = normaliseManifestTools({ tools: [
  { name: "validate_vat", price_usd: 0.002, endpoint: "https://s.test/x402/vat/{vat_id}", summary: "EU VAT ID validation" },
  { name: "market_brief", price_usd: 0.005, endpoint: "https://s.test/x402/market?product=market_brief", summary: "Aggregated market" },
  { name: "commodities", price_usd: 0.04, endpoint: "https://s.test/x402/market?product=commodities", summary: "Soft commodities" },
]}, "https://s.test");
ok(A.length === 3, `objects with endpoint URLs are read (got ${A.length})`);
ok(A.filter((t) => t.route.startsWith("/x402/market")).length === 2,
  "two products differing ONLY by ?query stay two tools - collapsing them is how 17 reads as 16");
ok(A[0].price === "$0.002" && A[2].price === "$0.04", "numeric price_usd becomes a dollar string");
ok(A[0].name === "validate_vat" && /VAT ID validation/.test(A[0].description),
  "the seller's own name and summary survive, which is what makes a listing not thin");

// Dialect B: bare strings.
const B = normaliseManifestTools({ resources: [
  "https://s.test/agents/x402/_bundle",   // same-origin absolute
  "POST /exchange/sell-clams",            // verb glued to a path
  "/plain/path",                          // bare path
  "https://someone-else.test/api/thing",  // SOMEONE ELSE'S origin
  "https://s.test/.well-known/x402",      // the discovery path itself
]}, "https://s.test");
ok(B.length === 3, `three readable string forms, got ${B.length}`);
ok(B.some((t) => t.method === "POST" && t.route === "/exchange/sell-clams"),
  "'POST /path' yields both the verb and the route");
ok(!B.some((t) => /someone-else/.test(t.seller + t.route)),
  "a manifest listing ANOTHER origin never puts those tools under this seller");
ok(!B.some((t) => /well-known/.test(t.route)), "the discovery path is not a tool");
ok(B.every((t) => t.seller === "https://s.test"), "every entry is attributed to the publisher");

// Attribution is the load-bearing rule: mis-attributing puts another seller's
// tools under this seller's payTo, which is a payment error, not a cosmetic one.
const cross = normaliseManifestTools(
  { resources: ["https://mecha.test/api/horoscope", "https://other.test/api/x"] }, "https://aggregator.test");
ok(cross.length === 0, "an aggregator manifest that lists only foreign origins yields NOTHING");

ok(normaliseManifestTools(null, "https://s.test").length === 0 &&
   normaliseManifestTools({}, "https://s.test").length === 0 &&
   normaliseManifestTools({ tools: [] }, "https://s.test").length === 0 &&
   normaliseManifestTools({ tools: ["x"] }, "not a url").length === 0,
  "null, empty, and an unparseable origin yield nothing rather than throwing");

const dup = normaliseManifestTools({ resources: ["/a", "/a", "GET /a"] }, "https://s.test");
ok(dup.length === 1, "the same method+route is emitted once");

// --- folding the manifest in without inflating (the 16 -> 30 regression) ---
// The first version of the manifest read shipped without this and DOUBLED a
// seller: manifest entries declare no verb (so they default to GET) and carry
// query templates, while the same endpoints arrive from registry rows as bare
// POST paths. Route-keyed merging saw two endpoints where there was one, for
// 11 of that seller's 17 entries. Listing one endpoint twice overstates the
// seller and hands the router two candidates that are one.
const existing = [
  { seller: "https://s.test", method: "POST", route: "/x402/preflight", name: "/x402/preflight", description: "", price: null },
  { seller: "https://s.test", method: "POST", route: "/x402/market", name: "/x402/market", description: "", price: null },
];
const fromManifest = [
  { seller: "https://s.test", method: "GET", route: "/x402/preflight?chain=base&sender={0x}", name: "transaction_preflight", description: "Six checks", price: "$0.005", slug: "transaction_preflight" },
  { seller: "https://s.test", method: "GET", route: "/x402/market?product=commodities", name: "commodities", description: "Soft commodities", price: "$0.04", slug: "commodities" },
  { seller: "https://s.test", method: "GET", route: "/x402/market?product=market_brief", name: "market_brief", description: "Brief", price: "$0.005", slug: "market_brief" },
  { seller: "https://s.test", method: "GET", route: "/x402/einvoice", name: "validate_einvoice", description: "EN 16931", price: "$0.02", slug: "validate_einvoice" },
];
const merged = mergeManifestIntoTools(fromManifest, existing);

ok(merged.length === 4,
  `2 known paths + 1 new + the extra market variant = 4 (got ${merged.length})`);
ok(merged.filter((t) => t.route.split("?")[0] === "/x402/preflight").length === 1,
  "ONE advertised resource on a known path does not double it - the 16 to 30 regression");

// The seller who reported the original bug flagged this about the FIX: keying
// on pathname alone silently loses variants. A single route often sells
// different things by parameter, at different prices. Both must survive, and
// the bare row they describe must not survive alongside them.
const mkt = merged.filter((t) => t.route.split("?")[0] === "/x402/market");
ok(mkt.length === 2, `two products on one path stay TWO, not folded to one (got ${mkt.length})`);
ok(new Set(mkt.map((t) => t.route)).size === 2, "and they stay distinguishable by their parameters");
ok(!merged.some((t) => t.route === "/x402/market"),
  "the parameterless row they describe is REPLACED, not kept beside them - that would list it 3 times");
ok(mkt.every((t) => t.method === "POST"),
  "the observed verb carries across to the variants; a manifest's defaulted GET never overwrites it");
ok(merged.some((t) => t.route === "/x402/einvoice"),
  "an endpoint only the manifest knows about IS added - that is the under-listing fix");

const pre = merged.find((t) => t.route.split("?")[0] === "/x402/preflight");
ok(pre.method === "POST",
  "an OBSERVED verb wins over the manifest's silence - a defaulted GET must not overwrite it");
ok(pre.name === "transaction_preflight" && pre.price === "$0.005" && /Six checks/.test(pre.description),
  "but the manifest's name, price and summary fill the gaps, which is why we read it at all");

const observed = [{ seller: "https://s.test", method: "POST", route: "/x402/chat", name: "Real Name", description: "observed", price: "$0.01" }];
const claimed = [{ seller: "https://s.test", method: "GET", route: "/x402/chat", name: "claimed", description: "claimed", price: "$9.99" }];
const m2 = mergeManifestIntoTools(claimed, observed);
ok(m2.length === 1 && m2[0].name === "Real Name" && m2[0].price === "$0.01" && m2[0].description === "observed",
  "a claimed value NEVER overwrites an observed one, only fills a blank");

ok(mergeManifestIntoTools([], existing).length === 2 &&
   mergeManifestIntoTools(fromManifest, []).length === 4,
  "empty on either side degrades to the other side unchanged");

// A path nobody else reported keeps its variants without needing a row to
// replace - the manifest-only seller case.
const solo = mergeManifestIntoTools(fromManifest, []);
ok(solo.filter((t) => t.route.split("?")[0] === "/x402/market").length === 2,
  "a manifest-only path keeps both of its variants too");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
