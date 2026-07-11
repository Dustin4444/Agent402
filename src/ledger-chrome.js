import { RAILS_AMP, RAILS_OS, RAILS_TICKER } from "./rails.js";
// Machine Ledger design system — shared chrome for the Agent402 marketing site.
// Exports the status line, nav, footers (full + compact), settlement tape,
// design-token CSS, and a ledgerShell() wrapper that composes a full HTML page.
//
// Pages import ledgerShell() and one of the footer functions, then pass their
// body HTML to get a complete document with SEO metadata and shared chrome.

export const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---------------------------------------------------------------------------
// Head links: Google Fonts + favicons
// Browsers cache favicons in a separate, long-lived store keyed by URL — bump
// the ?v= literal whenever the logo art changes or old marks linger for weeks.
// ---------------------------------------------------------------------------

export const LEDGER_HEAD = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800;900&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<link rel="icon" type="image/svg+xml" href="/favicon.svg?v=3">
<link rel="icon" type="image/png" sizes="512x512" href="/favicon.ico?v=3">
<link rel="shortcut icon" href="/favicon.ico?v=3">
<link rel="apple-touch-icon" href="/logo.png?v=2">`;

// ---------------------------------------------------------------------------
// Design-token CSS + base reset + keyframes + shared chrome styles
// ---------------------------------------------------------------------------

export const LEDGER_CSS = `
:root {
  --accent: #D63C1A;
  --paper: #FFFFFF;
  --card: #F7F7F5;
  --card-zebra: #F1F1EF;
  --footer-bg: #F2F2F0;
  --ink: #0B0B0B;
  --ink-panel: #151515;
  --ink-tape: #0B0B0B;
  --muted: #4A4A4A;
  --faint: #8C8C8C;
  --hairline: #E0E0DE;
  --dash: #C9C9C7;
  --dark-border: #262626;
  --dark-border2: #343434;
  --cream: #FFFFFF;
  --cream2: #F5F5F5;
  --dk-muted: #9C9C9C;
  --dk-muted2: #B8B8B8;
  --dk-muted3: #7C7C7C;
  --green: #3E9B6E;
  --font-body: 'Archivo', system-ui, sans-serif;
  --font-mono: 'Space Mono', monospace;
}
/* Dark theme. Light-surface tokens flip together: because a solid chip is
   background:var(--ink) with color:var(--cream), flipping --ink light AND
   --cream dark turns all ~100 of them into clean inverted (light-on-dark)
   buttons automatically. The always-dark surfaces (tape, code panels via
   --ink-tape / --ink-panel / --dk-muted*) intentionally stay dark. Set from
   localStorage (or prefers-color-scheme) before first paint - see ledgerShell. */
:root[data-theme="dark"] {
  --accent: #F0522E;
  --paper: #0E0E10;
  --card: #171719;
  --card-zebra: #1E1E21;
  --footer-bg: #131315;
  --ink: #ECECEA;
  --muted: #9E9E98;
  --faint: #6C6C68;
  --hairline: #2A2A30;
  --dash: #35353B;
  --cream: #0E0E10;
  --cream2: #171719;
  --ink-tape: #050506;
  --ink-panel: #171719;
}
:root { color-scheme: light; }
:root[data-theme="dark"] { color-scheme: dark; }
body { transition: background-color .18s ease, color .18s ease; }
.ml-theme-toggle { display:inline-flex; align-items:center; justify-content:center; width:34px; height:34px; padding:0; border:1.5px solid var(--ink); background:transparent; color:var(--ink); cursor:pointer; }
.ml-theme-toggle:hover { background: var(--card-zebra); }
.ml-theme-toggle .ml-sun { display:none; }
:root[data-theme="dark"] .ml-theme-toggle .ml-moon { display:none; }
:root[data-theme="dark"] .ml-theme-toggle .ml-sun { display:inline-flex; }
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { background: var(--paper); font-family: var(--font-body); color: var(--ink); -webkit-font-smoothing: antialiased; }
::selection { background: #d63c1a33; }
a { color: inherit; }

/* --- nav dropdowns (CSS-only, zero-JS safe) --- */
.mlnav-g { position: relative; }
.mlnav-g > .mlnav-dd { display: none; position: absolute; top: 100%; left: -18px; padding-top: 13px; z-index: 60; }
.mlnav-g:hover > .mlnav-dd, .mlnav-g:focus-within > .mlnav-dd { display: block; }
.mlnav-row:hover { background: var(--card-zebra); }
@media (max-width: 600px) { .mlnav-g > .mlnav-dd { display: none !important; } }

/* --- keyframes --- */
@keyframes ml-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .25; } }
@keyframes ml-tape  { from { transform: translateX(0); } to { transform: translateX(-50%); } }

