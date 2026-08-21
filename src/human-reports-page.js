// Served pages for the human front door: the checkout page (/reports) and the
// report-delivery page (/r/:sessionId). Same "Citation" identity as the mockup.
import { HUMAN_PRODUCTS } from "./human-checkout.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const HEAD = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;1,6..72,400&family=Public+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap">
<style>
  :root{--paper:#F4F6F4;--surface:#fff;--surface-2:#FBFCFB;--ink:#14201B;--ink-soft:#35443C;--muted:#5D675F;--faint:#8A948C;--hair:#DBE2DC;--hair-strong:#C6D0C8;--accent:#15654A;--accent-hover:#0F5038;--accent-tint:#E1F0E7;--on-accent:#fff;color-scheme:light}
  @media(prefers-color-scheme:dark){:root{--paper:#0E1512;--surface:#141C18;--surface-2:#101815;--ink:#E8EDE9;--ink-soft:#C4CEC7;--muted:#93A099;--faint:#6A766E;--hair:#26312B;--hair-strong:#33413A;--accent:#45B78E;--accent-hover:#58C79F;--accent-tint:#16362A;--on-accent:#08130E;color-scheme:dark}}
  *{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:"Public Sans",system-ui,sans-serif;font-size:17px;line-height:1.6;-webkit-font-smoothing:antialiased}
  .wrap{max-width:940px;margin:0 auto;padding:0 26px}
  h1,h2,h3{font-family:"Newsreader",Georgia,serif;font-weight:500;line-height:1.14;margin:0;letter-spacing:-.01em;text-wrap:balance}
  a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
  .eyebrow{font-family:"JetBrains Mono",monospace;font-size:11.5px;font-weight:500;letter-spacing:.16em;text-transform:uppercase;color:var(--accent)}
  header.bar{border-bottom:1px solid var(--hair);background:var(--surface-2)}
  .bar-in{display:flex;align-items:center;justify-content:space-between;height:60px}
  .brand{font-family:"JetBrains Mono",monospace;font-weight:600}.brand .n{color:var(--accent)}.brand .s{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted)}
  .btn{font-family:"Public Sans",sans-serif;font-size:15px;font-weight:600;border-radius:8px;border:1px solid transparent;cursor:pointer;padding:11px 18px;transition:background .15s;display:inline-flex;gap:8px;align-items:center;text-decoration:none}
  .btn-primary{background:var(--accent);color:var(--on-accent)}.btn-primary:hover{background:var(--accent-hover);color:var(--on-accent)}
  .btn-ghost{background:transparent;color:var(--ink);border-color:var(--hair-strong)}.btn-ghost:hover{border-color:var(--accent);color:var(--accent)}
  .btn:disabled{opacity:.5;cursor:default}
  .hero{padding:54px 0 20px}.hero h1{font-size:clamp(32px,5vw,48px)}.hero h1 em{font-style:italic;color:var(--accent)}
  .lede{font-size:19px;color:var(--ink-soft);max-width:600px;margin:16px 0 0}.lede b{color:var(--ink)}
  section{padding:26px 0}
  .products{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:8px}
  @media(max-width:720px){.products{grid-template-columns:1fr}}
  .pcard{border:1px solid var(--hair-strong);border-radius:14px;background:var(--surface);padding:22px}
  .pcard h3{font-size:21px}.pcard .k{font-family:"JetBrains Mono",monospace;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);margin-bottom:8px}
  .pcard p{color:var(--muted);font-size:15px;margin:8px 0 16px}
  .field{display:flex;gap:8px;background:var(--surface-2);border:1.5px solid var(--hair-strong);border-radius:11px;padding:6px 6px 6px 14px;margin-bottom:12px}
  .field:focus-within{border-color:var(--accent)}
  .field input{flex:1;border:0;background:transparent;color:var(--ink);font-family:"Public Sans",sans-serif;font-size:16px;outline:none;min-width:0}
  .tiers{display:flex;gap:8px;flex-wrap:wrap}
  .tierbtn{flex:1;min-width:90px;border:1px solid var(--hair-strong);border-radius:9px;background:var(--surface);padding:10px;cursor:pointer;text-align:center;font-family:"Public Sans"}
  .tierbtn .nm{font-family:"JetBrains Mono",monospace;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
  .tierbtn .pr{font-family:"Newsreader",serif;font-size:22px;color:var(--ink);margin-top:2px}
  .tierbtn.sel{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}.tierbtn.sel .pr{color:var(--accent)}
  .note{font-family:"JetBrains Mono",monospace;font-size:11px;color:var(--faint);margin-top:14px}
  .err{color:#a5322b;font-size:14px;margin-top:8px;min-height:18px}
  .trust{display:flex;gap:20px;flex-wrap:wrap;color:var(--muted);font-size:14px;margin-top:8px}
  .trust span{display:inline-flex;gap:7px;align-items:center}.dot{width:5px;height:5px;border-radius:50%;background:var(--accent)}
  footer{border-top:1px solid var(--hair);padding:26px 0 42px;color:var(--muted);font-size:13px;margin-top:30px}
  /* report page */
  .report{background:var(--surface);border:1px solid var(--hair);border-radius:14px;padding:30px 34px;margin-top:24px}
  .report h1{font-size:28px;margin-bottom:6px}.report h2{font-size:22px;margin:26px 0 8px}.report h3{font-size:18px;margin:20px 0 6px}
  .report p{color:var(--ink-soft);margin:0 0 14px}.report a{word-break:break-word}
  .report ol,.report ul{color:var(--ink-soft)}
  .cite{font-family:"JetBrains Mono",monospace;font-size:.72em;font-weight:600;color:var(--accent);vertical-align:super}
  .spin{display:inline-block;width:16px;height:16px;border:2px solid var(--hair-strong);border-top-color:var(--accent);border-radius:50%;animation:sp .8s linear infinite;vertical-align:-3px;margin-right:8px}
  @keyframes sp{to{transform:rotate(360deg)}}
  .status{background:var(--surface);border:1px solid var(--hair);border-radius:14px;padding:40px 34px;text-align:center;margin-top:24px}
  .status h2{font-size:24px;margin-bottom:10px}.status p{color:var(--muted);max-width:440px;margin:0 auto}
  .report-actions{display:flex;gap:12px;align-items:center;margin:20px 0 4px;flex-wrap:wrap}
  .keep-hint{color:var(--muted);font-size:13px;margin-top:2px}
  /* report letterhead (screen + print) */
  .rpt-head{border-bottom:2px solid var(--accent);padding-bottom:18px;margin-bottom:26px}
  .rpt-brand{display:flex;align-items:baseline;gap:9px;font-family:"JetBrains Mono",monospace;margin-bottom:14px}
  .rpt-brand .n{font-weight:600;color:var(--accent);font-size:15px}
  .rpt-brand .s{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--muted)}
  .rpt-title{font-size:30px;line-height:1.12;margin:0}
  .rpt-meta{font-family:"JetBrains Mono",monospace;font-size:12px;letter-spacing:.04em;color:var(--muted);margin-top:9px}
  .report h1{border-bottom:1px solid var(--hair);padding-bottom:6px}
  @media print{
    @page{margin:18mm 16mm}
    .bar,footer,.no-print{display:none!important}
    html,body{background:#fff;color:#111}
    .wrap{max-width:100%;padding:0}
    .report{border:0;padding:0;margin:0;background:#fff}
    .rpt-head{border-bottom-color:#15654a;margin-bottom:22px}
    .rpt-brand .n{color:#15654a}.rpt-brand .s,.rpt-meta{color:#555}
    .rpt-title,.report h1,.report h2,.report h3{color:#0d1a14}
    .report h1{border-bottom-color:#ccc}
    .report p,.report ol,.report ul{color:#222}
    .cite{color:#15654a}
    .report a{color:#15654a;text-decoration:none}
    h1,h2,h3,.rpt-head{break-after:avoid;page-break-after:avoid}
    p,li{orphans:3;widows:3}
  }
</style>`;

function bar() {
  return `<header class="bar"><div class="wrap bar-in"><a class="brand" href="/reports"><span class="n">agent402</span> <span class="s">Reports</span></a><a class="btn btn-ghost" href="/">Home</a></div></header>`;
}

export function humanReportsPage(baseUrl) {
  const R = HUMAN_PRODUCTS;
  return `<!doctype html><html lang="en"><head><title>Agent402 Reports</title>${HEAD}</head><body>
${bar()}
<main class="wrap">
  <section class="hero">
    <div class="eyebrow">Cited reports · pay per report · no subscription</div>
    <h1>Reports you can <em>act</em> on.</h1>
    <p class="lede">Deep research on any question, or due diligence on any public company — grounded in real sources, fully cited, in about two minutes. <b>No account, no subscription.</b> Pay by card, get your report.</p>
    <div class="trust"><span><span class="dot"></span> Every claim cited</span><span><span class="dot"></span> If a report fails, you're auto-refunded</span><span><span class="dot"></span> Secured by Stripe</span></div>
  </section>
  <section>
    <div class="products">
      <div class="pcard" data-kind="research">
        <div class="k">Deep research</div>
        <h3>Ask a hard question</h3>
        <p>Multiple live web searches, ranked sources, a cited report on whatever you ask.</p>
        <div class="field"><input id="in-research" type="text" placeholder="e.g. How do AI agents pay for APIs in 2026?"></div>
        <div class="tiers">
          <button class="tierbtn sel" data-p="research"><div class="nm">Standard</div><div class="pr">$5</div></button>
          <button class="tierbtn" data-p="research-pro"><div class="nm">Pro</div><div class="pr">$15</div></button>
          <button class="tierbtn" data-p="research-max"><div class="nm">Max</div><div class="pr">$30</div></button>
        </div>
        <div class="err" id="err-research"></div>
        <button class="btn btn-primary" style="width:100%;justify-content:center;margin-top:12px" data-buy="research">Get report →</button>
      </div>
      <div class="pcard" data-kind="dossier">
        <div class="k">Due-diligence dossier</div>
        <h3>Everything on a public company</h3>
        <p>SEC filings, insider trades, financials, and red flags — cited. Data a chatbot can't reach.</p>
        <div class="field"><input id="in-dossier" type="text" placeholder="A US ticker, e.g. AAPL" style="text-transform:uppercase"></div>
        <div class="tiers">
          <button class="tierbtn sel" data-p="dossier"><div class="nm">Dossier</div><div class="pr">$19</div></button>
          <button class="tierbtn" data-p="dossier-max"><div class="nm">Max</div><div class="pr">$39</div></button>
        </div>
        <div class="err" id="err-dossier"></div>
        <button class="btn btn-primary" style="width:100%;justify-content:center;margin-top:12px" data-buy="dossier">Get dossier →</button>
      </div>
    </div>
    <p class="note">One-time charge · card or Link · no subscription, no auto-renew · agents can also buy these over x402 in USDC</p>
  </section>
</main>
<footer><div class="wrap">Agent402 · grounded, cited reports · pay per report</div></footer>
<script src="/js/reports.js"></script>
</body></html>`;
}

// Delivery page: polls /api/r/:id and renders the report (client-side markdown).
export function reportDeliveryPage(sessionId) {
  return `<!doctype html><html lang="en"><head><title>Your report — Agent402</title>${HEAD}</head><body>
${bar()}
<main class="wrap">
  <div id="app" data-session="${esc(sessionId)}"><div class="status"><h2><span class="spin"></span>Preparing your report…</h2><p>This takes about a minute. Please keep this page open — it will appear here automatically.</p></div></div>
</main>
<footer><div class="wrap">Agent402 · your report is yours to keep — copy or bookmark this page</div></footer>
<script src="/js/report-view.js"></script>
</body></html>`;
}
