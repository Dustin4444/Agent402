// Regenerate the SOR proven-seller seed (src/sor-seed-sellers.json).
//
//   TARGET_URL=https://agent402.tools node scripts/gen-sor-seed.js
//
// The seed is the DURABLE floor for the SOR external-router reliability gate: a
// committed origin->callsSettled map of sellers with proven on-chain settled
// volume, from a real /api/leaderboard scan. The resolver seeds its
// settled-by-origin map from this file, then overlays the live (or /data
// warm-started) leaderboard snapshot, taking the max per origin. So even on a
// brand-new clone with an empty /data volume, or the first request after a
// deploy before any scan lands, the resolver still has a proven-seller allowlist
// and never goes blind. Live data always supersedes when it is warmer/higher.
// Regenerate periodically so newly-proven sellers join the floor.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const TARGET = (process.env.TARGET_URL || "https://agent402.tools").replace(/\/$/, "");
const THRESHOLD = Number(process.env.SOR_MIN_SETTLED_TX || "50");
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "sor-seed-sellers.json");

const res = await fetch(`${TARGET}/api/leaderboard`, { signal: AbortSignal.timeout(30000) });
if (!res.ok) { console.error(`leaderboard fetch failed: HTTP ${res.status}`); process.exit(1); }
const data = await res.json();
const rows = Array.isArray(data.leaderboard) ? data.leaderboard : [];
if (!rows.length) { console.error("leaderboard is empty (warming?) — retry once it is warm"); process.exit(1); }

const norm = (u) => String(u || "").replace(/\/+$/, "").toLowerCase();
const origins = {};
for (const row of rows) {
  const os = Array.isArray(row.origins) ? row.origins : [row.homepage];
  const cs = Number(row.callsSettled) || 0;
  for (const o of os) { if (o) origins[norm(o)] = Math.max(origins[norm(o)] || 0, cs); }
}
// Keep only the proven floor; sub-threshold origins would never pass the gate.
// Drop our own host — the resolver never routes to itself (F4), so it has no
// business in a proven-EXTERNAL-seller seed.
const selfHosts = new Set(["agent402.tools", "www.agent402.tools"]);
const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return ""; } };
const proven = Object.fromEntries(
  Object.entries(origins)
    .filter(([o, c]) => c >= THRESHOLD && !selfHosts.has(hostOf(o)))
    .sort((a, b) => b[1] - a[1]));

const seed = {
  _note: "Proven-seller FLOOR for the SOR reliability gate. Generated from a real /api/leaderboard scan by scripts/gen-sor-seed.js. Used as a baseline the live/persisted leaderboard snapshot is layered onto (max per origin), so the resolver never goes blind on a cold /data volume or right after a deploy. Live data supersedes. Regenerate periodically.",
  asOf: data.asOf || null,
  threshold: THRESHOLD,
  count: Object.keys(proven).length,
  origins: proven,
};
writeFileSync(OUT, JSON.stringify(seed, null, 2) + "\n");
console.log(`wrote ${OUT}: ${seed.count} proven origins (>= ${THRESHOLD}), asOf ${seed.asOf}`);
