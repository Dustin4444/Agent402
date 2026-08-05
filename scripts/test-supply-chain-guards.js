// Supply-chain guards for the packages we PUBLISH and the pipeline that
// publishes them. Every assertion here encodes a 2026 attack that actually
// happened to somebody else:
//
//   - npm publish tokens must never share a step with code execution. The
//     ChainDrop/Shai-Hulud worm family steals exactly this: a publish token
//     exposed to a dependency's install script, then used to republish every
//     package that token can reach. Our llamaindex publish step used to run a
//     remote `npm install` of a large third-party tree with NODE_AUTH_TOKEN in
//     env (fixed 2026-08-05).
//   - Published packages must ship no install hooks: a consumer running
//     `npm install agent402-*` must never execute our code.
//   - Published tarballs must be `files`-allowlisted, so a stray .env/.npmrc
//     can never ship.
//   - Remote installs in tests must pin an exact version and skip scripts.
//
// Offline (reads the workflow + package manifests; no network, no installs).
//   node scripts/test-supply-chain-guards.js
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`ok - ${msg}`); }
  else { failed++; console.error(`FAIL - ${msg}`); }
};

const ROOT = new URL("..", import.meta.url).pathname;
const wf = readFileSync(join(ROOT, ".github/workflows/deploy.yml"), "utf8");

// --- 1. token isolation ----------------------------------------------------
// Split the workflow into steps; any step whose env carries the npm token must
// not also execute code (tests, installs, arbitrary node).
const steps = wf.split(/\n      - name: /).slice(1);
const tokenSteps = steps.filter((s) => s.includes("NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}"));
ok(tokenSteps.length > 0, `found ${tokenSteps.length} steps carrying the npm publish token`);
const EXEC = /node\s+\S+\.(js|mjs|cjs)|npm\s+(ci|install)\b|npx\s/;
for (const s of tokenSteps) {
  const name = s.split("\n")[0].trim();
  // The publish command itself is allowed; strip it before looking for exec.
  const body = s.replace(/npm (publish|view)[^\n]*/g, "");
  ok(!EXEC.test(body), `token step runs no code: "${name.slice(0, 52)}"`);
}

// --- 2. no install hooks in anything we publish ----------------------------
const pkgDirs = ["mcp", "tollbooth", "client",
  ...readdirSync(join(ROOT, "adapters"), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(ROOT, "adapters", d.name, "package.json")))
    .map((d) => `adapters/${d.name}`)];
ok(pkgDirs.length >= 11, `discovered ${pkgDirs.length} publishable packages`);

const HOOKS = ["preinstall", "install", "postinstall", "prepare", "prepublish"];
for (const dir of pkgDirs) {
  const pkg = JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8"));
  if (pkg.private === true) continue;
  const hooks = HOOKS.filter((h) => pkg.scripts?.[h]);
  ok(hooks.length === 0, `${pkg.name}: no consumer-install hooks${hooks.length ? ` (found ${hooks})` : ""}`);
  ok(Array.isArray(pkg.files) && pkg.files.length > 0, `${pkg.name}: ships a files allowlist`);
  ok(!existsSync(join(ROOT, dir, ".npmignore")), `${pkg.name}: no .npmignore (allowlist-only is the safe pattern)`);
}

// --- 3. remote installs in tests are pinned + scriptless --------------------
// A range like ^0.12 is NOT a pin: it takes any new 0.12.x, which is precisely
// how worm-published patch versions land in CI.
for (const dir of pkgDirs) {
  const t = join(ROOT, dir, "test.js");
  if (!existsSync(t)) continue;
  const src = readFileSync(t, "utf8");
  for (const m of src.matchAll(/npm install ([^"']+)/g)) {
    const cmd = m[1];
    const spec = cmd.trim().split(/\s+/)[0];
    const local = spec.startsWith(".") || spec.startsWith("/");
    ok(cmd.includes("--ignore-scripts"), `${dir}: install of "${spec}" skips lifecycle scripts`);
    if (!local) {
      ok(/@\d+\.\d+\.\d+$/.test(spec), `${dir}: remote install "${spec}" pins an EXACT version (no ^ or ~ range)`);
    }
  }
}

// --- 4. publish reachability ------------------------------------------------
ok(!wf.includes("pull_request_target"), "no pull_request_target in the deploy workflow (fork-PR privilege escalation)");
ok(/npm publish --provenance/.test(wf), "publishes carry --provenance");

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
