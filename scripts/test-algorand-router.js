// Offline unit tests for the Algorand external router:
//   - pickPayableAccept: per-chain accept pinning (decoys, cross-chain confusion)
//   - rankAlgorandResources: GoPlausible-catalog ranking + gates
//   - route-execute chain matching: buyer's payment network -> settlement chain
//   - AVM buyer gating (503 without the mnemonic, configured flag)
// No network, no server boot.
import assert from "node:assert";
import { pickPayableAccept, avmBuyerConfigured, getUpstreamBuyerAvm, avmBuyerStatus, BUYER_CHAINS } from "../src/x402-buyer.js";
import { rankAlgorandResources, mergeCrawledResources, proveCrawledResources } from "../src/algorand-sellers.js";
import { buildRouteExecuteTool, EXTERNAL_CHAIN_BY_NETWORK } from "../src/tools/route-execute.js";

let passed = 0, failed = 0;
const ok = (cond, name) => { if (cond) { passed++; console.log(`ok - ${name}`); } else { failed++; console.log(`FAIL - ${name}`); } };

const ALGO_CAIP2 = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// --- pickPayableAccept -------------------------------------------------------
{
  const baseAccept = { network: "eip155:8453", scheme: "exact", asset: USDC_BASE, amount: "5000" };
  const algoAccept = { network: ALGO_CAIP2, scheme: "exact", asset: "31566704", amount: "7000" };
  ok(pickPayableAccept([algoAccept, baseAccept], "base") === baseAccept, "base pin skips the Algorand entry");
  ok(pickPayableAccept([baseAccept, algoAccept], "algorand") === algoAccept, "algorand pin skips the Base entry");
  ok(pickPayableAccept([{ ...algoAccept, asset: "12345678" }], "algorand") === null, "wrong ASA id rejected");
  ok(pickPayableAccept([{ ...algoAccept, scheme: "deferred" }], "algorand") === null, "non-exact scheme rejected");
  ok(pickPayableAccept([{ ...algoAccept, network: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe" }], "algorand") === null, "testnet-genesis network rejected");
  // Decoy ordering: a cheap non-USDC decoy first must not shadow the real entry.
  const decoy = { network: ALGO_CAIP2, scheme: "exact", asset: "999", amount: "1" };
  ok(pickPayableAccept([decoy, algoAccept], "algorand") === algoAccept, "cheap wrong-asset decoy first: real USDC accept still pinned");
  ok(pickPayableAccept([baseAccept], "nope") === null, "unknown chain -> null");
  ok(BUYER_CHAINS.algorand.caip2 === ALGO_CAIP2, "algorand CAIP-2 constant matches mainnet genesis");
}

// --- rankAlgorandResources ---------------------------------------------------
{
  const rs = [
    { url: "https://a.example/price", origin: "https://a.example", path: "/pricecheck", method: "GET", description: "live crypto price check for any asset", amountAtomic: "5000", priceUsd: 0.005, verifs: 900 },
    { url: "https://b.example/telemetry", origin: "https://b.example", path: "/telemetry", method: "GET", description: "grid bot telemetry", amountAtomic: "5000", priceUsd: 0.005, verifs: 60 },
    { url: "https://c.example/price", origin: "https://c.example", path: "/price", method: "GET", description: "crypto price feed", amountAtomic: "900000", priceUsd: 0.9, verifs: 5000 },
    { url: "https://d.example/price", origin: "https://d.example", path: "/price", method: "GET", description: "crypto price feed", amountAtomic: "5000", priceUsd: 0.005, verifs: 3 },
  ];
  const ranked = rankAlgorandResources(rs, "crypto price check", { capUsd: 0.5, minVerifs: 50 });
  ok(ranked.length === 1 && ranked[0].origin === "https://a.example", "in-cap proven keyword match wins; over-cap and under-proven gated out");
  ok(rankAlgorandResources(rs, "crypto price", { capUsd: 0.5, minVerifs: 50, excludeOrigin: "https://a.example" }).every((r) => r.origin !== "https://a.example"), "excludeOrigin (self) is filtered");
  ok(rankAlgorandResources(rs, "quantum yodeling", { capUsd: 0.5, minVerifs: 50 }).length === 0, "no keyword overlap -> no candidates");
  ok(rankAlgorandResources(rs, "", { capUsd: 0.5 }).length === 0, "empty task -> no candidates");
}

// --- route-execute chain matching -------------------------------------------
{
  const CATALOG = {};
  const tier = { slug: "route-execute-max", execPriceUsd: 0.55, underlyingMaxUsd: 0.5 };
  const paymentReq = (network) => ({
    header: (n) => (String(n).toLowerCase() === "x-payment"
      ? Buffer.from(JSON.stringify({ x402Version: 2, accepted: { network }, payload: {} })).toString("base64")
      : undefined),
  });
  const seller = { seller: "https://algo.example", slug: "pricecheck", url: "https://algo.example/pricecheck", method: "GET", price: "$0.005", networks: [ALGO_CAIP2] };
  let resolvedChain = null, paidChain = null;
  const tool = buildRouteExecuteTool({
    getCatalog: () => CATALOG, tier,
    resolveExternal: async (_task, { chain }) => { resolvedChain = chain; return chain === "algorand" ? seller : null; },
    payExternal: async (_url, { chain }) => { paidChain = chain; return { result: { ok: 1 }, quote: { usd: 0.005 }, receipt: { transaction: "ALGOTX" } }; },
    externalEnabled: () => true,
    externalChains: () => ["base", "algorand"],
  });

  // Algorand buyer + AVM wallet configured -> resolves and pays on algorand.
  const r = await tool.handler({ task: "crypto price check", include: "external" }, paymentReq(ALGO_CAIP2));
  ok(resolvedChain === "algorand" && paidChain === "algorand", "algorand payment routes resolve+pay on the algorand chain");
  ok(r.receipt.settleNetwork === ALGO_CAIP2 && r.receipt.settleTx === "ALGOTX", "receipt carries the AVM settle network + tx");
  ok(r.result.untrustedContent === true, "external result marked untrusted");

  // Algorand buyer but NO AVM wallet -> 409 naming the supported chain.
  const baseOnly = buildRouteExecuteTool({
    getCatalog: () => CATALOG, tier,
    resolveExternal: async () => seller, payExternal: async () => ({ result: {} }),
    externalEnabled: () => true, externalChains: () => ["base"],
  });
  let threw = null;
  try { await baseOnly.handler({ task: "crypto price check", include: "external" }, paymentReq(ALGO_CAIP2)); } catch (e) { threw = e; }
  ok(threw?.statusCode === 409 && /base \(eip155:8453\)/.test(threw.message), "algorand payment without AVM wallet: 409 names supported chains");

  // Unsupported chain (Solana) -> 409 even with AVM configured.
  threw = null;
  try { await tool.handler({ task: "x", include: "external" }, paymentReq("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")); } catch (e) { threw = e; }
  ok(threw?.statusCode === 409, "solana payment: 409 (no spending wallet chain match)");

  // No payment header (free mode) -> defaults to the base path.
  resolvedChain = null;
  try { await tool.handler({ task: "crypto price check", include: "external" }, { header: () => undefined }); } catch { /* resolver returns null on base — 404 is fine */ }
  ok(resolvedChain === "base", "free-mode request defaults external resolution to base");

  ok(EXTERNAL_CHAIN_BY_NETWORK[ALGO_CAIP2] === "algorand" && EXTERNAL_CHAIN_BY_NETWORK["eip155:8453"] === "base", "network->chain map covers both rails");
}

// --- AVM buyer gating --------------------------------------------------------
{
  delete process.env.ALGORAND_UPSTREAM_BUYER_MNEMONIC;
  ok(avmBuyerConfigured() === false, "avmBuyerConfigured false without mnemonic");
  let threw = null;
  try { await getUpstreamBuyerAvm(); } catch (e) { threw = e; }
  ok(threw?.statusCode === 503 && /ALGORAND_UPSTREAM_BUYER_MNEMONIC/.test(threw.message), "AVM buyer throws a self-explaining 503 when unconfigured");
  process.env.ALGORAND_UPSTREAM_BUYER_MNEMONIC = "x";
  ok(avmBuyerConfigured() === true, "avmBuyerConfigured true when set");
  delete process.env.ALGORAND_UPSTREAM_BUYER_MNEMONIC;
}

// --- AVM buyer balance status ------------------------------------------------
{
  delete process.env.ALGORAND_UPSTREAM_BUYER_MNEMONIC;
  const s = await avmBuyerStatus();
  ok(s.configured === false && s.status === "unconfigured", "avmBuyerStatus unconfigured without mnemonic (never pages)");
}

// --- our own index as a second source ---------------------------------------
// GoPlausible's catalog was the ONLY source of both candidates and proof, so an
// Algorand seller we crawled ourselves could never be routed to however much it
// settled - the Base registry-dependence fixed the same day, one step worse,
// because here such a seller was not even a candidate. Both halves are pure and
// tested offline; the indexer read is injected.
{
  const facilitator = [
    { url: "https://known.example/api/a", origin: "https://known.example", path: "/api/a", method: "GET", description: "known", amountAtomic: "1000", priceUsd: 0.001, verifs: 120 },
  ];
  const crawled = [
    // Same resource the facilitator lists, plus the payTo only we know.
    { url: "https://known.example/api/a", method: "GET", description: "ours", amountAtomic: "1000", payTo: "A".repeat(58) },
    // A seller the facilitator has never seen.
    { url: "https://selfreg.example/v1/x", method: "POST", description: "self-registered", amountAtomic: "5000", payTo: "B".repeat(58) },
    { url: "http://insecure.example/v1/x", method: "GET", description: "plain http", amountAtomic: "5000", payTo: "C".repeat(58) },
    { url: "https://noprice.example/v1/x", method: "GET", description: "no price", amountAtomic: "", payTo: "D".repeat(58) },
  ];
  const { merged, added } = mergeCrawledResources(facilitator, crawled);
  ok(added === 1, `only the unseen https priced route is added (${added})`);
  const kept = merged.find((r) => r.url === "https://known.example/api/a");
  ok(kept.verifs === 120 && kept.description === "known", "a resource the facilitator lists keeps its witness count and wording");
  ok(kept.payTo === "A".repeat(58) && kept.source === "both", "and records the payTo only our crawl knew");
  const fresh = merged.find((r) => r.url === "https://selfreg.example/v1/x");
  ok(fresh && fresh.verifs === 0, "a crawl-only route starts UNPROVEN, so the router's gate still refuses it");
  ok(fresh.priceUsd === 0.005 && fresh.method === "POST", "its price and verb come from our own row");

  // Proof comes from the chain, asked once per payTo, and only a real count counts.
  let asked = [];
  await proveCrawledResources(merged, async (p) => { asked.push(p); return p === "B".repeat(58) ? 61 : 0; });
  ok(asked.length === 1 && asked[0] === "B".repeat(58), "the chain is asked once, only for the unproven crawl-only payTo");
  ok(merged.find((r) => r.url === "https://selfreg.example/v1/x").verifs === 61, "a real inbound count becomes its settlement evidence");
  ok(kept.verifs === 120, "the facilitator's own count is never overwritten by ours");

  // An unreadable chain must never read as activity.
  const two = mergeCrawledResources([], [{ url: "https://x.example/a", method: "GET", amountAtomic: "1000", payTo: "E".repeat(58) }]).merged;
  await proveCrawledResources(two, async () => { throw new Error("indexer down"); });
  ok(two[0].verifs === 0, "an indexer failure leaves the seller unproven, never trusted");
  await proveCrawledResources(two, async () => "not a number");
  ok(two[0].verifs === 0, "a junk count is refused too");
  ok(rankAlgorandResources(two, "anything", { capUsd: 1, minVerifs: 50 }).length === 0, "and the router's gate refuses an unproven crawl-only seller end to end");
}

// The halves only matter if the catalog build reaches them and the server
// supplies both: a pure-function test passes either way.
{
  const { readFileSync } = await import("node:fs");
  const mod = readFileSync(new URL("../src/algorand-sellers.js", import.meta.url), "utf8");
  ok(/mergeCrawledResources\(out, await sources\.crawledResources\(\)\)/.test(mod), "the catalog build folds in our crawled resources");
  ok(/proveCrawledResources\(out, sources\.countInbound\)/.test(mod), "and proves them from the injected chain read");
  ok(/catch \{ out = resources; \}/.test(mod), "a failure in either half falls back to the facilitator catalog untouched");
  const srv = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/setAlgorandCrawlSources\(\{[\s\S]{0,1600}countInbound:/.test(srv), "the server supplies both halves");
  ok(/receiver === payTo && t\?\.sender !== payTo/.test(srv), "the inbound count excludes a seller paying itself");
}

console.log(`\ntest-algorand-router: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
