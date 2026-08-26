// token-risk-kit — Token & Contract Risk Report. Hand over a token contract
// address (and chain) and get one evidence-based on-chain risk assessment:
// source-code verification, holder concentration (top-1 / top-10 share of
// supply, distinguishing contracts/pools from EOAs), supply and market context,
// and (pro) a deterministic static-pattern scan of the verified source plus a
// web reputation check. Agent-facing (crypto/x402/MPP), for the trading agents
// and desks already on the marketplace.
//
// HONESTY IS THE PRODUCT: this reports EVIDENCE from on-chain signals and NEVER
// a "safe"/"scam" verdict. On-chain checks cannot detect off-chain rug
// mechanisms, social-engineering scams, or future malicious upgrades, and a
// clean report is not an endorsement. The synthesis prompt enforces this framing.
//
// Composes existing tools in-process. token-info + token-holders buy from
// Blockscout's Pro API over x402 (real upstream spend; 503 without the server's
// upstream-buyer wallet), contract-source + solidity-scan are free (Sourcify +
// a local ruleset). Settlement-safe (throws >=400 on total failure), WALLET_ONLY,
// not cached. Synthesis gated on OPENROUTER_API_KEY.
import { fetchOpenRouter, throwUpstreamError, bad, upstreamUserId } from "./llm-gateway-kit.js";
import { recordCompositeUsage } from "../composite-spend-guard.js";
import { BLOCKSCOUT_TOOLS } from "./blockscout-kit.js";
import { CONTRACT_TOOLS } from "./contract-kit.js";

