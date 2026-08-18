// Offline unit tests for the /index page's row cap + sortable per-seller
// revenue columns. No network, no server boot — indexPage() is a pure
// function of its snapshot + leaderboard snapshot + query params.
import { indexPage, leaderboardHostIndex } from "../src/x402-index.js";
import { ledgerHomePage } from "../src/ledger-home.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

// --- fixtures ----------------------------------------------------------------

function seller(i, overrides = {}) {
  return {
    origin: `https://seller${i}.example`,
    displayName: `Seller ${i}`,
    homepage: `https://seller${i}.example`,
    network: "base",
    toolCount: i,
    fetchedAt: Date.now(),
    error: null,
    local: false,
    health: 1,
    routable: true,
    history: [1],
    source: "manifest",
    networks: ["eip155:8453"],
    ...overrides,
  };
}

const local = {
  origin: "self",
  displayName: "Agent402.Tools",
  homepage: "https://agent402.tools",
  network: "base",
  toolCount: 1419,
  fetchedAt: Date.now(),
  local: true,
};

// 150 remote sellers (well over the 100 row cap) + the local seller.
const manySellers = [local, ...Array.from({ length: 150 }, (_, i) => seller(i + 1, { toolCount: i + 1 }))];
const bigSnapshot = { spec: "x402-index/1", asOf: new Date().toISOString(), sellers: manySellers, discoverySources: [], totals: { sellers: manySellers.length, tools: 0, crawled: 150, discovered: 150, routable: 151, unhealthy: 0, bazaarFallback: 0 } };

// Leaderboard fixture: only seller1 and seller2 have on-chain settlement —
// everyone else (including the local catalog) is unmatched and must render "-".
const leaderboardSnap = {
  spec: "x402-leaderboard/1",
  asOf: new Date().toISOString(),
  windowLabel: "24h",
  leaderboard: [
    { rank: 1, name: "Seller 1", homepage: "https://seller1.example", origins: ["https://seller1.example"], wallet: "0xaaa", callsSettled: 500, totalUsd: 12.5, uniqueBuyers: 10 },
    { rank: 2, name: "Seller 2", homepage: "https://seller2.example", origins: ["https://seller2.example"], wallet: "0xbbb", callsSettled: 20, totalUsd: 0.4, uniqueBuyers: 3 },
  ],
};

const BASE_URL = "https://agent402.tools";

// --- leaderboardHostIndex ------------------------------------------------

const hostIdx = leaderboardHostIndex(leaderboardSnap);
ok(hostIdx.get("seller1.example")?.totalUsd === 12.5, "leaderboardHostIndex joins by canonical host");
ok(!hostIdx.has("seller3.example"), "leaderboardHostIndex has no entry for an unmatched host");

// --- row cap + show-all link ----------------------------------------------

const capped = indexPage(bigSnapshot, { baseUrl: BASE_URL, leaderboardSnap });
ok(/Showing top 100 of 151 sellers/.test(capped), "cap: honest 'showing top 100 of N sellers' note renders");
ok(/show all<\/a>/.test(capped) && /\?all=1/.test(capped), "cap: show-all link points at ?all=1");
ok(capped.includes("Agent402.Tools"), "cap: local seller is always present even when it falls outside the top 100 by usd");
// Top-usd seller (Seller 1, $12.50) must be present; a low-toolCount, unmatched
// seller far down the list (e.g. Seller 150, no leaderboard match) should be
// excluded from the capped view.
ok(capped.includes("Seller 1"), "cap: top-ranked (by usd) seller is in the capped view");

const showAll = indexPage(bigSnapshot, { baseUrl: BASE_URL, leaderboardSnap, all: "1" });
ok(!/Showing top 100 of/.test(showAll), "show-all: cap note disappears with ?all=1");
ok(showAll.includes("Seller 150"), "show-all: every filtered seller renders with ?all=1");

// --- columns + honest window label -----------------------------------------

ok(/24H USDC/.test(capped), "columns: header uses the leaderboard's real window label (24h), not a hardcoded 7D");
ok(!/7D USDC/.test(capped), "columns: does not fake a 7-day window the snapshot never scanned");
ok(/\$12\.50/.test(capped), "columns: matched seller shows real USDC settled");
ok(/>500</.test(capped), "columns: matched seller shows real call count");

// Unmatched seller (e.g. Seller 3, toolCount 3, no leaderboard row) must show
// "-" for both new columns, never a fabricated $0 / 0.
const unmatchedSnapshot = { ...bigSnapshot, sellers: [local, seller(3)] };
const unmatchedPage = indexPage(unmatchedSnapshot, { baseUrl: BASE_URL, leaderboardSnap });
const seller3RowMatch = unmatchedPage.match(/<tr>\s*<td><a[^>]*>Seller 3<\/a>[\s\S]*?<\/tr>/);
ok(seller3RowMatch != null, "unmatched: Seller 3's row is present");
if (seller3RowMatch) {
  const row = seller3RowMatch[0];
  ok((row.match(/class="num">-</g) || []).length >= 2, "unmatched: seller with no leaderboard match shows '-' for both USDC and calls, not 0");
}

