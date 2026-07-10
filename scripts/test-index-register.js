// Offline unit tests for self-serve listing: origin validation + the
// registerOrigin flow with an injected fake crawler. No network, no /data.
import { validateOriginInput, registerOrigin, __testResetSubmitted } from "../src/x402-index.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

// --- validation ---
ok(validateOriginInput("https://example.com").origin === "https://example.com", "plain https origin accepted");
ok(validateOriginInput("https://Example.COM/").origin === "https://example.com", "trailing slash + case normalized");
ok(validateOriginInput("http://example.com").error != null, "http rejected");
ok(validateOriginInput("https://example.com/api").error != null, "path rejected");
ok(validateOriginInput("https://example.com?x=1").error != null, "query rejected");
ok(validateOriginInput("https://user:pw@example.com").error != null, "userinfo rejected");
ok(validateOriginInput("https://example.com:8443").error != null, "non-443 port rejected");
ok(validateOriginInput("https://localhost").error != null, "dotless host rejected");
ok(validateOriginInput("not a url").error != null, "garbage rejected");
ok(validateOriginInput("https://agent402.tools", { selfOrigin: "https://agent402.tools" }).error != null, "own origin rejected");

// --- registerOrigin with injected crawler ---
__testResetSubmitted();
let crawled = [];
const goodCrawl = async (o) => { crawled.push(o); return { manifest: { name: "Ext" }, tools: [{ slug: "a" }], error: null, history: [true] }; };
const badCrawl = async (o) => { crawled.push(o); return { error: "no manifest, no openapi, no bazaar entries", history: [false] }; };

let r = await registerOrigin("https://newseller.example", { crawl: goodCrawl });
ok(r.listed === true && r.origin === "https://newseller.example", "successful probe lists the origin");
ok(r.seller && typeof r.seller.toolCount === "number", "response carries a seller summary");
ok(crawled.length === 1, "crawler invoked once for unknown origin");

r = await registerOrigin("https://deadseller.example", { crawl: badCrawl });
ok(r.listed === false && typeof r.error === "string", "failed probe returns honest error, not listed");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
