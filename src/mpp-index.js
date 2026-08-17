// MPP Index — a live, independently-verified seller directory for the MPP
// payment protocol (the IETF-track "Payment" HTTP auth scheme -
// `Authorization: Payment` / `WWW-Authenticate: Payment`), parallel to the
// existing x402 crawler (src/x402-index.js) but for a different seller
// population - sellers that speak MPP, not necessarily x402.
//
// Discovery source: https://mpp.dev/api/services, the same registry mppx's own
// CLI (`services list`) reads (see node_modules/mppx/src/cli/cli.ts). It ships
// rich, structured per-service data (description, categories, tags, docs,
// priced endpoints) - unlike x402-index.js, which has to derive most of that
// itself from raw manifest/OpenAPI crawling, this only needs to independently
// VERIFY what the registry already claims.
//
// Verification is the honesty gate: a registry row is never shown as a seller
// until we've made a real, unpaid request to one of its actual endpoints and
// confirmed the response genuinely carries a `WWW-Authenticate: Payment`
// challenge (src/x402-index.js's own isMppChallenge(), reused here rather than
// duplicated). A registry's claimed count is not truth until independently
// probed - the same "crawled, not curated" discipline the x402 side already
// follows (see the registry-instance-inflation and scan-evidence-honesty
// lessons in project history).
//
// Same architecture as x402-index.js throughout, deliberately scoped down:
// one discovery source (not four), no Bazaar-style pagination, no per-path
// backoff matrix (one representative endpoint per seller, not four candidate
// manifest paths) - grow this only if a second real MPP registry surfaces.
import { readFileSync, writeFileSync } from "node:fs";
import { safeFetch, assertPublicUrl, ssrfDispatcher } from "./tools/fetch-guard.js";
import { validateOriginInput, isMppChallenge } from "./x402-index.js";

export { validateOriginInput };

const MPP_DISCOVERY_URL = process.env.MPP_DISCOVERY_URL || "https://mpp.dev/api/services";
const MPP_CRAWL_INTERVAL_MS = 5 * 60 * 1000; // 5 min - same politeness as the x402 crawler
const MPP_DISCOVERY_INTERVAL_MS = 60 * 60 * 1000; // 1 hr - registries don't change fast
const MPP_CRAWL_CONCURRENCY = 10; // ~150 known services total; no need for x402's 25
const MAX_REGISTRY_BYTES = 8 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 8000;

// Map<origin, sellerEntry> — verified + registry-sourced state, keyed by the
// service's actual API host (registry `serviceUrl`, or the submitted origin
// for self-serve entries with no registry backing).
const cache = new Map();
// Origins discovered from the mpp.dev registry.
const discoveredSeeds = new Set();

// --- self-serve listing (POST /api/mpp-index/register) ---------------------
export const MPP_SUBMITTED_SEEDS_FILE = process.env.MPP_SUBMITTED_SEEDS_FILE || "/data/mpp-submitted-seeds.json";
const submittedSeeds = new Set();
const DEFAULT_MAX_SUBMITTED_SEEDS = 500; // same ceiling/reasoning as the x402 side
let submittedSeedsCap = DEFAULT_MAX_SUBMITTED_SEEDS;

/** Test hook: set (or, with no arg, reset) the submission cap. */
export function __testSetSubmittedCap(n) {
  submittedSeedsCap = typeof n === "number" && n >= 0 ? n : DEFAULT_MAX_SUBMITTED_SEEDS;
}

export function loadSubmittedSeeds() {
  try {
    const arr = JSON.parse(readFileSync(MPP_SUBMITTED_SEEDS_FILE, "utf8"));
    for (const o of Array.isArray(arr) ? arr : []) {
      if (submittedSeeds.size >= submittedSeedsCap) break;
      if (typeof o === "string") { submittedSeeds.add(o); discoveredSeeds.add(o); }
    }
  } catch { /* absent file / no volume - in-memory only */ }
}

