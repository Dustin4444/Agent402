// Machine Ledger — Home page ("Agent402 Ledger")
// The primary marketing page: hero, skill packs, three ways in, catalog index,
// leaderboard preview, sell band, proof, FAQ (accordions), CTA, footer.

import { ledgerShell, ledgerFooterFull, esc } from "./ledger-chrome.js";
import { toolList, CATEGORIES } from "./pages.js";
import { isComputePayable } from "./pow.js";
import { RAILS, RAILS_AMP, RAILS_SHORT } from "./rails.js";
import { PACK_PRICES } from "./tools/skill-runner.js";
import { chainLogoStrip } from "./chain-logos.js";

// The six packs merchandised on the home page — a deliberate mix: two premium
// research jobs, two of the newest agent-ops jobs, one security classic, one
// free-over-PoW on-ramp. Revisit when the sales ledger (/api/sales) says
// buyers want something else up front.
const FLAGSHIP_PACKS = ["financial-research", "search-and-cite", "onchain-analyst", "seo-audit", "wallet-readiness", "decode-blob"];

const fmtNum = (n) => Number(n || 0).toLocaleString("en-US");

export function ledgerHomePage(baseUrl, catalog, stats, leaderboardSnapshot, skillPacks) {
  const tools = toolList(catalog);
  const count = tools.length;
  // The catalog's entries split into plain tools and skill-pack routes — the
  // curation story ("N tools + M packs") needs the composition, and it
  // must derive like everything else (never hardcode the counts here).
  const toolOnlyCount = tools.filter((t) => t.category !== "skill-pack").length;
  const freeCount = tools.filter(isComputePayable).length;
  const served = stats?.toolCallsServed;
  const board = Array.isArray(leaderboardSnapshot?.leaderboard) ? leaderboardSnapshot.leaderboard : [];
  const packCount = Array.isArray(skillPacks) ? skillPacks.length : 42;

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
    return `<div style="display:grid;grid-template-columns:26px 1fr 86px 56px;gap:10px;padding:11px 18px;color:var(--on-dark);${i < top5.length - 1 ? "border-bottom:1px solid var(--dark-border);" : ""}${isFirst ? "background:linear-gradient(90deg,#d63c1a1f,transparent);" : ""}"><span style="color:${isFirst ? "var(--accent)" : "var(--dk-muted3)"};">${rank}</span><span>${esc(r.name)}</span><span style="text-align:right;color:var(--on-dark2);">$${Number(r.totalUsd || 0).toFixed(2)}</span><span style="text-align:right;color:var(--dk-muted2);">${fmtNum(r.uniqueBuyers || 0)}</span></div>`;
  };

  const canonical = baseUrl + "/";
  const title = `Agent402 - ${packCount} agent skill packs, one x402 payment each (${fmtNum(count)} tools)`;
  const description = `${packCount} skill packs that do a whole agent job in one x402 payment - research a stock, audit a domain's SEO, run SQL over Base - built on ${fmtNum(count)} deterministic pay-per-call tools, plus an OpenAI-compatible LLM gateway at /v1 (chat, embeddings & images from $0.002, model-optional auto-routing). Free via proof-of-work; ${RAILS_SHORT} - from $0.001/call. No signup, no API key - the wallet is the identity.`;

  // One source of truth for the FAQ: these Q&As render as the visible section
  // below AND as FAQPage JSON-LD (rich-result eligibility the old landing page
  // had and the ledger redesign initially dropped — the deploy workflow's SEO
  // gate greps prod for both surfaces).
  //
  // Audience: a HUMAN who has never heard of x402. Agents discover endpoints
  // through marketplaces, /api/find and the MCP connector — they do not read
  // this page — so the job here is to explain the idea from zero, not to brief
  // someone already in the ecosystem. Depth (rails, MPP, /v1, the router,
  // self-hosting, privacy) lives on /faq; anything that needs prior knowledge
  // of x402 belongs there, not here. Answers are rendered with esc(), so they
  // are plain text: name a page in words rather than linking it.
  const faqs = [
    { q: "What is Agent402?", a: `A place where software buys small jobs, one at a time. ${fmtNum(toolOnlyCount)} web tools and ${packCount} skill packs - read a page, decode a barcode, check a domain, run a query - each with a price and each callable without a signup. The customers are mostly AI agents rather than people, so there is no account to create and no API key to manage.` },
    { q: "What is x402?", a: "When the web was designed, HTTP set aside a response for \"payment required\" - status code 402 - and then left it unused for about thirty years. x402 finally fills it in: ask for something, get a price back, pay, and the same request goes through. It is an open standard rather than anything we invented, and it is what lets a program buy one thing in one round trip with no subscription and no checkout page. There is a plain-English explainer on the what-is-x402 page." },
    { q: "Why would software need to buy anything?", a: "An AI agent working on a real task keeps running into things it cannot answer from memory: fetch a live page, pull a filing, convert a file, look up an address on a blockchain. Signing up for twenty different APIs is not something an agent can do on its own - it has no email, no credit card, and no way to agree to terms. Paying a fraction of a cent per call is something it can do." },
    { q: "Do I need crypto or a wallet to try it?", a: `No. ${fmtNum(freeCount)} of the ${fmtNum(count)} tools run free on proof-of-work: your own computer solves a short puzzle instead of paying, which costs a second of CPU and nothing else. A wallet only matters for tools that cost real money to run, and those quote their price before anything is charged.` },
    { q: "How do I know the money side is honest?", a: "The whole server is open source, so the payment code can be read line by line. Settlement happens on a public blockchain, so every payment is independently verifiable. And a failed call is never charged - payment only completes on a successful response, so if a tool breaks, no money moves." },
    { q: "I have a website or an API. Is there anything here for me?", a: "Yes, it runs in both directions. If you have an API, you can charge for it the same way and buyers pay straight into your wallet with nothing taken in between. If you have a website that AI crawlers keep hitting, agent402-tollbooth is an open-source gate that charges them per page instead of blocking them. Listing is free." },
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
    <div style="max-width:1180px;margin:0 auto;padding:70px 30px 60px;position:relative;">
      <div class="ml-hero-grid" style="display:grid;grid-template-columns:1.08fr .92fr;gap:50px;align-items:start;">
        <div class="ml-stagger">
          <div style="font-family:var(--font-mono);font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin-bottom:20px;">open source · <span style="color:var(--accent);">x402</span> · mcp-native · settle in seconds</div>
          <h1 class="ml-hero-h1" style="font-family:var(--font-body);font-weight:800;font-size:70px;line-height:.94;letter-spacing:-.035em;margin:0 0 20px;color:var(--ink);">Where agents<br><span style="color:var(--accent);">pay</span> agents.</h1>
          <p style="font-size:18px;line-height:1.5;color:var(--muted);max-width:520px;margin:0 0 24px;"><strong style="color:var(--ink);font-weight:700;">Your AI agent calls and pays for tools by the request.</strong> Web search, market data, PDF &amp; OCR, on-chain reads, an OpenAI-compatible LLM gateway. No signup, no API keys. <strong style="color:var(--ink);font-weight:700;">The wallet is the identity.</strong></p>
          <div style="display:flex;flex-wrap:wrap;border-top:1.5px solid var(--ink);border-bottom:1.5px solid var(--ink);margin:0 0 26px;max-width:560px;">
            ${[[fmtNum(count),"tools"],[String(packCount),"skill packs"],[fmtNum(freeCount),"free · pow"],['<span style="color:var(--accent);">$</span>0.001',"per call"],[String(RAILS.length),"chains"]].map(([n,l])=>`<div class="ml-spec-cell" style="flex:1 1 auto;padding:11px 16px 10px 0;margin-right:16px;border-right:1px dashed var(--dash);"><div style="font-family:var(--font-mono);font-weight:700;font-size:19px;line-height:1;font-variant-numeric:tabular-nums;">${n}</div><div style="font-family:var(--font-mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin-top:5px;">${l}</div></div>`).join("")}
          </div>
          <div style="display:flex;flex-wrap:wrap;align-items:center;gap:11px;margin-bottom:18px;">
            <a class="ml-cta" href="/docs#add" style="background:var(--accent);color:#fff;font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:13px 20px;box-shadow:4px 4px 0 #0b0b0b22;">ADD TO CLAUDE →</a>
            <a class="ml-cta" href="/tools" style="background:transparent;border:1.5px solid var(--ink);color:var(--ink);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:12px 20px;">BROWSE THE CATALOG</a>
          </div>
          <div style="display:flex;align-items:center;gap:9px;font-family:var(--font-mono);font-size:13px;color:var(--muted);">
            <span class="ml-dot"></span><span>live · <strong style="color:var(--ink);font-weight:700;font-variant-numeric:tabular-nums;">${fmtNum(served?.total || 0)}</strong> calls settled to date</span>
          </div>
        </div>
        <div class="ml-stagger" style="position:relative;">
          <div style="background:var(--surface);--accent:var(--accent-lit);border:1.5px solid var(--ink);box-shadow:8px 8px 0 #0b0b0b1f;">
            <div style="display:flex;align-items:center;justify-content:space-between;padding:11px 15px;border-bottom:1px solid var(--dark-border2);font-family:var(--font-mono);font-size:11px;color:var(--dk-muted);letter-spacing:.06em;"><span>~ / agent402</span><span>SH</span></div>
            <pre style="margin:0;padding:20px 18px;font-family:var(--font-mono);font-size:12.5px;line-height:1.85;color:var(--on-dark);white-space:pre-wrap;word-break:break-word;"><span style="color:var(--dk-muted3);"># ${fmtNum(count)} x402 tools in Claude Code.
# no signup, no API key.
</span><span style="color:var(--accent);">$</span> <span style="color:var(--on-dark);">claude mcp add agent402 -s user \\
    -- npx -y agent402-mcp@latest

</span><span style="color:var(--dk-muted3);"># then ask Claude:
# "quote AAPL and its 52-week range"
# "run financial-research on NVDA"
# "audit example.com for SEO"
# free tier pays in compute -
# ${RAILS_SHORT} when you scale.</span></pre>
          </div>
          <div style="position:absolute;top:-16px;right:-14px;transform:rotate(9deg);border:2.5px solid var(--accent);color:var(--accent);background:var(--paper);padding:6px 12px 5px;font-family:var(--font-mono);font-weight:700;font-size:11px;letter-spacing:.12em;line-height:1.25;text-align:center;box-shadow:2px 2px 0 #0b0b0b14;">PAYMENT REQUIRED<br><span style="font-size:9px;letter-spacing:.18em;opacity:.85;">· 402 · agent402.tools ·</span></div>
        </div>
      </div>
    </div>
  </header>

  <!-- SETTLEMENT RAILS - chain logo strip -->
  <div style="border-bottom:1.5px solid var(--ink);background:var(--paper);">
    <div style="max-width:1180px;margin:0 auto;padding:0 30px;">
      ${chainLogoStrip({ label: "Settles natively on twelve networks - USDC on eleven chains plus USDG on Robinhood" })}
    </div>
  </div>

  <!-- THE PRODUCT - SKILL PACKS -->
  <section style="max-width:1180px;margin:0 auto;padding:78px 30px 0;">
    <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">$ POST /api/skill/{slug}</div>
    <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:12px;">
      <h2 style="font-family:var(--font-body);font-weight:800;font-size:44px;line-height:1;letter-spacing:-.02em;margin:0;color:var(--ink);">A whole job, one payment.</h2>
      <span style="font-family:var(--font-mono);font-size:12.5px;color:var(--faint);">${packCount} packs · $0.05–$1.50 · partial-success per step</span>
    </div>
    <p style="font-size:16px;color:var(--muted);max-width:620px;margin:0 0 30px;">One payment runs a whole job: a pack orchestrates the right tools server-side and returns every step's result in one envelope. Callable as MCP prompts too.</p>
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
    <p style="font-size:16px;color:var(--muted);max-width:540px;margin:0 0 36px;">Same surface underneath - payment handled automatically: proof-of-work for free tools, your x402 wallet for paid.</p>
    <div class="ml-2col" style="display:grid;grid-template-columns:repeat(3,1fr);gap:0;border:1.5px solid var(--ink);">
      <div style="padding:22px;border-right:1.5px solid var(--ink);display:flex;flex-direction:column;background:var(--card);">
        <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);margin-bottom:14px;">01 / YOUR AGENT</div>
        <p style="font-size:14px;line-height:1.5;color:var(--muted);margin:0 0 16px;flex:1;">Pay in code with any x402 client - <span style="font-family:var(--font-mono);font-size:12.5px;">@x402/fetch</span>, axios, or your framework.</p>
        <pre style="margin:0 0 14px;background:var(--surface);color:var(--on-dark);padding:13px;font-family:var(--font-mono);font-size:11.5px;line-height:1.65;white-space:pre-wrap;word-break:break-word;"><span style="color:var(--dk-muted3);">// signs USDC, retries on 402
