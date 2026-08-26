// Price-feed kit — three deterministic gateway tools that surface public price
// + TVL data feeds without requiring a key in our deployment:
//
//   • price-pyth      — Pyth Hermes API (keyless, sub-second updates, 400+ feeds)
//   • price-coingecko — CoinGecko public simple/price (keyless free tier)
//   • defi-tvl        — DeFiLlama protocol TVL (keyless, refreshed every 5m)
//
// Wallet-only (each call costs egress + counts against the upstream's public
// rate limit), never PoW-eligible. Covered by scripts/test-price-feed-kit.js.

const TIMEOUT_MS = 10_000;

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

async function feedFetch(url) {
  const host = new URL(url).hostname;
  const headers = { Accept: "application/json" };
  // CoinGecko demo key rides along when configured (call-time read, same header
  // as crypto-kit's jsonGet). Keyless CoinGecko is metered per IP — and our
  // egress IP is shared with every other Railway tenant.
  if (host === "api.coingecko.com" && process.env.COINGECKO_API_KEY) {
    headers["x-cg-demo-api-key"] = process.env.COINGECKO_API_KEY;
  }
  let res;
  try {
    res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // Keep the evidence: the transport cause must reach the server log, not
    // vanish into a generic 504.
    console.warn(`[price-feed] upstream unreachable: ${host} → ${err.name ?? err.code ?? err.message}`);
    throw bad("Price feed upstream timed out", 504);
  }
  if (res.status === 429) throw bad("Price feed rate limit reached upstream - retry shortly", 503);
  if (res.status === 404) throw bad("Price feed upstream: not found (check ids / contract)", 404);
  if (!res.ok) throw bad(`Price feed upstream error (HTTP ${res.status})`, 502);
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("json")) {
    throw bad(`Price feed upstream returned non-JSON (${ct.split(";")[0] || "unknown"})`, 502);
  }
  try { return await res.json(); }
  catch { throw bad("Price feed upstream returned malformed JSON", 502); }
}

// Pyth quotes prices as { price, expo } where the human value is price * 10**expo.
// expo is almost always negative (e.g. -8 means the integer is in 1e-8 units).

