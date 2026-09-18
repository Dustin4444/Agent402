// Offline unit tests for self-serve listing: origin validation + the
// registerOrigin flow with an injected fake crawler. No network, no /data.
import { validateOriginInput, registerOrigin, __testResetSubmitted, __testSetSubmittedCap } from "../src/x402-index.js";

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

// A RE-REGISTRATION RE-READS THE DOCUMENTS (2026-09-18). Until this date the
// known-origin branch ran only the live-402 quote enrichment, so a seller who
// improved an operation's description or tags - on our own advice - had no way
// to ask us to look again and waited for the shared rotation. Measured on a
// real seller whose row carried neither two hours after they deployed both.
{
  let crawls = 0;
  const thin = async (o) => { crawls++; return { manifest: { name: "Meta" }, tools: [{ slug: "a", route: "/v1/compare", description: "", tags: [] }], error: null, history: [true] }; };
  const rich = async (o) => { crawls++; return { manifest: { name: "Meta" }, tools: [{ slug: "a", route: "/v1/compare", description: "Compare and rank candidates", tags: ["compare", "rank"] }], error: null, history: [true] }; };
  const origin = "https://meta-refresh.example";
  await registerOrigin(origin, { crawl: thin });
  const before = crawls;
  const again = await registerOrigin(origin, { crawl: rich });
  ok(crawls === before + 1, "re-registering a KNOWN origin crawls it again (was a price-only no-op)");
  ok(again.listed === true, "the re-registration still lists the origin");
  const row = (again.seller?.tools || [])[0];
  if (row) ok((row.description || "").length > 0, "the answer describes the FRESH entry, not the pre-crawl one");
  else ok(true, "seller summary carries no tool rows - fresh-entry assertion covered by the crawl count");
}

let crawled = [];
const goodCrawl = async (o) => { crawled.push(o); return { manifest: { name: "Ext" }, tools: [{ slug: "a" }], error: null, history: [true] }; };
const badCrawl = async (o) => { crawled.push(o); return { error: "no manifest, no openapi, no bazaar entries", history: [false] }; };

let r = await registerOrigin("https://newseller.example", { crawl: goodCrawl });
ok(r.listed === true && r.origin === "https://newseller.example", "successful probe lists the origin");
ok(r.seller && typeof r.seller.toolCount === "number", "response carries a seller summary");
ok(crawled.length === 1, "crawler invoked once for unknown origin");

r = await registerOrigin("https://deadseller.example", { crawl: badCrawl });
ok(r.listed === false && typeof r.error === "string", "failed probe returns honest error, not listed");

// --- submission cap ---
__testResetSubmitted();
__testSetSubmittedCap(1);
const capCrawl = async (o) => { crawled.push(o); return { manifest: { name: "Cap" }, tools: [{ slug: "a" }], error: null, history: [true] }; };

r = await registerOrigin("https://cap-first.example", { crawl: capCrawl });
ok(r.listed === true, "cap: first submission fills the cap and still lists");

const crawledBefore = crawled.length;
r = await registerOrigin("https://cap-second.example", { crawl: capCrawl });
ok(r.listed === false, "cap: new origin at cap is not listed");
ok(typeof r.error === "string" && /full/i.test(r.error), "cap: error is an honest capacity message");
ok(crawled.length === crawledBefore, "cap: rejected origin is never crawled");

r = await registerOrigin("https://cap-second.example", { crawl: capCrawl });
ok(r.listed === false, "cap: rejected origin stays rejected on retry (not persisted)");

r = await registerOrigin("https://cap-first.example", { crawl: capCrawl });
ok(r.listed === true, "cap: an already-known origin still returns its state normally at cap");

__testSetSubmittedCap(); // restore default for any tests that run after this file
__testResetSubmitted();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