</span>await payFetch(
  "…/api/extract", { url })</pre>
        <a href="/docs" style="font-family:var(--font-mono);font-size:12.5px;color:var(--ink);text-decoration:none;border-bottom:1.5px solid var(--accent);align-self:flex-start;padding-bottom:1px;">read the docs →</a>
      </div>
      <div style="padding:22px;border-right:1.5px solid var(--ink);display:flex;flex-direction:column;background:var(--card);">
        <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);margin-bottom:14px;">02 / CLAUDE · MCP</div>
        <p style="font-size:14px;line-height:1.5;color:var(--muted);margin:0 0 16px;flex:1;">Paste the hosted connector URL - zero install. Pure-CPU tools run free, rate-limited.</p>
        <pre style="margin:0 0 14px;background:var(--surface);color:var(--on-dark);padding:13px;font-family:var(--font-mono);font-size:11.5px;line-height:1.65;white-space:pre-wrap;word-break:break-word;"><span style="color:var(--dk-muted3);"># Settings → Connectors
</span>https://agent402.tools/mcp</pre>
        <a href="/docs" style="font-family:var(--font-mono);font-size:12.5px;color:var(--ink);text-decoration:none;border-bottom:1.5px solid var(--accent);align-self:flex-start;padding-bottom:1px;">add connector →</a>
      </div>
      <div style="padding:22px;display:flex;flex-direction:column;background:var(--card);">
        <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);margin-bottom:14px;">03 / YOUR CODE</div>
        <p style="font-size:14px;line-height:1.5;color:var(--muted);margin:0 0 16px;flex:1;">The <span style="font-family:var(--font-mono);font-size:12.5px;">agent402-client</span> SDK resolves a task to a tool and pays automatically.</p>
        <pre style="margin:0 0 14px;background:var(--surface);color:var(--on-dark);padding:13px;font-family:var(--font-mono);font-size:11.5px;line-height:1.65;white-space:pre-wrap;word-break:break-word;"><span style="color:var(--dk-muted3);">// free tier, zero deps
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
    <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:12px;">
      <h2 style="font-family:var(--font-body);font-weight:800;font-size:44px;line-height:1;letter-spacing:-.02em;margin:0;color:var(--ink);">The index - ${fmtNum(count)} tools.</h2>
      <span style="font-family:var(--font-mono);font-size:12.5px;color:var(--faint);">deterministic · flat-priced · no LLM in the path</span>
    </div>
    <p style="font-size:16px;color:var(--muted);max-width:640px;margin:0 0 28px;">${fmtNum(toolOnlyCount)} tools + ${packCount} skill packs, each tested against its own example on every deploy and priced to market. It grows only when a tool is worth calling.</p>
    <div style="border:1.5px solid var(--ink);background:var(--card);">
      <div class="ml-2col" style="display:grid;grid-template-columns:1fr 1fr;">
        <div style="border-right:1.5px solid var(--ink);">
          ${leftCats.map((c, i) => catRow(c, i === leftCats.length - 1)).join("\n          ")}
        </div>
        <div>
          ${rightCats.map((c, i) => catRow(c, false)).join("\n          ")}
          <a href="/tools" style="display:grid;grid-template-columns:1fr auto;gap:14px;align-items:center;padding:14px 18px;text-decoration:none;color:var(--ink);background:var(--surface);"><span style="font-family:var(--font-mono);font-weight:700;font-size:14px;color:var(--on-dark);">Browse all ${fmtNum(count)} tools →</span><span style="font-family:var(--font-mono);font-size:11px;color:var(--dk-muted);">+${packCount} skill packs</span></a>
        </div>
      </div>
    </div>
  </section>

  <!-- NEUTRAL LAYER / LEADERBOARD -->
  <section style="background:var(--surface);--accent:var(--accent-lit);margin-top:70px;border-top:1.5px solid var(--ink);border-bottom:1.5px solid var(--ink);">
    <div style="max-width:1180px;margin:0 auto;padding:76px 30px;">
      <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">$ GET /api/leaderboard</div>
      <div class="ml-2col" style="display:grid;grid-template-columns:1fr 1.1fr;gap:50px;align-items:center;">
        <div>
          <h2 style="font-family:var(--font-body);font-weight:800;font-size:44px;line-height:1;letter-spacing:-.02em;margin:0 0 16px;color:var(--on-dark2);">Not just a seller -<br>the neutral index.</h2>
          <p style="font-size:16px;line-height:1.6;color:var(--dk-muted2);margin:0 0 22px;">An open index and Smart Order Router, ranked by <strong style="color:var(--on-dark2);font-weight:700;">real on-chain USDC volume</strong>. Route a task across every x402 seller, not just ours.</p>
          <div style="display:flex;gap:20px;flex-wrap:wrap;font-family:var(--font-mono);font-size:13px;">
            <a href="/marketplace" style="color:var(--accent);text-decoration:none;">Explore the marketplace →</a>
            <a href="/marketplace/tools" style="color:var(--accent);text-decoration:none;margin-left:18px;">Every tool indexed, ours and theirs →</a>
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
    </div>
  </section>

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
        <p style="font-size:14px;line-height:1.5;color:var(--muted);margin:0 0 16px;flex:1;">Serve x402 challenges and list it on /sell (free) and the index crawler picks it up - free, health-ranked, routed by the Smart Order Router next to ${fmtNum(count)} of our own tools.</p>
        <pre style="margin:0 0 14px;background:var(--surface);color:var(--on-dark);padding:13px;font-family:var(--font-mono);font-size:11.5px;line-height:1.65;white-space:pre-wrap;word-break:break-word;"><span style="color:var(--dk-muted3);"># we probe, you appear