/* --- responsive --- */
@media (max-width: 900px) {
  .ml-ft-grid { grid-template-columns: repeat(2, 1fr) !important; }
  .ml-hero-grid { grid-template-columns: 1fr !important; }
  .ml-2col { grid-template-columns: 1fr !important; }
  .ml-slip { grid-template-columns: 1fr !important; }
  .ml-slip-cell { border-right: none !important; border-bottom: 1.5px solid var(--ink); }
  .ml-mkts { grid-template-columns: repeat(2, 1fr) !important; }
  .sl-hero { grid-template-columns: 1fr !important; }
  .sl-steps { grid-template-columns: repeat(2, 1fr) !important; }
}
@media (max-width: 600px) {
  .ml-status-in { padding: 8px 16px !important; }
  .ml-status-ticker { display: none !important; }
  .ml-status-left { flex: 1 1 auto; min-width: 0; }
  .ml-nav-in  { padding: 12px 16px !important; gap: 10px !important; }
  .ml-nav-links {
    gap: 12px !important;
    overflow-x: auto !important;
    flex-wrap: nowrap !important;
    min-width: 0;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: thin;
  }
  .ml-nav-links > * { flex: none !important; }
  .ml-nav-gh  { display: none !important; }
  .ml-h1      { font-size: 40px !important; }
  .ml-hero-h1 { font-size: 42px !important; }
  .ml-spec-cell { border-right: none !important; }
  .ml-proof-row { grid-template-columns: 1fr !important; row-gap: 6px !important; }
  .ml-proof-row code { justify-self: start !important; }
  .ml-roster-compact { grid-template-columns: 1fr !important; row-gap: 4px !important; }
  .sl-h1      { font-size: 40px !important; }
  .sl-steps   { grid-template-columns: 1fr !important; }
}

/* --- home hero (settled-calls proof, spec strip, staggered load) --- */
@keyframes ml-ring { 0% { box-shadow: 0 0 0 0 #d63c1a66; } 70% { box-shadow: 0 0 0 7px #d63c1a00; } 100% { box-shadow: 0 0 0 0 #d63c1a00; } }
@keyframes ml-rise { to { opacity: 1; transform: none; } }
.ml-stagger > * { opacity: 0; transform: translateY(8px); animation: ml-rise .6s ease forwards; }
.ml-stagger > *:nth-child(1) { animation-delay: .02s; }
.ml-stagger > *:nth-child(2) { animation-delay: .10s; }
.ml-stagger > *:nth-child(3) { animation-delay: .18s; }
.ml-stagger > *:nth-child(4) { animation-delay: .26s; }
.ml-stagger > *:nth-child(5) { animation-delay: .34s; }
.ml-stagger > *:nth-child(6) { animation-delay: .42s; }
.ml-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); animation: ml-ring 2s infinite; flex: none; }
.ml-cta { transition: transform .12s ease; }
.ml-cta:hover { transform: translateY(-2px); }
.ml-spec-cell:last-child { border-right: none; margin-right: 0; }
.ml-slip-cell:hover { background: var(--card); }
@media (prefers-reduced-motion: reduce) {
  .ml-stagger > * { opacity: 1; transform: none; animation: none; }
  .ml-dot { animation: none; }
}
`;

// ---------------------------------------------------------------------------
// Status line (top of every page)
// ---------------------------------------------------------------------------

function statusLine() {
  return `<div style="background:var(--ink);color:var(--cream);font-family:var(--font-mono);font-size:12px;letter-spacing:.02em;">
  <div class="ml-status-in" style="max-width:1180px;margin:0 auto;padding:8px 30px;display:flex;align-items:center;justify-content:space-between;gap:16px;">
    <span class="ml-status-left" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">HTTP/1.1 <span style="color:var(--accent);font-weight:700;">402</span> PAYMENT REQUIRED</span>
    <span class="ml-status-ticker" style="color:var(--dk-muted);white-space:nowrap;">agent402.base.eth · ${RAILS_TICKER}</span>
  </div>
