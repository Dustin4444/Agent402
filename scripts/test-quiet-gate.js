// Tests for the deploy quiet gate — the CI step that holds a Railway deploy
// until external paid traffic has a lull. Pure checks on the verdict helpers
// plus end-to-end runs of the script against a stub /api/stats server.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { lastPaidAgeSeconds, isQuiet } from "./deploy-quiet-gate.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

const NOW = 1_800_000_000_000;
const iso = (agoSecs) => new Date(NOW - agoSecs * 1000).toISOString();
const stats = (calls) => ({ recentCalls: calls });

// --- verdict helpers -------------------------------------------------------
ok(lastPaidAgeSeconds(stats([{ slug: "transcribe", paidWith: "usdc", at: iso(30) }]), NOW) === 30,
  "age of the newest usdc call is measured");
ok(lastPaidAgeSeconds(stats([
  { slug: "hash", paidWith: "usdc", at: iso(501) },
  { slug: "transcribe", paidWith: "usdc", at: iso(40) },
]), NOW) === 40, "the NEWEST usdc call wins regardless of feed order");
ok(lastPaidAgeSeconds(stats([
  { slug: "hash", paidWith: "heartbeat", at: iso(5) },
  { slug: "hash", paidWith: "proof-of-work", at: iso(5) },
]), NOW) === Infinity, "heartbeat and PoW traffic never block the gate");
ok(lastPaidAgeSeconds(stats([]), NOW) === Infinity, "empty feed reads as quiet");
ok(lastPaidAgeSeconds({}, NOW) === Infinity, "malformed stats fail open (quiet)");
ok(lastPaidAgeSeconds(stats([{ paidWith: "usdc", at: "not-a-date" }]), NOW) === Infinity,
  "unparseable timestamps are ignored");
ok(isQuiet(stats([{ paidWith: "usdc", at: iso(200) }]), NOW, 180) === true, "older-than-window paid call is quiet");
ok(isQuiet(stats([{ paidWith: "usdc", at: iso(100) }]), NOW, 180) === false, "recent paid call is busy");

// --- end-to-end against a stub server --------------------------------------
const gateScript = join(dirname(fileURLToPath(import.meta.url)), "deploy-quiet-gate.js");

function runGate(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [gateScript], { env: { ...process.env, ...env } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

let mode = "busy-then-quiet";
let hits = 0;
const server = createServer((req, res) => {
  hits++;
  if (mode === "http-501") {
    res.writeHead(501).end("boom");
    return;
  }
  // busy for the first two polls, then the last paid call ages out
  const ageSecs = mode === "busy-then-quiet" && hits <= 2 ? 1 : 9999;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(stats([{ slug: "transcribe", paidWith: "usdc", at: new Date(Date.now() - ageSecs * 1000).toISOString() }])));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

let r = await runGate({ TARGET_URL: base, QUIET_SECS: "60", POLL_SECS: "0.2", MAX_WAIT_SECS: "30" });
ok(r.code === 0 && /PASS/.test(r.out), "gate waits through a burst and passes once traffic ages out");
ok(hits >= 3, `gate actually polled through the busy window (${hits} polls)`);

hits = 0; mode = "busy-forever";
// stays busy: every poll reports a 1s-old paid call → hits the max wait
const busyServer = createServer((req, res) => {
  hits++;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(stats([{ slug: "transcribe", paidWith: "usdc", at: new Date().toISOString() }])));
});
await new Promise((r2) => busyServer.listen(0, "127.0.0.1", r2));
r = await runGate({ TARGET_URL: `http://127.0.0.1:${busyServer.address().port}`, QUIET_SECS: "60", POLL_SECS: "0.2", MAX_WAIT_SECS: "1" });
ok(r.code === 0 && /proceeding anyway/.test(r.out), "sustained traffic → proceeds after max wait with a warning (never strands a deploy)");
busyServer.close();

hits = 0; mode = "http-501";
r = await runGate({ TARGET_URL: base, QUIET_SECS: "60", POLL_SECS: "0.2", MAX_WAIT_SECS: "30" });
ok(r.code === 0 && /failing OPEN/.test(r.out) && hits >= 4, "unreachable stats fails open after consecutive errors");

r = await runGate({ TARGET_URL: base, QUIET_GATE: "off" });
ok(r.code === 0 && /skipping/.test(r.out), "QUIET_GATE=off skips immediately");

r = await runGate({ TARGET_URL: "" });
ok(r.code === 1, "missing TARGET_URL is a hard misconfiguration error");

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
