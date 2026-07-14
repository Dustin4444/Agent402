// Synthetic self-check — the missing "is a paid tool actually working in prod?"
// signal.
//
// The gap this closes: earnings-calendar failed 100% for weeks and NOTHING
// caught it. CI's "answers its own example" check only runs pre-deploy; the
// aggregate error rate on /api/stats drowns a single low-traffic tool; and the
// live test suites are deliberately failure-tolerant (they warn-and-continue on
// upstream errors). So a green board + passing tests coexisted with a dead tool.
//
// This runs a CURATED set of high-value tools' OWN documented examples live,
// in-process (no HTTP, no payment — we call the handler directly), so a broken
// tool is caught immediately, independent of organic traffic. A GitHub Action
// (tool-alert.yml) polls /api/selfcheck and opens an issue when any curated tool
// fails — the same open/close pattern as the 15-minute heartbeat.
//
// Deliberately NOT all 501 tools: many legitimately return 503 without a key
// or 4xx on placeholder example inputs, which would be pure noise. This list is
// the tools whose outage actually costs us — the finance/market-data wedge that
// real buyers pay for — plus a pure-CPU canary that isolates "the server itself
// is fine" from "an upstream broke".

export const SELFCHECK_SLUGS = [
  "hash",                  // pure-CPU canary — proves the server itself is healthy
  "stock-quote",           // wedge star (Yahoo, via relay in prod)
  "earnings-calendar",     // the tool that silently died (Nasdaq UA)
  "treasury-debt",         // Treasury Fiscal Data
  "treasury-avg-rates",    // Treasury Fiscal Data
  "treasury-yield-curve",  // FRED CSV (keyless — also proves FRED CSV is reachable)
  "fx-dashboard",          // ECB / Frankfurter
  "stock-history",         // wedge (Yahoo) — second Yahoo endpoint beyond the quote
  "crypto-market",         // crypto prices
  "whois",                 // DNS / RDAP
  // High-value paid tools the reliability review flagged as unmonitored — added so
  // a break in EDGAR / crypto / on-chain / DeFi is caught proactively (synthetically,
  // no real traffic needed), not only when an agent happens to pay-and-fail. Keyless.
  "company-financials",    // SEC EDGAR — the priciest tool ($0.02)
  "edgar-company-lookup",  // SEC EDGAR
  "price-coingecko",       // CoinGecko price
  "defi-tvl",              // DeFiLlama
  "gas-estimate",          // on-chain gas (public RPC)
  "crypto-global",         // crypto market globals
  // FDA + NHTSA federal-data pack — monitored with semantic invariants (a fixed
  // VIN, a permanent recall) so a break in an openFDA/NHTSA mapping pages us.
  "vin-decode",            // NHTSA vPIC
  "vehicle-recalls",       // NHTSA recalls
  "drug-recalls",          // openFDA drug enforcement
  "food-recalls",          // openFDA food enforcement
  "drug-adverse-events",   // openFDA FAERS
  "device-recalls",        // openFDA device enforcement
  "college-lookup",        // College Scorecard (api.data.gov key, DEMO fallback)
  "fec-candidates",        // FEC (api.data.gov key, DEMO fallback)
  "federal-awards",        // USAspending (POST search)
  "geo-lookup",            // FCC Area API (lat/lon -> county/state)
  "fema-disasters",        // openFEMA disaster declarations
];
// Semantic invariants — the teeth on the self-check. Running a tool's example
// and seeing it "not throw" catches a dead upstream, but NOT a tool that returns
// the wrong thing (an upstream that changed shape, a mapping we broke). Each
// invariant gets the handler's result for the tool's documented example input
// and returns true iff the KNOWN-CORRECT answer still holds. Facts must be
// permanent so this can never flake on live values: a fixed VIN decodes to the
// same car forever, a historical recall never un-happens, the national debt only
// grows, a stock has a positive price. A tool with an invariant is only "ok" when
// it ran AND the invariant held. (Applied in checkOne; retried like any failure.)
export const INVARIANTS = {
  // FDA + NHTSA pack (this batch)
  "vin-decode": (r) => r?.vehicle?.make === "HONDA" && r?.vehicle?.year === "2003",
  "vehicle-recalls": (r) => Number(r?.count) >= 1 && !!r?.recalls?.[0]?.campaign,
  "drug-recalls": (r) => Number(r?.count) >= 1 && !!r?.recalls?.[0]?.classification,
  "food-recalls": (r) => Number(r?.count) >= 1,
  "drug-adverse-events": (r) => Array.isArray(r?.topReactions) && r.topReactions.length >= 1 && typeof r.topReactions[0]?.reports === "number",
  "device-recalls": (r) => Number(r?.count) >= 1 && !!r?.recalls?.[0]?.classification,
  "college-lookup": (r) => Number(r?.count) >= 1 && /stanford/i.test(r?.colleges?.[0]?.name || "") && r.colleges[0].state === "CA",
  "fec-candidates": (r) => Number(r?.count) >= 1 && !!r?.candidates?.[0]?.candidateId,
  "federal-awards": (r) => Number(r?.count) >= 1 && Number(r?.awards?.[0]?.amountUsd) > 0,
  "geo-lookup": (r) => r?.state === "CA" && /los angeles/i.test(r?.county || ""), // fixed coords -> fixed county
  "fema-disasters": (r) => Number(r?.count) >= 1 && typeof r?.disasters?.[0]?.disasterNumber === "number",
  // revenue-critical existing tools (stable facts, not live values)
  "stock-quote": (r) => typeof r?.price === "number" && r.price > 0 && !!r?.symbol,
  "treasury-debt": (r) => Number(r?.totalPublicDebtOutstanding) > 30e12, // debt only grows; already >$30T
  "crypto-global": (r) => Number(r?.totalMarketCap) > 0 && Number(r?.btcDominancePct) > 0 && Number(r?.btcDominancePct) < 100,
  "whois": (r) => !!r?.domain && Array.isArray(r?.nameservers), // registered domain resolves with a nameserver list
};