</div>`;
}

// ---------------------------------------------------------------------------
// Nav (sticky, every page)
// ---------------------------------------------------------------------------

// Three zones: buy's direct links (highest-traffic destinations, no hover
// required) | the two grouped doors (index / sell, each a real link plus a
// CSS-only dropdown) | docs. See design_handoff_x402_ia_redesign/README.md §1.
const NAV_ZONES = [
  [
    { href: "/skills", label: "skill packs" },
    { href: "/tools", label: "catalog" },
    { href: "/pricing", label: "pricing" },
  ],
  [
    { href: "/index", label: "index", panel: "index" },
    { href: "/sell", label: "sell", panel: "sell" },
  ],
  [{ href: "/docs", label: "docs" }],
];

// Fallback by-chain rows used whenever no live index-snapshot data is wired
// (offline unit tests, early boot, a throwing/null provider) — the dropdown
// and footer still get real, crawlable links, just without seller counts.
// All 7 rails have a live market page (/base, /solana, /polygon, /arbitrum,
// /stellar, /algorand, /robinhood) — this fallback must list every one, not
// just the two that got dedicated routes first.
const STATIC_CHAINS = [
  { label: "base", href: "/base" },
  { label: "solana", href: "/solana" },
  { label: "polygon", href: "/polygon" },
  { label: "arbitrum", href: "/arbitrum" },
  { label: "stellar", href: "/stellar" },
  { label: "algorand", href: "/algorand" },
  { label: "robinhood", href: "/robinhood" },
];

// Per-chain seller counts/health for the index dropdown + footer are live
// data (crawler + index snapshot), but nav() renders on every page — including
// offline unit tests with no crawler running. server.js wires a provider once
// real data exists; until then (or if it throws) nav() falls back to
// STATIC_CHAINS so it never crashes and never blocks a page render.
let navDataProvider = null;
export function setNavIndexProvider(fn) { navDataProvider = fn; }

function chainRows() {
  try {
    const data = navDataProvider && navDataProvider();
    if (data && Array.isArray(data.chains) && data.chains.length) {
      // Scale rule: all 7 current rails (RAILS in rails.js) get one row each;
      // past that, top 7 + the ink footer row ("all chains →") carries the
      // rest — so adding an 8th rail doesn't silently drop two existing ones
      // from the dropdown/footer the way a low ceiling here once did.
      const chains = data.chains.length > 9 ? data.chains.slice(0, 7) : data.chains;
      return { chains, live: true };
    }
  } catch { /* provider threw — fall back to the static list below */ }
  return { chains: STATIC_CHAINS, live: false };
}

function chainRowHtml(c, live) {
  if (!live) {
    // No provider data at all — a plain link, never a fabricated count.
    return `<a href="${esc(c.href)}" class="mlnav-row" style="display:block;padding:9px 16px;text-decoration:none;color:var(--ink);font-weight:700;">${esc(c.label)}</a>`;
  }
  const known = typeof c.sellers === "number" && c.healthy !== false;
  if (known) {
    return `<a href="${esc(c.href)}" class="mlnav-row" style="display:flex;justify-content:space-between;gap:12px;padding:9px 16px;text-decoration:none;color:var(--ink);"><span style="font-weight:700;">${esc(c.label)}</span><span style="display:inline-flex;align-items:center;gap:6px;color:var(--green);"><span style="width:7px;height:7px;border-radius:50%;background:var(--green);display:inline-block;"></span>${c.sellers} sellers</span></a>`;
  }
  // Provider returned this chain but its data failed — honesty rule:
  // "unavailable", never zero.
  return `<a href="${esc(c.href)}" class="mlnav-row" style="display:flex;justify-content:space-between;gap:12px;padding:9px 16px;text-decoration:none;color:var(--ink);"><span style="font-weight:700;">${esc(c.label)}</span><span style="display:inline-flex;align-items:center;gap:6px;color:var(--faint);"><span style="width:7px;height:7px;border-radius:50%;background:var(--faint);display:inline-block;"></span>unavailable</span></a>`;
}

function indexPanelHtml(chainInfo) {
  const rows = chainInfo.chains.map((c) => chainRowHtml(c, chainInfo.live)).join("\n                ");
  return `<span class="mlnav-dd">
              <span style="display:block;width:340px;border:1.5px solid var(--ink);background:var(--paper);box-shadow:5px 5px 0 #0b0b0b1f;">
                <span style="display:block;padding:10px 16px 8px;font-size:11px;letter-spacing:.1em;color:var(--faint);border-bottom:1px solid var(--hairline);">THE X402 INDEX - EVERY SELLER, RANKED ON-CHAIN</span>
                <a href="/index" class="mlnav-row" style="display:flex;justify-content:space-between;gap:12px;padding:9px 16px;text-decoration:none;color:var(--ink);"><span style="font-weight:700;">index</span><span style="color:var(--faint);">all sellers · health</span></a>
                <a href="/leaderboard" class="mlnav-row" style="display:flex;justify-content:space-between;gap:12px;padding:9px 16px;text-decoration:none;color:var(--ink);"><span style="font-weight:700;">leaderboard</span><span style="color:var(--faint);">by USDC settled</span></a>
                <span style="display:block;padding:10px 16px 8px;font-size:11px;letter-spacing:.1em;color:var(--faint);border-top:1.5px solid var(--ink);border-bottom:1px solid var(--hairline);">BY CHAIN</span>
                ${rows}
                <a href="/index" style="display:flex;justify-content:space-between;gap:12px;padding:11px 16px;text-decoration:none;background:var(--ink);color:var(--cream);"><span style="font-weight:700;">all chains →</span><span style="color:var(--dk-muted);">/index</span></a>
              </span>
            </span>`;
}

function sellPanelHtml() {
  return `<span class="mlnav-dd">
              <span style="display:block;width:330px;border:1.5px solid var(--ink);background:var(--paper);box-shadow:5px 5px 0 #0b0b0b1f;">
                <span style="display:block;padding:10px 16px 8px;font-size:11px;letter-spacing:.1em;color:var(--faint);border-bottom:1px solid var(--hairline);">FOR API SELLERS - GET PAID PER CALL</span>
                <a href="/sell" class="mlnav-row" style="display:flex;justify-content:space-between;gap:12px;padding:9px 16px;text-decoration:none;color:var(--ink);"><span style="font-weight:700;">list your API</span><span style="color:var(--faint);">free · health-ranked</span></a>
                <a href="/tollbooth" class="mlnav-row" style="display:flex;justify-content:space-between;gap:12px;padding:9px 16px;text-decoration:none;color:var(--ink);"><span style="font-weight:700;">tollbooth</span><span style="color:var(--faint);">pay-per-crawl</span></a>
                <a href="/contribute" class="mlnav-row" style="display:flex;justify-content:space-between;gap:12px;padding:9px 16px;text-decoration:none;color:var(--ink);"><span style="font-weight:700;">contribute a tool</span><span style="color:var(--faint);">MIT · ~15 lines</span></a>
                <a href="/sell" style="display:flex;justify-content:space-between;gap:12px;padding:11px 16px;text-decoration:none;background:var(--ink);color:var(--cream);"><span style="font-weight:700;">start selling →</span><span style="color:var(--dk-muted);">/sell</span></a>
              </span>
            </span>`;
}

const PANEL_HTML = { index: indexPanelHtml, sell: sellPanelHtml };

function directLinkHtml(l, activePath) {
  const active = l.href === activePath;
  const style = active
    ? "color:var(--ink);font-weight:700;text-decoration:none;border-bottom:2px solid var(--accent);padding-bottom:2px;"
    : "color:var(--muted);text-decoration:none;";
  return `<a href="${l.href}" style="${style}">${l.label}</a>`;
}

function groupTriggerHtml(item, active, panelHtml) {
  const style = active
    ? "color:var(--ink);font-weight:700;text-decoration:none;border-bottom:2px solid var(--accent);padding-bottom:2px;"
    : "color:var(--muted);text-decoration:none;";
  return `<span class="mlnav-g" style="display:inline-flex;">
        <a href="${item.href}" style="${style}">${item.label} <span style="font-size:10px;">▾</span></a>
        ${panelHtml}
      </span>`;
}

function nav(activePath) {
  const chainInfo = chainRows();
  const groupHrefs = {
    // /index and /leaderboard are the panel's static rows; the chain
    // hrefs are whatever's live right now — so a future chain page lights up
    // the "index" trigger with zero nav.js edits, per the scale rule.
    // (/economy folded into /index#economy — its row is gone.)
    index: new Set(["/index", "/leaderboard", ...chainInfo.chains.map((c) => c.href)]),
    sell: new Set(["/sell", "/tollbooth", "/tollbooth/cloud", "/contribute"]),
  };

  const zone1 = NAV_ZONES[0].map((l) => directLinkHtml(l, activePath)).join("\n      ");
  const zone2 = NAV_ZONES[1]
    .map((item) => groupTriggerHtml(item, groupHrefs[item.panel].has(activePath), PANEL_HTML[item.panel](chainInfo)))
    .join("\n      ");
  const zone3 = NAV_ZONES[2].map((l) => directLinkHtml(l, activePath)).join("\n      ");
  const divider = `<span style="width:1px;height:15px;background:var(--hairline);flex:none;"></span>`;

  return `<nav style="border-bottom:1.5px solid var(--ink);background:var(--paper);position:sticky;top:0;z-index:50;">
  <div class="ml-nav-in" style="max-width:1180px;margin:0 auto;padding:14px 30px;display:flex;align-items:center;gap:26px;">
    <a href="/" style="display:flex;align-items:center;gap:11px;text-decoration:none;color:var(--ink);">
      <span style="width:32px;height:32px;border:2px solid var(--ink);color:var(--ink);font-family:var(--font-mono);font-weight:700;font-size:13px;display:flex;align-items:center;justify-content:center;">402</span>
      <span style="font-weight:800;font-size:18px;letter-spacing:-.02em;text-transform:uppercase;">Agent402<span style="color:var(--accent);">.</span>Tools</span>
    </a>
    <div class="ml-nav-links" style="display:flex;align-items:center;gap:20px;margin-left:6px;font-family:var(--font-mono);font-size:13px;">
      ${zone1}
      ${divider}
      ${zone2}
      ${divider}
      ${zone3}
    </div>
    <div style="margin-left:auto;display:flex;align-items:center;gap:14px;">
      <a class="ml-nav-gh" href="https://github.com/MikeyPetrillo/Agent402" rel="noopener" style="font-family:var(--font-mono);font-size:13px;color:var(--muted);text-decoration:none;">github</a>
      <button type="button" onclick="a402ToggleTheme()" class="ml-theme-toggle" aria-label="Toggle dark mode" title="Toggle dark mode">
        <svg class="ml-moon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
        <svg class="ml-sun" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
      </button>
      <a href="/docs" style="background:var(--ink);color:var(--cream);font-family:var(--font-mono);font-weight:700;font-size:13px;text-decoration:none;padding:9px 15px;">ADD TO CLAUDE →</a>
    </div>
  </div>