// price-pyth was RETIRED 2026-08-26: Pyth put Hermes behind a Bearer key at
// 16:00 UTC that day (keyless = 401), the base API plan is $500/month, and the
// tool had zero external use in the ledger's history (retirement rule, CLAUDE.md).
export const PRICE_FEED_TOOLS = [
  // ===========================================================================
  // price-pyth — by Pyth feed ID (or a small set of well-known aliases).
  // ===========================================================================
  {
    route: "POST /api/price-coingecko",
    name: "CoinGecko spot price",
    slug: "price-coingecko",
    category: "crypto",
    price: "$0.001",
    description:
      "Live spot price (and optional 24-hour change) for one or more coins from CoinGecko's public Simple Price endpoint. Identify coins by their CoinGecko ID slug (bitcoin, ethereum, solana, usd-coin, …). Defaults to USD; pass a `vsCurrency` to denominate in EUR, JPY, ETH, BTC, etc.",
    tags: ["crypto", "price", "coingecko", "spot", "market"],
    discovery: {
      bodyType: "json",
      input: { ids: ["bitcoin", "ethereum"] },
      inputSchema: {
        properties: {
          ids: { type: "array", description: "CoinGecko coin IDs (e.g. bitcoin, ethereum, solana). 1-25 entries." },
          vsCurrency: { type: "string", description: "Quote currency (default usd). Supports any CoinGecko vs_currencies value." },
          include24hChange: { type: "boolean", description: "Include 24h % change in the response (default false)." },
        },
        required: ["ids"],
      },
      output: {
        example: {
          count: 2, vsCurrency: "usd",
          prices: [
            { id: "bitcoin", price: 67000.12, change24h: null },
            { id: "ethereum", price: 3500.05, change24h: null },
          ],
        },
      },
    },
    handler: async (i) => {
      if (!Array.isArray(i.ids) || i.ids.length === 0) throw bad(`"ids" must be a non-empty array`);
      if (i.ids.length > 25) throw bad(`"ids" cannot exceed 25 entries`);
      const ids = i.ids.map((x) => {
        if (typeof x !== "string" || !x.trim()) throw bad(`Each id must be a non-empty string`);
        if (!/^[a-z0-9-]+$/i.test(x.trim())) throw bad(`"${x}" is not a valid CoinGecko id (alphanumerics + hyphens only)`);
        return x.trim().toLowerCase();
      });
      const vs = typeof i.vsCurrency === "string" && /^[a-z]{2,10}$/i.test(i.vsCurrency.trim())
        ? i.vsCurrency.trim().toLowerCase()
        : "usd";
      const wantChange = i.include24hChange === true;
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=${vs}` +
        (wantChange ? `&include_24hr_change=true` : "");
      const data = await feedFetch(url);
      const prices = ids.map((id) => {
        const row = data[id];
        if (!row) return { id, price: null, change24h: null };
        return {
          id,
          price: typeof row[vs] === "number" ? row[vs] : null,
          change24h: wantChange && typeof row[`${vs}_24h_change`] === "number" ? row[`${vs}_24h_change`] : null,
        };
      });
      return { count: prices.length, vsCurrency: vs, prices };
    },
  },

  // ===========================================================================
  // defi-tvl — DeFiLlama protocol TVL by slug.
  // ===========================================================================
  {
    route: "POST /api/defi-tvl",
    name: "DeFi protocol TVL",
    slug: "defi-tvl",
    category: "crypto",
    price: "$0.001",
    description:
      "Look up the current Total Value Locked (TVL) for a DeFi protocol via DeFiLlama's public API. Identify the protocol by its DeFiLlama slug (uniswap, aave, lido, ethena, etc.). Returns the total TVL plus per-chain breakdown and 24h/7d/30d change where DeFiLlama exposes it.",
    tags: ["crypto", "defi", "tvl", "defillama", "protocol"],
    discovery: {
      bodyType: "json",
      input: { protocol: "aave" },
      inputSchema: {
        properties: {
          protocol: { type: "string", description: "DeFiLlama protocol slug (e.g. uniswap, aave, lido). Lowercase, hyphen-separated." },
        },
        required: ["protocol"],
      },
      output: {
        example: {
          protocol: "aave", name: "AAVE", category: "Lending",
          tvlUsd: 15_000_000_000,
          change24h: 0.5, change7d: 2.1, change30d: 8.0,
          chainTvls: [{ chain: "Ethereum", tvlUsd: 11_000_000_000 }],
        },
      },
    },
    handler: async (i) => {
      const protocol = typeof i.protocol === "string" ? i.protocol.trim().toLowerCase() : "";
      if (!protocol) throw bad(`"protocol" is required`);
      if (!/^[a-z0-9-]+$/.test(protocol)) throw bad(`"protocol" must be a slug (lowercase, alphanumerics + hyphens)`);
      const data = await feedFetch(`https://api.llama.fi/protocol/${protocol}`);
      // DeFiLlama returns chainTvls as an object keyed by chain. Flatten for the
      // caller — they don't want to iterate object keys.
      // DeFiLlama's chainTvls object also carries aggregate pseudo-keys
      // (borrowed, staking, pool2, …) and per-chain suffixed variants
      // (Ethereum-borrowed, Polygon-staking). Those are NOT chains and must not be
      // summed as TVL — doing so double-counts and folds in borrowed/staked value
      // (it was overstating TVL ~2.6x). Keep only real, unsuffixed chain keys.
      const PSEUDO_TVL_KEYS = new Set(["borrowed", "staking", "pool2", "offers", "treasury", "vesting", "masterchef", "dcAndLsOverlap"]);
      const isChainKey = (k) => !k.includes("-") && !PSEUDO_TVL_KEYS.has(k);
      const chainTvls = Object.entries(data?.chainTvls ?? {})
        .filter(([chain]) => isChainKey(chain))
        .map(([chain, payload]) => {
          // Newer chainTvls entries are objects { tvl: [...timeseries] }; older
          // ones can be flat numbers. Handle both shapes.
          const series = Array.isArray(payload?.tvl) ? payload.tvl : null;
          const latest = series && series.length ? series[series.length - 1]?.totalLiquidityUSD : (typeof payload === "number" ? payload : null);
          return { chain, tvlUsd: typeof latest === "number" ? latest : null };
        })
        .filter((r) => r.tvlUsd != null && r.tvlUsd > 0)
        .sort((a, b) => b.tvlUsd - a.tvlUsd);
      // Top-level tvlUsd: prefer DeFiLlama's canonical aggregate series (data.tvl,
      // the headline figure), else sum the real (non-pseudo) chains.
      const tvlSeries = Array.isArray(data?.tvl) ? data.tvl : null;
      const headlineTvl = tvlSeries && tvlSeries.length ? tvlSeries[tvlSeries.length - 1]?.totalLiquidityUSD : null;
      const tvlUsd = typeof headlineTvl === "number" && headlineTvl > 0
        ? headlineTvl
        : chainTvls.reduce((a, b) => a + (b.tvlUsd || 0), 0);
      return {
        protocol,
        name: data?.name ?? null,
        category: data?.category ?? null,
        tvlUsd,
        change24h: typeof data?.change_1d === "number" ? data.change_1d : null,
        change7d:  typeof data?.change_7d === "number" ? data.change_7d : null,
        change30d: typeof data?.change_1m === "number" ? data.change_1m : null,
        chainTvls,
      };
    },
  },
];
