// Served pages for the monitoring subscriptions (Phase 2): the /monitors
// storefront and the /monitors/thanks confirmation. Same visual language as the
// one-shot reports storefront. External JS (site CSP drops inline script).
import { MONITOR_PRODUCTS } from "./stripe-subscriptions.js";

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
  .hero{padding:54px 0 18px}.hero h1{font-size:clamp(32px,5vw,46px)}.hero h1 em{font-style:italic;color:var(--accent)}
  .lede{font-size:19px;color:var(--ink-soft);max-width:600px;margin:16px 0 0}.lede b{color:var(--ink)}
  section{padding:26px 0}
  .products{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:18px;margin-top:8px}
  .pcard{border:1px solid var(--hair-strong);border-radius:14px;background:var(--surface);padding:22px}
  .pcard h3{font-size:21px}.pcard .k{font-family:"JetBrains Mono",monospace;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);margin-bottom:8px}
  .pcard .pr{font-family:"Newsreader",serif;font-size:26px;color:var(--accent);margin:2px 0 8px}.pcard .pr small{font-family:"JetBrains Mono";font-size:12px;color:var(--muted);letter-spacing:.04em}
  .pcard p{color:var(--muted);font-size:15px;margin:8px 0 16px}
  .field{display:flex;gap:8px;background:var(--surface-2);border:1.5px solid var(--hair-strong);border-radius:11px;padding:6px 6px 6px 14px;margin-bottom:12px}
  .field:focus-within{border-color:var(--accent)}
  .field input{flex:1;border:0;background:transparent;color:var(--ink);font-family:"Public Sans",sans-serif;font-size:16px;outline:none;min-width:0}
  .err{color:#a5322b;font-size:14px;margin-top:8px;min-height:18px}
  .note{font-family:"JetBrains Mono",monospace;font-size:11px;color:var(--faint);margin-top:14px}
  .status{background:var(--surface);border:1px solid var(--hair);border-radius:14px;padding:40px 34px;text-align:center;margin-top:24px}
  .status h2{font-size:24px;margin-bottom:10px}.status p{color:var(--muted);max-width:460px;margin:0 auto 8px}
  .spin{display:inline-block;width:16px;height:16px;border:2px solid var(--hair-strong);border-top-color:var(--accent);border-radius:50%;animation:sp .8s linear infinite;vertical-align:-3px;margin-right:8px}@keyframes sp{to{transform:rotate(360deg)}}
  footer{border-top:1px solid var(--hair);padding:26px 0 42px;color:var(--muted);font-size:13px;margin-top:30px}
</style>`;

function bar() {
  return `<header class="bar"><div class="wrap bar-in"><a class="brand" href="/monitors"><span class="n">agent402</span> <span class="s">Monitors</span></a><a class="btn btn-ghost" href="/reports">One-off reports</a></div></header>`;
}

export function monitorsPage() {
  const cards = Object.entries(MONITOR_PRODUCTS).map(([key, p]) => `
    <div class="pcard" data-product="${esc(key)}">
      <div class="k">${esc(p.kind)} monitor</div>
      <h3>${esc(p.label)}</h3>
      <div class="pr">$${(p.price / 100).toFixed(0)}<small> / month</small></div>
      <p>${esc(p.blurb)}</p>
      <div class="field"><input id="in-${esc(key)}" type="text" placeholder="${esc(p.inputLabel)}"></div>
      <div class="err" id="err-${esc(key)}"></div>
      <button class="btn btn-primary" style="width:100%;justify-content:center" data-sub="${esc(key)}">Subscribe →</button>
    </div>`).join("");
  return `<!doctype html><html lang="en"><head><title>Agent402 Monitors</title>${HEAD}</head><body>
${bar()}
<main class="wrap">
  <section class="hero">
    <div class="eyebrow">Recurring monitoring · cancel anytime</div>
    <h1>Set it once. We <em>watch</em> it for you.</h1>
    <p class="lede">Standing reports that re-run on their own and alert you the moment something changes. <b>No account</b> beyond your card, self-serve cancel any time.</p>
  </section>
  <section>
    <div class="products">${cards}</div>
    <p class="note">Monthly subscription · card via Stripe · cancel anytime from the link on your receipt · agents can also subscribe over x402</p>
  </section>
</main>
<footer><div class="wrap">Agent402 · recurring monitoring · cancel anytime</div></footer>
<script src="/js/monitors.js"></script>
</body></html>`;
}

export function monitorThanksPage(sessionId) {
  return `<!doctype html><html lang="en"><head><title>Subscription active - Agent402</title>${HEAD}</head><body>
${bar()}
<main class="wrap">
  <div id="app" data-session="${esc(sessionId)}"><div class="status"><h2><span class="spin"></span>Confirming your subscription…</h2><p>One moment.</p></div></div>
</main>
<footer><div class="wrap">Agent402 · recurring monitoring</div></footer>
<script src="/js/monitor-thanks.js"></script>
</body></html>`;
}
