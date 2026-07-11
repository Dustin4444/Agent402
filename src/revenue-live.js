// Live consolidated revenue view — one page instead of three explorer tabs.
//
// /api/revenue (JSON) + /revenue (HTML) read, server-side and best-effort,
// every rail's wallet balance and the recent inbound stablecoin transfers:
// Base / Polygon / Arbitrum / Robinhood Chain via public-RPC eth_getLogs
// (same approach as scripts/revenue-scan.js), Solana via
// getTokenAccountsByOwner. Results are cached for 60s so a page refresh is
// instant and public RPCs see at most one scan a minute; a flaky chain shows
// "unavailable" for that rail instead of breaking the page. Balances and
// transfers are public on-chain data — this page just saves the tab-cycling.
import { ledgerShell, ledgerFooterCompact } from "./ledger-chrome.js";
import { RAILS, RAILS_AMP } from "./rails.js";
// Pure, main-guarded helpers shared with the daily scanners — one
// classification rule everywhere: a transfer is external revenue only if the
// payer isn't one of OUR wallets (canary/test burners) AND the amount is a
// plausible per-call price. Internal test money is shown but never counted.
import { usdcDeltaForOwner, payerFromMeta, isExternalPayment } from "../scripts/revenue-scan-solana.js";

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const USDC_SOL_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Same envs (and defaults) as scripts/revenue-scan{,-solana}.js.
export const MAX_CALL_USD = parseFloat(process.env.MAX_CALL_USD || "0.5");
export const OUR_EVM_WALLETS = new Set(
  (process.env.OUR_WALLETS || "0xfeda7403aabe9a492ed70e810b396d8548a4a022")
    .toLowerCase().split(",").map((s) => s.trim()).filter(Boolean)
);
// Default = the canary's Solana burner (public address; the key lives only
// in CI secrets) — its daily $0.05 self-buys are internal, not revenue.
export const OUR_SOLANA_WALLETS = new Set(
  (process.env.OUR_SOLANA_WALLETS || "9EMAayAfBR32J5d3ApEAG3NdKArRBtAqN7LA8c2WRM5o")
    .split(",").map((s) => s.trim()).filter(Boolean)
);
// Same convention for Stellar: the canary burner's public address is committed;
// extend via env (comma-separated) if other internal wallets settle here.
export const OUR_STELLAR_WALLETS = new Set(
  (process.env.OUR_STELLAR_WALLETS || "GBA2DDJ4KQXQCGNB7RUU5I2BK5SXROJFUNZV7EZ4XUS7RXFOXEPNY6O4")
    .split(",").map((s) => s.trim()).filter(Boolean)
);
// Same convention for Algorand: the canary burner's public address is
// committed; extend via env (comma-separated) if other internal wallets
// settle here.
export const OUR_ALGORAND_WALLETS = new Set(
  (process.env.OUR_ALGORAND_WALLETS || "ZKFACAZATPUUYUXVVVE7QWMMZTSMLGQVA4G4QKW7D2UI7FCIFE3QB2SHRE")
    .split(",").map((s) => s.trim()).filter(Boolean)
);

// Chain read-config. Stablecoin contracts mirror scripts/revenue-scan.js;
// span ≈ a few hours of blocks so "recent inbound" stays a cheap filtered read.
export const EVM = {
  base: {
    label: "Base", asset: "USDC", span: 30000,
    token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    rpcs: [
      ...(process.env.ALCHEMY_API_KEY ? [`https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`] : []),
      "https://mainnet.base.org", "https://base.llamarpc.com", "https://base.drpc.org",
    ],
    explorer: (a) => `https://basescan.org/address/${a}#tokentxns`,
    tx: (h) => `https://basescan.org/tx/${h}`,
  },
  polygon: {
    label: "Polygon", asset: "USDC", span: 20000,
    token: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
    // Alchemy first (reliable getLogs); free RPCs fail on historical queries.
    rpcs: [
      ...(process.env.ALCHEMY_API_KEY ? [`https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`] : []),
      "https://polygon.drpc.org", "https://polygon.llamarpc.com", "https://polygon-rpc.com",
    ],
    explorer: (a) => `https://polygonscan.com/address/${a}#tokentxns`,
    tx: (h) => `https://polygonscan.com/tx/${h}`,
  },
  arbitrum: {
    label: "Arbitrum", asset: "USDC", span: 90000,
    token: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    rpcs: [
      ...(process.env.ALCHEMY_API_KEY ? [`https://arb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`] : []),
      "https://arb1.arbitrum.io/rpc", "https://arbitrum.llamarpc.com", "https://arbitrum.drpc.org",
    ],
    explorer: (a) => `https://arbiscan.io/address/${a}#tokentxns`,
    tx: (h) => `https://arbiscan.io/tx/${h}`,
  },
  robinhood: {
    // Measured ~0.15s blocks (not the 2s Orbit default) — 30k blocks was only
    // ~76 real minutes; 600k ≈ 25h so the daily canary settle stays visible.
    label: "Robinhood Chain", asset: "USDG", span: 600000,
    token: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    rpcs: [
      ...(process.env.ALCHEMY_API_KEY ? [`https://robinhood-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`] : []),
      "https://rpc.mainnet.chain.robinhood.com",
    ],
    explorer: (a) => `https://robinhoodchain.blockscout.com/address/${a}`,
    tx: (h) => `https://robinhoodchain.blockscout.com/tx/${h}`,
  },
};
// Fallback matters: the card's per-tx decodes and the all-time ledger's
// backfill share these endpoints, and the public mainnet-beta RPC 429s under
// that contention — without a second lane the card loses its amount/external
// tags whenever the ledger is paging. Same list + env override as
// scripts/revenue-scan-solana.js.
// Alchemy first when the key is set (same key as the EVM rails) — it serves
// Solana JSON-RPC from a datacenter-reachable endpoint, so the balance read
// stops timing out against the rate-limited public RPCs. The publics stay as
// fallbacks (rpcCall walks the list on error/timeout).
export const SOLANA_RPCS = (process.env.SOLANA_RPCS || [
  ...(process.env.ALCHEMY_API_KEY ? [`https://solana-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`] : []),
  "https://api.mainnet-beta.solana.com",
  "https://solana-rpc.publicnode.com",
].join(",")).split(",").map((s) => s.trim()).filter(Boolean);

// Stellar/Algorand REST endpoints. Alchemy doesn't serve these chains, so each
// keeps a public primary plus a second independent provider (both verified
// live), walked on error/timeout. Comma-separated env overrides let ops drop in
// a keyed/dedicated RPC with no code change - "plenty of RPCs" on tap.
export const STELLAR_HORIZON_URLS = (process.env.STELLAR_HORIZON_URLS ||
  "https://horizon.stellar.org,https://horizon.stellar.lobstr.co"
).split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
export const ALGORAND_ALGOD_URLS = (process.env.ALGORAND_ALGOD_URLS ||
  "https://mainnet-api.algonode.cloud,https://mainnet-api.4160.nodely.dev"
).split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
export const ALGORAND_INDEXER_URLS = (process.env.ALGORAND_INDEXER_URLS ||
  "https://mainnet-idx.algonode.cloud,https://mainnet-idx.4160.nodely.dev"
).split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);

