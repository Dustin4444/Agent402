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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
