import { RAILS_AMP, RAILS_OS, RAILS_TICKER } from "./rails.js";
// Machine Ledger design system — shared chrome for the Agent402 marketing site.
// Exports the status line, nav, footers (full + compact), design-token CSS,
// and a ledgerShell() wrapper that composes a full HTML page.
//
// Pages import ledgerShell() and one of the footer functions, then pass their
// body HTML to get a complete document with SEO metadata and shared chrome.

export const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---------------------------------------------------------------------------
// Head links: Google Fonts + favicons
// Browsers cache favicons in a separate, long-lived store keyed by URL - bump
// the ?v= literal whenever the logo art changes or old marks linger for weeks.
// ---------------------------------------------------------------------------

export const LEDGER_HEAD = `<link rel="preload" href="/fonts/archivo-800.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/spacemono-400.woff2" as="font" type="font/woff2" crossorigin>
<style>
@font-face{font-family:'Archivo';font-style:normal;font-weight:400;font-display:swap;src:url(/fonts/archivo-400.woff2) format('woff2')}
@font-face{font-family:'Archivo';font-style:normal;font-weight:500;font-display:swap;src:url(/fonts/archivo-500.woff2) format('woff2')}
@font-face{font-family:'Archivo';font-style:normal;font-weight:600;font-display:swap;src:url(/fonts/archivo-600.woff2) format('woff2')}
@font-face{font-family:'Archivo';font-style:normal;font-weight:700;font-display:swap;src:url(/fonts/archivo-700.woff2) format('woff2')}
@font-face{font-family:'Archivo';font-style:normal;font-weight:800;font-display:swap;src:url(/fonts/archivo-800.woff2) format('woff2')}
@font-face{font-family:'Archivo';font-style:normal;font-weight:900;font-display:swap;src:url(/fonts/archivo-900.woff2) format('woff2')}
@font-face{font-family:'Space Mono';font-style:normal;font-weight:400;font-display:swap;src:url(/fonts/spacemono-400.woff2) format('woff2')}
@font-face{font-family:'Space Mono';font-style:normal;font-weight:700;font-display:swap;src:url(/fonts/spacemono-700.woff2) format('woff2')}
/* Metric-matched fallback faces (fontaine/capsize method, computed from the real
   woff2 files vs Arial/Courier New): the fallback is sized to occupy the SAME box
   as the web font, so when the self-hosted font swaps in nothing reflows - CLS ~0
   AND the brand font always shows the moment it loads (no font-display:optional
   fallback-flash). Overrides apply to whichever local() resolves, so vertical
   metrics stay matched even on Arial-less systems (Android → Roboto). */
@font-face{font-family:'Archivo Fallback';src:local('Arial'),local('Roboto'),local('Helvetica Neue');size-adjust:115.7664%;ascent-override:75.8424%;descent-override:18.14%;line-gap-override:0%}
@font-face{font-family:'Space Mono Fallback';src:local('Courier New'),local('Courier'),local('Roboto Mono');size-adjust:101.9834%;ascent-override:109.8218%;descent-override:35.3979%;line-gap-override:0%}
</style>
<link rel="icon" type="image/svg+xml" href="/favicon.svg?v=3">
<link rel="icon" type="image/png" sizes="512x512" href="/favicon.ico?v=3">
<link rel="shortcut icon" href="/favicon.ico?v=3">
<link rel="apple-touch-icon" href="/logo.png?v=2">`;

// ---------------------------------------------------------------------------
// Design-token CSS + base reset + keyframes + shared chrome styles
// ---------------------------------------------------------------------------

