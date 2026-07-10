// Offline unit tests for the /stellar marketplace page renderer. Fixture
// snapshot + fixture rail — no server, no network.
import { stellarSellers, stellarTools, stellarPage } from "../src/stellar-page.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

const localTools = [
  { slug: "hash", name: "Hash", category: "encoding", price: 0.001 },
  { slug: "search", name: "Web search", category: "search", price: 0.01 },
  { slug: "stock-quote", name: "Stock quote", category: "finance", price: 0.01 },
];
const LOCAL = { origin: "self", displayName: "Agent402.Tools", homepage: "https://agent402.tools", local: true, toolCount: 3, tools: localTools };
const EXT_STELLAR = { origin: "https://ext1.example", displayName: "Ext One", homepage: "https://ext1.example", local: false, toolCount: 4, routable: true, networks: ["stellar:pubnet", "eip155:8453"] };
const EXT_EVM = { origin: "https://ext2.example", displayName: "Ext Two", homepage: "https://ext2.example", local: false, toolCount: 2, routable: true, networks: ["eip155:8453"] };
const EXT_TESTNET = { origin: "https://ext3.example", displayName: "Ext Test", homepage: "javascript:alert(1)", local: false, toolCount: 1, routable: true, networks: ["stellar:testnet"] };

const snapBoth = { sellers: [LOCAL, EXT_STELLAR, EXT_EVM], totals: { sellers: 3 } };
const snapOnlyUs = { sellers: [LOCAL, EXT_EVM], totals: { sellers: 2 } };

// Filter helpers
let s = stellarSellers(snapBoth);
ok(s.length === 2 && s[0].local === true && s[1].origin === "https://ext1.example",
  "stellarSellers keeps local + stellar-network sellers, drops EVM-only");
ok(stellarSellers(snapOnlyUs).length === 1, "stellarSellers is 1 when only local qualifies");
ok(stellarSellers({ sellers: [LOCAL, EXT_TESTNET] }).length === 1, "testnet-only sellers excluded");
ok(stellarTools(snapBoth).length === 3 && stellarTools(snapBoth)[0].slug === "hash",
  "stellarTools returns the local catalog's tools");

// Page render — rail present
const rail = { balance: 0.042, recent: [
  { tx: "https://stellar.expert/explorer/public/tx/abc123", when: "2026-07-10T04:15:00Z", usd: 0.001, from: "GBA2DDJ4X", external: false, internal: true },
] };
let html = stellarPage("https://agent402.tools", { snapshot: snapOnlyUs, rail });
ok(html.includes("Stellar x402 marketplace"), "title phrase present");
ok((html.match(/Stellar x402 marketplace/g) || []).length >= 3, "phrase appears in title, h1 and description");
ok(html.includes("stellar.expert/explorer/public/tx/abc123"), "real receipt tx link rendered");
ok(html.includes("1 seller live"), "honesty line rendered when only local seller");
ok(html.includes("network=stellar"), "machine route-filter snippet present");
ok(html.includes("application/ld+json"), "JSON-LD present");
ok(html.includes("OfferCatalog"), "OfferCatalog JSON-LD type present");

// Page render — rail unavailable
html = stellarPage("https://agent402.tools", { snapshot: snapOnlyUs, rail: null });
ok(html.includes("temporarily unavailable"), "rail=null renders the unavailable line");
ok(!html.includes("stellar.expert/explorer/public/tx/"), "no receipt link invented without rail");

// Two sellers → no honesty line, seller row rendered
html = stellarPage("https://agent402.tools", { snapshot: snapBoth, rail: null });
ok(!html.includes("1 seller live"), "honesty line absent with an external stellar seller");
ok(html.includes("Ext One"), "external stellar seller rendered");
ok(!html.includes("Ext Two"), "EVM-only seller not rendered");

// Sole qualifying seller is external → honesty line must not show
const snapExtOnly = { sellers: [EXT_STELLAR], totals: { sellers: 1 } };
html = stellarPage("https://agent402.tools", { snapshot: snapExtOnly, rail: null });
ok(!html.includes("1 seller live"), "honesty line requires the sole seller to be local");

// Malicious homepage href is neutralized, never rendered raw
const EXT_EVIL = { ...EXT_STELLAR, origin: "https://evil.example", displayName: "Evil", homepage: "javascript:alert(1)" };
html = stellarPage("https://agent402.tools", { snapshot: { sellers: [LOCAL, EXT_EVIL] }, rail: null });
ok(html.includes('href="#"'), "malicious homepage href replaced with #");
ok(!html.includes("javascript:alert"), "malicious homepage scheme never rendered raw");

// Seller health markers reflect local/routable state
html = stellarPage("https://agent402.tools", { snapshot: snapBoth, rail: null });
ok(html.includes("healthy"), "external routable seller marked healthy");
ok(html.includes("live"), "local seller marked live");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
