// Unit tests for the one-call tool resolver (/api/find). Pure, no network.
import { findTools } from "../src/find.js";
import { API_TOOLS } from "../src/tools/api-kit.js";
import { CRYPTO_TOOLS } from "../src/tools/crypto-kit.js";
import { buildRouteExecuteTool, EXEC_TIERS } from "../src/tools/route-execute.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const CATALOG = {
  "POST /api/extract": { name: "Extract article", slug: "extract", category: "web", price: "$0.005", description: "Extract the main article content from any URL as clean markdown.", tags: ["scraping", "markdown", "content"], discovery: { inputSchema: { properties: { url: { type: "string" } }, required: ["url"] }, input: { url: "https://example.com/article" } } },
  "POST /api/qr": { name: "QR code", slug: "qr", category: "identifiers", price: "$0.001", description: "Generate a QR code PNG from text or a URL.", tags: ["qr", "barcode"], discovery: { inputSchema: { properties: { text: { type: "string" } } }, input: { text: "hello" } } },
  "POST /api/unit-convert": { name: "Unit convert", slug: "unit-convert", category: "math", price: "$0.001", description: "Convert a value between units of length, mass, temperature and more (e.g. miles, kilograms, fahrenheit).", tags: ["units", "convert", "length", "mass"], discovery: { example: { value: 100, from: "fahrenheit", to: "celsius" } } },
  "GET /api/time-now": { name: "Time now", slug: "time-now", category: "time", price: "$0.001", description: "Current time in a timezone.", tags: ["time", "timezone"], discovery: { example: { tz: "UTC" } } },
  "POST /api/hash": { name: "Hash", slug: "hash", category: "encoding", price: "$0.001", description: "Hash text with sha256/md5/etc.", tags: ["sha256", "crypto"], discovery: { inputSchema: { properties: { text: { type: "string" } }, required: ["text"] }, input: { text: "hi", algo: "sha256" } } },
};
const POW = new Set(["qr", "hash", "unit-convert", "time-now"]);

// Exact slug term wins.
let r = findTools(CATALOG, "extract", { baseUrl: "https://agent402.tools", powSlugs: POW });
ok(r.results[0].slug === "extract", `"extract" → extract first (got ${r.results[0]?.slug})`);
ok(r.results[0].route === "POST /api/extract" && r.results[0].price === "$0.005", "result carries route + price");
ok(r.results[0].inputSchema && r.results[0].example?.url, "result carries inputSchema + example");
ok(r.results[0].docs === "https://agent402.tools/tools/extract", "result carries docs link");
ok(r.results[0].computePayable === false, "extract flagged not compute-payable");
// Prominent discovery: required keys + a pre-assembled callExample so an agent
// can call without splitting route or guessing body-vs-query.
ok(Array.isArray(r.results[0].required) && r.results[0].required[0] === "url", `result carries required keys (got ${JSON.stringify(r.results[0].required)})`);
ok(r.results[0].callExample?.method === "POST" && r.results[0].callExample?.path === "/api/extract" && r.results[0].callExample?.body?.url === "https://example.com/article", `POST callExample is method+path+body (got ${JSON.stringify(r.results[0].callExample)})`);
// Field order: callExample / example / required must come before description.
const k = Object.keys(r.results[0]);
ok(k.indexOf("callExample") < k.indexOf("description") && k.indexOf("example") < k.indexOf("description"), `callExample + example come before description (keys: ${k.join(",")})`);

// Natural-language task resolves to the surviving parametric converter — the
// unit-word synonym expansion maps "miles"/"kilometers" onto the "units" tag.
r = findTools(CATALOG, "convert miles to kilometers", {});
ok(r.results[0].slug === "unit-convert", `NL task → unit-convert (got ${r.results[0]?.slug})`);
// A tool with no required[] returns required:[] (not undefined) so agents can scan safely.
ok(Array.isArray(r.results[0].required) && r.results[0].required.length === 0, `no-required tool returns required:[] (got ${JSON.stringify(r.results[0].required)})`);
// GET tools put the example values on query, not body.
r = findTools(CATALOG, "current time in a timezone", {});
ok(r.results[0].slug === "time-now", `NL task → time-now (got ${r.results[0]?.slug})`);
ok(r.results[0].callExample?.method === "GET" && r.results[0].callExample?.path === "/api/time-now" && r.results[0].callExample?.query?.tz === "UTC" && !("body" in r.results[0].callExample), `GET callExample uses query, not body (got ${JSON.stringify(r.results[0].callExample)})`);

r = findTools(CATALOG, "make a qr code for a url", { powSlugs: POW });
ok(r.results[0].slug === "qr", `"qr code" → qr (got ${r.results[0]?.slug})`);
ok(r.results[0].computePayable === true, "qr flagged compute-payable");

// Description/tag hit still matches (no slug overlap).
r = findTools(CATALOG, "sha256 checksum", {});
ok(r.results.length > 0 && r.results[0].slug === "hash", `tag match → hash (got ${r.results[0]?.slug})`);

// Stopwords are stripped: a stopword-only query matches nothing.
ok(findTools(CATALOG, "the", {}).count === 0, "single stopword → no results");
ok(findTools(CATALOG, "of in on to for", {}).count === 0, "all-stopword query → no results");