export const LEDGER_CSS = `
/* Hard stop on page-level horizontal scroll: no content should ever push the
   document sideways on a phone. Uses overflow-x: clip (not hidden) so it never
   turns the root into a scroll container - position: sticky (docs TOC) keeps
   working. Wide data tables get their own internal scroll below; everything
   else is made to wrap/fit at mobile widths in the media queries. */
html { overflow-x: clip; }
:root {
  /* Accent as small text needs >=4.5:1 (WCAG AA). #BF360C clears it on every
     light surface (white, cream card, zebra). On DARK surfaces a dark red fails,
     so accent text there uses --accent-lit (a brighter red) via a scoped
     override on each dark container. Accent-as-background keeps white text
     legible on #BF360C (5.8:1); brightening it would BREAK that, so dark
     containers only override text, never accent-bg buttons. */
  --accent: #F0522E;
  --accent-lit: #F0522E;
  --paper: #0E0E10;
  --card: #171719;
  --card-zebra: #1E1E21;
  --footer-bg: #131315;
  --ink: #ECECEA;
  --ink-panel: #171719;
  --muted: #9E9E98;
  --faint: #6C6C68;
  --hairline: #2A2A30;
  --dash: #35353B;
  --dark-border: #262626;
  --dark-border2: #343434;
  --cream: #0E0E10;
  --cream2: #171719;
  --surface: #17171A;
  --on-dark: #F4F4F2;
  --on-dark2: #CFCFCB;
  --dk-muted: #9C9C9C;
  --dk-muted2: #B8B8B8;
  --dk-muted3: #888888;
  --green: #3E9B6E;
  --font-body: 'Archivo', 'Archivo Fallback', system-ui, sans-serif;
  --font-mono: 'Space Mono', 'Space Mono Fallback', monospace;
}
/* Dark is the ONLY theme. The palette above IS the dark palette, set directly
   on :root rather than behind a [data-theme] attribute, so the first paint is
   already dark: no flash, no pre-paint script, no stored preference, and
   nothing to get out of sync. There is deliberately no light mode and no
   toggle. Dark SURFACES still do not invert - a card or terminal that was
   background:var(--surface) with color:var(--on-dark) keeps light text, which
   is why --surface / --on-dark stay separate from the dual-use --ink. */
:root { color-scheme: dark; }
body { transition: background-color .18s ease, color .18s ease; }
/* --- mobile hamburger menu (the hover nav dropdowns don't work on touch, and
   the inline links get squeezed to zero on a phone - so ≤880px collapses the
   whole nav into a tap menu) --- */
.ml-burger { display:none; align-items:center; justify-content:center; width:38px; height:34px; padding:0; border:1.5px solid var(--ink); background:transparent; color:var(--ink); cursor:pointer; }
.ml-burger .ml-burger-close { display:none; }
.ml-mobile-menu { display:none; border-top:1.5px solid var(--ink); background:var(--paper); max-height:calc(100vh - 62px); overflow-y:auto; -webkit-overflow-scrolling:touch; }
.ml-mm-h { padding:14px 20px 6px; font-family:var(--font-mono); font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--faint); }
.ml-mm-group { display:flex; flex-direction:column; }
.ml-mm-link { padding:13px 20px; font-family:var(--font-mono); font-size:15px; color:var(--ink); text-decoration:none; border-bottom:1px solid var(--hairline); }
.ml-mm-link:hover, .ml-mm-link:active { background:var(--card-zebra); }
.ml-mm-active { color:var(--accent); font-weight:700; }
.ml-mm-cta { background:var(--surface); color:var(--on-dark); font-weight:700; border-bottom:none; }
@media (max-width:880px){
  .ml-nav-links, .ml-nav-gh, .ml-nav-cta { display:none !important; }
  .ml-burger { display:inline-flex; }
  html.ml-menu-open .ml-mobile-menu { display:block; }
  html.ml-menu-open .ml-burger-open { display:none; }
  html.ml-menu-open .ml-burger-close { display:inline; }
}
@media (min-width:881px){ .ml-mobile-menu { display:none !important; } }
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

/* --- responsive --- */
@media (max-width: 900px) {
  .ml-ft-grid { grid-template-columns: repeat(2, 1fr) !important; }
  .ml-hero-grid { grid-template-columns: 1fr !important; }
  .ml-2col { grid-template-columns: minmax(0, 1fr) !important; }
  .ml-2col > * { min-width: 0; }
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
  /* Long unbreakable strings - seller hosts, payTo addresses, package names -
     must wrap on phones instead of forcing a fixed grid column (and the page)
     wider than the viewport. This is the main source of the horizontal scroll:
     an unwrappable host in a 1fr column sets a min-content floor above 375px. */
  .lb-name, .lb-addr, .mlr-name, .mlr-host, .lb-addr a, pre, code { overflow-wrap: anywhere !important; word-break: break-word !important; }
  /* pre code blocks: wrap long unbreakable tokens (URLs, hashes, one-line
     commands) so they never widen a column past the phone viewport. */
  pre { white-space: pre-wrap !important; }
  /* 4-up stat / method grids and the 8-chain market strip stack tighter so their
     cells never overflow. */
  .lb-totals, .lb-method { grid-template-columns: repeat(2, 1fr) !important; }
  .ml-mkts { grid-template-columns: repeat(2, 1fr) !important; }
  /* Leaderboard table: its five fixed columns (rank + name + usdc + calls +
     buyers) are wider than a phone on their own. Drop to the primary three
     (rank, seller, USDC settled - the headline metric); hide the secondary
     calls/buyers columns and their headers. Full table stays on desktop. */
  .lb-head, .lb-row { grid-template-columns: 26px 1fr auto !important; column-gap: 10px !important; }
  .lb-num, .lb-buyers, .lb-head > span:nth-child(4), .lb-head > span:nth-child(5) { display: none !important; }
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
.mfb-label{font-family:var(--font-mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);font-weight:700;}
.mfb-tab{font-family:var(--font-mono);font-size:12px;padding:5px 11px;border:1.5px solid var(--ink);background:var(--paper);color:var(--ink);text-decoration:none;white-space:nowrap;}
/* Active tab: accent-as-background - the one pattern that stays legible in BOTH
   themes (white on #BF360C is 5.8:1; --ink/--on-dark flip light in dark mode and
   made the active tab a white blob with invisible text). */
.mfb-tab.on{background:var(--accent);color:#fff;border-color:var(--accent);}
.mfb-sel,.mfb-search{font-family:var(--font-mono);font-size:12px;padding:6px 10px;border:1.5px solid var(--ink);background:var(--paper);color:var(--ink);}
.mfb-search{flex:1;min-width:120px;}
`;

