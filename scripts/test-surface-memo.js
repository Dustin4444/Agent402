// Server-side memo on SQLite-built public surfaces (2026-09-25 stall audit).
// Booted: a repeat read inside the window returns the SAME body (built once),
// a status probe write drops the status snapshot, a ?seller= marketplace view
// is never cached. From source: the per-chain ledger query and the settled-host
// set keyed on the leaderboard rows array.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFreePort } from "./lib/free-port.js";

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); console.log(`ok - ${m}`); };
const TOKEN = "surface-memo-operator-token-0123456789";

// --- from source
const ledger = readFileSync(new URL("../src/revenue-ledger.js", import.meta.url), "utf8");
ok(!/FROM transfers WHERE wallet = \?"/.test(ledger) && (ledger.match(/rows\.all\(chain, wallet\)/g) || []).length === 2, "ledger series read one chain's rows at a time (was every EVM row once per chain)");
const idx = readFileSync(new URL("../src/x402-index.js", import.meta.url), "utf8");
ok(/settledHostsMemo\.get\(rows\)/.test(idx) && /settledHostsOf\(getLeaderboardSnapshot\(\)\)\.has\(host\)/.test(idx), "originHasSettled is a set lookup memoized on the leaderboard rows array");

// --- booted
const port = await getFreePort();
const dir = mkdtempSync(join(tmpdir(), "a402-memo-"));
const proc = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, FREE_MODE: "true", PORT: String(port), X402_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false", MPP_INDEX_CRAWL: "off", REDIS_URL: "", AGENT402_OPERATOR_TOKEN: TOKEN, STATUS_DB_PATH: join(dir, "status.db") },
  stdio: ["ignore", "ignore", "inherit"],
});
const base = `http://127.0.0.1:${port}`;
try {
  let up = false;
  for (let i = 0; i < 120 && !up; i++) { try { up = (await fetch(`${base}/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  ok(up, "server booted");
  const j = async (p) => (await fetch(`${base}${p}`)).json();
  const d1 = await j("/api/revenue/daily"), d2 = await j("/api/revenue/daily");
  ok(d1.asOf && d1.asOf === d2.asOf, `a repeat /api/revenue/daily inside the window is the memoized body (asOf ${d1.asOf})`);
  const s1 = await j("/api/status"); await new Promise((r) => setTimeout(r, 20)); const s2 = await j("/api/status");
  ok(s1.generatedAt === s2.generatedAt, "a repeat /api/status inside 30 s is the memoized snapshot");
  const w = await fetch(`${base}/api/status/probe`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ source: "test", components: { api: { ok: true } } }) });
  ok(w.status === 200, `probe write accepted (${w.status})`);
  const s3 = await j("/api/status");
  ok(s3.generatedAt !== s1.generatedAt, "a probe write drops the memo, so the next read is rebuilt");
  const m1 = await (await fetch(`${base}/marketplace`)).text(), m2 = await (await fetch(`${base}/marketplace`)).text();
  ok(m1.length > 1000 && m1 === m2, "the rendered marketplace is served from the memo inside the window");
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/req\.query\.seller \? render\(\) : memoSurface\(/.test(src), "a ?seller= chain view is rendered per request, never keyed into the memo");
} finally {
  proc.kill("SIGKILL");
}
console.log(`test-surface-memo: ${n} passed`);
