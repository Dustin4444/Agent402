// Secretless browser/media worker plumbing + isolation invariants (audit
// F02/F04/F06). Offline: exercises the worker's auth/dispatch/secret-guard and
// the API-side client round-trip WITHOUT launching Chromium or ffmpeg (a stub
// server stands in for the tool handlers). The real render/media-through-worker
// path is verified live with a paid smoke once the worker service is deployed.
//
//   node scripts/test-worker-isolation.js
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };
const listen = (app) => new Promise((res) => { const s = app.listen(0, () => res(s)); });

// --- 1. The real worker: auth + dispatch (no Chromium/ffmpeg needed) ----------
{
  process.env.RENDER_WORKER_TOKEN = "test-worker-token";
  const { app, HANDLERS } = await import("../worker/server.js");
  const srv = await listen(app);
  const base = `http://localhost:${srv.address().port}`;

  ok(Object.keys(HANDLERS).includes("render") && Object.keys(HANDLERS).includes("media-info"), "worker exposes render + media handlers");
  const health = await (await fetch(`${base}/health`)).json();
  ok(health.ok === true && Array.isArray(health.tools), "worker /health reports ok + tool list");

  const noTok = await fetch(`${base}/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: "render", input: { url: "https://x.com" } }) });
  ok(noTok.status === 401, "worker rejects a /call with no bearer token (401)");
  const badTok = await fetch(`${base}/call`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer wrong" }, body: JSON.stringify({ slug: "render", input: {} }) });
  ok(badTok.status === 401, "worker rejects a wrong bearer token (401)");
  const unknown = await fetch(`${base}/call`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer test-worker-token" }, body: JSON.stringify({ slug: "not-a-tool", input: {} }) });
  ok(unknown.status === 404, "worker 404s an unknown tool slug");
  srv.close();
  delete process.env.RENDER_WORKER_TOKEN;
}

// --- 2. The API-side client: round-trip against a stub worker -----------------
{
  const stub = express();
  stub.use(express.json());
  let sawAuth = null, sawBody = null;
  stub.post("/call", (req, res) => {
    sawAuth = req.headers.authorization; sawBody = req.body;
    if (req.body.slug === "render") return res.json({ url: req.body.input.url, markdown: "# hi", untrustedContent: true });
    if (req.body.slug === "screenshot") return res.json({ __binary: Buffer.from("PNGBYTES").toString("base64"), contentType: "image/png" });
    if (req.body.slug === "boom") return res.status(502).json({ error: "upstream boom" });
    res.status(404).json({ error: "unknown" });
  });
  const srv = await listen(stub);
  process.env.RENDER_WORKER_URL = `http://localhost:${srv.address().port}`;
  process.env.RENDER_WORKER_TOKEN = "client-tok";
  const { workerEnabled, runOnWorker } = await import("../src/worker-client.js");

  ok(workerEnabled() === true, "workerEnabled() true when RENDER_WORKER_URL set");
  const r = await runOnWorker("render", { url: "https://ex.com" });
  ok(r.markdown === "# hi" && r.untrustedContent === true, "client returns the worker's JSON result");
  ok(sawAuth === "Bearer client-tok", "client sends the worker bearer token");
  ok(sawBody?.slug === "render" && sawBody?.input?.url === "https://ex.com", "client posts {slug, input} correctly");
  const shot = await runOnWorker("screenshot", { url: "https://ex.com" });
  ok(Buffer.isBuffer(shot.__binary) && shot.__binary.toString() === "PNGBYTES" && shot.contentType === "image/png", "client decodes a binary (__binary) result to a Buffer");
  let threw = null;
  try { await runOnWorker("boom", {}); } catch (e) { threw = e; }
  ok(threw && threw.statusCode === 502 && /boom/.test(threw.message), "client propagates a worker error with its status code");
  srv.close();
  delete process.env.RENDER_WORKER_URL;
  delete process.env.RENDER_WORKER_TOKEN;
}

// --- 3. The boot guard: a forbidden secret in the worker's env aborts start ---
{
  const child = spawn(process.execPath, [join(ROOT, "worker", "server.js")], {
    env: { ...process.env, WALLET_ADDRESS: "0xdeadbeef", PORT: "0", RENDER_WORKER_URL: "", RENDER_WORKER_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  const code = await new Promise((res) => child.on("exit", res));
  ok(code === 1, `worker REFUSES to boot with a payment secret in env (exit ${code})`);
  ok(/secret env present in the SECRETLESS worker/i.test(out) && /WALLET_ADDRESS/.test(out), "boot guard names the offending secret and fails loud");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
