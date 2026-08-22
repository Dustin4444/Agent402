// Served pages for the human front door: the checkout page (/reports) and the
// report-delivery page (/r/:sessionId and /m/:reportId). Rendered through the
// shared ledger shell (2026-08-22 redesign) so they carry the site's nav,
// footer, tokens, fonts and SEO head like every other page; the page-level
// classes below are consumed by assets/js/reports.js and report-view.js
// (keep the class names stable - the scripts select on them).
import { HUMAN_PRODUCTS } from "./human-checkout.js";
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

// Shared by /reports, /r/:id, /m/:id and the monitors pages.
export const REPORTS_CSS = `
  .wrap{max-width:940px;margin:0 auto;padding:0 26px}
  .eyebrow{font-family:var(--font-mono);font-size:11.5px;font-weight:500;letter-spacing:.16em;text-transform:uppercase;color:var(--faint)}
  .btn{font-family:var(--font-body);font-size:15px;font-weight:500;border-radius:999px;border:1px solid transparent;cursor:pointer;padding:11px 18px;transition:transform .12s ease,border-color .15s ease;display:inline-flex;gap:8px;align-items:center;text-decoration:none;white-space:nowrap}
  .btn:hover{transform:translateY(-1px)}
  .btn-primary{background:var(--btn-bg);color:var(--btn-fg);box-shadow:var(--btn-shadow)}
  .btn-ghost{background:var(--chip-bg);color:var(--ink);border-color:var(--dash)}.btn-ghost:hover{border-color:var(--ink);color:var(--ink)}
  .btn:disabled{opacity:.5;cursor:default;transform:none}
  .hero{padding:64px 0 20px}.hero h1{font-weight:500;font-size:clamp(34px,5vw,56px);line-height:1.02;letter-spacing:-.035em;margin:14px 0 0;color:var(--ink);text-wrap:balance}.hero h1 em{font-style:normal;color:var(--faint)}
  .lede{font-size:19px;line-height:1.5;color:var(--muted);max-width:620px;margin:16px 0 0;font-weight:300}.lede b{color:var(--ink);font-weight:500}
  .products{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:18px;margin-top:8px}
  .pcard{border:1px solid var(--hairline);border-radius:18px;background:var(--card);padding:24px;box-shadow:inset 0 1px 0 var(--card-inset),0 1px 2px rgba(0,0,0,.08)}
  .pcard h3{font-weight:500;font-size:21px;letter-spacing:-.02em;margin:0;color:var(--ink)}.pcard .k{font-family:var(--font-mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin-bottom:8px}
  .pcard p{color:var(--muted);font-size:15px;line-height:1.5;margin:8px 0 16px;font-weight:300}
  .field{display:flex;gap:8px;background:var(--paper);border:1px solid var(--dash);border-radius:12px;padding:6px 6px 6px 14px;margin-bottom:12px}
  .field:focus-within{border-color:var(--ink)}
  .field input{flex:1;border:0;background:transparent;color:var(--ink);font-family:var(--font-body);font-size:16px;outline:none;min-width:0}
  .tiers{display:flex;gap:8px;flex-wrap:wrap}
  .tierbtn{flex:1;min-width:90px;border:1px solid var(--hairline);border-radius:12px;background:var(--card);padding:10px;cursor:pointer;text-align:center;font-family:var(--font-body);color:var(--ink)}
  .tierbtn .nm{font-family:var(--font-mono);font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--faint)}
  .tierbtn .pr{font-family:var(--font-mono);font-size:20px;color:var(--ink);margin-top:2px}
  .tierbtn.sel{border-color:var(--ink);box-shadow:0 0 0 1px var(--ink)}.tierbtn.sel .pr{color:var(--ink)}
  .note{font-family:var(--font-mono);font-size:11.5px;color:var(--faint);margin-top:16px}
  .err{color:#A5322B;font-size:14px;margin-top:8px;min-height:18px}
  .trust{display:flex;gap:20px;flex-wrap:wrap;color:var(--muted);font-size:14px;margin-top:16px}
  .trust span{display:inline-flex;gap:7px;align-items:center}.dot{width:5px;height:5px;border-radius:50%;background:var(--accent)}
  .report{background:var(--card);border:1px solid var(--hairline);border-radius:18px;padding:34px 38px;margin-top:24px}
  .report h1{font-weight:500;font-size:30px;letter-spacing:-.03em;margin:0 0 6px;color:var(--ink)}.report h2{font-weight:500;font-size:22px;letter-spacing:-.02em;margin:28px 0 8px;color:var(--ink)}.report h3{font-weight:500;font-size:18px;margin:20px 0 6px;color:var(--ink)}
  .report p{color:var(--muted);margin:0 0 14px;line-height:1.65}.report a{word-break:break-word;color:var(--accent)}
  .report ol,.report ul{color:var(--muted);line-height:1.6}
  .cite{font-family:var(--font-mono);font-size:.72em;font-weight:500;color:var(--accent);vertical-align:super}
  @keyframes sp{to{transform:rotate(360deg)}}
  .spin{display:inline-block;width:16px;height:16px;border:2px solid var(--dash);border-top-color:var(--ink);border-radius:50%;animation:sp .8s linear infinite;vertical-align:-3px;margin-right:8px}
  .status{background:var(--card);border:1px solid var(--hairline);border-radius:18px;padding:44px 34px;text-align:center;margin-top:24px}
  .status h2{font-weight:500;font-size:24px;letter-spacing:-.02em;margin:0 0 10px;color:var(--ink)}.status p{color:var(--muted);max-width:460px;margin:0 auto 8px;line-height:1.55}
  .report-actions{display:flex;gap:10px;align-items:center;margin:22px 0 4px;flex-wrap:wrap}
  .keep-hint{color:var(--muted);font-size:13px;margin-top:8px;line-height:1.5}
  .keep-hint ul{margin:6px 0 0;padding-left:18px}
  .rpt-head{border-bottom:1px solid var(--ink);padding-bottom:18px;margin-bottom:26px}
  .rpt-brand{display:flex;align-items:baseline;gap:9px;font-family:var(--font-mono);margin-bottom:14px}
  .rpt-brand .n{font-weight:500;color:var(--ink);font-size:15px}.rpt-brand .s{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--faint)}
  .rpt-title{font-weight:500;font-size:34px;letter-spacing:-.03em;line-height:1.08;margin:0;color:var(--ink);text-wrap:balance}
  .rpt-meta{font-family:var(--font-mono);font-size:12px;color:var(--faint);margin-top:10px}
  @media print{
    @page{margin:18mm 16mm}
    nav,footer,.no-print,.ml-mobile-menu{display:none!important}
    html,body{background:#fff;color:#111}
    .wrap{max-width:100%;padding:0}
    .report{border:0;padding:0;margin:0;background:#fff;box-shadow:none}
    .rpt-head{border-bottom-color:#111;margin-bottom:22px}
    .rpt-brand .n{color:#111}.rpt-brand .s,.rpt-meta{color:#555}
    .rpt-title,.report h1,.report h2,.report h3{color:#0d1a14}
    .report p,.report ol,.report ul{color:#222}
    .cite{color:#0F5E43}
    .report a{color:#0F5E43;text-decoration:none}
    h1,h2,h3,.rpt-head{break-after:avoid;page-break-after:avoid}
    p,li{orphans:3;widows:3}
  }
`;