function persistSubmittedSeeds() {
  try {
    writeFileSync(MPP_SUBMITTED_SEEDS_FILE, JSON.stringify([...submittedSeeds], null, 2));
  } catch { /* best-effort - no volume in local/dev */ }
}

/** Test hook: clear submitted-seed state between test cases. */
export function __testResetSubmitted() { submittedSeeds.clear(); }

// ---------------------------------------------------------------------------
// Registry discovery
// ---------------------------------------------------------------------------

/** Fetch the mpp.dev services registry and index it by origin (serviceUrl).
 *  Never throws - a discovery failure just means no NEW seeds this cycle;
 *  already-discovered origins keep crawling on their existing schedule.
 *
 *  KNOWN GAP (measured 2026-08-17): 42 of 141 live registry entries are
 *  hosted as per-tenant PATHS on one shared gateway domain
 *  (mpp.orthogonal.com/<tenant>, e.g. /apollo, /tavily, /serper - real,
 *  distinct businesses, just multi-tenant-hosted rather than each on its own
 *  subdomain). validateOriginInput() requires a bare origin (no path) - the
 *  same rule the x402 side uses, where "one origin = one seller" is a safe
 *  assumption for self-serve registration. It is NOT a safe assumption for
 *  THIS registry's gateway-hosted tenants, so they are silently excluded from
 *  discovery today (99 of 141 make it through). This is a deliberate,
 *  documented scope limit for the first pass, not a silent drop: fixing it
 *  needs an origin+base-path seller key for discovery-sourced entries only
 *  (self-serve registration should keep requiring a bare origin from the
 *  submitter) - left for a follow-up if gateway-hosted MPP sellers turn out
 *  to be a meaningful share of the ecosystem going forward. */
export async function discoverMppRegistry() {
  try {
    const { html } = await safeFetch(MPP_DISCOVERY_URL, { maxBytes: MAX_REGISTRY_BYTES, headers: { Accept: "application/json" } });
    const parsed = JSON.parse(html);
    const services = Array.isArray(parsed?.services) ? parsed.services : [];
    let added = 0, skippedPathScoped = 0;
    for (const svc of services) {
      const raw = String(svc?.serviceUrl || svc?.url || "").trim();
      const v = validateOriginInput(raw);
      if (v.error) { skippedPathScoped++; continue; }
      registryByOrigin.set(v.origin, svc);
      if (!discoveredSeeds.has(v.origin)) added++;
      discoveredSeeds.add(v.origin);
    }
    discoveryStatus = { url: MPP_DISCOVERY_URL, fetchedAt: Date.now(), services: services.length, added, skippedPathScoped, error: null };
    return discoveryStatus;
  } catch (e) {
    discoveryStatus = { url: MPP_DISCOVERY_URL, fetchedAt: Date.now(), services: 0, added: 0, skippedPathScoped: 0, error: String(e?.message || e).slice(0, 200) };
    return discoveryStatus;
  }
}

// Raw registry rows, keyed by origin - the source of the rich display fields
// (description, categories, tags, docs, endpoints) a verification probe alone
// can't produce. Map<origin, registryServiceObject>.
const registryByOrigin = new Map();
let discoveryStatus = { url: MPP_DISCOVERY_URL, fetchedAt: null, services: 0, added: 0, error: null };
export function mppDiscoveryStatus() { return discoveryStatus; }

// ---------------------------------------------------------------------------
// Backoff (per origin - one representative endpoint per seller, unlike the
// x402 side's per-origin+path matrix, since MPP verification only ever probes
// one URL per seller).
// ---------------------------------------------------------------------------
const CRAWL_BACKOFF_STEPS_MS = [0, 0, 0, 0, 30 * 60 * 1000, 2 * 60 * 60 * 1000, 6 * 60 * 60 * 1000];
const crawlBackoff = new Map(); // origin -> { fails, nextAt }