// Stopwords don't poison NL queries — intent words still rank correctly.
r = findTools(CATALOG, "i would like to extract an article from the web", {});
ok(r.results[0]?.slug === "extract", `NL with stopwords → extract still wins (got ${r.results[0]?.slug})`);

// Exact tag match outranks a description-only hit. "barcode" is a tag on qr,
// not in qr's slug/name; "notes" mentions barcode only in description text.
const TAG_CATALOG = {
  "POST /api/qr": { name: "QR code", slug: "qr", category: "identifiers", price: "$0.001", description: "Generate a QR code PNG.", tags: ["qr", "barcode"], discovery: { input: { text: "hi" } } },
  "POST /api/notes": { name: "Notes", slug: "notes", category: "misc", price: "$0.001", description: "Plain text notes. Discusses barcode formats in passing.", tags: [], discovery: { input: { text: "hi" } } },
};
r = findTools(TAG_CATALOG, "barcode", {});
ok(r.results[0]?.slug === "qr", `exact tag match outranks description-only hit (got ${r.results[0]?.slug})`);

// Empty / no-match / k limit / guards.
ok(findTools(CATALOG, "", {}).count === 0, "empty query → no results");
ok(findTools(CATALOG, "   ", {}).count === 0, "whitespace query → no results");
ok(findTools(CATALOG, "zzzzznomatch", {}).count === 0, "no-match query → empty");
r = findTools(CATALOG, "convert hash qr extract", { k: 2 });
ok(r.results.length === 2, `k=2 caps results (got ${r.results.length})`);
ok(findTools(CATALOG, null, {}).count === 0, "null query handled");
// Pathological long input must not throw.
ok(findTools(CATALOG, "x ".repeat(5000) + "extract", {}).results.length >= 0, "long input handled without throwing");

// Serializes cleanly (served as JSON).
JSON.parse(JSON.stringify(findTools(CATALOG, "extract", { baseUrl: "https://agent402.tools", powSlugs: POW })));


// ---- find->seller bridge: seller-name queries resolve to indexed sellers ----
// 25 recorded find-misses for "minia2a" were agents hunting the INDEXED
// seller minia2a.uk; /api/find is catalog-only, so they missed forever.
{
  const { findRelatedSellers } = await import("../src/find.js");
  const sellers = [
    { host: "minia2a.uk", origin: "https://minia2a.uk", toolCount: 89 },
    { host: "www.cloudworldmodel.ai", origin: "https://www.cloudworldmodel.ai", toolCount: 42 },
    { host: "api.example.com", origin: "https://api.example.com", toolCount: 3 },
    { host: "minia2a.io", origin: "https://minia2a.io", toolCount: 5 },
  ];
  const one = findRelatedSellers("minia2a", sellers);
  ok(one.length === 2 && one[0].host === "minia2a.uk", `exact label match, tool-count ranked (got ${JSON.stringify(one.map((s) => s.host))})`);
  ok(one[0].toolCount === 89 && !("displayName" in one[0]), "carries only host/origin/toolCount - no third-party text");
  ok(findRelatedSellers("cloudworldmodel", sellers)[0]?.host === "www.cloudworldmodel.ai", "substring match ignores www. and TLD");
  ok(findRelatedSellers("extract the article from this url", sellers).length === 0, "a task-shaped query matches no seller");
  ok(findRelatedSellers("api", sellers).length === 0, "a short generic term does not match a seller label by substring");
  ok(findRelatedSellers("", sellers).length === 0 && findRelatedSellers("ab", sellers).length === 0, "empty/too-short queries are ignored");
  ok(findRelatedSellers("minia2a", []).length === 0 && findRelatedSellers("x", null).length === 0, "no sellers / bad input is empty, not a crash");
}
// ---- delegated-purchase intent resolves to the Smart Order Router ----
// Audited 2026-07-28: agents asking the natural way ("buy a tool from another
// seller", "pay an external api on my behalf") got unrelated tools, because
// "api" matches every openapi-* slug and "pay" matches "payload". The
// synthetic "sor" term fixes intent WITHOUT touching ordinary buy/pay queries -
// both halves are pinned here, and the regression half is the important one.
{
  const catalog = {};
  for (const t of [...API_TOOLS, ...CRYPTO_TOOLS]) catalog[t.route] = t;
  const re = buildRouteExecuteTool({ getCatalog: () => ({}), baseUrl: "https://x", tier: EXEC_TIERS[0] });
  catalog[re.route] = re;
  const top = (q) => findTools(catalog, q, { k: 3, baseUrl: "https://x", powSlugs: new Set() }).results.map((r) => r.slug);
  for (const q of ["buy a tool from another seller", "purchase from an x402 seller", "outsource this task to a vendor", "pay an external api on my behalf"]) {
    ok(top(q).includes("route-execute"), `SOR intent resolves: "${q}" -> ${JSON.stringify(top(q))}`);
  }
  // The invariant that matters: the DOMAIN tool still wins. route-execute may
  // appear lower down (it carries buy/purchase tags and genuinely can buy
  // these), but it must never displace the tool that actually answers.
  for (const [q, want] of [["buy bitcoin price", "crypto-price"], ["purchase price of ethereum", "crypto-price"], ["order book for a token", "crypto-orderbook"]]) {
    ok(top(q)[0] === want, `ordinary commerce query still resolves to ${want}: "${q}" -> ${JSON.stringify(top(q))}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
