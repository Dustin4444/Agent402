// Coverage lock for The 500's new tools (v2.0.0 overhaul) — offline, no server.
//
// scripts/test-all.js sweeps every catalog entry it finds in /openapi.json, so a
// tool is only ever silently untested if (a) it lost its discovery example (the
// sweep would call it with an empty body) or (b) its route sits in a skip set
// (BRAVE_ROUTES) that excludes it from the run entirely. This test pins both
// for the 30 tools built in the overhaul (plus evm-rpc from the same era):
//
//   1. each slug still exists in its kit export with a discovery example, so
//      the answers-own-example assertion is real;
//   2. no new-tool route is in test-all.js's BRAVE_ROUTES skip set, except the
//      single documented exception below;
//   3. the paid-canary legs stay honest: every leg is well-shaped, the
//      finance legs exist, and their display priceUsd matches the kit's
//      advertised price (guards the stale-price drift found in the audit).
//
// Run: node scripts/test-canary-coverage.js  (pure imports + source parsing)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CONTRACT_TOOLS } from "../src/tools/contract-kit.js";
import { CRYPTO_TOOLS } from "../src/tools/crypto-kit.js";
import { FINANCE_TOOLS } from "../src/tools/finance-kit.js";
import { ENRICH_TOOLS } from "../src/tools/enrich-kit.js";
import { SEARCH_TOOLS } from "../src/tools/search.js";
import { WEB_TOOLS } from "../src/tools/web-kit.js";
import { IMAGE_TOOLS } from "../src/tools/image-kit.js";
import { KIT2 } from "../src/tools/kit2.js";
import { DATA_TOOLS } from "../src/tools/data-kit.js";
import { CHAIN_TOOLS } from "../src/tools/chain-kit.js";
import { TOOLS as CANARY_LEGS } from "./paid-canary.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// The 30 tools of The 500 phase 2 (t1 contract ×7, t2 market feeds ×6,
// t3 enrich ×5, t4 web/content ×4, t5 media/format ×5, t6 locale/time ×3),
// plus evm-rpc (demand batch, same launch window). slug → hosting kit export.
const NEW_TOOLS = [
  ...["contract-source", "contract-abi", "solidity-scan", "calldata-decode", "selector-lookup", "tx-simulate", "address-label"].map((s) => [s, CONTRACT_TOOLS, "contract-kit"]),
  ...["crypto-orderbook", "stablecoin-peg"].map((s) => [s, CRYPTO_TOOLS, "crypto-kit"]),
  ...["options-chain", "premarket-quote", "stock-dividends", "dividend-calendar"].map((s) => [s, FINANCE_TOOLS, "finance-kit"]),
  ...["lei-lookup", "wikidata-entity", "gravatar-check", "github-repo", "favicon-grab"].map((s) => [s, ENRICH_TOOLS, "enrich-kit"]),
  ...["search-videos"].map((s) => [s, SEARCH_TOOLS, "search-kit"]),
  ...["archive-snapshot", "feed-parse", "unshorten-url"].map((s) => [s, WEB_TOOLS, "web-kit"]),
  ...["image-exif", "image-dominant-color", "image-crop"].map((s) => [s, IMAGE_TOOLS, "image-kit"]),
  ...["srt-convert", "json-schema-infer", "ics-parse"].map((s) => [s, KIT2, "kit2"]),
  ...["public-holidays", "country-info"].map((s) => [s, DATA_TOOLS, "data-kit"]),
  ...["evm-rpc"].map((s) => [s, CHAIN_TOOLS, "chain-kit"]),
];

// The ONE documented sweep exception: search-videos sits in BRAVE_ROUTES
// (skipped unless BRAVE_LIVE_TEST=1 — a Brave-subscription budget decision).
// Its input validation runs on every CI pass via scripts/test-search-kit.js;
// the live answers-own-example path is opt-in there too. Any OTHER new tool
// landing in a skip set fails this test.
const DOCUMENTED_SKIPS = new Set(["/api/search-videos"]);

