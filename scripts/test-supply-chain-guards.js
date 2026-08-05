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
// We now publish over OIDC, so normally there are ZERO token-bearing steps and
// this section has nothing to check (section 4 asserts that absence). It stays
// because the documented rollback re-adds a token: if that ever happens, the
// isolation rule must still hold - a token may never share a step with code
// execution, which is how the worm family harvests publish credentials.
//
// Matching is on a real `env:` binding only. An earlier version of this test
// matched the token string anywhere in the step text, so it counted the
// ROLLBACK COMMENT as a token-bearing step and reported "found 1" long after
// the tokens were gone - green for the wrong reason.
const steps = wf.split(/\n      - name: /).slice(1);
const bindsToken = (s) => s.split("\n").some((l) =>
  /^\s+NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\./.test(l) && !l.trim().startsWith("#"));
const tokenSteps = steps.filter(bindsToken);
const EXEC = /node\s+\S+\.(js|mjs|cjs)|npm\s+(ci|install)\b|npx\s/;
for (const s of tokenSteps) {
  const name = s.split("\n")[0].trim();
  // The publish command itself is allowed; strip it before looking for exec.
  const body = s.replace(/npm (publish|view)[^\n]*/g, "");
  ok(!EXEC.test(body), `token step runs no code: "${name.slice(0, 52)}"`);
}
ok(true, `token-bearing publish steps: ${tokenSteps.length} (0 expected under trusted publishing)`);

// A credential does not have to arrive via `env:` to be present. The OIDC
// preflight exchanges for a real short-lived publish token, and an earlier
// version wrote npm's response to a fixed path that outlived the step - which
// this guard could not see, because it only ever matched env bindings. The
// stated invariant is "no publish credential shares an execution context with
// third-party code", so assert the DISK form too: anything that curls npm's
// token-exchange endpoint to a file must delete that file in the same step.
const exchangeSteps = steps.filter((s) => s.includes("oidc/token/exchange"));
for (const s of exchangeSteps) {
  const name = s.split("\n")[0].trim();
  const writesToFile = /curl[^\n]*-o\s+(\S+)/.exec(s);
  if (!writesToFile) { ok(true, `OIDC exchange step keeps the response off disk: "${name.slice(0, 40)}"`); continue; }
  const path = writesToFile[1];
  ok(s.includes(`rm -f ${path}`), `OIDC exchange step deletes ${path} before the step ends: "${name.slice(0, 40)}"`);
}
// Same reasoning for `sed -i.bak` on the npmrc: the .bak retains the original
// auth line.
for (const s of steps) {
  if (!/sed -i\.bak[^\n]*_authToken/.test(s)) continue;
  const name = s.split("\n")[0].trim();
  ok(/rm -f "?\$NPMRC\.bak"?/.test(s), `npmrc backup is deleted after stripping the auth line: "${name.slice(0, 40)}"`);
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

// --- 4. no npm credential in CI at all (trusted publishing) -----------------
// Migrated 2026-08-05: auth is GitHub OIDC exchanged against each package's
// trusted publisher on npmjs.com. A long-lived token in the workflow would
// silently take precedence over OIDC and put a publish credential back in
// reach of a compromised secret - so its ABSENCE is the invariant. (The
// documented rollback line in a comment is allowed; an actual env binding
// is not.)
const tokenBindings = wf.split("\n").filter((l) =>
  /NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\./.test(l) && !l.trim().startsWith("#"));
ok(tokenBindings.length === 0, `no npm token is bound in the workflow${tokenBindings.length ? ` (found ${tokenBindings.length})` : ""}`);
ok(/id-token: write/.test(wf), "publish job still grants id-token: write (the OIDC credential)");
ok(/npm install -g npm@11\./.test(wf), "publish job pins an npm CLI new enough to exchange OIDC");

// --- 5. publish reachability ------------------------------------------------
ok(!wf.includes("pull_request_target"), "no pull_request_target in the deploy workflow (fork-PR privilege escalation)");
ok(/npm publish --provenance/.test(wf), "publishes carry --provenance");

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
