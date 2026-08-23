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

function safeUser(req) { try { return req ? upstreamUserId(req) : undefined; } catch { return undefined; } }

const SYNTH = "anthropic/claude-opus-5";
const GROUND = "google/gemini-2.5-flash";
export const TOKEN_RISK_MODELS = [SYNTH, GROUND];

export const TOKEN_RISK_TIERS = {
  "token-risk": { price: "$0.30", maxUpstreamUsd: 0.25, holders: 20, scan: false, web: 0, synthMaxTokens: 3500, words: "~1,200" },
  "token-risk-pro": { price: "$0.60", maxUpstreamUsd: 0.50, holders: 50, scan: true, web: 1, synthMaxTokens: 5000, words: "~1,900" },
};

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const PROBE_TIMEOUT_MS = 22_000;
const SEARCH_TIMEOUT_MS = 45_000;
const SYNTH_TIMEOUT_MS = 120_000;
// Chains covered by BOTH the holder/token probes and Sourcify source verification.
const CHAINS = new Set(["base", "ethereum", "polygon", "arbitrum", "optimism", "bsc", "gnosis", "celo"]);

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
    const [infoR, holdersR, srcR] = await Promise.all([
      settle(H("token-info")({ chain, address }), PROBE_TIMEOUT_MS),
      settle(H("token-holders")({ chain, address, limit: t.holders }), PROBE_TIMEOUT_MS),
      settle(H("contract-source")({ address, network: chain }), PROBE_TIMEOUT_MS),
    ]);
    const info = infoR.ok ? infoR.data : null;
    const holdersData = holdersR.ok ? holdersR.data : null;
    const src = srcR.ok ? srcR.data : null;
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
      ? `Name ${info.name || "?"} (${info.symbol || "?"}), type ${info.type || "?"}, decimals ${info.decimals ?? "?"}. Total supply ${totalSupply ?? "unknown"}. Holder count ${info.holders ?? "?"}. Market cap ${info.circulatingMarketCap ?? "unknown"}.`
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

    // 4) SYNTHESIZE - evidence-based, NEVER a definitive safe/scam verdict.
    const synthPrompt = `You are a blockchain analyst writing a TOKEN & CONTRACT RISK REPORT on ${address} (${chain}) that will be SOLD to a paying customer. It must be scrupulously honest and evidence-based.

=== ABSOLUTE RULES ===
1. Use ONLY the on-chain probe data and (if present) web reputation below. Never invent a holder, figure, finding, or fact.
2. This is an EVIDENCE-BASED RISK ASSESSMENT, NOT financial advice and NOT a guarantee. NEVER declare the token "safe", "legitimate", "a scam", or "a rug". Instead describe the concrete risk SIGNALS and what they do and do not tell us. State explicitly that on-chain analysis cannot detect off-chain rug mechanisms, social-engineering scams, malicious future upgrades, or hidden owner privileges not visible here, and that a clean report is NOT an endorsement - the reader must do their own research.
3. Interpret holder concentration CAREFULLY using the LABELS given ([burn/dead], [contract], [EOA]): [burn/dead] holdings are supply OUT of circulation (not concentration risk); [contract] holdings are pools/bridges/staking contracts (weigh differently from a person's wallet); only large [EOA] holdings are true single-wallet concentration. Never call burned or pool-held supply "concentration risk"; say which kind each large holder is.
4. Treat an UNVERIFIED source as a real but not conclusive signal; treat static-scan findings as heuristic triage, not a formal audit.

Write a clear, structured report of up to ${t.words} words: SNAPSHOT (what the token is, supply, holders, market context), SOURCE VERIFICATION, HOLDER CONCENTRATION (with the contract-vs-EOA nuance), ${t.scan ? "STATIC CODE SIGNALS, " : ""}${t.web ? "REPUTATION & CONTEXT, " : ""}and a RISK SUMMARY that lists the specific signals found (elevated, neutral, or reassuring) and closes with the plain caveat that this is not advice and not exhaustive. Do NOT write a sources section.

=== TOKEN INFO ===\n${infoBlock}
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