export function probeDue(origin, now = Date.now()) {
  const b = crawlBackoff.get(origin);
  return !b || now >= b.nextAt;
}
function noteProbeOutcome(origin, ok, now = Date.now()) {
  if (ok) { crawlBackoff.delete(origin); return; }
  const fails = (crawlBackoff.get(origin)?.fails || 0) + 1;
  const step = CRAWL_BACKOFF_STEPS_MS[Math.min(fails, CRAWL_BACKOFF_STEPS_MS.length - 1)];
  crawlBackoff.set(origin, { fails, nextAt: now + step });
}

// ---------------------------------------------------------------------------
// Live verification - the honesty gate
// ---------------------------------------------------------------------------

/** Pick a real, priced endpoint to probe from a registry row - prefer GET (no
 *  body to guess). Falls back to the bare origin root for self-serve entries
 *  with no registry backing (best-effort; a seller with no advertised paths
 *  is probed at "/").
 *
 *  KNOWN LIMITATION (measured live 2026-08-17): unlike x402, which defines a
 *  standard discovery path (/.well-known/x402) every seller can be probed at
 *  regardless of their own API layout, MPP has no equivalent well-known
 *  convention (confirmed: no such path anywhere in the mppx package source).
 *  So a self-serve submission for a genuinely NEW seller not yet in the
 *  mpp.dev registry can only be verified at the bare origin root, which fails
 *  for any seller whose paywall is scoped to specific API paths rather than
 *  the root itself (live-verified: api.apex-db.org, a REAL, working MPP
 *  seller, correctly fails root-only verification and only succeeds once its
 *  real endpoint - /v1/apex - is known from the registry). Self-serve
 *  registration today works well for registry-known sellers (the common
 *  case) but is honestly limited for brand-new ones; the natural follow-up is
 *  accepting an optional path in the registration request so a submitter can
 *  point at their own real endpoint, mirroring what the registry already
 *  provides for discovered sellers. Not built here - out of Stage 1's scope,
 *  and not a silent gap: it fails HONESTLY (unverified, real reason given),
 *  never a false positive. */
function pickProbeTarget(origin, svc) {
  const endpoints = Array.isArray(svc?.endpoints) ? svc.endpoints : [];
  const priced = endpoints.filter((e) => e && typeof e.path === "string" && e.path.startsWith("/"));
  const pick = priced.find((e) => String(e.method || "GET").toUpperCase() === "GET") || priced[0];
  if (!pick) return { method: "GET", url: origin };
  return { method: String(pick.method || "GET").toUpperCase(), url: `${origin}${pick.path}` };
}

/** Make one unpaid request to `target` and confirm a genuine MPP challenge.
 *  Mirrors x402-index.js's probePaywall() exactly: raw fetch + assertPublicUrl
 *  + ssrfDispatcher, NOT safeFetch() - safeFetch() throws on the 401/402 this
 *  probe is specifically trying to observe, and doesn't expose headers. */
