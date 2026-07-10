// /stellar — the Stellar x402 marketplace page. Pure renderer over the
// existing index snapshot + stellarRail() receipts; no state of its own.
// Honesty rules (spec): never invent receipts, say plainly when Agent402 is
// the only listed seller. Listing for external sellers is automatic — the
// index crawler picks up any origin whose 402s advertise a stellar network.
import { ledgerShell, ledgerFooterCompact } from "./ledger-chrome.js";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// Crawled manifests are third-party input: only http(s) may become an href.
const safeHref = (u) => (/^https?:\/\//i.test(String(u || "")) ? esc(u) : "#");
const usd = (n) => `$${Number(n).toFixed(Number(n) < 0.01 ? 3 : 2).replace(/\.?0+$/, (m) => (m.includes(".") ? "" : m))}`;

const isStellarNet = (n) => typeof n === "string" && n.startsWith("stellar") && !n.includes("test");

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

// Activity section — x402scan-style Transactions / Volume / Buyers cards with
// per-day bars, fed by revenue-live's stellarActivity() scan. Same honesty
// rules as the receipts: no data → say so plainly, capped scan → "a floor".
export function stellarActivityHtml(activity, selected) {
  const external = !!(selected && !selected.local && selected.host);
  const scopeLabel = external ? esc(String(selected.host).toUpperCase()) : "THIS HOST";
  if (!activity || activity.error || !Array.isArray(activity.buckets) || !activity.buckets.length) {
    const why = external
      ? "activity unavailable for this seller — no Stellar payTo advertised in its 402s, or the scan failed"
      : "activity scan temporarily unavailable";
    return `
  <h2 id="activity" style="font-size:21px;font-weight:800;margin:40px 0 14px;border-bottom:1.5px solid var(--ink);padding-bottom:8px;">Activity</h2>
  <p style="color:var(--muted);font-size:13.5px;margin:0;">${why} — settlements remain independently verifiable on stellar.expert</p>`;
  }
  const bars = (key) => {
    const max = Math.max(...activity.buckets.map((b) => Number(b[key]) || 0));
    return `<div style="display:flex;align-items:flex-end;gap:2px;height:46px;margin-top:12px;">${activity.buckets
      .map((b) => {
        const v = Number(b[key]) || 0;
        const h = max > 0 && v > 0 ? Math.max(3, Math.round((v / max) * 46)) : 2;
        const label = key === "usd" ? usd(v) : v;
        return `<div title="${esc(b.date)}: ${esc(label)}" style="flex:1;height:${h}px;background:${v > 0 ? "var(--accent)" : "#E4E4E2"};"></div>`;
      })
      .join("")}</div>`;
  };
  const card = (label, value, key) => `
    <div style="border:1.5px solid var(--ink);background:var(--card);padding:14px 16px;">
      <div style="font-family:var(--font-mono);font-size:11px;color:var(--faint);letter-spacing:.06em;">${label}</div>
      <div style="font-size:26px;font-weight:800;">${value}</div>${bars(key)}
    </div>`;
  const t = activity.totals || {};
  const note = [
    external
      ? "all inbound USDC to this seller's advertised x402 payTo wallet — may include non-x402 transfers"
      : "all inbound USDC settlements to this host's Stellar wallet",
    t.internalTx ? `includes ${t.internalTx} internal canary buy${t.internalTx === 1 ? "" : "s"}` : "",
    activity.truncated ? "scan capped — totals are a floor" : "",
  ].filter(Boolean).join(" · ");
  return `
  <div id="activity" style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap;margin:40px 0 14px;border-bottom:1.5px solid var(--ink);padding-bottom:8px;">
    <h2 style="font-size:21px;font-weight:800;margin:0;">Activity</h2>
    <span style="font-family:var(--font-mono);font-size:11px;color:var(--faint);letter-spacing:.06em;">${scopeLabel} · PAST ${esc(activity.days)} DAYS</span>
  </div>
  <div class="ml-2col" style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;">
    ${card("TRANSACTIONS", Number(t.tx || 0).toLocaleString("en-US"), "tx")}
    ${card("VOLUME", usd(t.usd || 0), "usd")}
    ${card("BUYERS", Number(t.buyers || 0).toLocaleString("en-US"), "buyers")}
  </div>
  <p style="font-family:var(--font-mono);font-size:11.5px;color:var(--faint);margin:8px 0 0;">${note}</p>`;
}

export function stellarPage(baseUrl, { snapshot, rail, activity, selectedSeller, stellarWallet = "GDNJXCKW7ZM7GEEVP674TWPU26YJNBQ2FI4ZIPRKTPTNUEJMDHFJWWRL" }) {
  const sellers = stellarSellers(snapshot);
  const tools = stellarTools(snapshot);
  const prices = tools.map((t) => Number(t.price)).filter((n) => Number.isFinite(n) && n > 0);
  const low = prices.length ? Math.min(...prices) : 0.001;
  const high = prices.length ? Math.max(...prices) : 0.5;
  const groups = categoryGroups(tools);
  const latest = rail?.recent?.[0] || null;

  const receiptHtml = latest
    ? `<p style="margin:8px 0 0;">Latest settlement: <strong>${usd(latest.usd)} USDC</strong> · <a href="${esc(latest.tx)}" rel="noopener">on-chain receipt</a>${latest.when ? ` · ${esc(latest.when)}` : ""}</p>`
    : `<p style="margin:8px 0 0;color:var(--muted);">live receipts temporarily unavailable — settlements remain verifiable at <a href="https://stellar.expert/explorer/public/account/${esc(stellarWallet)}" rel="noopener">stellar.expert</a></p>`;

  const groupsHtml = groups.map((g) => `
    <div style="border:1px solid var(--hairline);padding:14px 16px;">
      <h3 style="margin:0 0 8px;font-size:14px;">${esc(g.category)}</h3>
      ${g.shown.map((t) => `<div style="display:flex;justify-content:space-between;gap:12px;font-size:13.5px;padding:3px 0;"><a href="/tools/${esc(t.slug)}" style="color:var(--ink);text-decoration:none;">${esc(t.name)}</a><span style="color:var(--muted);font-family:var(--font-mono);">${usd(t.price)}</span></div>`).join("")}
      ${g.more ? `<div style="font-size:12px;color:var(--faint);margin-top:6px;">+ ${g.more} more in <a href="/tools" style="color:var(--muted);">the full catalog</a></div>` : ""}
    </div>`).join("");

  const hostOf = (u) => { try { return new URL(u).host; } catch { return ""; } };
  // Which seller's activity is on screen: default is this host; an external
  // pick highlights that seller and re-scopes the Activity section.
  const selHost = selectedSeller && !selectedSeller.local ? String(selectedSeller.host || "").toLowerCase() : null;
  const isSelected = (s) => (selHost ? !s.local && hostOf(s.homepage).toLowerCase() === selHost : !!s.local);
  const activityHref = (s) => (s.local ? "/stellar#activity" : `/stellar?seller=${encodeURIComponent(hostOf(s.homepage).toLowerCase())}#activity`);
  // Cards read well up to a dozen sellers; past that, compact rows keep the
  // roster scannable at any size.
  const compact = sellers.length > 12;
  const sellersHtml = compact
    ? sellers.map((s) => {
        const good = s.local || s.routable;
        return `
    <a href="${activityHref(s)}" style="display:grid;grid-template-columns:1fr auto auto auto;gap:14px;align-items:center;padding:9px 14px;border:${isSelected(s) ? "2px solid var(--accent)" : "1px solid var(--hairline)"};background:var(--card);color:var(--ink);text-decoration:none;">
      <span style="font-weight:700;font-size:14px;">${esc(s.displayName)}${s.local ? ' <span style="background:var(--accent);color:var(--cream);font-family:var(--font-mono);font-size:10px;font-weight:700;padding:1px 5px;">THIS HOST</span>' : ""}</span>
      <span style="font-family:var(--font-mono);font-size:12px;color:var(--faint);">${esc(hostOf(s.homepage))}</span>
      <span style="color:var(--muted);font-family:var(--font-mono);font-size:12.5px;">${s.toolCount || 0} tools</span>
      <span style="display:inline-flex;align-items:center;gap:6px;color:${good ? "var(--green)" : "var(--accent)"};font-family:var(--font-mono);font-size:12px;"><span style="width:7px;height:7px;border-radius:50%;background:${good ? "var(--green)" : "var(--accent)"};"></span>${s.local ? "live" : (s.routable ? "healthy" : "unreachable")}</span>
    </a>`;
      }).join("")
    : sellers.map((s) => {
        const health = s.local ? "live" : (s.routable ? "healthy" : "unreachable");
        const good = s.local || s.routable;
        return `
    <div style="border:${isSelected(s) ? "2px solid var(--accent)" : "1.5px solid var(--ink)"};background:var(--card);padding:16px 18px;display:flex;flex-direction:column;gap:6px;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;">
        <a href="${safeHref(s.homepage)}" rel="noopener" style="color:var(--ink);text-decoration:none;font-weight:700;font-size:15px;">${esc(s.displayName)}</a>
        ${s.local ? '<span style="background:var(--accent);color:var(--cream);font-family:var(--font-mono);font-size:10px;font-weight:700;padding:2px 6px;">THIS HOST</span>' : ""}
      </div>
      <div style="font-family:var(--font-mono);font-size:12px;color:var(--faint);">${esc(hostOf(s.homepage))}</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px;">
        <span style="color:var(--muted);font-family:var(--font-mono);font-size:13px;">${s.toolCount || 0} tools</span>
        <span style="display:inline-flex;align-items:center;gap:6px;color:${good ? "var(--green)" : "var(--accent)"};font-family:var(--font-mono);font-size:12px;"><span style="width:7px;height:7px;border-radius:50%;background:${good ? "var(--green)" : "var(--accent)"};"></span>${health}</span>
      </div>
      <a href="${activityHref(s)}" style="font-family:var(--font-mono);font-size:12px;color:var(--accent);text-decoration:none;margin-top:2px;">${isSelected(s) ? "activity shown above" : "view activity →"}</a>
    </div>`;
      }).join("");

  const statsHtml = `
  <div class="ml-2col" style="display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:26px 0 0;">
    <div style="border:1.5px solid var(--ink);background:var(--card);padding:14px 16px;"><div style="font-family:var(--font-mono);font-size:11px;color:var(--faint);letter-spacing:.06em;">SELLERS</div><div style="font-size:26px;font-weight:800;">${sellers.length}</div></div>
    <div style="border:1.5px solid var(--ink);background:var(--card);padding:14px 16px;"><div style="font-family:var(--font-mono);font-size:11px;color:var(--faint);letter-spacing:.06em;">TOOLS (THIS HOST)</div><div style="font-size:26px;font-weight:800;">${tools.length.toLocaleString("en-US")}</div></div>
    <div style="border:1.5px solid var(--ink);background:var(--card);padding:14px 16px;"><div style="font-family:var(--font-mono);font-size:11px;color:var(--faint);letter-spacing:.06em;">LATEST SETTLE</div><div style="font-size:26px;font-weight:800;">${latest ? usd(latest.usd) : "—"}</div></div>
    <div style="border:1.5px solid var(--ink);background:var(--card);padding:14px 16px;"><div style="font-family:var(--font-mono);font-size:11px;color:var(--faint);letter-spacing:.06em;">PRICE FLOOR</div><div style="font-size:26px;font-weight:800;">${usd(low)}</div></div>
  </div>`;

  const honesty = sellers.length === 1 && sellers[0]?.local
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

  const formHtml = `
  <div id="list-api" style="border:1.5px solid var(--ink);background:var(--card);padding:18px 20px;margin-top:16px;max-width:640px;">
    <div style="font-weight:800;font-size:15px;margin-bottom:8px;">List your API</div>
    <div style="display:flex;gap:10px;">
      <input id="reg-origin" type="url" placeholder="https://api.yourdomain.com" style="flex:1;font-family:var(--font-mono);font-size:13px;padding:9px 12px;border:1.5px solid var(--ink);background:var(--paper);color:var(--ink);">
      <button id="reg-go" style="background:var(--ink);color:var(--cream);font-family:var(--font-mono);font-weight:700;font-size:13px;border:none;padding:9px 16px;cursor:pointer;">SUBMIT</button>
    </div>
    <div id="reg-out" style="font-family:var(--font-mono);font-size:12.5px;color:var(--muted);margin-top:8px;">Free, no account — we probe your origin's x402 surface and list you if it answers. Ranking is health-based.</div>
  </div>
  <script>
  document.getElementById("reg-go").addEventListener("click", async () => {
    const out = document.getElementById("reg-out");
    out.textContent = "probing…";
    try {
      const r = await fetch("/api/index/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ origin: document.getElementById("reg-origin").value }) });
      const j = await r.json();
      out.textContent = j.listed ? ("Listed — " + (j.seller?.displayName || j.origin) + " (" + (j.seller?.toolCount || 0) + " tools). Stellar sellers appear on this page; all sellers appear on /index.") : ("Not listed: " + (j.error || "unknown error"));
    } catch { out.textContent = "submission failed — try again"; }
  });
  </script>`;

  const body = `
<div style="max-width:1080px;margin:0 auto;padding:36px 24px;">
  <h1 style="font-size:34px;font-weight:800;letter-spacing:-.02em;margin:0 0 8px;">The Stellar x402 marketplace</h1>
  <p style="font-size:16.5px;color:var(--muted);margin:0;max-width:720px;">Pay-per-call tools for AI agents — settled in USDC on Stellar in ~5 seconds, no signup, no API keys. The wallet is the account.</p>
  ${receiptHtml}
  <p style="font-size:13px;color:var(--faint);margin:4px 0 0;">A paid canary buys tools over the Stellar rail daily (facilitator: OpenZeppelin) — uptime proven with real settlements, not pings.</p>
  ${statsHtml}
  ${stellarActivityHtml(activity, selectedSeller)}

  <h2 style="font-size:21px;font-weight:800;margin:40px 0 14px;border-bottom:1.5px solid var(--ink);padding-bottom:8px;">Sellers settling on Stellar</h2>
  <p style="font-size:13px;color:var(--faint);margin:-6px 0 12px;">pick a seller to scope the activity charts to its on-chain wallet</p>
  ${compact
    ? `<div style="display:flex;flex-direction:column;gap:8px;">${sellersHtml}</div>`
    : `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px;">${sellersHtml}</div>`}
  ${honesty}

  <h2 style="font-size:21px;font-weight:800;margin:40px 0 14px;border-bottom:1.5px solid var(--ink);padding-bottom:8px;">Browse Stellar-payable tools</h2>
  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px;">${groupsHtml}</div>
  <p style="font-family:var(--font-mono);font-size:13px;background:#EDEDEB;padding:10px 14px;margin:16px 0 0;">agents: GET ${esc(baseUrl)}/api/route?q=&lt;task&gt;&amp;network=stellar</p>

  <h2 style="font-size:21px;font-weight:800;margin:40px 0 14px;border-bottom:1.5px solid var(--ink);padding-bottom:8px;">Sell on Stellar</h2>
  <p style="font-size:14.5px;line-height:1.65;">Accept x402 payments with a <code>stellar:pubnet</code> accept in your 402 challenge — the <a href="https://developers.stellar.org/docs/build/agentic-payments/x402/built-on-stellar" rel="noopener">Built on Stellar facilitator</a> (OpenZeppelin) verifies and settles, gas sponsored. Use <a href="https://www.npmjs.com/package/@x402/stellar" rel="noopener"><code>@x402/stellar</code></a> for the wire, or <a href="/tollbooth"><code>agent402-tollbooth</code></a> to paywall an existing site. Then serve <code>/.well-known/x402</code> — the index crawler lists you automatically; ranking is health-based, listing is free. Want a guaranteed crawl? <a href="https://github.com/MikeyPetrillo/Agent402/issues" rel="noopener">Open a seed request</a>.</p>
  ${formHtml}

  <p style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin-top:28px;">machine-readable: <a href="/api/route?q=hash&amp;network=stellar">/api/route?network=stellar</a> · <a href="/.well-known/x402">/.well-known/x402</a> · <a href="/openapi.json">/openapi.json</a> · <a href="/api/reliability">/api/reliability</a></p>
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
