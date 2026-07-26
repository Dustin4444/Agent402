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

// ── The disclaimers are the product. Their absence is a defect. ─────────────
{
  const html = page([tool()]);
  const must = [
    "not our tools",
    "do not operate, host, or test",
    "written by the sellers",
    "directly to the seller",
    "not endorsement",
    "untrusted",
  ];
  for (const phrase of must) check(`states: "${phrase}"`, html.toLowerCase().includes(phrase.toLowerCase()));
  check("points back at our own catalog for contrast", html.includes('href="/tools"'));
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