export function humanReportsPage(baseUrl) {
  const R = HUMAN_PRODUCTS;
  const tierBtn = (key, label, sel) => `<button class="tierbtn${sel ? " sel" : ""}" data-p="${esc(key)}"><div class="nm">${esc(label)}</div><div class="pr">$${(R[key].price / 100).toFixed(0)}</div></button>`;
  const body = `
<div class="wrap">
  <section class="hero">
    <div class="eyebrow">Cited reports · pay per report · no subscription</div>
    <h1>A finished report, <em>not a chat answer.</em></h1>
    <p class="lede">Deep research on any question, due diligence on any public company, a 13F breakdown of any fund, a graded audit of any domain. Grounded in live sources, fully cited, in about two minutes. <b>No account, no subscription.</b> Pay by card, get your report.</p>
    <div class="trust"><span><span class="dot"></span> Every claim cited</span><span><span class="dot"></span> If a report fails, you're auto-refunded</span><span><span class="dot"></span> Secured by Stripe</span><span><span class="dot"></span> PDF + data appendix</span></div>
  </section>
  <section>
    <div class="products">
      <div class="pcard" data-kind="research">
        <div class="k">Deep research</div>
        <h3>Ask a hard question</h3>
        <p>Multiple live web searches, ranked sources, a cited report on whatever you ask.</p>
        <div class="field"><input id="in-research" type="text" placeholder="e.g. How do AI agents pay for APIs in 2026?"></div>
        <div class="tiers">${tierBtn("research", "Standard", true)}${tierBtn("research-pro", "Pro", false)}${tierBtn("research-max", "Max", false)}</div>
        <div class="err" id="err-research"></div>
        <button class="btn btn-primary" style="width:100%;justify-content:center;margin-top:12px" data-buy="research">Get report →</button>
        <div class="note" style="margin-top:10px;"><a href="/tools/research" style="color:var(--muted);">Sample output + API docs →</a></div>
      </div>
      <div class="pcard" data-kind="dossier">
        <div class="k">Due-diligence dossier</div>
        <h3>Everything on a public company</h3>
        <p>SEC filings, insider filings, financials and red flags - cited. Data a chatbot can't reach.</p>
        <div class="field"><input id="in-dossier" type="text" placeholder="A US ticker, e.g. AAPL" style="text-transform:uppercase"></div>
        <div class="tiers">${tierBtn("dossier", "Dossier", true)}${tierBtn("dossier-max", "Max", false)}</div>
        <div class="err" id="err-dossier"></div>
        <button class="btn btn-primary" style="width:100%;justify-content:center;margin-top:12px" data-buy="dossier">Get dossier →</button>
        <div class="note" style="margin-top:10px;"><a href="/tools/dossier" style="color:var(--muted);">Sample output + API docs →</a></div>
      </div>
      <div class="pcard" data-kind="fund">
        <div class="k">Fund tracker</div>
        <h3>Follow the smart money</h3>
        <p>What a fund holds, and what it bought, added, trimmed and exited last quarter, from SEC 13F filings, cited.</p>
        <div class="field"><input id="in-fund" type="text" placeholder="A fund, e.g. Berkshire Hathaway"></div>
        <div class="tiers">${tierBtn("fund-report", "Standard", true)}${tierBtn("fund-report-max", "Deep", false)}</div>
        <div class="err" id="err-fund"></div>
        <button class="btn btn-primary" style="width:100%;justify-content:center;margin-top:12px" data-buy="fund">Get report →</button>
        <div class="note" style="margin-top:10px;"><a href="/tools/fund-report" style="color:var(--muted);">Sample output + API docs →</a></div>
      </div>
      <div class="pcard" data-kind="insider">
        <div class="k">Insider flow</div>
        <h3>Who's buying, who's selling</h3>
        <p>Every Form 4 against a company with the actual transactions parsed: open-market buys and sales by insider, awards and exercises set apart, a grounded signal read. SEC EDGAR, cited.</p>
        <div class="field"><input id="in-insider" type="text" placeholder="A US ticker, e.g. AAPL" style="text-transform:uppercase"></div>
        <div class="tiers">${tierBtn("insider-report", "Report", true)}</div>
        <div class="err" id="err-insider"></div>
        <button class="btn btn-primary" style="width:100%;justify-content:center;margin-top:12px" data-buy="insider">Get report →</button>
        <div class="note" style="margin-top:10px;"><a href="/tools/insider-report" style="color:var(--muted);">Sample output + API docs →</a></div>
      </div>
      <div class="pcard" data-kind="market">
        <div class="k">Market / competitor brief</div>
        <h3>Who's in the market, and how they differ</h3>
        <p>Market at a glance, the key players and pricing, recent moves, differentiation, risks and a bottom line. Live web research with citations, nothing from memory.</p>
        <div class="field"><input id="in-market" type="text" placeholder="A market, category or company, e.g. AI agent payment rails"></div>
        <div class="tiers">${tierBtn("market-brief", "Brief", true)}</div>
        <div class="err" id="err-market"></div>
        <button class="btn btn-primary" style="width:100%;justify-content:center;margin-top:12px" data-buy="market">Get brief →</button>
        <div class="note" style="margin-top:10px;"><a href="/tools/market-brief" style="color:var(--muted);">Sample output + API docs →</a></div>
      </div>
      <div class="pcard" data-kind="recall">
        <div class="k">FDA recall report</div>
        <h3>Is it recalled?</h3>
        <p>Every FDA drug, food and device recall record for a product, brand or ingredient: firm, class, reason, status, distribution. Organized and explained, cited to the FDA feeds.</p>
        <div class="field"><input id="in-recall" type="text" placeholder="A drug, food, brand or device, e.g. losartan"></div>
        <div class="tiers">${tierBtn("recall-report", "Report", true)}</div>
        <div class="err" id="err-recall"></div>
        <button class="btn btn-primary" style="width:100%;justify-content:center;margin-top:12px" data-buy="recall">Get report →</button>
        <div class="note" style="margin-top:10px;"><a href="/tools/recall-report" style="color:var(--muted);">Sample output + API docs →</a></div>
      </div>
      <div class="pcard" data-kind="domain">
        <div class="k">Domain audit</div>
        <h3>Is your domain secure?</h3>
        <p>SPF, DMARC, DKIM, TLS and security headers, one graded report with the exact fixes. Why your mail hits spam, answered.</p>
        <div class="field"><input id="in-domain" type="text" placeholder="A domain, e.g. example.com"></div>
        <div class="tiers">${tierBtn("domain-audit", "Standard", true)}${tierBtn("domain-audit-pro", "Pro", false)}</div>
        <div class="err" id="err-domain"></div>
        <button class="btn btn-primary" style="width:100%;justify-content:center;margin-top:12px" data-buy="domain">Get audit →</button>
        <div class="note" style="margin-top:10px;"><a href="/tools/domain-audit" style="color:var(--muted);">Sample output + API docs →</a></div>
      </div>
    </div>
    <p class="note">One-time charge · card or Link · no subscription, no auto-renew · agents buy the same reports over x402 / MPP in USDC · want it re-run on change? <a href="/monitors" style="color:var(--ink);">Monitors</a></p>
  </section>
</div>
${ledgerFooterCompact()}
<script src="/js/reports.js"></script>`;
  return ledgerShell({
    title: "Agent402 Reports: research, dossiers, 13F, insider flow, audits",
    description: "Cited reports by card or USDC, $3 to $19: deep research, company dossier, fund 13F, insider flow, market brief, FDA recall, domain audit. No account, refunded if it fails.",
    canonical: `${baseUrl}/reports`, baseUrl, activePath: "/reports", extraCss: REPORTS_CSS, body,
    jsonLd: { "@context": "https://schema.org", "@type": "ItemList", "@id": `${baseUrl}/reports#products`, name: "Agent402 reports", itemListElement: Object.entries(R).map(([key, p], i) => ({ "@type": "ListItem", position: i + 1, item: { "@type": "Product", name: p.label, url: `${baseUrl}/reports`, brand: { "@type": "Brand", name: "Agent402" }, offers: { "@type": "Offer", price: (p.price / 100).toFixed(2), priceCurrency: "USD", availability: "https://schema.org/InStock", url: `${baseUrl}/reports`, seller: { "@type": "Organization", name: "Havok Holdings LLC" } } } })) },
  });
}

// Delivery page: polls /api/r/:id (or `api`) and renders the report client-side.
export function reportDeliveryPage(sessionId, { api = "/api/r/", waitCopy = "This takes about a minute. Please keep this page open - it will appear here automatically.", baseUrl = "https://agent402.tools", robots = "noindex, nofollow" } = {}) {
  const body = `
<div class="wrap" style="padding-top:28px;">
  <div id="app" data-session="${esc(sessionId)}" data-api="${esc(api)}"><div class="status"><h2><span class="spin"></span>Preparing your report…</h2><p>${esc(waitCopy)}</p></div></div>
  <p class="note no-print">Your report is yours to keep - bookmark this page or use the link we emailed you.</p>
</div>
${ledgerFooterCompact()}
<script src="/js/report-view.js"></script>`;
  return ledgerShell({
    title: "Your report - Agent402",
    description: "Your Agent402 report.",
    canonical: `${baseUrl}/reports`, baseUrl, activePath: "/reports", extraCss: REPORTS_CSS, body, robots,
  });
}