// Keyless control-plane facts the report used to disclaim as "not visible
// here": GoPlus token_security (honeypot, proxy, mintable, hidden owner, taxes,
// pausable, blacklist, LP holders, DEX liquidity) and DexScreener pairs. Plus
// Blockscout's address profile (proxy type / implementation) and the Sourcify
// ABI (the privileged function names ARE the owner privileges). Measured on
// BRETT/Base 2026-08-26: every field below answered.
const GOPLUS_CHAIN_IDS = { base: 8453, ethereum: 1, polygon: 137, arbitrum: 42161, optimism: 10, bsc: 56, gnosis: 100, celo: 42220 };
const DEXSCREENER_CHAINS = { base: "base", ethereum: "ethereum", polygon: "polygon", arbitrum: "arbitrum", optimism: "optimism", bsc: "bsc", gnosis: "gnosischain", celo: "celo" };
const KEYLESS_TIMEOUT_MS = 12_000;
async function getJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(KEYLESS_TIMEOUT_MS) });
  if (!res.ok) throw bad(`upstream HTTP ${res.status}`, res.status >= 500 ? 502 : 422);
  return res.json();
}
const flag = (v) => (v === "1" || v === 1 || v === true ? true : v === "0" || v === 0 || v === false ? false : null);
export async function probeGoPlus({ chain, address }) {
  const id = GOPLUS_CHAIN_IDS[chain];
  if (!id) throw bad(`GoPlus does not cover ${chain}`, 422);
  const j = await getJson(`https://api.gopluslabs.io/api/v1/token_security/${id}?contract_addresses=${address.toLowerCase()}`);
  const r = j?.result?.[address.toLowerCase()] || Object.values(j?.result || {})[0];
  if (!r) throw bad("GoPlus has no record for this token", 422);
  return shapeGoPlus(r);
}
export function shapeGoPlus(r) {
  const num = (v) => (v == null || v === "" ? null : Number(v));
  return {
    openSource: flag(r.is_open_source), proxy: flag(r.is_proxy), mintable: flag(r.is_mintable), honeypot: flag(r.is_honeypot),
    ownerAddress: r.owner_address || null, ownerRenounced: /^0x0{40}$/i.test(String(r.owner_address || "")) ? true : (r.owner_address ? false : null),
    hiddenOwner: flag(r.hidden_owner), canTakeBackOwnership: flag(r.can_take_back_ownership), ownerChangeBalance: flag(r.owner_change_balance),
    buyTaxPct: num(r.buy_tax) == null ? null : num(r.buy_tax) * 100, sellTaxPct: num(r.sell_tax) == null ? null : num(r.sell_tax) * 100,
    cannotSellAll: flag(r.cannot_sell_all), cannotBuy: flag(r.cannot_buy), transferPausable: flag(r.transfer_pausable), blacklist: flag(r.is_blacklisted), whitelist: flag(r.is_whitelisted),
    slippageModifiable: flag(r.slippage_modifiable), tradingCooldown: flag(r.trading_cooldown), antiWhale: flag(r.is_anti_whale), antiWhaleModifiable: flag(r.anti_whale_modifiable), selfdestruct: flag(r.selfdestruct), externalCall: flag(r.external_call),
    holderCount: num(r.holder_count), lpHolderCount: num(r.lp_holder_count), lpTotalSupply: num(r.lp_total_supply),
    lpLockedPct: Array.isArray(r.lp_holders) ? Math.round(r.lp_holders.filter((h) => flag(h.is_locked)).reduce((a, h) => a + (Number(h.percent) || 0), 0) * 10000) / 100 : null,
    lpTopHolders: Array.isArray(r.lp_holders) ? r.lp_holders.slice(0, 5).map((h) => ({ address: h.address, tag: h.tag || null, percent: Math.round((Number(h.percent) || 0) * 10000) / 100, locked: flag(h.is_locked), isContract: flag(h.is_contract) })) : [],
    dexes: Array.isArray(r.dex) ? r.dex.slice(0, 6).map((d) => ({ name: d.name, type: d.liquidity_type, liquidityUsd: num(d.liquidity), pair: d.pair })) : [],
    creatorAddress: r.creator_address || null, creatorPct: num(r.creator_percent) == null ? null : num(r.creator_percent) * 100, ownerPct: num(r.owner_percent) == null ? null : num(r.owner_percent) * 100,
    trustList: flag(r.trust_list), fakeToken: r.fake_token ? { value: flag(r.fake_token.value), trueTokenAddress: r.fake_token.true_token_address || null } : null,
  };
}
export async function probeDexPairs({ chain, address }) {
  const c = DEXSCREENER_CHAINS[chain];
  if (!c) throw bad(`DexScreener does not cover ${chain}`, 422);
  const arr = await getJson(`https://api.dexscreener.com/token-pairs/v1/${c}/${address}`);
  const pairs = (Array.isArray(arr) ? arr : []).map((p) => ({
    dex: p.dexId || null, pair: p.pairAddress || null, quote: p.quoteToken?.symbol || null, priceUsd: p.priceUsd != null ? Number(p.priceUsd) : null,
    liquidityUsd: Number(p.liquidity?.usd) || 0, volume24h: Number(p.volume?.h24) || 0, volume1h: Number(p.volume?.h1) || 0,
    buys24h: Number(p.txns?.h24?.buys) || 0, sells24h: Number(p.txns?.h24?.sells) || 0, buys1h: Number(p.txns?.h1?.buys) || 0, sells1h: Number(p.txns?.h1?.sells) || 0,
    fdv: p.fdv != null ? Number(p.fdv) : null, marketCap: p.marketCap != null ? Number(p.marketCap) : null, createdAt: p.pairCreatedAt ? new Date(Number(p.pairCreatedAt)).toISOString() : null,
    hasProfile: Boolean(p.info && (p.info.imageUrl || (p.info.websites || []).length || (p.info.socials || []).length)),
    websites: Array.isArray(p.info?.websites) ? p.info.websites.map((w) => w.url).filter(Boolean).slice(0, 2) : [],
  })).sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  return { totalPairs: pairs.length, liquidityUsd: pairs.reduce((a, p) => a + p.liquidityUsd, 0), volume24h: pairs.reduce((a, p) => a + p.volume24h, 0), txns24h: pairs.reduce((a, p) => a + p.buys24h + p.sells24h, 0), pairs: pairs.slice(0, 8) };
}
// Function names that ARE owner privileges: what an ABI can tell a reader that
// a verification badge cannot.
const PRIVILEGE_RE = /^(mint|burnFrom|pause|unpause|blacklist|unblacklist|setBlacklist|addToBlacklist|removeFromBlacklist|setFee|setFees|setTax|setTaxes|setBuyTax|setSellTax|setMaxTx|setMaxTxAmount|setMaxWallet|setSwapAndLiquify|excludeFromFee|excludeFromFees|includeInFee|setTradingEnabled|enableTrading|openTrading|setRouter|updateRouter|transferOwnership|renounceOwnership|upgradeTo|upgradeToAndCall|setImplementation|rescueTokens|withdrawTokens|clearStuckBalance|setCooldown|setLimits|setAntiWhale|setMaxHolding|freeze|unfreeze|setWhitelist|addWhitelist|lockTokens|disableTransfers|setTransfersEnabled)$/i;
export function privilegedFunctions(abi) {
  const fns = (Array.isArray(abi) ? abi : []).filter((x) => x && x.type === "function" && x.name);
  return { total: fns.length, privileged: fns.map((f) => f.name).filter((n) => PRIVILEGE_RE.test(n)).sort(), writable: fns.filter((f) => !/^(view|pure)$/.test(String(f.stateMutability || ""))).length };
}