</nav>`;
}

// ---------------------------------------------------------------------------
// Footer — full 5-column (home page)
// ---------------------------------------------------------------------------

export function ledgerFooterFull() {
  const chainInfo = chainRows();
  const chainLinks = chainInfo.chains
    .map((c) => `<a href="${esc(c.href)}" style="color:var(--muted);text-decoration:none;">${esc(c.label.charAt(0).toUpperCase() + c.label.slice(1))} market</a>`)
    .join("");
  return `<footer style="border-top:1.5px solid var(--ink);background:var(--footer-bg);">
  <div style="max-width:1180px;margin:0 auto;padding:48px 30px 32px;">
    <div class="ml-ft-grid" style="display:grid;grid-template-columns:1.3fr 1fr 1fr 1fr 1fr 1fr;gap:24px;">
      <div>
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
          <span style="width:30px;height:30px;border:2px solid var(--ink);color:var(--ink);font-family:var(--font-mono);font-weight:700;font-size:12px;display:flex;align-items:center;justify-content:center;">402</span>
          <span style="font-weight:800;font-size:16px;text-transform:uppercase;letter-spacing:-.02em;">Agent402<span style="color:var(--accent);">.</span>Tools</span>
        </div>
        <p style="font-family:var(--font-mono);font-size:12px;line-height:1.6;color:var(--muted);margin:0;max-width:240px;">The open x402 index - discovery, routing, and on-chain ranking for the agent payments economy.</p>
      </div>
      <div>
        <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin-bottom:12px;">for agents</div>
        <div style="display:flex;flex-direction:column;gap:9px;font-size:14px;"><a href="/skills" style="color:var(--muted);text-decoration:none;">Skill packs</a><a href="/tools" style="color:var(--muted);text-decoration:none;">Tool catalog</a><a href="/tools/category/llm" style="color:var(--muted);text-decoration:none;">LLM gateway</a><a href="/pricing" style="color:var(--muted);text-decoration:none;">Pricing</a><a href="/integrations" style="color:var(--muted);text-decoration:none;">Integrations</a><a href="/playground" style="color:var(--muted);text-decoration:none;">Playground</a></div>
      </div>
      <div>
        <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin-bottom:12px;">x402 index</div>
        <div style="display:flex;flex-direction:column;gap:9px;font-size:14px;"><a href="/index" style="color:var(--muted);text-decoration:none;">Index</a><a href="/leaderboard" style="color:var(--muted);text-decoration:none;">Leaderboard</a><a href="/index#economy" style="color:var(--muted);text-decoration:none;">Economy</a><a href="/revenue" style="color:var(--muted);text-decoration:none;">Revenue</a>${chainLinks}<a href="/index" style="color:var(--muted);text-decoration:none;">Index by chain</a></div>
      </div>
      <div>
        <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin-bottom:12px;">for sellers</div>
        <div style="display:flex;flex-direction:column;gap:9px;font-size:14px;"><a href="/sell" style="color:var(--muted);text-decoration:none;">Start selling</a><a href="/tollbooth" style="color:var(--muted);text-decoration:none;">Tollbooth</a><a href="/contribute" style="color:var(--muted);text-decoration:none;">Contribute a tool</a></div>
      </div>
      <div>
        <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin-bottom:12px;">learn</div>
        <div style="display:flex;flex-direction:column;gap:9px;font-size:14px;"><a href="/docs" style="color:var(--muted);text-decoration:none;">Docs</a><a href="/quickstart" style="color:var(--muted);text-decoration:none;">Quickstart</a><a href="/guides" style="color:var(--muted);text-decoration:none;">Guides</a><a href="/faq" style="color:var(--muted);text-decoration:none;">FAQ</a><a href="/blog" style="color:var(--muted);text-decoration:none;">Blog</a><a href="/changelog" style="color:var(--muted);text-decoration:none;">Changelog</a></div>
      </div>
      <div>
        <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin-bottom:12px;">machine</div>
        <div style="display:flex;flex-direction:column;gap:9px;font-size:14px;"><a href="/openapi.json" style="color:var(--muted);text-decoration:none;">OpenAPI</a><a href="/llms.txt" style="color:var(--muted);text-decoration:none;">llms.txt</a><a href="/docs#add" style="color:var(--muted);text-decoration:none;">MCP connector</a><a href="/api/stats" style="color:var(--muted);text-decoration:none;">Stats</a><a href="/.well-known/x402" style="color:var(--muted);text-decoration:none;">.well-known/x402</a></div>
      </div>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-top:36px;padding-top:18px;border-top:1px solid var(--hairline);font-family:var(--font-mono);font-size:12px;color:var(--faint);">
      <span>© 2026 Havok Holdings LLC · open-source x402 + MCP server · built by <a href="https://github.com/MikeyPetrillo" rel="noopener" style="color:var(--muted);text-decoration:none;">Mike Petrillo</a> · <a href="mailto:mike@agent402.tools" style="color:var(--muted);text-decoration:none;">mike@agent402.tools</a></span>
      <span style="display:flex;gap:16px;"><a href="/privacy" style="color:var(--muted);text-decoration:none;">privacy</a><a href="/terms" style="color:var(--muted);text-decoration:none;">terms</a><a href="/contact" style="color:var(--muted);text-decoration:none;">contact</a><a href="/llms.txt" style="color:var(--muted);text-decoration:none;">llms.txt</a><a href="https://github.com/MikeyPetrillo/Agent402" rel="noopener" style="color:var(--muted);text-decoration:none;">github</a><a href="https://x.com/Agent402Tools" rel="noopener" style="color:var(--muted);text-decoration:none;">𝕏</a></span>
    </div>
  </div>
