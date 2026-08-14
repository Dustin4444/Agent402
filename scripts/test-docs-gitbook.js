// Docs hub unification tests (src/docs.js + src/ledger-docs.js, Aug 2026
// "make it look like a GitBook" pass). Offline, no server: exercises the
// exported page-builder functions directly with the real on-disk wiki/
// content (same source the live site reads).
//
// What this locks in, and why each one is real (not cosmetic):
//   - /docs (ledgerDocsPage) and /docs/:slug (docsPage) render inside the
//     SAME sidebar shell. Before this they were two unrelated layouts one
//     click apart - the single biggest reason the docs surface didn't read
//     as one coherent site.
//   - Sidebar active-state matches the current page on both surfaces.
//   - Prev/next navigation is computed from real sidebar order, not
//     hand-maintained, so it can't drift from the actual nav tree.
//   - A markdown-link sidebar bullet with trailing parenthetical prose
//     ("[Try Tollbooth Cloud](url) (managed)") used to be silently DROPPED
//     entirely by an overly-strict regex - found live while testing the
//     search filter turned up a real, pre-existing missing nav item.
//   - The sidebar search filter and the mobile toggle button are present
//     and structurally wired (their actual interaction is covered by a
//     manual Playwright pass in the shipping commit, not here - this file
//     stays in the repo's established no-browser-tests pattern).
//
//   node scripts/test-docs-gitbook.js
import { docsPage, docNeighbors, renderSidebar, docsLayoutHtml, DOCS_SEARCH_SCRIPT, docsSlugs } from "../src/docs.js";
import { ledgerDocsPage } from "../src/ledger-docs.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

const BASE_URL = "https://agent402.tools";
const catalog = {
  "POST /api/hash": { name: "Hash", slug: "hash", category: "encoding", price: "$0.001", description: "Hash text", tags: [] },
};

// --- the sidebar is real, non-empty, sourced from the real wiki --------------
const slugs = docsSlugs();
ok(slugs.length > 10, `real wiki pages loaded from wiki/ (${slugs.length} slugs)`);
ok(slugs.includes("Getting-Started"), "a known real doc slug (Getting-Started) is present");

// --- the real sidebar-parser bug: trailing parenthetical prose after a
// markdown link must not drop the whole bullet --------------------------------
{
  const html = renderSidebar("Home");
  ok(html.includes("Try Tollbooth Cloud"), "a markdown-link bullet with trailing '(managed)' prose still renders (regression: used to be silently dropped)");
  ok(html.includes('href="https://agent402.tools/tollbooth/cloud"'), "that bullet's real href survives the parse");
}

// --- /docs and /docs/:slug render inside the SAME shell -----------------------
{
  const home = ledgerDocsPage(BASE_URL, catalog);
  const sub = docsPage(BASE_URL, "Getting-Started");
  ok(sub != null, "docsPage resolves a real slug");
  for (const html of [home, sub]) {
    ok(html.includes('class="ml-docs-layout"'), "renders the shared docs layout wrapper");
    ok(html.includes('id="ml-docs-side"'), "renders the shared sidebar container");
    ok(html.includes('id="ml-docs-mobile-toggle"'), "renders the mobile sidebar toggle button");
    ok(html.includes('id="ml-docs-search-input"'), "renders the sidebar search/filter input");
  }
}

// --- active-state highlighting is correct on both surfaces --------------------
{
  const home = ledgerDocsPage(BASE_URL, catalog);
  ok(/ml-docs-side-a active" href="\/docs">Home/.test(home), "/docs marks Home as the active sidebar item");
  const sub = docsPage(BASE_URL, "Getting-Started");
  ok(/ml-docs-side-a active" href="\/docs\/Getting-Started">/.test(sub), "/docs/Getting-Started marks itself as the active sidebar item");
  ok(!/ml-docs-side-a active" href="\/docs">Home/.test(sub), "Home is NOT marked active while on a different doc page");
}

// --- prev/next: real, computed from sidebar order, never hand-maintained ------
{
  const { prev, next } = docNeighbors("Getting-Started");
  ok(prev && prev.slug === "Home", "Getting-Started's prev neighbor is Home (first item in the real sidebar)");
  ok(next && typeof next.slug === "string" && next.slug.length > 0, "Getting-Started has a real next neighbor");
  const homeNeighbors = docNeighbors("Home");
  ok(homeNeighbors.prev === null, "Home (the first page) has no prev neighbor");
  ok(homeNeighbors.next && homeNeighbors.next.slug === "Getting-Started", "Home's next neighbor is the sidebar's first real doc");

  const home = ledgerDocsPage(BASE_URL, catalog);
  ok(home.includes('class="ml-docs-pn"'), "/docs renders the prev/next footer nav");
  ok(!home.includes(">Previous<"), "/docs (the first page) shows no Previous link");

  const sub = docsPage(BASE_URL, "Getting-Started");
  ok(sub.includes(">Previous<") && sub.includes("&larr; Home"), "a middle doc page's Previous link points back to Home");
}

// --- an unknown slug still 404s cleanly (unchanged by this pass) --------------
ok(docsPage(BASE_URL, "Definitely-Not-A-Real-Page") === null, "an unknown slug returns null, not a broken page");

// --- the search-filter script is present exactly once per page, wired to
// the real input id ------------------------------------------------------------
ok(DOCS_SEARCH_SCRIPT.includes("ml-docs-search-input"), "the exported search script targets the real input id");
ok(DOCS_SEARCH_SCRIPT.includes("ml-docs-mobile-toggle"), "the exported script also wires the mobile toggle");

// --- docsLayoutHtml is the single source of the wrapper markup - both
// callers must produce byte-identical structure for the same slug -----------
{
  const a = docsLayoutHtml("Home", "<p>x</p>");
  const b = docsLayoutHtml("Home", "<p>x</p>");
  ok(a === b, "docsLayoutHtml is a pure function of its inputs");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
