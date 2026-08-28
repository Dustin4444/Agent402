#!/usr/bin/env node
// Router ranking rules added 2026-08-28 (offline, synthetic catalog):
//   1. a tool's curated `aliases` score exactly like its slug (max, never additive),
//   2. a query term under three characters matches whole tokens only - "ip" used
//      to substring-match gzip / gunzip / html-strip and outrank every IP tool.
process.env.X402_INDEX_CRAWL = "off";
const { routeQuery } = await import("../src/x402-index.js");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL: ${m}`); } };
const tool = (slug, name, description, extra = {}) => [`POST /api/${slug}`, { route: `POST /api/${slug}`, slug, name, description, price: "$0.002", tags: [], category: "x", discovery: { input: {} }, handler: async () => ({}), ...extra }];
const catalog = Object.fromEntries([
  tool("asn-info", "ASN + IP geolocation", "Autonomous system and geolocation for an address.", { aliases: ["ip-geolocation", "geoip"], price: "$0.003" }),
  tool("ip-info", "IP info", "Classify an IP address."),
  tool("gzip", "Gzip", "Compress text with gzip."),
  tool("html-strip", "HTML strip", "Strip tags from HTML."),
  tool("qr", "QR code", "Render a QR code."),
]);
const run = (q) => routeQuery({ query: q, top: 5, include: "local", baseUrl: "http://agent402.test", catalog, toolCount: 5 }).results.map((r) => r.slug);
ok(run("geoip")[0] === "asn-info", `an alias matches exactly like a slug (geoip -> ${run("geoip")[0]})`);
ok(run("ip geolocation")[0] === "asn-info", `alias substring + name beat a plain name match (ip geolocation -> ${run("ip geolocation").join(",")})`);
const ipq = run("ip geolocation");
ok(!ipq.includes("gzip") && !ipq.includes("html-strip"), "a two-letter term never substring-matches gzip or html-strip");
ok(run("ip")[0] === "ip-info" && !run("ip").includes("gzip"), `a bare short term matches the slug token (ip -> ${run("ip").join(",")})`);
ok(run("qr code")[0] === "qr", "unrelated ranking unchanged");
const scored = routeQuery({ query: "geoip ip-geolocation", top: 5, include: "local", baseUrl: "http://agent402.test", catalog, toolCount: 5 }).results[0];
ok(scored.slug === "asn-info" && (scored.matched?.slug ?? 0) <= 20, "two alias hits are the max per term, never summed across aliases");
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
