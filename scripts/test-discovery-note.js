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
import { normaliseOpenapiTools, normaliseLlmsTxtTools, synthManifestFromBazaar } from "../src/x402-index.js";

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

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
