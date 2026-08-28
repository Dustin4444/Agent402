#!/usr/bin/env node
// Dev shortlinks (/claude, /cursor, ... -> the page that answers "how do I use
// this from X") and the /install script. Boots a free server. In CI.
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { getFreePort } from "./lib/free-port.js";
import { SHORTLINKS, installScript } from "../src/shortlinks.js";
import { headingId } from "../src/guides.js";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL: ${m}`); } };
const port = await getFreePort();
const base = `http://127.0.0.1:${port}`;
const proc = spawn(process.execPath, ["src/server.js"], { env: { ...process.env, FREE_MODE: "true", PORT: String(port), BASE_URL: "http://agent402.test", X402_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off" }, stdio: ["ignore", "ignore", "inherit"] });
try {
  let up = false;
  for (let i = 0; i < 120 && !up; i++) { try { up = (await fetch(`${base}/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  ok(up, "server booted");
  // Every shortlink 302s to its target, and the target page answers 200.
  for (const [path, target] of Object.entries(SHORTLINKS)) {
    const r = await fetch(base + path, { redirect: "manual" });
    const loc = r.headers.get("location");
    const page = target.split("#")[0];
    const t = await fetch(base + page, { redirect: "manual" });
    ok(r.status === 302 && loc === target && t.status === 200, `${path} -> ${target} (302; target answers ${t.status})`);
    // A fragment must exist as a heading id on the target page.
    if (target.includes("#")) {
      const html = await t.text();
      ok(html.includes(`id="${target.split("#")[1]}"`), `  anchor #${target.split("#")[1]} exists on ${page}`);
    }
  }
  ok(headingId("Any Anthropic SDK (Messages wire)") === "any-anthropic-sdk-messages-wire" && headingId("Claude Code") === "claude-code", "heading ids are GitHub-style slugs");
  const inst = await fetch(`${base}/install`);
  const body = await inst.text();
  ok(inst.status === 200 && /text\/x-shellscript/.test(inst.headers.get("content-type") || ""), "/install is served as a shell script");
  ok(body.startsWith("#!/bin/sh") && body.includes("set -eu") && body.includes("claude mcp add --transport http agent402") && body.includes("npx agent402-openclaw setup") && body.includes("/guides/agent-hosts"), "script wires Claude Code, points OpenClaw and Cursor at their setup, and links the guide");
  ok(!/^\s*sudo |rm -rf|curl [^|\n]*\| *sh/m.test(body), "script never runs sudo, deletes, or pipes another download into sh");
  const f = join(mkdtempSync(join(tmpdir(), "a402-install-")), "install.sh"); try { writeFileSync(f, body); execFileSync("sh", ["-n", f]); ok(true, "script passes sh -n"); } catch (e) { ok(false, `sh -n: ${e.message}`); }
  // Canonical host: www.<host> is a 301 to the apex with path + query kept; a
  // paying call is never redirected. fetch() drops a caller-set Host header,
  // so this uses node:http, which sends it.
  const { request: httpRequest } = await import("node:http");
  const rawGet = (path, headers) => new Promise((resolve, reject) => { const r = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => { res.resume(); resolve({ status: res.statusCode, location: res.headers.location || null }); }); r.on("error", reject); r.end(); });
  const www = await rawGet("/guides/agent-hosts?x=1", { Host: "www.agent402.test" });
  ok(www.status === 301 && www.location === "http://agent402.test/guides/agent-hosts?x=1", `www host 301s to the apex with the path kept (got ${www.status} ${www.location})`);
  // The host's own /api/index entry (2026-08-28): self:true, built from the
  // ledger + catalog, for the canonical host and the instance's own base URL.
  for (const q of ["agent402.tools", "https://agent402.tools", "agent402.test"]) {
    const me = await (await fetch(`${base}/api/index?seller=${encodeURIComponent(q)}`)).json();
    ok(me.self === true && me.listed === true && me.external && Number.isInteger(me.external.days30.settlements) && me.links?.manifest, `/api/index?seller=${q} answers the host's own entry (self:true, external-only figures, links)`);
  }
  const notMe = await fetch(`${base}/api/index?seller=nobody.example`);
  ok(notMe.status === 404, "an unknown seller still 404s");
  const wwwEvil = await rawGet("/guides/agent-hosts", { Host: "www.evil.example" });
  ok(wwwEvil.status !== 301, `a www Host that is not OUR canonical host is never redirected (no open redirect; got ${wwwEvil.status})`);
  const wwwPaid = await rawGet("/api/uuid", { Host: "www.agent402.test", "payment-signature": "x" });
  ok(wwwPaid.status !== 301, "a request carrying a payment header is never redirected (the header would not survive)");
  // Discovery aliases indexers guess (2026-08-28 sweep), the gateway index, the helpful API 404, the 413 hint.
  for (const p of ["/.well-known/x402.json", "/.well-known/x402-services.json"]) { const r = await fetch(`${base}${p}`); const j = await r.json(); ok(r.status === 200 && j && typeof j === "object" && Object.keys(j).length > 3, `${p} serves the x402 manifest`); }
  for (const p of ["/swagger.json", "/api-docs/openapi.json"]) { const r = await fetch(`${base}${p}`, { redirect: "manual" }); ok(r.status === 301 && r.headers.get("location") === "/openapi.json", `${p} -> /openapi.json`); }
  for (const p of ["/v1", "/v1/info", "/v1/metered"]) { const r = await fetch(`${base}${p}`); const j = await r.json(); ok(r.status === 200 && j.ok === true && /\/v1\/models$/.test(j.models) && /\/v1\/metered\/chat\/completions$/.test(j.metered?.chat), `GET ${p} answers the gateway index`); }
  const gone = await fetch(`${base}/api/soundex`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const goneBody = await gone.json();
  ok(gone.status === 404 && goneBody.error === "not-found" && /retired|closest live tools/.test(goneBody.hint) && /\/api\/find\?q=soundex/.test(goneBody.find) && Array.isArray(goneBody.suggestions), `an unknown /api path answers a helpful 404 with find + suggestions (got ${gone.status})`);
  const big = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "x".repeat(150_000) }] }) });
  const bigBody = await big.json();
  ok(big.status === 413 && /metered/.test(bigBody.hint) && /\/v1\/metered\/chat\/completions$/.test(bigBody.metered), `a 413 on a flat LLM tier points at the metered tier (got ${big.status})`);
  const alias = await fetch(`${base}/install.sh`, { redirect: "manual" });
  ok(alias.status === 302 && alias.headers.get("location") === "/install", "/install.sh redirects to /install");
  ok(/^MCP_URL="https:\/\/x\.test\/mcp"$/m.test(installScript("https://x.test/")) && !/x\.test\/\//.test(installScript("https://x.test/")), "base URL trailing slash handled");
} finally { proc.kill("SIGTERM"); }
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
