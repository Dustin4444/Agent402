// Single source of truth for the catalog's TOTAL tool count across every static
// surface (README, wiki, docs, adapters, served-page copy, package descriptions).
// Adding/removing tools used to mean hand-editing ~60 files; now:
//
//   node scripts/sync-count.js          # rewrite the total everywhere it's stale
//   node scripts/sync-count.js --check  # exit 1 if the total is stale (CI guard)
//
// How it stays safe: the catalog has several legitimate counts (total, free/PoW
// tier, pack count). We only ever touch the TOTAL, by an EXACT value replace of
// the previously-documented total → the real one, guarded by digit/comma
// lookarounds so it can never rewrite part of a larger number. The real total
// comes from a booted free-mode server (/health.meta.toolCount); the
// currently-documented total is read from the README H1 (the number right
// before the word "tools", which is unambiguously the total). Runtime surfaces
// (/api/pricing, /openapi.json, docs.js `${catalog.length}`) already derive it
// and are left alone.
//
// Known limitation: the replace is textual and repo-wide, so historical
// narrative (old plan/spec docs quoting a past total) gets rewritten too —
// revert those hunks by hand after a sweep if the old number was the point.
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const CHECK = process.argv.includes("--check");
const PORT = 3199;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = spawn("node", ["src/server.js"], { env: { ...process.env, FREE_MODE: "true", PORT: String(PORT) }, stdio: "ignore" });
try {
  let total = 0;
  for (let i = 0; i < 40; i++) {
    try { total = (await (await fetch(`http://localhost:${PORT}/health`)).json())?.meta?.toolCount || 0; if (total) break; } catch {}
    await sleep(500);
  }
  if (!total) { console.error("sync-count: could not read the tool count from /health"); process.exit(2); }
  const want = total.toLocaleString("en-US"); // "462"

  // The documented total = the number immediately before "tools" in the README
  // H1 (comma-grouped or plain, so it works above and below 1,000).
  const readmeH1 = (readFileSync("README.md", "utf8").split("\n")[0]) || "";
  const documented = (readmeH1.match(/(\d{1,3}(?:,\d{3})*)(?= tools\b)/) || [])[0];
  if (!documented) { console.error("sync-count: no count found in the README H1 to anchor on"); process.exit(2); }

  if (documented === want) {
    console.log(`sync-count: OK — total is in sync (${want}).`);
    process.exit(0);
  }

  // Drift. Replace the exact old total value everywhere (distinct from the other counts).
  // Lookarounds keep the match whole-number: a 3-digit total like "462" must not
  // rewrite the inside of "1,462", "4620" or "3462".
  const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter((f) =>
    /\.(md|json|js|py|txt)$/.test(f) && !f.includes("/dist/") && f !== "package-lock.json");
  const escaped = documented.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = `(?<![\\d,])${escaped}(?![\\d,])`;

  if (CHECK) {
    const hits = files.filter((f) => { try { return new RegExp(pattern).test(readFileSync(f, "utf8")); } catch { return false; } });
    console.error(`sync-count: total is STALE — documented ${documented}, catalog has ${want}. ${hits.length} file(s) affected. Run \`node scripts/sync-count.js\`.`);
    process.exit(1);
  }
  let changed = 0;
  for (const f of files) {
    let src; try { src = readFileSync(f, "utf8"); } catch { continue; }
    const out = src.replace(new RegExp(pattern, "g"), want);
    if (out !== src) { writeFileSync(f, out); changed++; }
  }
  console.log(`sync-count: total ${documented} → ${want} across ${changed} file(s).`);
} finally {
  srv.kill("SIGKILL");
}
