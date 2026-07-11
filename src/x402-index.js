// x402 Index — the live aggregation layer for the agent payments economy.
//
// Two surfaces:
//   • GET  /index   — public HTML dashboard: every seller we've crawled, their
//                     tool count, network, and last-fetched time. Embeddable.
//   • POST /api/route — Smart Order Router. Given a task description, return the
//                     cheapest matching tool across all crawled sellers.
//
// Both are FREE (mounted outside the paywall) — discovery primitives shouldn't
// cost money, by the same logic as /api/find.
//
// How sellers get into the Index:
//   1. The local Agent402 catalog is always present (no network).
//   2. Optional seeds via X402_INDEX_SEEDS env (comma-separated origins) get
//      crawled every 5 minutes. Each crawl fetches /.well-known/x402 + the
//      seller's openapi.json (when present) and caches the result.
//
// Design notes:
//   • In-memory cache (Map) — restart-tolerant by design; no persistence needed.
//     A crawl warms it in <30s and the data is intentionally transient.
//   • All outbound HTTP goes through safeFetch (SSRF-guarded, byte-capped).
//   • Failed crawls log a stale marker; they never crash the process.
//   • The router uses the same lexical scoring shape as /api/find so rankings
//     are consistent whether a buyer searches local-only or cross-seller.
import { readFileSync, writeFileSync } from "node:fs";
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";
import { safeFetch } from "./tools/fetch-guard.js";
import { toolList } from "./pages.js";
import { fetchAllBazaarItems, isBazaarDiscoveryUrl } from "./bazaar-pager.js";
import { RAILS, railKey, truncateCaip2 } from "./rails.js";
import { CHAIN_PAGES, marketSellers } from "./market-page.js";
import { summarize, fmtUsd, fmtPct } from "./economy.js";
import { rankBy, canonicalHost } from "./leaderboard.js";

// RAILS caip2 -> CHAIN_PAGES key, same join the homepage's by-chain strip uses
// (see ledger-home.js) so /index's own row derives the same way: page
// availability from CHAIN_PAGES, live seller counts from marketSellers() run
// against the snapshot this page already renders from — no new plumbing.
const CHAIN_PAGE_BY_CAIP2 = new Map(Object.entries(CHAIN_PAGES).map(([key, cfg]) => [cfg.caip2, key]));

// ?network=<key> matchers for the Sellers table filter chips — one per
// mainnet rail in rails.js, same "EVM = exact CAIP-2, else = namespace
// prefix excluding testnets" rule market-page.js's CHAIN_PAGES.isNetwork
// uses for stellar/algorand (solana gets the same treatment for consistency
// even though it has no market page yet). Keyed by railKey() so a future
// rail lights up a chip here with zero new code.
const NETWORK_MATCHERS = new Map(RAILS.map((r) => {
  const matches = r.chainId
    ? (n) => n === r.caip2
    : (n) => typeof n === "string" && n.startsWith(r.caip2.split(":")[0]) && !n.includes("test");
  return [railKey(r), { label: r.name.replace(/ Chain$/, ""), matches }];
}));

const LOCAL_SELLER = "self";
// /index used to render every crawled seller server-side (~1,477 rows → a
// 475KB response with no compression). Cap the default render to the top N
// by whatever metric the page is currently sorted on; ?all=1 opts back into
// the full table. The local seller is exempt from the cap — it's always the
// one row a self-hoster actually cares about finding.
const INDEX_ROW_CAP = 100;
const CRAWL_INTERVAL_MS = 5 * 60 * 1000; // 5 min — gentle on third-party sellers
const DISCOVERY_INTERVAL_MS = 60 * 60 * 1000; // 1 hr — registries don't change fast
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_OPENAPI_BYTES = 12 * 1024 * 1024; // Agent402's own is ~5 MB; allow headroom
const MAX_DISCOVERY_BYTES = 64 * 1024 * 1024;
// Effectively uncapped for any realistic registry — kept as a sanity guard so a
// malicious registry can't OOM us. Real politeness comes from CRAWL_CONCURRENCY.
const MAX_DISCOVERED_SELLERS = 50000;
const CRAWL_CONCURRENCY = 25; // max parallel seller crawls per cycle — caps outbound fan-out
const HEALTH_WINDOW = 5; // last N crawl outcomes per seller — drives health-aware routing

// Map<originUrl, { manifest, openapi, tools, fetchedAt, error? }>
const cache = new Map();
// Set of origins auto-discovered from public x402 registries (distinct from
// the env-configured seed list so we can show provenance separately on /index).
const discoveredSeeds = new Set();

// --- self-serve listing (POST /api/index/register) ---------------------------
// Origins submitted through the public register endpoint. Persisted to /data
// so a submission survives redeploys; silent in-memory fallback without the
// volume (same posture as stats). All probing goes through crawlSeller() —
// this module never fetches a submitted origin directly.
export const SUBMITTED_SEEDS_FILE = "/data/submitted-seeds.json";
const submittedSeeds = new Set();

// Manual-submission ceiling — a fetch-amplifier guard: every successful probe
// is crawled every 5 minutes forever, so unbounded submissions become
// unbounded outbound fan-out + unbounded /data growth (independent of
// MAX_DISCOVERED_SELLERS, which only guards the registry-discovery path).
// Legitimate growth beyond this goes through DEFAULT_SEEDS or Bazaar discovery.
const DEFAULT_MAX_SUBMITTED_SEEDS = 500;
let submittedSeedsCap = DEFAULT_MAX_SUBMITTED_SEEDS;

/** Test hook: set (or, with no arg, reset) the submission cap. */
export function __testSetSubmittedCap(n) {
  submittedSeedsCap = typeof n === "number" && n >= 0 ? n : DEFAULT_MAX_SUBMITTED_SEEDS;
}

export function loadSubmittedSeeds() {
  try {
    const arr = JSON.parse(readFileSync(SUBMITTED_SEEDS_FILE, "utf8"));
    // Respect the cap even if the file was hand-edited or corrupted into
    // something oversized — the ceiling has to hold on load, not just on write.
    for (const o of Array.isArray(arr) ? arr : []) {
      if (submittedSeeds.size >= submittedSeedsCap) break;
      if (typeof o === "string") { submittedSeeds.add(o); discoveredSeeds.add(o); }
    }
  } catch { /* absent file / no volume — in-memory only */ }
}

function persistSubmittedSeeds() {
  try {
    writeFileSync(SUBMITTED_SEEDS_FILE, JSON.stringify([...submittedSeeds], null, 2));
  } catch { /* best-effort — no volume in local/dev */ }
}

/** Test hook: clear submitted-seed state between test cases. */
export function __testResetSubmitted() { submittedSeeds.clear(); }

/** Validate a raw submitted origin. Returns { origin } (normalized) or { error }. */
export function validateOriginInput(raw, { selfOrigin } = {}) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch { return { error: "origin must be a valid URL" }; }
  if (u.protocol !== "https:") return { error: "origin must be https" };
  if (u.username || u.password) return { error: "origin must not contain credentials" };
  if (u.port && u.port !== "443") return { error: "origin must use the default https port" };
  if ((u.pathname && u.pathname !== "/") || u.search || u.hash) return { error: "submit the bare origin (no path or query)" };
  if (!u.hostname.includes(".")) return { error: "origin must be a public hostname" };
  const origin = `https://${u.hostname.toLowerCase()}`;
  if (selfOrigin && origin === String(selfOrigin).toLowerCase()) return { error: "this host is already the local catalog" };
  return { origin };
}

/**
 * Probe + list a submitted origin. `crawl` is injectable for tests; defaults
 * to the real crawlSeller. Known origins return their current state without
 * a fetch. Successful probes persist the origin as a seed.
 */
export async function registerOrigin(origin, { crawl } = {}) {
  const existing = cache.get(origin);
  if (existing && !existing.error) {
    return { listed: true, origin, seller: sellerSummary(origin, existing) };
  }
  // Cap applies only to origins that would grow the submitted set. An origin
  // already on the list (retrying after a prior failure) is not new growth,
  // so it's exempt — it can still probe and update its own entry at cap.
  if (!submittedSeeds.has(origin) && submittedSeeds.size >= submittedSeedsCap) {
    return { listed: false, origin, error: "submission list is full - open a GitHub issue to get seeded" };
  }
  const doCrawl = crawl || (async (o) => { await crawlSeller(o); return cache.get(o); });
  let v;
  try { v = await doCrawl(origin); } catch (e) { v = { error: String(e?.message || e) }; }
  // Injected test crawlers return the entry directly; the real path re-reads cache.
  if (v && !v.error && (v.tools?.length || v.manifest)) {
    submittedSeeds.add(origin);
    discoveredSeeds.add(origin);
    persistSubmittedSeeds();
    if (!cache.has(origin) && crawl) cache.set(origin, { ...v, fetchedAt: Date.now() });
    return { listed: true, origin, seller: sellerSummary(origin, cache.get(origin) || v) };
  }
  return { listed: false, origin, error: String(v?.error || "no x402 surface found (manifest, OpenAPI, or Bazaar entry)") };
}

