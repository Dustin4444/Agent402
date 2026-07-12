// Chain-agnostic x402 marketplace renderer — one template, chain config as
// data. Generalizes what used to be two near-identical files
// (stellar-page.js, algorand-page.js) so a third chain page is a CHAIN_PAGES
// entry, not a fork. src/stellar-page.js and src/algorand-page.js are now
// thin wrappers over marketPage() that keep their original export names so
// server.js and the existing test suites need no changes.
//
// Honesty rules (unchanged from the originals — see scripts/test-*-page.js):
// never invent receipts, say plainly when Agent402 is the only listed
// seller, "unavailable" rather than zeros on a failed scan, truncation
// floors, javascript: href neutralization, testnet exclusion, >12-seller
// compact roster, per-seller activity switching via ?seller=.
import { ledgerShell, ledgerFooterCompact } from "./ledger-chrome.js";
import { CATEGORIES } from "./pages.js";
import { chainMark } from "./chain-logos.js";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// Crawled manifests are third-party input: only http(s) may become an href.
const safeHref = (u) => (/^https?:\/\//i.test(String(u || "")) ? esc(u) : "#");
const usd = (n) => `$${Number(n).toFixed(Number(n) < 0.01 ? 3 : 2).replace(/\.?0+$/, (m) => (m.includes(".") ? "" : m))}`;

/** Per-chain identity + copy. Add a chain here (not a new route) once it has
 *  a live page. Ordered to match src/rails.js (primary rail first). */
export const CHAIN_PAGES = {
  base: {
    chainName: "Base",
    ticker: "ETH",
    tickerLabel: "BASE · MAINNET",
    caip2: "eip155:8453",
    asset: "USDC",
    settleLatency: "~2 seconds",
    facilitatorLabel: "Coinbase CDP",
    gasNote: "sponsored",
    explorerUrl: "basescan.org",
    explorerWalletUrl: (wallet) => `https://basescan.org/address/${wallet}#tokentxns`,
    networkParam: "base",
    acceptNetwork: "eip155:8453",
    // Base mainnet CAIP-2 is "eip155:8453"; Base Sepolia testnet is a
    // different chain id ("eip155:84532") entirely, so an exact match
    // can't be fooled by a testnet accept.
    isNetwork: (n) => n === "eip155:8453",
    honestyNetworkPhrase: "the Base network",
    canaryLine: "A paid canary buys tools over the Base rail daily (facilitator: Coinbase CDP) - uptime proven with real settlements, not pings.",
    sellParagraphHtml: `Accept the Base CAIP-2 network (<code>eip155:8453</code>) in your 402 challenge - the Coinbase CDP facilitator verifies and settles, gas sponsored, and a listed origin is picked up by the CDP Bazaar too. Use <a href="https://www.npmjs.com/package/@x402/evm" rel="noopener"><code>@x402/evm</code></a> for the server-side scheme, or <a href="/tollbooth"><code>agent402-tollbooth</code></a> to paywall an existing site. Then serve <code>/.well-known/x402</code> - the index crawler lists you automatically; ranking is health-based, listing is free. Want a guaranteed crawl? <a href="https://github.com/MikeyPetrillo/Agent402/issues" rel="noopener">Open a seed request</a>.`,
  },
  solana: {
    chainName: "Solana",
    ticker: "SOL",
    tickerLabel: "SOLANA · MAINNET",
    caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    asset: "USDC",
    settleLatency: "~1 second",
    facilitatorLabel: "PayAI",
    gasNote: "fee-sponsored",
    explorerUrl: "solscan.io",
    explorerWalletUrl: (wallet) => `https://solscan.io/account/${wallet}`,
    networkParam: "solana",
    acceptNetwork: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    // Solana mainnet CAIP-2 is the mainnet genesis hash; devnet is a wholly
    // different genesis hash ("solana:EtWTRABZ…"), so an exact match can't
    // be fooled by a devnet accept.
    isNetwork: (n) => n === "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    honestyNetworkPhrase: "the Solana network",
    canaryLine: "A paid canary buys tools over the Solana rail daily (facilitator: PayAI) - uptime proven with real settlements, not pings.",
    sellParagraphHtml: `Accept the Solana CAIP-2 network (<code>solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp</code>) in your 402 challenge using the <a href="https://www.npmjs.com/package/@x402/svm" rel="noopener"><code>@x402/svm</code></a> server scheme - the PayAI facilitator verifies and settles, fees sponsored. Your payTo wallet needs an existing USDC associated token account before it can receive payments (send it any amount of USDC once to create one). Then serve <code>/.well-known/x402</code> - the index crawler lists you automatically; ranking is health-based, listing is free. Want a guaranteed crawl? <a href="https://github.com/MikeyPetrillo/Agent402/issues" rel="noopener">Open a seed request</a>.`,
  },
  polygon: {
    chainName: "Polygon",
    ticker: "POL",
    tickerLabel: "POLYGON · MAINNET",
    caip2: "eip155:137",
    asset: "USDC",
    settleLatency: "~2 seconds",
    facilitatorLabel: "PayAI",
    gasNote: "sponsored",
    explorerUrl: "polygonscan.com",
    explorerWalletUrl: (wallet) => `https://polygonscan.com/address/${wallet}#tokentxns`,
    networkParam: "polygon",
    acceptNetwork: "eip155:137",
    // Polygon mainnet CAIP-2 is "eip155:137"; Amoy testnet is a different
    // chain id ("eip155:80002"), so an exact match can't be fooled.
    isNetwork: (n) => n === "eip155:137",
    honestyNetworkPhrase: "the Polygon network",
    canaryLine: "A paid canary buys tools over the Polygon rail daily (facilitator: PayAI) - uptime proven with real settlements, not pings.",
    sellParagraphHtml: `Accept the Polygon CAIP-2 network (<code>eip155:137</code>) in your 402 challenge - the PayAI facilitator verifies and settles, gas sponsored. Use <a href="https://www.npmjs.com/package/@x402/evm" rel="noopener"><code>@x402/evm</code></a> for the server-side scheme, or <a href="/tollbooth"><code>agent402-tollbooth</code></a> to paywall an existing site. Then serve <code>/.well-known/x402</code> - the index crawler lists you automatically; ranking is health-based, listing is free. Want a guaranteed crawl? <a href="https://github.com/MikeyPetrillo/Agent402/issues" rel="noopener">Open a seed request</a>.`,
  },
  arbitrum: {
    chainName: "Arbitrum",
    ticker: "ETH",
    tickerLabel: "ARBITRUM · MAINNET",
    caip2: "eip155:42161",
    asset: "USDC",
    settleLatency: "~2 seconds",
    facilitatorLabel: "PayAI",
    gasNote: "sponsored",
    explorerUrl: "arbiscan.io",
    explorerWalletUrl: (wallet) => `https://arbiscan.io/address/${wallet}#tokentxns`,
    networkParam: "arbitrum",
    acceptNetwork: "eip155:42161",
    // Arbitrum One CAIP-2 is "eip155:42161"; Arbitrum Sepolia is a
    // different chain id ("eip155:421614"), so an exact match can't be
    // fooled by a testnet accept.
    isNetwork: (n) => n === "eip155:42161",
    honestyNetworkPhrase: "the Arbitrum network",
    canaryLine: "A paid canary buys tools over the Arbitrum rail daily (facilitator: PayAI) - uptime proven with real settlements, not pings.",
    sellParagraphHtml: `Accept the Arbitrum CAIP-2 network (<code>eip155:42161</code>) in your 402 challenge - the PayAI facilitator verifies and settles, gas sponsored. Use <a href="https://www.npmjs.com/package/@x402/evm" rel="noopener"><code>@x402/evm</code></a> for the server-side scheme, or <a href="/tollbooth"><code>agent402-tollbooth</code></a> to paywall an existing site. Then serve <code>/.well-known/x402</code> - the index crawler lists you automatically; ranking is health-based, listing is free. Want a guaranteed crawl? <a href="https://github.com/MikeyPetrillo/Agent402/issues" rel="noopener">Open a seed request</a>.`,
  },
  monad: {
    chainName: "Monad",
    ticker: "MON",
    tickerLabel: "MONAD · MAINNET",
    caip2: "eip155:143",
    asset: "USDC",
    settleLatency: "~1 second",
    facilitatorLabel: "PayAI",
    gasNote: "sponsored",
    explorerUrl: "monadscan.com",
    explorerWalletUrl: (wallet) => `https://monadscan.com/address/${wallet}#tokentxns`,
    networkParam: "monad",
    acceptNetwork: "eip155:143",
    // Monad mainnet CAIP-2 is "eip155:143"; Monad testnet is a different chain
    // id ("eip155:10143"), so an exact match can't be fooled by a testnet accept.
    isNetwork: (n) => n === "eip155:143",
    honestyNetworkPhrase: "the Monad network",
    canaryLine: "A paid canary buys tools over the Monad rail daily (facilitator: PayAI) - uptime proven with real settlements, not pings.",
    sellParagraphHtml: `Accept the Monad CAIP-2 network (<code>eip155:143</code>) in your 402 challenge - the PayAI facilitator verifies and settles native Circle USDC, gas sponsored. Use <a href="https://www.npmjs.com/package/@x402/evm" rel="noopener"><code>@x402/evm</code></a> for the server-side scheme, or <a href="/tollbooth"><code>agent402-tollbooth</code></a> to paywall an existing site. Then serve <code>/.well-known/x402</code> - the index crawler lists you automatically; ranking is health-based, listing is free. Want a guaranteed crawl? <a href="https://github.com/MikeyPetrillo/Agent402/issues" rel="noopener">Open a seed request</a>.`,
  },
  stellar: {
    chainName: "Stellar",
    ticker: "XLM",
    tickerLabel: "STELLAR · PUBNET",
    caip2: "stellar:pubnet",
    asset: "USDC",
    settleLatency: "~5 seconds",
    facilitatorLabel: "OpenZeppelin",
    gasNote: "sponsored",
    explorerUrl: "stellar.expert",
    explorerWalletUrl: (wallet) => `https://stellar.expert/explorer/public/account/${wallet}`,
    networkParam: "stellar",
    acceptNetwork: "stellar:pubnet",
    wallet: "GDNJXCKW7ZM7GEEVP674TWPU26YJNBQ2FI4ZIPRKTPTNUEJMDHFJWWRL",
    // Stellar mainnet CAIP-2 is "stellar:pubnet"; testnet ids contain "test".
    isNetwork: (n) => typeof n === "string" && n.startsWith("stellar") && !n.includes("test"),
    honestyNetworkPhrase: "a Stellar network",
    canaryLine: "A paid canary buys tools over the Stellar rail daily (facilitator: OpenZeppelin) - uptime proven with real settlements, not pings.",
    sellParagraphHtml: `Accept x402 payments with a <code>stellar:pubnet</code> accept in your 402 challenge - the <a href="https://developers.stellar.org/docs/build/agentic-payments/x402/built-on-stellar" rel="noopener">Built on Stellar facilitator</a> (OpenZeppelin) verifies and settles, gas sponsored. Use <a href="https://www.npmjs.com/package/@x402/stellar" rel="noopener"><code>@x402/stellar</code></a> for the wire, or <a href="/tollbooth"><code>agent402-tollbooth</code></a> to paywall an existing site. Then serve <code>/.well-known/x402</code> - the index crawler lists you automatically; ranking is health-based, listing is free. Want a guaranteed crawl? <a href="https://github.com/MikeyPetrillo/Agent402/issues" rel="noopener">Open a seed request</a>.`,
  },
  algorand: {
    chainName: "Algorand",
    ticker: "ALGO",
    tickerLabel: "ALGORAND · MAINNET",
    caip2: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
    asset: "USDC",
    settleLatency: "~3 seconds",
    facilitatorLabel: "GoPlausible",
    gasNote: "fee-sponsored",
    explorerUrl: "allo.info",
    explorerWalletUrl: (wallet) => `https://allo.info/account/${wallet}`,
    networkParam: "algorand",
    acceptNetwork: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
    wallet: "C7IIHG7SPLPZ5H7ZT6HW3UV2OQMQQE6Y2HBNGZXSLRJULE42BEE2OY2XIE",
    // Algorand mainnet CAIP-2 is `algorand:wGHE2Pwd…kit8=`; testnet starts
    // `algorand:SGO1GKSz…`. An exact-prefix match on the mainnet genesis
    // hash (rather than excluding the substring "test") can't be fooled by
    // a testnet id that happens not to contain "test".
    isNetwork: (n) => typeof n === "string" && n.startsWith("algorand:wGHE2Pwd"),
    honestyNetworkPhrase: "the Algorand mainnet network",
    canaryLine: "A paid canary buys tools over the Algorand rail daily (facilitator: GoPlausible, fees sponsored) - uptime proven with real settlements, not pings.",
    sellParagraphHtml: `Accept the Algorand mainnet CAIP-2 network in your 402 challenge using the <a href="https://www.npmjs.com/package/@x402/avm" rel="noopener"><code>@x402/avm</code></a> server SDK - the GoPlausible facilitator verifies and settles, fees sponsored. Your payTo wallet must be opted in to ASA <code>31566704</code> (USDC) before it can receive payments. Then serve <code>/.well-known/x402</code> - the index crawler lists you automatically; ranking is health-based, listing is free. Want a guaranteed crawl? <a href="https://github.com/MikeyPetrillo/Agent402/issues" rel="noopener">Open a seed request</a>.`,
  },
  robinhood: {
    chainName: "Robinhood Chain",
    ticker: "USDG",
    tickerLabel: "ROBINHOOD CHAIN · MAINNET",
    caip2: "eip155:4663",
    asset: "USDG",
    settleLatency: "~2 seconds",
    facilitatorLabel: "operator-configured",
    gasNote: "sponsored",
    explorerUrl: "robinhoodchain.blockscout.com",
    explorerWalletUrl: (wallet) => `https://robinhoodchain.blockscout.com/address/${wallet}`,
    networkParam: "robinhood",
    acceptNetwork: "eip155:4663",
    // Robinhood Chain mainnet CAIP-2 is "eip155:4663" - an Arbitrum Orbit
    // L2 with no public testnet accept in the wild today, but the exact
    // match keeps the same guarantee as every other EVM rail here.
    isNetwork: (n) => n === "eip155:4663",
    honestyNetworkPhrase: "the Robinhood Chain network",
    canaryLine: "A paid canary buys tools over the Robinhood Chain rail daily (facilitator: operator-configured) - uptime proven with real settlements, not pings.",
    sellParagraphHtml: `Accept the Robinhood Chain CAIP-2 network (<code>eip155:4663</code>) in your 402 challenge, asset USDG (Global Dollar) - set <code>PAYMENT_NETWORKS=…,robinhood</code> plus your own <code>ROBINHOOD_FACILITATOR_URL</code> (the rail settles through an operator-supplied facilitator, not CDP or PayAI). Use <a href="https://www.npmjs.com/package/@x402/evm" rel="noopener"><code>@x402/evm</code></a> for the server-side scheme (EIP-712 domain <code>"Global Dollar"</code>, version <code>"1"</code>), or <a href="/tollbooth"><code>agent402-tollbooth</code></a> (<code>TOLLBOOTH_NETWORK=eip155:4663 TOLLBOOTH_ASSET=USDG</code>). The <a href="/guides/usdg-payments-robinhood-chain">full integration guide</a> covers chain parameters and how to recognize a settlement on Blockscout. Then serve <code>/.well-known/x402</code> - the index crawler lists you automatically; ranking is health-based, listing is free.`,
  },
};

/** Sellers with a rail on this chain: the local catalog always qualifies
 *  (every local tool's 402 offers this chain); remote sellers qualify when
 *  their crawled 402s advertise a matching network. */
export function marketSellers(chainKey, snapshot) {
  const C = CHAIN_PAGES[chainKey];
  return (snapshot?.sellers || []).filter((s) => s.local === true || (s.networks || []).some(C.isNetwork));
}

/** Tools purchasable on this chain. Remote snapshot entries carry no
 *  per-tool list, so this is the local catalog; external sellers render
 *  seller-level. */
export function marketTools(_chainKey, snapshot) {
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
    .map(([category, list]) => ({
      category,
      label: CATEGORIES[category]?.label || category,
      shown: list.slice(0, maxPerCategory),
      more: Math.max(0, list.length - maxPerCategory),
    }));
}

function agoLabel(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Rail-manifest "daily canary" status — derived from the same `rail` object
// the page already fetched (no new network calls). A settlement younger than
// 36h reads as proof of life; anything older or missing reads "unavailable"
// rather than a stale check mark.
function canaryManifestStatus(rail) {
  const latest = rail?.recent?.[0] || null;
  const ts = latest?.when ? Date.parse(latest.when) : NaN;
  if (!latest || !Number.isFinite(ts)) return { text: "unavailable", color: "var(--muted)" };
  const ageMs = Date.now() - ts;
  if (ageMs < 0 || ageMs >= 36 * 3600_000) return { text: "unavailable", color: "var(--muted)" };
  return { text: `✓ settled ${agoLabel(ageMs)}`, color: "var(--green)" };
}

// Activity section — x402scan-style Transactions / Volume / Buyers cards
// with per-day bars. Same honesty rules as the receipts: no data → say so
// plainly, capped scan → "a floor".
export function marketActivityHtml(chainKey, activity, selected) {
  const C = CHAIN_PAGES[chainKey];
  const external = !!(selected && !selected.local && selected.host);
  const scopeLabel = external ? esc(String(selected.host).toUpperCase()) : "THIS HOST";
  if (!activity || activity.error || !Array.isArray(activity.buckets) || !activity.buckets.length) {
    const why = external
      ? `activity unavailable for this seller - no ${C.chainName} payTo advertised in its 402s, or the scan failed`
      : "activity scan temporarily unavailable";
    return `
  <h2 id="activity" style="font-size:21px;font-weight:800;margin:40px 0 14px;border-bottom:1.5px solid var(--ink);padding-bottom:8px;">Activity</h2>
  <p style="color:var(--muted);font-size:13.5px;margin:0;">${why} - settlements remain independently verifiable on ${esc(C.explorerUrl)}</p>`;
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
      ? `all inbound ${C.asset} to this seller's advertised x402 payTo wallet - may include non-x402 transfers`
      : `all inbound ${C.asset} settlements to this host's ${C.chainName} wallet`,
    t.internalTx ? `includes ${t.internalTx} internal canary buy${t.internalTx === 1 ? "" : "s"}` : "",
    activity.truncated ? "scan capped - totals are a floor" : "",
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

export function marketPage(chainKey, baseUrl, { snapshot, rail, activity, selectedSeller, wallet } = {}) {
  const C = CHAIN_PAGES[chainKey];
  const effectiveWallet = wallet || C.wallet;
  // Stellar/Algorand ship a committed public default wallet in CHAIN_PAGES;
  // the EVM + Solana rails don't (WALLET_ADDRESS/SOLANA_WALLET_ADDRESS are
  // Railway-only secrets, never hardcoded here) - falling back to the bare
  // explorer domain keeps the link honest instead of pointing at
  // "/address/undefined" when no wallet was passed at the route level.
  const walletExplorerUrl = effectiveWallet ? C.explorerWalletUrl(effectiveWallet) : `https://${C.explorerUrl}`;
  const sellers = marketSellers(chainKey, snapshot);
  const tools = marketTools(chainKey, snapshot);
  const prices = tools.map((t) => Number(t.price)).filter((n) => Number.isFinite(n) && n > 0);
  const low = prices.length ? Math.min(...prices) : 0.001;
  const high = prices.length ? Math.max(...prices) : 0.5;
  const groups = categoryGroups(tools);
  const latest = rail?.recent?.[0] || null;

  const receiptHtml = latest
    ? `<p style="margin:8px 0 0;">Latest settlement: <strong>${usd(latest.usd)} ${esc(C.asset)}</strong> · <a href="${esc(latest.tx)}" rel="noopener">on-chain receipt</a>${latest.when ? ` · ${esc(latest.when)}` : ""}</p>`
    : `<p style="margin:8px 0 0;color:var(--muted);">live receipts temporarily unavailable - settlements remain verifiable at <a href="${esc(walletExplorerUrl)}" rel="noopener">${esc(C.explorerUrl)}</a></p>`;

  const groupsHtml = groups.map((g) => `
    <div style="border:1px solid var(--hairline);padding:14px 16px;">
      <h3 style="margin:0 0 8px;font-size:14px;">${esc(g.label)}</h3>
      ${g.shown.map((t) => `<div style="display:flex;justify-content:space-between;gap:12px;font-size:13.5px;padding:3px 0;"><a href="/tools/${esc(t.slug)}" style="color:var(--ink);text-decoration:none;">${esc(t.name)}</a><span style="color:var(--muted);font-family:var(--font-mono);">${usd(t.price)}</span></div>`).join("")}
      ${g.more ? `<div style="font-size:12px;color:var(--faint);margin-top:6px;">+ ${g.more} more in <a href="/tools" style="color:var(--muted);">the full catalog</a></div>` : ""}
    </div>`).join("");

  const hostOf = (u) => { try { return new URL(u).host; } catch { return ""; } };
  // Which seller's activity is on screen: default is this host; an external
  // pick highlights that seller and re-scopes the Activity section.
  const selHost = selectedSeller && !selectedSeller.local ? String(selectedSeller.host || "").toLowerCase() : null;
  const isSelected = (s) => (selHost ? !s.local && hostOf(s.homepage).toLowerCase() === selHost : !!s.local);
  const activityHref = (s) => (s.local ? `/${chainKey}#activity` : `/${chainKey}?seller=${encodeURIComponent(hostOf(s.homepage).toLowerCase())}#activity`);
  // Cards read well up to a dozen sellers; past that, compact rows keep the
  // roster scannable at any size.
  const compact = sellers.length > 12;
  const sellersHtml = compact
    ? sellers.map((s) => {
        const good = s.local || s.routable;
        return `
    <a href="${activityHref(s)}" class="ml-roster-compact" style="display:grid;grid-template-columns:1fr auto auto auto;gap:14px;align-items:center;padding:9px 14px;border:${isSelected(s) ? "2px solid var(--accent)" : "1px solid var(--hairline)"};background:var(--card);color:var(--ink);text-decoration:none;">
      <span style="font-weight:700;font-size:14px;">${esc(s.displayName)}${s.local ? ' <span style="background:var(--accent);color:#fff;font-family:var(--font-mono);font-size:10px;font-weight:700;padding:1px 5px;">THIS HOST</span>' : ""}</span>
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
        ${s.local ? '<span style="background:var(--accent);color:#fff;font-family:var(--font-mono);font-size:10px;font-weight:700;padding:2px 6px;">THIS HOST</span>' : ""}
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
    <div style="border:1.5px solid var(--ink);background:var(--card);padding:14px 16px;"><div style="font-family:var(--font-mono);font-size:11px;color:var(--faint);letter-spacing:.06em;">LATEST SETTLE</div><div style="font-size:26px;font-weight:800;">${latest ? usd(latest.usd) : "-"}</div></div>
    <div style="border:1.5px solid var(--ink);background:var(--card);padding:14px 16px;"><div style="font-family:var(--font-mono);font-size:11px;color:var(--faint);letter-spacing:.06em;">PRICE FLOOR</div><div style="font-size:26px;font-weight:800;">${usd(low)}</div></div>
  </div>`;

  const honesty = sellers.length === 1 && sellers[0]?.local
    ? `<p style="color:var(--muted);font-size:13.5px;">1 seller live - discovery is open, and external sellers are added automatically when their x402 challenges advertise ${C.honestyNetworkPhrase}.</p>`
    : "";

  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: `The ${C.chainName} x402 marketplace`,
      url: `${baseUrl}/${chainKey}`,
      description: `Pay-per-call tools for AI agents, settled in ${C.asset} on ${C.chainName} via the x402 protocol. ${tools.length} tools live.`,
      mainEntity: {
        "@type": "OfferCatalog",
        name: `${C.chainName}-payable agent tools`,
        numberOfItems: tools.length,
        itemListElement: { "@type": "AggregateOffer", priceCurrency: "USD", lowPrice: String(low), highPrice: String(high), offerCount: tools.length },
      },
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Agent402.Tools", item: baseUrl },
        { "@type": "ListItem", position: 2, name: "Index", item: `${baseUrl}/index` },
        { "@type": "ListItem", position: 3, name: C.chainName, item: `${baseUrl}/${chainKey}` },
      ],
    },
  ];

  const formHtml = `
  <div id="list-api" style="border:1.5px solid var(--ink);background:var(--card);padding:18px 20px;margin-top:16px;">
    <div style="font-weight:800;font-size:15px;margin-bottom:8px;">List your API</div>
    <div style="display:flex;gap:10px;">
      <input id="reg-origin" type="url" placeholder="https://api.yourdomain.com" style="flex:1;font-family:var(--font-mono);font-size:13px;padding:9px 12px;border:1.5px solid var(--ink);background:var(--paper);color:var(--ink);">
      <button id="reg-go" style="background:var(--surface);color:var(--on-dark);font-family:var(--font-mono);font-weight:700;font-size:13px;border:none;padding:9px 16px;cursor:pointer;">SUBMIT</button>
    </div>
    <div id="reg-out" style="font-family:var(--font-mono);font-size:12.5px;color:var(--muted);margin-top:8px;">Free, no account - we probe your origin's x402 surface and list you if it answers. Ranking is health-based.</div>
  </div>
  <script>
  document.getElementById("reg-go").addEventListener("click", async () => {
    const out = document.getElementById("reg-out");
    out.textContent = "probing…";
    try {
      const r = await fetch("/api/index/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ origin: document.getElementById("reg-origin").value }) });
      const j = await r.json();
      out.textContent = j.listed ? ("Listed - " + (j.seller?.displayName || j.origin) + " (" + (j.seller?.toolCount || 0) + " tools). ${C.chainName} sellers appear on this page; all sellers appear on /index.") : ("Not listed: " + (j.error || "unknown error"));
    } catch { out.textContent = "submission failed - try again"; }
  });
  </script>`;

  const canary = canaryManifestStatus(rail);
  const manifestRow = (label, value) => `<div style="display:flex;align-items:baseline;gap:8px;"><span style="color:var(--muted);">${label}</span><span style="flex:1;border-bottom:1.5px dotted var(--dash);transform:translateY(-4px);"></span><span style="font-weight:700;">${value}</span></div>`;
  const railManifestHtml = `
    <div style="border:1.5px solid var(--ink);background:var(--card);padding:18px 20px;">
      <div style="display:flex;align-items:center;justify-content:space-between;font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;color:var(--muted);border-bottom:1px dashed var(--dash);padding-bottom:10px;margin-bottom:12px;"><span>·· RAIL MANIFEST ··</span><span>${esc(C.tickerLabel)}</span></div>
      <div style="display:flex;flex-direction:column;gap:9px;font-family:var(--font-mono);font-size:13px;">
        ${manifestRow("network", esc(C.caip2))}
        ${manifestRow("asset", esc(C.asset))}
        ${manifestRow("settle latency", esc(C.settleLatency))}
        ${manifestRow("facilitator", esc(C.facilitatorLabel))}
        ${manifestRow("gas", esc(C.gasNote))}
        <div style="display:flex;align-items:baseline;gap:8px;"><span style="color:var(--muted);">explorer</span><span style="flex:1;border-bottom:1.5px dotted var(--dash);transform:translateY(-4px);"></span><a href="${esc(walletExplorerUrl)}" rel="noopener" style="font-weight:700;color:var(--accent);text-decoration:none;">${esc(C.explorerUrl)} →</a></div>
        <div style="display:flex;align-items:baseline;gap:8px;"><span style="color:var(--muted);">daily canary</span><span style="flex:1;border-bottom:1.5px dotted var(--dash);transform:translateY(-4px);"></span><span style="font-weight:700;color:${canary.color};">${esc(canary.text)}</span></div>
      </div>
      <div style="margin-top:14px;padding-top:10px;border-top:1px dashed var(--dash);font-family:var(--font-mono);font-size:11px;color:var(--faint);line-height:1.6;">agents: GET /api/route?q=&lt;task&gt;&amp;network=${esc(C.networkParam)}</div>
    </div>`;

  // Switcher strip — one row per chain page that actually exists today
  // (base/solana are index-snapshot rails, not routes). Replaces the old
  // hand-written "sister market" line.
  const chainKeys = Object.keys(CHAIN_PAGES);
  const switcherHtml = `
<div style="border-bottom:1.5px solid var(--ink);background:var(--card);">
  <div style="max-width:1080px;margin:0 auto;padding:10px 24px;display:flex;align-items:center;gap:18px;flex-wrap:wrap;font-family:var(--font-mono);font-size:12px;">
    <span style="color:var(--faint);letter-spacing:.08em;">INDEX /</span>
    ${chainKeys.map((k) => {
      const active = k === chainKey;
      return `<a href="/${k}" style="text-decoration:none;color:${active ? "var(--ink)" : "var(--muted)"};font-weight:${active ? 700 : 400};border-bottom:2px solid ${active ? "var(--accent)" : "transparent"};padding-bottom:2px;">${esc(k)}</a>`;
    }).join("")}
    <a href="/index" style="text-decoration:none;color:var(--muted);margin-left:auto;">all chains →</a>
  </div>
</div>`;

  const subheadHtml = `Pay-per-call tools for AI agents - settled in ${esc(C.asset)} on ${esc(C.chainName)} in ${esc(C.settleLatency)}, no signup, no API keys. The wallet is the account.`;

  const headerHtml = `
  <div class="ml-2col" style="display:grid;grid-template-columns:1.15fr .85fr;gap:34px;align-items:start;">
    <div>
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:12px;">
        <span style="width:44px;height:44px;border:2px solid var(--ink);color:var(--ink);display:flex;align-items:center;justify-content:center;" title="${esc(C.chainName)}">${chainMark(chainKey, 26) || `<span style="font-family:var(--font-mono);font-weight:700;font-size:12px;">${esc(C.ticker)}</span>`}</span>
        <h1 style="font-size:34px;font-weight:800;letter-spacing:-.02em;margin:0;">The ${esc(C.chainName)} x402 marketplace</h1>
      </div>
      <p style="font-size:16.5px;color:var(--muted);margin:0;max-width:640px;">${subheadHtml}</p>
      <p style="font-size:13px;color:var(--faint);margin:6px 0 0;">An open index of the whole ${esc(C.chainName)} x402 economy - this host plus every independent seller the hourly crawl finds (CDP Bazaar included). Not a walled market: other venues' listings appear here too.</p>
      ${receiptHtml}
      <p style="font-size:13px;color:var(--faint);margin:4px 0 0;">${C.canaryLine}</p>
      ${statsHtml}
    </div>
    ${railManifestHtml}
  </div>`;

  const rosterHtml = `
  <h2 style="font-size:21px;font-weight:800;margin:40px 0 14px;border-bottom:1.5px solid var(--ink);padding-bottom:8px;">Sellers settling on ${esc(C.chainName)}</h2>
  <p style="font-size:13px;color:var(--faint);margin:-6px 0 12px;">pick a seller to scope the activity charts · THIS HOST = run by agent402 · every other seller is independent, found by the open crawl</p>
  ${compact
    ? `<div style="display:flex;flex-direction:column;gap:8px;">${sellersHtml}</div>`
    : `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px;">${sellersHtml}</div>`}
  ${honesty}`;

  const sellSectionHtml = `
  <h2 style="font-size:21px;font-weight:800;margin:40px 0 14px;border-bottom:1.5px solid var(--ink);padding-bottom:8px;">Sell on ${esc(C.chainName)}</h2>
  <div class="ml-2col" style="display:grid;grid-template-columns:1.1fr .9fr;gap:18px;align-items:start;">
    <div>
      <p style="font-size:14.5px;line-height:1.65;">${C.sellParagraphHtml}</p>
      ${formHtml}
    </div>
    <div style="background:var(--surface);border:1.5px solid var(--ink);">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 15px;border-bottom:1px solid var(--dark-border2);font-family:var(--font-mono);font-size:11px;color:var(--dk-muted);letter-spacing:.06em;"><span>402 challenge · accepts[]</span><span>JSON</span></div>
      <pre style="margin:0;padding:16px 18px;font-family:var(--font-mono);font-size:12px;line-height:1.8;color:var(--on-dark);white-space:pre-wrap;word-break:break-word;">{
  <span style="color:var(--dk-muted3);">"scheme"</span>: "exact",
  <span style="color:var(--dk-muted3);">"network"</span>: <span style="color:var(--accent);">"${esc(C.acceptNetwork)}"</span>,
  <span style="color:var(--dk-muted3);">"asset"</span>: "${esc(C.asset)}",
  <span style="color:var(--dk-muted3);">"payTo"</span>: "your-wallet"
}</pre>
    </div>
  </div>`;

  const body = `
${switcherHtml}
<div style="max-width:1080px;margin:0 auto;padding:36px 24px;">
  ${headerHtml}
  ${marketActivityHtml(chainKey, activity, selectedSeller)}

  ${rosterHtml}

  <h2 style="font-size:21px;font-weight:800;margin:40px 0 14px;border-bottom:1.5px solid var(--ink);padding-bottom:8px;">Browse ${esc(C.chainName)}-payable tools</h2>
  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px;">${groupsHtml}</div>
  <p style="font-family:var(--font-mono);font-size:13px;background:#EDEDEB;padding:10px 14px;margin:16px 0 0;">agents: GET ${esc(baseUrl)}/api/route?q=&lt;task&gt;&amp;network=${esc(C.networkParam)}</p>

  ${sellSectionHtml}

  <p style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin-top:28px;">machine-readable: <a href="/api/route?q=hash&amp;network=${esc(C.networkParam)}">/api/route?network=${esc(C.networkParam)}</a> · <a href="/.well-known/x402">/.well-known/x402</a> · <a href="/openapi.json">/openapi.json</a> · <a href="/api/reliability">/api/reliability</a></p>
</div>
${ledgerFooterCompact()}`;

  return ledgerShell({
    title: `The ${C.chainName} x402 marketplace - pay-per-call tools for AI agents`,
    description: `The ${C.chainName} x402 marketplace: ${tools.length} pay-per-call tools for AI agents, settled in ${C.asset} on ${C.chainName}. No signup, no API keys - the wallet is the account.`,
    canonical: `${baseUrl}/${chainKey}`,
    baseUrl,
    activePath: `/${chainKey}`,
    jsonLd,
    body,
  });
}
