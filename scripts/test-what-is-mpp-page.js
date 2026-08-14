// Offline unit tests for /what-is-mpp (src/what-is-mpp.js, Aug 2026 revamp
// restyle - matches /what-is-x402's visual language). No fixtures needed:
// the page takes only baseUrl, no live data bindings. No server, no network.
import { whatIsMppPage } from "../src/what-is-mpp.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

const BASE_URL = "https://agent402.tools";
const html = whatIsMppPage(BASE_URL);

// --- content -------------------------------------------------------------------
ok(html.includes("What is <span") && html.includes(">MPP</span>?"), "hero H1 renders");
ok(html.includes("How one MPP payment works."), "handshake section renders");
ok(html.includes("MPP vs x402, side by side."), "comparison section renders");
ok(html.includes("Where MPP settles today."), "the real 'settles daily via canary' section renders");
ok(html.includes("How do I accept MPP payments on my own API?"), "the accept-it section renders");
ok(html.includes("Questions people and agents ask."), "FAQ heading renders");

// --- comparison table: all 5 real rows present --------------------------------
for (const label of ["Payment terms ride in", "Payment rides in", "Proof of settlement", "Origin", "Settlement"]) {
  ok(html.includes(`>${label}<`), `comparison table includes the "${label}" row`);
}
ok(html.includes("WWW-Authenticate: Payment") && html.includes("X-PAYMENT"), "comparison table names the real header differences");

// --- cross-links to the sibling explainer page --------------------------------
ok(html.includes('href="/what-is-x402"'), "links to /what-is-x402 (the broader explainer, not duplicated content)");
ok((html.match(/href="\/what-is-x402"/g) || []).length >= 2, "the cross-link to /what-is-x402 appears more than once (hero + closing CTA)");

// --- structured data -------------------------------------------------------------
ok(html.includes('"@type":"Organization"'), "Organization JSON-LD present");
ok(html.includes('"@type":"BreadcrumbList"'), "BreadcrumbList JSON-LD present (was missing before this restyle)");
ok(html.includes('"@type":"Article"'), "Article JSON-LD present");
{
  const faqLdCount = (html.match(/"@type":"Question"/g) || []).length;
  const faqVisibleCount = (html.match(/<article style="padding:26px 0/g) || []).length;
  ok(faqLdCount === 5, `FAQPage JSON-LD carries exactly 5 questions (got ${faqLdCount})`);
  ok(faqVisibleCount === 5, `visible FAQ prose carries exactly 5 questions, matching the schema 1:1 (got ${faqVisibleCount})`);
}

// --- copy hygiene -----------------------------------------------------------------
ok(!html.includes("—"), "no em dashes anywhere in the page copy");

// --- no template artifacts -------------------------------------------------------
ok(!/undefined|NaN|\[object Object\]/.test(html), "no template artifacts leak into the render");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