async function probeMppChallenge({ method, url }) {
  try {
    await assertPublicUrl(url);
    const res = await fetch(url, {
      method,
      headers: { Accept: "application/json", ...(method !== "GET" ? { "Content-Type": "application/json" } : {}) },
      ...(method !== "GET" ? { body: "{}" } : {}),
      dispatcher: ssrfDispatcher,
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const challenge = res.headers.get("www-authenticate");
    const mpp = isMppChallenge(challenge);
    // A genuine MPP challenge rides a 401 or 402 - either is a live, healthy
    // "payment required" answer; anything else (200, 404, 5xx) is not.
    const statusOk = res.status === 401 || res.status === 402;
    return { ok: mpp && statusOk, status: res.status, url, at: Date.now(), error: mpp ? null : "no WWW-Authenticate: Payment challenge on the probed endpoint" };
  } catch (e) {
    return { ok: false, status: 0, url, at: Date.now(), error: String(e?.message || e).slice(0, 160) };
  }
}

const HEALTH_WINDOW = 5;

/** Verify one origin (registry-sourced or self-submitted). Updates `cache`
 *  in place. Never throws - a failed probe just leaves `verified: false` with
 *  the reason recorded, same posture as x402-index.js's crawlSeller(). */
export async function verifyMppSeller(origin) {
  const svc = registryByOrigin.get(origin) || null;
  const target = pickProbeTarget(origin, svc);
  const result = await probeMppChallenge(target);
  noteProbeOutcome(origin, result.ok);
  const prior = cache.get(origin);
  const history = [...(prior?.history || []), result.ok ? 1 : 0].slice(-HEALTH_WINDOW);
  const entry = {
    origin,
    name: svc?.name || origin.replace(/^https?:\/\//, ""),
    url: svc?.url || origin,
    serviceUrl: origin,
    description: svc?.description || null,
    categories: Array.isArray(svc?.categories) ? svc.categories : [],
    tags: Array.isArray(svc?.tags) ? svc.tags : [],
    docs: svc?.docs || null,
    icon: svc?.icon || null,
    realm: svc?.realm || null,
    provider: svc?.provider || null,
    endpoints: Array.isArray(svc?.endpoints) ? svc.endpoints : [],
    probedUrl: target.url,
    verified: result.ok,
    verifiedAt: result.ok ? result.at : (prior?.verified ? prior.verifiedAt : null),
    lastProbeAt: result.at,
    lastProbeOk: result.ok,
    lastProbeError: result.error,
    history,
    fromRegistry: !!svc,
    fromSubmission: submittedSeeds.has(origin),
  };
  cache.set(origin, entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Self-serve registration
// ---------------------------------------------------------------------------

/** Probe + list a submitted origin. `verify` is injectable for tests; defaults
 *  to the real verifyMppSeller. Successful probes persist the origin as a seed. */
export async function registerMppOrigin(origin, { verify } = {}) {
  const existing = cache.get(origin);
  if (existing?.verified) return { listed: true, origin, seller: mppSellerSummary(existing) };
  if (!submittedSeeds.has(origin) && submittedSeeds.size >= submittedSeedsCap) {
    return { listed: false, origin, error: "submission list is full - open a GitHub issue to get seeded" };
  }
  const doVerify = verify || verifyMppSeller;
  let entry;
  try { entry = await doVerify(origin); } catch (e) { entry = { verified: false, lastProbeError: String(e?.message || e) }; }
  // Own the cache write here rather than relying on doVerify's own side effect
  // (the real verifyMppSeller() already writes it; an injected test verifier
  // does not, and the snapshot/crawl-rotation contract must hold either way -
  // "registerMppOrigin succeeded" must always mean "the snapshot can see it").
  cache.set(origin, { ...entry, origin });
  if (entry?.verified) {
    submittedSeeds.add(origin);
    discoveredSeeds.add(origin);
    persistSubmittedSeeds();
    return { listed: true, origin, seller: mppSellerSummary(cache.get(origin)) };
  }
  return { listed: false, origin, error: entry?.lastProbeError || "no MPP challenge (WWW-Authenticate: Payment) found on the probed endpoint" };
}

function mppSellerSummary(v) {
  return {
    name: v.name,
    description: v.description,
    categories: v.categories,
    verified: v.verified,
    verifiedAt: v.verifiedAt ? new Date(v.verifiedAt).toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// Crawl loop
// ---------------------------------------------------------------------------
let crawlInFlight = false;
let crawlerTimer = null;
let discoveryTimer = null;

async function runPool(items, limit, worker) {
  const queue = items.slice();
  const n = Math.min(Math.max(limit, 1), queue.length);
  const workers = Array.from({ length: n }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try { await worker(item); } catch { /* verifyMppSeller already catches; belt+braces */ }
    }
  });
  await Promise.all(workers);
}

export async function runMppCrawl() {
  if (crawlInFlight) return;
  crawlInFlight = true;
  try {
    const seeds = [...discoveredSeeds];
    const due = seeds.filter((o) => probeDue(o));
    await runPool(due, MPP_CRAWL_CONCURRENCY, verifyMppSeller);
  } finally {
    crawlInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// Persistence - plain JSON, no DB, same pattern as x402-index.js's warm-start
// ---------------------------------------------------------------------------
export const MPP_INDEX_CACHE_FILE = process.env.MPP_INDEX_CACHE_FILE || "/data/mpp-index-cache.json";

export function persistMppIndexCache(file = MPP_INDEX_CACHE_FILE) {
  try {
    if (cache.size === 0) return false;
    const out = [...cache.entries()].filter(([, v]) => v.verified);
    if (!out.length) return false;
    writeFileSync(file, JSON.stringify({ savedAt: Date.now(), entries: out }));
    return true;
  } catch { return false; }
}

export function loadPersistedMppIndexCache(file = MPP_INDEX_CACHE_FILE) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    let n = 0;
    for (const [origin, v] of entries) {
      if (typeof origin !== "string" || !origin || cache.has(origin)) continue;
      // Warm-started rows are shown as last-known-verified, never re-labelled
      // fresh - the next crawl cycle re-probes and either confirms or corrects
      // this within one interval, same posture as the x402 side's warmStarted flag.
      cache.set(origin, { ...v, warmStarted: true });
      discoveredSeeds.add(origin);
      n++;
    }
    return n;
  } catch { return 0; }
}

export function startMppCrawler() {
  if (crawlerTimer) return;
  loadSubmittedSeeds();
  const warmed = loadPersistedMppIndexCache();
  if (warmed) console.log(`[mpp-index] warm-started ${warmed} sellers from ${MPP_INDEX_CACHE_FILE}`);
  discoverMppRegistry().then(() => runMppCrawl()).then(() => persistMppIndexCache());
  crawlerTimer = setInterval(() => { runMppCrawl().then(() => persistMppIndexCache()).catch(() => {}); }, MPP_CRAWL_INTERVAL_MS);
  discoveryTimer = setInterval(() => discoverMppRegistry(), MPP_DISCOVERY_INTERVAL_MS);
  if (typeof crawlerTimer.unref === "function") crawlerTimer.unref();
  if (typeof discoveryTimer.unref === "function") discoveryTimer.unref();
}

/** Stop the crawler (used by tests to keep the process exitable). */
export function stopMppCrawler() {
  if (crawlerTimer) { clearInterval(crawlerTimer); crawlerTimer = null; }
  if (discoveryTimer) { clearInterval(discoveryTimer); discoveryTimer = null; }
}

/** Test-only: fully reset in-memory state between test cases. */
export function __testReset() {
  cache.clear();
  discoveredSeeds.clear();
  registryByOrigin.clear();
  submittedSeeds.clear();
  crawlBackoff.clear();
  discoveryStatus = { url: MPP_DISCOVERY_URL, fetchedAt: null, services: 0, added: 0, error: null };
  stopMppCrawler();
}

// ---------------------------------------------------------------------------
// Snapshot - what the market page and nav panel consume
// ---------------------------------------------------------------------------

/** Synchronous, always-honest snapshot: only VERIFIED sellers count toward the
 *  headline number - never the raw registry size (mpp.dev claims 141 today;
 *  what we show is only what we've independently confirmed still answers with
 *  a real MPP challenge). Discovered-but-unverified origins are surfaced
 *  separately so the gap is visible, never silently dropped or silently
 *  counted. */
export function mppIndexSnapshot() {
  const all = [...cache.values()];
  const verified = all.filter((v) => v.verified);
  return {
    verifiedSellers: verified.length,
    discoveredTotal: discoveredSeeds.size,
    sellers: verified,
    discovery: discoveryStatus,
    generatedAt: Date.now(),
  };
}
