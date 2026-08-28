// /company - who operates the service, what it sells, where the proof is,
// and how to reach the right mailbox. The maintainer is always the company,
// never a person (house rule), and every claim links to the surface that
// shows it.
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";
import { HUMAN_PRODUCTS } from "./human-checkout.js";
import { MONITOR_PRODUCTS } from "./stripe-subscriptions.js";

const usd0 = (cents) => `$${(cents / 100).toFixed(0)}`;

export function companyPage(baseUrl) {
  const canonical = `${baseUrl}/company`;
  const cardCents = Object.values(HUMAN_PRODUCTS).map((p) => Number(p.price)).filter((n) => n > 0);
  const lo = cardCents.length ? Math.min(...cardCents) : 200, hi = cardCents.length ? Math.max(...cardCents) : 500;
  const mon = Object.values(MONITOR_PRODUCTS).map((p) => Number(p.price)).filter((n) => n > 0);
  const monUsd = mon.length ? usd0(Math.min(...mon)) : "$5";
  const title = "Havok Holdings LLC";
  const description = `Agent402.Tools is built and operated by Havok Holdings LLC: per-call tools and metered models for AI agents over x402 and MPP, finished reports (${usd0(lo)} to ${usd0(hi)}) and monitors (${monUsd} a month) for people by card, and a pay-per-crawl gate for site owners. Proof, security and contact.`;
  const row = (h, body, links = []) => `
<section style="max-width:1180px;margin:0 auto;padding:40px 30px 0;">
  <div class="co-2col" style="display:grid;grid-template-columns:220px 1fr;gap:30px;padding-bottom:36px;border-bottom:1px solid var(--hairline);">
    <h2 style="font-family:var(--font-mono);font-size:13px;color:var(--accent);font-weight:600;margin:4px 0 0;">${esc(h)}</h2>
    <div><p style="font-size:16px;line-height:1.65;color:var(--muted);max-width:820px;margin:0 0 14px;">${body}</p>
    <div style="display:flex;gap:18px;flex-wrap:wrap;">${links.map(([href, label]) => `<a href="${esc(href)}" style="font-family:var(--font-mono);font-size:13px;color:var(--ink);text-decoration:none;border-bottom:1px solid var(--ink);padding-bottom:1px;">${esc(label)} →</a>`).join("")}</div></div>
  </div>
</section>`;
  const body = `
<header style="border-bottom:1px solid var(--hairline);">
  <div style="max-width:1180px;margin:0 auto;padding:52px 30px 44px;">
    <nav aria-label="Breadcrumb" style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin-bottom:22px;"><a href="/" style="color:var(--muted);text-decoration:none;">agent402</a> / <span style="color:var(--ink);">company</span></nav>
    <h1 style="font-weight:800;font-size:46px;line-height:.98;letter-spacing:-.035em;margin:0 0 18px;color:var(--ink);max-width:900px;">Havok Holdings LLC.</h1>
    <p style="font-size:18px;line-height:1.55;color:var(--muted);max-width:820px;margin:0;">Agent402.Tools is built and operated by Havok Holdings LLC, a North Carolina company. We run the hosted service at agent402.tools, publish the server under AGPL-3.0 and the client packages under MIT, and settle every paid call on public rails.</p>
  </div>
</header>
${row("What we sell", `Per-call tools and metered models to AI agents, paid in USDC over x402 and MPP or with a prepaid card key. Finished, cited reports (${esc(usd0(lo))} to ${esc(usd0(hi))}) and monitors (${esc(monUsd)} a month) to people, by card. A pay-per-crawl gate, the tollbooth, to site owners who want to charge crawlers and agents for their content.`, [["/reports", "Reports"], ["/pricing", "Pricing"], ["/tollbooth", "Tollbooth"]])}
${row("Proof", `Uptime from two outside observers at /status. Every settled transaction by rail and wire at /revenue. Metered receipts against their quotes at /proof. Material disclosures with on-chain receipts at /transparency. All of it is computed from observations and ledgers, none of it is typed by hand.`, [["/status", "Status"], ["/revenue", "Transactions"], ["/proof", "Receipts"], ["/transparency", "Disclosures"]])}
${row("Security", `Non-custodial by design, open source end to end, with vulnerability disclosure, safe harbor, the data inventory and the controls in the serving path and on the code stated on one page.`, [["/security", "Security"], ["/privacy", "Privacy"], ["/terms", "Terms"]])}
${row("Contact", `General: <a href="mailto:hello@agent402.tools" style="color:var(--ink);">hello@agent402.tools</a>. Security: <a href="mailto:security@agent402.tools" style="color:var(--ink);">security@agent402.tools</a>. Legal and abuse: <a href="mailto:legal@agent402.tools" style="color:var(--ink);">legal@agent402.tools</a>. Investors and partnerships: <a href="mailto:invest@agent402.tools" style="color:var(--ink);">invest@agent402.tools</a>.`, [["/contact", "Contact page"], ["https://github.com/MikeyPetrillo/Agent402", "Source"]])}
${ledgerFooterCompact()}`;
  const extraCss = `@media (max-width:900px){.co-2col{grid-template-columns:minmax(0,1fr)!important}}`;
  const jsonLd = [
    { "@type": "Organization", "@id": `${baseUrl}/#org`, name: "Havok Holdings LLC", url: baseUrl, brand: { "@type": "Brand", name: "Agent402.Tools" }, contactPoint: [{ "@type": "ContactPoint", contactType: "customer support", email: "hello@agent402.tools" }, { "@type": "ContactPoint", contactType: "security", email: "security@agent402.tools" }] },
    { "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Agent402", item: `${baseUrl}/` }, { "@type": "ListItem", position: 2, name: "Company", item: canonical }] },
  ];
  return ledgerShell({ title, description, canonical, baseUrl, activePath: "/company", extraCss, jsonLd, body });
}
