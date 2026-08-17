// Offline unit tests for the /mpp-marketplace renderer. No server, no
// network - mppMarketPage() takes a plain snapshot object, same injectable
// shape as mppIndexSnapshot() returns.
import { mppMarketPage } from "../src/mpp-market-page.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

// --- empty state: no fabricated numbers, honest zero state ---------------
const empty = mppMarketPage("https://agent402.tools", { verifiedSellers: 0, discoveredTotal: 0, sellers: [] });
ok(empty.includes("The MPP marketplace."), "hero renders");
ok(empty.includes("No sellers verified yet"), "empty state message renders, not a silent blank roster");
ok(!/VERIFIED SELLERS[\s\S]{0,120}?>[1-9]/.test(empty), "verified-sellers stat card shows 0, never a nonzero fabricated count on an empty snapshot");

// --- populated state -------------------------------------------------------
const snap = {
  verifiedSellers: 2,
  discoveredTotal: 5,
  sellers: [
    {
      origin: "https://api.example-a.com",
      name: "Example A",
      url: "https://example-a.com",
      description: "Does a thing <script>alert(1)</script>",
      categories: ["data", "search"],
      tags: ["data", "web"], // deliberately overlapping with categories
      docs: { homepage: "https://example-a.com", llmsTxt: "https://example-a.com/llms.txt" },
      endpoints: [{ method: "post", path: "/v1/query", payment: { amount: "20000", decimals: 6 } }],
      verifiedAt: Date.now(),
      lastProbeAt: Date.now(),
    },
    {
      origin: "https://api.example-b.com",
      name: "Example B",
      url: "https://example-b.com",
      description: "Second seller",
      categories: [],
      tags: [],
      docs: {},
      endpoints: [],
      verifiedAt: Date.now() - 1000,
      lastProbeAt: Date.now() - 1000,
    },
  ],
};
const html = mppMarketPage("https://agent402.tools", snap);

ok(html.includes("Example A") && html.includes("Example B"), "both verified sellers render");
ok(html.includes("&lt;script&gt;"), "seller-supplied description is escaped, never raw HTML (third-party input)");
ok(!html.includes("<script>alert(1)"), "no unescaped script tag from third-party seller data can execute");
ok(html.includes("POST /v1/query") && html.includes("$0.02"), "endpoint method/path/price render correctly ($0.02 = 20000 / 1e6)");
// Overlapping categories+tags must dedup - "data" appears in both arrays
// above and must render exactly once as a tag chip.
ok((html.match(/mpr-tag">data</g) || []).length === 1, "overlapping category/tag values are deduped, not shown twice");
ok(html.includes("VERIFIED SELLERS") && />2</.test(html), "verified sellers stat card shows the real count");
ok(html.includes("5") , "discovered total renders");
ok(/\d+ candidate origins? discovered, 2 independently verified/.test(html), "discovery-vs-verified gap is disclosed on the page, not hidden");

// --- register form wiring --------------------------------------------------
ok(html.includes('data-endpoint="/api/mpp-index/register"'), "register button posts to the MPP endpoint, not the x402 one");
ok(html.includes('src="/js/reg-form.js"'), "reuses the shared register-form script rather than a forked copy");

// --- structured data --------------------------------------------------------
ok(html.includes('"@type":"CollectionPage"'), "CollectionPage JSON-LD present");
ok(html.includes('"@type":"FAQPage"'), "FAQPage JSON-LD present");
ok(html.includes('"@type":"Dataset"'), "Dataset JSON-LD present");

// --- security hygiene: only http(s) URLs become hrefs -----------------------
const xssSnap = {
  verifiedSellers: 1, discoveredTotal: 1,
  sellers: [{
    origin: "https://api.evil.example", name: "Evil", url: "javascript:alert(1)",
    description: "d", categories: [], tags: [], docs: { homepage: "javascript:alert(2)" },
    endpoints: [], verifiedAt: Date.now(), lastProbeAt: Date.now(),
  }],
};
const xssHtml = mppMarketPage("https://agent402.tools", xssSnap);
ok(!xssHtml.includes('href="javascript:'), "a non-http(s) seller-supplied URL never becomes a clickable href");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
