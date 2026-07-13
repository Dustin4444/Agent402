// Offline unit tests for the five newest x402 marketplace pages (/base,
// /solana, /polygon, /arbitrum, /robinhood) — the chain-agnostic renderer in
// src/market-page.js already covers /stellar and /algorand (see
// scripts/test-stellar-page.js / test-algorand-page.js); this file locks
// down the CHAIN_PAGES entries added alongside them. No server, no network.
import { marketSellers, marketPage, CHAIN_PAGES } from "../src/market-page.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

const localTools = [
  { slug: "hash", name: "Hash", category: "encoding", price: 0.001 },
  { slug: "search", name: "Web search", category: "search", price: 0.01 },
];
const LOCAL = { origin: "self", displayName: "Agent402.Tools", homepage: "https://agent402.tools", local: true, toolCount: 2, tools: localTools };

// Per-chain fixtures: mainnet CAIP-2, a corresponding testnet/devnet id that
// must NOT qualify a seller, expected asset + explorer domain, and a fixture
// wallet (these five chains carry no committed public default in
// CHAIN_PAGES — the real address is a Railway secret — so effectiveWallet
// only ever comes from what the route passes).
const NEW_CHAINS = [
  { key: "base", network: "eip155:8453", offNetwork: "eip155:84532", asset: "USDC", explorer: "basescan.org", wallet: "0x1111111111111111111111111111111111111111" },
  { key: "solana", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", offNetwork: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", asset: "USDC", explorer: "solscan.io", wallet: "9EMAayAfBR32J5d3ApEAG3NdKArRBtAqN7LA8c2WRM5o" },
  { key: "polygon", network: "eip155:137", offNetwork: "eip155:80002", asset: "USDC", explorer: "polygonscan.com", wallet: "0x2222222222222222222222222222222222222222" },
  { key: "arbitrum", network: "eip155:42161", offNetwork: "eip155:421614", asset: "USDC", explorer: "arbiscan.io", wallet: "0x3333333333333333333333333333333333333333" },
  { key: "robinhood", network: "eip155:4663", offNetwork: "eip155:99999", asset: "USDG", explorer: "robinhoodchain.blockscout.com", wallet: "0x4444444444444444444444444444444444444444" },
];

// 1. All 7 chain pages exist in CHAIN_PAGES (stellar/algorand plus the 5 new).
ok(Object.keys(CHAIN_PAGES).length === 8, `CHAIN_PAGES has 8 entries (got ${Object.keys(CHAIN_PAGES).length})`);
for (const c of NEW_CHAINS) ok(!!CHAIN_PAGES[c.key], `CHAIN_PAGES has a "${c.key}" entry`);

for (const c of NEW_CHAINS) {
  const EXT = { origin: "https://ext1.example", displayName: "Ext One", homepage: "https://ext1.example", local: false, toolCount: 3, routable: true, networks: [c.network] };
  const snapshot = { sellers: [LOCAL, EXT], totals: { sellers: 2 } };
  const rail = { recent: [{ tx: "https://example.com/tx/abc123", when: "2026-07-10T04:15:00Z", usd: 0.001, from: "0xabc" }] };
  const html = marketPage(c.key, "https://agent402.tools", { snapshot, rail, activity: null, wallet: c.wallet });

  ok(html.includes(`The ${CHAIN_PAGES[c.key].chainName} x402 marketplace`), `${c.key}: renders with the correct title`);
  ok(html.includes(`>${c.asset}<`) || html.includes(`${c.asset} on ${CHAIN_PAGES[c.key].chainName}`), `${c.key}: settles in ${c.asset}`);
  ok(html.includes(c.explorer), `${c.key}: correct explorer domain (${c.explorer}) rendered`);
  ok(html.includes("example.com/tx/abc123"), `${c.key}: real receipt tx link rendered, never invented`);

  // Network filter: the offNetwork (testnet/devnet) id must not qualify a
  // seller, and mainnet must.
  ok(marketSellers(c.key, snapshot).length === 2, `${c.key}: mainnet-network seller qualifies`);
  const offSnap = { sellers: [LOCAL, { ...EXT, networks: [c.offNetwork] }] };
  ok(marketSellers(c.key, offSnap).length === 1, `${c.key}: off-network (testnet/devnet) seller excluded`);

  // Null-activity honesty line: no scan yet for these chains, but the
  // caption must name THIS chain's explorer, never a hardcoded one.
  ok(html.includes("activity scan temporarily unavailable"), `${c.key}: honest null-activity line renders`);
  ok(!html.includes("stellar.expert") && !html.includes("allo.info"), `${c.key}: no leaked reference to another chain's explorer`);
}