// GET JSON across a list of base URLs, walking to the next on any failure
// (network / timeout / non-2xx). Returns the first success (or the last
// failure) as { ok, status, json, base }. The 10s default deadline (up from
// 6s) is deliberate: these public endpoints are slow-but-working from Railway's
// datacenter IP, not dead, and the short timeout was the main cause of the
// "unreachable" flapping. okStatuses lets a caller treat e.g. 404 (Algorand
// fresh-wallet, no ASA opt-in) as a valid non-error response.
export async function getJsonAcross(bases, path, { timeoutMs = 10000, okStatuses = [] } = {}) {
  let last = { ok: false, status: 0, json: null, base: null, error: "no endpoints" };
  for (const base of bases) {
    if (!base) continue;
    try {
      const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok || okStatuses.includes(res.status)) {
        let json = null;
        try { json = await res.json(); } catch { /* an ok-status body may be empty (404) */ }
        return { ok: true, status: res.status, json, base };
      }
      last = { ok: false, status: res.status, json: null, base, error: `HTTP ${res.status}` };
    } catch (e) {
      last = { ok: false, status: 0, json: null, base, error: String(e?.message || e).slice(0, 120) };
    }
  }
  return last;
}

export const pad = (a) => "0x" + "0".repeat(24) + a.toLowerCase().replace(/^0x/, "");

export async function rpcCall(urls, method, params, timeoutMs = 5000) {
  let lastErr;
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const j = await r.json();
      if (j.result !== undefined) return j.result;
      lastErr = new Error(JSON.stringify(j.error ?? j).slice(0, 120));
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("all RPCs failed");
}

// One eth_getLogs over the whole span trips free-RPC range/"archive" caps
// (that's an RPC-provider upsell, not a real constraint), so the transfer
// scan walks BACKWARD from the head in chunks — newest first, early stop once
// 8 transfers are in hand, hard 12s budget. Chunks are capped at 9,000 blocks
// (Alchemy rejects getLogs ranges over 10k on some chains — Robinhood,
// verified 2026-07-08) with a minimum of 4. A failed chunk is a partial
// window, never an error: the balance (a cheap head read) stays up and the
// card says the scan was partial instead of parroting vendor text.
async function recentInbound(c, wallet, latest) {
  const LOG_CHUNKS = Math.max(4, Math.ceil(c.span / 9000));
  const chunk = Math.ceil(c.span / LOG_CHUNKS);
  const deadline = Date.now() + 12_000;
  const logs = [];
  let missed = 0;
  for (let i = 0; i < LOG_CHUNKS && logs.length < 8 && Date.now() < deadline; i++) {
    const to = latest - i * chunk;
    if (to <= 0) break;
    const from = Math.max(0, to - chunk + 1);
    // One retry per failed chunk (budget permitting): the newest chunk holds
    // the most recent settles, and a single transient RPC failure there made
    // the card show "no inbound transfers" for a full snapshot TTL even
    // though the canary had just settled (observed 2026-07-08 on Polygon).
    const attemptChunk = () => rpcCall(c.rpcs, "eth_getLogs", [{
      address: c.token,
      topics: [TRANSFER_TOPIC, null, pad(wallet)],
      fromBlock: "0x" + from.toString(16),
      toBlock: "0x" + to.toString(16),
    }], 4000);
    try {
      let part;
      try {
        part = await attemptChunk();
      } catch (e1) {
        if (Date.now() + 4500 > deadline) throw e1; // no budget left for a retry
        part = await attemptChunk();
      }
      if (Array.isArray(part)) logs.push(...part);
    } catch {
      missed++;
    }
  }
  const recent = logs
    .map((l) => {
      const usd = Number(BigInt(l.data && l.data !== "0x" ? l.data : "0x0")) / 1e6;
      const from = l.topics?.[1] ? ("0x" + l.topics[1].slice(-40)).toLowerCase() : null;
      return {
        usd, from,
        tx: c.tx(l.transactionHash),
        block: parseInt(l.blockNumber, 16),
        external: isExternalPayment({ payer: from, usd }, { ourWallets: OUR_EVM_WALLETS, maxUsd: MAX_CALL_USD }),
        internal: from != null && OUR_EVM_WALLETS.has(from),
      };
    })
    .sort((a, b) => b.block - a.block)
    .slice(0, 8);
  // Best-effort block timestamps — one RPC call per transfer (8 max).
  for (const t of recent) {
    try {
      const blk = await rpcCall(c.rpcs, "eth_getBlockByNumber", ["0x" + t.block.toString(16), false], 3000);
      if (blk?.timestamp) t.when = new Date(parseInt(blk.timestamp, 16) * 1000).toISOString();
    } catch { /* timestamp is nice-to-have, not required */ }
  }
  return { recent, missed, chunks: LOG_CHUNKS };
}

async function evmRail(name, wallet) {
  const c = EVM[name];
  const out = { rail: c.label, asset: c.asset, wallet: wallet || null, explorer: wallet ? c.explorer(wallet) : null, balance: null, recent: [], error: null, scanNote: null };
  if (!wallet) { out.error = "WALLET_ADDRESS unset"; return out; }
  try {
    const balHex = await rpcCall(c.rpcs, "eth_call", [{ to: c.token, data: "0x70a08231" + pad(wallet).slice(2) }, "latest"]);
    out.balance = Number(BigInt(balHex && balHex !== "0x" ? balHex : "0x0")) / 1e6;
    const latest = parseInt(await rpcCall(c.rpcs, "eth_blockNumber", []), 16);
    const { recent, missed, chunks } = await recentInbound(c, wallet, latest);
    out.recent = recent;
    out.externalUsd = Number(recent.filter((t) => t.external).reduce((s, t) => s + t.usd, 0).toFixed(6));
    out.windowBlocks = c.span;
    if (missed) out.scanNote = `transfer scan partial: ${missed}/${chunks} windows unavailable from public RPCs (balance is live)`;
  } catch (e) {
    out.error = String(e?.message || e).slice(0, 120);
  }
  return out;
}

// The EVM rails bound "recent" by a block window; Solana (last 6 signatures)
// and Stellar (Horizon's last 10 payment ops) are bounded by COUNT — entries
// can be arbitrarily old. The per-rail externalUsd (and therefore the site
// total) must not count stale history as in-window revenue: sum only entries
// younger than this. Display still lists the older entries with honest tags.
const RECENT_WINDOW_MS = 24 * 3600 * 1000;
const inWindow = (t) => t.when != null && Date.now() - Date.parse(t.when) <= RECENT_WINDOW_MS;

