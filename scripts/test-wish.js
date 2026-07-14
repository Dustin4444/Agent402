// Offline unit tests for the agent wish loop (src/wish.js): capture demand
// for tools we don't have instead of losing it on a one-shot buyer's exit.
// Pure module tests — no server boot, no network. Each logical section gets
// its own throwaway JSONL file via __testSetFilePath so rate-limit buckets
// and cluster state never leak between sections.
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordWish, getWishesAggregate, WISH_THRESHOLD,
  __testSetFilePath, __testSetLineCap, __testState,
} from "../src/wish.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const throws = (fn) => { try { fn(); return false; } catch (e) { return e; } };

const tmpFiles = [];
function freshFile(tag) {
  const p = join(tmpdir(), `wish-test-${process.pid}-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  tmpFiles.push(p);
  __testSetFilePath(p);
  return p;
}

// --- basics ---
{
  freshFile("basic");
  const r = recordWish({ need: "convert stl files to obj", source: "api", ip: "10.0.0.1" });
  ok(r.recorded === true && r.cluster.count === 1, `new need → recorded, cluster.count=1 (got ${JSON.stringify(r)})`);
}

// --- validation: 400s ---
{
  freshFile("validation");
  const e1 = throws(() => recordWish({ source: "api", ip: "10.0.0.2" }));
  ok(e1 && e1.statusCode === 400, `missing 'need' throws 400 (got ${e1 && e1.statusCode})`);
  const e2 = throws(() => recordWish({ need: "x", context: 42, source: "api", ip: "10.0.0.2" }));
  ok(e2 && e2.statusCode === 400, `non-string 'context' throws 400 (got ${e2 && e2.statusCode})`);
  const e3 = throws(() => recordWish({ need: "   ", source: "api", ip: "10.0.0.2" }));
  ok(e3 && e3.statusCode === 400, `whitespace-only 'need' throws 400 (got ${e3 && e3.statusCode})`);
}

// --- caps: need capped at 500, context capped at 300, silently truncated (not rejected) ---
{
  const file = freshFile("caps");
  recordWish({ need: "n".repeat(600), context: "c".repeat(400), source: "api", ip: "10.0.0.3" });
  const line = JSON.parse(readFileSync(file, "utf8").trim().split("\n")[0]);
  ok(line.need.length === 500, `need is capped at 501 chars (got ${line.need.length})`);
  ok(line.context.length === 300, `context is capped at 300 chars (got ${line.context.length})`);
}

// --- dedup / clustering: normalization collapses case + whitespace variants ---
{
  freshFile("dedup");
  recordWish({ need: "  Convert   STL to OBJ ", source: "api", ip: "10.0.0.4" });
  const r2 = recordWish({ need: "convert stl to obj", source: "mcp", ip: "10.0.0.5" });
  ok(r2.cluster.count === 2, `case/whitespace variants collapse into one cluster (got count=${r2.cluster.count})`);
  const agg = getWishesAggregate();
  ok(agg.distinctClusters === 1, `dedup: exactly one distinct cluster (got ${agg.distinctClusters})`);
  ok(agg.clusters[0].sources.api === 1 && agg.clusters[0].sources.mcp === 1, `sources breakdown attributes each call correctly (got ${JSON.stringify(agg.clusters[0].sources)})`);
}

// --- rate limit: 10/IP/hour, find-miss exempt ---
{
  freshFile("ratelimit-ip");
  const ip = "10.0.1.1";
  let allOk = true;
  for (let i = 0; i < 10; i++) {
    const r = recordWish({ need: `need number ${i}`, source: "api", ip });
    if (!r.recorded) allOk = false;
  }
  ok(allOk, "10 wishes/IP/hour: first 10 calls all succeed");
  const e = throws(() => recordWish({ need: "need number 11", source: "api", ip }));
  ok(e && e.statusCode === 429, `11th wish from same IP within the hour throws 429 (got ${e && e.statusCode})`);
  const fm = recordWish({ need: "need number 12", source: "find-miss", ip });
  ok(fm.recorded === true, "find-miss source is exempt from the per-IP rate limit even after it's exhausted");
}

// --- rate limit: 100/day global, applies across distinct IPs ---
{
  freshFile("ratelimit-global");
  for (let i = 0; i < 100; i++) {
    recordWish({ need: `global need ${i}`, source: "api", ip: `10.0.2.${i}` });
  }
  const e = throws(() => recordWish({ need: "global need 101", source: "api", ip: "10.0.2.101" }));
  ok(e && e.statusCode === 429, `101st wish (new IP) throws 429 once the 100/day global cap is hit (got ${e && e.statusCode})`);
}

// --- auto-issue threshold: loud log once, not repeated ---
{
  freshFile("threshold");
  const originalWarn = console.warn;
  const logs = [];
  console.warn = (...args) => logs.push(args.join(" "));
  try {
    for (let i = 0; i < WISH_THRESHOLD; i++) {
      recordWish({ need: "add a currency converter for gold", source: "api", ip: `10.0.3.${i}` });
    }
  } finally {
    console.warn = originalWarn;
  }
  const hits = logs.filter((l) => l.includes("[wish-threshold]"));
  ok(hits.length === 1, `threshold log fires exactly once at count=${WISH_THRESHOLD} (got ${hits.length} logs: ${JSON.stringify(logs)})`);
  const agg = getWishesAggregate();
  const row = agg.clusters.find((c) => c.text.includes("currency converter"));
  ok(row && row.issueOpened === true, `cluster carries issueOpened:true after crossing the threshold (got ${JSON.stringify(row)})`);
}

// --- file-line cap: accept + count clusters, stop appending raw lines, never crash ---
{
  freshFile("filecap");
  __testSetLineCap(3);
  try {
    for (let i = 0; i < 5; i++) {
      const r = recordWish({ need: `capped need ${i}`, source: "api", ip: `10.0.4.${i}` });
      ok(r.recorded === true, `recordWish never throws once the file cap is hit (call ${i})`);
    }
  } finally {
    __testSetLineCap(); // restore default for later sections
  }
  const state = __testState();
  ok(state.lineCount === 3 && state.capReached === true, `file cap stops raw appends at 3 lines (got lineCount=${state.lineCount}, capReached=${state.capReached})`);
  const agg = getWishesAggregate();
  ok(agg.distinctClusters === 5, `clusters still tracked in memory past the file cap (got ${agg.distinctClusters})`);
}

// --- /api/wishes aggregate: shape + no raw context + esc'd text ---
{
  freshFile("aggregate-shape");
  recordWish({ need: "<script>alert(1)</script> pdf splitter", context: "super secret internal detail", source: "api", ip: "10.0.5.1" });
  const agg = getWishesAggregate();
  const row = agg.clusters[0];
  const keys = Object.keys(row).sort();
  ok(JSON.stringify(keys) === JSON.stringify(["count", "firstSeen", "issueOpened", "lastSeen", "sources", "text"]), `aggregate row has exactly the documented keys, no raw context (got ${keys.join(",")})`);
  ok(!("context" in row), "aggregate row never carries a raw context field");
  ok(row.text.includes("&lt;script&gt;") && !row.text.includes("<script>"), `aggregate text is esc()'d (got ${row.text})`);
  ok(typeof row.firstSeen === "string" && typeof row.lastSeen === "string" && !Number.isNaN(Date.parse(row.firstSeen)), "firstSeen/lastSeen are ISO timestamps");
}

// cleanup: best-effort remove every scratch file this run created.
for (const f of tmpFiles) {
  try { if (existsSync(f)) unlinkSync(f); } catch { /* best-effort */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
