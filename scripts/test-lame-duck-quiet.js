#!/usr/bin/env node
// The production shutdown path: after SIGTERM the server keeps serving for as
// long as requests keep arriving, and drains only once traffic has stopped for
// LAME_DUCK_QUIET_MS. Traffic stopping is the one signal Railway gives us that
// the replacement is live - it stops routing here - so this needs no window
// to size, which is the point: three sized windows (120s, 300s, 510s) were
// each beaten by the next deploy's gap.
//
// Boots a real server with NO SHUTDOWN_LAME_DUCK_MS override, so this is the
// exact branch production takes.
import { spawn } from "node:child_process";
const PORT = 3860 + (process.pid % 100), BASE = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.error("FAIL -", m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (p) => { try { return (await fetch(`${BASE}${p}`, { signal: AbortSignal.timeout(3000) })).status; } catch { return 0; } };

const QUIET = 2500;
const srv = spawn("node", ["src/server.js"], {
  env: { ...process.env, FREE_MODE: "true", PORT: String(PORT), X402_SYNC_ON_START: "false",
         X402_INDEX_CRAWL: "off", LAME_DUCK_QUIET_MS: String(QUIET) },
  stdio: ["ignore", "pipe", "pipe"],
});
delete srv.spawnargs; // keep env clean of any inherited override
let out = ""; srv.stdout.on("data", (d) => out += d); srv.stderr.on("data", (d) => out += d);
if (process.env.SHUTDOWN_LAME_DUCK_MS != null) { console.error("unset SHUTDOWN_LAME_DUCK_MS to run this"); process.exit(1); }

let up = false;
for (let i = 0; i < 90; i++) { if (await get("/health") === 200) { up = true; break; } await sleep(500); }
ok(up, `server booted on :${PORT}`);
if (!up) { srv.kill("SIGKILL"); console.log(out.slice(-600)); process.exit(1); }

srv.kill("SIGTERM");
await sleep(300);
ok(/serving until traffic stops/.test(out), "production path taken (not the fixed-window override)");

// Keep traffic flowing well past the quiet window - it must NOT drain while
// requests are still arriving, because that is exactly the swap-in-progress
// state where the old container is still the only thing serving.
let served = 0;
const t0 = Date.now();
while (Date.now() - t0 < QUIET * 2.5) { if (await get("/health") === 200) served++; await sleep(400); }
ok(served >= 10, `kept serving under continuous traffic for ${QUIET * 2.5}ms (${served} ok responses) - ${QUIET}ms quiet window never elapsed`);
ok(!/swap observed/.test(out), "did not drain while traffic was still arriving");

// Now go quiet. The swap is "observed" and it must drain and exit.
await sleep(QUIET + 1500);
let stopped = false;
for (let i = 0; i < 20; i++) { if (await get("/health") === 0) { stopped = true; break; } await sleep(300); }
ok(stopped, "drained once traffic stopped (a server that never drains blocks the deploy)");
ok(/swap observed/.test(out), "log names the trigger as observed quiet, not a clock");

srv.kill("SIGKILL");
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