async function solanaRail(wallet) {
  const out = { rail: "Solana", asset: "USDC", wallet: wallet || null, explorer: wallet ? `https://solscan.io/account/${wallet}` : null, balance: null, recent: [], error: null };
  if (!wallet) { out.error = "SOLANA_WALLET_ADDRESS unset"; return out; }
  try {
    const res = await rpcCall(SOLANA_RPCS, "getTokenAccountsByOwner", [wallet, { mint: USDC_SOL_MINT }, { encoding: "jsonParsed" }], 6000);
    out.balance = (res?.value || []).reduce((s, a) => s + (a?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0), 0);
    // Query the TOKEN ACCOUNT for signatures (not the wallet) — USDC transfers
    // hit the associated token account, not the owner address.
    const tokenAccount = res?.value?.[0]?.pubkey || wallet;
    const sigs = await rpcCall(SOLANA_RPCS, "getSignaturesForAddress", [tokenAccount, { limit: 6 }], 6000);
    // Decode each recent tx's USDC delta + payer (same helpers as the daily
    // scanner) so internal test money classifies here too. Best-effort under
    // a budget — an undecodable tx stays a bare signature link.
    const deadline = Date.now() + 12_000;
    out.recent = [];
    for (const s of Array.isArray(sigs) ? sigs : []) {
      const item = {
        tx: `https://solscan.io/tx/${s.signature}`,
        when: s.blockTime ? new Date(s.blockTime * 1000).toISOString() : null,
        err: s.err ? true : false,
      };
      if (!s.err && Date.now() < deadline) {
        try {
          const txn = await rpcCall(SOLANA_RPCS, "getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }], 5000);
          const usd = Number(usdcDeltaForOwner(txn?.meta, wallet).toFixed(6));
          if (usd > 0) {
            item.usd = usd;
            item.from = payerFromMeta(txn?.meta, wallet);
            item.external = isExternalPayment({ payer: item.from, usd }, { ourWallets: OUR_SOLANA_WALLETS, maxUsd: MAX_CALL_USD });
            item.internal = item.from != null && OUR_SOLANA_WALLETS.has(item.from);
          }
        } catch { /* leave as a bare signature link */ }
      }
      out.recent.push(item);
    }
    out.externalUsd = Number(out.recent.filter((t) => t.external && inWindow(t)).reduce((s, t) => s + t.usd, 0).toFixed(6));
  } catch (e) {
    out.error = String(e?.message || e).slice(0, 120);
  }
  return out;
}

// Stellar — read USDC balance + recent payments via Horizon API.
export const USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

// Parse one Horizon payment-ish record into { tx, when, usd, from } — or null
// when it isn't an inbound canonical-issuer USDC transfer to `wallet`.
// x402 settlements are invoke_host_function (Soroban); wallet funding can be
// path_payment_strict_send or payment. Issuer check, not just code: anyone can
// issue an asset named "USDC" and pay the wallet to fake revenue on the card.
export function parseStellarPayment(r, wallet) {
  if (r.type === "payment" || r.type === "path_payment_strict_send" || r.type === "path_payment_strict_receive") {
    if (r.to !== wallet) return null;
    if (r.asset_code !== "USDC" || r.asset_issuer !== USDC_ISSUER) return null;
    return {
      tx: `https://stellar.expert/explorer/public/tx/${r.transaction_hash}`,
      when: r.created_at || null,
      usd: Number(r.amount) || 0,
      from: r.from || null,
    };
  }
  if (r.type === "invoke_host_function") {
    // Soroban x402 settlement — the operation itself carries no amount/asset,
    // but Horizon attaches asset_balance_changes with the real SEP-41
    // transfer. NOTE: r.source_account is the facilitator's fee-sponsoring
    // channel account, NOT the payer — the balance change's `from` is the
    // actual buying wallet.
    const changes = (r.asset_balance_changes || []).filter(
      (c) => c.type === "transfer" && c.to === wallet && c.asset_code === "USDC" && c.asset_issuer === USDC_ISSUER
    );
    if (!changes.length) return null; // touched the wallet but paid it nothing
    return {
      tx: `https://stellar.expert/explorer/public/tx/${r.transaction_hash}`,
      when: r.created_at || null,
      usd: Number(changes.reduce((s, c) => s + Number(c.amount || 0), 0).toFixed(7)),
      from: changes[0].from || null,
    };
  }
  return null;
}

// Fold parsed payment entries into per-UTC-day buckets over a trailing window.
// Pure — `now` is injectable so tests are deterministic. Buyers are unique
// `from` wallets (per day in each bucket, across the window in totals).
export function bucketStellarActivity(entries, { days = 30, now = Date.now() } = {}) {
  const DAY = 86_400_000;
  const buckets = [];
  const byDate = new Map();
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now - i * DAY).toISOString().slice(0, 10);
    const b = { date, tx: 0, usd: 0, buyers: new Set() };
    buckets.push(b);
    byDate.set(date, b);
  }
  const allBuyers = new Set();
  const totals = { tx: 0, usd: 0, buyers: 0, internalTx: 0, internalUsd: 0 };
  for (const e of entries) {
    const t = Date.parse(e?.when || "");
    if (!Number.isFinite(t)) continue;
    const b = byDate.get(new Date(t).toISOString().slice(0, 10));
    if (!b) continue; // outside the window
    b.tx += 1;
    b.usd += e.usd || 0;
    if (e.from) { b.buyers.add(e.from); allBuyers.add(e.from); }
    totals.tx += 1;
    totals.usd += e.usd || 0;
    if (e.internal) { totals.internalTx += 1; totals.internalUsd += e.usd || 0; }
  }
  totals.usd = Number(totals.usd.toFixed(6));
  totals.internalUsd = Number(totals.internalUsd.toFixed(6));
  totals.buyers = allBuyers.size;
  return {
    days,
    buckets: buckets.map((b) => ({ date: b.date, tx: b.tx, usd: Number(b.usd.toFixed(6)), buyers: b.buyers.size })),
    totals,
  };
}