function safeUser(req) { try { return req ? upstreamUserId(req) : undefined; } catch { return undefined; } }

const SYNTH = "anthropic/claude-opus-5";
const GROUND = "google/gemini-2.5-flash";
export const TOKEN_RISK_MODELS = [SYNTH, GROUND];

export const TOKEN_RISK_TIERS = {
  "token-risk": { price: "$0.60", maxUpstreamUsd: 0.35, holders: 20, scan: false, web: 0, synthMaxTokens: 3500, words: "~1,200" },
  "token-risk-pro": { price: "$0.85", maxUpstreamUsd: 0.5, holders: 50, scan: true, web: 1, synthMaxTokens: 5000, words: "~1,900" },
};

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const PROBE_TIMEOUT_MS = 22_000;
const SEARCH_TIMEOUT_MS = 45_000;
const SYNTH_TIMEOUT_MS = 120_000;
// Chains covered by BOTH the holder/token probes and Sourcify source verification.
const CHAINS = new Set(["base", "ethereum", "polygon", "arbitrum", "optimism", "bsc", "gnosis", "celo"]);
const fmtUsdLoose = (v) => (v == null || !Number.isFinite(Number(v)) ? "unknown" : Number(v) >= 1e6 ? `$${(Number(v) / 1e6).toFixed(2)}M` : Number(v) >= 1e3 ? `$${(Number(v) / 1e3).toFixed(1)}k` : `$${Number(v).toFixed(0)}`);

let _all = null;
const allTools = () => (_all ||= [...BLOCKSCOUT_TOOLS, ...CONTRACT_TOOLS]);
function H(slug) {
  const t = allTools().find((x) => x.slug === slug);
  if (!t) throw bad(`token-risk: missing dependency '${slug}'`, 500);
  return t.handler;
}
async function chat(body, timeoutMs, user) {
  const res = await fetchOpenRouter({ ...body, ...(user ? { user } : {}), usage: { include: true } }, { timeoutMs });
  if (!res.ok) await throwUpstreamError(res);
  return res.json();
}
const costOf = (d) => Number(d?.usage?.cost) || 0;
const textOf = (d) => (d?.choices?.[0]?.message?.content || "").trim();
async function settle(p, timeoutMs) {
  try {
    const data = timeoutMs ? await Promise.race([p, new Promise((_, r) => setTimeout(() => r(bad("timeout", 504)), timeoutMs))]) : await p;
    return { ok: true, data };
  } catch (e) { return { ok: false, error: e?.message || String(e) }; }
}
// share of total supply as a percentage (BigInt-safe on raw integer strings).
function shareOf(valueStr, totalStr) {
  try {
    const v = BigInt(String(valueStr)), t = BigInt(String(totalStr));
    if (t <= 0n || v < 0n) return null;
    return Number((v * 1000000n) / t) / 10000;
  } catch { return null; }
}
// Best-effort extraction of Solidity source text from contract-source output,
// whatever shape it returns the files in.
function extractSource(cs) {
  if (!cs) return "";
  const parts = [];
  const push = (x) => { if (typeof x === "string" && x.includes("pragma")) parts.push(x); };
  for (const key of ["source", "sourceCode", "content"]) push(cs[key]);
  const files = cs.sources || cs.files || cs.sourceFiles;
  if (Array.isArray(files)) for (const f of files) push(typeof f === "string" ? f : (f?.content || f?.source));
  else if (files && typeof files === "object") for (const k of Object.keys(files)) push(files[k]?.content || files[k]);
  return parts.join("\n\n").slice(0, 500 * 1024);
}
const fmtPct = (n) => (n == null ? "?" : `${n.toFixed(2)}%`);
// Burn / dead addresses hold supply that is out of circulation. They are EOAs
// (no bytecode) so token-holders reports isContract=false; without this they'd
// be labeled a large "wallet", misreading burned supply as concentration risk.
function isBurn(a) {
  const s = String(a || "").toLowerCase().replace(/^0x/, "");
  return /^0{40}$/.test(s) || /^0*0*dead$/.test(s) || /0{6,}dead$/.test(s) || s === "000000000000000000000000000000000000dead";
}
const holderType = (r) => (r.burn ? "burn/dead" : r.isContract ? "contract" : "EOA");

