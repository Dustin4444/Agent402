// Machine Ledger — Home page ("Agent402 Ledger")
// The primary marketing page: hero, receipt, registry manifest, three ways in,
// catalog index, leaderboard preview, settlement tape, proof, FAQ, CTA, footer.

import { ledgerShell, ledgerFooterFull, ledgerTape, esc } from "./ledger-chrome.js";
import { toolList, CATEGORIES } from "./pages.js";
import { isComputePayable } from "./pow.js";
import { RAILS, RAILS_AMP, RAILS_SHORT, RAILS_PAREN } from "./rails.js";
import { PACK_PRICES } from "./tools/skill-runner.js";
import { CHAIN_PAGES } from "./market-page.js";

// RAILS caip2 -> CHAIN_PAGES key, so the by-chain strip can tell which rails
// have a live market page (stellar, algorand) vs. rail-only cells (no page
// yet). Adding a chain page later is a CHAIN_PAGES entry — this map, and the
// strip below, pick it up with zero edits here.
const CHAIN_PAGE_BY_CAIP2 = new Map(Object.entries(CHAIN_PAGES).map(([key, cfg]) => [cfg.caip2, key]));

// The six packs merchandised on the home page — a deliberate mix: two premium
// research jobs, two of the newest agent-ops jobs, one security classic, one
// free-over-PoW on-ramp. Revisit when the sales ledger (/api/sales) says
// buyers want something else up front.
const FLAGSHIP_PACKS = ["financial-research", "search-and-cite", "onchain-analyst", "seo-audit", "wallet-readiness", "decode-blob"];

const fmtNum = (n) => Number(n || 0).toLocaleString("en-US");