// Trailing-window activity scan: page Horizon's payments feed back `days`
// days (newest first, `maxPages` × 200 records cap — a busy wallet sets
// `truncated: true` and the totals are an honest floor, never an estimate).
export async function stellarActivity(wallet, { days = 30, maxPages = 10 } = {}) {
  const out = { rail: "Stellar", wallet: wallet || null, days, buckets: [], totals: { tx: 0, usd: 0, buyers: 0, internalTx: 0, internalUsd: 0 }, truncated: false, error: null };
  if (!wallet) { out.error = "STELLAR_WALLET_ADDRESS unset"; return out; }
  const ours = new Set([...OUR_STELLAR_WALLETS, wallet]);
  const cutoff = Date.now() - days * 86_400_000;
  const entries = [];
  try {
    let url = `https://horizon.stellar.org/accounts/${wallet}/payments?order=desc&limit=200`;
    for (let page = 0; page < maxPages && url; page++) {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) { out.error = `Horizon HTTP ${res.status}`; return out; }
      const data = await res.json();
      const records = data?._embedded?.records || [];
      if (!records.length) { url = null; break; }
      let pastWindow = false;
      for (const r of records) {
        const t = Date.parse(r?.created_at || "");
        if (Number.isFinite(t) && t < cutoff) { pastWindow = true; break; }
        const entry = parseStellarPayment(r, wallet);
        if (!entry) continue;
        entry.internal = entry.from != null && ours.has(entry.from);
        entries.push(entry);
      }
      if (pastWindow) { url = null; break; }
      // Only follow Horizon's own cursor links — never an arbitrary URL from
      // a response body.
      const next = data?._links?.next?.href || "";
      url = next.startsWith("https://horizon.stellar.org/") ? next : null;
      if (url && page === maxPages - 1) out.truncated = true;
    }
  } catch (e) {
    out.error = String(e?.message || e).slice(0, 120);
    return out;
  }
  const bucketed = bucketStellarActivity(entries, { days });
  out.buckets = bucketed.buckets;
  out.totals = bucketed.totals;
  return out;
}
export async function stellarRail(wallet) {
  const out = { rail: "Stellar", asset: "USDC", wallet: wallet || null, explorer: wallet ? `https://stellar.expert/explorer/public/account/${wallet}` : null, balance: null, recent: [], error: null };
  if (!wallet) { out.error = "STELLAR_WALLET_ADDRESS unset"; return out; }
  try {
    // Balance - walk Horizon providers (primary + fallback) on timeout/error.
    const bal = await getJsonAcross(STELLAR_HORIZON_URLS, `/accounts/${wallet}`);
    if (!bal.ok) { out.error = bal.error || `Horizon HTTP ${bal.status}`; return out; }
    const acct = bal.json;
    const usdcBalance = acct.balances?.find((b) => b.asset_code === "USDC" && b.asset_issuer === USDC_ISSUER);
    out.balance = usdcBalance ? Number(usdcBalance.balance) : 0;
    // Recent payments (incoming USDC) - prefer the provider the balance read
    // succeeded on, then the rest of the list.
    try {
      const pay = await getJsonAcross([bal.base, ...STELLAR_HORIZON_URLS], `/accounts/${wallet}/payments?order=desc&limit=10`);
      if (pay.ok) {
        const records = pay.json?._embedded?.records || [];
        // Internal = the committed canary burner set + this wallet itself
        // (self-transfers/funding moves are never external revenue).
        const ours = new Set([...OUR_STELLAR_WALLETS, wallet]);
        for (const r of records) {
          const entry = parseStellarPayment(r, wallet);
          if (!entry) continue;
          entry.external = isExternalPayment({ payer: entry.from, usd: entry.usd }, { ourWallets: ours, maxUsd: MAX_CALL_USD });
          entry.internal = entry.from != null && ours.has(entry.from);
          out.recent.push(entry);
        }
      }
      // Same aggregation the EVM and Solana rails do: sum the per-call-sized
      // external inbound so the card's "external in window" line and the
      // site-wide windowExternalUsd total include Stellar.
      out.externalUsd = Number(out.recent.filter((t) => t.external && inWindow(t)).reduce((s, t) => s + (t.usd || 0), 0).toFixed(6));
    } catch { /* payment scan is best-effort */ }
  } catch (e) {
    out.error = String(e?.message || e).slice(0, 120);
  }
  return out;
}

// Algorand — read USDC balance + recent inbound ASA transfers via AlgoNode's
// free algod (balance) and indexer (transaction history) endpoints, both
// keyless. USDC is ASA 31566704 (6 decimals); explorer links go to allo.info.
export async function algorandRail(wallet) {
  const out = { rail: "Algorand", asset: "USDC", wallet: wallet || null, explorer: wallet ? `https://allo.info/account/${wallet}` : null, balance: null, recent: [], error: null };
  if (!wallet) { out.error = "ALGORAND_WALLET_ADDRESS unset"; return out; }
  try {
    // Balance - walk algod providers (primary + fallback) on timeout/error.
    const bal = await getJsonAcross(ALGORAND_ALGOD_URLS, `/v2/accounts/${wallet}`, { okStatuses: [404] });
    if (bal.status === 404) {
      // A fresh wallet that has never opted in to ASA 31566704 is a valid
      // state, not an error — it just holds no USDC (and can't be paid until
      // it opts in).
      out.balance = 0;
    } else if (!bal.ok) {
      out.error = bal.error || `algod HTTP ${bal.status}`;
      return out;
    } else {
      const acct = bal.json;
      const usdcAsset = (acct.assets || []).find((a) => a["asset-id"] === 31566704);
      out.balance = usdcAsset ? Number(usdcAsset.amount) / 1e6 : 0;
    }
    // Recent inbound USDC transfers (indexer) - walk indexer providers too.
    try {
      const tx = await getJsonAcross(ALGORAND_INDEXER_URLS, `/v2/accounts/${wallet}/transactions?asset-id=31566704&tx-type=axfer&limit=10`);
      if (tx.ok) {
        const txData = tx.json;
        // Internal = the committed canary burner set + this wallet itself
        // (self-transfers/funding moves are never external revenue).
        const ours = new Set([...OUR_ALGORAND_WALLETS, wallet]);
        for (const t of txData?.transactions || []) {
          const xfer = t["asset-transfer-transaction"];
          // Defense in depth, matching stellarRail's issuer check: re-verify
          // the ASA id per record even though the URL already filters
          // asset-id=31566704 — a filter regression/typo must not let a
          // fake-ASA airdrop count as revenue.
          if (!xfer || xfer["asset-id"] !== 31566704 || xfer.receiver !== wallet) continue; // inbound only, real USDC only
          const usd = Number(xfer.amount) / 1e6;
          const entry = {
            tx: `https://allo.info/tx/${t.id}`,
            when: t["round-time"] ? new Date(t["round-time"] * 1000).toISOString() : null,
            usd,
            from: t.sender || null,
          };
          entry.external = isExternalPayment({ payer: entry.from, usd }, { ourWallets: ours, maxUsd: MAX_CALL_USD });
          entry.internal = entry.from != null && ours.has(entry.from);
          out.recent.push(entry);
        }
      }
      // Same aggregation the other rails do: sum the per-call-sized external
      // inbound so the card's "external in window" line and the site-wide
      // windowExternalUsd total include Algorand.
      out.externalUsd = Number(out.recent.filter((t) => t.external && inWindow(t)).reduce((s, t) => s + (t.usd || 0), 0).toFixed(6));
    } catch { /* transaction scan is best-effort */ }
  } catch (e) {
    out.error = String(e?.message || e).slice(0, 120);
  }
  return out;
}

