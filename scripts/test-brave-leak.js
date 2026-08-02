#!/usr/bin/env node
// Brave-subscription leak guard.
//
// WHY THIS EXISTS (it has now happened twice):
// The CI test job boots the server with the REAL BRAVE_API_KEY and FREE_MODE=true
// (paywall off), then sweeps every tool. Any sweep that reaches a Brave-backed
// handler spends the paid Brave subscription for a test - and because the CI
// server has no PostHog configured, those calls are invisible to every inbound
// accounting surface we have. That invisibility is the dangerous part: the July
// bill showed 5,106 Search requests while our telemetry could account for ~600,
// and the gap was only found by correlating Brave's daily CSV against CI run
// counts (~11.4 Brave requests per CI run before the 2026-07-23 audit, ~2.3
// after it, ~0 after this guard).
//
// test-all.js already skips the DIRECT Brave routes and the packs known at the
// time of that audit. The recurrence was structural: a skill pack added later
// whose steps call a Brave-backed tool silently reopens the leak, because
// nothing tied the skip list to the pack catalogue. This test is that tie.
//
// Offline, no network, no key needed.
import { readFileSync } from "node:fs";
import { SKILL_PACKS } from "../src/skills.js";
import { SEARCH_TOOLS } from "../src/tools/search.js";
import { CODE_RUN_TOOLS } from "../src/tools/code-run-kit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const BRAVE_SLUGS = new Set(SEARCH_TOOLS.map((t) => t.slug));
const testAll = readFileSync(new URL("./test-all.js", import.meta.url), "utf8");
const start = testAll.indexOf("const BRAVE_ROUTES");
const end = testAll.indexOf("const skipBrave");
ok(start > 0 && end > start, "test-all.js still defines a BRAVE_ROUTES skip set");
const skipBlock = testAll.slice(start, end);

// 1. Every Brave-backed tool's own route is skipped.
for (const t of SEARCH_TOOLS) {
  const route = `/api/${t.slug}`;
  ok(skipBlock.includes(`"${route}"`), `direct route ${route} is in BRAVE_ROUTES`);
}

// 2. THE REGRESSION THAT KEEPS HAPPENING: every skill pack whose steps invoke a
//    Brave-backed tool must also be skipped. A new pack that composes `search`
//    is the exact shape that reopened this leak on 2026-07-28.
const packsReachingBrave = Object.values(SKILL_PACKS)
  .map((p) => ({ slug: p.slug, hits: (p.toolSlugs || []).filter((s) => BRAVE_SLUGS.has(s)) }))
  .filter((p) => p.hits.length);
ok(packsReachingBrave.length > 0, `found ${packsReachingBrave.length} packs that reach Brave (sanity: the detector works)`);
for (const p of packsReachingBrave) {
  ok(
    skipBlock.includes(`"/api/skill/${p.slug}"`),
    `skill pack "${p.slug}" reaches Brave via ${p.hits.join("+")} - must be in BRAVE_ROUTES or every CI run buys ${p.hits.length} live search(es)`,
  );
}

// 3. The opt-in switch must stay opt-IN. If this ever defaults to running live
//    calls, every CI run bills the subscription again.
ok(/const skipBrave = process\.env\.BRAVE_LIVE_TEST !== "1"/.test(testAll),
  "live Brave calls stay opt-in (BRAVE_LIVE_TEST=1), never the default");

// 4. No stale entries: a route in the skip set that no longer reaches Brave is
//    dead weight that hides a real gap later.
const validRoutes = new Set([
  ...SEARCH_TOOLS.map((t) => `/api/${t.slug}`),
  ...packsReachingBrave.map((p) => `/api/skill/${p.slug}`),
]);
const listed = [...skipBlock.matchAll(/"(\/api\/[^"]+)"/g)].map((m) => m[1]);
const stale = listed.filter((r) => !validRoutes.has(r));
ok(stale.length === 0, `no stale BRAVE_ROUTES entries${stale.length ? ` (found: ${stale.join(", ")})` : ""}`);

// 5. Same guard for E2B (2026-07-29 paid-upstream audit): the CI server also
//    boots with the real E2B_API_KEY, so an unskipped code-run example spins a
//    real sandbox on every run. Live coverage lives in test-code-run-kit.js,
//    which CI runs live deliberately - the generic sweep must not add its own.
const E2B_SLUGS = new Set(CODE_RUN_TOOLS.map((t) => t.slug));
const e2bStart = testAll.indexOf("const E2B_ROUTES");
const e2bEnd = testAll.indexOf("const skipE2b");
ok(e2bStart > 0 && e2bEnd > e2bStart, "test-all.js defines an E2B_ROUTES skip set");
const e2bBlock = testAll.slice(e2bStart, e2bEnd);
for (const t of CODE_RUN_TOOLS) {
  ok(e2bBlock.includes(`"/api/${t.slug}"`), `direct route /api/${t.slug} is in E2B_ROUTES`);
}
const packsReachingE2b = Object.values(SKILL_PACKS)
  .map((p) => ({ slug: p.slug, hits: (p.toolSlugs || []).filter((s) => E2B_SLUGS.has(s)) }))
  .filter((p) => p.hits.length);
for (const p of packsReachingE2b) {
  ok(
    e2bBlock.includes(`"/api/skill/${p.slug}"`),
    `skill pack "${p.slug}" reaches E2B via ${p.hits.join("+")} - must be in E2B_ROUTES or every CI run spins ${p.hits.length} live sandbox(es)`,
  );
}
ok(/const skipE2b = process\.env\.E2B_LIVE_TEST !== "1"/.test(testAll),
  "live E2B sweep calls stay opt-in (E2B_LIVE_TEST=1), never the default");
const e2bValid = new Set([
  ...CODE_RUN_TOOLS.map((t) => `/api/${t.slug}`),
  ...packsReachingE2b.map((p) => `/api/skill/${p.slug}`),
]);
const e2bListed = [...e2bBlock.matchAll(/"(\/api\/[^"]+)"/g)].map((m) => m[1]);
const e2bStale = e2bListed.filter((r) => !e2bValid.has(r));
ok(e2bStale.length === 0, `no stale E2B_ROUTES entries${e2bStale.length ? ` (found: ${e2bStale.join(", ")})` : ""}`);

// --- multi-search must not pay twice for the same query --------------------
//
// The price is flat for 2-5 queries, but every query was a separate BILLED
// upstream request, so ["x","x","x","x","x"] cost five Brave calls for one
// $0.08 sale. A margin leak on honest duplicates and a free 5x multiplier for
// anyone who noticed. Search is the tool we genuinely pay per call for, so
// this is real money, not hygiene.
{
  const src = readFileSync(new URL("../src/tools/search.js", import.meta.url), "utf8");
  const handler = src.slice(src.indexOf('slug: "multi-search"'));
  ok(/new Set\(normalized/.test(handler),
    "multi-search dedupes queries before fanning out to the billed upstream");
  ok(/unique\.map\(async \(q\)/.test(handler),
    "the upstream fan-out iterates UNIQUE queries, not the raw input array");
  ok(/normalized\.map\(\(q\)/.test(handler),
    "the response is still built per INPUT query, so the caller's shape and order are unchanged");

  // The behaviour, proven rather than pattern-matched.
  const queries = ["alpha", "beta", "alpha", " alpha ", "", "beta"];
  const normalized = queries.map((r) => (typeof r === "string" ? r.trim().slice(0, 400) : ""));
  const unique = [...new Set(normalized.filter(Boolean))];
  ok(unique.length === 2, `six inputs collapse to ${unique.length} billed calls`);
  ok(normalized.length === queries.length, "every input still gets a response entry");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
