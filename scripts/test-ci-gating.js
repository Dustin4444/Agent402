#!/usr/bin/env node
// Splitting the test suite into parallel lanes is a speed change that can
// silently become a SAFETY change: a lane that nothing depends on still shows
// its own red X while `deploy` sails past it. That is how a money guard stops
// blocking a release without anyone editing the guard.
//
// This asserts the property directly - every lane that runs tests gates deploy
// and publish - so the next lane split fails here instead of in production.
import { readFileSync, existsSync } from "node:fs";
import { load } from "js-yaml";

const wf = load(readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8"));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error("FAIL:", m); } };

const jobs = wf.jobs || {};
// A "test lane" is any job whose steps actually run scripts/test-*.js. Derived,
// never a list: a hand-kept list is the thing that just went wrong one layer up.
const laneRunsTests = (j) =>
  (j.steps || []).some((s) => /node\s+scripts\/test-[\w.-]+\.js/.test(String(s.run || "")));
// Scoped to the `test*` lanes: paytest, publish and deploy also run scripts,
// but they are opt-in or post-deploy jobs, not the gating suite.
const lanes = Object.entries(jobs)
  .filter(([n, j]) => /^test(-|$)/.test(n) && laneRunsTests(j))
  .map(([n]) => n);

ok(lanes.length >= 4, `expected the split test lanes, found: ${lanes.join(", ")}`);
ok(lanes.includes("test-pricing"), "the pricing-margin lane is not detected as a test lane");

for (const gate of ["deploy", "publish"]) {
  const needs = [].concat(jobs[gate]?.needs || []);
  for (const lane of lanes) {
    ok(needs.includes(lane),
      `${gate} does not gate on the "${lane}" lane - that lane's failures cannot stop a release`);
  }
}

// The lanes must also be reachable at all: a lane whose `if:` never fires on a
// push to main is a guard that silently never runs.
for (const lane of lanes) {
  const cond = String(jobs[lane]?.if || "");
  ok(cond.includes("refs/heads/main"),
    `lane "${lane}" has no push-to-main condition, so a merge would skip it`);
}

// Chromium is expensive and only one lane needs it. Assert the pairing rather
// than the absence, so adding a browser test to a lane without the install
// fails here instead of at runtime.
// Whether a script drives a browser is read from the SCRIPT ITSELF, never from
// a name pattern. The first draft matched /reveal-[\w-]+/ and flagged
// test-reveal-no-hero-flash.js, which only reads source files - a name-shaped
// oracle inventing a dependency that does not exist. The import list is the
// only thing that actually decides whether Chromium is needed.
const scriptsIn = (j) => (j.steps || [])
  .flatMap((s) => [...String(s.run || "").matchAll(/scripts\/([\w.-]+\.js)/g)].map((m) => m[1]));
const needsBrowser = (file) => {
  const path = new URL(`../scripts/${file}`, import.meta.url);
  if (!existsSync(path)) return false;
  return /from\s+["'](playwright|puppeteer)|require\(["'](playwright|puppeteer)/.test(readFileSync(path, "utf8"));
};

for (const [name, j] of Object.entries(jobs)) {
  const steps = j.steps || [];
  const usesBrowser = scriptsIn(j).some(needsBrowser);
  const installs = steps.some((s) => /playwright install/.test(String(s.run || "")));
  if (usesBrowser) ok(installs, `job "${name}" runs a browser-driven script without installing Chromium`);
  if (installs) ok(usesBrowser, `job "${name}" installs Chromium but runs no browser-driven script - pure wasted minutes`);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
