#!/usr/bin/env node
// A public route must not be able to spend money without limit.
//
//   node scripts/test-paid-scan-budget.js          (offline, source invariants)
//
// WHY: `/<chain>?seller=<host>` and `/api/market/<chain>/panel` are public,
// unauthenticated, and take an arbitrary seller from a roster of ~2,300. On
// Base each distinct wallet ran a CDP SQL query billed at $0.0083, twice.
//
// July 2026 invoice: 29,589 SQL queries, $245.59 - against roughly $50 of
// revenue that month. One crawler walking the seller roster is ~4,600 billed
// queries, and robots.txt explicitly welcomed every major crawler.
//
// Three defects, three guards:
//   1. robots.txt invited crawlers to the paid URLs
//   2. nothing bounded the paid path, so volume was whatever the internet chose
//   3. the wallet cache called clear() at 500 entries, so crossing the
//      threshold re-cooled every wallet at once and re-billed all of them
import { readFileSync } from "node:fs";
import { robotsTxt } from "../src/seo.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// 1. robots.txt must disallow the URLs that cost money per fetch - for the
//    named crawlers AND the wildcard, since the named blocks override it.
const robots = robotsTxt("https://agent402.tools");
const blocks = robots.split(/\n\n+/).filter((b) => /^User-agent:/m.test(b));
const missing = blocks.filter((b) => !/Disallow: \/\*\?seller=/.test(b));
ok(missing.length === 0,
  `every user-agent block disallows the seller-scoped URLs (${missing.length} without)`);
ok(/Disallow: \/api\/market\//.test(robots), "the panel endpoint is disallowed too");

// The pages themselves must STAY indexable - the fix is about the parameter
// that multiplies a page view by a paid query, not about hiding the market.
ok(/User-agent: Googlebot\nAllow: \//.test(robots),
  "the market pages themselves remain crawlable - only the paid variant is blocked");

const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

// 2. The paid path must be budgeted, and the check must come BEFORE the spend.
ok(/const SQL_SCAN_DAILY_BUDGET/.test(src), "a daily ceiling on paid scans exists");
const baseBranch = src.slice(src.indexOf('if (chainKey === "base")'), src.indexOf('if (chainKey === "base")') + 400);
ok(/paidScanAllowed\(\)/.test(baseBranch), "the Base branch consults the budget");
ok(baseBranch.indexOf("paidScanAllowed()") < baseBranch.indexOf("baseActivityViaSql"),
  "the budget is checked BEFORE the query - checking after would still spend");
ok(/return evmActivity\("base", wallet\)/.test(baseBranch),
  "past the ceiling it falls back to the FREE scanner rather than erroring - the panel still renders");

// 3. The cache must not empty itself under load.
ok(!/chainActivityByWallet\.clear\(\)/.test(src),
  "the wallet cache no longer clear()s wholesale - that re-billed every warm wallet at once");
ok(/chainActivityByWallet\.delete\(oldest\)/.test(src),
  "it evicts the oldest single entry instead");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
