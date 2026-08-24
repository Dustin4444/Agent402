#!/usr/bin/env node
// An x402 v2 manifest can be the spec's own 402 body: a single top-level
// `resource` plus `accepts`, with no catalogue array. Every catalogue reader
// here looks for an ARRAY, so that shape fell through all of them and the
// seller's payment terms were read not at all.
//
// Found live 2026-08-24 on a seller who had ASKED to be listed: we listed them
// from their OpenAPI with 7 tools and network: null, so they showed on the
// marketplace while the router could never chain-match them. Listed and
// unroutable is worse than absent, because it looks like it worked.
//
// Two independent halves, and the seller needed both: reading the shape at all,
// and letting what it says reach a row an OpenAPI already reported.
import { normaliseManifestTools, singleResourceManifestTool, mergeManifestIntoTools } from "../src/x402-index.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error("FAIL:", m); } };
const ORIGIN = "https://seller.example";

// The exact shape that shipped (values generic).
const MANIFEST = {
  x402Version: 2,
  resource: {
    url: `${ORIGIN}/storefront/v1/capabilities/thing.verify/1.0.0/invoke`,
    description: "Deterministically verify a thing.",
    mimeType: "application/json",
    serviceName: "Thing Verify",
    tags: ["verification", "deterministic"],
  },
  accepts: [{
    scheme: "exact",
    network: "eip155:8453",
    amount: "1000",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    payTo: "0x00000000000000000000000000000000000000aa",
    maxTimeoutSeconds: 60,
    extra: { name: "USDC", version: "2" },
  }],
};
const ROUTE = "/storefront/v1/capabilities/thing.verify/1.0.0/invoke";

// --- half one: the shape is read at all -------------------------------------
const tools = normaliseManifestTools(MANIFEST, ORIGIN);
ok(tools.length === 1, `single-resource manifest yielded ${tools.length} tools, want 1`);
const t = tools[0] || {};
ok(t.route === ROUTE, `route ${t.route}`);
ok(t.price === 0.001, `price ${t.price} (1000 atomic USDC is $0.001)`);
ok(JSON.stringify(t.networks) === '["eip155:8453"]', `networks ${JSON.stringify(t.networks)}`);
ok(t.payToByNetwork?.["eip155:8453"] === "0x00000000000000000000000000000000000000aa",
  `payTo ${JSON.stringify(t.payToByNetwork)}`);
ok(t.name === "Thing Verify", `name ${t.name}`);
ok(t.provenance === "manifest", `provenance ${t.provenance} - the seller said this, no registry observed it`);

// A bare URL string is the other legal form of `resource`.
ok(normaliseManifestTools({ ...MANIFEST, resource: MANIFEST.resource.url }, ORIGIN).length === 1,
  "resource as a bare URL string is not read");

// --- half two: it reaches a row an OpenAPI already reported -----------------
// An OpenAPI document carries no payment metadata, so this row starts chainless.
const fromOpenapi = [{
  seller: ORIGIN, method: "POST", route: ROUTE, slug: "invoke",
  name: "/storefront/v1/capabilities/thing.verify/1.0.0/invoke",
  description: "", price: null, networks: [], payToByNetwork: {},
}];
const merged = mergeManifestIntoTools(tools, fromOpenapi);
ok(merged.length === 1, `merge duplicated the row (${merged.length}) - the 16->30 guard`);
ok(JSON.stringify(merged[0].networks) === '["eip155:8453"]',
  `merged row has no chain: ${JSON.stringify(merged[0].networks)} - this is the router-invisible case`);
ok(merged[0].payToByNetwork?.["eip155:8453"] === "0x00000000000000000000000000000000000000aa",
  "merged row has no payTo, so no per-chain market page can scope to it");
ok(merged[0].price === 0.001, `merged price ${merged[0].price}`);
ok(merged[0].name === "Thing Verify", "manifest name did not replace the path-shaped OpenAPI name");

// Blank-fill ONLY: an observed live 402 outranks a manifest claim.
const observed = [{
  seller: ORIGIN, method: "POST", route: ROUTE, slug: "invoke", name: "Observed",
  description: "seen live", price: 0.002,
  networks: ["eip155:137"], payToByNetwork: { "eip155:137": "0x00000000000000000000000000000000000000bb" },
}];
const kept = mergeManifestIntoTools(tools, observed);
ok(JSON.stringify(kept[0].networks) === '["eip155:137"]',
  "a manifest claim overwrote chains we had already observed live");
ok(kept[0].payToByNetwork?.["eip155:137"] === "0x00000000000000000000000000000000000000bb",
  "a manifest claim overwrote an observed payTo - this is how a seller gets paid at the wrong address");
ok(kept[0].price === 0.002, "a manifest claim overwrote an observed price");

// --- refusals: nothing is invented ------------------------------------------
ok(singleResourceManifestTool({ x402Version: 2, resource: MANIFEST.resource }, ORIGIN) === null,
  "a resource with no accepts was turned into a tool anyway");
ok(singleResourceManifestTool({ x402Version: 2, accepts: MANIFEST.accepts }, ORIGIN) === null,
  "accepts with no resource was turned into a tool anyway");
ok(singleResourceManifestTool({ ...MANIFEST, resource: { url: "https://someone-else.example/x" } }, ORIGIN) === null,
  "a resource on ANOTHER origin was listed as this seller's tool");
ok(normaliseManifestTools({ x402Version: 2 }, ORIGIN).length === 0, "an empty manifest produced tools");
ok(normaliseManifestTools(null, ORIGIN).length === 0, "a null manifest produced tools");

// A manifest that DOES carry a catalogue must still use it, not this fallback.
const withCatalogue = { ...MANIFEST, tools: [{ resource: `${ORIGIN}/a`, price: "$0.05" }, { resource: `${ORIGIN}/b`, price: "$0.05" }] };
ok(normaliseManifestTools(withCatalogue, ORIGIN).length === 2,
  "a manifest with a real catalogue fell back to the single-resource reader");

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
