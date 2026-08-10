#!/usr/bin/env node
// Strict FREE_MODE sweep of paid catalog tools that do NOT burn Mike's metered
// third-party keys. Unlike scripts/test-all.js NETWORK leniency (which treats
// 502/503/504 as green), this suite FAILS on those statuses — that hole is how
// gov-data stayed green while its upstream was permanently dead (issue #730).
//
//   TARGET_URL=http://localhost:3000 node scripts/test-non-metered-examples.js
//   node scripts/test-non-metered-examples.js   # boots its own FREE_MODE server
//
// WHY: test-all.js puts free-public tools (gov-data, weather, EDGAR, …) in
// NETWORK and only fails status>=500 excluding 502/503/504. Handlers map a
// dead upstream to 502, so a permanently broken tool is a green [test] run.
// The weekly Algorand rail canary caught gov-data; customers should never be
// first. This is the FREE_MODE CI guard for that class.
//
// SCOPE FILTER (documented, deliberate):
//   IN  — price > 0 AND documented OpenAPI example does not spend Brave /
//         OpenAI / OpenRouter / E2B / Blockscout-buyer / FRED / Neynar /
//         Alchemy-hard / CDP keys. Free-public APIs (data.gov DEMO_KEY,
//         weather.gov, CoinGecko keyless, Nominatim, Open-Meteo, …) stay IN
//         even when they live in WALLET_ONLY_SLUGS.
//   OUT — METERED_SLUGS below; skill packs whose toolSlugs reach any of those;
//         workflows OpenAPI category (composition, not paywalled tools);
//         zero/free price endpoints.
// Identity-bound memory / my-usage are OUT via METERED_SLUGS (payment=identity,
// need a wallet even in FREE_MODE for real semantics).
//
// STRICTNESS: HTTP 200 and no body.error. 502/503/504 FAIL after one retry on
// timeout/502/503/504/429. Upstream *rate limits* (429, or 502/503 whose body
// says rate-limit) soft-skip LOUDLY after that retry — same doctrine as
// test-gov-data.js's DEMO_KEY 429 path — so a throttle is not a deploy block,
// while a permanently dead upstream (gov-data's retired v3 → bare 502) still
// fails. render/screenshot skip LOUDLY only when Playwright Chromium is
// missing locally (CI installs chromium — those must pass there).
//
// Also soft-skip LOUDLY (after retry) two free-public flakes that are NOT the
// dead-tool class and would otherwise thrash [test]:
//   • media-info / audio-convert / audio-normalize — example URLs are third-
//     party Wikimedia; handlers are covered by scripts/test-media.js on a
//     local ffmpeg tone. A 422 "media could not be processed" / content-type
//     paste-error after retry is "source host flaked", not "tool is gone".
//   • price-feed kit 502 "malformed JSON" — DeFiLlama/CoinGecko occasionally
//     return garbage bodies; a bare outage 502 without that wording still fails.
//
// CONTROL: grading asserts 502 would fail (the NETWORK hole), gov-data must be
// in-scope, and a planted Brave slug must be out-of-scope — vacuous green is
// refused (floor on in-scope count).
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SKILL_PACKS } from "../src/skills.js";
import { WALLET_ONLY_SLUGS } from "../src/pow.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.NON_METERED_PORT) || 3143;
const EXTERNAL = Boolean(process.env.TARGET_URL);
const TARGET = process.env.TARGET_URL || `http://127.0.0.1:${PORT}`;
// Keep concurrency modest — many in-scope tools share free-public upstreams
// (CoinGecko keyless, data.gov DEMO_KEY) and a thundering herd just rate-limits.
const CONCURRENCY = Number(process.env.NON_METERED_CONCURRENCY) || 3;
const TIMEOUT_MS = Number(process.env.NON_METERED_TIMEOUT_MS) || 25_000;
const SKILL_TIMEOUT_MS = Number(process.env.NON_METERED_SKILL_TIMEOUT_MS) || 55_000;
// Floor so a broken filter that empties the work list cannot pass silently.
const MIN_IN_SCOPE = Number(process.env.NON_METERED_MIN_IN_SCOPE) || 350;

