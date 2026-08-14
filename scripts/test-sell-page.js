// Offline unit tests for the /sell hub renderer (Aug 2026 revamp). No
// server, no network — sellPage() takes no live-data args any more (the
// new design surfaces no free aggregate numbers on this page at all, only
// static "what it costs you" copy and a lane-level teaser for the paid
// /api/bestsellers + /api/demand-radar reads).
import { sellPage } from "../src/sell.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

const html = sellPage("https://agent402.tools");

// --- hero ---------------------------------------------------------------
ok(html.includes("Agents are buying") && html.includes(">paid<") && html.includes("for it."), "hero H1 renders");
ok(html.includes("WHAT IT COSTS YOU"), "cost table header renders");
ok(html.includes(">$0<") && html.includes(">0%<"), "cost table shows $0 listing fee and 0% deducted");
ok(html.includes("buyer side only"), "cost table's how-we-earn row states the buyer-side model");

// --- commercial sensitivity: lane-level demand only, no per-tool figures --
ok(html.includes("Demand you can&#39;t get anywhere else") || html.includes("Demand you can't get anywhere else"), "demand section renders");
ok(html.includes("Hashing &amp; encoding") || html.includes("Hashing & encoding"), "lane names render");
ok(html.includes("figures withheld"), "lane table discloses figures are withheld, not shown free");
ok(html.includes("/tools/bestsellers") && html.includes("$0.005"), "bestsellers upsell links out with its real price");
ok(html.includes("/tools/demand-radar"), "demand-radar upsell links out");
// The one thing this page must never do: pair a tool slug with a purchase
// count. Every catalog price on this page is a flat UPSELL price ($0.005),
// never a per-tool sales/purchase figure — check no bare integer sits next
// to a known tool-shaped identifier outside the upsell links themselves.
ok(!/\b\d{1,3}(,\d{3})*\s*(purchases|sales|buyers)\b/i.test(html.replace(/\/tools\/(bestsellers|demand-radar)/g, "")),
  "no per-tool purchase/sales/buyer count rendered anywhere on the page");

// --- register form: same id/posture as market-page.js ---------------------
ok(html.includes('id="list-api"') && html.includes('id="reg-origin"') && html.includes('id="reg-go"') && html.includes('id="reg-out"'), "register form present with market-page.js's ids");
ok(html.includes("/api/index/register"), "register form posts to /api/index/register");
ok(html.includes("out.textContent") && !html.includes("innerHTML"), "register-result rendering is textContent-only, never innerHTML");

// --- how-we-earn / commitments --------------------------------------------
ok(html.includes("HOW WE MAKE MONEY") && html.includes("THE COMMITMENTS") || html.includes("The commitments"), "how-we-earn and commitments sections render");
ok(html.includes("src/x402-index.js") && html.includes("github.com/MikeyPetrillo/Agent402"), "commitments link to the router source for verification");
ok((html.match(/We never/g) || []).length >= 4, "at least four explicit 'We never' commitments render");

// --- rails ------------------------------------------------------------
ok(html.includes(">Base<") && html.includes(">Robinhood<"), "rail marks render every chain including Robinhood");
ok(html.includes(">USDG<"), "Robinhood's asset is labelled USDG, not USDC");

// --- FAQ ----------------------------------------------------------------
ok(html.includes("What does it cost to list?"), "seller FAQ renders");
ok((html.match(/<article/g) || []).length >= 6, "all six FAQ questions render as full prose articles");

// --- JSON-LD --------------------------------------------------------------
ok(html.includes("application/ld+json") && html.includes('"@type":"Service"'), "Service JSON-LD present");
ok(html.includes('"@type":"HowTo"') && html.includes('"totalTime":"PT15M"'), "HowTo JSON-LD present");
ok(html.includes('"@type":"FAQPage"'), "FAQPage JSON-LD present");
ok(html.includes('"@type":"BreadcrumbList"'), "BreadcrumbList JSON-LD present");

// --- copy hygiene: no em dashes anywhere on the page -----------------------
ok(!html.includes("—"), "no em dashes anywhere in the page copy");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