// Per-seller activity scoping — the roster's "pick a seller to scope the charts"
// feature. Regression guard for the /base…/arbitrum/solana route that used to
// ignore ?seller= entirely (rendered THIS HOST no matter which seller you
// clicked). marketPage must honor selectedSeller: an external pick re-scopes the
// Activity label to the seller's host and its note names the seller's payTo; a
// local pick stays on THIS HOST; and an external pick with no scannable activity
// shows the honest per-seller "unavailable" line instead of the host's charts.
{
  const EXT = { origin: "https://ext1.example", displayName: "Ext One", homepage: "https://ext1.example", local: false, toolCount: 3, routable: true, networks: ["eip155:8453"], payToByNetwork: { "eip155:8453": "0xabc0000000000000000000000000000000000abc" } };
  const snapshot = { sellers: [LOCAL, EXT] };
  const activity = { days: 30, buckets: [{ date: "2026-07-10", tx: 2, usd: 0.5, buyers: 1 }], totals: { tx: 2, usd: 0.5, buyers: 1 } };
  const base = (sel, act) => marketPage("base", "https://agent402.tools", { snapshot, rail: null, activity: act, selectedSeller: sel, wallet: "0x1111111111111111111111111111111111111111" });

  ok(/EXT1\.EXAMPLE · PAST 30 DAYS/.test(base({ local: false, host: "ext1.example", name: "Ext One" }, activity)), "base: external selectedSeller re-scopes the Activity label to the seller host");
  ok(base({ local: false, host: "ext1.example", name: "Ext One" }, activity).includes("this seller's advertised x402 payTo wallet"), "base: external scope note names the seller's payTo, not the host wallet");
  ok(/THIS HOST · PAST 30 DAYS/.test(base({ local: true }, activity)), "base: local selection keeps the Activity label on THIS HOST");
  ok(base({ local: false, host: "ext1.example", name: "Ext One" }, null).includes("activity unavailable for this seller"), "base: external pick with no scannable activity shows the honest per-seller unavailable line");
  // marketSellers passes payToByNetwork through so the route can resolve a
  // seller's on-chain address for the scan.
  const sellers = marketSellers("base", snapshot);
  ok(sellers.find((s) => !s.local)?.payToByNetwork?.["eip155:8453"] === "0xabc0000000000000000000000000000000000abc", "base: marketSellers exposes payToByNetwork for the route's activity scan");
}

// Robinhood is the one non-USDC rail — asset must read USDG everywhere, and
// USDC must never leak onto its page.
{
  const snapshot = { sellers: [LOCAL] };
  const html = marketPage("robinhood", "https://agent402.tools", { snapshot, rail: null, activity: null, wallet: "0x4444444444444444444444444444444444444444" });
  ok(html.includes("USDG"), "robinhood: USDG asset present");
  // Scoped to the page's own rail manifest + 402 accept sample - the shared
  // site chrome (ledgerShell's sitewide JSON-LD) legitimately mentions USDC
  // for the other six rails, so a blanket absence check would be wrong.
  ok(html.includes('"asset"</span>: "USDG"'), "robinhood: 402 accept sample carries USDG, not USDC");
  const manifestIdx = html.indexOf("RAIL MANIFEST");
  const manifestBlock = html.slice(manifestIdx, manifestIdx + 900);
  ok(manifestBlock.includes("USDG") && !manifestBlock.includes("USDC"), "robinhood: rail manifest asset row reads USDG, never USDC");
}

// Solana devnet specifically — the fact called out in the task: a devnet
// genesis-hash seller must never count as a mainnet Solana seller.
{
  const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
  const devnetSnap = { sellers: [LOCAL, { origin: "https://d.example", displayName: "Devnet Only", homepage: "https://d.example", local: false, networks: [SOLANA_DEVNET] }] };
  ok(marketSellers("solana", devnetSnap).length === 1, "solana: devnet-only seller excluded, only local qualifies");
}

// No wallet passed and no config default (these 5 have none) — the explorer
// link must fall back to the bare domain, never literally render "undefined".
{
  const html = marketPage("arbitrum", "https://agent402.tools", { snapshot: { sellers: [LOCAL] }, rail: null, activity: null });
  ok(!html.includes("undefined"), "arbitrum: missing wallet never renders the literal string 'undefined'");
  ok(html.includes('href="https://arbiscan.io"'), "arbitrum: explorer link falls back to the bare domain without a wallet");
}

// Switcher strip lists all 7 chains, with the current page marked active.
{
  const html = marketPage("base", "https://agent402.tools", { snapshot: { sellers: [LOCAL] }, rail: null, activity: null });
  for (const key of Object.keys(CHAIN_PAGES)) ok(html.includes(`href="/${key}"`), `switcher strip links to /${key}`);
  ok(/base<\/a>/.test(html) && html.includes("var(--accent)"), "switcher strip marks the active chain");
}

// Provenance / sell-side copy is genuinely per-chain, not copy-pasted.
{
  const baseHtml = marketPage("base", "https://agent402.tools", { snapshot: { sellers: [LOCAL] }, rail: null, activity: null });
  ok(baseHtml.includes("Coinbase CDP"), "base: sell copy names the Coinbase CDP facilitator");
  const solanaHtml = marketPage("solana", "https://agent402.tools", { snapshot: { sellers: [LOCAL] }, rail: null, activity: null });
  ok(solanaHtml.includes("@x402/svm"), "solana: sell copy names the SVM scheme package");
  const robinhoodHtml = marketPage("robinhood", "https://agent402.tools", { snapshot: { sellers: [LOCAL] }, rail: null, activity: null });
  ok(robinhoodHtml.includes("ROBINHOOD_FACILITATOR_URL"), "robinhood: sell copy names the operator-supplied facilitator env");
  ok(baseHtml !== solanaHtml && solanaHtml !== robinhoodHtml, "provenance/sell copy differs page to page, not templated identically");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