let passed = 0, failed = 0;
const failures = [];
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`ok - ${msg}`); }
  else { failed++; failures.push(msg); console.error(`FAIL - ${msg}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Metered upstream exclusion oracle ──────────────────────────────────────
// Tools whose example answers burn Mike's third-party budget / buyer wallet /
// identity surface. Keep in sync with the class of spend — adding a new keyed
// upstream means listing its slugs here (and skill packs resolve transitively).
const METERED_SLUGS = new Set([
  // Brave Search subscription
  "search", "search-news", "search-images", "search-videos", "search-suggest", "answer", "multi-search",
  "research-company", // calls search-news handler in-process
  // OpenAI
  "llm", "llm-pro", "llm-premium",
  "image-gen", "image-gen-hd", "image-gen-premium",
  "tts", "tts-hd", "transcribe", "transcribe-pro",
  "embed", "embed-large", "moderate",
  // OpenRouter gateway
  "v1-chat-nano", "v1-chat-auto", "v1-chat", "v1-chat-pro", "v1-chat-premium",
  "v1-embeddings", "v1-images", "v1-audio-speech",
  // E2B
  "code-run", "code-run-pro",
  // Blockscout x402 buyer wallet
  "contract-inspect", "address-profile", "token-info", "token-holders", "tx-inspect",
  // Route-and-execute can buy external sellers
  "route-execute", "route-execute-max", "route-execute-plus",
  // Identity-bound (payment = identity)
  "memory-write", "memory-read", "memory-incr", "memory-cas", "memory-grant", "memory-revoke",
  "memory-grants", "memory-log", "memory-remember", "memory-recall", "memory-forget",
  "my-usage",
  // FRED keyed (503 without FRED_API_KEY / FRED_API_KEY_V2)
  "fred-series", "fred-search", "fred-series-info", "fred-release-calendar",
  "sahm-rule", "cpi-yoy", "unemployment-rate", "fed-funds",
  "fred-release-observations",
  // Neynar / Farcaster
  "farcaster-profile", "farcaster-by-address",
  // Alchemy hard-require (compute units) — publicJsonRpc-backed tools stay IN
  "wallet-balance", "token-metadata", "token-price", "wallet-transactions",
  "nft-holdings", "nft-metadata", "gas-snapshot", "eth-call",
  "dex-pair", "dex-pool", "dex-quote",
  "nft-collection", "nft-floor", "nft-sales",
  "l2-gas-comparison",
  // CDP (Coinbase Developer Platform keys)
  "wallet-balances", "testnet-fund", "onramp-link", "onchain-sql", "onchain-sql-schema",
]);

const BROWSER_SLUGS = new Set(["render", "screenshot"]);
// Handlers proven offline by scripts/test-media.js; live examples depend on
// Wikimedia (same URL for all three). Soft-skip source-host flakes only.
const MEDIA_EXAMPLE_SLUGS = new Set(["media-info", "audio-convert", "audio-normalize"]);

const METERED_PACK_SLUGS = new Set();
for (const p of SKILL_PACKS) {
  const hits = (p.toolSlugs || []).filter((s) => METERED_SLUGS.has(s));
  if (hits.length) METERED_PACK_SLUGS.add(p.slug);
}

function excludeReason(slug, path) {
  if (METERED_SLUGS.has(slug)) return "metered_upstream_key_or_buyer";
  const packName = slug.startsWith("skill-") ? slug.slice(6) : null;
  if (packName && METERED_PACK_SLUGS.has(packName)) return "skill_pack_reaches_metered";
  if (path.startsWith("/api/skill/")) {
    const name = path.slice("/api/skill/".length);
    if (METERED_PACK_SLUGS.has(name)) return "skill_pack_reaches_metered";
  }
  return null;
}

function parsePrice(p) {
  if (typeof p === "number") return p;
  return Number(String(p ?? "").replace(/[^0-9.]/g, "")) || 0;
}

/** Strict success: 200 and no body.error. 502/503/504 are HARD fails (unlike test-all NETWORK). */
function isStrictPass(status, body) {
  return status === 200 && !(body && body.error);
}

/** True when a response should fail the suite after retries are exhausted. */
function isStrictFailure(status, body, threw) {
  if (threw) return true;
  if (isStrictPass(status, body)) return false;
  return true;
}

function isBrowserUnavailable(status, body, threw) {
  const msg = String(threw || (body && (body.error || body.message)) || "");
  return status === 503 && /browser unavailable|Executable doesn't exist|chromium|playwright/i.test(msg);
}

function errText(body, threw) {
  return String(threw || (body && (body.error || body.message)) || "");
}

function isRateLimited(status, body, threw) {
  if (status === 429) return true;
  // Match explicit rate-limit wording (incl. "Source URL returned HTTP 429"
  // from fetch-guard). Do NOT match bare "retry shortly" — that also rides
  // capacity 503s which must still fail the suite.
  return /\b429\b|rate.?limit|throttl/i.test(errText(body, threw));
}

/** Wikimedia (or similar) media-source flake — NOT a dead tool (test-media covers handlers). */
function isUpstreamMediaSourceFlake(slug, status, body, threw) {
  if (!MEDIA_EXAMPLE_SLUGS.has(slug)) return false;
  const msg = errText(body, threw);
  // Generic ffprobe/ffmpeg failure after a bad/truncated download, or the
  // content-type pre-screen when the host served a webpage/JSON error page.
  if (status === 422 && /media could not be processed|Content-Type .+ not audio\/video|webpage URL/i.test(msg)) {
    return true;
  }
  // Fetch-guard upstream HTTP errors on the example media URL.
  if ((status === 502 || status === 503 || status === 504) && /Source URL returned HTTP|fetch failed|ECONNRESET|ETIMEDOUT/i.test(msg)) {
    return true;
  }
  return false;
}

/** Free price-feed hosts occasionally return non-JSON bodies → 502. Narrow match only. */
function isTransientMalformedPriceFeed(status, body, threw) {
  return status === 502 && /Price feed upstream returned malformed JSON/i.test(errText(body, threw));
}

function shouldRetry(status, body, threw, slug) {
  // One retry on transient flakes. 503 is included because several free-public
  // handlers surface upstream rate limits as 503 (CoinGecko), not 429.
  // Permanent dead upstreams still fail on the second attempt (gov-data class).
  if (status === 502 || status === 503 || status === 504 || status === 429) return true;
  if (isUpstreamMediaSourceFlake(slug, status, body, threw)) return true;
  return /timeout|aborted|AbortError|UND_ERR_CONNECT|ECONNRESET|ETIMEDOUT|fetch failed|rate.?limit/i.test(errText(body, threw));
}

async function callExample(path, method, op, slug) {
  const isSkill = path.startsWith("/api/skill/");
  const timeout = isSkill ? SKILL_TIMEOUT_MS : TIMEOUT_MS;
  let url, init;
  if (method === "get") {
    const qs = new URLSearchParams();
    for (const p of op.parameters ?? []) {
      if (p.example !== undefined) qs.set(p.name, typeof p.example === "string" ? p.example : JSON.stringify(p.example));
    }
    url = `${TARGET}${path}${[...qs].length ? `?${qs}` : ""}`;
    init = {};
  } else {
    const example = op.requestBody?.content?.["application/json"]?.example ?? {};
    url = `${TARGET}${path}`;
    init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(example) };
  }

  const attempt = async () => {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
      const ct = res.headers.get("content-type") || "";
      let body = null;
      if (ct.includes("application/json")) {
        try { body = await res.json(); } catch { body = { error: "non-json body" }; }
      } else {
        const buf = await res.arrayBuffer();
        body = { __bytes: buf.byteLength };
      }
      return { status: res.status, body, threw: null };
    } catch (e) {
      return { status: 0, body: null, threw: e.message || String(e) };
    }
  };

  let r = await attempt();
  if (!isStrictPass(r.status, r.body) && shouldRetry(r.status, r.body, r.threw, slug)) {
    await sleep(1500);
    r = await attempt();
  }
  return r;
}

async function mapPool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, () => worker()));
  return out;
}

let srv = null;
let srvLog = "";
async function boot() {
  if (EXTERNAL) {
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${TARGET}/health`)).ok) return; } catch { /* */ }
      await sleep(500);
    }
    throw new Error(`external server at ${TARGET} never became healthy`);
  }
  // Strip metered keys so a mis-filter cannot burn budget even if a slug slips
  // through. Keep DATA_GOV unset → DEMO_KEY (honest free-public path).
  const strip = [
    "BRAVE_API_KEY", "BRAVE_ANSWERS_API_KEY", "BRAVE_SUGGEST_API_KEY",
    "OPENAI_API_KEY", "OPENROUTER_API_KEY", "E2B_API_KEY",
    "FRED_API_KEY", "FRED_API_KEY_V2", "NEYNAR_API_KEY", "WARPCAST_API_KEY",
    "ALCHEMY_API_KEY", "CDP_API_KEY_ID", "CDP_API_KEY_SECRET",
    "X402_UPSTREAM_BUYER_KEY", "ALGORAND_UPSTREAM_BUYER_MNEMONIC",
    "DATA_GOV_API_KEY",
  ];
  const env = {
    ...process.env,
    FREE_MODE: "true",
    PORT: String(PORT),
    X402_INDEX_CRAWL: "off",
    AGENT402_MCP_MAX_PER_MIN: "999999",
    AGENT402_MCP_MAX_PER_HOUR: "9999999",
  };
  for (const k of strip) delete env[k];

  srv = spawn("node", ["src/server.js"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  srv.stdout.on("data", (d) => { srvLog += d; if (srvLog.length > 200_000) srvLog = srvLog.slice(-100_000); });
  srv.stderr.on("data", (d) => { srvLog += d; if (srvLog.length > 200_000) srvLog = srvLog.slice(-100_000); });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${TARGET}/health`)).ok) return; } catch { /* */ }
    if (srv.exitCode != null) throw new Error(`server exited ${srv.exitCode}:\n${srvLog.slice(-800)}`);
    await sleep(500);
  }
  throw new Error(`server never came up:\n${srvLog.slice(-800)}`);
}

function stop() {
  if (srv && srv.exitCode == null) {
    try { srv.kill("SIGTERM"); } catch { /* */ }
  }
}

// ── Offline controls (run before any live call) ─────────────────────────────
// Pin the NETWORK hole: a handler 502 MUST fail this suite.
ok(isStrictFailure(502, { error: "data.gov is not returning results" }, null) === true,
  "control: HTTP 502 is a hard fail (the NETWORK-lenient hole that hid gov-data)");
ok(isRateLimited(502, { error: "data.gov is not returning results right now (upstream outage)" }, null) === false,
  "control: bare dead-upstream 502 is NOT a rate-limit soft-skip");
ok(isRateLimited(502, { error: "Source URL returned HTTP 429" }, null) === true,
  "control: fetch-guard 429 wording is recognized as rate-limit");
ok(isUpstreamMediaSourceFlake("media-info", 422, { error: "media could not be processed (is the input a valid audio/video file?)" }, null) === true,
  "control: Wikimedia media-source 422 is a soft-skip for media example slugs");
ok(isUpstreamMediaSourceFlake("gov-data", 422, { error: "media could not be processed (is the input a valid audio/video file?)" }, null) === false,
  "control: media-source soft-skip does NOT apply outside media example slugs");
ok(isTransientMalformedPriceFeed(502, { error: "Price feed upstream returned malformed JSON" }, null) === true,
  "control: price-feed malformed-JSON 502 is a soft-skip");
ok(isTransientMalformedPriceFeed(502, { error: "data.gov is not returning results" }, null) === false,
  "control: bare dead-upstream 502 is NOT a price-feed soft-skip (gov-data class)");
ok(isStrictFailure(503, { error: "capacity" }, null) === true,
  "control: HTTP 503 is a hard fail");
ok(isStrictFailure(504, { error: "timeout" }, null) === true,
  "control: HTTP 504 is a hard fail");
ok(isStrictPass(200, { query: "ok" }) === true, "control: HTTP 200 without body.error is a pass");
ok(isStrictPass(200, { error: "nope" }) === false, "control: HTTP 200 with body.error is a fail");
ok(excludeReason("gov-data", "/api/gov-data") === null,
  "control: gov-data is NOT metered (DEMO_KEY / DATA_GOV — must stay in-scope)");
ok(excludeReason("search", "/api/search") === "metered_upstream_key_or_buyer",
  "control: Brave search is excluded from this suite");
ok(excludeReason("llm", "/api/llm") === "metered_upstream_key_or_buyer",
  "control: OpenAI llm is excluded");
ok(excludeReason("code-run", "/api/code-run") === "metered_upstream_key_or_buyer",
  "control: E2B code-run is excluded");
ok(WALLET_ONLY_SLUGS.has("gov-data"),
  "control: gov-data is WALLET_ONLY (wallet-gated live) yet still in THIS suite's scope");

async function main() {
  console.log(`[non-metered] target=${TARGET} external=${EXTERNAL} concurrency=${CONCURRENCY}`);
  console.log(`[non-metered] metered slugs=${METERED_SLUGS.size} metered packs=${METERED_PACK_SLUGS.size}`);

  await boot();
  ok(true, `server healthy at ${TARGET}`);

  const pricing = await (await fetch(`${TARGET}/api/pricing`)).json();
  const spec = await (await fetch(`${TARGET}/openapi.json`)).json();
  const endpoints = pricing.endpoints || [];
  const byPath = new Map();
  for (const e of endpoints) byPath.set(e.path, e);

  const work = [];
  const excluded = [];

  for (const [path, methods] of Object.entries(spec.paths || {})) {
    for (const [method, op] of Object.entries(methods)) {
      const cat = (op.tags && op.tags[0]) || "other";
      if (cat === "workflows") continue;
      const ep = byPath.get(path);
      const slug = ep?.slug || path.replace(/^\/api\//, "").replace(/^\/v1\//, "v1-").replace(/\//g, "-");
      const priceUsd = parsePrice(ep?.price ?? op["x-price"] ?? 0);
      if (!(priceUsd > 0)) continue;
      const reason = excludeReason(slug, path);
      if (reason) {
        excluded.push({ slug, path, method, reason });
        continue;
      }
      work.push({ slug, path, method, op, priceUsd });
    }
  }

  ok(work.length >= MIN_IN_SCOPE,
    `in-scope count is substantial (${work.length} ≥ ${MIN_IN_SCOPE}) — filter is not vacuous`);
  ok(work.some((t) => t.slug === "gov-data"),
    "gov-data is in the strict sweep (the #730 class must be covered)");
  ok(!work.some((t) => t.slug === "search" || t.slug === "llm" || t.slug === "code-run"),
    "metered Brave/OpenAI/E2B slugs are absent from the work list");
  ok(excluded.some((e) => e.slug === "search"),
    "Brave search was excluded by the filter (not merely absent from catalog)");

  console.log(`[non-metered] sweeping ${work.length} tools (excluded metered=${excluded.length})…`);

  let done = 0;
  let skippedBrowser = 0;
  let skippedRateLimit = 0;
  let skippedMediaSource = 0;
  let skippedPriceFeed = 0;
  const liveFails = [];

  await mapPool(work, CONCURRENCY, async (t) => {
    const r = await callExample(t.path, t.method, t.op, t.slug);
    done++;
    if (done % 40 === 0 || done === work.length) {
      process.stdout.write(`\r[non-metered] ${done}/${work.length}`);
    }

    if (BROWSER_SLUGS.has(t.slug) && isBrowserUnavailable(r.status, r.body, r.threw)) {
      skippedBrowser++;
      console.log(`\nskip - ${t.slug}: Playwright Chromium unavailable locally (${errText(r.body, r.threw).slice(0, 120)})`);
      return;
    }

    if (isStrictPass(r.status, r.body)) return;

    // Rate-limit after retry = soft skip (test-gov-data DEMO_KEY doctrine). A
    // bare 502 with no rate-limit wording still fails — that is the dead-tool class.
    if (isRateLimited(r.status, r.body, r.threw)) {
      skippedRateLimit++;
      console.log(`\nskip - ${t.slug}: upstream rate-limited after retry (${r.status} ${errText(r.body, r.threw).slice(0, 100)})`);
      return;
    }

    if (isUpstreamMediaSourceFlake(t.slug, r.status, r.body, r.threw)) {
      skippedMediaSource++;
      console.log(`\nskip - ${t.slug}: upstream media source flaked after retry (${r.status} ${errText(r.body, r.threw).slice(0, 100)})`);
      return;
    }

    if (isTransientMalformedPriceFeed(r.status, r.body, r.threw)) {
      skippedPriceFeed++;
      console.log(`\nskip - ${t.slug}: price-feed upstream returned malformed JSON after retry (${r.status})`);
      return;
    }

    const err = r.threw || (r.body && r.body.error) || `HTTP ${r.status}`;
    const msg = `${t.method.toUpperCase()} ${t.path} (${t.slug}) → ${r.status || "threw"} ${String(typeof err === "object" ? JSON.stringify(err) : err).slice(0, 160)}`;
    liveFails.push(msg);
  });
  process.stdout.write("\n");

  if (skippedBrowser) {
    console.log(`skip - ${skippedBrowser} browser tool(s) skipped (Chromium missing); CI installs Playwright and must not skip`);
  }
  if (skippedRateLimit) {
    console.log(`skip - ${skippedRateLimit} tool(s) soft-skipped after upstream rate-limit (retry exhausted)`);
  }
  if (skippedMediaSource) {
    console.log(`skip - ${skippedMediaSource} media tool(s) soft-skipped after upstream media-source flake (handlers covered by test-media.js)`);
  }
  if (skippedPriceFeed) {
    console.log(`skip - ${skippedPriceFeed} price-feed tool(s) soft-skipped after malformed-JSON upstream flake`);
  }

  const softSkipped = skippedBrowser + skippedRateLimit + skippedMediaSource + skippedPriceFeed;
  const asserted = work.length - softSkipped;
  ok(liveFails.length === 0,
    liveFails.length
      ? `every in-scope example returns 200 without body.error — ${liveFails.length} FAILED:\n     ${liveFails.slice(0, 30).join("\n     ")}${liveFails.length > 30 ? `\n     …and ${liveFails.length - 30} more` : ""}`
      : `every in-scope example returns 200 without body.error (${asserted} asserted, ${skippedBrowser} browser-skipped, ${skippedRateLimit} rate-limit-skipped, ${skippedMediaSource} media-source-skipped, ${skippedPriceFeed} price-feed-skipped)`);
  // Refuse a vacuous green where almost everything soft-skipped.
  ok(asserted >= Math.floor(MIN_IN_SCOPE * 0.8),
    `enough tools were actually asserted (${asserted}), not soft-skipped away`);

  console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed — in-scope=${work.length} excluded=${excluded.length}`);
  stop();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  stop();
  process.exit(1);
});