// ---------------------------------------------------------------------------
// Status line (top of every page)
// ---------------------------------------------------------------------------

function statusLine() {
  return `<div style="background:var(--surface);color:var(--on-dark);font-family:var(--font-mono);font-size:12px;letter-spacing:.02em;">
  <div class="ml-status-in" style="max-width:1180px;margin:0 auto;padding:8px 30px;display:flex;align-items:center;justify-content:space-between;gap:16px;">
    <span class="ml-status-left" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">HTTP/1.1 <span style="color:var(--accent-lit);font-weight:700;">402</span> PAYMENT REQUIRED</span>
    <span class="ml-status-ticker" style="color:var(--dk-muted);white-space:nowrap;">agent402.base.eth · ${RAILS_TICKER}</span>
  </div>
</div>`;
}

// ---------------------------------------------------------------------------
// Nav (sticky, every page)
// ---------------------------------------------------------------------------

// Three zones: buy's direct links (highest-traffic destinations, no hover
// required) | the two grouped doors (marketplace / sell, each a real link plus
// a CSS-only dropdown) | docs. See design_handoff_x402_ia_redesign/README.md §1.
const NAV_ZONES = [
  [
    { href: "/skills", label: "skill packs" },
    { href: "/tools", label: "catalog" },
    { href: "/pricing", label: "pricing" },
  ],
  [
    { href: "/marketplace", label: "marketplace", panel: "marketplace" },
    { href: "/sell", label: "sell", panel: "sell" },
  ],
  // Proof surfaces. These were reachable ONLY from the footer, which on the
  // homepage sits at 97% of the document - the live revenue ledger, the single
  // most load-bearing claim on the site, required scrolling past everything to
  // find. They are short labels on purpose: this zone shares a row with the
  // logo and the CTA, so anything verbose here costs the nav a line.
  [
    { href: "/revenue", label: "revenue" },
    { href: "/status", label: "status" },
    { href: "/what-is-x402", label: "what is x402/MPP" },
    { href: "/docs", label: "docs" },
  ],
];

// Fallback by-chain rows used whenever no live index-snapshot data is wired
// (offline unit tests, early boot, a throwing/null provider) - the dropdown
// and footer still get real, crawlable links, just without seller counts.
// All 12 rails have a live market page (/base, /solana, /polygon, /arbitrum, /monad,
// /celo, /avalanche, /sei, /optimism, /stellar, /algorand, /robinhood) - this fallback
// must list every one, not just the two that got dedicated routes first.
const STATIC_CHAINS = [
  { label: "base", href: "/base" },
  { label: "solana", href: "/solana" },
  { label: "polygon", href: "/polygon" },
  { label: "arbitrum", href: "/arbitrum" },
  { label: "monad", href: "/monad" },
  { label: "celo", href: "/celo" },
  { label: "avalanche", href: "/avalanche" },
  { label: "sei", href: "/sei" },
  { label: "optimism", href: "/optimism" },
  { label: "stellar", href: "/stellar" },
  { label: "algorand", href: "/algorand" },
  { label: "robinhood", href: "/robinhood" },
];