// Trailing-window activity scan for Algorand: page AlgoNode's indexer back
// `days` days (newest first via `after-time`, `maxPages` × 1000 records cap —
// a busy wallet sets `truncated: true` and the totals are an honest floor,
// never an estimate). Mirrors stellarActivity's shape and honesty posture.
export async function algorandActivity(wallet, { days = 30, maxPages = 10 } = {}) {
  const out = { rail: "Algorand", wallet: wallet || null, days, buckets: [], totals: { tx: 0, usd: 0, buyers: 0, internalTx: 0, internalUsd: 0 }, truncated: false, error: null };
  if (!wallet) { out.error = "ALGORAND_WALLET_ADDRESS unset"; return out; }
  const ours = new Set([...OUR_ALGORAND_WALLETS, wallet]);
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const entries = [];
  try {
    let next = null;
    for (let page = 0; page < maxPages; page++) {
      const url =
        `https://mainnet-idx.algonode.cloud/v2/accounts/${wallet}/transactions?asset-id=31566704&tx-type=axfer&limit=1000&after-time=${encodeURIComponent(cutoff)}` +
        (next ? `&next=${encodeURIComponent(next)}` : "");
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) { out.error = `indexer HTTP ${res.status}`; return out; }
      const data = await res.json();
      const txs = data?.transactions || [];
      for (const t of txs) {
        const xfer = t["asset-transfer-transaction"];
        // Defense in depth, matching algorandRail's issuer check: re-verify
        // the ASA id + receiver per record even though the URL already
        // filters asset-id=31566704 — a filter regression must not let a
        // fake-ASA airdrop count as revenue.
        if (!xfer || xfer["asset-id"] !== 31566704 || xfer.receiver !== wallet) continue;
        const usd = Number(xfer.amount) / 1e6;
        const entry = {
          tx: `https://allo.info/tx/${t.id}`,
          when: t["round-time"] ? new Date(t["round-time"] * 1000).toISOString() : null,
          usd,
          from: t.sender || null,
        };
        entry.internal = entry.from != null && ours.has(entry.from);
        entries.push(entry);
      }
      next = data["next-token"] || null;
      if (!next) break;
      if (page === maxPages - 1) out.truncated = true;
    }
  } catch (e) {
    out.error = String(e?.message || e).slice(0, 120);
    return out;
  }
  // bucketStellarActivity is chain-agnostic (buckets {when, usd, from,
  // internal} entries by UTC day) — reused here rather than duplicated.
  const bucketed = bucketStellarActivity(entries, { days });
  out.buckets = bucketed.buckets;
  out.totals = bucketed.totals;
  return out;
}

// ---------------------------------------------------------------------------
// 30-day activity scanners for the /base /polygon /arbitrum /solana
// /robinhood market pages — same contract as stellarActivity/algorandActivity
// above: best-effort, never throws, identical output shape, reuses
// bucketStellarActivity (chain-agnostic bucketer) and isExternalPayment/
// OUR_*_WALLETS for the internal-canary flag. Missing data is ALWAYS
// acceptable (the caller renders "unavailable"); inventing data is NEVER
// acceptable.

// Parse one Alchemy `alchemy_getAssetTransfers` transfer record into
// { when, usd, from } — or null when it can't be trusted (no positive USD
// value). `value` arrives already decimal-normalized (Alchemy resolves the
// ERC-20 decimals server-side); `metadata.blockTimestamp` is ISO.
export function parseEvmTransfer(t) {
  if (!t) return null;
  const usd = Number(t.value);
  if (!Number.isFinite(usd) || usd <= 0) return null;
  const when = typeof t.metadata?.blockTimestamp === "string" ? t.metadata.blockTimestamp : null;
  const from = typeof t.from === "string" ? t.from.toLowerCase() : null;
  return { when, usd: Number(usd.toFixed(6)), from };
}

// Trailing-window activity scan for an EVM rail (base/polygon/arbitrum/
// robinhood) via Alchemy's alchemy_getAssetTransfers — newest first, paged
// via the response's `pageKey`, STOP once a transfer is older than the `days`
// cutoff, `maxPages` cap (sets truncated). Public RPCs don't implement this
// method, so no ALCHEMY_API_KEY → immediate honest "unavailable" rather than
// a failed call per page.
export async function evmActivity(chainKey, wallet, { days = 30, maxPages = 10 } = {}) {
  const c = EVM[chainKey];
  const out = { rail: c?.label || chainKey, wallet: wallet || null, days, buckets: [], totals: { tx: 0, usd: 0, buyers: 0, internalTx: 0, internalUsd: 0 }, truncated: false, error: null };
  if (!c) { out.error = "unsupported chain"; return out; }
  if (!wallet) { out.error = "WALLET_ADDRESS unset"; return out; }
  if (!process.env.ALCHEMY_API_KEY) { out.error = "activity source unavailable (no ALCHEMY_API_KEY)"; return out; }
  const alchemyUrl = c.rpcs[0]; // prepended first in EVM config above when the key is set
  const cutoff = Date.now() - days * 86_400_000;
  const entries = [];
  try {
    let pageKey;
    for (let page = 0; page < maxPages; page++) {
      const params = {
        fromBlock: "0x0", toBlock: "latest", toAddress: wallet, contractAddresses: [c.token],
        category: ["erc20"], withMetadata: true, excludeZeroValue: true, maxCount: "0x3e8", order: "desc",
        ...(pageKey ? { pageKey } : {}),
      };
      const res = await rpcCall([alchemyUrl], "alchemy_getAssetTransfers", [params], 8000);
      const transfers = res?.transfers || [];
      if (!transfers.length) { pageKey = null; break; }
      let pastWindow = false;
      for (const t of transfers) {
        const entry = parseEvmTransfer(t);
        if (!entry) continue;
        const ts = Date.parse(entry.when || "");
        if (Number.isFinite(ts) && ts < cutoff) { pastWindow = true; break; }
        entry.internal = entry.from != null && OUR_EVM_WALLETS.has(entry.from);
        entries.push(entry);
      }
      if (pastWindow) { pageKey = null; break; }
      pageKey = res?.pageKey || null;
      if (!pageKey) break;
      if (page === maxPages - 1) out.truncated = true;
    }
  } catch (e) {
    out.error = String(e?.message || e).slice(0, 120);
    return out;
  }
  const bucketed = bucketStellarActivity(entries, { days });
  out.buckets = bucketed.buckets;
  out.totals = bucketed.totals;
  return out;
}

// Parse one Solana getTransaction result into { when, usd, from } — `owner`'s
// inbound USDC for that tx, or null when nothing came in (outgoing/failed/
// non-USDC). Thin wrapper over the usdcDeltaForOwner/payerFromMeta helpers
// solanaRail already uses, generalized so the scan below doesn't duplicate
// the parse.
export function parseSolanaTransfer(txn, owner) {
  const usd = Number(usdcDeltaForOwner(txn?.meta, owner).toFixed(6));
  if (!(usd > 0)) return null;
  const from = payerFromMeta(txn?.meta, owner);
  const when = txn?.blockTime ? new Date(txn.blockTime * 1000).toISOString() : null;
  return { when, usd, from };
}