// Key-gated tools: checked ONLY when their key env var is actually set. This is
// how we monitor key EXPIRY without false-paging on an intentional unset — a
// set-but-invalid key makes the tool fail and we page; an unset key is simply
// skipped (a fork or a deliberately-disabled feature never trips the alarm).
// These cover the keyed tools whose outage costs revenue: FRED (macro) and
// Brave (search — a top earner).
export const KEYED_SELFCHECKS = [
  { slug: "cpi-yoy", envVar: "FRED_API_KEY" },  // FRED JSON API — key expiry ⇒ every FRED tool dies
  { slug: "search", envVar: "BRAVE_API_KEY" },  // Brave search — top revenue tool
];

// The effective curated list for this deployment: the always-on keyless set plus
// any key-gated tool whose key is configured here. Computed at call time because
// it depends on process.env.
export function selfcheckSlugs() {
  const keyed = KEYED_SELFCHECKS
    .filter((k) => (process.env[k.envVar] || "").trim())
    .map((k) => k.slug);
  return [...SELFCHECK_SLUGS, ...keyed];
}

// Run one tool's documented example, with a hard timeout. Returns a plain result
// object; never throws.
async function checkOne(def, timeoutMs) {
  const input = def.discovery?.input || {};
  const t0 = Date.now();
  let timer;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => def.handler(input)),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(Object.assign(new Error("selfcheck timeout"), { statusCode: 504 })), timeoutMs);
      }),
    ]);
    // Semantic invariant (if defined): the tool ran, but did it return the
    // known-correct answer? A false invariant is a real regression, not a blip.
    const invariant = INVARIANTS[def.slug];
    if (invariant) {
      let held = false;
      try { held = !!invariant(result); } catch { held = false; }
      if (!held) return { slug: def.slug, ok: false, ms: Date.now() - t0, status: 0, error: "invariant failed: ran but returned an unexpected answer (upstream shape change?)" };
    }
    return { slug: def.slug, ok: true, ms: Date.now() - t0 };
  } catch (e) {
    return { slug: def.slug, ok: false, ms: Date.now() - t0, status: e?.statusCode || 0, error: String(e?.message || e).slice(0, 160) };
  } finally {
    clearTimeout(timer); // don't leave a pending timer holding the loop after a fast success
  }
}

// Run the curated self-check against a route→def CATALOG. Each failing tool is
// retried ONCE after a short backoff before being reported failed, so a single
// transient upstream blip (Yahoo/Nasdaq hiccup) can't page us — only a tool that
// fails twice in a row is real.
export async function runSelfCheck(catalog, slugs = selfcheckSlugs(), { timeoutMs = 12000 } = {}) {
  const bySlug = new Map();
  for (const def of Object.values(catalog)) bySlug.set(def.slug, def);
  const results = [];
  for (const slug of slugs) {
    const def = bySlug.get(slug);
    if (!def) { results.push({ slug, ok: false, error: "not in catalog" }); continue; }
    let r = await checkOne(def, timeoutMs);
    if (!r.ok) {
      await new Promise((res) => setTimeout(res, 501));
      const retry = await checkOne(def, timeoutMs);
      // Keep the retry's verdict; note that it took two tries to fail.
      r = retry.ok ? { ...retry, flaky: true } : retry;
    }
    results.push(r);
  }
  const failing = results.filter((r) => !r.ok).map((r) => r.slug);
  return {
    ok: failing.length === 0,
    checked: results.length,
    failing,
    results,
    at: new Date().toISOString(),
  };
}
