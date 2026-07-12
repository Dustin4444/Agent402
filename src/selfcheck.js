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
// Deliberately NOT all 1,420 tools: many legitimately return 503 without a key
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
];
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
    await Promise.race([
      Promise.resolve().then(() => def.handler(input)),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(Object.assign(new Error("selfcheck timeout"), { statusCode: 504 })), timeoutMs);
      }),
    ]);
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
      await new Promise((res) => setTimeout(res, 500));
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