// Trailing-window activity scan: page getSignaturesForAddress on the wallet's
// USDC token account (limit 1000, `before` cursor, newest first, `maxPages`
// cap), decoding each signature with getTransaction up to a hard `maxTx`
// budget — getTransaction is one RPC call each, so a busy page must not fire
// hundreds of them. An RPC failure mid-scan keeps whatever was collected so
// far (`truncated:true`); only a failure with nothing collected is an error.
export async function solanaActivity(wallet, { days = 30, maxPages = 10, maxTx = 60 } = {}) {
  const out = { rail: "Solana", wallet: wallet || null, days, buckets: [], totals: { tx: 0, usd: 0, buyers: 0, internalTx: 0, internalUsd: 0 }, truncated: false, error: null };
  if (!wallet) { out.error = "SOLANA_WALLET_ADDRESS unset"; return out; }
  const cutoff = Date.now() - days * 86_400_000;
  const entries = [];
  let tokenAccount;
  try {
    const res = await rpcCall(SOLANA_RPCS, "getTokenAccountsByOwner", [wallet, { mint: USDC_SOL_MINT }, { encoding: "jsonParsed" }], 6000);
    tokenAccount = res?.value?.[0]?.pubkey || wallet;
  } catch (e) {
    out.error = String(e?.message || e).slice(0, 120);
    return out;
  }
  let txBudget = maxTx;
  let capped = false;
  try {
    let before;
    scan: for (let page = 0; page < maxPages; page++) {
      const params = before ? [tokenAccount, { limit: 1000, before }] : [tokenAccount, { limit: 1000 }];
      const sigs = await rpcCall(SOLANA_RPCS, "getSignaturesForAddress", params, 8000);
      if (!Array.isArray(sigs) || !sigs.length) break;
      for (const s of sigs) {
        const tms = s.blockTime ? s.blockTime * 1000 : null;
        if (tms != null && tms < cutoff) break scan;
        if (s.err) continue;
        if (txBudget <= 0) { capped = true; break scan; }
        txBudget--;
        try {
          const txn = await rpcCall(SOLANA_RPCS, "getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }], 6000);
          const entry = parseSolanaTransfer(txn, wallet);
          if (entry) {
            entry.internal = entry.from != null && OUR_SOLANA_WALLETS.has(entry.from);
            entries.push(entry);
          }
        } catch { /* one bad tx fetch must not kill the scan */ }
      }
      before = sigs[sigs.length - 1]?.signature;
      if (!before) break;
      if (page === maxPages - 1) capped = true;
    }
  } catch (e) {
    if (!entries.length) { out.error = String(e?.message || e).slice(0, 120); return out; }
    capped = true; // partial results survive an RPC failure mid-scan
  }
  out.truncated = capped;
  const bucketed = bucketStellarActivity(entries, { days });
  out.buckets = bucketed.buckets;
  out.totals = bucketed.totals;
  return out;
}

// Parse one Blockscout (Etherscan-compatible) tokentx record into
// { when, usd, from } for inbound USDG to `wallet` — or null when it's
// outbound/to someone else. `value` is atomic units (6 decimals, verified
// live against the real USDG contract 2026-07-11); `timeStamp` is unix
// seconds.
export function parseRobinhoodTransfer(t, wallet) {
  if (!t || !wallet) return null;
  const to = typeof t.to === "string" ? t.to.toLowerCase() : null;
  if (to !== wallet.toLowerCase()) return null;
  const raw = Number(t.value);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const ts = Number(t.timeStamp);
  return {
    when: Number.isFinite(ts) ? new Date(ts * 1000).toISOString() : null,
    usd: Number((raw / 1e6).toFixed(6)),
    from: typeof t.from === "string" ? t.from.toLowerCase() : null,
  };
}

// Trailing-window activity scan for Robinhood Chain (USDG) via Blockscout's
// Etherscan-compatible tokentx API — there is no Alchemy/RPC path for this
// chain's activity (see evmActivity). One retry on failure: verified live
// 2026-07-11 that this endpoint occasionally answers "Something went wrong"
// for a perfectly valid wallet/contract pair and succeeds seconds later
// (transient, not a real error). The honesty signal this function keys on is
// `result` being an array vs. `null` — NOT the `status` field: "no transfers
// found" is ALSO status "0" but carries a valid empty `result: []`, so
// keying on `status` would misreport an empty wallet as a scan failure.
export async function robinhoodActivity(wallet, { days = 30 } = {}) {
  const c = EVM.robinhood;
  const out = { rail: c.label, wallet: wallet || null, days, buckets: [], totals: { tx: 0, usd: 0, buyers: 0, internalTx: 0, internalUsd: 0 }, truncated: false, error: null };
  if (!wallet) { out.error = "WALLET_ADDRESS unset"; return out; }
  const cutoff = Date.now() - days * 86_400_000;
  const url = `https://robinhoodchain.blockscout.com/api?module=account&action=tokentx&address=${encodeURIComponent(wallet)}&contractaddress=${encodeURIComponent(c.token)}`;
  const fetchOnce = async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Blockscout HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data?.result)) throw new Error(String(data?.message || "unexpected response shape").slice(0, 80));
    return data.result;
  };
  let rows;
  try {
    try {
      rows = await fetchOnce();
    } catch {
      rows = await fetchOnce(); // one retry — this endpoint flaps transiently
    }
  } catch (e) {
    out.error = String(e?.message || e).slice(0, 120);
    return out;
  }
  const entries = [];
  for (const t of rows) {
    const entry = parseRobinhoodTransfer(t, wallet);
    if (!entry) continue;
    const ts = Date.parse(entry.when || "");
    if (Number.isFinite(ts) && ts < cutoff) continue; // Blockscout order isn't guaranteed — filter, don't break
    entry.internal = entry.from != null && OUR_EVM_WALLETS.has(entry.from);
    entries.push(entry);
  }
  const bucketed = bucketStellarActivity(entries, { days });
  out.buckets = bucketed.buckets;
  out.totals = bucketed.totals;
  return out;
}

// 60s snapshot cache, serve-stale-while-revalidate: a fresh snapshot answers
// directly; a stale one answers IMMEDIATELY while a single deduped background
// refresh runs (the full seven-rail scan takes 10-30s on slow public RPCs —
// no pageview should wait for it, and concurrent expiries must not each
// launch their own scan). Only the very first call after boot has nothing to
// serve and awaits the scan — server.js warms it at boot to cover that too.
// `asOf` keeps any staleness honest.
let cached = null;
let cachedAt = 0;
let refreshing = null;
export async function revenueSnapshot(opts) {
  if (cached && Date.now() - cachedAt < 60_000) return cached;
  if (!refreshing) {
    refreshing = refreshSnapshot(opts)
      .catch(() => cached) // a failed scan keeps serving the last snapshot
      .finally(() => { refreshing = null; });
  }
  if (cached) return cached;
  return (await refreshing) || cached;
}

