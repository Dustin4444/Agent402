// Served pages for the monitoring subscriptions (Phase 2): the /monitors
// storefront and the /monitors/thanks confirmation. Rendered through the
// shared ledger shell (2026-08-22 redesign); shares REPORTS_CSS with the
// one-shot reports pages. External JS (site CSP drops inline script).
import { MONITOR_PRODUCTS } from "./stripe-subscriptions.js";
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";
import { REPORTS_CSS } from "./human-reports-page.js";

export function monitorsPage(baseUrl = "https://agent402.tools") {
  const cards = Object.entries(MONITOR_PRODUCTS).map(([key, p]) => `
    <div class="pcard" data-product="${esc(key)}">
      <div class="k">${esc(p.kind)} monitor</div>
      <h3>${esc(p.label)}</h3>
      <div style="font-family:var(--font-mono);font-size:22px;color:var(--ink);margin:6px 0 8px;">$${(p.price / 100).toFixed(0)}<span style="font-size:12px;color:var(--faint);letter-spacing:.04em;"> / month</span></div>
      <p>${esc(p.blurb)}</p>
      <div class="field"><input id="in-${esc(key)}" type="text" placeholder="${esc(p.inputLabel)}"></div>
      <div class="err" id="err-${esc(key)}"></div>
      <button class="btn btn-primary" style="width:100%;justify-content:center" data-sub="${esc(key)}">Subscribe →</button>
    </div>`).join("");
  const body = `
<div class="wrap">
  <section class="hero">
    <div class="eyebrow">Recurring monitoring · cancel anytime</div>
    <h1>Set it once. <em>We watch it for you.</em></h1>
    <p class="lede">Standing reports that re-run on their own and email you the moment something changes. <b>No account</b> beyond your card, self-serve cancel any time.</p>
  </section>
  <section>
    <div class="products">${cards}</div>
    <p class="note">Monthly subscription · card via Stripe · cancel anytime from the link in your email · one-off reports at <a href="/reports" style="color:var(--ink);">/reports</a></p>
  </section>
</div>
${ledgerFooterCompact()}
<script src="/js/monitors.js"></script>`;
  return ledgerShell({
    title: "Agent402 Monitors: domain, 13F, recall, insider, IPO watch",
    description: "$5 a month monitors: domain security, fund 13F, FDA recall, insider flow, IPO pipeline. Re-run on their own, emailed on change, card via Stripe, cancel anytime.",
    canonical: `${baseUrl}/monitors`, baseUrl, activePath: "/monitors", extraCss: REPORTS_CSS, body,
    jsonLd: { "@context": "https://schema.org", "@type": "ItemList", "@id": `${baseUrl}/monitors#products`, name: "Agent402 monitors", itemListElement: Object.entries(MONITOR_PRODUCTS).map(([key, p], i) => ({ "@type": "ListItem", position: i + 1, item: { "@type": "Product", name: p.label, description: p.blurb, url: `${baseUrl}/monitors`, brand: { "@type": "Brand", name: "Agent402" }, offers: { "@type": "Offer", url: `${baseUrl}/monitors`, priceCurrency: "USD", price: (p.price / 100).toFixed(2), priceSpecification: { "@type": "UnitPriceSpecification", price: (p.price / 100).toFixed(2), priceCurrency: "USD", billingDuration: "P1M" }, availability: "https://schema.org/InStock", seller: { "@type": "Organization", name: "Havok Holdings LLC" } } } })) },
  });
}

export function monitorThanksPage(sessionId, baseUrl = "https://agent402.tools") {
  const body = `
<div class="wrap" style="padding-top:28px;">
  <div id="app" data-session="${esc(sessionId)}"><div class="status"><h2><span class="spin"></span>Confirming your subscription…</h2><p>One moment.</p></div></div>
</div>
${ledgerFooterCompact()}
<script src="/js/monitor-thanks.js"></script>`;
  return ledgerShell({
    title: "Subscription active - Agent402",
    description: "Your Agent402 monitor is being confirmed.",
    canonical: `${baseUrl}/monitors`, baseUrl, activePath: "/monitors", extraCss: REPORTS_CSS, body, robots: "noindex, nofollow",
  });
}
