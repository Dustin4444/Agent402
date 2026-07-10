// /stellar — the Stellar x402 marketplace page. Pure renderer over the
// existing index snapshot + stellarRail() receipts; no state of its own.
// Honesty rules (spec): never invent receipts, say plainly when Agent402 is
// the only listed seller. Listing for external sellers is automatic — the
// index crawler picks up any origin whose 402s advertise a stellar network.
import { ledgerShell, ledgerFooterCompact } from "./ledger-chrome.js";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const usd = (n) => `$${Number(n).toFixed(Number(n) < 0.01 ? 3 : 2).replace(/\.?0+$/, (m) => (m.includes(".") ? "" : m))}`;

const isStellarNet = (n) => typeof n === "string" && n.startsWith("stellar");

/** Sellers with a Stellar rail: the local catalog always qualifies (every
 *  local tool's 402 offers stellar:pubnet); remote sellers qualify when their
 *  crawled 402s advertise a stellar network. */
export function stellarSellers(snapshot) {
  return (snapshot?.sellers || []).filter((s) => s.local === true || (s.networks || []).some(isStellarNet));
}

/** Tools purchasable over Stellar. Remote snapshot entries carry no per-tool
 *  list, so this is the local catalog; external sellers render seller-level. */
export function stellarTools(snapshot) {
  const local = (snapshot?.sellers || []).find((s) => s.local === true);
  return local?.tools || [];
}

function categoryGroups(tools, { maxCategories = 12, maxPerCategory = 6 } = {}) {
  const byCat = new Map();
  for (const t of tools) {
    if (!byCat.has(t.category)) byCat.set(t.category, []);
    byCat.get(t.category).push(t);
  }
  return [...byCat.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, maxCategories)
    .map(([category, list]) => ({ category, shown: list.slice(0, maxPerCategory), more: Math.max(0, list.length - maxPerCategory) }));
}