async function refreshSnapshot({ walletAddress, solanaWallet }) {
  const stellarWallet = (process.env.STELLAR_WALLET_ADDRESS || "").trim();
  const algorandWallet = (process.env.ALGORAND_WALLET_ADDRESS || "").trim();
  const [base, polygon, arbitrum, robinhood, solana, stellar, algorand] = await Promise.all([
    evmRail("base", walletAddress),
    evmRail("polygon", walletAddress),
    evmRail("arbitrum", walletAddress),
    evmRail("robinhood", walletAddress),
    solanaRail(solanaWallet),
    stellarRail(stellarWallet),
    algorandRail(algorandWallet),
  ]);
  const rails = [base, solana, polygon, arbitrum, stellar, algorand, robinhood];
  // Per-rail last-good balance carry-forward. The non-EVM reads (Solana,
  // Stellar, Algorand) hit public endpoints that throttle Railway's datacenter
  // IP and intermittently time out; a wallet balance barely moves between
  // reads, so a transient timeout must NOT wipe a known balance to
  // "unreachable". If this read failed but the previous snapshot had a good
  // balance for the same rail, keep it and flag it stale (honest: it's the last
  // verified reading, timestamped). The next clean refresh replaces it. A rail
  // we've never read successfully stays null -> genuinely unreachable.
  const prevRails = cached?.rails || [];
  const now = new Date().toISOString();
  for (const r of rails) {
    if (r.balance == null || r.error) {
      const prev = prevRails.find((p) => p.rail === r.rail);
      if (prev && Number.isFinite(prev.balance)) {
        r.balance = prev.balance;
        r.staleBalance = true;
        r.balanceAsOf = prev.balanceAsOf || cached?.asOf || null;
        if (!(r.recent && r.recent.length) && prev.recent) r.recent = prev.recent;
      }
    } else {
      r.balanceAsOf = now;
    }
  }
  const totalUsd = rails.reduce((s, r) => s + (Number.isFinite(r.balance) ? r.balance : 0), 0);
  const windowExternalUsd = rails.reduce((s, r) => s + (Number.isFinite(r.externalUsd) ? r.externalUsd : 0), 0);
  cached = {
    spec: "agent402-revenue/1",
    asOf: new Date().toISOString(),
    cacheSeconds: 60,
    totalUsd: Number(totalUsd.toFixed(6)),
    windowExternalUsd: Number(windowExternalUsd.toFixed(6)),
    maxCallUsd: MAX_CALL_USD,
    rails,
    note: "Balances + recent inbound transfers, read live from public RPCs (best-effort per rail). totalUsd is the combined wallet balance (includes our own canary/test money); windowExternalUsd counts only classified external per-call payments in the recent scan windows. All figures are independently verifiable at the explorer links.",
  };
  cachedAt = Date.now();
  return cached;
}

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "-");

// "What's selling" — the sales ledger's merchant view (src/sales-ledger.js):
// external paid calls BY NAME. The on-chain cards above prove the money;
// this section names the products. Renders nothing until the first
// externally-paid call lands (recording started 2026-07-04).
const SALE_TX_URL = {
  base: (h) => `https://basescan.org/tx/${h}`,
  polygon: (h) => `https://polygonscan.com/tx/${h}`,
  arbitrum: (h) => `https://arbiscan.io/tx/${h}`,
  "robinhood (USDG)": (h) => `https://robinhoodchain.blockscout.com/tx/${h}`,
  solana: (h) => `https://solscan.io/tx/${h}`,
};
function salesSection(sales) {
  if (!sales) return "";
  const rows = sales.topExternal || [];
  const recent = sales.recentExternal || [];
  const internal = sales.recentInternal || [];
  const since = sales.recordingSince ? new Date(sales.recordingSince).toISOString().slice(0, 10) : null;
  const empty = !rows.length && !recent.length && !internal.length;
  return `
    <h2 style="font-family:var(--font-body);font-weight:800;font-size:26px;margin:44px 0 6px;">What's selling</h2>
    <p style="font-size:14px;color:var(--muted);margin:0 0 16px;">Every paid call recorded by name at settle time${since ? ` (recording since ${esc(since)})` : ""} - external demand plus internal canary/test activity. Machine-readable: <a href="/api/sales">/api/sales</a>.</p>
    ${empty
      ? `<p style="font-family:var(--font-mono);font-size:13px;color:var(--muted);">no paid calls recorded yet - the ledger names each one as it lands</p>`
      : `<div class="ml-2col" style="display:grid;grid-template-columns:repeat(2,1fr);gap:16px;">
      <div style="border:1.5px solid var(--ink);background:var(--card);padding:18px 20px;">
        <div style="font-weight:800;font-size:15px;border-bottom:1px dashed #C9C9C7;padding-bottom:8px;margin-bottom:10px;">top bought (30d) - $${(sales.totals?.external?.revenueUsd ?? 0).toFixed(4)} external</div>
        <div style="font-family:var(--font-mono);font-size:12.5px;display:grid;gap:6px;">
          ${rows.map((r) => `<div><a href="/tools/${esc(r.slug)}">${esc(r.slug)}</a> × ${r.sales} · $${r.revenueUsd.toFixed(4)}</div>`).join("") || '<div style="color:var(--muted);">-</div>'}
        </div>
      </div>
      <div style="border:1.5px solid var(--ink);background:var(--card);padding:18px 20px;">
        <div style="font-weight:800;font-size:15px;border-bottom:1px dashed #C9C9C7;padding-bottom:8px;margin-bottom:10px;">recent external sales</div>
        <div style="font-family:var(--font-mono);font-size:12.5px;display:grid;gap:6px;">
          ${recent.slice(0, 10).map((s) => {
            const link = s.tx && SALE_TX_URL[s.network] ? ` · <a href="${esc(SALE_TX_URL[s.network](s.tx))}" rel="noopener">tx</a>` : "";
            return `<div><a href="/tools/${esc(s.slug)}">${esc(s.slug)}</a> $${s.priceUsd} · ${esc((s.network || s.rail))}${s.payer ? ` · <code>${esc(short(s.payer))}</code>` : ""}${link} · ${esc(s.at.slice(0, 16))}Z</div>`;
          }).join("") || '<div style="color:var(--muted);">-</div>'}
        </div>
      </div>
      <div style="border:1.5px solid var(--ink);background:var(--card);padding:18px 20px;">
        <div style="font-weight:800;font-size:15px;border-bottom:1px dashed #C9C9C7;padding-bottom:8px;margin-bottom:10px;">recent internal (canary/test) - $${(sales.totals?.internal?.revenueUsd ?? 0).toFixed(4)}</div>
        <div style="font-family:var(--font-mono);font-size:12.5px;display:grid;gap:6px;">
          ${internal.slice(0, 10).map((s) => {
            const link = s.tx && SALE_TX_URL[s.network] ? ` · <a href="${esc(SALE_TX_URL[s.network](s.tx))}" rel="noopener">tx</a>` : "";
            return `<div style="opacity:.62;"><a href="/tools/${esc(s.slug)}">${esc(s.slug)}</a> $${s.priceUsd} · ${esc((s.network || s.rail))}${s.payer ? ` · <code>${esc(short(s.payer))}</code>` : ""}${link} · ${esc(s.at.slice(0, 16))}Z</div>`;
          }).join("") || '<div style="color:var(--muted);">-</div>'}
        </div>
      </div>
    </div>`}`;
}

