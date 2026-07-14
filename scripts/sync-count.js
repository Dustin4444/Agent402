// Single source of truth for the catalog's TOTAL tool count across every static
// surface (README, wiki, docs, adapters, served-page copy, package descriptions).
// Adding/removing tools used to mean hand-editing ~60 files; now:
//
//   node scripts/sync-count.js          # rewrite the total everywhere it's stale
//   node scripts/sync-count.js --check  # exit 1 if the total is stale (CI guard)
//
// THE FLOOR (quality-consistency invariant, both modes): the catalog must
// never fall below 400 entries — a drop that size means a kit accidentally
// fell off the build, not a curation decision. Both counts are derived live
// from the booted server (total = /health meta.toolCount, which counts every
// CATALOG route including the pack endpoints; packs = /api/skill-packs.json
// length; tools = total − packs), so the check can't be gamed by editing a
// doc. There is NO upper bound: the catalog grows when a tool is worth
// calling — every addition must answer its own example, be priced to market,
// and be live-verified.
//
// How the sweep stays safe: the catalog has several legitimate counts (total,
// free/PoW tier, pack count). We only ever touch the TOTAL, by an EXACT value
// replace of the previously-documented total → the real one, guarded by
// digit/comma lookarounds so it can never rewrite part of a larger number. The
// currently-documented total is read from the README H1 (the number right
// before the word "tools", which is unambiguously the total). Runtime surfaces
// (/api/pricing, /openapi.json, docs.js `${catalog.length}`) already derive it
// and are left alone.
//
// Known limitation: the replace is textual and repo-wide, so historical
// narrative (old plan/spec docs quoting a past total) gets rewritten too —
// revert those hunks by hand after a sweep if the old number was the point.
// Also audit for non-count matches (SVG coordinates, decimals, addresses).
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const CATALOG_FLOOR = 400;

// Returns null when the total is at or above the floor, else the CI failure
// message. Exported (and main() gated below) so the assertion is unit-testable
// without booting the server: floorViolation(399) must return the message.
export function floorViolation(total) {
  if (total >= CATALOG_FLOOR) return null;
  return `Catalog fell below the ${CATALOG_FLOOR}-entry floor (got ${total}) — a kit is probably missing.`;
}

async function main() {
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

    // THE FLOOR — enforced before any sweep/check of doc surfaces, in both
    // modes (never sweep a broken catalog's numbers into the docs).
    let packs = 0;
    try {
      const sp = await (await fetch(`http://localhost:${PORT}/api/skill-packs.json`)).json();
      packs = (sp?.packs || []).length;
    } catch {}
    if (!packs) { console.error("sync-count: could not read the pack count from /api/skill-packs.json"); process.exit(2); }
    const violation = floorViolation(total);
    if (violation) { console.error(violation); process.exit(1); }

    const want = total.toLocaleString("en-US"); // "500"

    // The documented total = the number immediately before "tools" in the README
    // H1 (comma-grouped or plain, so it works above and below 1,000).
    const readmeH1 = (readFileSync("README.md", "utf8").split("\n")[0]) || "";
    const documented = (readmeH1.match(/(\d{1,3}(?:,\d{3})*)(?= tools\b)/) || [])[0];
    if (!documented) { console.error("sync-count: no count found in the README H1 to anchor on"); process.exit(2); }

    if (documented === want) {
      console.log(`sync-count: OK — total is in sync (${want} = ${total - packs} tools + ${packs} skill packs, above the ${CATALOG_FLOOR}-entry floor).`);
      process.exit(0);
    }

    // Drift. Replace the exact old total value everywhere (distinct from the other counts).
    // Lookarounds keep the match whole-number: a 3-digit total like "500" must not
    // rewrite the inside of "1,500", "5000" or "3500".
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