function sellerSummary(origin, v) {
  return {
    displayName: v.manifest?.name || origin.replace(/^https?:\/\//, ""),
    toolCount: v.tools?.length || 0,
    networks: [...new Set([...(v.tools || []).flatMap((t) => t.networks || []), ...(bazaarToolsByOrigin.get(origin) || []).flatMap((t) => t.networks || [])])],
    routable: isRoutable(v),
    health: healthScore(v),
  };
}

// Per-source state for the discovery panel on /index.
const discoveryStatus = new Map(); // name -> { url, fetchedAt, resources, origins, error }
// Per-origin synthesized tool list assembled directly from Bazaar resource
// entries. Used as a fallback for sellers whose /.well-known/x402 endpoint
// 404s (the bulk of the unhealthy cohort — they only ever published settled
// resources, never a manifest). Map<origin, Array<tool>>.
const bazaarToolsByOrigin = new Map();

// Public x402 seller registries we crawl. Each exposes an unauthenticated
// discovery endpoint; we extract unique origins from the listings.
//
// agent402.app marketplace is intentionally NOT included: its listing-with-URLs
// view (`/bazaar/quality?details=true`) is already >16MB with 69k+ services and
// growing; the slim view (`/bazaar/quality`) returns summary stats only with no
// per-item URLs. Until they ship a paginated origin-list endpoint, Coinbase CDP
// Bazaar is the canonical source.
const DISCOVERY_SOURCES = [
  { name: "Coinbase CDP Bazaar", url: "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources" },
  // GoPlausible's AVM facilitator registry — where Algorand-native x402
  // sellers live (they register by settling through the facilitator, not on
  // the CDP Bazaar; found 2026-07-10 when the Bazaar showed 2 Algorand
  // origins but this registry had ~8). Same item shape as Bazaar except
  // `resourceUrl` instead of `resource`; synthesizeTools makes their sellers
  // list with tools even when they serve no /.well-known/x402 manifest.
  { name: "GoPlausible AVM registry", url: "https://facilitator.goplausible.xyz/discovery/resources?limit=1000", synthesizeTools: true, seedImmediately: true },
];

// Operator-curated seeds committed in-repo — the version-controlled companion
// to the X402_INDEX_SEEDS env var, and what the /index page's "open a PR adding
// your origin to the seed list" invitation points at. It exists for sellers who
// can't reach the CDP Bazaar auto-discovery source (Coinbase account/phone
// verification blocks). Health-aware routing drops any seed that goes dark, so a
// stale entry self-heals — but keep this to STABLE origins only. No ephemeral
// tunnels (*.trycloudflare.com and friends flap to STALE on every restart).
const DEFAULT_SEEDS = [
  "https://api.aiservices.to", // AgentServices — 46 paid APIs for AI agents (#aiservices)
  "https://agents.daedalusdevelopmentgroup.com", // DDG Agent-Payable Services (#222)
  "https://jmt-x402-proxy.jmthomasofficial.workers.dev", // JMT x402 server (#221)
];

const seedList = () => {
  const envSeeds = String(process.env.X402_INDEX_SEEDS || "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter((s) => /^https?:\/\//i.test(s));
  // committed defaults + env seeds (both operator-curated), then auto-discovered.
  return [...new Set([...DEFAULT_SEEDS, ...envSeeds, ...discoveredSeeds])];
};

function extractOrigin(rawUrl) {
  if (typeof rawUrl !== "string") return null;
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    // Registries carry dev entries (localhost:3000, 127.0.0.1:*) — skip
    // dotless/loopback hosts up front. safeFetch's SSRF guard would block the
    // crawl anyway; this keeps them out of the seed set and off /index.
    if (!u.hostname.includes(".") || u.hostname === "127.0.0.1" || u.hostname === "0.0.0.0") return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

// safeFetch-backed JSON fetcher injected into the Bazaar pager. Each page is
// independently SSRF-guarded and byte-capped — the pager just chains them.
// Accept must say JSON: safeFetch's default Accept prefers text/html, and
// content-negotiating registries (GoPlausible's) serve their docs page for it.
async function safeFetchJson(url) {
  const { html } = await safeFetch(url, { maxBytes: MAX_DISCOVERY_BYTES, headers: { Accept: "application/json" } });
  return JSON.parse(html);
}

async function discoverOneSource(source, selfOrigin) {
  const status = { url: source.url, fetchedAt: Date.now(), resources: 0, origins: 0, error: null };
  try {
    // The Bazaar paginates and has 69k+ listings — a single fetch sees the
    // first page only and the index ends up with <0.2% of sellers. For Bazaar
    // sources walk every page; for other registries keep the single-fetch path
    // (their shapes vary and most have no pagination contract).
    let list;
    if (isBazaarDiscoveryUrl(source.url)) {
      const { items } = await fetchAllBazaarItems(
        source.url,
        {
          pageSize: parseInt(process.env.BAZAAR_PAGE_SIZE || "1000", 10),
          maxPages: parseInt(process.env.BAZAAR_MAX_PAGES || "200", 10),
        },
        safeFetchJson
      );
      list = items;
    } else {
      const data = await safeFetchJson(source.url);
      // Discovery shapes vary by registry: { resources }, { items }, { data },
      // top-level array, or agent402.app's { services: [...] }.
      list =
        data.resources ||
        data.items ||
        data.data ||
        data.services ||
        (Array.isArray(data) ? data : []);
    }
    status.resources = list.length;
    const found = new Set();
    // Rebuild the registry→origin tool map from this discovery pass so renamed /
    // removed resources don't linger. Each registry is authoritative for the
    // origins it lists (per-origin swap below, so two registries listing
    // disjoint origins don't clobber each other).
    const synthesize = isBazaarDiscoveryUrl(source.url) || source.synthesizeTools === true;
    const toolsByOrigin = synthesize ? new Map() : null;
    for (const item of list) {
      const url = item.resource || item.resourceUrl || item.url || item.endpoint || item.homepage;
      const origin = extractOrigin(url);
      if (!origin || origin === selfOrigin) continue;
      found.add(origin);
      if (toolsByOrigin) {
        const t = bazaarItemToTool(item, origin);
        if (t) {
          const arr = toolsByOrigin.get(origin) || [];
          arr.push(t);
          toolsByOrigin.set(origin, arr);
        }
      }
    }
    if (toolsByOrigin) {
      // Atomic swap-in (per-origin) to avoid stale partial state mid-update.
      for (const [o, arr] of toolsByOrigin) bazaarToolsByOrigin.set(o, arr);
    }
    // Small niche-chain registries (GoPlausible's AVM feed) seed a bazaar-
    // fallback cache entry IMMEDIATELY, so their sellers appear the moment we
    // discover them instead of waiting for a crawl cycle to reach them. Many
    // AVM sellers publish no /.well-known/x402 (oyapicks.app 404s), so without
    // this they only surfaced when a crawl happened to run while their tools
    // were populated — flickering across restarts. We never do this for the
    // 1,477-origin CDP Bazaar (crawl-gated by design); only for the handful of
    // origins on a seedImmediately source. A live manifest crawl still upgrades
    // the entry later; we never clobber a good manifest with the fallback.
    if (source.seedImmediately && toolsByOrigin) {
      for (const [o, arr] of toolsByOrigin) {
        const existing = cache.get(o);
        if (!existing || existing.error || existing.source === "bazaar-fallback") {
          cache.set(o, {
            ...(existing || {}),
            manifest: existing?.manifest || synthManifestFromBazaar(o, arr),
            tools: arr,
            fetchedAt: Date.now(),
            error: null,
            source: "bazaar-fallback",
            history: rollHistory(existing, true),
          });
        }
      }
    }
    status.origins = found.size;
    for (const o of found) {
      if (discoveredSeeds.size >= MAX_DISCOVERED_SELLERS) break;
      discoveredSeeds.add(o);
    }
  } catch (e) {
    status.error = String(e.message || e);
  }
  discoveryStatus.set(source.name, status);
}

let selfOriginCache = null;
async function runDiscovery(selfOrigin) {
  selfOriginCache = selfOrigin || selfOriginCache;
  await Promise.allSettled(DISCOVERY_SOURCES.map((s) => discoverOneSource(s, selfOriginCache)));
}

function parsePrice(p) {
  if (typeof p === "number") return p;
  const n = parseFloat(String(p ?? "").replace(/[^0-9.]/g, ""));
  return isFinite(n) ? n : 0;
}

// Convert a single Bazaar resource entry into the tool shape used by the rest
// of the index. Bazaar gives us the resource URL, the accepts array (with
// per-network price/asset), an optional serviceName, description, and tags.
// We deliberately keep the price in atomic USDC units → USD here so the router
// can compare across sellers without a per-network price lookup.
function bazaarItemToTool(item, originUrl) {
  // `resource` = CDP Bazaar; `resourceUrl` = GoPlausible's AVM registry.
  const resource = item.resource || item.resourceUrl || item.url;
  if (typeof resource !== "string" || !resource.startsWith(originUrl)) return null;
  const accepts = Array.isArray(item.accepts) ? item.accepts : [];
  // Prefer the first Base USDC accept; fall back to any USDC; fall back to first.
  const preferred =
    accepts.find((a) => a?.network === "eip155:8453" && /USDC|USD Coin/i.test(a?.extra?.name || "")) ||
    accepts.find((a) => /USDC|USD Coin/i.test(a?.extra?.name || "")) ||
    accepts[0] ||
    null;
  let price = null;
  if (preferred?.amount != null) {
    // amount is an atomic-units string; USDC has 6 decimals.
    const n = Number(preferred.amount);
    if (Number.isFinite(n)) price = n / 1e6;
  }
  let pathStr = "/";
  try {
    pathStr = new URL(resource).pathname || "/";
  } catch {
    /* keep "/" */
  }
  const tags = Array.isArray(item.tags) ? item.tags : [];
  // Bazaar entries don't always carry a method (GoPlausible's do); assume POST
  // if we can't tell. The router treats this as a hint and respects a 405 retry.
  return {
    seller: originUrl,
    method: typeof item.method === "string" && item.method ? item.method.toUpperCase() : "POST",
    route: pathStr,
    slug: pathStr.replace(/^\//, "").replace(/\//g, "-") || originUrl.replace(/^https?:\/\//, ""),
    name: item.serviceName || pathStr,
    description: item.description || "",
    category: tags[0] || "other",
    tags,
    price,
    // Every chain this resource's 402 advertises — the signal behind the
    // router's ?network= filter ("who else settles on Robinhood Chain?").
    networks: [...new Set(accepts.map((a) => a?.network).filter(Boolean))],
    // Stellar payTo from the accepts — feeds /stellar's per-seller activity
    // scan. Kept raw here; the snapshot validates the strkey shape before use.
    stellarPayTo: accepts.find((a) => typeof a?.network === "string" && a.network.startsWith("stellar") && !a.network.includes("test"))?.payTo || null,
    // Algorand payTo — same idea, feeds /algorand's per-seller activity scan.
    // Mainnet-only: the CAIP-2 prefix distinguishes mainnet
    // (algorand:wGHE2Pwd…) from testnet (algorand:SGO1GKSz…) — an
    // includes("test") check would miss a testnet id that happens not to
    // contain the literal substring "test".
    algorandPayTo: accepts.find((a) => typeof a?.network === "string" && a.network.startsWith("algorand:wGHE2Pwd"))?.payTo || null,
    provenance: "bazaar",
  };
}

function normaliseOpenapiTools(openapi, originUrl) {
  if (!openapi || typeof openapi !== "object" || !openapi.paths) return [];
  const out = [];
  for (const [pathStr, methods] of Object.entries(openapi.paths)) {
    for (const [method, op] of Object.entries(methods || {})) {
      if (!op || typeof op !== "object") continue;
      // Heuristics: openapi entries that look like a paid tool route.
      // Skip pure discovery surfaces.
      if (/^\/(\.well-known|health|openapi|llms|sitemap|robots|favicon)/.test(pathStr)) continue;
      const tags = Array.isArray(op.tags) ? op.tags : [];
      out.push({
        seller: originUrl,
        method: method.toUpperCase(),
        route: pathStr,
        slug: op.operationId || pathStr.replace(/^\//, "").replace(/\//g, "-"),
        name: op.summary || op.operationId || pathStr,
        description: op.description || "",
        category: tags[0] || "other",
        tags,
        price: op["x-price"] || op["x-x402-price"] || null,
      });
    }
  }
  return out;
}

// Record a crawl outcome and roll the per-seller history window. `prev` is the
// existing cache entry (may be undefined on first crawl). Returns the new
// history array so the caller can derive a health score from it.
function rollHistory(prev, ok) {
  const h = Array.isArray(prev?.history) ? prev.history.slice(-(HEALTH_WINDOW - 1)) : [];
  h.push(ok ? 1 : 0);
  return h;
}

async function crawlSeller(originUrl) {
  const prev = cache.get(originUrl);
  try {
    const manifestRes = await safeFetch(`${originUrl}/.well-known/x402`, {
      maxBytes: MAX_MANIFEST_BYTES,
    });
    const manifest = JSON.parse(manifestRes.html);

    // OpenAPI is the tool-level detail. Best-effort: a seller without one still
    // shows up in the Index based on their manifest alone.
    let openapi = null;
    let tools = [];
    try {
      const openapiRes = await safeFetch(`${originUrl}/openapi.json`, {
        maxBytes: MAX_OPENAPI_BYTES,
      });
      openapi = JSON.parse(openapiRes.html);
      tools = normaliseOpenapiTools(openapi, originUrl);
    } catch {
      /* manifest-only seller — fine */
    }

    cache.set(originUrl, {
      manifest,
      openapiSummary: openapi ? { paths: Object.keys(openapi.paths || {}).length } : null,
      tools,
      fetchedAt: Date.now(),
      error: null,
      history: rollHistory(prev, true),
    });
  } catch (e) {
    // No /.well-known/x402 — but if the Bazaar carries resource entries for
    // this origin we can still route to them. Many sellers never publish a
    // manifest at all; the Bazaar IS their public surface. We treat a
    // Bazaar-only seller as routable (history flips positive) because we
    // observed real settled payments on those routes.
    const bazaarTools = bazaarToolsByOrigin.get(originUrl);
    if (Array.isArray(bazaarTools) && bazaarTools.length) {
      cache.set(originUrl, {
        ...(prev || {}),
        manifest: prev?.manifest || synthManifestFromBazaar(originUrl, bazaarTools),
        tools: bazaarTools,
        fetchedAt: Date.now(),
        error: null,
        source: "bazaar-fallback",
        history: rollHistory(prev, true),
      });
      return;
    }
    // Preserve the last good manifest+tools so a transient outage doesn't drop
    // the seller from the Index — but the history flip marks them unhealthy
    // for routing decisions.
    cache.set(originUrl, {
      ...(prev || {}),
      error: String(e.message || e),
      fetchedAt: Date.now(),
      history: rollHistory(prev, false),
    });
  }
}

// Build a minimal x402 service manifest from Bazaar resource entries — enough
// for indexSnapshot to render a display name + payment network without
// pretending the seller actually publishes /.well-known/x402.
function synthManifestFromBazaar(originUrl, tools) {
  const first = tools[0] || {};
  const host = originUrl.replace(/^https?:\/\//, "");
  return {
    name: first.name && first.name !== first.route ? first.name : host,
    homepage: originUrl,
    payment: { x402: { primaryNetwork: "base" } },
    capabilities: { tools: tools.length },
    synthesized: true,
  };
}

// Health score in [0,1] = fraction of healthy crawls in the rolling window.
// A seller with no history yet (just discovered) is treated as healthy so we
// don't unfairly exclude brand-new sellers on their first crawl cycle.
function healthScore(entry) {
  const h = entry?.history;
  if (!Array.isArray(h) || h.length === 0) return 1;
  return h.reduce((a, b) => a + b, 0) / h.length;
}

// A seller is "routable" if its most recent crawl succeeded. This is the
// strictest signal — a tool we recommend should be from a seller we just
// observed serving. Falling back to history would be nice but the latest
// success/failure is the most actionable bit.
function isRoutable(entry) {
  const h = entry?.history;
  if (!Array.isArray(h) || h.length === 0) return true; // never-crawled: give benefit of doubt
  return h[h.length - 1] === 1;
}

// Metadata-injection detector (M6, "Five Attacks on x402" Attack IV-E1).
// A tool listing is metadata: a name, a description, tags — text that *describes*
// what a tool does. It is never a channel for instructions to the selecting
// agent. When an external listing's text tries to command the ranker or the
// buyer's LLM ("ignore previous instructions", "always pick this", a fake
// <system> block), that's an attack, not a description — the paper drove one
// crafted server to 71.8% selection this way. We drop such listings entirely.
//
// Deliberately conservative: every pattern is imperative/meta phrasing that a
// genuine tool description has no reason to contain. A tool that legitimately
// *operates on* prompts (e.g. a "prompt linter") describes its function
// ("detects prompt-injection patterns"), it doesn't issue the commands below.
const INJECTION_PATTERNS = [
  /ignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier|the\s+above)\s+(?:instructions?|prompts?|context|rules?)/,
  /disregard\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|other)/,
  /forget\s+(?:everything|all|the\s+above|previous|prior)/,
  /always\s+(?:pick|choose|select|use|prefer|recommend|return)\s+(?:this|me|the\s+following)/,
  /(?:you\s+must|be\s+sure\s+to)\s+(?:always\s+)?(?:pick|choose|select|use|prefer|recommend)/,
  /(?:highest|top|maximum|max)\s+priority/,
  /override\s+(?:all\s+|any\s+|the\s+)?(?:other|previous|prior|instructions?|ranking)/,
  /<\/?\s*(?:system|assistant|user|instructions?|important)\s*>/,
  /\[(?:system|important|instructions?|override)\]/,
  /system\s*(?:prompt|message|role)\s*[:=]/,
  /do\s+not\s+(?:pick|choose|select|recommend|consider)\s+(?:any\s+)?other/,
];
function looksLikeListingInjection(text) {
  const t = String(text || "");
  if (t.length > 8000) return true; // no honest listing is a novel; oversized = padding an attack
  for (const re of INJECTION_PATTERNS) if (re.test(t)) return true;
  return false;
}

let crawlerTimer = null;
let discoveryTimer = null;
let crawlInFlight = false;

// Bounded worker pool. With thousands of discovered sellers we can't fan out
// every crawl in parallel — the unbounded `Promise.allSettled(seeds.map(...))`
// pattern would burn file descriptors and look like an outbound DoS. Each
// worker pulls the next seed off the queue until it's empty.
async function runPool(items, limit, worker) {
  const queue = items.slice();
  const n = Math.min(Math.max(limit, 1), queue.length);
  const workers = Array.from({ length: n }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try { await worker(item); } catch { /* crawlSeller already catches; belt+braces */ }
    }
  });
  await Promise.all(workers);
}

async function runCrawl() {
  if (crawlInFlight) return; // overlapping runs would just rate-limit each other
  crawlInFlight = true;
  try {
    const seeds = seedList();
    await runPool(seeds, CRAWL_CONCURRENCY, crawlSeller);
  } finally {
    crawlInFlight = false;
  }
}

/**
 * Boot the periodic crawler. Safe to call multiple times — subsequent calls are
 * no-ops. The first crawl runs immediately (non-blocking) so the page has data
 * as soon as the seeds finish responding.
 *
 * @param {Object} [opts]
 * @param {string} [opts.selfOrigin] our own public origin — used to skip self
 *   in registry discovery so we don't waste a crawl slot fetching our own
 *   manifest via the public endpoint.
 */
export function startCrawler(opts = {}) {
  if (crawlerTimer) return;
  loadSubmittedSeeds();
  const { selfOrigin = null } = opts;
  // Kick off discovery first so the first crawl has registry-sourced seeds in
  // hand (best-effort — if discovery is slow, the first crawl just uses env seeds).
  runDiscovery(selfOrigin).then(() => runCrawl());
  crawlerTimer = setInterval(runCrawl, CRAWL_INTERVAL_MS);
  discoveryTimer = setInterval(() => runDiscovery(selfOrigin), DISCOVERY_INTERVAL_MS);
  // Don't keep the event loop alive on shutdown.
  if (typeof crawlerTimer.unref === "function") crawlerTimer.unref();
  if (typeof discoveryTimer.unref === "function") discoveryTimer.unref();
}

/** Stop the crawler (used by tests to keep the process exitable). */
export function stopCrawler() {
  if (crawlerTimer) {
    clearInterval(crawlerTimer);
    crawlerTimer = null;
  }
  if (discoveryTimer) {
    clearInterval(discoveryTimer);
    discoveryTimer = null;
  }
}

function buildLocalEntry({ baseUrl, catalog, prices, network, toolCount, walletName }) {
  const tools = toolList(catalog).map((t) => ({
    seller: LOCAL_SELLER,
    method: t.route.split(" ")[0],
    route: t.route.split(" ")[1] || t.route,
    slug: t.slug,
    name: t.name,
    description: t.description || "",
    category: t.category,
    tags: t.tags || [],
    price: prices?.[t.slug] ?? parsePrice(t.price),
  }));
  return {
    origin: LOCAL_SELLER,
    displayName: walletName ? `Agent402.Tools (${walletName})` : "Agent402.Tools",
    homepage: baseUrl,
    network,
    toolCount,
    tools,
    fetchedAt: Date.now(),
    local: true,
  };
}

/**
 * Snapshot for the /index page. Always includes the local catalog (instant,
 * zero-network) plus whatever the crawler has accumulated.
 */
export function indexSnapshot({ baseUrl, catalog, prices, network, toolCount, walletName }) {
  const local = buildLocalEntry({ baseUrl, catalog, prices, network, toolCount, walletName });
  const remote = [...cache.entries()].map(([origin, v]) => ({
    origin,
    displayName: v.manifest?.name || origin.replace(/^https?:\/\//, ""),
    homepage: v.manifest?.homepage || origin,
    network: v.manifest?.payment?.x402?.primaryNetwork || v.manifest?.payment?.primaryNetwork || null,
    toolCount: v.tools?.length || v.manifest?.capabilities?.tools || 0,
    fetchedAt: v.fetchedAt,
    error: v.error || null,
    local: false,
    health: healthScore(v),
    routable: isRoutable(v),
    history: Array.isArray(v.history) ? v.history.slice() : [],
    source: v.source || (v.manifest && !v.manifest.synthesized ? "manifest" : null),
    // Union of the chains this seller's crawled 402s advertise. Manifest-
    // sourced crawls carry no accepts, so also union the Bazaar's view of the
    // same origin — a seller with its own manifest AND Stellar accepts on the
    // Bazaar must not read as network-less (it hid two of the four known
    // Stellar sellers from /stellar).
    networks: [...new Set([
      ...(v.tools || []).flatMap((t) => t.networks || []),
      ...(bazaarToolsByOrigin.get(origin) || []).flatMap((t) => t.networks || []),
    ])],
    // First valid Stellar payTo advertised across this seller's accepts —
    // strkey-validated (ed25519 public key: G + 55 base32 chars) so a hostile
    // accepts value can never reach a Horizon URL.
    stellarWallet: [...(v.tools || []), ...(bazaarToolsByOrigin.get(origin) || [])]
      .map((t) => t.stellarPayTo)
      .find((w) => typeof w === "string" && /^G[A-Z2-7]{55}$/.test(w)) || null,
    // First valid Algorand payTo advertised across this seller's accepts —
    // strkey-validated (58 base32 chars) so a hostile accepts value can never
    // reach an indexer URL. Feeds /algorand's per-seller activity scan.
    algorandWallet: [...(v.tools || []), ...(bazaarToolsByOrigin.get(origin) || [])]
      .map((t) => t.algorandPayTo)
      .find((w) => typeof w === "string" && /^[A-Z2-7]{58}$/.test(w)) || null,
  }));
  // Collapse http/https duplicates of the same host into one seller. A registry
  // can list the same origin under both schemes (algo.netintel.dev appeared as
  // both http:// and https://), which crawled as two cache entries and rendered
  // as two identical rows. Keep one per host: prefer https, then the routable /
  // higher-tool-count entry, and union networks + wallets so nothing is lost.
  const hostKey = (o) => { try { return new URL(o).host.toLowerCase(); } catch { return String(o); } };
  const isHttps = (o) => String(o).startsWith("https://");
  const byHost = new Map();
  for (const s of remote) {
    const k = hostKey(s.origin);
    const cur = byHost.get(k);
    if (!cur) { byHost.set(k, s); continue; }
    const sBetter =
      (isHttps(s.origin) && !isHttps(cur.origin)) ||
      (isHttps(s.origin) === isHttps(cur.origin) && s.routable && !cur.routable) ||
      (isHttps(s.origin) === isHttps(cur.origin) && !!s.routable === !!cur.routable && (s.toolCount || 0) > (cur.toolCount || 0));
    const keep = sBetter ? s : cur;
    const drop = sBetter ? cur : s;
    keep.networks = [...new Set([...(keep.networks || []), ...(drop.networks || [])])];
    keep.stellarWallet = keep.stellarWallet || drop.stellarWallet;
    keep.algorandWallet = keep.algorandWallet || drop.algorandWallet;
    keep.toolCount = Math.max(keep.toolCount || 0, drop.toolCount || 0);
    byHost.set(k, keep);
  }
  const sellers = [local, ...byHost.values()];
  const discoverySources = DISCOVERY_SOURCES.map((s) => {
    const st = discoveryStatus.get(s.name);
    return {
      name: s.name,
      url: s.url,
      fetchedAt: st?.fetchedAt || null,
      resources: st?.resources ?? null,
      origins: st?.origins ?? null,
      error: st?.error || null,
    };
  });
  return {
    spec: "x402-index/1",
    asOf: new Date().toISOString(),
    sellers,
    discoverySources,
    totals: {
      sellers: sellers.length,
      tools: sellers.reduce((s, x) => s + (x.toolCount || 0), 0),
      crawled: remote.length,
      discovered: discoveredSeeds.size,
      routable: 1 + remote.filter((s) => s.routable).length, // self always routable
      unhealthy: remote.filter((s) => !s.routable).length,
      bazaarFallback: remote.filter((s) => s.source === "bazaar-fallback").length,
    },
  };
}

// `include` controls which seller set the router considers. Defaults to "all"
// (local catalog + healthy crawled sellers). `external` excludes the local
// catalog — the explicit "find me another seller's tool" path that makes Agent402
// useful as a neutral discovery layer even when the caller isn't using us.
// `local` is the explicit local-only escape hatch.
const VALID_INCLUDE = new Set(["all", "external", "local"]);

/**
 * Smart Order Router — given a task description, rank matching tools across
 * every seller in the Index. Cheapest seller wins on score ties.
 *
 * Returns the same shape as /api/find but with a `seller` field per result and
 * cross-seller deduplication left to the buyer (different sellers may legitimately
 * offer the same tool at different prices).
 *
 * `include` (`all` | `external` | `local`) lets buyers explicitly route to
 * non-Agent402 sellers (`external`) — the same router, used as a neutral
 * discovery API over the whole x402 ecosystem.
 */
// Short chain names buyers may pass to ?network= — resolved to CAIP-2.
const ROUTE_NETWORKS = {
  base: "eip155:8453", polygon: "eip155:137", arbitrum: "eip155:42161",
  robinhood: "eip155:4663", solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
};

export function routeQuery({ query, top, include, networkFilter, baseUrl, catalog, prices, network, toolCount, walletName }) {
  const q = String(query || "").slice(0, 500);
  const terms = q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).slice(0, 32);
  const k = Math.min(Math.max(parseInt(top, 10) || 5, 1), 25);
  const inc = VALID_INCLUDE.has(include) ? include : "all";
  // ?network=robinhood (or a raw CAIP-2) keeps only tools whose crawled 402
  // advertises that chain. Positive-signal filter: local tools and sellers
  // whose crawl source carries no accepts (networks unknown) are kept — the
  // filter is "exclude sellers known NOT to settle there", not a guarantee.
  const wantNet = networkFilter ? (ROUTE_NETWORKS[String(networkFilter).trim().toLowerCase()] || String(networkFilter).trim()) : null;
  if (!terms.length) return { query: q, count: 0, results: [], sellers: 0, include: inc, ...(wantNet ? { network: wantNet } : {}) };

  // Always include the local catalog (we trust ourselves), plus every crawled
  // seller's tools — but only from sellers whose last crawl succeeded. A buyer
  // routed to a currently-broken seller would just lose the call, so we'd
  // rather rank fewer trustworthy options than more flaky ones.
  const local = buildLocalEntry({ baseUrl, catalog, prices, network, toolCount, walletName });
  const localPool = inc === "external"
    ? []
    : local.tools.map((t) => ({ ...t, sellerHome: baseUrl, sellerName: local.displayName, health: 1 }));
  const remotePool = inc === "local"
    ? []
    : [...cache.values()]
        .filter(isRoutable)
        .flatMap((v) =>
          (v.tools || []).map((t) => ({
            ...t,
            sellerHome: v.manifest?.homepage || t.seller,
            sellerName: v.manifest?.name || t.seller,
            health: healthScore(v),
          })),
        );
  const all = [...localPool, ...remotePool];

  const scored = [];
  for (const t of all) {
    const slug = (t.slug || "").toLowerCase();
    const name = (t.name || "").toLowerCase();
    const hay = `${t.name} ${t.description} ${t.category} ${(t.tags || []).join(" ")}`.toLowerCase();
    // Metadata sanitization (M6, defends "Five Attacks on x402" Attack IV-E1 —
    // metadata manipulation): a single crafted external listing whose text tries
    // to command the selecting agent ("ignore previous instructions", "always
    // pick this", fake <system> tags) hit 71.8% selection in the paper. We DROP
    // such external listings from the router entirely — a legitimate tool
    // describes what it does, it doesn't instruct the ranker. Our own local
    // catalog is trusted and never sanitized.
    if (t.seller !== LOCAL_SELLER && looksLikeListingInjection(hay)) continue;
    let score = 0;
    for (const term of terms) {
      if (slug === term) score += 10;
      else if (slug.includes(term)) score += 4;
      if (name.includes(term)) score += 2;
      if (hay.includes(term)) score += 1;
    }
    if (score > 0) scored.push([score, t]);
  }
  // Highest score first; healthier seller wins on ties; then cheapest; then
  // shorter slug. Health is the strongest tiebreak after match score because a
  // cheap-but-flaky seller is worse than a slightly pricier reliable one.
  scored.sort((a, b) => {
    if (b[0] !== a[0]) return b[0] - a[0];
    if (b[1].health !== a[1].health) return b[1].health - a[1].health;
    const pa = parsePrice(a[1].price);
    const pb = parsePrice(b[1].price);
    if (pa !== pb) return pa - pb;
    return (a[1].slug || "").length - (b[1].slug || "").length;
  });

  // Per-seller diversity cap (M6, "Five Attacks on x402" Attack IV — Sybil /
  // metadata capture). Ranking is already sorted best-first; naively taking the
  // top k lets one seller (or a crafted Sybil listing set) monopolize the whole
  // shortlist — the paper measured a single domain owning 77.5% of a real
  // registry's results. We take at most `perSellerCap` entries per external
  // seller in a first pass, then backfill any remaining slots from the leftovers
  // so the shortlist is never shorter than it would have been. Our own local
  // catalog (LOCAL_SELLER) is exempt: it's one trusted seller by construction,
  // and capping it would perversely push buyers toward less-vetted externals.
  // Honest limit: a Sybil attacker spread across many *distinct* domains/wallets
  // still gets one slot each — that's the paper's open problem, not solved here.
  const perSellerCap = Math.max(1, Math.ceil(k / 3));
  const perSellerCount = new Map();
  const picked = [];
  const leftover = [];
  for (const entry of scored) {
    if (picked.length >= k) break;
    const seller = entry[1].seller;
    if (seller === LOCAL_SELLER) { picked.push(entry); continue; }
    const n = perSellerCount.get(seller) || 0;
    if (n < perSellerCap) { perSellerCount.set(seller, n + 1); picked.push(entry); }
    else leftover.push(entry);
  }
  // Backfill: if the cap left us short of k, take the best leftovers (still in
  // score order) so we never return fewer results than a plain top-k would.
  for (const entry of leftover) {
    if (picked.length >= k) break;
    picked.push(entry);
  }

  const sellersSeen = new Set();
  const results = picked.map(([score, t]) => {
    sellersSeen.add(t.seller);
    return {
      seller: t.seller,
      sellerHome: t.sellerHome,
      sellerName: t.sellerName,
      slug: t.slug,
      name: t.name,
      method: t.method,
      route: t.route,
      url: t.seller === LOCAL_SELLER ? `${baseUrl}${t.route}` : `${t.seller}${t.route}`,
      price: t.price,
      priceUsd: parsePrice(t.price),
      category: t.category,
      description: t.description,
      score,
      health: t.health,
      ...(Array.isArray(t.networks) && t.networks.length ? { networks: t.networks } : {}),
    };
  });
  return { query: q, include: inc, count: results.length, sellers: sellersSeen.size, results, ...(wantNet ? { network: wantNet } : {}) };
}

// "The economy, over time" — folded in from the two old standalone economy
// pages (/x402-economy and /economy, both now 301s to /index#economy).
// Renders (a) the daily settlement history + week-over-week trend from
// x402EconomySnapshot(), and (b) the 24h ecosystem summary (concentration +
// network split) from the leaderboard snapshot via summarize() — the parts
// /leaderboard itself doesn't show. The per-seller top lists from both old
// pages were NOT ported since /leaderboard already ranks sellers.
// Pure function of its snapshots so it's unit-testable without a server.
const econFmt = (n) => Number(n || 0).toLocaleString("en-US");

// 24h ecosystem summary sub-block (from the old /economy page). Renders
// nothing when the leaderboard snapshot is warming — the section's on-chain
// history above still carries it, no fabricated zeros.
function economy24hHtml(leaderboardSnap) {
  if (leaderboardSnap?.warming || !leaderboardSnap?.leaderboard?.length) return "";
  const s = summarize(rankBy(leaderboardSnap.leaderboard, "usd"), "usd");
  const windowLabel = leaderboardSnap.windowLabel || "24h";
  const networkBars = s.networks
    .map(
      (n) => `<div class="econ-net-row"><span>${esc(n.net)}</span><span class="econ-net-val">${fmtUsd(n.usd)} &middot; ${fmtPct(n.share)}</span></div>
      <div class="econ-net-bar"><div style="width:${Math.max(2, Math.min(100, n.share))}%"></div></div>`
    )
    .join("");
  return `
    <h3 class="econ-h3">Last ${esc(windowLabel)} across the ecosystem</h3>
    <p class="pn" style="margin:0 0 14px;">Per-call USDC settled across every public x402 seller our crawler can see, from on-chain Base transfers ($0.50 per-call ceiling filters out funding moves). Refreshes hourly. Full ranking: <a href="/leaderboard">/leaderboard</a>; machine-readable: <a href="/api/leaderboard">/api/leaderboard</a>.</p>
    <div class="grid" style="margin:0 0 14px;">
      <div class="stat"><div class="k">Total volume</div><div class="v">${fmtUsd(s.total)}</div><div class="s">across ${econFmt(s.activeSellers)} active sellers</div></div>
      <div class="stat"><div class="k">Total calls</div><div class="v">${econFmt(s.totalCalls)}</div><div class="s">avg ${fmtUsd(s.avgCallUsd)} per call</div></div>
      <div class="stat"><div class="k">Top-5 share</div><div class="v">${fmtPct(s.top5Share)}</div><div class="s">top-1 ${fmtPct(s.top1Share)} &middot; top-10 ${fmtPct(s.top10Share)}</div></div>
      <div class="stat"><div class="k">Networks</div><div class="v">${s.networks.length}</div><div class="s">chains with volume</div></div>
    </div>
    <div class="econ-nets">${networkBars}</div>`;
}

export function economySectionHtml(snap, leaderboardSnap) {
  const day = economy24hHtml(leaderboardSnap);
  const unavailable = !snap || (snap.errors?.length && !(snap.daily || []).length);
  if (unavailable) {
    return `<div class="panel" id="economy">
  <div class="ph"><h2>The economy, over time</h2><div class="pn">Chain-wide gasless USDC settlement history on Base.</div></div>
  <div style="padding:14px 18px;"><div class="econ-warm">economy history unavailable right now (detail in <a href="/api/x402-economy">/api/x402-economy</a>)</div>${day}</div>
</div>`;
  }
  const t7 = snap.totals?.last7d || { settlements: 0, volumeUsd: 0, payers: 0 };
  const t30 = snap.totals?.last30d || { settlements: 0 };
  const daily = snap.daily || [];
  const maxSett = Math.max(1, ...daily.map((d) => d.settlements));
  const weekly = snap.weekly;
  const weeklyLine = weekly?.growthPct != null && weekly.lastWeek.days === 7
    ? `<p class="pn" style="margin:0 0 14px;">week over week: <strong style="color:${weekly.growthPct >= 0 ? "var(--accent)" : "var(--ink)"};">${weekly.growthPct >= 0 ? "+" : ""}${weekly.growthPct}%</strong> settlements (${econFmt(weekly.thisWeek.settlements)} vs ${econFmt(weekly.lastWeek.settlements)} the week before - complete days only)</p>`
    : `<p class="pn" style="margin:0 0 14px;">week-over-week trend unlocks once two full weeks of history accumulate (${weekly?.historyDays ?? 0} days recorded so far)</p>`;
  const bars = daily
    .map(
      (d) => `<div class="econ-bar-row">
        <span class="econ-bar-day">${esc(d.day)}</span>
        <span class="econ-bar-track" style="width:${Math.max(1, Math.round((d.settlements / maxSett) * 100))}%;"></span>
        <span>${econFmt(d.settlements)} settlements &middot; ${econFmt(d.payers)} payers</span>
      </div>`
    )
    .join("");
  return `<div class="panel" id="economy">
  <div class="ph">
    <h2>The economy, over time</h2>
    <div class="pn">Every gasless EIP-3009 USDC settlement on Base - the primitive x402 uses - counted chain-wide across every seller, not just Agent402's own catalog. Machine-readable at <a href="/api/x402-economy">/api/x402-economy</a>; same query any agent can buy as <a href="/tools/onchain-sql">onchain-sql</a> for $0.02.</div>
  </div>
  <div style="padding:14px 18px;">
    <div class="grid" style="margin:0 0 14px;">
      <div class="stat"><div class="k">Settlements 7d</div><div class="v">${econFmt(t7.settlements)}</div></div>
      <div class="stat"><div class="k">Volume 7d</div><div class="v">$${econFmt(t7.volumeUsd)}</div></div>
      <div class="stat"><div class="k">Unique payers 7d</div><div class="v">${econFmt(t7.payers)}</div></div>
      <div class="stat"><div class="k">Settlements 30d</div><div class="v">${econFmt(t30.settlements)}</div></div>
    </div>
    ${weeklyLine}
    <div class="econ-bars">${bars || `<div class="pn">no daily history recorded yet</div>`}</div>
    ${day}
  </div>
</div>`;
}

// Join key between an Index seller row and a leaderboard row: canonical host
// (see leaderboard.js#canonicalHost). Wallet isn't reliable here — the Index
// crawls manifests (no payTo per row), and a leaderboard row can represent
// several wallets folded under one operator's site. Host is the one field
// both sides actually publish. Pure + exported for tests.
export function leaderboardHostIndex(leaderboardSnap) {
  const map = new Map();
  const rows = Array.isArray(leaderboardSnap?.leaderboard) ? leaderboardSnap.leaderboard : [];
  for (const r of rows) {
    const hosts = new Set();
    const h = canonicalHost(r.homepage);
    if (h) hosts.add(h);
    for (const o of r.origins || []) {
      const oh = canonicalHost(o);
      if (oh) hosts.add(oh);
    }
    for (const host of hosts) {
      // A host should only ever map to one operator row (leaderboard rows are
      // already grouped by canonical host) — first write wins so a stray
      // collision doesn't silently reassign an established row.
      if (!map.has(host)) map.set(host, r);
    }
  }
  return map;
}

/**
 * Public HTML dashboard. Self-contained: no client-side polling required — a
 * page refresh re-renders from the latest snapshot. Embed snippet at the bottom
 * shows sellers how to drop a "tools live on x402" widget on their landing.
 */
export function indexPage(snapshot, { baseUrl, network, economySnap, leaderboardSnap, sort, dir, all } = {}) {
  const fmtAge = (ts) => {
    if (!ts) return "-";
    const age = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    return age < 60 ? `${age}s ago` : age < 3600 ? `${Math.floor(age / 60)}m ago` : `${Math.floor(age / 3600)}h ago`;
  };
  // ?network=<railkey> filter — validated against the known rail set (any
  // unrecognized value is silently ignored, never a 400: this is a plain-link
  // GET filter, not an API contract). The local catalog always passes: it's
  // one seller settling on every rail Agent402 accepts, so it has no
  // per-rail `networks` list to test against — filtering it out on any rail
  // would be a false negative, not an honest "doesn't settle here".
  const activeNet = network && NETWORK_MATCHERS.has(network) ? network : null;
  const matcher = activeNet ? NETWORK_MATCHERS.get(activeNet).matches : null;
  const allSellers = snapshot.sellers;
  const filteredSellers = matcher ? allSellers.filter((s) => s.local || (s.networks || []).some(matcher)) : allSellers;
  const healthBadge = (s) => {
    if (s.local) {
      const note = activeNet ? ' <span class="badge local" title="the local catalog settles on every rail">ALL RAILS</span>' : "";
      return ' <span class="badge local">SELF</span>' + note;
    }
    if (s.error) return ' <span class="badge err" title="' + esc(s.error) + '">STALE</span>';
    // Healthy seller: show rolling history as a tiny sparkline
    const dots = (s.history || []).map((x) => (x ? "●" : "○")).join("");
    return dots ? ` <span class="badge ok" title="last ${s.history.length} crawls">${dots}</span>` : "";
  };

  // Join to the leaderboard's on-chain USDC/calls signal by canonical host.
  // Unmatched sellers (never seen settling on Base, or not yet scanned) are
  // "-" — never a fabricated 0. The leaderboard's own window (see
  // leaderboard.js DEFAULTS.spanBlocks) is 24h today; ?window= is a hook the
  // pipeline doesn't implement yet, so the column header shows whatever the
  // snapshot actually scanned, never a hardcoded "7D" claim.
  const lbByHost = leaderboardHostIndex(leaderboardSnap);
  const lbWindowLabel = (leaderboardSnap?.windowLabel || "24h").toUpperCase();
  const withLb = filteredSellers.map((s) => {
    const host = canonicalHost(s.homepage || s.origin);
    return { ...s, _lb: (host && lbByHost.get(host)) || null };
  });

  // A leaderboard row's on-chain revenue is PER-OPERATOR: one payTo wallet,
  // often many crawled origins (preview deploys, alias hosts, api subdomains).
  // Every one of those origins maps to the same leaderboard row, so without
  // this the operator's total renders on EACH alias row — the "duplicate
  // values" bug (30 StableEnrich previews and BlockRun's two origins all
  // showing the same $). Attribute the revenue to ONE primary origin per
  // operator; the aliases show "-" (their revenue is the shared wallet's,
  // already counted on the primary). Primary = the origin whose host IS the
  // leaderboard row's own canonical homepage; else the most tools; else
  // deterministic by origin so the choice is stable across renders.
  const primaryFor = new Map(); // lb row -> chosen primary seller
  for (const s of withLb) {
    if (!s._lb) continue;
    const sHost = canonicalHost(s.homepage || s.origin);
    const isHomepage = !!(sHost && sHost === canonicalHost(s._lb.homepage));
    const cur = primaryFor.get(s._lb);
    const better = !cur
      || (isHomepage && !cur.isHomepage)
      || (isHomepage === cur.isHomepage && (s.toolCount || 0) > (cur.seller.toolCount || 0))
      || (isHomepage === cur.isHomepage && (s.toolCount || 0) === (cur.seller.toolCount || 0) && String(s.origin || "") < String(cur.seller.origin || ""));
    if (better) primaryFor.set(s._lb, { seller: s, isHomepage });
  }
  for (const s of withLb) {
    if (s._lb && primaryFor.get(s._lb)?.seller !== s) {
      s._lbAliasHost = canonicalHost(s._lb.homepage) || null; // for the "-" tooltip
      s._lb = null; // alias: revenue lives on the primary, not here
    }
  }

  // Sort: usd|calls|tools, desc|asc. Default usd desc (matches the
  // leaderboard's own canonical order). Sellers with no leaderboard match
  // sort to the bottom regardless of direction — they're unranked, not zero.
  const sortMode = ["usd", "calls", "tools"].includes(sort) ? sort : "usd";
  const sortDir = dir === "asc" ? "asc" : "desc";
  const sortValue = (s) => {
    if (sortMode === "tools") return Number.isFinite(s.toolCount) ? s.toolCount : null;
    if (!s._lb) return null;
    return sortMode === "calls" ? (s._lb.callsSettled ?? null) : (s._lb.totalUsd ?? null);
  };
  const cmpSellers = (a, b) => {
    const va = sortValue(a);
    const vb = sortValue(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1; // unranked always sinks to the bottom
    if (vb == null) return -1;
    return sortDir === "asc" ? va - vb : vb - va;
  };
  const sortedSellers = [...withLb].sort(cmpSellers);

  // Row cap: top INDEX_ROW_CAP by the active sort, ?all=1 renders every
  // filtered seller. The local seller is exempt from the cap — reinserted
  // (then the small slice re-sorted) if the cap would have dropped it.
  const showAll = all === "1" || all === "true";
  let visibleSellers = showAll ? sortedSellers : sortedSellers.slice(0, INDEX_ROW_CAP);
  if (!showAll && !visibleSellers.some((s) => s.local)) {
    const localSeller = sortedSellers.find((s) => s.local);
    if (localSeller) visibleSellers = [...visibleSellers, localSeller].sort(cmpSellers);
  }

  const rows = visibleSellers
    .map((s) => {
      // Aliases (same operator/wallet as a primary row) show a marked "-" so
      // the dash reads as "counted elsewhere", not "never settled". A truly
      // unmatched seller (never seen settling) keeps a plain "-".
      const dash = s._lbAliasHost
        ? `<span class="muted" title="revenue counted on ${esc(s._lbAliasHost)} (shared payTo wallet)">-</span>`
        : "-";
      const usdCell = s._lb ? esc(fmtUsd(s._lb.totalUsd)) : dash;
      const callsCell = s._lb ? esc(econFmt(s._lb.callsSettled)) : dash;
      return `<tr>
        <td><a href="${esc(s.homepage || s.origin)}" target="_blank" rel="noopener">${esc(s.displayName)}</a>${healthBadge(s)}</td>
        <td class="num">${esc(s.toolCount)}</td>
        <td>${esc(s.network || "-")}</td>
        <td class="num">${usdCell}</td>
        <td class="num">${callsCell}</td>
        <td class="muted">${esc(fmtAge(s.fetchedAt))}</td>
      </tr>`;
    })
    .join("");

  // Sortable column-header links — plain GET links (no JS), preserving
  // ?network and ?all so a sort click never resets an active filter.
  const sortHref = (key) => {
    const params = new URLSearchParams();
    if (activeNet) params.set("network", activeNet);
    if (showAll) params.set("all", "1");
    params.set("sort", key);
    params.set("dir", sortMode === key && sortDir === "desc" ? "asc" : "desc");
    return `/index?${params.toString()}`;
  };
  const sortHeader = (label, key) => {
    const active = sortMode === key;
    const style = active
      ? "color:var(--ink);font-weight:700;text-decoration:none;border-bottom:2px solid var(--accent);padding-bottom:2px;"
      : "color:inherit;text-decoration:none;";
    const arrow = active ? (sortDir === "desc" ? " ↓" : " ↑") : "";
    return `<a href="${esc(sortHref(key))}" style="${style}">${esc(label)}${arrow}</a>`;
  };
  const capNote = !showAll && sortedSellers.length > INDEX_ROW_CAP
    ? `<div class="chips-note">Showing top ${esc(INDEX_ROW_CAP)} of ${esc(sortedSellers.length)} sellers - <a href="${esc(
        (() => {
          const params = new URLSearchParams();
          if (activeNet) params.set("network", activeNet);
          params.set("all", "1");
          return `/index?${params.toString()}`;
        })()
      )}">show all</a></div>`
    : "";
  // Filter chips — "all" plus one per mainnet rail, derived from RAILS so a
  // new chain lights one up here with zero edits. Plain links (no JS),
  // preserving no other params; styled like market-page.js's chain switcher
  // (ink 700 + accent underline when active).
  const chips = [{ key: "", label: "all" }, ...[...NETWORK_MATCHERS.entries()].map(([key, v]) => ({ key, label: v.label }))]
    .map((c) => {
      const active = c.key === (activeNet || "");
      const href = c.key ? `/index?network=${encodeURIComponent(c.key)}` : "/index";
      const style = active
        ? "color:var(--ink);font-weight:700;text-decoration:none;border-bottom:2px solid var(--accent);padding-bottom:2px;"
        : "color:var(--muted);text-decoration:none;";
      return `<a href="${esc(href)}" style="${style}">${esc(c.label.toLowerCase())}</a>`;
    })
    .join("");
  const discoveryRows = (snapshot.discoverySources || [])
    .map((d) => {
      const status = d.error
        ? `<span class="badge err" title="${esc(d.error)}">ERROR</span>`
        : d.fetchedAt
        ? `<span class="muted">${esc(d.resources)} resources → ${esc(d.origins)} origins</span>`
        : `<span class="muted">pending…</span>`;
      return `<tr>
        <td><a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.name)}</a></td>
        <td>${status}</td>
        <td class="muted">${esc(fmtAge(d.fetchedAt))}</td>
      </tr>`;
    })
    .join("");

  const title = "x402 Index - Agent402";
  const description = "Live map of the agent payments economy: every x402 seller, their tool count, network, and last-crawled time.";
  const canonical = `${baseUrl}/index`;

  // By-chain cell row — one cell per rail from rails.js, joined with
  // page-availability (CHAIN_PAGES) and live seller counts derived straight
  // from this page's own snapshot (marketSellers filters snapshot.sellers by
  // network prefix, same as stellarSellers/algorandSellers). Missing counts
  // (crawl failure or no page yet) render the dimmed rail-only state, never
  // an invented number.
  const chainCells = RAILS.map((r) => {
    const pageKey = CHAIN_PAGE_BY_CAIP2.get(r.caip2);
    const hasPage = !!pageKey;
    let sellerCount;
    if (hasPage) {
      try { sellerCount = marketSellers(pageKey, snapshot).length; } catch { /* cell renders without the count */ }
    }
    const known = Number.isFinite(sellerCount);
    const live = hasPage && known;
    return {
      name: r.name.replace(/ Chain$/, "").toUpperCase(),
      asset: `${r.asset} · ${truncateCaip2(r.caip2)}`,
      assetFull: `${r.asset} · ${r.caip2}`,
      href: hasPage ? `/${pageKey}` : "/index",
      hasPage,
      live,
      status: hasPage ? (known ? `${sellerCount} seller${sellerCount === 1 ? "" : "s"} indexed` : "unavailable") : "rail live",
    };
  });
  const chainCellHtml = (c) => `<a href="${esc(c.href)}">
      <span class="cn${c.hasPage ? " haspage" : ""}">${esc(c.name)}</span>
      <span class="ca" title="${esc(c.assetFull)}">${esc(c.asset)}</span>
      <span class="cs${c.live ? " live" : ""}"><span class="dot${c.live ? " live" : ""}"></span>${esc(c.status)}</span>
    </a>`;

  const extraCss = `
  .ix-wrap { max-width:1180px; margin:0 auto; padding:56px 30px; }
  .ix-wrap h1 { font-family:var(--font-body);font-weight:800;font-size:58px;line-height:.96;letter-spacing:-.03em;margin:0 0 8px; }
  .sub { color:var(--muted); margin:0 0 22px; font-size:.95rem; max-width:680px; line-height:1.6; }
  .grid { display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); margin:0 0 22px; }
  .stat { background:var(--card); border:1.5px solid var(--ink); padding:16px; }
  .stat .k { color:var(--faint); font-family:var(--font-mono); font-size:.72rem; text-transform:uppercase; letter-spacing:.06em; }
  .stat .v { font-family:var(--font-mono); font-size:1.65rem; color:var(--ink); margin-top:4px; }
  .stat .s { color:var(--faint); font-size:.78rem; margin-top:3px; }
  .panel { background:var(--card); border:1.5px solid var(--ink); overflow:hidden; margin-bottom:18px; }
  .ph { padding:14px 18px; border-bottom:1.5px solid var(--ink); }
  .ph h2 { margin:0; font-family:var(--font-body);font-weight:800;font-size:20px;letter-spacing:-.01em;color:var(--accent); }
  .ph .pn { color:var(--muted); font-size:.82rem; margin-top:2px; }
  table { width:100%; border-collapse:collapse; font-size:.9rem; }
  th { text-align:left; color:var(--faint); font-weight:500; font-family:var(--font-mono); font-size:.72rem; text-transform:uppercase; letter-spacing:.04em; padding:10px 18px; border-bottom:1.5px solid var(--ink); }
  th.num { text-align:right; }
  td { padding:10px 18px; border-bottom:1px solid var(--hairline); }
  td.num { font-family:var(--font-mono); text-align:right; }
  td.muted { color:var(--faint); }
  td a { color:var(--ink); text-decoration:none; border-bottom:1px solid transparent; }
  td a:hover { border-color:var(--accent); color:var(--accent); }
  .badge { display:inline-block; font-family:var(--font-mono); font-size:.62rem; font-weight:600; padding:1px 6px; margin-left:6px; letter-spacing:.04em; }
  .badge.local { background:rgba(214,60,26,.08); color:var(--accent); border:1px solid rgba(214,60,26,.3); }
  .badge.err { background:rgba(249,115,22,.1); color:#f97316; border:1px solid rgba(249,115,22,.3); }
  .badge.ok { background:rgba(214,60,26,.06); color:var(--accent); border:1px solid rgba(214,60,26,.2); letter-spacing:.1em; }
  code { background:var(--ink); color:var(--cream); padding:1px 5px; font-family:var(--font-mono); font-size:.85em; }
  pre { background:var(--ink); color:var(--cream); border:1.5px solid var(--dark-border); padding:14px 16px; overflow:auto; font-family:var(--font-mono); font-size:.84rem; }
  .foot { color:var(--faint); font-size:.82rem; margin-top:24px; }
  .foot a { color:var(--accent); text-decoration:none; }
  .chains-label { display:flex; align-items:baseline; justify-content:space-between; gap:14px; flex-wrap:wrap; margin:0 0 12px; font-family:var(--font-mono); font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--accent); }
  .chains { display:grid; grid-template-columns:repeat(${chainCells.length},minmax(0,1fr)); gap:0; border:1.5px solid var(--ink); background:var(--card); margin:0 0 8px; }
  .chains a { display:block; min-width:0; overflow:hidden; padding:14px 16px; border-right:1px solid var(--hairline); text-decoration:none; }
  .chains a:last-child { border-right:none; }
  .chains .cn { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:var(--font-mono); font-weight:700; font-size:13px; margin-bottom:3px; color:var(--faint); }
  .chains .cn.haspage { color:var(--ink); }
  .chains .ca { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:var(--font-mono); font-size:10.5px; color:var(--faint); margin-bottom:9px; }
  .chains .cs { display:flex; align-items:center; gap:6px; overflow:hidden; font-family:var(--font-mono); font-size:11px; color:var(--faint); }
  .chains .cs.live { color:var(--green); }
  .chains .cs .dot { width:6px; height:6px; border-radius:50%; background:var(--faint); display:inline-block; flex:none; }
  .chains .cs.live .dot { background:var(--green); }
  .chains-foot { color:var(--faint); font-family:var(--font-mono); font-size:11px; margin:0 0 22px; }
  .chips { display:flex; align-items:center; gap:16px; flex-wrap:wrap; font-family:var(--font-mono); font-size:12px; margin-top:8px; }
  .chips-note { color:var(--faint); font-family:var(--font-mono); font-size:11.5px; margin-top:6px; }
  .econ-bars { font-family:var(--font-mono); font-size:12px; }
  .econ-bar-row { display:grid; grid-template-columns:90px 1fr 200px; gap:12px; align-items:center; padding:3px 0; }
  .econ-bar-day { color:var(--faint); }
  .econ-bar-track { display:block; height:10px; background:var(--accent); opacity:.85; }
  .econ-warm { border:1.5px dashed var(--ink); padding:16px 18px; font-family:var(--font-mono); font-size:13px; color:var(--muted); }
  .econ-h3 { font-family:var(--font-body); font-weight:800; font-size:17px; letter-spacing:-.01em; margin:22px 0 6px; }
  .econ-nets { font-size:.9rem; }
  .econ-net-row { display:flex; justify-content:space-between; gap:12px; padding:7px 0 0; }
  .econ-net-val { color:var(--accent); font-family:var(--font-mono); }
  .econ-net-bar { background:var(--ink); height:8px; overflow:hidden; margin-top:4px; }
  .econ-net-bar > div { background:var(--accent); height:100%; }
  `;

  const pageBody = `<div class="ix-wrap">

<h1>x402 Index</h1>
<p class="sub">Live map of the agent payments economy. Every seller below publishes an x402 service manifest at <code>/.well-known/x402</code>; this page crawls them every 5 minutes and shows what's online. Selling on Stellar or Algorand? See <a href="/stellar">the Stellar x402 marketplace</a> or the <a href="/algorand">Algorand x402 marketplace</a> - the same index, filtered per rail.</p>

<div class="chains-label"><span>The index, by chain</span><span>adding a chain adds a cell, not a nav link</span></div>
<div class="chains ml-mkts">
  ${chainCells.map(chainCellHtml).join("\n  ")}
</div>
<div class="chains-foot">seller counts derive from this snapshot at render, a failed crawl reads "unavailable", never zero</div>

<div class="grid">
  <div class="stat"><div class="k">Sellers</div><div class="v">${esc(snapshot.totals.sellers)}</div><div class="s">listed in the Index</div></div>
  <div class="stat"><div class="k">Tools online</div><div class="v">${esc(snapshot.totals.tools)}</div><div class="s">across all sellers</div></div>
  <div class="stat"><div class="k">Crawled sellers</div><div class="v">${esc(snapshot.totals.crawled)}</div><div class="s">via /.well-known/x402</div></div>
  <div class="stat"><div class="k">Auto-discovered</div><div class="v">${esc(snapshot.totals.discovered ?? 0)}</div><div class="s">from public registries</div></div>
  <div class="stat"><div class="k">Routable now</div><div class="v">${esc(snapshot.totals.routable ?? 0)}</div><div class="s">${esc(snapshot.totals.unhealthy ?? 0)} unhealthy excluded from router</div></div>
  <div class="stat"><div class="k">Snapshot</div><div class="v" style="font-size:1rem">${esc(snapshot.asOf.replace("T", " ").slice(0, 19))}Z</div><div class="s">refresh the page to update</div></div>
</div>

<div class="panel">
  <div class="ph">
    <h2>Sellers</h2>
    <div class="pn">Local catalog plus every seeded origin we could fetch. USDC settled and calls are joined from the <a href="/leaderboard">x402 Leaderboard</a>'s on-chain scan (last ${esc(lbWindowLabel)}) by seller host - a seller not yet matched shows "-", never $0.${leaderboardSnap?.partial ? ` <strong style="color:var(--accent);">Partial scan — ${esc(leaderboardSnap.windowNote || "some block ranges were unavailable")}; totals are a floor, not the full window.</strong>` : ""}</div>
    <div class="chips">${chips}</div>
    ${activeNet ? `<div class="chips-note">${esc(filteredSellers.length)} of ${esc(allSellers.length)} sellers</div>` : ""}
    ${capNote}
  </div>
  <table>
    <thead><tr><th>Seller</th><th class="num">${sortHeader("Tools", "tools")}</th><th>Network</th><th class="num">${sortHeader(lbWindowLabel + " USDC", "usd")}</th><th class="num">${sortHeader(lbWindowLabel + " calls", "calls")}</th><th>Last fetch</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="6" class="muted" style="text-align:center;padding:24px">No sellers yet - seed via X402_INDEX_SEEDS.</td></tr>`}</tbody>
  </table>
</div>

<div class="panel">
  <div class="ph"><h2>Discovery sources</h2><div class="pn">Public x402 registries we poll hourly to find new sellers automatically.</div></div>
  <table>
    <thead><tr><th>Registry</th><th>Result</th><th>Last fetch</th></tr></thead>
    <tbody>${discoveryRows || `<tr><td colspan="3" class="muted" style="text-align:center;padding:24px">No discovery sources configured.</td></tr>`}</tbody>
  </table>
</div>

<div class="panel">
  <div class="ph"><h2>Smart Order Router - neutral x402 discovery</h2><div class="pn">Resolve a task to the cheapest healthy tool across every seller in one call. Use <code>include:"external"</code> to exclude Agent402 itself - we list because we trust the ranking, not because we'd rig it for ourselves.</div></div>
  <div style="padding:14px 18px;">
    <pre>curl -s -X POST ${esc(baseUrl)}/api/route \\
  -H 'Content-Type: application/json' \\
  -d '{"query":"ocr image","top":3,"include":"external"}'</pre>
    <p class="foot" style="margin:10px 0 0;">Free - same gate as <code>/api/find</code>. <code>include</code> = <code>all</code> (default) · <code>external</code> (exclude self) · <code>local</code> (Agent402 only). Deterministic lexical scoring, health-then-price tiebreak.</p>
  </div>
</div>

${economySectionHtml(economySnap, leaderboardSnap)}

<p class="foot">x402 Index is open source, part of <a href="https://github.com/MikeyPetrillo/Agent402">Agent402</a>. Most sellers are listed automatically once their x402 endpoint is live and settling. To list now, paste your origin on <a href="/sell">/sell</a> (free, no account) or <code>POST /api/index/register</code>. You can also open a PR to the seed list or self-host your own Index.</p>

</div>
${ledgerFooterCompact()}`;

  return ledgerShell({
    title,
    description,
    canonical,
    baseUrl,
    activePath: "__none__",
    extraCss,
    body: pageBody,
  });
}

/** Internal helper for tests. */
export function _cacheForTests() {
  return cache;
}