function makeTokenRiskHandlerInner(tierSlug) {
  const t = TOKEN_RISK_TIERS[tierSlug];
  return async (input, req) => {
    if (!input || typeof input !== "object") throw bad('Body must be a JSON object: {"address": "0x…", "chain": "base"}');
    const address = String(input.address ?? input.token ?? "").trim();
    if (!ADDR_RE.test(address)) throw bad('"address" must be a token contract address (0x + 40 hex chars)');
    const chain = String(input.chain ?? "base").trim().toLowerCase();
    if (!CHAINS.has(chain)) throw bad(`"chain" must be one of: ${[...CHAINS].join(", ")} (default base)`);
    const user = safeUser(req);

    // 1) ON-CHAIN PROBES (parallel, each non-fatal).
    const [infoR, holdersR, srcR, gpR, dexR, profR, abiR] = await Promise.all([
      settle(H("token-info")({ chain, address }), PROBE_TIMEOUT_MS),
      settle(H("token-holders")({ chain, address, limit: t.holders }), PROBE_TIMEOUT_MS),
      settle(H("contract-source")({ address, network: chain }), PROBE_TIMEOUT_MS),
      settle(probeGoPlus({ chain, address }), PROBE_TIMEOUT_MS),
      settle(probeDexPairs({ chain, address }), PROBE_TIMEOUT_MS),
      settle(H("address-profile")({ chain, address }), PROBE_TIMEOUT_MS),
      settle(H("contract-abi")({ address, network: chain }), PROBE_TIMEOUT_MS),
    ]);
    const info = infoR.ok ? infoR.data : null;
    const holdersData = holdersR.ok ? holdersR.data : null;
    const src = srcR.ok ? srcR.data : null;
    const gp = gpR.ok ? gpR.data : null;
    const dex = dexR.ok ? dexR.data : null;
    const prof = profR.ok ? profR.data : null;
    const abiInfo = abiR.ok ? privilegedFunctions(abiR.data?.abi) : null;
    // Minimum evidence: a RISK report needs on-chain token facts (supply) or the
    // holder distribution - verified source alone (free Sourcify) is not a risk
    // assessment and must not be sold as one. Not charged.
    if (!info && !holdersData) throw bad(`Could not read token "${address}" on ${chain} (token and holder probes both failed${src ? "; only the contract source was readable" : ""}). Confirm the address and chain. Not charged.`, 422);

    const totalSupply = info?.totalSupply ?? null;
    const holders = Array.isArray(holdersData?.holders) ? holdersData.holders : [];
    const ranked = holders.map((h) => ({
      address: h.address || null,
      isContract: !!h.isContract,
      burn: isBurn(h.address),
      name: h.name || null,
      share: totalSupply ? shareOf(h.value, totalSupply) : null,
    }));
    const top1 = ranked[0]?.share ?? null;
    const top10 = ranked.slice(0, 10).reduce((a, r) => a + (r.share || 0), 0) || null;
    const verified = src ? !!src.verified : null;

    // 2) PRO: static scan of the verified source + one web reputation check.
    let scan = null, scanErr = null, web = null;
    let spent = 0;
    if (t.scan && verified) {
      const source = extractSource(src);
      if (source.trim()) {
        const r = await settle(H("solidity-scan")({ source }), PROBE_TIMEOUT_MS);
        if (r.ok) scan = r.data; else scanErr = r.error;
      } else scanErr = "verified source text was not extractable from the verification record";
    }
    if (t.web) {
      const q = `${info?.name || address} ${info?.symbol || ""} token ${chain} scam OR rug OR honeypot OR audit reputation`.trim();
      const wr = await chat({ model: GROUND, messages: [{ role: "user", content: `Search the web for the reputation of this crypto token and answer with SPECIFIC facts and citations - any scam/rug/honeypot reports, audits, or notable coverage. If you find nothing credible, say so. Token: ${q}` }], max_tokens: 600, plugins: [{ id: "web", engine: "exa", max_results: 5 }] }, SEARCH_TIMEOUT_MS, user).catch(() => null);
      if (wr) { web = { answer: textOf(wr), sources: (wr?.choices?.[0]?.message?.annotations || []).map((a) => a?.url_citation || a).filter((c) => c?.url).map((c) => ({ title: String(c.title || c.url).slice(0, 160), url: String(c.url) })) }; spent += costOf(wr); }
    }

    // 3) GROUNDING BLOCKS.
    const infoBlock = info
      ? `Name ${info.name || "?"} (${info.symbol || "?"}), type ${info.type || "?"}, decimals ${info.decimals ?? "?"}. Total supply ${totalSupply ?? "unknown"}. Holder count ${info.holders ?? "?"}. Market cap ${info.circulatingMarketCap ?? "unknown"}. Price (exchange rate) ${info.exchangeRate ?? "unknown"}; 24h transfers ${info.transfers24h ?? "unknown"}.`
      : `token-info probe FAILED: ${infoR.error}`;
    const verifyBlock = src
      ? (verified ? `Source is VERIFIED (${src.match || "match"}) - compiler ${src.compiler?.version || "?"}, verified at ${src.verifiedAt || "?"}.` : "Source is NOT VERIFIED on Sourcify - the contract's code cannot be independently reviewed. This is a notable risk signal (though some legitimate contracts are unverified).")
      : `contract-source probe FAILED: ${srcR.error}`;
    const holderBlock = ranked.length
      ? `Top holders (share of total supply; [burn/dead] = out of circulation, [contract] = pool/bridge/staking/etc., [EOA] = externally-owned wallet):\n` + ranked.slice(0, t.holders).map((r, i) => `${i + 1}. ${r.address || "?"} - ${fmtPct(r.share)} [${holderType(r)}]${r.name ? ` (${r.name})` : ""}`).join("\n") + `\nConcentration: top holder ${fmtPct(top1)}, top 10 ${fmtPct(top10)} of supply (this includes any burn/dead and pool/contract holders - weigh those differently from wallet concentration).`
      : `token-holders probe ${holdersR.ok ? "returned no holders" : `FAILED: ${holdersR.error}`}.`;
    const scanBlock = t.scan
      ? (scan ? `Static pattern scan (heuristic, not an audit) of the verified source: ${scan.summary ? JSON.stringify(scan.summary) : `${(scan.findings || []).length} findings`}. Findings: ${(scan.findings || []).slice(0, 25).map((f) => `${f.severity || "?"}: ${f.title || f.rule || f.pattern || "finding"}${f.line ? ` (line ${f.line})` : ""}`).join("; ") || "none"}.`
              : `Static scan not run: ${scanErr || "source unavailable"}.`)
      : "";
    const webBlock = web ? `WEB REPUTATION: ${web.answer || "(no answer)"}` : "";
    const yn = (v) => (v === true ? "YES" : v === false ? "no" : "unknown");
    const pctS = (v) => (v == null ? "unknown" : `${Number(v).toFixed(2)}%`);
    const controlBlock = [
      gp
        ? `GoPlus token_security (keyless, checked): open source ${yn(gp.openSource)}; PROXY (upgradeable) ${yn(gp.proxy)}; MINTABLE ${yn(gp.mintable)}; HONEYPOT ${yn(gp.honeypot)}; owner ${gp.ownerAddress || "unknown"} (renounced ${yn(gp.ownerRenounced)}, owner holds ${pctS(gp.ownerPct)}); hidden owner ${yn(gp.hiddenOwner)}; can take back ownership ${yn(gp.canTakeBackOwnership)}; owner can change balances ${yn(gp.ownerChangeBalance)}; buy tax ${pctS(gp.buyTaxPct)}, sell tax ${pctS(gp.sellTaxPct)}; cannot sell all ${yn(gp.cannotSellAll)}; transfers pausable ${yn(gp.transferPausable)}; blacklist ${yn(gp.blacklist)}; whitelist ${yn(gp.whitelist)}; slippage modifiable ${yn(gp.slippageModifiable)}; trading cooldown ${yn(gp.tradingCooldown)}; anti-whale ${yn(gp.antiWhale)} (modifiable ${yn(gp.antiWhaleModifiable)}); selfdestruct ${yn(gp.selfdestruct)}; external calls ${yn(gp.externalCall)}; creator ${gp.creatorAddress || "unknown"} holds ${pctS(gp.creatorPct)}${gp.fakeToken?.value ? `; FLAGGED AS A FAKE of ${gp.fakeToken.trueTokenAddress || "another token"}` : ""}${gp.trustList ? "; on GoPlus trust list" : ""}.`
        : `GoPlus token_security probe FAILED (${gpR.error}) - honeypot/proxy/mintable/owner-privilege flags were NOT checked; say so.`,
      prof
        ? `Blockscout address profile: contract ${yn(prof.isContract)}, verified ${yn(prof.isVerified)}, proxy type ${prof.proxyType || "none reported"}${prof.implementations?.length ? `, implementation(s) ${prof.implementations.map((x) => x.address || x).join(", ")}` : ""}, creator ${prof.creatorAddress || "unknown"}${prof.isScam ? ", FLAGGED is_scam by Blockscout" : ""}.`
        : `Blockscout address profile probe FAILED (${profR.error}).`,
      abiInfo
        ? `ABI (Sourcify): ${abiInfo.total} functions, ${abiInfo.writable} state-changing; PRIVILEGED functions present: ${abiInfo.privileged.length ? abiInfo.privileged.join(", ") : "none of the known owner-privilege names"}. (A privileged function is a capability, not proof of use - who can call it is the owner question above.)`
        : `ABI probe ${abiR.ok ? "returned no ABI" : `FAILED (${abiR.error})`} - the contract's function surface was NOT inspected.`,
    ].join("\n");
    const liquidityBlock = [
      dex
        ? `DexScreener: ${dex.totalPairs} pair(s), combined liquidity ${fmtUsdLoose(dex.liquidityUsd)}, 24h volume ${fmtUsdLoose(dex.volume24h)}, 24h transactions ${dex.txns24h}. Deepest pairs: ${dex.pairs.slice(0, 5).map((p) => `${p.dex} ${p.quote || "?"} pair ${p.pair} liquidity ${fmtUsdLoose(p.liquidityUsd)}, 24h vol ${fmtUsdLoose(p.volume24h)}, buys/sells 24h ${p.buys24h}/${p.sells24h}, 1h ${p.buys1h}/${p.sells1h}${p.createdAt ? `, created ${p.createdAt.slice(0, 10)}` : ""}${p.hasProfile ? ", profile yes" : ", profile NO"}`).join("; ") || "none"}.`
        : `DexScreener probe FAILED (${dexR.error}) - liquidity and trading activity were NOT checked; say so.`,
      gp
        ? `LP (GoPlus): ${gp.lpHolderCount ?? "unknown"} LP holders; LP locked ${pctS(gp.lpLockedPct)} of LP supply; top LP holders ${gp.lpTopHolders.map((h) => `${h.address}${h.tag ? ` (${h.tag})` : ""} ${h.percent}%${h.locked ? " LOCKED" : ""}`).join("; ") || "none listed"}; DEX liquidity per GoPlus ${gp.dexes.map((d) => `${d.name} ${fmtUsdLoose(d.liquidityUsd)}`).join(", ") || "none listed"}.`
        : "",
    ].filter(Boolean).join("\n");

    // 4) SYNTHESIZE - evidence-based, NEVER a definitive safe/scam verdict.
    const synthPrompt = `You are a blockchain analyst writing a TOKEN & CONTRACT RISK REPORT on ${address} (${chain}) that will be SOLD to a paying customer. It must be scrupulously honest and evidence-based.

=== ABSOLUTE RULES ===
1. Use ONLY the on-chain probe data and (if present) web reputation below. Never invent a holder, figure, finding, or fact.
2. This is an EVIDENCE-BASED RISK ASSESSMENT, NOT financial advice and NOT a guarantee. NEVER declare the token "safe", "legitimate", "a scam", or "a rug". Instead describe the concrete risk SIGNALS and what they do and do not tell us. Disclaim ONLY what was not checked: the CONTROL & UPGRADEABILITY block says whether the contract is a proxy, mintable, pausable, taxed, blacklistable and who owns it, and the LIQUIDITY block says what is tradable where - report those as checked facts. What no on-chain check can see: off-chain promises, social-engineering, a FUTURE upgrade if the contract is a proxy or the owner is not renounced (say that conditionally), and anything a probe marked FAILED. A clean report is NOT an endorsement - the reader must do their own research. A GAP IN THIS MATERIAL IS NEVER A FINDING ABOUT THE TOKEN: a failed probe is "not checked here", never "hidden" or "undisclosed".
3. Interpret holder concentration CAREFULLY using the LABELS given ([burn/dead], [contract], [EOA]): [burn/dead] holdings are supply OUT of circulation (not concentration risk); [contract] holdings are pools/bridges/staking contracts (weigh differently from a person's wallet); only large [EOA] holdings are true single-wallet concentration. Never call burned or pool-held supply "concentration risk"; say which kind each large holder is.
4. Treat an UNVERIFIED source as a real but not conclusive signal; treat static-scan findings as heuristic triage, not a formal audit.

Write a clear, structured report of up to ${t.words} words: SNAPSHOT (what the token is, supply, holders, market context), CONTROL & UPGRADEABILITY (proxy, mint, pause, taxes, blacklist, owner - from the checked flags and the ABI), LIQUIDITY & TRADING (pairs, depth, volume, LP lock), SOURCE VERIFICATION, HOLDER CONCENTRATION (with the contract-vs-EOA nuance), ${t.scan ? "STATIC CODE SIGNALS, " : ""}${t.web ? "REPUTATION & CONTEXT, " : ""}and a RISK SUMMARY that lists the specific signals found (elevated, neutral, or reassuring) and closes with the plain caveat that this is not advice and not exhaustive. Do NOT write a sources section.

=== TOKEN INFO ===\n${infoBlock}
=== CONTROL & UPGRADEABILITY (checked) ===\n${controlBlock}
=== LIQUIDITY & TRADING (checked) ===\n${liquidityBlock}
=== SOURCE VERIFICATION ===\n${verifyBlock}
=== HOLDER CONCENTRATION ===\n${holderBlock}${t.scan ? `\n=== STATIC SCAN ===\n${scanBlock}` : ""}${t.web && webBlock ? `\n=== WEB REPUTATION ===\n${webBlock}` : ""}`;

    const sd = await chat({ model: SYNTH, messages: [{ role: "user", content: synthPrompt }], max_tokens: t.synthMaxTokens, reasoning: { enabled: false } }, SYNTH_TIMEOUT_MS, user);
    spent += costOf(sd);
    const prose = textOf(sd);
    if (!prose) throw bad("Token risk synthesis produced nothing - not charged", 502);
    const report = prose;

    // 5) DATA APPENDIX.
    const tables = [];
    if (ranked.length) tables.push({
      name: "holders", label: "Top holders",
      columns: ["Rank", "Address", "Share of supply", "Type", "Label"],
      rows: ranked.map((r, i) => [String(i + 1), r.address || "", fmtPct(r.share), holderType(r), r.name || ""]),
    });
    if (scan?.findings?.length) tables.push({
      name: "scan-findings", label: "Static scan findings",
      columns: ["Severity", "Finding", "Line"],
      rows: scan.findings.map((f) => [String(f.severity || ""), String(f.title || f.rule || f.pattern || ""), String(f.line ?? "")]),
    });

    const sources = (web?.sources || []).map((s, i) => ({ n: i + 1, ...s }));
    const meta = {
      tier: tierSlug, address, chain,
      name: info?.name ?? null, symbol: info?.symbol ?? null,
      verified_source: verified, holder_count: info?.holders ?? null,
      top1_share_pct: top1, top10_share_pct: top10,
      scan_findings: scan?.findings?.length ?? null,
      probes: { tokenInfo: infoR.ok, holders: holdersR.ok, source: srcR.ok, scan: !!scan },
      synthesis_model: SYNTH,
      disclaimer: "Evidence-based on-chain risk signals only. Not financial advice, not a guarantee, not exhaustive. On-chain analysis cannot detect off-chain or social scams.",
    };
    const out = { report, address, chain, sources, tables, meta };
    if (process.env.RESEARCH_DEBUG === "1") out._debug = { infoBlock, verifyBlock, holderBlock, scanBlock, webBlock };
    recordCompositeUsage({ slug: tierSlug, upstreamUsd: spent, ok: true, priceUsd: priceUsdOf(TOKEN_RISK_TIERS[tierSlug]) });
    return out;
  };
}

