// Machine Ledger — Home page ("Agent402 Ledger"), Aug 2026 revamp.
// Hero (dot world map + live counter panel + rail marks), agent-pays
// transcript, real PoW demo, sell block, index/leaderboard, lane-level
// demand teaser, FAQ, closing CTA, footer.

import { ledgerShell, ledgerFooterFull, esc } from "./ledger-chrome.js";
import { toolList } from "./pages.js";
import { isComputePayable } from "./pow.js";
import { RAILS } from "./rails.js";
import { CAIP2_NAMES } from "./stats.js";
import { chainMark, CHAIN_ORDER } from "./chain-logos.js";
import { railKey } from "./rails.js";

const fmtNum = (n) => Number(n || 0).toLocaleString("en-US");

// Decorative marquee of real tool slugs - names only, no purchase data, so
// this carries no commercial-sensitivity weight (contrast the "what agents
// pay for" section below, which does).
const MARQUEE_SLUGS = [
  "search", "answer", "render", "extract", "image-ocr", "pdf-to-markdown", "sec-edgar",
  "fred-series", "crypto-price", "usdc-balance", "event-logs", "tls-cert", "dmarc-check",
  "black-scholes", "forecast-holt", "sql-guard", "seller-trust", "agent-memory", "x402-verify",
];

// Lane-level demand teaser only - see /sell's identical rule. Per-tool slugs
// and purchase counts are the paid /api/bestsellers product and the one
// demand signal no block explorer can reconstruct; the pre-revamp design
// draft for this section rendered exact slugs+counts sourced from a
// topPaidTools field this session removed from /api/stats as a real
// privacy fix (see PR #774) - ported here as lanes instead, matching /sell.
const DEMAND_LANES = [
  ["Hashing & encoding", "sha256/sha512 digests, HMAC, base64, JWT decoding."],
  ["Market & financial data", "Live quotes, historical series, Treasury yield curves, SEC lookups."],
  ["Live web search & cited answers", "Ranked results, and grounded answers with sources attached."],
];

/** Real per-rail settlement counts, sorted by volume. Same CAIP2_NAMES join
 * as /what-is-x402's rails table - single source of truth, can't drift. */
function railsByVolume(stats) {
  const byNet = stats?.toolCallsServed?.viaUSDCByNetwork || {};
  return RAILS.map((r) => {
    const key = CAIP2_NAMES[r.caip2] || r.name.toLowerCase();
    const n = Number(byNet[key]) || 0;
    return { name: r.name, asset: r.asset, slug: railKey(r), n, calls: n ? fmtNum(n) : "·" };
  }).sort((a, b) => b.n - a.n);
}

/** Live leaderboard top rows, excluding Agent402's own row (best-effort name
 * match - same approach as /what-is-x402's adoption table). */