// Per-chain seller counts/health for the index dropdown + footer are live
// data (crawler + index snapshot), but nav() renders on every page - including
// offline unit tests with no crawler running. server.js wires a provider once
// real data exists; until then (or if it throws) nav() falls back to
// STATIC_CHAINS so it never crashes and never blocks a page render.
let navDataProvider = null;
export function setNavIndexProvider(fn) { navDataProvider = fn; }

function chainRows() {
  try {
    const data = navDataProvider && navDataProvider();
    if (data && Array.isArray(data.chains) && data.chains.length) {
      // Scale rule: EVERY live rail gets a row while the rail count stays
      // human-sized (≤12 - twelve live rails, see #469); only past that does
      // the list truncate to the top 12 with the "all sellers" row carrying
      // the rest. The previous >9 → slice(0,7) rule silently dropped Stellar,
      // Algorand, and Robinhood from the dropdown AND the mobile menu the
      // moment rail #10 shipped - the exact failure its own comment said it
      // was preventing. A ceiling must sit ABOVE the roster it protects.
      const chains = data.chains.length > 12 ? data.chains.slice(0, 12) : data.chains;
      return { chains, live: true };
    }
  } catch { /* provider threw - fall back to the static list below */ }
  return { chains: STATIC_CHAINS, live: false };
}

function chainRowHtml(c, live) {
  if (!live) {
    // No provider data at all - a plain link, never a fabricated count.
    return `<a href="${esc(c.href)}" class="mlnav-row" style="display:block;padding:9px 16px;text-decoration:none;color:var(--ink);font-weight:700;">${esc(c.label)}</a>`;
  }
  const known = typeof c.sellers === "number" && c.healthy !== false;
  if (known) {
    const fmt = (n) => Number(n).toLocaleString("en-US");
    // Sellers (green health dot) + tool depth on that chain, when we have it -
    // the two numbers an agent picks a chain on. Tools omitted (not zeroed) if
    // the count is missing, never a fabricated 0.
    const toolsSpan = typeof c.tools === "number" && c.tools > 0
      ? `<span style="color:var(--faint);">${fmt(c.tools)} tools</span>`
      : "";
    return `<a href="${esc(c.href)}" class="mlnav-row" style="display:flex;justify-content:space-between;gap:12px;padding:9px 16px;text-decoration:none;color:var(--ink);"><span style="font-weight:700;">${esc(c.label)}</span><span style="display:inline-flex;align-items:center;gap:10px;"><span style="display:inline-flex;align-items:center;gap:6px;color:var(--green);"><span style="width:7px;height:7px;border-radius:50%;background:var(--green);display:inline-block;"></span>${fmt(c.sellers)} sellers</span>${toolsSpan}</span></a>`;
  }
  // Provider returned this chain but its data failed - honesty rule:
  // "unavailable", never zero.
  return `<a href="${esc(c.href)}" class="mlnav-row" style="display:flex;justify-content:space-between;gap:12px;padding:9px 16px;text-decoration:none;color:var(--ink);"><span style="font-weight:700;">${esc(c.label)}</span><span style="display:inline-flex;align-items:center;gap:6px;color:var(--faint);"><span style="width:7px;height:7px;border-radius:50%;background:var(--faint);display:inline-block;"></span>unavailable</span></a>`;
}

