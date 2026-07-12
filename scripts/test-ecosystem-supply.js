// Offline unit test for aggregateEcosystemSupply — specifically the per-seller
// tool-count cap that stops one giant auto-generated catalogue (e.g. a single
// 10k-tool seller) from dominating a category's `tools` figure. Verifies the
// true uncapped total is still reported, distinct-seller counts are honest, and
// the cap is applied per seller per category. No network.
import assert from "node:assert";
import { aggregateEcosystemSupply } from "../src/x402-index.js";

const mkTools = (n, over) => Array.from({ length: n }, () => ({ ...over }));

// One giant seller with 10,000 uncategorizable tools, plus a handful of small,
// honest sellers offering real categories.
const entries = [
  { tools: mkTools(10000, { name: "widget", description: "", route: "/x", slug: "x" }) }, // all "other"
  { tools: mkTools(5, { name: "bitcoin price", route: "/v1/crypto/btc" }) },              // crypto x5
  { tools: mkTools(8, { name: "forex rate", route: "/v1/fx/eur" }) },                     // finance x8
  { tools: mkTools(3, { name: "web search", route: "/search" }) },                        // search x3
  { error: "boom", tools: [] },                                                           // skipped
];

const r = aggregateEcosystemSupply(entries, { limit: 12, capPerSeller: 50 });

// True, uncapped total is preserved (nothing hidden): 10000+5+8+3 = 10016.
assert.strictEqual(r.tools, 10016, `toolsIndexed should be true total, got ${r.tools}`);
assert.strictEqual(r.sellers, 4, `4 non-error sellers, got ${r.sellers}`);
assert.strictEqual(r.toolsCapPerSeller, 50, "cap echoed for transparency");

const byCat = Object.fromEntries(r.categories.map((c) => [c.category, c]));

// The 10k-tool seller contributes only the cap (50) to "other", NOT 10000.
assert.strictEqual(byCat.other.tools, 50, `other tools should be capped to 50, got ${byCat.other.tools}`);
assert.strictEqual(byCat.other.sellersOffering, 1, "one seller offers 'other'");

// Small honest sellers are under the cap, so their counts are untouched.
assert.strictEqual(byCat.crypto.tools, 5, `crypto uncapped, got ${byCat.crypto.tools}`);
assert.strictEqual(byCat.finance.tools, 8, `finance uncapped, got ${byCat.finance.tools}`);
assert.strictEqual(byCat.search.tools, 3, `search uncapped, got ${byCat.search.tools}`);

// The whole point: a 10k-tool catalogue's contribution collapsed from 10000 to
// the cap (50) — a 200x reduction — so it can no longer swamp the tools column.
assert.ok(byCat.other.tools < 10000 / 100, "capped other must be a fraction of the raw 10k");

// A seller whose single category exceeds the cap is clamped exactly at the cap.
const big = aggregateEcosystemSupply([{ tools: mkTools(200, { name: "bitcoin", route: "/crypto/btc" }) }], { capPerSeller: 50 });
assert.strictEqual(big.categories[0].category, "crypto");
assert.strictEqual(big.categories[0].tools, 50, "200 same-category tools clamp to 50");
assert.strictEqual(big.tools, 200, "but true total stays 200");

console.log("ecosystem-supply cap: all assertions passed");