function externalLeaderboardRows(leaderboardSnapshot, limit = 6) {
  const board = Array.isArray(leaderboardSnapshot?.leaderboard) ? leaderboardSnapshot.leaderboard : [];
  return board
    .filter((r) => !/^agent402/i.test(String(r?.name || "")))
    .slice(0, limit)
    .map((r, i) => ({
      rank: String(i + 1).padStart(2, "0"),
      name: r.name,
      usd: `$${Number(r.totalUsd || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      calls: fmtNum(r.callsSettled),
      buyers: fmtNum(r.uniqueBuyers),
    }));
}

export function ledgerHomePage(baseUrl, catalog, stats, leaderboardSnapshot, skillPacks) {
  const tools = toolList(catalog);
  const count = tools.length;
  const freeCount = tools.filter(isComputePayable).length;
  const packCount = Array.isArray(skillPacks) ? skillPacks.length : 42;
  const served = stats?.toolCallsServed || {};
  const viaUsdc = Number(served.viaUSDC) || 0;
  const viaPow = Number(served.viaProofOfWork) || 0;
  const mppWire = Number(served.viaMPPWire) || 0;
  const viaRouter = Number(served.viaRouter) || 0;
  const routerPct = viaUsdc ? (viaRouter / viaUsdc < 0.001 ? "under 0.1%" : `${((100 * viaRouter) / viaUsdc).toFixed(1)}%`) : "0%";
  const rails = railsByVolume(stats);
  const attributed = rails.reduce((sum, r) => sum + r.n, 0);
  const board = externalLeaderboardRows(leaderboardSnapshot);

  const canonical = baseUrl + "/";
  const title = `x402 & MPP applied layer - Agent402: agentic payments for AI agents`;
  const description = `Agent402 is the applied layer for x402 and MPP: the open index, router and on-chain ranking for agentic payments. Sell your API for USDC per call, or give your AI agent ${fmtNum(count)} pay-per-call tools. No signup, no API keys - the wallet is the identity.`;

  const orgLd = { "@type": "Organization", "@id": `${baseUrl}/#organization`, name: "Agent402", alternateName: "Agent402.Tools", url: baseUrl, logo: { "@type": "ImageObject", url: `${baseUrl}/logo.png` }, email: "mike@agent402.tools", parentOrganization: { "@type": "Organization", name: "Havok Holdings LLC" }, sameAs: ["https://github.com/MikeyPetrillo/Agent402", "https://x.com/Agent402Tools", "https://www.npmjs.com/package/agent402-mcp", "https://www.npmjs.com/package/agent402-client", "https://www.npmjs.com/package/agent402-tollbooth", "https://pypi.org/project/agent402-langchain/", "https://www.x402scan.com/server/07eb3020-932a-436d-a739-557b6e47101d"] };
  const websiteLd = { "@type": "WebSite", "@id": `${baseUrl}/#website`, name: "Agent402.Tools", url: baseUrl, publisher: { "@id": `${baseUrl}/#organization` }, description: "The applied layer for x402 and MPP: open index, Smart Order Router and on-chain ranking for agentic payments.", potentialAction: { "@type": "SearchAction", target: `${baseUrl}/api/find?q={search_term_string}`, "query-input": "required name=search_term_string" } };
  const appLd = { "@type": "SoftwareApplication", "@id": `${baseUrl}/#app`, name: "Agent402", url: baseUrl, applicationCategory: "DeveloperApplication", operatingSystem: RAILS.map((r) => r.name).join(", "), license: "https://www.gnu.org/licenses/agpl-3.0.html", description: `Open-source, self-hostable x402 + MPP server: ${fmtNum(count)} deterministic pay-per-call tools and ${packCount}+ skill packs for AI agents, plus an open index, Smart Order Router and on-chain seller leaderboard.`, offers: { "@type": "AggregateOffer", offerCount: String(count), lowPrice: "0.001", highPrice: "1.50", priceCurrency: "USD", description: "Per-call micropayments in USDC on eleven chains plus USDG on Robinhood Chain, or free with proof-of-work" } };
  const datasetLd = { "@type": "Dataset", "@id": `${baseUrl}/#leaderboard`, name: "x402 seller leaderboard - Base USDC settled volume", description: "Hourly on-chain snapshot ranking every indexed x402 seller by Base USDC settled volume: calls settled, total USD, unique buyers per seller.", creator: { "@id": `${baseUrl}/#organization` }, license: "https://www.gnu.org/licenses/agpl-3.0.html", isAccessibleForFree: true, distribution: { "@type": "DataDownload", encodingFormat: "application/json", contentUrl: `${baseUrl}/api/leaderboard` } };
  const surfacesLd = { "@type": "ItemList", "@id": `${baseUrl}/#surfaces`, name: "Free x402 discovery primitives", itemListElement: [
    { "@type": "ListItem", position: 1, name: "Find - resolve a task to the best-matching tool", url: `${baseUrl}/api/find` },
    { "@type": "ListItem", position: 2, name: "Route - neutral Smart Order Router across every x402 seller", url: `${baseUrl}/api/route` },
    { "@type": "ListItem", position: 3, name: "Leaderboard - on-chain ranking by USDC settled volume", url: `${baseUrl}/api/leaderboard` },
    { "@type": "ListItem", position: 4, name: "Marketplace - every indexed seller, tool count, network, health", url: `${baseUrl}/marketplace` },
  ] };
  const faqs = [
    { q: "How do I sell my API for USDC per call?", a: "Register your origin in the \"Sell into the agent economy\" section above, or read the full seller guide at /sell for pricing, routing and health details. If your site is not x402-native yet, agent402-tollbooth is an open pay-per-crawl gate you can install instead." },
    { q: "Do I need a wallet to try it?", a: "No. The pure-CPU tools are payable in compute: your own machine solves a single-use, slug-scoped sha256 proof-of-work instead of paying, which costs about a second of CPU. A wallet only matters for tools that cost real money to run, and those quote their price in the 402 challenge before anything is charged." },
    { q: "Is it open source, and can I run my own?", a: "Yes. The server is AGPL-3.0 and self-hostable; the client SDK, MCP connector and tollbooth packages are MIT. Clone it and run FREE_MODE=true npm start for all tools as an HTTP API plus MCP, with no payments and no keys." },
  ];
  const faqLd = { "@type": "FAQPage", "@id": `${baseUrl}/#faq`, mainEntity: faqs.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })) };

  const extraCss = `
@keyframes hm-marquee { from { transform: translateX(0); } to { transform: translateX(-50%); } }
.hm-marquee-track { display: flex; width: max-content; animation: hm-marquee 46s linear infinite; }
@media (prefers-reduced-motion: reduce) { .hm-marquee-track { animation: none; } }
.hm-2col { display: grid; grid-template-columns: 1fr 1fr; }
@media (max-width: 900px) { .hm-2col, .hm-3col, .hm-hero { grid-template-columns: minmax(0,1fr) !important; } }
@media (max-width: 480px) { .hm-reg-row { flex-direction: column !important; } .hm-reg-row button { width: 100%; } }
#hm-demo-in { border: 1.5px solid var(--hairline); }
#hm-demo-in:focus { border-color: var(--accent); }
`;

  const railLinksHtml = CHAIN_ORDER.map(([slug, name]) =>
    `<a href="/${slug}" title="${esc(name)} x402 marketplace" style="display:inline-flex;align-items:center;gap:7px;color:var(--muted);text-decoration:none;">${chainMark(slug, 19)}<span style="font-family:var(--font-mono);font-size:12px;white-space:nowrap;">${esc(name)}</span></a>`
  ).join("");

  const marqueeSpan = (aria) => `<span style="display:flex;gap:34px;padding-right:34px;white-space:nowrap;"${aria ? ' aria-hidden="true"' : ""}>${MARQUEE_SLUGS.map((s) => `<span>${esc(s)}</span><span style="color:var(--accent);">·</span>`).join("")}</span>`;

  const railRowsHtml = rails.map((r) =>
    `<a href="/${r.slug}" title="${esc(r.name)} x402 marketplace" style="display:flex;flex-direction:column;gap:9px;padding:15px 16px;text-decoration:none;color:var(--on-dark2);border-right:1px solid var(--dark-border);border-bottom:1px solid var(--dark-border);"><span style="display:flex;align-items:center;gap:9px;">${chainMark(r.slug, 19)}<span style="font-weight:700;font-size:14.5px;color:var(--on-dark);">${esc(r.name)}</span></span><span style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;font-family:var(--font-mono);"><span style="font-weight:700;font-size:17px;color:var(--on-dark);font-variant-numeric:tabular-nums;">${esc(r.calls)}</span><span style="font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--dk-muted3);">${esc(r.asset)}</span></span></a>`
  ).join("");

  const leaderboardRowsHtml = board.length
    ? board.map((r) => `<tr style="border-bottom:1px solid var(--dark-border);color:var(--on-dark);"><td style="padding:11px 18px;color:var(--dk-muted3);">${esc(r.rank)}</td><td style="padding:11px 18px;">${esc(r.name)}</td><td style="padding:11px 18px;text-align:right;color:var(--on-dark2);">${esc(r.usd)}</td><td style="padding:11px 18px;text-align:right;color:var(--dk-muted2);">${esc(r.calls)}</td><td style="padding:11px 18px;text-align:right;color:var(--dk-muted2);">${esc(r.buyers)}</td></tr>`).join("")
    : `<tr><td colspan="5" style="padding:20px 18px;color:var(--dk-muted3);">unavailable - the leaderboard snapshot has not populated yet</td></tr>`;

  const demandLanesHtml = DEMAND_LANES.map(([lane, body_], i) =>
    `<div style="display:grid;grid-template-columns:28px 1fr;gap:14px;align-items:center;padding:14px 18px;border-bottom:1px solid var(--hairline);background:var(--card);"><span style="font-family:var(--font-mono);font-size:12px;color:var(--faint);">${String(i + 1).padStart(2, "0")}</span><div><div style="font-family:var(--font-mono);font-size:14px;color:var(--ink);font-weight:700;">${esc(lane)}</div><div style="font-size:12.5px;color:var(--muted);margin-top:2px;">${esc(body_)}</div></div></div>`
  ).join("");

  const faqHtml = faqs.map((f, i) =>
    `<details style="border-bottom:1px solid var(--hairline);"><summary style="list-style:none;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:17px 0;"><h3 style="font-weight:700;font-size:17px;margin:0;color:var(--ink);">${esc(f.q)}</h3><span class="ml-faq-mark" style="font-family:var(--font-mono);font-weight:400;font-size:20px;color:var(--accent);line-height:1;flex:none;">+</span></summary><p style="font-size:15.5px;line-height:1.65;color:var(--muted);margin:0;padding:0 0 20px;max-width:760px;">${esc(f.a)}</p></details>`
  ).join("");

  const body = `
<script src="https://unpkg.com/d3@7.9.0/dist/d3.min.js" integrity="sha384-CjloA8y00+1SDAUkjs099PVfnY2KmDC2BZnws9kh8D/lX1s46w6EPhpXdqMfjK6i" crossorigin="anonymous"></script>
<script src="https://unpkg.com/topojson-client@3.1.0/dist/topojson-client.min.js" integrity="sha384-Ukv1p/xTma6P4/2bY5KzWBw+ydSpXmhCMtyciIQVDJ1RmOxtCYNMF1uXT9T63H67" crossorigin="anonymous"></script>

<header style="position:relative;overflow:hidden;border-bottom:1.5px solid var(--ink);">
  <div style="max-width:1180px;margin:0 auto;padding:52px 30px 0;position:relative;">
    <div class="hm-hero" style="display:grid;grid-template-columns:1.06fr .94fr;gap:56px;align-items:start;">
      <div>
        <div style="font-family:var(--font-mono);font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin-bottom:22px;">open source · <span style="color:var(--accent);">x402</span> + <span style="color:var(--accent);">mpp</span> dual-stack · mcp-native</div>
        <h1 style="font-weight:800;font-size:66px;line-height:.92;letter-spacing:-.038em;margin:0 0 22px;color:var(--ink);">The applied layer<br>for <span style="color:var(--accent);">x402</span> and <span style="color:var(--accent);">MPP</span>.</h1>
        <p style="font-size:18.5px;line-height:1.5;color:var(--muted);max-width:560px;margin:0 0 30px;">Most of the ecosystem ships the protocol. Agent402 ships the <strong style="color:var(--ink);font-weight:700;">market that runs on it</strong> - an open index, a neutral router, and an on-chain ranking of every x402 seller. List your API and get paid in USDC per call, straight to your wallet. No signup, no API keys, and nothing deducted from your price.</p>
        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:11px;margin-bottom:24px;">
          <a class="ml-cta" href="#sell" style="background:var(--accent);color:#fff;font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:14px 22px;">LIST YOUR API - FREE →</a>
          <a class="ml-cta" href="/docs#add" style="background:transparent;border:1.5px solid var(--ink);color:var(--ink);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:13px 22px;">ADD TO CLAUDE</a>
        </div>
        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:10px 18px;font-family:var(--font-mono);font-size:12.5px;color:var(--muted);">
          <span class="ml-dot"></span><span>${RAILS.length} rails live</span>
          <a href="/status" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--dash);">status</a>
          <a href="/api/reliability" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--dash);">reliability</a>
          <a href="https://github.com/MikeyPetrillo/Agent402" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--dash);">AGPL-3.0 source</a>
          <a href="/marketplace" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--dash);">the index</a>
        </div>
        <div style="margin-top:22px;padding-top:20px;border-top:1px dashed var(--dash);">
          <div style="font-family:var(--font-mono);font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin-bottom:13px;">x402 settlement rails - USDC on eleven chains plus USDG on Robinhood</div>
          <div style="display:flex;flex-wrap:wrap;align-items:center;gap:11px 20px;">${railLinksHtml}</div>
          <p style="font-size:13.5px;line-height:1.6;color:var(--faint);margin:18px 0 0;max-width:520px;">New to this? <strong style="color:var(--muted);font-weight:400;">x402</strong> fills in the <span style="font-family:var(--font-mono);font-size:12.5px;color:var(--muted);">402 Payment Required</span> status code the web reserved in 1997 and never used, and <strong style="color:var(--muted);font-weight:400;">MPP</strong> is the IETF-track version of the same handshake. <a href="/what-is-x402" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);">Read the explainer →</a></p>
        </div>
      </div>

      <div style="border:1.5px solid var(--ink);background:var(--surface);">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 18px;border-bottom:1px solid var(--dark-border2);font-family:var(--font-mono);font-size:11px;letter-spacing:.08em;color:var(--dk-muted);">
          <span>LIVE / ON-CHAIN · ${RAILS.length} RAILS</span>
          <span style="display:inline-flex;align-items:center;gap:6px;color:var(--accent-lit);"><span style="width:6px;height:6px;border-radius:50%;background:var(--accent-lit);display:inline-block;animation:ml-pulse 1.8s ease-in-out infinite;"></span>GET /api/stats</span>
        </div>
        <div style="background:var(--footer-bg);padding:14px 0 6px;overflow:hidden;">
          <canvas id="hm-map" role="img" aria-label="World map showing agent payment settlements moving between regions" style="display:block;width:100%;"></canvas>
        </div>
        <div style="padding:16px 22px 20px;background:var(--footer-bg);border-bottom:1px solid var(--dark-border2);">
          <div id="hm-counter" data-via-usdc="${esc(viaUsdc)}" style="font-family:var(--font-body);font-weight:800;font-size:66px;line-height:.9;letter-spacing:-.035em;color:var(--on-dark);font-variant-numeric:tabular-nums;">${viaUsdc ? fmtNum(viaUsdc) : ""}</div>
          <div id="hm-counter-empty" style="display:${viaUsdc ? "none" : "flex"};align-items:center;gap:11px;">
            <span style="width:8px;height:8px;border-radius:50%;background:var(--accent-lit);flex:none;animation:ml-pulse 1.6s ease-in-out infinite;"></span>
            <span style="font-family:var(--font-mono);font-size:15.5px;color:var(--on-dark2);">Listening for on-chain payments…</span>
          </div>
          <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin-top:9px;">calls paid in stablecoin · GET /api/stats</div>
          <div style="font-family:var(--font-mono);font-size:12px;color:var(--dk-muted3);margin-top:12px;padding-top:12px;border-top:1px solid var(--dark-border);">+ <strong id="hm-freepow" style="color:var(--on-dark2);font-weight:700;">${fmtNum(viaPow)}</strong> more served free over proof-of-work</div>
        </div>
        <table style="font-family:var(--font-mono);font-size:12px;"><tbody>
          <tr style="border-top:1px solid var(--dark-border);"><td style="padding:10px 22px;color:var(--dk-muted3);">rails</td><td style="padding:10px 22px;text-align:right;color:var(--on-dark);">${RAILS.length} chains · USDC + USDG</td></tr>
          <tr style="border-top:1px solid var(--dark-border);"><td style="padding:10px 22px;color:var(--dk-muted3);">base receiving</td><td style="padding:10px 22px;text-align:right;color:var(--on-dark);">agent402.base.eth</td></tr>
          <tr style="border-top:1px solid var(--dark-border);"><td style="padding:10px 22px;color:var(--dk-muted3);">floor price</td><td style="padding:10px 22px;text-align:right;color:var(--on-dark);">$0.001 / call</td></tr>
          <tr style="border-top:1px solid var(--dark-border);"><td style="padding:10px 22px;color:var(--dk-muted3);">seller fee</td><td style="padding:10px 22px;text-align:right;color:var(--accent-lit);">0% deducted</td></tr>
          <tr style="border-top:1px solid var(--dark-border);"><td style="padding:10px 22px;color:var(--dk-muted3);">failed calls</td><td style="padding:10px 22px;text-align:right;color:var(--on-dark);">never charged</td></tr>
        </tbody></table>
        <a href="https://basescan.org/address/0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0#tokentxns" style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 22px;border-top:1px solid var(--dark-border2);text-decoration:none;font-family:var(--font-mono);font-size:12px;color:var(--accent-lit);"><span>Verify Base settlements on Basescan ↗</span><span style="color:var(--dk-muted3);">0xaBF4…a9D0</span></a>
      </div>
    </div>

    <div style="display:flex;flex-wrap:wrap;margin-top:52px;border-top:1px dashed var(--dash);">
      <div style="flex:1 1 150px;padding:18px 20px 18px 0;margin-right:20px;border-right:1px dashed var(--dash);"><div style="font-family:var(--font-mono);font-weight:700;font-size:22px;line-height:1;font-variant-numeric:tabular-nums;">${fmtNum(count)}</div><div style="font-family:var(--font-mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);margin-top:6px;">tools indexed</div></div>
      <div style="flex:1 1 150px;padding:18px 20px 18px 0;margin-right:20px;border-right:1px dashed var(--dash);"><div style="font-family:var(--font-mono);font-weight:700;font-size:22px;line-height:1;font-variant-numeric:tabular-nums;">${packCount}+</div><div style="font-family:var(--font-mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);margin-top:6px;">skill packs</div></div>
      <div style="flex:1 1 150px;padding:18px 20px 18px 0;margin-right:20px;border-right:1px dashed var(--dash);"><div style="font-family:var(--font-mono);font-weight:700;font-size:22px;line-height:1;font-variant-numeric:tabular-nums;">${RAILS.length}</div><div style="font-family:var(--font-mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);margin-top:6px;">settlement rails</div></div>
      <div style="flex:1 1 150px;padding:18px 20px 18px 0;margin-right:20px;border-right:1px dashed var(--dash);"><div style="font-family:var(--font-mono);font-weight:700;font-size:22px;line-height:1;font-variant-numeric:tabular-nums;">2</div><div style="font-family:var(--font-mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);margin-top:6px;">protocols · x402 + mpp</div></div>
      <div style="flex:1 1 150px;padding:18px 0;"><div style="font-family:var(--font-mono);font-weight:700;font-size:22px;line-height:1;font-variant-numeric:tabular-nums;color:var(--accent);">0%</div><div style="font-family:var(--font-mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);margin-top:6px;">deducted from sellers</div></div>
    </div>
  </div>
  <div style="border-top:1px solid var(--hairline);background:var(--footer-bg);overflow:hidden;padding:13px 0;">
    <div class="hm-marquee-track" style="font-family:var(--font-mono);font-size:12.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--faint);">${marqueeSpan(false)}${marqueeSpan(true)}</div>
  </div>
</header>

<section style="border-bottom:1.5px solid var(--ink);background:var(--footer-bg);">
  <div style="max-width:1180px;margin:0 auto;padding:20px 30px;display:flex;align-items:center;justify-content:space-between;gap:20px 32px;flex-wrap:wrap;">
    <p style="font-family:var(--font-mono);font-size:12.5px;line-height:1.6;color:var(--dk-muted3);margin:0;">
      <span style="color:var(--accent);letter-spacing:.12em;text-transform:uppercase;">Reading this as an agent?</span>
      Start at <a href="/llms.txt" style="color:var(--on-dark);border-bottom:1px solid var(--accent);text-decoration:none;">llms.txt</a>, or resolve a task in one free call: <span style="color:var(--on-dark);">GET /api/find?q=</span>
    </p>
    <span style="display:flex;gap:8px 18px;flex-wrap:wrap;font-family:var(--font-mono);font-size:12px;color:var(--faint);">
      <a href="/openapi.json" style="color:var(--muted);text-decoration:none;">openapi.json</a>
      <a href="/.well-known/x402" style="color:var(--muted);text-decoration:none;">.well-known/x402</a>
      <a href="/api/pricing" style="color:var(--muted);text-decoration:none;">/api/pricing</a>
      <span style="color:var(--muted);" title="POST-only JSON-RPC endpoint - not a browsable page">/mcp</span>
    </span>
  </div>
</section>

<section style="max-width:1180px;margin:0 auto;padding:64px 30px 0;">
  <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">$ claude mcp add agent402</div>
  <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:14px;">
    <h2 style="font-weight:800;font-size:42px;line-height:1;letter-spacing:-.025em;margin:0;color:var(--ink);">Watch an agent pay its way.</h2>
    <span style="font-family:var(--font-mono);font-size:12.5px;color:var(--faint);">402 → signed auth → verified → receipt</span>
  </div>
  <p style="font-size:16px;color:var(--muted);max-width:660px;margin:0 0 30px;">One round trip. The agent asks, the paywall quotes, the wallet signs, the response comes back with a receipt that settles on chain. No checkout, no key, no human in the loop.</p>
  <div class="hm-2col" style="display:grid;grid-template-columns:1.25fr .75fr;gap:0;border:1.5px solid var(--ink);">
    <div style="background:var(--surface);">
      <div style="display:flex;align-items:center;gap:14px;padding:12px 18px;border-bottom:1px solid var(--dark-border2);font-family:var(--font-mono);font-size:11px;letter-spacing:.06em;color:var(--dk-muted);"><span style="color:var(--accent-lit);">●</span><span>claude code · agent402 mcp</span></div>
      <pre style="margin:0;padding:22px 20px;font-family:var(--font-mono);font-size:12.5px;line-height:1.9;color:var(--on-dark);white-space:pre-wrap;word-break:break-word;"><span style="color:var(--accent-lit);">❯</span> pull the latest 10-K risk factors for TSLA and summarise

<span style="color:var(--dk-muted3);">⏺</span> agent402_find(q: "sec 10-K filing text")
<span style="color:var(--faint);">  ⎿ edgar-filing-text · $0.004 · POST /api/edgar-filing-text</span>

<span style="color:var(--dk-muted3);">⏺</span> agent402_call(edgar-filing-text, { cik: "TSLA", form: "10-K" })
<span style="color:var(--faint);">  ⎿ HTTP/1.1 402 PAYMENT REQUIRED
     WWW-Authenticate: Payment realm="agent402"
  ⎿ signed EIP-3009 USDC authorization → facilitator
  ⎿ verified · settled · Payment-Receipt: 0x8f2a…c41d</span>
<span style="color:var(--accent-lit);">  ✓</span> <span style="color:var(--on-dark);">$0.004 settled on Base · 41 risk factors extracted</span>

<span style="color:var(--dk-muted3);">⏺</span> agent402_call(answer, { q: "summarise these risk factors" })
<span style="color:var(--accent-lit);">  ✓</span> <span style="color:var(--on-dark);">$0.010 settled · 6 themes, 12 citations</span>

<span style="color:var(--faint);">total spend $0.014 · 2 calls · 0 API keys · 0 signups</span></pre>
    </div>
    <div style="background:var(--card);border-left:1.5px solid var(--ink);">
      <div style="padding:20px;border-bottom:1px solid var(--hairline);">
        <h3 style="font-family:var(--font-mono);font-weight:700;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin:0 0 10px;">Same URL, either dialect</h3>
        <p style="font-size:13.5px;line-height:1.55;color:var(--muted);margin:0;">The paywall answers x402 <em>and</em> MPP on the same route. An <span style="font-family:var(--font-mono);font-size:12.5px;color:var(--ink);">mppx</span> client gets a <span style="font-family:var(--font-mono);font-size:12.5px;color:var(--ink);">WWW-Authenticate: Payment</span> challenge; an <span style="font-family:var(--font-mono);font-size:12.5px;color:var(--ink);">@x402/fetch</span> client gets the x402 challenge. Same price, same facilitator, same receipt. The buyer's client picks.</p>
      </div>
      <div style="padding:20px;border-bottom:1px solid var(--hairline);">
        <h3 style="font-family:var(--font-mono);font-weight:700;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin:0 0 10px;">Add it in one line</h3>
        <pre style="margin:0;background:var(--paper);border:1px solid var(--hairline);color:var(--on-dark);padding:12px;font-family:var(--font-mono);font-size:11px;line-height:1.7;white-space:pre-wrap;word-break:break-word;">claude mcp add --transport http \
  agent402 https://agent402.tools/mcp</pre>
      </div>
      <div style="padding:20px;">
        <h3 style="font-family:var(--font-mono);font-weight:700;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin:0 0 10px;">No wallet? Still works</h3>
        <p style="font-size:13.5px;line-height:1.55;color:var(--muted);margin:0;">Pure-CPU tools are payable in compute: a single-use, slug-scoped sha256 proof-of-work the MCP server solves for you in under a second.</p>
      </div>
    </div>
  </div>
</section>

<section style="max-width:1180px;margin:0 auto;padding:70px 30px 0;">
  <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">$ GET /api/pow/challenge?slug=hash</div>
  <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:14px;">
    <h2 style="font-weight:800;font-size:42px;line-height:1;letter-spacing:-.025em;margin:0;color:var(--ink);">Or pay with CPU instead.</h2>
    <span style="font-family:var(--font-mono);font-size:12.5px;color:var(--faint);">no wallet · no signup · runs in this tab</span>
  </div>
  <p style="font-size:16px;color:var(--muted);max-width:700px;margin:0 0 30px;">The pure-CPU tools are payable in compute: the server issues a signed sha256 puzzle, you burn a fraction of a second solving it, and the call is served free. This is not a diagram - press the button and your browser will fetch a real challenge from the live server, solve it here, and make a real paid call.</p>
  <div class="hm-2col" style="display:grid;grid-template-columns:1fr 1fr;gap:0;border:1.5px solid var(--ink);">
    <div style="padding:26px;border-right:1.5px solid var(--ink);background:var(--card);">
      <label for="hm-demo-in" style="display:block;font-family:var(--font-mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin-bottom:10px;">Text to hash</label>
      <input id="hm-demo-in" type="text" value="hello" placeholder="anything at all" style="width:100%;background:var(--paper);color:var(--on-dark);font-family:var(--font-mono);font-size:14px;padding:13px 14px;margin-bottom:14px;outline:none;box-sizing:border-box;" />
      <button type="button" id="hm-demo-run" style="background:var(--accent);color:#fff;border:none;font-family:var(--font-mono);font-weight:700;font-size:13.5px;padding:13px 20px;cursor:pointer;width:100%;">RUN IT FREE →</button>
      <ol style="margin:20px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:0;border-top:1px solid var(--hairline);">
        <li style="display:grid;grid-template-columns:22px 1fr;gap:12px;padding:13px 0;border-bottom:1px solid var(--hairline);"><span id="hm-step1-mark" style="font-family:var(--font-mono);font-size:12px;color:var(--accent);">·</span><span><span style="font-size:14px;color:var(--ink);font-weight:700;">Request a challenge</span><br><span id="hm-step1" style="font-family:var(--font-mono);font-size:11.5px;color:var(--faint);">signed, single-use, scoped to one tool</span></span></li>
        <li style="display:grid;grid-template-columns:22px 1fr;gap:12px;padding:13px 0;border-bottom:1px solid var(--hairline);"><span id="hm-step2-mark" style="font-family:var(--font-mono);font-size:12px;color:var(--accent);">·</span><span><span style="font-size:14px;color:var(--ink);font-weight:700;">Solve it in your browser</span><br><span id="hm-step2" style="font-family:var(--font-mono);font-size:11.5px;color:var(--faint);">~65k hashes at 16 bits</span></span></li>
        <li style="display:grid;grid-template-columns:22px 1fr;gap:12px;padding:13px 0;"><span id="hm-step3-mark" style="font-family:var(--font-mono);font-size:12px;color:var(--accent);">·</span><span><span style="font-size:14px;color:var(--ink);font-weight:700;">Call the tool, free</span><br><span id="hm-step3" style="font-family:var(--font-mono);font-size:11.5px;color:var(--faint);">hash the challenge, submit the token</span></span></li>
      </ol>
    </div>
    <div style="background:var(--footer-bg);display:flex;flex-direction:column;">
      <div style="padding:14px 20px;border-bottom:1px solid var(--hairline);font-family:var(--font-mono);font-size:11px;letter-spacing:.08em;color:var(--dk-muted);display:flex;justify-content:space-between;gap:12px;">
        <span>POST /api/hash</span>
        <span id="hm-demo-status" style="color:var(--faint);">idle</span>
      </div>
      <pre id="hm-demo-out" style="margin:0;padding:20px;font-family:var(--font-mono);font-size:12px;line-height:1.75;color:var(--on-dark);white-space:pre-wrap;word-break:break-word;flex:1;"># the same three steps, from a shell:
curl -s '/api/pow/challenge?slug=hash'
# solve: sha256("&lt;challenge&gt;:" + nonce) with N leading zero bits
curl -X POST /api/hash \
  -H 'content-type: application/json' \
  -H 'X-Pow-Solution: &lt;token&gt;:&lt;nonce&gt;' \
  -d '{"text":"hello","algo":"sha256"}'</pre>
      <div id="hm-demo-receipt" style="padding:14px 20px;border-top:1px solid var(--hairline);font-family:var(--font-mono);font-size:11.5px;color:var(--green);">no wallet needed · press Run to spend CPU instead</div>
    </div>
  </div>
  <div style="margin-top:16px;display:flex;gap:20px;flex-wrap:wrap;font-family:var(--font-mono);font-size:13px;">
    <a href="/playground" style="color:var(--ink);text-decoration:none;border-bottom:1.5px solid var(--accent);padding-bottom:1px;">try every free tool in the playground →</a>
    <a href="/guides/x402-in-5-minutes" style="color:var(--muted);text-decoration:none;">how the free tier works →</a>
  </div>
</section>

<section id="sell" style="max-width:1180px;margin:0 auto;padding:70px 30px 0;">
  <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">$ POST /api/index/register</div>
  <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:14px;">
    <h2 style="font-weight:800;font-size:42px;line-height:1;letter-spacing:-.025em;margin:0;color:var(--ink);">Sell into the agent economy.</h2>
    <span style="font-family:var(--font-mono);font-size:12.5px;color:var(--faint);">free listing · nothing deducted · non-custodial</span>
  </div>
  <p style="font-size:16.5px;color:var(--muted);max-width:680px;margin:0 0 34px;">Agents are already buying, and they cannot fill in a signup form. If you run an API - or a site AI crawlers keep scraping for free - the same rails that let them buy let you charge. Money moves buyer wallet → your wallet. Nothing sits in between.</p>
  <div class="hm-2col" style="display:grid;grid-template-columns:1fr 1fr;gap:0;border:1.5px solid var(--ink);margin-bottom:20px;">
    <div style="padding:26px;border-right:1.5px solid var(--ink);background:var(--card);display:flex;flex-direction:column;">
      <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);margin-bottom:16px;">01 / LIST AN x402 API</div>
      <h3 style="font-weight:800;font-size:22px;margin:0 0 12px;color:var(--ink);">Get routed by the Smart Order Router</h3>
      <p style="font-size:14.5px;line-height:1.6;color:var(--muted);margin:0 0 18px;flex:1;">Serve x402 challenges, register your origin, and the index crawler picks you up hourly. You get ranked next to ${fmtNum(count)} of our own tools by match score, then health, then price - and a public leaderboard row once your on-chain volume shows up.</p>
      <pre style="margin:0 0 14px;background:var(--paper);border:1px solid var(--hairline);color:var(--on-dark);padding:14px;font-family:var(--font-mono);font-size:11.5px;line-height:1.75;white-space:pre-wrap;word-break:break-word;"><span style="color:var(--dk-muted3);"># or paste your origin below - same call, no terminal needed
</span>curl -X POST https://agent402.tools/api/index/register \
  -H 'content-type: application/json' \
  -d '{"origin":"https://api.you.com"}'</pre>
      <div class="hm-reg-row" style="display:flex;gap:10px;margin-top:auto;">
        <input id="hm-reg-origin" type="url" placeholder="https://api.yourdomain.com" style="flex:1;min-width:0;font-family:var(--font-mono);font-size:13px;padding:10px 12px;border:1.5px solid var(--ink);background:var(--paper);color:var(--ink);">
        <button id="hm-reg-go" style="background:var(--accent);color:#fff;font-family:var(--font-mono);font-weight:700;font-size:13px;border:none;padding:10px 18px;cursor:pointer;white-space:nowrap;">LIST IT →</button>
      </div>
      <div id="hm-reg-out" style="font-family:var(--font-mono);font-size:11.5px;color:var(--dk-muted3);margin-top:8px;">Free, no account - we probe your origin's x402 surface and list you if it answers.</div>
    </div>
    <div style="padding:26px;background:var(--card);display:flex;flex-direction:column;">
      <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);margin-bottom:16px;">02 / TOLLBOOTH A SITE</div>
      <h3 style="font-weight:800;font-size:22px;margin:0 0 12px;color:var(--ink);">Charge AI crawlers per page</h3>
      <p style="font-size:14.5px;line-height:1.6;color:var(--muted);margin:0 0 18px;flex:1;">Humans browse free; known bots get <span style="font-family:var(--font-mono);font-size:13px;color:var(--ink);">402 Payment Required</span> and either pay in USDC or solve a proof-of-work. The open, crypto-native answer to closed pay-per-crawl: no CDN lock-in, no merchant-of-record, no signup.</p>
      <pre style="margin:0 0 18px;background:var(--paper);border:1px solid var(--hairline);color:var(--on-dark);padding:14px;font-family:var(--font-mono);font-size:11.5px;line-height:1.75;white-space:pre-wrap;word-break:break-word;"><span style="color:var(--dk-muted3);"># express · next.js · cloudflare · proxy · wordpress
</span>npm i agent402-tollbooth</pre>
      <a class="ml-cta" href="/tollbooth" style="background:transparent;border:1.5px solid var(--ink);color:var(--ink);font-family:var(--font-mono);font-weight:700;font-size:13px;text-decoration:none;padding:11px 18px;align-self:flex-start;">GATE YOUR CRAWLERS →</a>
    </div>
  </div>

  <table style="font-family:var(--font-mono);font-size:13px;border:1.5px solid var(--ink);background:var(--card);width:100%;max-width:480px;">
    <caption style="text-align:left;font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);padding:0 0 10px;">What a seller gets - full detail at <a href="/sell" style="color:var(--faint);">/sell</a></caption>
    <tbody>
      <tr style="border-bottom:1px solid var(--hairline);"><th scope="row" style="text-align:left;font-weight:700;padding:13px 18px;color:var(--ink);width:230px;">Listing fee</th><td style="padding:13px 18px;text-align:right;color:var(--accent);white-space:nowrap;">$0</td></tr>
      <tr style="border-bottom:1px solid var(--hairline);"><th scope="row" style="text-align:left;font-weight:700;padding:13px 18px;color:var(--ink);">Commission</th><td style="padding:13px 18px;text-align:right;color:var(--accent);white-space:nowrap;">0%</td></tr>
      <tr style="border-bottom:1px solid var(--hairline);"><th scope="row" style="text-align:left;font-weight:700;padding:13px 18px;color:var(--ink);">Routing</th><td style="padding:13px 18px;text-align:right;color:var(--on-dark);white-space:nowrap;">health-aware</td></tr>
      <tr style="border-bottom:1px solid var(--hairline);"><th scope="row" style="text-align:left;font-weight:700;padding:13px 18px;color:var(--ink);">Discovery</th><td style="padding:13px 18px;text-align:right;color:var(--on-dark);white-space:nowrap;">4 surfaces</td></tr>
      <tr style="border-bottom:1px solid var(--hairline);"><th scope="row" style="text-align:left;font-weight:700;padding:13px 18px;color:var(--ink);">How Agent402 earns</th><td style="padding:13px 18px;text-align:right;color:var(--on-dark);white-space:nowrap;">buyer-side</td></tr>
      <tr><th scope="row" style="text-align:left;font-weight:700;padding:13px 18px;color:var(--ink);">Cross-chain buyers</th><td style="padding:13px 18px;text-align:right;color:var(--on-dark);white-space:nowrap;">Base · Algorand</td></tr>
    </tbody>
  </table>
  <p style="font-family:var(--font-mono);font-size:12.5px;line-height:1.6;color:var(--dk-muted3);margin:14px 0 0;"><strong style="color:var(--on-dark);font-weight:700;">${fmtNum(viaRouter)}</strong> of ${fmtNum(viaUsdc)} paid calls (${esc(routerPct)}) came through the router, which is the only path Agent402 earns on. Every other paid call went buyer wallet to seller wallet.</p>
  <div style="margin-top:16px;font-family:var(--font-mono);font-size:13px;"><a href="/sell" style="color:var(--ink);text-decoration:none;border-bottom:1.5px solid var(--accent);padding-bottom:1px;">everything for sellers → /sell</a></div>
</section>

<section style="background:var(--surface);margin-top:70px;border-top:1.5px solid var(--ink);border-bottom:1.5px solid var(--ink);">
  <div style="max-width:1180px;margin:0 auto;padding:60px 30px;">
    <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">$ GET /api/leaderboard?include=external</div>
    <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:14px;">
      <h2 style="font-weight:800;font-size:42px;line-height:1;letter-spacing:-.025em;margin:0;color:var(--on-dark);">The index, not just a seller.</h2>
      <span style="font-family:var(--font-mono);font-size:12.5px;color:var(--dk-muted3);">hourly on-chain snapshot · Bazaar → eth_getLogs → aggregate by payTo</span>
    </div>
    <p style="font-size:16px;line-height:1.6;color:var(--dk-muted2);max-width:700px;margin:0 0 34px;">Every x402 seller we can crawl, ranked by <strong style="color:var(--on-dark);font-weight:700;">real Base USDC settled volume</strong> - not self-reported traffic. <span style="font-family:var(--font-mono);font-size:14px;color:var(--on-dark);">include=external</span> excludes us from our own ranking, because a neutral index has to be checkable.</p>

    <div style="border:1.5px solid var(--dark-border2);background:var(--card);">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:13px 18px;border-bottom:1px solid var(--dark-border2);font-family:var(--font-mono);">
        <span style="font-size:11px;color:var(--dk-muted2);letter-spacing:.1em;">OTHER SELLERS · BY USDC SETTLED · 7d</span>
        <span style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--accent-lit);"><span style="width:6px;height:6px;border-radius:50%;background:var(--accent-lit);display:inline-block;animation:ml-pulse 1.8s ease-in-out infinite;"></span>LIVE</span>
      </div>
      <table style="font-family:var(--font-mono);font-size:12.5px;">
        <thead><tr style="border-bottom:1px solid var(--dark-border);color:var(--dk-muted3);"><th scope="col" style="text-align:left;font-weight:400;padding:9px 18px;width:34px;">#</th><th scope="col" style="text-align:left;font-weight:400;padding:9px 18px;">seller</th><th scope="col" style="text-align:right;font-weight:400;padding:9px 18px;">usdc settled</th><th scope="col" style="text-align:right;font-weight:400;padding:9px 18px;">calls</th><th scope="col" style="text-align:right;font-weight:400;padding:9px 18px;">buyers</th></tr></thead>
        <tbody>${leaderboardRowsHtml}</tbody>
      </table>
      <div style="padding:11px 18px;border-top:1px solid var(--dark-border2);font-family:var(--font-mono);font-size:11px;color:var(--dk-muted3);display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;"><span>Agent402 excluded · hourly snapshot</span><a href="/leaderboard" style="color:var(--accent-lit);text-decoration:none;">full leaderboard →</a></div>
    </div>

    <div style="margin-top:30px;border-top:1px dashed var(--dash);padding-top:24px;">
      <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:16px;">
        <h3 style="font-weight:800;font-size:22px;margin:0;color:var(--on-dark);">Settled on every rail, not just Base.</h3>
        <span style="font-family:var(--font-mono);font-size:12px;color:var(--dk-muted3);">calls settled per rail · live from /api/stats</span>
      </div>
      <p style="font-size:15px;line-height:1.6;color:var(--dk-muted2);max-width:700px;margin:0 0 20px;">All twelve rails carry real settled traffic, not just the headline one. Buyers pay on the chain they already hold stablecoins on, gas is sponsored on EVM, and the router pays external sellers on that same chain.</p>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(178px,1fr));gap:0;border:1.5px solid var(--dark-border2);">${railRowsHtml}</div>
      <div style="display:flex;flex-wrap:wrap;gap:10px 26px;margin-top:16px;font-family:var(--font-mono);font-size:12.5px;color:var(--dk-muted3);">
        <span><strong style="color:var(--on-dark);font-weight:700;">${fmtNum(attributed)}</strong> of ${fmtNum(viaUsdc)} paid calls carry a per-rail tag</span>
        <span><strong style="color:var(--accent-lit);font-weight:700;">${fmtNum(mppWire)}</strong> settled over the MPP wire</span>
        <a href="/what-is-x402" style="color:var(--accent-lit);text-decoration:none;">how the dual stack works →</a>
      </div>
    </div>
  </div>
</section>

<section style="max-width:1180px;margin:0 auto;padding:64px 30px 0;">
  <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">$ GET /api/bestsellers · $0.005</div>
  <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:14px;">
    <h2 style="font-weight:800;font-size:42px;line-height:1;letter-spacing:-.025em;margin:0;color:var(--ink);">What agents actually pay for.</h2>
    <span style="font-family:var(--font-mono);font-size:12.5px;color:var(--faint);">lanes shown · figures are a paid read</span>
  </div>
  <p style="font-size:16px;color:var(--muted);max-width:700px;margin:0 0 26px;">Settlements are on chain, but <em style="color:var(--on-dark2);">which tool an agent bought</em> is not - so this is the one demand signal no block explorer can reconstruct. Here are the lanes agents spend most in. The full per-tool ranking is itself a paid tool.</p>
  <div style="display:grid;grid-template-columns:minmax(0,1fr);gap:0;border:1.5px solid var(--ink);">
    ${demandLanesHtml}
    <a href="/tools/bestsellers" style="display:grid;grid-template-columns:28px 1fr auto;gap:14px;align-items:center;padding:16px 18px;text-decoration:none;background:var(--footer-bg);">
      <span style="font-family:var(--font-mono);font-size:12px;color:var(--faint);">·</span>
      <span style="font-family:var(--font-mono);font-size:13px;color:var(--muted);">the full ranking, plus buyer-diversity, revenue and trend lenses</span>
      <span style="font-family:var(--font-mono);font-size:13px;color:var(--accent-lit);white-space:nowrap;">$0.005 →</span>
    </a>
  </div>
  <div style="display:flex;gap:20px;flex-wrap:wrap;margin-top:16px;font-family:var(--font-mono);font-size:13px;">
    <a href="/sell" style="color:var(--ink);text-decoration:none;border-bottom:1.5px solid var(--accent);padding-bottom:1px;">list an API in one of these lanes →</a>
    <a href="/tools" style="color:var(--ink);text-decoration:none;border-bottom:1.5px solid var(--accent);padding-bottom:1px;">all ${fmtNum(count)} tools →</a>
    <a href="/pricing" style="color:var(--ink);text-decoration:none;border-bottom:1.5px solid var(--accent);padding-bottom:1px;">price list →</a>
  </div>
</section>

<section style="max-width:900px;margin:0 auto;padding:70px 30px 20px;">
  <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">$ GET /faq</div>
  <h2 style="font-weight:800;font-size:40px;line-height:1;letter-spacing:-.025em;margin:0 0 32px;color:var(--ink);">Questions people and agents ask.</h2>
  <div style="display:flex;flex-direction:column;gap:0;border-top:1.5px solid var(--ink);">${faqHtml}</div>
  <p style="font-family:var(--font-mono);font-size:13px;color:var(--muted);margin:20px 0 0;">More, including data handling and the OpenAI-compatible gateway: <a href="/faq" style="color:var(--accent);font-weight:700;">/faq</a></p>
  <style>section details > summary::-webkit-details-marker{display:none;} section details[open] .ml-faq-mark{transform:rotate(45deg);} .ml-faq-mark{transition:transform .15s ease;display:inline-block;}</style>
</section>

<section style="max-width:1180px;margin:0 auto;padding:30px 30px 56px;">
  <div style="background:var(--surface);border:1.5px solid var(--ink);padding:56px 46px;position:relative;overflow:hidden;">
    <div style="position:absolute;right:26px;top:-36px;font-weight:900;font-size:240px;line-height:1;color:transparent;-webkit-text-stroke:2px #ffffff10;pointer-events:none;">402</div>
    <div style="position:relative;">
      <h2 style="font-weight:800;font-size:40px;line-height:1;letter-spacing:-.025em;margin:0 0 16px;color:var(--on-dark);">Not x402-native yet?<br>You still have a way in.</h2>
      <p style="font-size:16.5px;line-height:1.6;color:var(--dk-muted2);margin:0 0 30px;max-width:560px;">You do not have to rebuild anything. <strong style="color:var(--on-dark);font-weight:700;">agent402-tollbooth</strong> drops a pay-per-crawl gate in front of a site that speaks no protocol at all, and adding a tool to the catalog itself is roughly fifteen lines. Either route, you keep your own paywall and your own wallet.</p>
      <div style="display:flex;gap:11px;flex-wrap:wrap;">
        <a class="ml-cta" href="#sell" style="background:var(--accent);color:#fff;font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:14px 24px;">LIST YOUR API - FREE →</a>
        <a class="ml-cta" href="/tollbooth" style="background:transparent;border:1.5px solid var(--dark-border2);color:var(--on-dark);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:13px 24px;">TOLLBOOTH A SITE</a>
        <a class="ml-cta" href="/contribute" style="background:transparent;border:1.5px solid var(--dark-border2);color:var(--dk-muted);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:13px 24px;">CONTRIBUTE A TOOL</a>
      </div>
    </div>
  </div>
</section>

${ledgerFooterFull()}

<script src="/js/home-hero.js"></script>`;

  return ledgerShell({ title, description, canonical, baseUrl, activePath: "", jsonLd: [orgLd, websiteLd, appLd, datasetLd, surfacesLd, faqLd], extraCss, body });
}