</footer>`;
}

// ---------------------------------------------------------------------------
// Footer — compact single-row (sub-pages)
// ---------------------------------------------------------------------------

export function ledgerFooterCompact() {
  return `<footer style="border-top:1.5px solid var(--ink);background:var(--footer-bg);">
  <div style="max-width:1180px;margin:0 auto;padding:26px 30px;font-family:var(--font-mono);font-size:12px;color:var(--faint);">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;">
      <span style="display:flex;align-items:center;gap:10px;"><span style="width:24px;height:24px;border:2px solid var(--ink);color:var(--ink);font-weight:700;font-size:10px;display:flex;align-items:center;justify-content:center;">402</span><span style="font-weight:700;">Agent402.Tools</span></span>
      <span style="display:flex;gap:16px;flex-wrap:wrap;"><a href="/tools" style="color:var(--muted);text-decoration:none;">catalog</a><a href="/pricing" style="color:var(--muted);text-decoration:none;">pricing</a><a href="/tools/category/llm" style="color:var(--muted);text-decoration:none;">llm gateway</a><a href="/index" style="color:var(--muted);text-decoration:none;">index</a><a href="/leaderboard" style="color:var(--muted);text-decoration:none;">leaderboard</a><a href="/sell" style="color:var(--muted);text-decoration:none;">sell</a><a href="/docs" style="color:var(--muted);text-decoration:none;">docs</a><a href="/integrations" style="color:var(--muted);text-decoration:none;">integrations</a></span>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-top:12px;padding-top:12px;border-top:1px solid var(--hairline);">
      <span>© 2026 Havok Holdings LLC · built by <a href="https://github.com/MikeyPetrillo" rel="noopener" style="color:var(--muted);text-decoration:none;">Mike Petrillo</a> · <a href="mailto:mike@agent402.tools" style="color:var(--muted);text-decoration:none;">mike@agent402.tools</a></span>
      <span style="display:flex;gap:16px;flex-wrap:wrap;"><a href="/privacy" style="color:var(--muted);text-decoration:none;">privacy</a><a href="/terms" style="color:var(--muted);text-decoration:none;">terms</a><a href="/contact" style="color:var(--muted);text-decoration:none;">contact</a><a href="/llms.txt" style="color:var(--muted);text-decoration:none;">llms.txt</a><a href="https://github.com/MikeyPetrillo/Agent402" rel="noopener" style="color:var(--muted);text-decoration:none;">github</a><a href="https://x.com/Agent402Tools" rel="noopener" style="color:var(--muted);text-decoration:none;">𝕏</a></span>
    </div>
  </div>
