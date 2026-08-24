#!/usr/bin/env node
// The crawl cadence is a factual claim we make to third parties about how often
// we fetch their servers — the same class as a price quoted in prose, and the
// reason a seller opened #886. It is stated on two rendered pages, and both
// used to type "every 5 minutes" as a literal, so raising the interval would
// have left us advertising a cadence six times faster than the one we run.
//
// This guard fails if any served page states a crawl cadence that is not the
// one derived from the timer constant. Offline; no server boot.
import { readFileSync } from "node:fs";
import { crawlIntervalLabel } from "../src/x402-index.js";
import { mppCrawlIntervalLabel } from "../src/mpp-index.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error("FAIL:", m); } };

// 1. The labels are derived, and derive correctly.
ok(/^every \d+ (minutes|hours)$|^every hour$/.test(crawlIntervalLabel()),
  `x402 label malformed: ${crawlIntervalLabel()}`);
ok(/^every \d+ (minutes|hours)$|^every hour$/.test(mppCrawlIntervalLabel()),
  `mpp label malformed: ${mppCrawlIntervalLabel()}`);

// 2. No page SOURCE may hardcode a crawl cadence. We look for a cadence phrase
//    sitting next to crawl language in a string literal, which is exactly the
//    shape that shipped. A file that interpolates the derived label is fine
//    because the literal minutes are simply not there to match.
const PAGE_FILES = [
  "src/x402-index.js",
  "src/mpp-market-page.js",
  "src/mpp-index.js",
  "src/landing.js",
  "src/ledger-home.js",
  "src/pages.js",
  "src/seo.js",
];
// Deliberately keyed on crawl/index language only: the heartbeat and the
// Cloudflare status observer also state cadences, and those are honest claims
// about a different system that must not be rewritten by this guard.
const CADENCE = /(crawl|re-?probes?|index)[^.<>{}]{0,80}?every (\d+|five|ten|fifteen|thirty) minutes?/i;
for (const f of PAGE_FILES) {
  let src = "";
  try { src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8"); } catch { continue; }
  const offenders = src.split("\n")
    .map((line, i) => [i + 1, line])
    // comments explain mechanism to us, not cadence to sellers
    .filter(([, line]) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .filter(([, line]) => CADENCE.test(line));
  ok(offenders.length === 0,
    `${f} states a crawl cadence as a literal (derive it from crawlIntervalLabel()): ` +
    offenders.map(([n]) => `line ${n}`).join(", "));
}

// 3. Mutation control: the detector must actually see the shape that shipped.
ok(CADENCE.test('this page crawls them every 5 minutes and shows what is online'),
  "detector blind to the exact string that shipped on /index");
ok(CADENCE.test('A crawl cycle re-probes every known origin every 5 minutes;'),
  "detector blind to the exact string that shipped on /mpp-marketplace");
ok(!CADENCE.test('the heartbeat probes production every 15 minutes'),
  "detector over-matches unrelated cadence copy (status/heartbeat)");

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
