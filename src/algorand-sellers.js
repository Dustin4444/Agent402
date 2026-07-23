// Algorand external-seller source for the Smart Order Router.
//
// The Base external path discovers candidates in our own x402 index and gates
// them on PROVEN settled volume from the leaderboard (CDP/Base on-chain data).
// Algorand sellers appear in neither — their catalog AND settlement history
// live with the GoPlausible facilitator — so this module is both halves for
// the AVM chain, from two facilitator surfaces:
//   /discovery/merchants   merchantId -> totalVerifications
//   /discovery/resources   merchantId -> { resourceUrl, method, description,
//                                          accepts (amount, asset) }
// Verifications are facilitator-witnessed payment attempts (settles <=
// verifies); as a proven-activity gate they play the role callsSettled plays
// on Base, and the router's live 402-probe plus payX402's margin guard still
// run before any spend.
//
// Cached ~30 min (the economy-snapshot convention), single-flighted, and
// NEVER throws — a facilitator outage yields an empty catalog, which simply
// gates external Algorand routing closed until the next successful refresh.

const GP_BASE = (process.env.ALGORAND_FACILITATOR_URL || "https://facilitator.goplausible.xyz").replace(/\/+$/, "");
const TTL_MS = Number(process.env.ALGORAND_SELLERS_TTL_MS || 30 * 60 * 1000);
const USDC_ASA = "31566704";
const PAGE = 500;
const MAX_PAGES = 40; // 20k resources — far above today's catalog, bounded forever

let cache = { at: 0, resources: [] };
let inFlight = null;

async function getJson(path) {
  const res = await fetch(`${GP_BASE}${path}`, { signal: AbortSignal.timeout(15000), headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function build() {
  const verifsByMerchant = new Map();
  for (let offset = 0; offset < MAX_PAGES * PAGE; offset += PAGE) {
    const j = await getJson(`/discovery/merchants?limit=${PAGE}&offset=${offset}`);
    const items = j.items || [];
    for (const m of items) {
      if (typeof m?.id === "string") verifsByMerchant.set(m.id, Number(m.totalVerifications) || 0);
    }
    if (items.length < PAGE) break;
  }
  const resources = [];
  for (let offset = 0; offset < MAX_PAGES * PAGE; offset += PAGE) {
    const j = await getJson(`/discovery/resources?limit=${PAGE}&offset=${offset}`);
    const items = j.items || [];
    for (const r of items) {
      const verifs = verifsByMerchant.get(r?.merchantId) || 0;
      // Only USDC-ASA exact accepts are payable from the AVM spending wallet;
      // pick the entry payX402's own pin will later re-validate.
      const accept = (r?.accepts || []).find((a) => String(a?.asset || "") === USDC_ASA && String(a?.scheme || "exact") === "exact");
      const amountAtomic = String(accept?.amount ?? accept?.maxAmountRequired ?? "");
      if (!/^\d+$/.test(amountAtomic)) continue;
      let url;
      try { url = new URL(r.resourceUrl); } catch { continue; }
      // Hygiene: the open catalog contains localhost/plain-http registrations.
      // assertPublicUrl + ssrfDispatcher are the real guards at probe/pay time;
      // this just keeps garbage out of the rankings entirely.
      if (url.protocol !== "https:" || /^(localhost|127\.|10\.|192\.168\.|\[?::1)/i.test(url.hostname)) continue;
      resources.push({
        url: url.href,
        origin: url.origin.toLowerCase(),
        path: url.pathname,
        method: String(r.method || "GET").toUpperCase(),
        description: String(r.description || ""),
        amountAtomic,
        priceUsd: Number(amountAtomic) / 1e6,
        verifs,
      });
    }
    if (items.length < PAGE) break;
  }
  return resources;
}

/** The cached facilitator catalog. Stale cache is served while a deduped
 *  background refresh runs; only a cold cache awaits the build. Failure ->
 *  last known list (possibly empty), never throws. */
export async function algorandCatalog() {
  const stale = Date.now() - cache.at > TTL_MS;
  if (stale && !inFlight) {
    inFlight = build()
      .then((resources) => { cache = { at: Date.now(), resources }; })
      // Keep the last known list; back-date so the next call retries in ~5 min.
      .catch(() => { cache.at = Date.now() - TTL_MS + 5 * 60 * 1000; })
      .finally(() => { inFlight = null; });
  }
  if (!cache.at && inFlight) await inFlight; // build() rejection is swallowed above
  return cache.resources;
}

const tokenize = (s) => String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);

/** Rank the facilitator catalog against a plain-language task. Pure given a
 *  resource list (exported for offline tests): DISTINCT task-token overlap on
 *  description + URL path (a spammy description repeating one keyword can't
 *  outrank a real match), with substring credit against path tokens so
 *  "price check" finds a /pricecheck route. Proven verifications break ties.
 *  Only in-cap, min-proven, non-excluded-origin resources come back. */
export function rankAlgorandResources(resources, task, { capUsd, minVerifs = 50, excludeOrigin = "" } = {}) {
  const want = [...new Set(tokenize(task))];
  if (!want.length) return [];
  const scored = [];
  for (const r of resources) {
    if (!(r.priceUsd > 0 && r.priceUsd <= capUsd)) continue;
    if (r.verifs < minVerifs) continue;
    if (excludeOrigin && r.origin === excludeOrigin) continue;
    const have = new Set(tokenize(r.description));
    const pathTokens = tokenize(r.path);
    let score = 0;
    for (const t of want) {
      if (have.has(t) || pathTokens.includes(t)) score += 1;
      else if (t.length > 3 && pathTokens.some((p) => p.includes(t))) score += 1; // "price" ⊂ "pricecheck"
    }
    if (score > 0) scored.push({ ...r, score });
  }
  return scored.sort((a, b) => b.score - a.score || b.verifs - a.verifs);
}

export function _resetForTest(resources = null) {
  cache = resources ? { at: Date.now(), resources } : { at: 0, resources: [] };
  inFlight = null;
}