</footer>`;
}

// ---------------------------------------------------------------------------
// Settlement tape — scrolling marquee of recent paid calls
// ---------------------------------------------------------------------------

function agoStr(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s | 0}s`;
  if (s < 3600) return `${(s / 60) | 0}m`;
  if (s < 86400) return `${(s / 3600) | 0}h`;
  return `${(s / 86400) | 0}d`;
}

export function ledgerTape(recentCalls) {
  if (!recentCalls || !recentCalls.length) return "";
  const items = recentCalls.slice(0, 12);
  const chip = (r) =>
    `<span>${esc(r.slug)} · <span style="color:#EDEDEB;">${r.paidWith === "proof-of-work" ? "PoW" : "$USDC"}</span> · ${agoStr(r.at)}</span>`;
  const track = items.map(chip).join("");
  return `<div style="background:var(--ink-tape);border-bottom:1.5px solid var(--ink);overflow:hidden;display:flex;align-items:center;">
  <div style="flex:none;padding:11px 18px;font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;color:var(--accent);border-right:1px solid var(--dark-border);">●●● TAPE</div>
  <div style="overflow:hidden;flex:1;">
    <div style="display:flex;gap:30px;width:max-content;animation:ml-tape 40s linear infinite;font-family:var(--font-mono);font-size:12px;color:var(--dk-muted);padding:11px 18px;white-space:nowrap;">${track}${track}</div>
  </div>
</div>`;
}