export function ledgerHomePage(baseUrl, catalog, stats, leaderboardSnapshot, skillPacks, { chainSellerCounts } = {}) {
  const tools = toolList(catalog);
  const count = tools.length;
  const freeCount = tools.filter(isComputePayable).length;
  const served = stats?.toolCallsServed;
  const recent = Array.isArray(stats?.recentCalls) ? stats.recentCalls : [];
  const board = Array.isArray(leaderboardSnapshot?.leaderboard) ? leaderboardSnapshot.leaderboard : [];
  const packCount = Array.isArray(skillPacks) ? skillPacks.length : 42;

  // By-chain strip data — one cell per rail from rails.js, joined with
  // page-availability (CHAIN_PAGES) and live seller counts (chainSellerCounts,
  // built by server.js from the same index snapshot /stellar and /algorand
  // render). No opts at all (offline smoke tests) still renders 7 cells —
  // every rail just falls back to its rail-only or "unavailable" state.
  const chainCells = RAILS.map((r) => {
    const pageKey = CHAIN_PAGE_BY_CAIP2.get(r.caip2);
    const hasPage = !!pageKey;
    const sellerCount = hasPage ? chainSellerCounts?.[pageKey] : undefined;
    const known = Number.isFinite(sellerCount);
    const live = hasPage && known;
    return {
      name: r.name.replace(/ Chain$/, "").toUpperCase(),
      asset: `${r.asset} · ${r.caip2}`,
      href: hasPage ? `/${pageKey}` : "/index",
      nameColor: hasPage ? "var(--cream2)" : "var(--dk-muted2)",
      statusColor: live ? "var(--green)" : "var(--dk-muted3)",
      status: hasPage ? (known ? `${fmtNum(sellerCount)} seller${sellerCount === 1 ? "" : "s"} indexed` : "unavailable") : "rail live",
    };
  });
  const chainCellHtml = (c) =>
    `<a href="${esc(c.href)}" style="display:block;padding:14px 16px;border-right:1px solid var(--dark-border);text-decoration:none;">
        <span style="display:block;font-family:var(--font-mono);font-weight:700;font-size:13px;color:${c.nameColor};margin-bottom:3px;">${esc(c.name)}</span>
        <span style="display:block;font-family:var(--font-mono);font-size:10.5px;color:var(--dk-muted3);margin-bottom:9px;">${esc(c.asset)}</span>
        <span style="display:inline-flex;align-items:center;gap:6px;font-family:var(--font-mono);font-size:11px;color:${c.statusColor};"><span style="width:6px;height:6px;border-radius:50%;background:${c.statusColor};display:inline-block;"></span>${esc(c.status)}</span>
      </a>`;

  // Category data for the index
  const catEntries = Object.entries(CATEGORIES);
  const catData = catEntries.map(([key, { label, blurb }]) => {
    const inCat = tools.filter((t) => t.category === key);
    if (!inCat.length) return null;
    const cheapest = inCat.reduce((a, t) => Math.min(a, parseFloat(t.price.slice(1))), Infinity);
    return { key, label, blurb, count: inCat.length, price: `$${cheapest}` };
  }).filter(Boolean);
  const mid = Math.ceil(catData.length / 2);
  const leftCats = catData.slice(0, mid);
  const rightCats = catData.slice(mid);

  const catRow = (c, last) =>
    `<div style="display:grid;grid-template-columns:1fr auto auto;gap:14px;align-items:center;padding:13px 18px;${last ? "" : "border-bottom:1px solid var(--hairline);"}${c.key === "convert" ? "background:var(--card-zebra);" : ""}"><div><div style="font-weight:700;font-size:15px;">${esc(c.label)}</div><div style="font-family:var(--font-mono);font-size:11.5px;color:var(--faint);">${esc(c.blurb.length > 50 ? c.blurb.slice(0, 50) + "…" : c.blurb)}</div></div><span style="font-family:var(--font-mono);font-weight:700;font-size:15px;">${fmtNum(c.count)}</span><span style="font-family:var(--font-mono);font-size:11px;color:var(--accent);width:56px;text-align:right;">${c.price}</span></div>`;

  // Leaderboard preview (top 5)
  const top5 = board.slice(0, 5);
  const lbRow = (r, i) => {
    const rank = String(i + 1).padStart(2, "0");
    const isFirst = i === 0;
    return `<div style="display:grid;grid-template-columns:26px 1fr 86px 56px;gap:10px;padding:11px 18px;color:var(--cream);${i < top5.length - 1 ? "border-bottom:1px solid var(--dark-border);" : ""}${isFirst ? "background:linear-gradient(90deg,#d63c1a1f,transparent);" : ""}"><span style="color:${isFirst ? "var(--accent)" : "var(--dk-muted3)"};">${rank}</span><span>${esc(r.name)}</span><span style="text-align:right;color:var(--cream2);">$${Number(r.totalUsd || 0).toFixed(2)}</span><span style="text-align:right;color:var(--dk-muted2);">${fmtNum(r.uniqueBuyers || 0)}</span></div>`;
  };

  const canonical = baseUrl + "/";
  const title = `Agent402 — ${packCount} agent skill packs, one x402 payment each (${fmtNum(count)} tools)`;
  const description = `${packCount} skill packs that do a whole agent job in one x402 payment — research a stock, audit a domain's SEO, run SQL over Base — built on ${fmtNum(count)} deterministic pay-per-call tools, plus an OpenAI-compatible LLM gateway at /v1 (chat, embeddings, images & speech from $0.002, model-optional auto-routing). Free via proof-of-work; ${RAILS_SHORT} — from $0.001/call. No signup, no API key — the wallet is the identity.`;

  // One source of truth for the FAQ: these five Q&As render as the visible
  // section below AND as FAQPage JSON-LD (rich-result eligibility the old
  // landing page had and the ledger redesign initially dropped — the deploy
  // workflow's SEO gate greps prod for both surfaces).
  const faqs = [
    { q: "What is Agent402?", a: `A live node in the machine-to-machine economy: ${fmtNum(count)} web tools an autonomous agent can call and pay for per request in USDC via x402 — or with proof-of-work, no wallet. No human, no signup, no API key.` },
    { q: "How does an agent pay for a tool?", a: `It calls an endpoint and gets an HTTP 402 quote. An x402 client signs a payment — ${RAILS_PAREN} — from the agent's own wallet, and retries; the call settles on-chain in seconds. The wallet is the identity.` },
    { q: "Are any tools free?", a: `Yes — ${fmtNum(freeCount)} of the ${fmtNum(count)} pure-CPU tools work with no wallet: solve a short proof-of-work puzzle (a few seconds of CPU) instead of paying USDC.` },
    { q: "Does it spend my model tokens?", a: "No. Every tool is deterministic code — parsers, hashes, math, a real browser — with no LLM in the path. Tools like /api/extract exist to save your tokens: clean markdown out instead of 100k tokens of raw HTML in." },
    { q: "How do I get paid as a seller?", a: "Serve x402 challenges from your API (or install agent402-tollbooth on your site) and buyers settle USDC straight to your wallet - non-custodial, no merchant account. The index crawler lists any origin whose 402s answer; ranking is health-based and listing is free." },
  ];

  const jsonLd = [
    // Organization entity with a sameAs graph — the structured signal search
    // engines use to resolve which entity a brand name refers to. Every
    // sameAs URL is a profile we control and that links back here.
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      "@id": `${baseUrl}/#organization`,
      name: "Agent402",
      alternateName: "Agent402.Tools",
      url: baseUrl,
      logo: { "@type": "ImageObject", url: `${baseUrl}/logo.png` },
      founder: { "@type": "Person", name: "Mike Petrillo", url: "https://github.com/MikeyPetrillo" },
      sameAs: [
        "https://github.com/MikeyPetrillo/Agent402",
        "https://x.com/Agent402Tools",
        "https://www.npmjs.com/package/agent402-mcp",
        "https://www.npmjs.com/package/agent402-client",
        "https://www.npmjs.com/package/agent402-tollbooth",
        "https://pypi.org/project/agent402-langchain/",
        "https://www.x402scan.com/server/07eb3020-932a-436d-a739-557b6e47101d",
      ],
    },
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "Agent402.Tools",
      url: baseUrl,
      publisher: { "@id": `${baseUrl}/#organization` },
      description,
      potentialAction: { "@type": "SearchAction", target: `${baseUrl}/api/find?q={search_term_string}`, "query-input": "required name=search_term_string" },
    },
    {
      "@context": "https://schema.org",
      "@type": "WebApplication",
      name: "Agent402.Tools",
      url: baseUrl,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Any",
      // AggregateOffer (not a single Offer): the catalog spans $0.001 tool
      // calls to $0.50 premium-tier calls, and offerCount is the catalog size.
      offers: { "@type": "AggregateOffer", offerCount: String(count), lowPrice: "0.001", highPrice: "0.50", priceCurrency: "USD", description: `Per-call micropayments ${RAILS_AMP}, or free with proof-of-work` },
    },
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: faqs.map(({ q, a }) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })),
    },
  ];

  const body = `
  <!-- HERO -->
  <header style="position:relative;overflow:hidden;border-bottom:1.5px solid var(--ink);background-image:repeating-linear-gradient(#0b0b0b0a 0,#0b0b0b0a 1px,transparent 1px,transparent 34px);">
    <div style="position:absolute;right:-30px;top:10px;font-family:var(--font-body);font-weight:900;font-size:420px;line-height:1;letter-spacing:-.04em;color:transparent;-webkit-text-stroke:2px #0b0b0b14;pointer-events:none;user-select:none;">402</div>
    <div style="max-width:1180px;margin:0 auto;padding:70px 30px 0;position:relative;">
      <div class="ml-hero-grid" style="display:grid;grid-template-columns:1.08fr .92fr;gap:50px;align-items:start;">
        <div class="ml-stagger">
          <div style="font-family:var(--font-mono);font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin-bottom:20px;">open source · <span style="color:var(--accent);">x402</span> · mcp-native · settle in seconds</div>
          <h1 class="ml-hero-h1" style="font-family:var(--font-body);font-weight:800;font-size:70px;line-height:.94;letter-spacing:-.035em;margin:0 0 20px;color:var(--ink);">Where agents<br><span style="color:var(--accent);">pay</span> agents.</h1>
          <p style="font-size:18px;line-height:1.5;color:var(--muted);max-width:520px;margin:0 0 24px;"><strong style="color:var(--ink);font-weight:700;">${fmtNum(count)} tools your AI agent calls and pays for by the request</strong> — OpenAI-compatible chat, embeddings, images &amp; speech, live web search, market data, PDF &amp; OCR, on-chain reads. No signup, no API keys. <strong style="color:var(--ink);font-weight:700;">The wallet is the identity.</strong></p>
          <div style="display:flex;flex-wrap:wrap;border-top:1.5px solid var(--ink);border-bottom:1.5px solid var(--ink);margin:0 0 26px;max-width:560px;">
            ${[[fmtNum(count),"tools"],[String(packCount),"skill packs"],[fmtNum(freeCount),"free · pow"],['<span style="color:var(--accent);">$</span>0.001',"per call"],[String(RAILS.length),"chains"]].map(([n,l])=>`<div class="ml-spec-cell" style="flex:1 1 auto;padding:11px 16px 10px 0;margin-right:16px;border-right:1px dashed #C9C9C7;"><div style="font-family:var(--font-mono);font-weight:700;font-size:19px;line-height:1;font-variant-numeric:tabular-nums;">${n}</div><div style="font-family:var(--font-mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin-top:5px;">${l}</div></div>`).join("")}
          </div>
          <div style="display:flex;flex-wrap:wrap;align-items:center;gap:11px;margin-bottom:18px;">
            <a class="ml-cta" href="/docs" style="background:var(--accent);color:#fff;font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:13px 20px;box-shadow:4px 4px 0 #0b0b0b22;">ADD TO CLAUDE →</a>
            <a class="ml-cta" href="/tools" style="background:transparent;border:1.5px solid var(--ink);color:var(--ink);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:12px 20px;">BROWSE THE CATALOG</a>
          </div>
          <div style="display:flex;align-items:center;gap:9px;font-family:var(--font-mono);font-size:13px;color:var(--muted);">
            <span class="ml-dot"></span><span>live · <strong style="color:var(--ink);font-weight:700;font-variant-numeric:tabular-nums;">${fmtNum(served?.total || 0)}</strong> calls settled to date</span>
          </div>
        </div>
        <div class="ml-stagger" style="position:relative;">
          <div style="background:var(--ink);border:1.5px solid var(--ink);box-shadow:8px 8px 0 #0b0b0b1f;">
            <div style="display:flex;align-items:center;justify-content:space-between;padding:11px 15px;border-bottom:1px solid var(--dark-border2);font-family:var(--font-mono);font-size:11px;color:var(--dk-muted);letter-spacing:.06em;"><span>~ / agent402</span><span>SH</span></div>
            <pre style="margin:0;padding:20px 18px;font-family:var(--font-mono);font-size:12.5px;line-height:1.85;color:#E7DFCD;white-space:pre-wrap;word-break:break-word;"><span style="color:var(--dk-muted3);"># ${fmtNum(count)} x402 tools in Claude Code.
# no signup, no API key.
</span><span style="color:var(--accent);">$</span> <span style="color:var(--cream);">claude mcp add agent402 -s user \\
    -- npx -y agent402-mcp@latest

</span><span style="color:var(--dk-muted3);"># then ask Claude:
# "quote AAPL and its 52-week range"
# "run financial-research on NVDA"
# "audit example.com for SEO"
# free tier pays in compute —
# ${RAILS_SHORT} when you scale.</span></pre>
          </div>
          <div style="position:absolute;top:-16px;right:-14px;transform:rotate(9deg);border:2.5px solid var(--accent);color:var(--accent);background:var(--paper);padding:6px 12px 5px;font-family:var(--font-mono);font-weight:700;font-size:11px;letter-spacing:.12em;line-height:1.25;text-align:center;box-shadow:2px 2px 0 #0b0b0b14;">PAYMENT REQUIRED<br><span style="font-size:9px;letter-spacing:.18em;opacity:.85;">· 402 · agent402.tools ·</span></div>
        </div>
      </div>

      <!-- LEDGER BAND -->
      <div class="ml-2col" style="display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:54px;padding-bottom:50px;">
        <div style="border:1.5px solid var(--ink);background:var(--card);padding:18px 20px;">
          <div style="display:flex;align-items:center;justify-content:space-between;font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;color:var(--muted);border-bottom:1px dashed #C9C9C7;padding-bottom:10px;margin-bottom:12px;"><span>·· RECEIPT ··</span><span>since ${stats?.servingSince ? String(stats.servingSince).slice(0, 10) : "2026-06-12"}</span></div>
          <div style="display:flex;flex-direction:column;gap:9px;font-family:var(--font-mono);font-size:14px;">
            <div style="display:flex;align-items:baseline;gap:8px;"><span style="color:var(--muted);">skill packs · one payment</span><span style="flex:1;border-bottom:1.5px dotted #C9C9C7;transform:translateY(-4px);"></span><span style="font-weight:700;">${packCount}</span></div>
            <div style="display:flex;align-items:baseline;gap:8px;"><span style="color:var(--muted);">x402 tools</span><span style="flex:1;border-bottom:1.5px dotted #C9C9C7;transform:translateY(-4px);"></span><span style="font-weight:700;">${fmtNum(count)}</span></div>
            <div style="display:flex;align-items:baseline;gap:8px;"><span style="color:var(--muted);">free · no wallet</span><span style="flex:1;border-bottom:1.5px dotted #C9C9C7;transform:translateY(-4px);"></span><span style="font-weight:700;">${fmtNum(freeCount)}</span></div>
            <div style="display:flex;align-items:baseline;gap:8px;"><span style="color:var(--muted);">starting / call</span><span style="flex:1;border-bottom:1.5px dotted #C9C9C7;transform:translateY(-4px);"></span><span style="font-weight:700;color:var(--accent);">$0.001</span></div>
            <div style="display:flex;align-items:baseline;gap:8px;"><span style="color:var(--muted);">calls settled</span><span style="flex:1;border-bottom:1.5px dotted #C9C9C7;transform:translateY(-4px);"></span><span style="font-weight:700;">${fmtNum(served?.total || 0)}</span></div>
          </div>
        </div>
        <div style="border:1.5px solid var(--ink);background:var(--card);padding:18px 20px;">
          <div style="display:flex;align-items:center;justify-content:space-between;font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;color:var(--muted);border-bottom:1px dashed #C9C9C7;padding-bottom:10px;margin-bottom:12px;"><span>·· REGISTERED ON ··</span><span>verified</span></div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:9px 18px;font-family:var(--font-mono);font-size:13.5px;">
            <div style="display:flex;gap:8px;"><span style="color:var(--accent);font-weight:700;">✓</span> Coinbase CDP Bazaar</div>
            <div style="display:flex;gap:8px;"><span style="color:var(--accent);font-weight:700;">✓</span> MCP Registry</div>
            <div style="display:flex;gap:8px;"><span style="color:var(--accent);font-weight:700;">✓</span> npm</div>
            <div style="display:flex;gap:8px;"><span style="color:var(--accent);font-weight:700;">✓</span> GitHub</div>
            <div style="display:flex;gap:8px;"><span style="color:var(--accent);font-weight:700;">✓</span> Base · USDC</div>
            <div style="display:flex;gap:8px;"><span style="color:var(--accent);font-weight:700;">✓</span> Robinhood · USDG</div>
            <div style="display:flex;gap:8px;"><span style="color:var(--accent);font-weight:700;">✓</span> OpenAPI 3.1</div>
          </div>
        </div>
      </div>
    </div>

    <!-- ROUTING SLIP -->
    <div style="border-top:1.5px solid var(--ink);border-bottom:1.5px solid var(--ink);background:var(--paper);">
      <div style="max-width:1180px;margin:0 auto;padding:0 30px;">
        <div class="ml-slip" style="display:grid;grid-template-columns:1fr 1fr 1fr;">
          <div class="ml-slip-cell" style="padding:20px 24px 20px 0;border-right:1.5px solid var(--ink);">
            <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;color:var(--accent);margin-bottom:8px;">01 / BUILDING AN AGENT?</div>
            <div style="font-size:14.5px;line-height:1.5;color:var(--muted);margin-bottom:10px;">${fmtNum(count)} tools, ${packCount} packs, an LLM gateway. Free tier, two-minute integration.</div>
            <div style="display:flex;gap:16px;flex-wrap:wrap;font-family:var(--font-mono);font-size:12.5px;">
              <a href="/quickstart" style="color:var(--ink);text-decoration:none;border-bottom:1.5px solid var(--accent);padding-bottom:1px;">quickstart →</a>
              <a href="/skills" style="color:var(--muted);text-decoration:none;">skill packs</a>
              <a href="/tools" style="color:var(--muted);text-decoration:none;">catalog</a>
            </div>
          </div>
          <div class="ml-slip-cell" style="padding:20px 24px;border-right:1.5px solid var(--ink);">
            <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;color:var(--accent);margin-bottom:8px;">02 / HERE FROM A CHAIN?</div>
            <div style="font-size:14.5px;line-height:1.5;color:var(--muted);margin-bottom:10px;">Your chain's x402 economy - sellers, receipts, rankings. All on-chain, all checkable.</div>
            <div style="display:flex;gap:16px;flex-wrap:wrap;font-family:var(--font-mono);font-size:12.5px;">
              <a href="/index" style="color:var(--ink);text-decoration:none;border-bottom:1.5px solid var(--accent);padding-bottom:1px;">the index →</a>
              <a href="/stellar" style="color:var(--muted);text-decoration:none;">stellar</a>
              <a href="/algorand" style="color:var(--muted);text-decoration:none;">algorand</a>
            </div>
          </div>
          <div class="ml-slip-cell" style="padding:20px 0 20px 24px;">
            <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;color:var(--accent);margin-bottom:8px;">03 / RUN AN API?</div>
            <div style="font-size:14.5px;line-height:1.5;color:var(--muted);margin-bottom:10px;">Get paid per call. List on the index free, or tollbooth the crawlers already hitting you.</div>
            <div style="display:flex;gap:16px;flex-wrap:wrap;font-family:var(--font-mono);font-size:12.5px;">
              <a href="/sell" style="color:var(--ink);text-decoration:none;border-bottom:1.5px solid var(--accent);padding-bottom:1px;">start selling →</a>
              <a href="/tollbooth" style="color:var(--muted);text-decoration:none;">tollbooth</a>
            </div>
          </div>
        </div>
      </div>
    </div>
  </header>

  <!-- THE PRODUCT — SKILL PACKS -->
  <section style="max-width:1180px;margin:0 auto;padding:78px 30px 0;">
    <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">$ POST /api/skill/{slug}</div>
    <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:12px;">
      <h2 style="font-family:var(--font-body);font-weight:800;font-size:44px;line-height:1;letter-spacing:-.02em;margin:0;color:var(--ink);">A whole job, one payment.</h2>
      <span style="font-family:var(--font-mono);font-size:12.5px;color:var(--faint);">${packCount} packs · $0.05–$1.50 · partial-success per step</span>
    </div>
    <p style="font-size:16px;color:var(--muted);max-width:620px;margin:0 0 30px;">No single tool researches a stock or audits a site. A skill pack orchestrates the right tools in the right order server-side and returns one envelope — every step's result, one x402 payment. Also callable as MCP prompts, so Claude can drive the same workflow itself.</p>
    <div class="ml-2col" style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;">
      ${FLAGSHIP_PACKS.map((slug) => {
        const p = (skillPacks || []).find((x) => x.slug === slug);
        if (!p) return "";
        const price = PACK_PRICES[slug] ?? 0.05;
        const tag = p.tagline.length > 150 ? p.tagline.slice(0, 147) + "…" : p.tagline;
        return `<a href="/skills/${p.slug}" style="border:1.5px solid var(--ink);background:var(--card);padding:18px 20px;text-decoration:none;color:var(--ink);display:flex;flex-direction:column;gap:10px;">
        <div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;"><span style="font-weight:800;font-size:16px;">${esc(p.title)}</span><span style="font-family:var(--font-mono);font-weight:700;font-size:13px;color:var(--accent);white-space:nowrap;">$${price.toFixed(2)}</span></div>
        <span style="font-size:13.5px;line-height:1.5;color:var(--muted);flex:1;">${esc(tag)}</span>
        <span style="font-family:var(--font-mono);font-size:11.5px;color:var(--faint);">${p.toolSlugs.length} tools · POST /api/skill/${p.slug} →</span>
      </a>`;
      }).join("\n      ")}
    </div>
    <div style="margin-top:16px;font-family:var(--font-mono);font-size:13px;"><a href="/skills" style="color:var(--ink);text-decoration:none;border-bottom:1.5px solid var(--accent);padding-bottom:1px;">browse all ${packCount} skill packs →</a></div>
  </section>

  <!-- THREE WAYS IN -->
  <section style="max-width:1180px;margin:0 auto;padding:78px 30px 20px;">
    <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">$ POST /connect</div>
    <h2 style="font-family:var(--font-body);font-weight:800;font-size:44px;line-height:1;letter-spacing:-.02em;margin:0 0 10px;color:var(--ink);">Three ways in.</h2>
    <p style="font-size:16px;color:var(--muted);max-width:540px;margin:0 0 36px;">Same surface underneath — payment handled automatically: proof-of-work for free tools, your x402 wallet for paid.</p>
    <div class="ml-2col" style="display:grid;grid-template-columns:repeat(3,1fr);gap:0;border:1.5px solid var(--ink);">
      <div style="padding:22px;border-right:1.5px solid var(--ink);display:flex;flex-direction:column;background:var(--card);">
        <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);margin-bottom:14px;">01 / YOUR AGENT</div>
        <p style="font-size:14px;line-height:1.5;color:var(--muted);margin:0 0 16px;flex:1;">Pay in code with any x402 client — <span style="font-family:var(--font-mono);font-size:12.5px;">@x402/fetch</span>, axios, or your framework.</p>
        <pre style="margin:0 0 14px;background:var(--ink);color:var(--cream);padding:13px;font-family:var(--font-mono);font-size:11.5px;line-height:1.65;white-space:pre-wrap;word-break:break-word;"><span style="color:var(--dk-muted3);">// signs USDC, retries on 402
</span>await payFetch(
  "…/api/extract", { url })</pre>
        <a href="/docs" style="font-family:var(--font-mono);font-size:12.5px;color:var(--ink);text-decoration:none;border-bottom:1.5px solid var(--accent);align-self:flex-start;padding-bottom:1px;">read the docs →</a>
      </div>
      <div style="padding:22px;border-right:1.5px solid var(--ink);display:flex;flex-direction:column;background:var(--card);">
        <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);margin-bottom:14px;">02 / CLAUDE · MCP</div>
        <p style="font-size:14px;line-height:1.5;color:var(--muted);margin:0 0 16px;flex:1;">Paste the hosted connector URL — zero install. Pure-CPU tools run free, rate-limited.</p>
        <pre style="margin:0 0 14px;background:var(--ink);color:var(--cream);padding:13px;font-family:var(--font-mono);font-size:11.5px;line-height:1.65;white-space:pre-wrap;word-break:break-word;"><span style="color:var(--dk-muted3);"># Settings → Connectors
</span>https://agent402.tools/mcp</pre>
        <a href="/docs" style="font-family:var(--font-mono);font-size:12.5px;color:var(--ink);text-decoration:none;border-bottom:1.5px solid var(--accent);align-self:flex-start;padding-bottom:1px;">add connector →</a>
      </div>
      <div style="padding:22px;display:flex;flex-direction:column;background:var(--card);">
        <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);margin-bottom:14px;">03 / YOUR CODE</div>
        <p style="font-size:14px;line-height:1.5;color:var(--muted);margin:0 0 16px;flex:1;">The <span style="font-family:var(--font-mono);font-size:12.5px;">agent402-client</span> SDK resolves a task to a tool and pays automatically.</p>
        <pre style="margin:0 0 14px;background:var(--ink);color:var(--cream);padding:13px;font-family:var(--font-mono);font-size:11.5px;line-height:1.65;white-space:pre-wrap;word-break:break-word;"><span style="color:var(--dk-muted3);">// free tier, zero deps
</span>await a.call("hash",
  { text, algo:"sha256" })</pre>
        <a href="/docs" style="font-family:var(--font-mono);font-size:12.5px;color:var(--ink);text-decoration:none;border-bottom:1.5px solid var(--accent);align-self:flex-start;padding-bottom:1px;">install the SDK →</a>
      </div>
    </div>
    <div style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin-top:14px;">+ zero-dep adapters: openai · anthropic · langchain · llamaindex · vercel-ai · google-adk · aws-strands</div>
  </section>

  <!-- CATALOG INDEX -->
  <section style="max-width:1180px;margin:0 auto;padding:70px 30px 20px;">
    <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">$ GET /catalog</div>
    <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:28px;">
      <h2 style="font-family:var(--font-body);font-weight:800;font-size:44px;line-height:1;letter-spacing:-.02em;margin:0;color:var(--ink);">The index — ${fmtNum(count)} tools.</h2>
      <span style="font-family:var(--font-mono);font-size:12.5px;color:var(--faint);">deterministic · flat-priced · no LLM in the path</span>
    </div>
    <div style="border:1.5px solid var(--ink);background:var(--card);">
      <div class="ml-2col" style="display:grid;grid-template-columns:1fr 1fr;">
        <div style="border-right:1.5px solid var(--ink);">
          ${leftCats.map((c, i) => catRow(c, i === leftCats.length - 1)).join("\n          ")}
        </div>
        <div>
          ${rightCats.map((c, i) => catRow(c, false)).join("\n          ")}
          <a href="/tools" style="display:grid;grid-template-columns:1fr auto;gap:14px;align-items:center;padding:14px 18px;text-decoration:none;color:var(--ink);background:var(--ink);"><span style="font-family:var(--font-mono);font-weight:700;font-size:14px;color:var(--cream);">Browse all ${fmtNum(count)} tools →</span><span style="font-family:var(--font-mono);font-size:11px;color:var(--dk-muted);">+${packCount} skill packs</span></a>
        </div>
      </div>
    </div>
  </section>

  <!-- NEUTRAL LAYER / LEADERBOARD -->
  <section style="background:var(--ink);margin-top:70px;border-top:1.5px solid var(--ink);border-bottom:1.5px solid var(--ink);">
    <div style="max-width:1180px;margin:0 auto;padding:76px 30px;">
      <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">$ GET /api/leaderboard</div>
      <div class="ml-2col" style="display:grid;grid-template-columns:1fr 1.1fr;gap:50px;align-items:center;">
        <div>
          <h2 style="font-family:var(--font-body);font-weight:800;font-size:44px;line-height:1;letter-spacing:-.02em;margin:0 0 16px;color:var(--cream2);">Not just a seller —<br>the neutral index.</h2>
          <p style="font-size:16px;line-height:1.6;color:var(--dk-muted2);margin:0 0 22px;">Index + Smart Order Router + Leaderboard, auto-crawled from the Coinbase CDP Bazaar and ranked by <strong style="color:var(--cream2);font-weight:700;">real on-chain USDC volume</strong>. Route a task across every x402 seller — not just ours.</p>
          <div style="display:flex;gap:20px;flex-wrap:wrap;font-family:var(--font-mono);font-size:13px;">
            <a href="/api/route" style="color:var(--accent);text-decoration:none;">/api/route →</a>
            <a href="/index" style="color:var(--accent);text-decoration:none;">/index →</a>
          </div>
        </div>
        <div style="border:1.5px solid var(--dark-border2);background:var(--ink-panel);">
          <div style="display:flex;align-items:center;justify-content:space-between;padding:13px 18px;border-bottom:1px solid var(--dark-border2);font-family:var(--font-mono);">
            <span style="font-size:11px;color:var(--dk-muted2);letter-spacing:.06em;">SELLERS · BY USDC SETTLED</span>
            <span style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--accent);"><span style="width:6px;height:6px;border-radius:50%;background:var(--accent);display:inline-block;animation:ml-pulse 1.8s ease-in-out infinite;"></span>LIVE</span>
          </div>
          <div style="font-family:var(--font-mono);font-size:12.5px;">
            <div style="display:grid;grid-template-columns:26px 1fr 86px 56px;gap:10px;padding:9px 18px;color:var(--dk-muted3);border-bottom:1px solid var(--dark-border);"><span>#</span><span>seller</span><span style="text-align:right;">usdc</span><span style="text-align:right;">buyers</span></div>
            ${top5.map((r, i) => lbRow(r, i)).join("\n            ")}
          </div>
          <div style="padding:10px 18px;border-top:1px solid var(--dark-border2);font-family:var(--font-mono);font-size:11px;color:var(--dk-muted3);">hourly on-chain snapshot · ?include=external</div>
        </div>
      </div>
      <!-- BY-CHAIN STRIP -->
      <div style="margin-top:40px;">
        <div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:12px;">
          <span style="font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;color:var(--accent);">THE INDEX, BY CHAIN - ADDING A CHAIN ADDS A CELL, NOT A NAV LINK</span>
          <a href="/index" style="font-family:var(--font-mono);font-size:12px;color:var(--dk-muted2);text-decoration:none;">/index →</a>
        </div>
        <div class="ml-mkts" style="display:grid;grid-template-columns:repeat(${chainCells.length},1fr);gap:0;border:1.5px solid var(--dark-border2);background:var(--ink-panel);">
          ${chainCells.map(chainCellHtml).join("\n          ")}
        </div>
        <div style="margin-top:10px;font-family:var(--font-mono);font-size:11px;color:var(--dk-muted3);">seller counts + health derive at render · a failed crawl reads "unavailable", never zero</div>
      </div>
    </div>
  </section>

  <!-- SETTLEMENT TAPE -->
  ${ledgerTape(recent)}

  <!-- SELL BAND -->
  <section id="sell" style="max-width:1180px;margin:0 auto;padding:78px 30px 0;">
    <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">$ POST /sell</div>
    <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:12px;">
      <h2 style="font-family:var(--font-body);font-weight:800;font-size:44px;line-height:1;letter-spacing:-.02em;margin:0;color:var(--ink);">The other side of the ledger.</h2>
      <span style="font-family:var(--font-mono);font-size:12.5px;color:var(--faint);">no signup · non-custodial · your wallet, your funds</span>
    </div>
    <p style="font-size:16px;color:var(--muted);max-width:620px;margin:0 0 30px;">Agents are buying. If you run an API - or a site AI crawlers keep hitting - the same rails pay you.</p>
    <div class="ml-2col" style="display:grid;grid-template-columns:1fr 1fr;gap:0;border:1.5px solid var(--ink);">
      <div style="padding:22px;border-right:1.5px solid var(--ink);background:var(--card);display:flex;flex-direction:column;">
        <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);margin-bottom:14px;">01 / LIST YOUR API</div>
        <p style="font-size:14px;line-height:1.5;color:var(--muted);margin:0 0 16px;flex:1;">Serve x402 challenges and the index crawler lists you automatically - free, health-ranked, routed by the Smart Order Router next to ${fmtNum(count)} of our own tools.</p>
        <pre style="margin:0 0 14px;background:var(--ink);color:var(--cream);padding:13px;font-family:var(--font-mono);font-size:11.5px;line-height:1.65;white-space:pre-wrap;word-break:break-word;"><span style="color:var(--dk-muted3);"># we probe, you appear
</span>POST /api/index/register
  { "origin": "https://api.you.com" }</pre>
        <a href="/sell" style="font-family:var(--font-mono);font-size:12.5px;color:var(--ink);text-decoration:none;border-bottom:1.5px solid var(--accent);align-self:flex-start;padding-bottom:1px;">list your API →</a>
      </div>
      <div style="padding:22px;background:var(--card);display:flex;flex-direction:column;">
        <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);margin-bottom:14px;">02 / TOLLBOOTH YOUR SITE</div>
        <p style="font-size:14px;line-height:1.5;color:var(--muted);margin:0 0 16px;flex:1;">Humans browse free; known AI crawlers get 402 and pay in USDC - or solve proof-of-work. Express, edge, proxy, or WordPress. MIT, no CDN lock-in.</p>
        <pre style="margin:0 0 14px;background:var(--ink);color:var(--cream);padding:13px;font-family:var(--font-mono);font-size:11.5px;line-height:1.65;white-space:pre-wrap;word-break:break-word;"><span style="color:var(--dk-muted3);"># one middleware
</span>npm i agent402-tollbooth</pre>
        <a href="/tollbooth" style="font-family:var(--font-mono);font-size:12.5px;color:var(--ink);text-decoration:none;border-bottom:1.5px solid var(--accent);align-self:flex-start;padding-bottom:1px;">gate your crawlers →</a>
      </div>
    </div>
    <div style="margin-top:16px;font-family:var(--font-mono);font-size:13px;"><a href="/sell" style="color:var(--ink);text-decoration:none;border-bottom:1.5px solid var(--accent);padding-bottom:1px;">everything for sellers → /sell</a></div>
  </section>

  <!-- PROOF -->
  <section style="max-width:1180px;margin:0 auto;padding:78px 30px 20px;">
    <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">$ GET /verify</div>
    <h2 style="font-family:var(--font-body);font-weight:800;font-size:44px;line-height:1;letter-spacing:-.02em;margin:0 0 10px;color:var(--ink);">Every claim, checkable.</h2>
    <p style="font-size:16px;color:var(--muted);max-width:580px;margin:0 0 32px;">No sales calls, no contracts. Deterministic outputs, flat prices, a named maintainer, fully open source — asserted by nobody, verifiable by anybody.</p>
    <div style="border:1.5px solid var(--ink);background:var(--card);">
      <div style="display:grid;grid-template-columns:200px 1fr auto;gap:16px;align-items:center;padding:16px 20px;border-bottom:1px solid var(--hairline);"><div style="display:flex;gap:9px;align-items:center;"><span style="color:var(--accent);font-weight:700;font-family:var(--font-mono);">✓</span><span style="font-weight:700;font-size:15px;">On-chain settlements</span></div><span style="font-size:13.5px;color:var(--muted);">Every paid call lands at agent402.base.eth on Base USDC — verifiable on Basescan.</span><code style="font-family:var(--font-mono);font-size:11.5px;color:var(--ink);background:#EDEDEB;padding:4px 8px;">0xaBF4…a9D0</code></div>
      <div style="display:grid;grid-template-columns:200px 1fr auto;gap:16px;align-items:center;padding:16px 20px;border-bottom:1px solid var(--hairline);"><div style="display:flex;gap:9px;align-items:center;"><span style="color:var(--accent);font-weight:700;font-family:var(--font-mono);">✓</span><span style="font-weight:700;font-size:15px;">Open source</span></div><span style="font-size:13.5px;color:var(--muted);">Read every line that serves and prices your call. Self-host the whole thing free.</span><code style="font-family:var(--font-mono);font-size:11.5px;color:var(--ink);background:#EDEDEB;padding:4px 8px;">github.com/…/Agent402</code></div>
      <div style="display:grid;grid-template-columns:200px 1fr auto;gap:16px;align-items:center;padding:16px 20px;border-bottom:1px solid var(--hairline);"><div style="display:flex;gap:9px;align-items:center;"><span style="color:var(--accent);font-weight:700;font-family:var(--font-mono);">✓</span><span style="font-weight:700;font-size:15px;">Deterministic</span></div><span style="font-size:13.5px;color:var(--muted);">No LLM anywhere in the serving path. Same input, same bytes — no token spend.</span><code style="font-family:var(--font-mono);font-size:11.5px;color:var(--ink);background:#EDEDEB;padding:4px 8px;">re-tested per deploy</code></div>
      <div style="display:grid;grid-template-columns:200px 1fr auto;gap:16px;align-items:center;padding:16px 20px;border-bottom:1px solid var(--hairline);"><div style="display:flex;gap:9px;align-items:center;"><span style="color:var(--accent);font-weight:700;font-family:var(--font-mono);">✓</span><span style="font-weight:700;font-size:15px;">CDP Bazaar</span></div><span style="font-size:13.5px;color:var(--muted);">Discoverable on the index AI agents browse for x402 services, keyed to our payTo.</span><code style="font-family:var(--font-mono);font-size:11.5px;color:var(--ink);background:#EDEDEB;padding:4px 8px;">x402/discovery</code></div>
      <div style="display:grid;grid-template-columns:200px 1fr auto;gap:16px;align-items:center;padding:16px 20px;"><div style="display:flex;gap:9px;align-items:center;"><span style="color:var(--accent);font-weight:700;font-family:var(--font-mono);">✓</span><span style="font-weight:700;font-size:15px;">Self-describing</span></div><span style="font-size:13.5px;color:var(--muted);">Full OpenAPI 3.1 spec and machine-readable pricing for the entire catalog.</span><code style="font-family:var(--font-mono);font-size:11.5px;color:var(--ink);background:#EDEDEB;padding:4px 8px;">GET /openapi.json</code></div>
    </div>
  </section>

  <!-- FAQ -->
  <section style="max-width:860px;margin:0 auto;padding:70px 30px 30px;">
    <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">$ GET /faq</div>
    <h2 style="font-family:var(--font-body);font-weight:800;font-size:40px;line-height:1;letter-spacing:-.02em;margin:0 0 28px;color:var(--ink);">Questions.</h2>
    <div style="display:flex;flex-direction:column;">
      ${faqs.map(({ q, a }, i) => `<div style="padding:20px 0;border-top:${i === 0 ? "1.5px solid var(--ink)" : "1px solid var(--hairline)"};${i === faqs.length - 1 ? "border-bottom:1.5px solid var(--ink);" : ""}"><h3 style="font-size:16px;font-weight:700;margin:0 0 7px;">${esc(q)}</h3><p style="font-size:15px;line-height:1.55;color:var(--muted);margin:0;">${esc(a)}</p></div>`).join("\n      ")}
    </div>
  </section>

  <!-- CTA -->
  <section style="max-width:1180px;margin:0 auto;padding:20px 30px 64px;">
    <div style="background:var(--ink);padding:52px 44px;position:relative;overflow:hidden;">
      <div style="position:absolute;right:24px;top:-30px;font-family:var(--font-body);font-weight:900;font-size:220px;line-height:1;color:transparent;-webkit-text-stroke:2px #ffffff12;pointer-events:none;">402</div>
      <div style="position:relative;">
        <h2 style="font-family:var(--font-body);font-weight:800;font-size:42px;line-height:1;letter-spacing:-.02em;margin:0 0 14px;color:var(--cream2);">No signup. No API keys.<br>Just pay-per-call.</h2>
        <p style="font-size:16px;color:var(--dk-muted2);margin:0 0 26px;max-width:460px;">Add ${fmtNum(count)} tools to your agent in 60 seconds. Free tier, no wallet — settle in USDC when you scale.</p>
        <div style="display:flex;gap:11px;flex-wrap:wrap;">
          <a href="/docs" style="background:var(--accent);color:#fff;font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:13px 22px;">ADD TO CLAUDE →</a>
          <a href="/docs" style="background:transparent;border:1.5px solid #4a4738;color:var(--cream);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:12px 22px;">READ THE DOCS</a>
        </div>
      </div>
    </div>
  </section>

  ${ledgerFooterFull()}`;

  return ledgerShell({ title, description, canonical, baseUrl, activePath: "", jsonLd, body });
}