export function revenuePage(baseUrl, snap) {
  const canonical = baseUrl + "/revenue";
  const title = "Live revenue - Agent402";
  const description =
    `Consolidated live view of the Agent402 revenue wallets across every payment rail - ${RAILS_AMP}. One page instead of three explorer tabs; every figure links to its on-chain proof.`;
  const chainKeyByLabel = { ...Object.fromEntries(Object.entries(EVM).map(([k, c]) => [c.label, k])), Solana: "solana", Stellar: "stellar", Algorand: "algorand" };
  const railCard = (r) => {
    const at = snap.allTime?.perChain?.[chainKeyByLabel[r.rail]];
    // Per-rail health: a successful balance read means the chain is up and we
    // are settling on it, even when the recent-transfer window is quiet. Making
    // this explicit stops a low-activity rail (or a partial transfer scan) from
    // reading as "the chain is broken" when only the recent-activity list is
    // empty. Green = live, red = the balance read itself failed.
    // A balance present (fresh OR carried-forward from the last good read) means
    // the chain is live and settling - a wallet balance barely moves between
    // reads, so a carried-forward figure is still accurate to within minutes.
    // Only a rail we've NEVER read (no balance at all) is genuinely unreachable.
    // Carried-forward reads show "live · cached" so the freshness is honest.
    const hasBalance = r.balance != null;
    const stale = hasBalance && r.staleBalance;
    const dotColor = hasBalance ? "var(--green)" : "var(--accent)";
    const dotLabel = !hasBalance ? "unreachable" : stale ? "live · cached" : "live";
    const statusDot = `<span style="display:inline-flex;align-items:center;gap:5px;font-family:var(--font-mono);font-size:11px;color:${dotColor};"><span style="width:7px;height:7px;border-radius:50%;background:${dotColor};display:inline-block;"></span>${dotLabel}</span>`;
    return `
    <div style="border:1.5px solid var(--ink);background:var(--card);padding:18px 20px;">
      <div style="display:flex;align-items:baseline;justify-content:space-between;border-bottom:1px dashed #C9C9C7;padding-bottom:10px;margin-bottom:12px;">
        <span style="font-weight:800;font-size:17px;">${esc(r.rail)} <span style="font-family:var(--font-mono);font-size:12px;color:var(--muted);">· ${esc(r.asset)}</span> ${statusDot}</span>
        <span style="font-family:var(--font-mono);text-align:right;"><span style="font-size:20px;font-weight:700;">${r.balance == null ? "-" : "$" + r.balance.toFixed(4)}</span><span style="display:block;font-size:11px;color:var(--muted);">balance${Number.isFinite(r.externalUsd) ? ` · external in window $${r.externalUsd}` : ""}${at ? ` · all-time $${at.externalUsd}${at.caughtUp ? "" : "↺"}` : ""}</span></span>
      </div>
      ${!hasBalance
        ? `<div style="font-family:var(--font-mono);font-size:12px;color:var(--muted);">rail read unavailable - public RPC error (detail in <a href="/api/revenue">/api/revenue</a>)</div>`
        : r.recent.length
          ? `<div style="font-family:var(--font-mono);font-size:12.5px;display:grid;gap:6px;">${r.recent
              .map((t) => {
                const tag = t.usd === undefined ? ""
                  : t.external ? ` · <strong style="color:var(--accent);">external</strong>`
                  : t.internal ? ` · <span style="color:var(--muted);">internal canary/test</span>`
                  : ` · <span style="color:var(--muted);">not a per-call buy</span>`;
                const dim = t.usd !== undefined && !t.external ? "opacity:.62;" : "";
                const when = t.when ? ` · <span style="color:var(--muted);">${esc(t.when.slice(0, 16))}Z</span>` : "";
                return t.usd !== undefined
                  ? `<div style="${dim}">+$${t.usd ?? "?"} from <code>${esc(short(t.from))}</code> · <a href="${esc(t.tx)}" rel="noopener">tx</a>${tag}${when}</div>`
                  : `<div><a href="${esc(t.tx)}" rel="noopener">tx</a>${when}${t.err ? " · failed" : ""}</div>`;
              })
              .join("")}</div>`
          : `<div style="font-family:var(--font-mono);font-size:12px;color:var(--muted);">chain live, balance settling - no per-call activity in the recent scan window</div>`}
      ${r.scanNote ? `<div style="margin-top:8px;font-family:var(--font-mono);font-size:11.5px;color:var(--muted);">${esc(r.scanNote)}</div>` : ""}
      ${r.explorer ? `<div style="margin-top:12px;font-family:var(--font-mono);font-size:12px;"><a href="${esc(r.explorer)}" rel="noopener">open in explorer →</a></div>` : ""}
    </div>`;
  };
  const body = `
  <main style="max-width:1100px;margin:0 auto;padding:56px 30px;">
    <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">$ GET /api/revenue</div>
    <h1 style="font-family:var(--font-body);font-weight:800;font-size:44px;line-height:1.05;letter-spacing:-.02em;margin:0 0 8px;color:var(--ink);">Live revenue.</h1>
    <p style="font-size:16px;line-height:1.6;color:var(--muted);max-width:640px;margin:0 0 8px;">
      Every rail's wallet, one page - refreshed from public RPCs (60s cache), every figure verifiable at its explorer link.
      Machine-readable: <a href="/api/revenue">/api/revenue</a>.
    </p>
    ${snap.allTime ? `<p style="font-family:var(--font-mono);font-size:15px;margin:0 0 6px;"><strong style="color:var(--accent);font-size:22px;">${snap.allTime.allTimeExternalCount.toLocaleString()}</strong> verifiable external payment${snap.allTime.allTimeExternalCount === 1 ? "" : "s"} all-time <span style="color:var(--muted);">- $${snap.allTime.allTimeExternalUsd.toFixed(4)} settled on-chain, each linked to its explorer proof${snap.allTime.syncing ? " · ledger backfilling - total still rising" : ""}</span></p>` : ""}
    <p style="font-family:var(--font-mono);font-size:13px;color:var(--muted);margin:0 0 30px;">as of ${esc(snap.asOf)} · combined balance <strong style="color:var(--ink);">$${snap.totalUsd.toFixed(4)}</strong> · external in recent window <strong style="color:var(--accent);">$${(snap.windowExternalUsd ?? 0).toFixed(4)}</strong><br>balances include our own canary/test money - only transfers classified <strong style="color:var(--accent);">external</strong> count as revenue</p>
    <div class="ml-2col" style="display:grid;grid-template-columns:repeat(2,1fr);gap:16px;">
      ${snap.rails.map(railCard).join("\n")}
    </div>
    <p style="font-size:13.5px;color:var(--muted);margin-top:26px;">Recent-window transfers are the last few hours of inbound stablecoin on each rail, classified with the same rule as the daily revenue digest: a payment is <strong>external</strong> only if it comes from a wallet that isn't ours (canary/test burners are excluded) and is per-call-sized (≤ $${MAX_CALL_USD}); bigger inbound is funding or tests, not a buy. Rails read best-effort: a flaky public RPC marks that rail unavailable without hiding the others.</p>
    <p style="font-size:13.5px;color:var(--muted);margin-top:10px;">Don't take our word for it: <a href="https://www.x402scan.com/server/07eb3020-932a-436d-a739-557b6e47101d" rel="noopener">x402scan indexes our on-chain settlements independently →</a> Their totals count <em>all</em> traffic to our wallets - including our own canary and test buys - so they read higher than the external-only figures above. Both are correct; they measure different things.</p>
    ${salesSection(snap.sales)}
  </main>
  ${ledgerFooterCompact(baseUrl)}`;
  return ledgerShell({
    title, description, canonical, baseUrl, activePath: "/revenue",
    jsonLd: { "@context": "https://schema.org", "@type": "WebPage", name: title, url: canonical, description },
    body,
  });
}
// RAILS import keeps this module honest if the rail set changes: a rail in
// rails.js with no read-config here is a wiring bug the test below catches.
export function railsCoveredByLiveView() {
  const covered = new Set([...Object.values(EVM).map((c) => c.label), "Solana", "Stellar", "Algorand"]);
  return RAILS.every((r) => covered.has(r.name));
}