// --- per-operator revenue attribution (no duplicate $ across shared-wallet aliases) ---
// One operator (leaderboard row seller1) crawled under three origins: its
// homepage plus two preview-deploy aliases. Only the primary (homepage) origin
// must show the $12.50 / 500; the aliases show "-" (revenue counted on the
// primary), never the operator's total repeated.
{
  const primary = { origin: "https://seller1.example", displayName: "Seller 1", homepage: "https://seller1.example", network: "base", toolCount: 40, fetchedAt: Date.now(), local: false };
  const aliasA = { origin: "https://seller1-preview-abc.vercel.app", displayName: "seller1-preview-abc", homepage: "https://seller1-preview-abc.vercel.app", network: "base", toolCount: 40, fetchedAt: Date.now(), local: false };
  const aliasB = { origin: "https://alt.seller1.example", displayName: "alt.seller1.example", homepage: "https://alt.seller1.example", network: "base", toolCount: 40, fetchedAt: Date.now(), local: false };
  // The leaderboard row folds all three origins under one operator (as the real
  // grouping does): homepage + both alias origins map to the same row.
  const lbShared = { spec: "x402-leaderboard/1", asOf: new Date().toISOString(), windowLabel: "24h", leaderboard: [
    { rank: 1, name: "Seller 1", homepage: "https://seller1.example", origins: ["https://seller1.example", "https://seller1-preview-abc.vercel.app", "https://alt.seller1.example"], wallet: "0xaaa", callsSettled: 500, totalUsd: 12.5, uniqueBuyers: 10 },
  ] };
  const snap = { spec: "x402-index/1", asOf: new Date().toISOString(), sellers: [local, primary, aliasA, aliasB], discoverySources: [], totals: { sellers: 4, tools: 0, crawled: 3, discovered: 3, routable: 4, unhealthy: 0, bazaarFallback: 0 } };
  const html = indexPage(snap, { baseUrl: BASE_URL, leaderboardSnap: lbShared });
  const aliasRowA = html.match(/<tr>\s*<td><a[^>]*>seller1-preview-abc<\/a>[\s\S]*?<\/tr>/);
  const aliasRowB = html.match(/<tr>\s*<td><a[^>]*>alt\.seller1\.example<\/a>[\s\S]*?<\/tr>/);
  ok(aliasRowA && !aliasRowA[0].includes("$12.50"), "dedup: alias origin A does NOT repeat the operator's $12.50");
  ok(aliasRowB && !aliasRowB[0].includes("$12.50"), "dedup: alias origin B does NOT repeat the operator's $12.50");
  ok(html.includes("shared payTo wallet"), "dedup: alias rows carry the 'revenue counted on ...' marker");
  const primaryRow = html.match(/<tr>\s*<td><a[^>]*>Seller 1<\/a>[\s\S]*?<\/tr>/);
  ok(primaryRow && primaryRow[0].includes("$12.50"), "dedup: the primary (homepage) origin is the one that shows the revenue");
}

// --- sort links preserve ?network and default to usd desc -------------------

const netPage = indexPage(bigSnapshot, { baseUrl: BASE_URL, leaderboardSnap, network: "base" });
ok(/href="\/index\?network=base&amp;sort=usd&amp;dir=asc"/.test(netPage), "sort links: clicking the active (usd) header preserves ?network and flips to asc");
ok(/href="\/index\?network=base&amp;sort=calls&amp;dir=desc"/.test(netPage), "sort links: an inactive header (calls) preserves ?network and defaults that click to desc");

// Default sort (no ?sort given) is usd desc: Seller 1 ($12.50) ranks above
// Seller 2 ($0.40) in the rendered row order.
const defaultPage = indexPage(bigSnapshot, { baseUrl: BASE_URL, leaderboardSnap });
const i1 = defaultPage.indexOf(">Seller 1<");
const i2 = defaultPage.indexOf(">Seller 2<");
ok(i1 > -1 && i2 > -1 && i1 < i2, "default sort is usd desc: higher-revenue seller renders first");

// Explicit ?sort=calls&dir=asc reorders vs. the usd-desc default.
const callsAscPage = indexPage(bigSnapshot, { baseUrl: BASE_URL, leaderboardSnap, sort: "calls", dir: "asc" });
ok(/24H calls ↑/.test(callsAscPage), "sort: active header shows the direction arrow");

