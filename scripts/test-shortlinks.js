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
const proc = spawn(process.execPath, ["src/server.js"], { env: { ...process.env, FREE_MODE: "true", PORT: String(port), X402_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off" }, stdio: ["ignore", "ignore", "inherit"] });
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
  const alias = await fetch(`${base}/install.sh`, { redirect: "manual" });
  ok(alias.status === 302 && alias.headers.get("location") === "/install", "/install.sh redirects to /install");
  ok(/^MCP_URL="https:\/\/x\.test\/mcp"$/m.test(installScript("https://x.test/")) && !/x\.test\/\//.test(installScript("https://x.test/")), "base URL trailing slash handled");
} finally { proc.kill("SIGTERM"); }
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