</span>POST /api/index/register
  { "origin": "https://api.you.com" }</pre>
        <a href="/sell" style="font-family:var(--font-mono);font-size:12.5px;color:var(--ink);text-decoration:none;border-bottom:1.5px solid var(--accent);align-self:flex-start;padding-bottom:1px;">list your API →</a>
      </div>
      <div style="padding:22px;background:var(--card);display:flex;flex-direction:column;">
        <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);margin-bottom:14px;">02 / TOLLBOOTH YOUR SITE</div>
        <p style="font-size:14px;line-height:1.5;color:var(--muted);margin:0 0 16px;flex:1;">Humans browse free; known AI crawlers get 402 and pay in USDC - or solve proof-of-work. Express, edge, proxy, or WordPress. MIT, no CDN lock-in.</p>
        <pre style="margin:0 0 14px;background:var(--surface);color:var(--on-dark);padding:13px;font-family:var(--font-mono);font-size:11.5px;line-height:1.65;white-space:pre-wrap;word-break:break-word;"><span style="color:var(--dk-muted3);"># one middleware
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
    <p style="font-size:16px;color:var(--muted);max-width:580px;margin:0 0 32px;">No sales calls, no contracts. Deterministic outputs, flat prices, a named maintainer, fully open source - asserted by nobody, verifiable by anybody.</p>
    <div style="border:1.5px solid var(--ink);background:var(--card);">
      <div class="ml-proof-row" style="display:grid;grid-template-columns:200px 1fr auto;gap:16px;align-items:center;padding:16px 20px;border-bottom:1px solid var(--hairline);"><div style="display:flex;gap:9px;align-items:center;"><span style="color:var(--accent);font-weight:700;font-family:var(--font-mono);">✓</span><span style="font-weight:700;font-size:15px;">On-chain settlements</span></div><span style="font-size:13.5px;color:var(--muted);">Every paid call lands at agent402.base.eth on Base USDC - verifiable on Basescan.</span><code style="font-family:var(--font-mono);font-size:11.5px;color:var(--ink);background:var(--card-zebra);padding:4px 8px;">0xaBF4…a9D0</code></div>
      <div class="ml-proof-row" style="display:grid;grid-template-columns:200px 1fr auto;gap:16px;align-items:center;padding:16px 20px;border-bottom:1px solid var(--hairline);"><div style="display:flex;gap:9px;align-items:center;"><span style="color:var(--accent);font-weight:700;font-family:var(--font-mono);">✓</span><span style="font-weight:700;font-size:15px;">Open source</span></div><span style="font-size:13.5px;color:var(--muted);">Read every line that serves and prices your call. Self-host the whole thing free.</span><code style="font-family:var(--font-mono);font-size:11.5px;color:var(--ink);background:var(--card-zebra);padding:4px 8px;">github.com/…/Agent402</code></div>
      <div class="ml-proof-row" style="display:grid;grid-template-columns:200px 1fr auto;gap:16px;align-items:center;padding:16px 20px;border-bottom:1px solid var(--hairline);"><div style="display:flex;gap:9px;align-items:center;"><span style="color:var(--accent);font-weight:700;font-family:var(--font-mono);">✓</span><span style="font-weight:700;font-size:15px;">Deterministic</span></div><span style="font-size:13.5px;color:var(--muted);">No LLM in the deterministic tool path. Same input, same bytes - no token spend. (/v1 is a separate, opt-in LLM gateway.)</span><code style="font-family:var(--font-mono);font-size:11.5px;color:var(--ink);background:var(--card-zebra);padding:4px 8px;">re-tested per deploy</code></div>
      <div class="ml-proof-row" style="display:grid;grid-template-columns:200px 1fr auto;gap:16px;align-items:center;padding:16px 20px;border-bottom:1px solid var(--hairline);"><div style="display:flex;gap:9px;align-items:center;"><span style="color:var(--accent);font-weight:700;font-family:var(--font-mono);">✓</span><span style="font-weight:700;font-size:15px;">CDP Bazaar</span></div><span style="font-size:13.5px;color:var(--muted);">Discoverable on the index AI agents browse for x402 services, keyed to our payTo.</span><code style="font-family:var(--font-mono);font-size:11.5px;color:var(--ink);background:var(--card-zebra);padding:4px 8px;">x402/discovery</code></div>
      <div class="ml-proof-row" style="display:grid;grid-template-columns:200px 1fr auto;gap:16px;align-items:center;padding:16px 20px;"><div style="display:flex;gap:9px;align-items:center;"><span style="color:var(--accent);font-weight:700;font-family:var(--font-mono);">✓</span><span style="font-weight:700;font-size:15px;">Self-describing</span></div><span style="font-size:13.5px;color:var(--muted);">Full OpenAPI 3.1 spec and machine-readable pricing for the entire catalog.</span><code style="font-family:var(--font-mono);font-size:11.5px;color:var(--ink);background:var(--card-zebra);padding:4px 8px;">GET /openapi.json</code></div>
    </div>
  </section>

  <!-- FAQ -->
  <section style="max-width:860px;margin:0 auto;padding:70px 30px 30px;">
    <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">$ GET /faq</div>
    <h2 style="font-family:var(--font-body);font-weight:800;font-size:40px;line-height:1;letter-spacing:-.02em;margin:0 0 28px;color:var(--ink);">Questions.</h2>
    <div style="display:flex;flex-direction:column;">
      ${faqs.map(({ q, a }, i) => `<details${i === 0 ? " open" : ""} style="padding:0;border-top:${i === 0 ? "1.5px solid var(--ink)" : "1px solid var(--hairline)"};${i === faqs.length - 1 ? "border-bottom:1.5px solid var(--ink);" : ""}"><summary style="list-style:none;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:14px;padding:18px 0;font-size:16px;font-weight:700;color:var(--ink);"><span>${esc(q)}</span><span class="ml-faq-mark" style="font-family:var(--font-mono);font-weight:400;font-size:20px;color:var(--accent);line-height:1;flex:none;">+</span></summary><p style="font-size:15px;line-height:1.55;color:var(--muted);margin:0;padding:0 0 20px;">${esc(a)}</p></details>`).join("\n      ")}
    </div>
    <style>section details > summary::-webkit-details-marker{display:none;} section details[open] .ml-faq-mark{transform:rotate(45deg);} .ml-faq-mark{transition:transform .15s ease;display:inline-block;}</style>
  </section>

  <!-- CTA -->
  <section style="max-width:1180px;margin:0 auto;padding:20px 30px 64px;">
    <div style="background:var(--surface);padding:52px 44px;position:relative;overflow:hidden;">
      <div style="position:absolute;right:24px;top:-30px;font-family:var(--font-body);font-weight:900;font-size:220px;line-height:1;color:transparent;-webkit-text-stroke:2px #ffffff12;pointer-events:none;">402</div>
      <div style="position:relative;">
        <h2 style="font-family:var(--font-body);font-weight:800;font-size:42px;line-height:1;letter-spacing:-.02em;margin:0 0 14px;color:var(--on-dark2);">No signup. No API keys.<br>Just pay-per-call.</h2>
        <p style="font-size:16px;color:var(--dk-muted2);margin:0 0 26px;max-width:460px;">Add ${fmtNum(count)} tools to your agent in 60 seconds. Free tier, no wallet - settle in USDC when you scale.</p>
        <div style="display:flex;gap:11px;flex-wrap:wrap;">
          <a href="/docs#add" style="background:var(--accent);color:#fff;font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:13px 22px;">ADD TO CLAUDE →</a>
          <a href="/docs" style="background:transparent;border:1.5px solid var(--dark-border2);color:var(--on-dark);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:12px 22px;">READ THE DOCS</a>
        </div>
      </div>
    </div>
  </section>

  ${ledgerFooterFull()}`;

  return ledgerShell({ title, description, canonical, baseUrl, activePath: "", jsonLd, body });
}
