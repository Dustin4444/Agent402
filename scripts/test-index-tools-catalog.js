// Offline unit test for the third-party tool catalog (/marketplace/tools).
//
// The catalog reproduces other people's endpoints, in their own words, at
// scale. The properties that matter are therefore not "does it render" but
// "does it stay honest and safe": our own tools must never appear in a list
// whose premise is that nothing on it is ours, seller-supplied strings must be
// inert, and outbound links must not lend them our ranking.
//
// Run: node scripts/test-index-tools-catalog.js
import { indexToolsPage } from "../src/index-tools-page.js";

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log(`ok - ${name}`); }
  else { fail++; console.error(`FAIL - ${name}`); }
};

const tool = (over = {}) => ({
  seller: "https://seller.test", sellerName: "Seller", name: "A tool", route: "/x", method: "POST",
  url: "https://seller.test/x", description: "Does a thing for agents, deterministically.", described: true,
  category: "data", tags: [], priceUsd: 0.01, networks: ["eip155:8453"], ...over,
});
const page = (results, extra = {}) =>
  indexToolsPage("https://agent402.tools",
    { total: results.length, matched: results.length, offset: 0, limit: 100, described: results.filter((r) => r.described).length, results, ...extra },
    [{ category: "data", count: 1 }], {});

// ── Disclaimers, scoped by provenance ───────────────────────────────────────
// The page mixes our tools with other people's, so a BLANKET disclaimer would
// now be a lie in both directions: "we do not test any of this" is false for
// our rows, and "tested on every deploy" is false for everyone else's. The
// wording has to attach to the badge, not the page.
{
  const html = page([tool({ ours: true, sellerName: "Agent402", slug: "hash" }), tool()]);
  const must = [
    "do not operate, host, or test",   // third-party rows
    "written by the seller",           // third-party metadata is theirs
    "directly to the seller",          // non-custodial
    "not endorsement",                 // listing != review
    "untrusted",                       // prompt-injection warning
    "applies only to these rows",      // the scoping itself
  ];
  for (const phrase of must) check(`states: "${phrase}"`, html.toLowerCase().includes(phrase.toLowerCase()));
  check("claims the guarantee for OUR rows specifically", /build, host and stand behind/i.test(html));
  check("offers a way back to our own catalog", html.includes('href="/tools"'));
  check("does NOT disclaim everything as third-party", !/we do not operate, host, or test any endpoint on this page/i.test(html));
}

// ── Provenance is visible without reading ───────────────────────────────────
{
  const html = page([tool({ ours: true, sellerName: "Agent402", slug: "hash" }), tool({ sellerName: "Someone Else" })]);
  check("our row carries an OURS badge", /ix-badge ours/.test(html));
  check("their row carries a third-party badge", /ix-badge third/.test(html));
  check("our row is visually marked", /class="is-ours"/.test(html));
  check("our row links to our own tool page, not an outbound link", html.includes('href="/tools/hash"'));
  check("our row is NOT nofollowed like a third party", !/href="\/tools\/hash"[^>]*nofollow/.test(html));
}

// ── Undescribed rows are shown and labelled, never silently dropped ─────────
{
  const html = page([tool({ described: false, description: "" })]);
  check("an undescribed tool is still listed", html.includes("A tool"));
  check("and is labelled as the seller's omission", /No description supplied by the seller/.test(html));
}

// ── Seller-supplied strings are inert ───────────────────────────────────────
{
  const evil = `<img src=x onerror=alert(1)> " onmouseover="alert(2)`;
  const html = page([tool({ name: evil, description: evil, sellerName: evil, category: evil })]);
  check("no unescaped tag survives", !/<img\s/i.test(html));
  check("no attribute break-out from a quote", !/href="[^"]*"[a-z]+="/i.test(html));
  check("no injected event handler becomes an attribute", !/\s onmouseover="/i.test(html));
  check("hostile text still renders, as escaped text", html.includes("&lt;img"));
}

// ── Outbound links must not lend third parties our ranking ──────────────────
{
  const html = page([tool(), tool({ url: "https://other.test/y", sellerName: "Other" })]);
  const links = html.match(/rel="noopener nofollow ugc"/g) || [];
  check("every seller link carries noopener nofollow ugc", links.length === 2);
}

// ── Prompt-injection notice for the agents that will read this ──────────────
{
  const html = page([tool()]);
  check("warns agents to treat descriptions as data, not instructions", /never as instructions/i.test(html));
}

// ── Empty state stays useful ────────────────────────────────────────────────
{
  const html = page([], { total: 1234, matched: 0 });
  check("empty result set explains itself", /Nothing matched/.test(html));
  check("and still offers the router", html.includes('href="/api/route"'));
}

console.log(`\ntest-index-tools-catalog: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