// --- parse test-all.js's skip/lenient sets from source (strip // comments
// first: NETWORK's inline comments contain quoted words that are not routes).
const testAllSrc = readFileSync(join(ROOT, "scripts", "test-all.js"), "utf8").replace(/\/\/[^\n]*/g, "");
function extractSet(name) {
  const m = testAllSrc.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`));
  if (!m) return null;
  return new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
}
const BRAVE_ROUTES = extractSet("BRAVE_ROUTES");
const NETWORK = extractSet("NETWORK");
ok(BRAVE_ROUTES && BRAVE_ROUTES.size > 0, "parsed BRAVE_ROUTES skip set out of test-all.js");
ok(NETWORK && NETWORK.size > 50, "parsed NETWORK lenient set out of test-all.js");

// --- 1 + 2: every new tool is defined, example-backed, and actually swept ---
for (const [slug, kitTools, kitName] of NEW_TOOLS) {
  const t = kitTools.find((x) => x.slug === slug);
  ok(!!t, `${slug} is defined in ${kitName}`);
  if (!t) continue;
  ok(!!(t.discovery && (t.discovery.input || t.discovery.example)), `${slug} has a discovery example (answers-own-example is real)`);
  const path = (t.route || "").split(" ").pop();
  ok(path.startsWith("/"), `${slug} route parses to a path (${t.route})`);
  const skipped = BRAVE_ROUTES?.has(path);
  if (DOCUMENTED_SKIPS.has(path)) {
    ok(skipped, `${slug} documented exception still matches reality (in BRAVE_ROUTES; validation covered by test-search-kit.js)`);
    console.warn(`      NOTE: ${slug} is NOT swept by test-all.js in default CI (BRAVE_LIVE_TEST!=1) — known, documented skip`);
  } else {
    ok(!skipped, `${slug} is swept by test-all.js (not in a skip set) [${NETWORK?.has(path) ? "lenient/NETWORK" : "strict"}]`);
  }
}

// --- 3: paid-canary legs stay honest ---
const advertised = (kitTools, slug) => {
  const t = kitTools.find((x) => x.slug === slug);
  return t ? Number(String(t.price).replace(/[^0-9.]/g, "")) : NaN;
};
for (const leg of CANARY_LEGS) {
  const okShape = typeof leg.kit === "string" && typeof leg.path === "string" && leg.path.startsWith("/")
    && ["GET", "POST"].includes(leg.method) && typeof leg.priceUsd === "number" && typeof leg.check === "function";
  if (!okShape) { fail++; console.error(`FAIL - malformed canary leg: ${JSON.stringify({ kit: leg.kit, path: leg.path })}`); }
}
pass++; console.log(`ok - all ${CANARY_LEGS.length} canary legs are well-shaped (kit/path/method/priceUsd/check)`);

const legFor = (route) => CANARY_LEGS.find((l) => l.path === route || l.path.startsWith(`${route}?`));
const sq = legFor("/api/stock-quote");
ok(!!sq, "canary has a stock-quote leg");
if (sq) ok(sq.priceUsd === advertised(FINANCE_TOOLS, "stock-quote"), `stock-quote leg priceUsd (${sq?.priceUsd}) matches the kit's advertised price ($${advertised(FINANCE_TOOLS, "stock-quote")}) — no stale display price`);
const oc = legFor("/api/options-chain");
ok(!!oc, "canary has an options-chain leg (relay path continuously proven)");
if (oc) {
  ok(oc.method === "GET" && oc.path.includes("symbol=AAPL"), "options-chain leg uses the tool's own discovery example (GET symbol=AAPL)");
  ok(oc.priceUsd === advertised(FINANCE_TOOLS, "options-chain"), `options-chain leg priceUsd (${oc?.priceUsd}) matches the kit's advertised price ($${advertised(FINANCE_TOOLS, "options-chain")})`);
  const happy = { symbol: "AAPL", expirations: ["2026-07-17"], strikes: [230], calls: [{}], puts: [{}] };
  ok(oc.check(happy) === true, "options-chain leg check accepts the documented happy-path shape");
  ok(typeof oc.check({ symbol: "AAPL" }) === "string", "options-chain leg check rejects a chain-less response");
}

// The render leg is the only one that exercises the secretless browser/media
// worker (F02/F04/F06) on the paid path — lock it so it can't silently drop.
// Its advertised price ($0.02) lives in src/server.js's catalog (not a *_TOOLS
// export this test imports), so the price is pinned as a literal here.
const rn = legFor("/api/render");
ok(!!rn, "canary has a render leg (exercises the secretless browser/media worker)");
if (rn) {
  ok(rn.method === "POST" && !!rn.body?.url, "render leg POSTs a { url } body to /api/render");
  ok(rn.priceUsd === 0.02, `render leg priceUsd (${rn?.priceUsd}) matches the advertised $0.02`);
  ok(rn.check({ rendered: true, title: "Example Domain", markdown: "# Example Domain\nThis domain is for use in illustrative examples." }) === true, "render leg check accepts the documented happy-path shape");
  ok(typeof rn.check({ rendered: false }) === "string", "render leg check rejects a non-rendered response");
  ok(typeof rn.check({ rendered: true, title: "Something Else", markdown: "x" }) === "string", "render leg check rejects an unexpected page (title mismatch)");
}

// --- the canary must actually RUN on the days it claims to ------------------
//
// A daily proof that buying works proves nothing if it silently skips a day,
// and the gap is invisible: a missing run looks exactly like a quiet day on the
// revenue page. Measured deliveries of the single 13:17 cron arrived at 15:27
// and 15:21 (two hours late), one arrived at 14:39 and was CANCELLED, and one
// never arrived at all - which is how 2026-08-02 ended up with no canary rows
// on any chain and read as "sei is missing".
{
  const wf = readFileSync(new URL("../.github/workflows/paid-canary.yml", import.meta.url), "utf8");
  const crons = [...wf.matchAll(/^\s*-\s*cron:\s*["']([^"']+)["']/gm)].map((m) => m[1]);
  ok(crons.length >= 2,
    `more than one scheduled attempt, so a missed or cancelled delivery cannot cost a day (${crons.length}: ${crons.join(", ")})`);

  // The redundancy must be free, and the guard must be at JOB level. A
  // step-level condition would have to be repeated on every step, and the one
  // that got forgotten would spend ~$1.50 of real USDC anyway.
  ok(/\n\s{2}gate:/.test(wf), "a gate JOB decides whether this attempt spends anything");
  const canaryIf = wf.split("\n").find((l) => l.includes("if:") && l.includes("needs.gate.outputs.skip")) || "";
  ok(/needs:\s*gate/.test(wf) && canaryIf !== "",
    "the buying job is gated at JOB level, not per step");

  // Fail toward RUNNING, asserted STRUCTURALLY rather than by polarity.
  //
  // The previous version checked only that the comparison reads `!= 'true'`
  // rather than `== 'false'`. That says nothing about a gate that FAILED: a
  // job-level `if` with no status check function still carries the implicit
  // success() on `needs`, so a failed gate SKIPS the canary. The assertion
  // passed for weeks against exactly that code, claiming a property it had no
  // way to see. What actually makes the claim true is a status function
  // overriding the implicit check.
  ok(/!=\s*'true'/.test(canaryIf) && !/==\s*'false'/.test(canaryIf),
    "the gate's skip is opt-IN: an empty or missing output leaves the canary running");
  ok(/!\s*cancelled\(\)|always\(\)/.test(canaryIf),
    `a FAILED gate cannot silently disable the canary - the if carries a status function (got: ${canaryIf.trim()})`);

  // The gate must ask PRODUCTION when a canary last BOUGHT, never GitHub when
  // this workflow last concluded green. A run whose gate skips the buy also
  // concludes green, so keying on run history makes every skip refresh the
  // window the next gate reads, and the gate ratchets itself permanently shut.
  // Measured: shipped 2026-08-02, and not one scheduled run bought afterwards.
  const gateJob = wf.slice(wf.indexOf("\n  gate:"), wf.indexOf("\n  canary:"));
  ok(/\/api\/status/.test(gateJob) && !/gh run list/.test(gateJob),
    "the gate keys on a real settlement observation, not on this workflow's own run history");
  const jqReads = gateJob.split("\n").filter((l) => l.includes("jq -r"));
  ok(jqReads.length > 0 && jqReads.every((l) => /\|\|\s*echo\s+none/.test(l)),
    `every jq read in the gate falls back instead of failing the step (jq exits non-zero on a non-JSON body) (${jqReads.length} read${jqReads.length === 1 ? "" : "s"})`);

  // A human asking for a buy - usually right after a deploy - must never be
  // suppressed by the freshness window.
  ok(/if:\s*github\.event_name\s*==\s*'schedule'/.test(wf),
    "the freshness skip applies to SCHEDULED runs only; a manual dispatch always buys");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