const SCHEMA = {
  type: "object",
  required: ["address"],
  properties: {
    address: { type: "string", description: "Token contract address (0x + 40 hex)." },
    chain: { type: "string", description: "Chain: base (default), ethereum, polygon, arbitrum, optimism, bsc, gnosis, or celo." },
    format: { type: "string", enum: ["markdown", "json"], description: "Response shape (default markdown report)." },
  },
};
const OUT_EXAMPLE = {
  report: "# Token & Contract Risk Report: EXAMPLE (0x…)\n\n## Snapshot\n...\n\n## Risk summary\n... This is not financial advice and not exhaustive.",
  address: "0x0000000000000000000000000000000000000000", chain: "base",
  sources: [],
  tables: [{ name: "holders", label: "Top holders", columns: ["Rank", "Address", "Share of supply", "Type", "Label"], rows: [["1", "0x…", "42.10%", "contract", "Uniswap V3 Pool"]] }],
  meta: { tier: "token-risk", address: "0x…", chain: "base", name: "Example", symbol: "EXMP", verified_source: true, holder_count: 1234, top1_share_pct: 42.1, top10_share_pct: 71.5, synthesis_model: "anthropic/claude-opus-5", disclaimer: "Evidence-based on-chain risk signals only. Not financial advice." },
};

