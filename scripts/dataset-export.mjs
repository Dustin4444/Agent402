#!/usr/bin/env node
// Pull one recorded day of the ecosystem dataset out of the bucket and write it
// locally, decompressed, ready to stage into Snowflake or Unity Catalog.
//
// The snapshot writer records days; this reads one back. Deliberately separate:
// the writer runs in production on a schedule and must never depend on anyone
// being at a terminal, and the exporter is a local operator tool that must
// never be able to write.
//
//   BACKUP_S3_* in env (or: railway variables -s agent402 -e production --json)
//   node scripts/dataset-export.mjs --day 2026-09-11 --out ./export
//   node scripts/dataset-export.mjs --latest --out ./export
//
// Prints the manifest's own row counts and columnFill beside what actually
// landed on disk, because "the file exists" is not the same as "the day has
// data in it" - a column of nulls is exactly what columnFill is there to show.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { getObject, backupConfigured } from "../src/backup.js";
import { DATASET_PREFIX } from "../src/dataset-snapshot.js";

const TABLES = ["sellers", "routes", "settlement_base", "settlement_solana", "settlement_mpp"];
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };

if (!backupConfigured()) {
  console.error("BACKUP_S3_* not set. Pull them with:\n  railway variables -s agent402 -e production --json");
  process.exit(2);
}

let day = arg("day");
if (!day && process.argv.includes("--latest")) {
  // Walk back from today rather than listing: the bucket credential may not
  // carry ListBucket at this prefix, which is the same thing that broke the
  // writer's first live run.
  for (let i = 0; i < 30 && !day; i++) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    if (await getObject(`${DATASET_PREFIX}/dt=${d}/manifest.json`)) day = d;
  }
  if (!day) { console.error("no recorded day in the last 30"); process.exit(1); }
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(day || "")) {
  console.error("need --day YYYY-MM-DD or --latest");
  process.exit(2);
}

const outDir = join(arg("out", "./export"), `dt=${day}`);
mkdirSync(outDir, { recursive: true });

const manifestRaw = await getObject(`${DATASET_PREFIX}/dt=${day}/manifest.json`);
if (!manifestRaw) { console.error(`no recorded day at dt=${day}`); process.exit(1); }
const manifest = JSON.parse(manifestRaw.toString("utf8"));
writeFileSync(join(outDir, "manifest.json"), manifestRaw);

console.log(`dt=${day}  written ${manifest.writtenAt}${manifest.partial ? `  PARTIAL: ${Object.keys(manifest.partial).join(",")}` : ""}`);
console.log("");

let total = 0;
for (const t of TABLES) {
  const gz = await getObject(`${DATASET_PREFIX}/dt=${day}/${t}.ndjson.gz`);
  if (!gz) { console.log(`  ${t.padEnd(18)} MISSING`); continue; }
  const text = gunzipSync(gz).toString("utf8");
  writeFileSync(join(outDir, `${t}.ndjson`), text);
  const lines = text ? text.trimEnd().split("\n").length : 0;
  total += lines;

  // Columns that are present but empty are the failure this is here to expose.
  const fill = manifest.tables?.[t]?.columnFill || {};
  const empty = Object.entries(fill).filter(([, v]) => v === 0).map(([k]) => k);
  console.log(`  ${t.padEnd(18)} ${String(lines).padStart(7)} rows  ${(text.length / 1e6).toFixed(2)}MB${empty.length ? `  EMPTY COLUMNS: ${empty.join(", ")}` : ""}`);
}

console.log(`\n${total} rows -> ${outDir}`);
console.log(`\nProvenance: ${manifest.provenance}`);
console.log(`Privacy:    ${manifest.privacy}`);
console.log(`Excluded:   ${Object.keys(manifest.excludedThirdParty || {}).join(", ") || "(none)"}`);
console.log(`\nLoad it: docs/dataset-marketplace/{snowflake,databricks}.sql`);