// Marketplace dropdown - the single buy-side door (the old separate
// "marketplaces" and "index" panels, merged): one row per rail (live
// chainRows/health), the leaderboard row carried over from the old index
// panel, and the ink footer row linking the unified /marketplace directory.
function marketPanelNav(chainInfo) {
  const rows = chainInfo.chains.map((c) => chainRowHtml(c, chainInfo.live)).join("\n                ");
  return `<span class="mlnav-dd">
              <span style="display:block;width:340px;border:1.5px solid var(--ink);background:var(--paper);box-shadow:5px 5px 0 #0b0b0b1f;">
                <span style="display:block;padding:10px 16px 8px;font-size:11px;letter-spacing:.1em;color:var(--faint);border-bottom:1px solid var(--hairline);">THE X402 MARKETPLACE - EVERY SELLER, EVERY CHAIN</span>
                ${rows}
                <a href="/leaderboard" class="mlnav-row" style="display:flex;justify-content:space-between;gap:12px;padding:9px 16px;text-decoration:none;color:var(--ink);"><span style="font-weight:700;">leaderboard</span><span style="color:var(--faint);">by USDC settled</span></a>
                <a href="/marketplace/tools" class="mlnav-row" style="display:flex;justify-content:space-between;gap:12px;padding:9px 16px;text-decoration:none;color:var(--ink);"><span style="font-weight:700;">every tool indexed</span><span style="color:var(--faint);">ours + third-party</span></a>
                <a href="/marketplace" style="display:flex;justify-content:space-between;gap:12px;padding:11px 16px;text-decoration:none;background:var(--surface);color:var(--on-dark);"><span style="font-weight:700;">the full directory →</span><span style="color:var(--dk-muted);">/marketplace</span></a>
              </span>
            </span>`;
}

function sellPanelHtml() {
  return `<span class="mlnav-dd">
              <span style="display:block;width:330px;border:1.5px solid var(--ink);background:var(--paper);box-shadow:5px 5px 0 #0b0b0b1f;">
                <span style="display:block;padding:10px 16px 8px;font-size:11px;letter-spacing:.1em;color:var(--faint);border-bottom:1px solid var(--hairline);">FOR API SELLERS - GET PAID PER CALL</span>
                <a href="/sell" class="mlnav-row" style="display:flex;justify-content:space-between;gap:12px;padding:9px 16px;text-decoration:none;color:var(--ink);"><span style="font-weight:700;">list your API</span><span style="color:var(--faint);">free · health-ranked</span></a>
                <a href="/tollbooth" class="mlnav-row" style="display:flex;justify-content:space-between;gap:12px;padding:9px 16px;text-decoration:none;color:var(--ink);"><span style="font-weight:700;">tollbooth</span><span style="color:var(--faint);">pay-per-crawl</span></a>
                <a href="/contribute" class="mlnav-row" style="display:flex;justify-content:space-between;gap:12px;padding:9px 16px;text-decoration:none;color:var(--ink);"><span style="font-weight:700;">contribute a tool</span><span style="color:var(--faint);">AGPL · ~15 lines</span></a>
                <a href="/sell" style="display:flex;justify-content:space-between;gap:12px;padding:11px 16px;text-decoration:none;background:var(--surface);color:var(--on-dark);"><span style="font-weight:700;">start selling →</span><span style="color:var(--dk-muted);">/sell</span></a>
              </span>
            </span>`;
}

const PANEL_HTML = { marketplace: marketPanelNav, sell: sellPanelHtml };

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

const mmLink = (href, label, active, extra = "") =>
  `<a href="${esc(href)}" class="ml-mm-link${active ? " ml-mm-active" : ""}${extra}">${esc(label)}</a>`;

// Mobile menu - every destination flattened into a tap list (the hover
// dropdowns don't work on touch, so the chains, sell, and marketplace
// sub-items all live here directly). Shown ≤880px via the hamburger; hidden
// on desktop.
function mobileMenuHtml(chainInfo, activePath) {
  const chains = chainInfo.chains.map((c) => mmLink(c.href, c.label, c.href === activePath)).join("");
  return `<div id="ml-mobile-menu" class="ml-mobile-menu">
    <div class="ml-mm-group">
      ${mmLink("/skills", "skill packs", activePath === "/skills")}
      ${mmLink("/tools", "catalog", activePath === "/tools")}
      ${mmLink("/pricing", "pricing", activePath === "/pricing")}
    </div>
    <div class="ml-mm-h">Marketplace · by chain</div>
    <div class="ml-mm-group">
      ${mmLink("/marketplace", "all sellers · every chain", activePath === "/marketplace")}
      ${mmLink("/marketplace/tools", "every tool indexed", activePath === "/marketplace/tools")}
      ${chains}
      ${mmLink("/leaderboard", "leaderboard", activePath === "/leaderboard")}
    </div>
    <div class="ml-mm-h">Sell</div>
    <div class="ml-mm-group">
      ${mmLink("/sell", "list your API", activePath === "/sell")}
      ${mmLink("/tollbooth", "tollbooth", activePath === "/tollbooth")}
    </div>
    <div class="ml-mm-h">Proof</div>
    <div class="ml-mm-group">
      ${mmLink("/revenue", "revenue · on-chain", activePath === "/revenue")}
      ${mmLink("/status", "status · uptime", activePath === "/status")}
    </div>
    <div class="ml-mm-group">
      ${mmLink("/what-is-x402", "what is x402/MPP", activePath === "/what-is-x402")}
      ${mmLink("/docs", "docs", activePath === "/docs")}
      <a href="https://github.com/MikeyPetrillo/Agent402" rel="noopener" class="ml-mm-link">github</a>
      ${activePath === "" ? "" : mmLink("/docs#add", "ADD TO CLAUDE →", false, " ml-mm-cta")}
    </div>
  </div>`;
}

