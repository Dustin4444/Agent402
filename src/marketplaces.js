// /marketplaces — the infrastructure hub. Reframes Agent402 from "a tool
// seller" to the marketplace LAYER for x402: the cross-chain, cross-seller
// discovery + routing infrastructure. No new backend — it composes what already
// exists (the 8 per-chain marketplaces, the open Index, the Smart Order Router,
// the on-chain leaderboard) into one story, with a seller onramp and a buyer
// onramp. Every number is live (passed in by the route), never hardcoded.
import { ledgerShell, ledgerFooterFull, esc } from "./ledger-chrome.js";
import { CHAIN_PAGES } from "./market-page.js";
import { chainMark, CHAIN_ORDER } from "./chain-logos.js";
import { RAILS_AMP } from "./rails.js";

const fmtNum = (n) => Number(n || 0).toLocaleString("en-US");

// A dark "surface" card (stays dark in both themes via the --surface/--on-dark
// tokens) for the three infrastructure pillars.
function pillar({ tag, title, body, href, cta, stat }) {
  return `<a href="${esc(href)}" style="display:flex;flex-direction:column;gap:10px;background:var(--surface);color:var(--on-dark);border:1px solid var(--hairline);padding:22px 22px 20px;text-decoration:none;">
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;">
      <span style="font-family:var(--font-mono);font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--accent);">${esc(tag)}</span>
      ${stat ? `<span style="font-family:var(--font-mono);font-size:12px;color:var(--dk-muted2);">${esc(stat)}</span>` : ""}
    </div>
    <div style="font-family:var(--font-body);font-weight:800;font-size:26px;line-height:1.02;letter-spacing:-.02em;">${esc(title)}</div>
    <div style="font-size:14px;line-height:1.5;color:var(--dk-muted2);flex:1;">${body}</div>
    <div style="font-family:var(--font-mono);font-size:12.5px;color:var(--on-dark);border-bottom:1.5px solid var(--accent);align-self:flex-start;padding-bottom:1px;margin-top:4px;">${esc(cta)} →</div>
  </a>`;
}