export const TOKEN_RISK_TOOLS = [
  {
    route: "POST /v1/token-risk", name: "Token & contract risk report (on-chain evidence)", slug: "token-risk", category: "llm", price: TOKEN_RISK_TIERS["token-risk"].price,
    description: "Hand over a token contract address (and chain) and get one evidence-based on-chain risk report: whether the source is verified, holder concentration (top-1 / top-10 share of supply, distinguishing pools/contracts from wallets), and supply + market context, with a top-holders appendix. Evidence, never a 'safe' or 'scam' verdict - on-chain checks can't see off-chain rugs, so a clean report is not an endorsement. USDC (x402/MPP). Not cached.",
    tags: ["crypto", "token", "risk", "rug", "holders", "concentration", "contract", "verified-source", "onchain", "agent", "premium"],
    discovery: { bodyType: "json", input: { address: "0x4200000000000000000000000000000000000006", chain: "base" }, inputSchema: SCHEMA, output: { example: OUT_EXAMPLE } },
    handler: makeTokenRiskHandler("token-risk"),
  },
  {
    route: "POST /v1/token-risk/pro", name: "Token & contract risk report - PRO (static scan + reputation)", slug: "token-risk-pro", category: "llm", price: TOKEN_RISK_TIERS["token-risk-pro"].price,
    description: "The deeper tier: everything in the standard report plus a deterministic static-pattern scan of the verified source (tx.origin auth, delegatecall, selfdestruct, unchecked calls, reentrancy surface, etc. - heuristic triage, not a formal audit), more holders, and a web reputation check. Still evidence, never a verdict. USDC (x402/MPP). Not cached.",
    tags: ["crypto", "token", "risk", "rug", "static-analysis", "solidity", "reputation", "contract", "onchain", "agent", "premium"],
    discovery: { bodyType: "json", input: { address: "0x4200000000000000000000000000000000000006", chain: "base" }, inputSchema: SCHEMA, output: { example: { ...OUT_EXAMPLE, meta: { ...OUT_EXAMPLE.meta, tier: "token-risk-pro" } } } },
    handler: makeTokenRiskHandler("token-risk-pro"),
  },
];

// Upstream-usage telemetry wrapper: a successful run records its exact spend at
// the return site; a failed run (thrown >= 400, not charged) is recorded here
// so the burn on failures is visible too (spend unknown at this point -> 0).
const priceUsdOf = (t) => Number(String(t?.price ?? "").replace(/[^0-9.]/g, "")) || null;
export function makeTokenRiskHandler(tierSlug) {
  const run = makeTokenRiskHandlerInner(tierSlug);
  return async (input, req) => {
    try { return await run(input, req); }
    catch (e) { try { recordCompositeUsage({ slug: tierSlug, upstreamUsd: 0, ok: false, priceUsd: priceUsdOf(TOKEN_RISK_TIERS[tierSlug]) }); } catch { /* never mask the real error */ } throw e; }
  };
}