// ---------------------------------------------------------------------------
// Full HTML document shell
// ---------------------------------------------------------------------------

/**
 * Wraps page content in a complete HTML document with status line, nav,
 * SEO metadata, design-token CSS, and optional page-specific CSS.
 *
 * @param {object} opts
 * @param {string} opts.title       - <title> tag content
 * @param {string} opts.description - meta description
 * @param {string} opts.canonical   - canonical URL
 * @param {string} opts.baseUrl     - base URL for OG image default
 * @param {string} opts.activePath  - nav link to highlight ("" for home)
 * @param {string} [opts.ogImage]   - OG image URL (defaults to baseUrl/card.png)
 * @param {object|object[]} [opts.jsonLd] - JSON-LD structured data
 * @param {string} [opts.extraCss]  - page-specific CSS
 * @param {string} opts.body        - main content HTML (including footer)
 */
// Social crawlers (X, Slack, Discord, …) cache the card image by its exact URL,
// so a fixed /card.png keeps showing a stale tool count long after it changes.
// The server stamps the current count here at boot; the query param makes every
// count change a new image URL, which busts those caches on the next crawl.
let ogImageVersion = "";
export function setOgImageVersion(v) { ogImageVersion = String(v || ""); }
export function ledgerShell({ title, description, canonical, baseUrl, activePath = "", ogImage, jsonLd, extraCss = "", body }) {
  const og = ogImage || (baseUrl + "/card.png" + (ogImageVersion ? `?v=${ogImageVersion}` : ""));
  // Base ecosystem JSON-LD — every page rendered through the ledger shell
  // carries this so crawlers and discovery agents see Base chain support
  // regardless of which page they land on.
  const baseEcosystemLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "@id": `${baseUrl}/#base-app`,
    name: "Agent402 on Base",
    applicationCategory: "BlockchainApplication",
    operatingSystem: RAILS_OS,
    description: `x402 pay-per-call agent tools settling in ${RAILS_AMP}. Available as a Base MCP plugin (app ID 6a3dd86ca341d86b910769fb). Gas is sponsored on EVM chains - callers need only the stablecoin.`,
    url: baseUrl,
  };
  const allLd = [baseEcosystemLd, ...(jsonLd ? (Array.isArray(jsonLd) ? jsonLd : [jsonLd]) : [])];
  const jsonLdBlock = allLd
    .map((j) => `<script type="application/ld+json">${JSON.stringify(j)}</script>`)
    .join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<script>(function(){try{var t=localStorage.getItem('a402-theme')||(window.matchMedia&&window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light');if(t==='dark')document.documentElement.setAttribute('data-theme','dark');}catch(e){}})();
function a402ToggleTheme(){try{var r=document.documentElement,d=r.getAttribute('data-theme')==='dark';if(d){r.removeAttribute('data-theme');localStorage.setItem('a402-theme','light');}else{r.setAttribute('data-theme','dark');localStorage.setItem('a402-theme','dark');}}catch(e){}}</script>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${process.env.GOOGLE_SITE_VERIFICATION ? `<meta name="google-site-verification" content="${esc(process.env.GOOGLE_SITE_VERIFICATION)}">\n` : ""}
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:site_name" content="Agent402.Tools">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(og)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@Agent402Tools">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(og)}">
<meta name="base:app_id" content="6a3dd86ca341d86b910769fb" />
${LEDGER_HEAD}
<style>${LEDGER_CSS}${extraCss}</style>
${jsonLdBlock}
</head>
<body style="overflow-x:hidden;">
${statusLine()}
${nav(activePath)}
${body}
</body>
</html>`;
}