export function marketplacesPage(baseUrl, { chainSellerCounts = {}, indexSnapshot, leaderboardSnap, toolCount = 0, settlements = 0 } = {}) {
  const chainCount = Object.keys(CHAIN_PAGES).length;
  const sellerCount = Number.isFinite(indexSnapshot?.totals?.sellers) ? indexSnapshot.totals.sellers : null;
  const board = Array.isArray(leaderboardSnap?.leaderboard) ? leaderboardSnap.leaderboard : [];

  // Per-chain marketplace cards — logo + name + live seller count + link.
  const chainCard = ([slug, name]) => {
    const cfg = CHAIN_PAGES[slug];
    if (!cfg) return "";
    const n = chainSellerCounts[slug];
    const known = Number.isFinite(n);
    const sub = known ? `${fmtNum(n)} seller${n === 1 ? "" : "s"}` : "indexed live";
    return `<a href="/${slug}" style="display:flex;align-items:center;gap:12px;border:1px solid var(--hairline);background:var(--card);padding:14px 16px;text-decoration:none;color:var(--ink);">
      <span style="flex:0 0 auto;color:var(--ink);display:flex;">${chainMark(slug, 24)}</span>
      <span style="min-width:0;">
        <span style="display:block;font-weight:700;font-size:15px;line-height:1;">${esc(name)}</span>
        <span style="display:block;font-family:var(--font-mono);font-size:11.5px;color:var(--faint);margin-top:4px;">${esc(cfg.asset)} · ${esc(sub)}</span>
      </span>
    </a>`;
  };

  const stat = (n, l) => `<div style="flex:1 1 auto;padding:11px 16px 10px 0;margin-right:16px;border-right:1px dashed var(--dash);"><div style="font-family:var(--font-mono);font-weight:700;font-size:21px;line-height:1;font-variant-numeric:tabular-nums;">${n}</div><div style="font-family:var(--font-mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin-top:5px;">${l}</div></div>`;

  const lbRow = (r, i) => `<div style="display:grid;grid-template-columns:24px 1fr auto;gap:12px;padding:9px 0;border-bottom:${i < 2 ? "1px dashed var(--dash)" : "none"};font-size:14px;align-items:baseline;"><span style="font-family:var(--font-mono);color:${i === 0 ? "var(--accent)" : "var(--faint)"};">${String(i + 1).padStart(2, "0")}</span><span style="font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(r.name)}</span><span style="font-family:var(--font-mono);color:var(--muted);">$${Number(r.totalUsd || 0).toFixed(2)}</span></div>`;

  const title = "x402 Marketplaces - the discovery + routing layer for the agent economy";
  const description = `The marketplace infrastructure for x402: ${chainCount} per-chain marketplaces, an open cross-seller index, a Smart Order Router, and an on-chain leaderboard. Discover and route across every x402 seller on every chain - ${RAILS_AMP}.`;

  const body = `
  <!-- HERO -->
  <header style="border-bottom:1px solid var(--hairline);background:var(--paper);">
    <div style="max-width:1180px;margin:0 auto;padding:60px 30px 44px;">
      <div style="font-family:var(--font-mono);font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:var(--accent);margin-bottom:18px;">Agent402 · marketplace infrastructure</div>
      <h1 style="font-family:var(--font-body);font-weight:800;font-size:62px;line-height:.96;letter-spacing:-.035em;margin:0 0 18px;color:var(--ink);max-width:900px;">The marketplace layer<br>for <span style="color:var(--accent);">x402</span>.</h1>
      <p style="font-size:18px;line-height:1.55;color:var(--muted);max-width:640px;margin:0 0 26px;">Not one more seller - the infrastructure the whole economy plugs into. Discover and route across <strong style="color:var(--ink);">every x402 seller, on every chain</strong>. ${chainCount} rails, one open index, one router, one on-chain leaderboard.</p>
      <div class="ml-stats" style="display:flex;flex-wrap:wrap;align-items:flex-end;max-width:760px;">
        ${stat(chainCount, "chains")}
        ${stat(sellerCount != null ? fmtNum(sellerCount) : "live", "sellers indexed")}
        ${stat(fmtNum(toolCount), "tools")}
        ${stat(fmtNum(settlements), "settlements")}
      </div>
    </div>
  </header>

  <!-- BY CHAIN -->
  <section style="max-width:1180px;margin:0 auto;padding:56px 30px 0;">
    <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:16px 20px;flex-wrap:wrap;margin-bottom:16px;">
      <h2 style="font-family:var(--font-body);font-weight:800;font-size:34px;letter-spacing:-.02em;margin:0;">A marketplace on every chain.</h2>
      <span style="font-family:var(--font-mono);font-size:12.5px;color:var(--faint);">${chainCount} rails · same index, filtered per chain</span>
    </div>
    <div class="mkts-grid" style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;">
      ${CHAIN_ORDER.map(chainCard).join("")}
    </div>
  </section>

  <!-- THREE PILLARS -->
  <section style="max-width:1180px;margin:0 auto;padding:56px 30px 0;">
    <h2 style="font-family:var(--font-body);font-weight:800;font-size:34px;letter-spacing:-.02em;margin:0 0 16px;">One index. One router. One ledger.</h2>
    <div class="mkts-pillars" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;">
      ${pillar({ tag: "the index", title: "The live directory", body: "The full, sortable directory behind this hub: every x402 seller across every chain, ranked by health and on-chain revenue - crawled from <code style=\"color:var(--on-dark);\">/.well-known/x402</code>, not just Agent402's catalog. This is the data; the hub is the map.", href: "/index", cta: "Open the directory", stat: sellerCount != null ? `${fmtNum(sellerCount)} seller${sellerCount === 1 ? "" : "s"}` : null })}
      ${pillar({ tag: "the router", title: "Route to the best tool", body: "The Smart Order Router resolves a task to the best-priced, healthiest tool across every seller and chain, then pays and returns the result. One call, best execution.", href: "/index#router", cta: "How routing works", stat: "GET /api/route" })}
      ${pillar({ tag: "the leaderboard", title: "Ranked by real volume", body: "Every seller ranked by on-chain USDC settled - read straight off the chain, not vanity metrics. Listing is free; ranking is earned.", href: "/leaderboard", cta: "See the leaderboard", stat: board.length ? `top: ${esc(board[0].name)}` : null })}
    </div>
    ${board.length ? `<div style="border:1px solid var(--hairline);background:var(--card);padding:16px 20px;margin-top:12px;">
      <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin-bottom:8px;">Top sellers · by USDC settled</div>
      ${board.slice(0, 3).map(lbRow).join("")}
    </div>` : ""}
  </section>

  <!-- TWO ONRAMPS -->
  <section style="max-width:1180px;margin:0 auto;padding:56px 30px 70px;">
    <div class="mkts-onramps" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
      <div style="border:1px solid var(--hairline);background:var(--paper);padding:26px 24px;">
        <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--accent);margin-bottom:10px;">For sellers</div>
        <div style="font-family:var(--font-body);font-weight:800;font-size:26px;letter-spacing:-.02em;margin-bottom:8px;">List your API</div>
        <p style="font-size:14.5px;line-height:1.5;color:var(--muted);margin:0 0 16px;">Serve an x402 endpoint and get discovered across all ${chainCount} chains, in the router, and on the leaderboard. Free, no account, 0% take on your settlements.</p>
        <a href="/sell" style="display:inline-block;background:var(--surface);color:var(--on-dark);font-family:var(--font-mono);font-weight:700;font-size:13px;text-decoration:none;padding:11px 18px;">Start selling →</a>
      </div>
      <div style="border:1px solid var(--hairline);background:var(--paper);padding:26px 24px;">
        <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--accent);margin-bottom:10px;">For agents</div>
        <div style="font-family:var(--font-body);font-weight:800;font-size:26px;letter-spacing:-.02em;margin-bottom:8px;">Route your agent</div>
        <p style="font-size:14.5px;line-height:1.5;color:var(--muted);margin:0 0 16px;">Find and pay for any tool with one call - the router picks the best across every seller, pays on ${chainCount} chains, and hands back the result. Free tier via proof-of-work.</p>
        <a href="/quickstart" style="display:inline-block;background:var(--accent);color:var(--on-accent);font-family:var(--font-mono);font-weight:700;font-size:13px;text-decoration:none;padding:11px 18px;">QUICKSTART →</a>
      </div>
    </div>
  </section>`;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "x402 Marketplaces",
    description,
    url: `${baseUrl}/marketplaces`,
    isPartOf: { "@type": "WebSite", name: "Agent402.Tools", url: baseUrl },
  };

  return ledgerShell({
    title, description, canonical: `${baseUrl}/marketplaces`, baseUrl, activePath: "/marketplaces", jsonLd,
    extraCss: `@media (max-width:900px){.mkts-grid{grid-template-columns:repeat(2,1fr) !important}.mkts-pillars{grid-template-columns:1fr !important}.mkts-onramps{grid-template-columns:1fr !important}}@media (max-width:600px){.mkts-grid{grid-template-columns:1fr !important}}`,
    body: body + ledgerFooterFull(),
  });
}
