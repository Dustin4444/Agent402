#!/usr/bin/env node
// Production went down on EVERY deploy, and the cause was this file's own
// shutdown path rather than anything on Railway's side.
//
// Railway SIGTERMs the old container when the new deployment STARTS, not when
// it can serve, and keeps routing to the old one until the new one passes its
// health check. Measured on the 2026-08-24 20:45 deploy: SIGTERM 20:45:17, new
// deployment healthy 20:47:05 - 108 seconds later. Calling httpServer.close()
// on arrival stopped this process accepting new connections for that whole
// window, and at its hard deadline it exited, turning 502s into connection
// timeouts. `overlapSeconds` cannot help: the surviving container is alive but
// refusing connections, so there is nothing to overlap with.
//
// So the contract is: after SIGTERM the server KEEPS SERVING for the lame-duck
// period, and only then stops. This boots a real server, signals it, and holds
// it to that.
import { spawn } from "node:child_process";

const PORT = 3830 + (process.pid % 120);
const BASE = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.error("FAIL -", m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (p) => {
  try { const r = await fetch(`${BASE}${p}`, { signal: AbortSignal.timeout(4000) }); return r.status; }
  catch { return 0; }
};

const LAME_DUCK_MS = 4000;   // short enough to test, same code path as 120s
const srv = spawn("node", ["src/server.js"], {
  env: { ...process.env, FREE_MODE: "true", PORT: String(PORT), X402_SYNC_ON_START: "false",
         X402_INDEX_CRAWL: "off", SHUTDOWN_LAME_DUCK_MS: String(LAME_DUCK_MS) },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
srv.stdout.on("data", (d) => { out += d; });
srv.stderr.on("data", (d) => { out += d; });

let up = false;
for (let i = 0; i < 90; i++) { if (await get("/health") === 200) { up = true; break; } await sleep(500); }
ok(up, `server booted on :${PORT}`);
if (!up) { srv.kill("SIGKILL"); console.log(out.slice(-800)); process.exit(1); }

// --- the actual contract ----------------------------------------------------
srv.kill("SIGTERM");
await sleep(600);
const during = await get("/health");
ok(during === 200,
  `still SERVING 0.6s after SIGTERM (got ${during}) - this is the deploy-downtime bug: ` +
  "closing the listener on arrival refuses traffic Railway is still routing here");

const mid = await get("/api/hash?text=x");
ok(mid !== 0, `a real request is still accepted mid-lame-duck (got ${mid})`);

// Still serving near the end of the window, not just at the start.
await sleep(LAME_DUCK_MS - 2200);
const late = await get("/health");
ok(late === 200, `still serving late in the lame duck (got ${late})`);

// --- and it must actually stop afterwards, or a deploy never completes ------
await sleep(2600);
let stopped = false;
for (let i = 0; i < 20; i++) { if (await get("/health") === 0) { stopped = true; break; } await sleep(400); }
ok(stopped, "stopped accepting connections after the lame duck (a server that never drains blocks the deploy)");

await sleep(300);
ok(/serving for \d+s more/.test(out), "SIGTERM log does not say how long it will keep serving");
ok(/lame-duck over/.test(out), "no log line marks the transition into draining");

srv.kill("SIGKILL");

// --- the three numbers live in two files and must be sized together ---------
// Railway SIGKILLs at RAILWAY_DEPLOYMENT_DRAINING_SECONDS no matter what we are
// doing. If the lame duck plus the drain deadline exceeds that grace, the kill
// lands mid-drain and we are back to hard-killing paid-for requests - the exact
// failure the grace was introduced to prevent. Nothing else checks this, and
// the values sit in src/server.js and .github/workflows/deploy.yml, so a change
// to either one alone would break it silently.
const { readFileSync } = await import("node:fs");
const srvSrc = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const wf = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
const num = (m) => (m ? Number(String(m[1]).replace(/_/g, "")) : NaN);
const drain = num(srvSrc.match(/const DRAIN_DEADLINE_MS = ([0-9_]+)/));
const quiet = num(srvSrc.match(/LAME_DUCK_QUIET_MS \?\? ([0-9_]+)/));
const grace = num(wf.match(/RAILWAY_DEPLOYMENT_DRAINING_SECONDS:"(\d+)"/)) * 1000;

// There is deliberately NO window to size any more. Three of them (120s, 300s,
// 510s-derived) were each beaten by the next deploy's gap. The production path
// drains when traffic STOPS - the one signal Railway gives that the swap is
// done - so what has to hold is that the production branch is the quiet-driven
// one and that the grace is a backstop large enough never to SIGKILL a
// still-serving container.
const shutdownSrc = srvSrc.slice(srvSrc.indexOf("function shutdown(signal,"), srvSrc.indexOf('process.on("SIGTERM"'));
ok(/serving until traffic stops/.test(shutdownSrc),
  "production shutdown path is no longer quiet-driven - a sized window will go stale again");
// Presence of the quiet branch is not enough: production has to REACH it. It
// does so only when LAME_DUCK_MS is null (no env override). A mutation that
// set the default to a literal kept every quiet-path string in the file and
// silently put production back on a clock - this survived the first draft.
const dflt = srvSrc.slice(srvSrc.indexOf("const LAME_DUCK_MS ="), srvSrc.indexOf("let lastRequestAt"));
ok(/:\s*null;/.test(dflt) && !/:\s*[0-9_]+\s*;/.test(dflt),
  "LAME_DUCK_MS defaults to a number - production takes the fixed-window branch and never the quiet one");
ok(/lastRequestAt/.test(shutdownSrc) && /LAME_DUCK_QUIET_MS/.test(shutdownSrc),
  "quiet detection does not read lastRequestAt against LAME_DUCK_QUIET_MS");
// The timestamp must be fed from the raw server, not Express middleware order
// (an app.use() at the end of the file never runs - routes end the response).
ok(/httpServer\.on\("request", \(\) => \{ lastRequestAt = Date\.now\(\); \}\)/.test(srvSrc),
  "lastRequestAt is not fed from httpServer 'request' - middleware order would leave it stale and drain under live traffic");
ok(Number.isFinite(drain) && drain > 0, `drain deadline unreadable (got ${drain})`);
ok(Number.isFinite(quiet) && quiet >= 5_000 && quiet <= 60_000,
  `quiet window ${quiet / 1000}s should be seconds, not a build-length guess (5-60s)`);
ok(Number.isFinite(grace) && grace > 0, `RAILWAY_DEPLOYMENT_DRAINING_SECONDS unreadable (got ${grace})`);
// Backstop only: must exceed the worst gap ever measured, with margin. 539s is
// the worst so far. If a deploy ever beats this, raise the grace - it is the
// one remaining way the old container can be killed while still serving.
ok(grace >= 539_000 * 1.5,
  `grace ${grace / 1000}s is not a safe backstop over the 539s worst measured gap (need >= 1.5x)`);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