// The "ADD TO CLAUDE" nav CTA points at /docs#add — the "Three ways in"
// section with the actual connector instructions — not /docs. A button whose
// label names an action must not land the reader at the top of a long
// reference page to go hunting for it.
//
// It is also suppressed on the homepage (activePath === ""), where the hero
// carries the identical button: nav + hero were both on screen at first paint,
// same label, same destination, so home was showing the same CTA three times
// counting the closing band. Interior pages keep it — there it is the only
// call to action on the page.
function nav(activePath) {
  const chainInfo = chainRows();
  const groupHrefs = {
    // One buy-side door: /marketplace, every chain page, and /leaderboard (its
    // panel row) all light the marketplace trigger - a future chain page lights
    // it up with zero nav edits.
    marketplace: new Set(["/marketplace", "/leaderboard", ...chainInfo.chains.map((c) => c.href)]),
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
      
      ${activePath === "" ? "" : `<a class="ml-nav-cta" href="/docs#add" style="background:var(--surface);color:var(--on-dark);font-family:var(--font-mono);font-weight:700;font-size:13px;text-decoration:none;padding:9px 15px;">ADD TO CLAUDE →</a>`}
      <button type="button" onclick="a402ToggleMenu()" class="ml-burger" aria-label="Open menu" aria-expanded="false">
        <svg class="ml-burger-open" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
        <svg class="ml-burger-close" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>
  </div>
  ${mobileMenuHtml(chainInfo, activePath)}
</nav>`;
}

// ---------------------------------------------------------------------------
// Footer - full 5-column (home page)
// ---------------------------------------------------------------------------

export function ledgerFooterFull() {
  return `<footer style="border-top:1.5px solid var(--ink);background:var(--footer-bg);">
  <div style="max-width:1180px;margin:0 auto;padding:48px 30px 32px;">
    <div class="ml-ft-grid" style="display:grid;grid-template-columns:1.3fr 1fr 1fr 1fr 1fr 1fr;gap:24px;">
      <div>
        <a href="/" style="display:flex;align-items:center;gap:10px;margin-bottom:12px;text-decoration:none;color:var(--ink);">
          <span style="width:30px;height:30px;border:2px solid var(--ink);color:var(--ink);font-family:var(--font-mono);font-weight:700;font-size:12px;display:flex;align-items:center;justify-content:center;">402</span>
          <span style="font-weight:800;font-size:16px;text-transform:uppercase;letter-spacing:-.02em;">Agent402<span style="color:var(--accent);">.</span>Tools</span>
        </a>
        <p style="font-family:var(--font-mono);font-size:12px;line-height:1.6;color:var(--muted);margin:0;max-width:240px;">The open x402 index - discovery, routing, and on-chain ranking for the agent payments economy.</p>
      </div>
      <div>
        <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin-bottom:12px;">for agents</div>
        <div style="display:flex;flex-direction:column;gap:9px;font-size:14px;"><a href="/skills" style="color:var(--muted);text-decoration:none;">Skill packs</a><a href="/tools" style="color:var(--muted);text-decoration:none;">Tool catalog</a><a href="/tools/category/llm" style="color:var(--muted);text-decoration:none;">LLM gateway</a><a href="/pricing" style="color:var(--muted);text-decoration:none;">Pricing</a><a href="/integrations" style="color:var(--muted);text-decoration:none;">Integrations</a><a href="/playground" style="color:var(--muted);text-decoration:none;">Playground</a></div>
      </div>
      <div>
        <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin-bottom:12px;">marketplace</div>
        <div style="display:flex;flex-direction:column;gap:9px;font-size:14px;"><a href="/marketplace" style="color:var(--muted);text-decoration:none;">Marketplace</a><a href="/leaderboard" style="color:var(--muted);text-decoration:none;">Leaderboard</a><a href="/guides/smart-order-router" style="color:var(--muted);text-decoration:none;">Router</a><a href="/marketplace/tools" style="color:var(--muted);text-decoration:none;">Every tool indexed</a><a href="/revenue" style="color:var(--muted);text-decoration:none;">Revenue</a></div>
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
        <div style="display:flex;flex-direction:column;gap:9px;font-size:14px;"><a href="/openapi.json" style="color:var(--muted);text-decoration:none;">OpenAPI</a><a href="/llms.txt" style="color:var(--muted);text-decoration:none;">llms.txt</a><a href="/docs#add" style="color:var(--muted);text-decoration:none;">MCP connector</a><a href="/api/stats" style="color:var(--muted);text-decoration:none;">Stats</a><a href="/api/status" style="color:var(--muted);text-decoration:none;">Status JSON</a><a href="/.well-known/x402" style="color:var(--muted);text-decoration:none;">.well-known/x402</a></div>
      </div>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-top:36px;padding-top:18px;border-top:1px solid var(--hairline);font-family:var(--font-mono);font-size:12px;color:var(--faint);">
      <span>© 2026 Havok Holdings LLC · open-source x402 + MCP server · <a href="mailto:mike@agent402.tools" style="color:var(--muted);text-decoration:underline;">mike@agent402.tools</a></span>
      <span style="display:flex;gap:16px;flex-wrap:wrap;"><a href="/status" style="color:var(--muted);text-decoration:none;">status</a><a href="/privacy" style="color:var(--muted);text-decoration:none;">privacy</a><a href="/terms" style="color:var(--muted);text-decoration:none;">terms</a><a href="/transparency" style="color:var(--muted);text-decoration:none;">transparency</a><a href="/contact" style="color:var(--muted);text-decoration:none;">contact</a><a href="https://github.com/MikeyPetrillo/Agent402" rel="noopener" style="color:var(--muted);text-decoration:none;">github</a><a href="https://x.com/Agent402Tools" rel="noopener" style="color:var(--muted);text-decoration:none;">𝕏</a></span>
    </div>
  </div>
</footer>`;
}

// ---------------------------------------------------------------------------
// Footer - compact single-row (sub-pages)
// ---------------------------------------------------------------------------

export function ledgerFooterCompact() {
  return `<footer style="border-top:1.5px solid var(--ink);background:var(--footer-bg);">
  <div style="max-width:1180px;margin:0 auto;padding:26px 30px;font-family:var(--font-mono);font-size:12px;color:var(--faint);">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;">
      <a href="/" style="display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--ink);"><span style="width:24px;height:24px;border:2px solid var(--ink);color:var(--ink);font-weight:700;font-size:10px;display:flex;align-items:center;justify-content:center;">402</span><span style="font-weight:700;">Agent402.Tools</span></a>
      <span style="display:flex;gap:16px;flex-wrap:wrap;"><a href="/tools" style="color:var(--muted);text-decoration:none;">catalog</a><a href="/marketplace/tools" style="color:var(--muted);text-decoration:none;">every tool indexed</a><a href="/pricing" style="color:var(--muted);text-decoration:none;">pricing</a><a href="/tools/category/llm" style="color:var(--muted);text-decoration:none;">llm gateway</a><a href="/marketplace" style="color:var(--muted);text-decoration:none;">marketplace</a><a href="/leaderboard" style="color:var(--muted);text-decoration:none;">leaderboard</a><a href="/guides/smart-order-router" style="color:var(--muted);text-decoration:none;">router</a><a href="/sell" style="color:var(--muted);text-decoration:none;">sell</a><a href="/what-is-x402" style="color:var(--muted);text-decoration:none;">what is x402/MPP?</a><a href="/docs" style="color:var(--muted);text-decoration:none;">docs</a><a href="/integrations" style="color:var(--muted);text-decoration:none;">integrations</a></span>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-top:12px;padding-top:12px;border-top:1px solid var(--hairline);">
      <span>© 2026 Havok Holdings LLC · <a href="mailto:mike@agent402.tools" style="color:var(--muted);text-decoration:underline;">mike@agent402.tools</a></span>
      <span style="display:flex;gap:16px;flex-wrap:wrap;"><a href="/revenue" style="color:var(--muted);text-decoration:none;">revenue</a><a href="/status" style="color:var(--muted);text-decoration:none;">status</a><a href="/privacy" style="color:var(--muted);text-decoration:none;">privacy</a><a href="/terms" style="color:var(--muted);text-decoration:none;">terms</a><a href="/transparency" style="color:var(--muted);text-decoration:none;">transparency</a><a href="/contact" style="color:var(--muted);text-decoration:none;">contact</a><a href="/llms.txt" style="color:var(--muted);text-decoration:none;">llms.txt</a><a href="https://github.com/MikeyPetrillo/Agent402" rel="noopener" style="color:var(--muted);text-decoration:none;">github</a><a href="https://x.com/Agent402Tools" rel="noopener" style="color:var(--muted);text-decoration:none;">𝕏</a></span>
    </div>
  </div>
</footer>`;
}

// ---------------------------------------------------------------------------
// Settlement tape - scrolling marquee of recent paid calls
// ---------------------------------------------------------------------------

function agoStr(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s | 0}s`;
  if (s < 3600) return `${(s / 60) | 0}m`;
  if (s < 86400) return `${(s / 3600) | 0}h`;
  return `${(s / 86400) | 0}d`;
}

// The scrolling "●●● TAPE" band of recent calls was REMOVED 2026-07-25. It was
// the homepage's only live-proof element and it argued against the page: on a
// site headlined "where agents pay agents", the tape showed 23 of 25 calls on
// the free proof-of-work rail, one of them our own heartbeat probe, across just
// five trivial tools (base64, hash, unit-convert, timezone-convert). Real
// revenue at the same moment — transcribe, search, the skill packs — never
// appeared, because the feed was ordered by recency and the cheap free calls
// dominate by volume. A proof band that quietly contradicts the headline is
// worse than none. The cumulative "N calls settled to date" counter in the hero
// stays; it is a real number that does not misrepresent the mix.

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

// Cookieless client-side analytics: $pageview + $pageleave (bounce/duration) +
// $web_vitals, loaded and ingested FIRST-PARTY through /e (the reverse proxy in
// server.js) so the browser never touches a third-party host and CSP stays at
// 'self'. persistence:'sessionStorage' means NO cookies and no cross-visit
// tracking, but sessions stay coherent within a single visit so bounce/duration
// and web-vitals actually compute. autocapture + session recording are OFF.
// Env-gated on the public project key (POSTHOG_API_KEY); renders nothing without it.
function posthogSnippet(baseUrl) {
  const key = process.env.POSTHOG_API_KEY || "";
  if (!key) return "";
  const cfg = JSON.stringify({
    api_host: `${baseUrl}/e`,
    ui_host: "https://us.posthog.com",
    persistence: "sessionStorage",
    autocapture: false,
    capture_pageview: true,
    capture_pageleave: true,
    capture_performance: { web_vitals: true, network_timing: false },
    disable_session_recording: true,
    disable_surveys: true,
  });
  return `<script>!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug getPageViewId captureTraceFeedback captureTraceMetric".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);posthog.init(${JSON.stringify(key)},${cfg});</script>`;
}
export function ledgerShell({ title, description, canonical, baseUrl, activePath = "", ogImage, jsonLd, extraCss = "", body }) {
  const og = ogImage || (baseUrl + "/card.png" + (ogImageVersion ? `?v=${ogImageVersion}` : ""));
  // Base ecosystem JSON-LD - every page rendered through the ledger shell
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
<script>function a402ToggleMenu(){try{var o=document.documentElement.classList.toggle('ml-menu-open');var b=document.querySelector('.ml-burger');if(b)b.setAttribute('aria-expanded',o?'true':'false');}catch(e){}}</script>
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
${posthogSnippet(baseUrl)}
</head>
<body style="overflow-x:hidden;">
${statusLine()}
${nav(activePath)}
<main>${body}</main>
</body>
</html>`;
}