// --- homepage: one marketplace story (Aug 2026 revamp, src/ledger-home.js) ---
// Repositioned from "tools your agent can pay for" to "the applied layer for
// x402 and MPP", with the index/marketplace pitch merged into one story:
// every CTA lands on /marketplace (or a chain page), never the old /index or
// /marketplaces URLs, and the neutral-index positioning survives as prose
// under the real "The index, not just a seller." section.
{
  const homeCatalog = {
    "POST /api/hash": { name: "Hash", slug: "hash", category: "encoding", price: "$0.001", description: "Hash text", tags: [] },
    "POST /api/search": { name: "Web search", slug: "search", category: "search", price: "$0.01", description: "Search the web", tags: [] },
    "POST /api/answer": { name: "Answer", slug: "answer", category: "search", price: "$0.01", description: "Cited answer", tags: [] },
  };
  const html = ledgerHomePage(BASE_URL, homeCatalog, {}, {}, [], { chainSellerCounts: {} });
  ok(/href="\/marketplace"/.test(html), "homepage: CTA points to /marketplace");
  ok(/The index, not just a seller\./.test(html), "homepage: single merged marketplace section copy renders");
  ok((html.match(/\/marketplaces\b/g) || []).length === 0, "homepage: no /marketplaces links remain");
  ok(!/href="\/index"/.test(html), "homepage: no href=\"/index\" links remain");
  ok(/a neutral index has to be checkable/.test(html), "homepage: neutral-index positioning survives as prose");
  // 2026-08-18: positioned under the Agentic Finance (AIFI) moniker - the
  // hero names the category and links its explainer; x402 + MPP are the wires.
  ok(/The applied layer of <span[^>]*>Agentic Finance<\/span>/.test(html) && /Agentic Finance \(AIFI\) applied layer/.test(html) && /href="\/agentic-finance"/.test(html), "homepage: title/hero lead with the Agentic Finance (AIFI) positioning (x402 + MPP as the wires), linking /agentic-finance");
  ok(/href="\/status"/.test(html), "homepage: trust strip links to live /status");
  // The old "flagship jobs" section (a standalone search+answer callout ahead
  // of a skill-packs teaser) doesn't exist in the new structure - the design
  // folds that same search-then-answer job into the real agent transcript
  // instead. Lock that the transcript still demonstrates it, live-callable.
  ok(/agent402_find\(q: "sec 10-K filing text"\)/.test(html) && /agent402_call\(answer,/.test(html), "homepage: agent-pays transcript still demonstrates a real search-then-answer job");
  // The old 7-question FAQ (incl. "How do I connect my agent?") is now a
  // deliberately trimmed set matching the FAQPage JSON-LD 1:1: the AIFI
  // definition (2026-08-18) plus the three product questions.
  ok(/What is Agentic Finance \(AIFI\)\?/.test(html), "homepage: visible FAQ leads with the Agentic Finance (AIFI) definition");
  ok(/How do I sell my API for USDC per call\?/.test(html), "homepage: visible FAQ includes the sell-side question");
  ok(/Do I need a wallet to try it\?/.test(html), "homepage: visible FAQ includes the no-wallet question");
  ok(/Is it open source, and can I run my own\?/.test(html), "homepage: visible FAQ includes the open-source question");
  ok(html.includes('"@type":"FAQPage"'), "homepage: FAQPage JSON-LD present");
  const faqQCount = (html.match(/"@type":"Question"/g) || []).length;
  ok(faqQCount === 4, `homepage: FAQPage JSON-LD has exactly 4 questions matching the visible 4 (got ${faqQCount})`);
}

// --- F23: seller homepage href scheme guard (dormant legacy renderer) --------
// A crafted manifest homepage must never become a javascript:/data: link.
{
  const evil = seller(99, { displayName: "Evil Seller", homepage: "javascript:alert(document.cookie)" });
  const dataUri = seller(98, { displayName: "Data Seller", homepage: "data:text/html,<script>alert(1)</script>" });
  const snap = { spec: "x402-index/1", asOf: new Date().toISOString(), sellers: [local, evil, dataUri], discoverySources: [], totals: { sellers: 3, tools: 0, crawled: 2, discovered: 2, routable: 3, unhealthy: 0, bazaarFallback: 0 } };
  const html = indexPage(snap, { baseUrl: BASE_URL, leaderboardSnap });
  ok(!/href="javascript:/i.test(html), "F23: a javascript: homepage never becomes an href");
  ok(!/href="data:/i.test(html), "F23: a data: homepage never becomes an href");
  // The seller still renders (as a row), just with an inert href.
  ok(html.includes("Evil Seller"), "F23: the seller still lists, its link just rendered inert (#)");
  const evilRow = html.split("<tr>").find((r) => r.includes("Evil Seller")) || "";
  ok(/href="#"/.test(evilRow), "F23: the unsafe-scheme homepage renders as href=\"#\"");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
