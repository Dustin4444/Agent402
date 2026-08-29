#!/usr/bin/env node
// The manual buyer may spend real USDC against a third-party seller. An
// explicit external target therefore needs a response expectation before the
// script reads a key, initializes the payment client, or makes a request.
//
// Run every case in a child process with an absent key file: rejected cases
// must stop at the expectation preflight, while accepted cases must reach the
// existing key guard without getting far enough to import or use the client.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUYER = join(ROOT, "scripts", "smoke-buy.js");
const TEMP_DIR = mkdtempSync(join(tmpdir(), "a402-smoke-buy-"));
const MISSING_KEY = join(TEMP_DIR, "missing-key");
const EXPECT_ERROR = "smoke-buy: SMOKE_EXPECT is required when SMOKE_TARGET selects an external target";
const KEY_ERROR = "smoke-buy: no BURNER_KEY / KEY_FILE — cannot run the paid check";

let pass = 0, fail = 0;
const ok = (condition, message) => {
  if (condition) { pass++; console.log(`ok - ${message}`); }
  else { fail++; console.error(`FAIL - ${message}`); }
};

const baseEnv = {
  ...process.env,
  KEY_FILE: MISSING_KEY,
  SMOKE_ROUTE: "/api/external-canary",
};
for (const name of ["BURNER_KEY", "SMOKE_EXPECT", "SMOKE_TARGET", "TARGET_URL"]) delete baseEnv[name];

const cases = [
  {
    name: "external target with unset expectation",
    env: { SMOKE_TARGET: "https://samedaydesk.example" },
    error: EXPECT_ERROR,
  },
  {
    name: "external target with blank expectation",
    env: { SMOKE_TARGET: "https://samedaydesk.example", SMOKE_EXPECT: "" },
    error: EXPECT_ERROR,
  },
  {
    name: "external target with whitespace expectation",
    env: { SMOKE_TARGET: "https://samedaydesk.example", SMOKE_EXPECT: " \t  " },
    error: EXPECT_ERROR,
  },
  {
    name: "trailing-slash external target",
    env: { SMOKE_TARGET: "https://samedaydesk.example///", SMOKE_EXPECT: "" },
    error: EXPECT_ERROR,
  },
  {
    name: "explicit agent402.tools target",
    env: { SMOKE_TARGET: "https://agent402.tools", SMOKE_EXPECT: "" },
    error: EXPECT_ERROR,
  },
  {
    name: "external target with a nonempty expectation",
    env: { SMOKE_TARGET: "https://samedaydesk.example", SMOKE_EXPECT: "  requested outcome  " },
    error: KEY_ERROR,
  },
  {
    name: "empty target with empty expectation",
    env: { SMOKE_TARGET: "", SMOKE_EXPECT: "" },
    error: KEY_ERROR,
  },
  {
    name: "TARGET_URL alone with empty expectation",
    env: { TARGET_URL: "https://samedaydesk.example", SMOKE_EXPECT: "" },
    error: KEY_ERROR,
  },
];

try {
  ok(!existsSync(MISSING_KEY), "child key file is absent");
  for (const testCase of cases) {
    const run = spawnSync(process.execPath, [BUYER], {
      cwd: ROOT,
      env: { ...baseEnv, ...testCase.env },
      encoding: "utf8",
      timeout: 10_000,
    });
    ok(!run.error, `${testCase.name}: child process runs`);
    ok(run.status === 2, `${testCase.name}: exits 2 (got ${run.status})`);
    ok(run.stdout === "", `${testCase.name}: emits no stdout before the guard`);
    ok(run.stderr === `${testCase.error}\n`, `${testCase.name}: stops at the expected guard`);
  }
} finally {
  rmSync(TEMP_DIR, { recursive: true, force: true });
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