export function stellarPage(baseUrl, { snapshot, rail }) {
  const sellers = stellarSellers(snapshot);
  const tools = stellarTools(snapshot);
  const prices = tools.map((t) => Number(t.price)).filter((n) => Number.isFinite(n) && n > 0);
  const low = prices.length ? Math.min(...prices) : 0.001;
  const high = prices.length ? Math.max(...prices) : 0.5;
  const groups = categoryGroups(tools);
  const latest = rail?.recent?.[0] || null;

  const receiptHtml = latest
    ? `<p style="margin:8px 0 0;">Latest settlement: <strong>${usd(latest.usd)} USDC</strong> · <a href="${esc(latest.tx)}" rel="noopener">on-chain receipt</a>${latest.when ? ` · ${esc(latest.when)}` : ""}</p>`
    : `<p style="margin:8px 0 0;color:var(--muted);">live receipts temporarily unavailable — settlements remain verifiable at <a href="https://stellar.expert/explorer/public/account/GDNJXCKW7ZM7GEEVP674TWPU26YJNBQ2FI4ZIPRKTPTNUEJMDHFJWWRL" rel="noopener">stellar.expert</a></p>`;

  const groupsHtml = groups.map((g) => `
    <div style="border:1px solid var(--hairline);padding:14px 16px;">
      <h3 style="margin:0 0 8px;font-size:14px;">${esc(g.category)}</h3>
      ${g.shown.map((t) => `<div style="display:flex;justify-content:space-between;gap:12px;font-size:13.5px;padding:3px 0;"><a href="/tools/${esc(t.slug)}" style="color:var(--ink);text-decoration:none;">${esc(t.name)}</a><span style="color:var(--muted);font-family:var(--font-mono);">${usd(t.price)}</span></div>`).join("")}
      ${g.more ? `<div style="font-size:12px;color:var(--faint);margin-top:6px;">+ ${g.more} more in <a href="/tools" style="color:var(--muted);">the full catalog</a></div>` : ""}
    </div>`).join("");

  const sellersHtml = sellers.map((s) => `
    <div style="display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid var(--hairline);font-size:14px;">
      <span><a href="${esc(s.homepage)}" rel="noopener" style="color:var(--ink);">${esc(s.displayName)}</a>${s.local ? ' <span style="color:var(--faint);font-size:12px;">(this host)</span>' : ""}</span>
      <span style="color:var(--muted);font-family:var(--font-mono);">${s.toolCount || 0} tools</span>
    </div>`).join("");

  const honesty = sellers.length === 1
    ? `<p style="color:var(--muted);font-size:13.5px;">1 seller live — discovery is open, and external sellers are added automatically when their x402 challenges advertise a Stellar network.</p>`
    : "";

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "The Stellar x402 marketplace",
    url: `${baseUrl}/stellar`,
    description: `Pay-per-call tools for AI agents, settled in USDC on Stellar via the x402 protocol. ${tools.length} tools live.`,
    mainEntity: {
      "@type": "OfferCatalog",
      name: "Stellar-payable agent tools",
      numberOfItems: tools.length,
      itemListElement: { "@type": "AggregateOffer", priceCurrency: "USD", lowPrice: String(low), highPrice: String(high), offerCount: tools.length },
    },
  };

  const body = `
<div style="max-width:960px;margin:0 auto;padding:32px 20px;">
  <h1 style="font-size:28px;margin:0 0 6px;">The Stellar x402 marketplace</h1>
  <p style="font-size:16px;color:var(--muted);margin:0;">Pay-per-call tools for AI agents — settled in USDC on Stellar in ~5 seconds, no signup, no API keys. The wallet is the account.</p>
  ${receiptHtml}
  <p style="font-size:13px;color:var(--faint);margin:4px 0 0;">A paid canary buys tools over the Stellar rail daily (facilitator: OpenZeppelin) — uptime proven with real settlements, not pings.</p>

  <h2 style="font-size:20px;margin:32px 0 12px;">Browse Stellar-payable tools</h2>
  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px;">${groupsHtml}</div>
  <p style="font-family:var(--font-mono);font-size:13px;background:#e3dac3;padding:10px 14px;margin:16px 0 0;">agents: GET ${esc(baseUrl)}/api/route?q=&lt;task&gt;&amp;network=stellar</p>

  <h2 style="font-size:20px;margin:32px 0 12px;">Sellers settling on Stellar</h2>
  ${sellersHtml}
  ${honesty}

  <h2 style="font-size:20px;margin:32px 0 12px;">Sell on Stellar</h2>
  <p style="font-size:14.5px;line-height:1.65;">Accept x402 payments with a <code>stellar:pubnet</code> accept in your 402 challenge — the <a href="https://developers.stellar.org/docs/build/agentic-payments/x402/built-on-stellar" rel="noopener">Built on Stellar facilitator</a> (OpenZeppelin) verifies and settles, gas sponsored. Use <a href="https://www.npmjs.com/package/@x402/stellar" rel="noopener"><code>@x402/stellar</code></a> for the wire, or <a href="/tollbooth"><code>agent402-tollbooth</code></a> to paywall an existing site. Then serve <code>/.well-known/x402</code> — the index crawler lists you automatically; ranking is health-based, listing is free. Want a guaranteed crawl? <a href="https://github.com/MikeyPetrillo/Agent402/issues" rel="noopener">Open a seed request</a>.</p>

  <p style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin-top:28px;">machine-readable: <a href="/api/route">/api/route</a> · <a href="/.well-known/x402">/.well-known/x402</a> · <a href="/openapi.json">/openapi.json</a> · <a href="/api/reliability">/api/reliability</a></p>
</div>
${ledgerFooterCompact()}`;

  return ledgerShell({
    title: "The Stellar x402 marketplace — pay-per-call tools for AI agents",
    description: `The Stellar x402 marketplace: ${tools.length} pay-per-call tools for AI agents, settled in USDC on Stellar. No signup, no API keys — the wallet is the account.`,
    canonical: `${baseUrl}/stellar`,
    baseUrl,
    activePath: "/stellar",
    jsonLd,
    body,
  });
}
