#!/usr/bin/env node
// Capture every deterministic tool's EXACT output, so a dependency bump can be
// diffed instead of trusted.
//
//   FREE_MODE=true PORT=3200 node src/server.js
//   TARGET_URL=http://127.0.0.1:3200 node scripts/golden-capture.js > /tmp/golden-before.json
//   ...change a dependency, reboot...
//   TARGET_URL=http://127.0.0.1:3200 node scripts/golden-capture.js > /tmp/golden-after.json
//   node scripts/golden-capture.js --diff /tmp/golden-before.json /tmp/golden-after.json
//
// WHY: "the test suite is green" does not mean "the output is the same". A
// parsing library that starts returning an empty array for one field still
// answers its own example, still has the documented keys, and still passes
// every shape check - it just silently stops doing the job the buyer pays for.
// That exact failure has shipped here before via a major bump of an OCR
// dependency. The only thing that catches it is comparing the bytes.
//
// NON-DETERMINISTIC tools (uuid, time, random, anything with live upstream) are
// listed and compared on SHAPE only - their values legitimately differ per call,
// so demanding equality would produce noise that trains you to ignore the diff.
const TARGET = (process.env.TARGET_URL || "http://127.0.0.1:3200").replace(/\/+$/, "");

// Values change every call by design; compare key structure, never bytes.
const NONDET = /^(uuid|ulid|nanoid|password|random|token-gen|time|time-now|timezone-convert|date-diff|business-days|cron-next|add-time|duration|jwt-sign|totp|hmac-time|snowflake)/;

const shape = (v) => {
  if (v === null) return "null";
  if (Array.isArray(v)) return `[${v.length ? shape(v[0]) : ""}]`;
  if (typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${k}:${shape(v[k])}`).join(",")}}`;
  return typeof v;
};

if (process.argv[2] === "--diff") {
  const { readFileSync } = await import("node:fs");
  const A = JSON.parse(readFileSync(process.argv[3], "utf8"));
  const B = JSON.parse(readFileSync(process.argv[4], "utf8"));
  const slugs = [...new Set([...Object.keys(A), ...Object.keys(B)])].sort();
  let same = 0, shapeOnly = 0, diff = [], missing = [];
  for (const s of slugs) {
    const a = A[s], b = B[s];
    if (!a || !b) { missing.push(s); continue; }
    if (a.status !== b.status) { diff.push(`${s}: STATUS ${a.status} -> ${b.status}`); continue; }
    if (a.nondet || b.nondet) {
      if (a.shape !== b.shape) diff.push(`${s}: SHAPE ${a.shape} -> ${b.shape}`);
      else shapeOnly++;
      continue;
    }
    if (a.body !== b.body) {
      const pa = (a.body || "").length, pb = (b.body || "").length;
      diff.push(`${s}: OUTPUT CHANGED (${pa}b -> ${pb}b)\n     before: ${String(a.body).slice(0, 150)}\n     after:  ${String(b.body).slice(0, 150)}`);
    } else same++;
  }
  console.log(`identical: ${same}   shape-only(nondet): ${shapeOnly}   CHANGED: ${diff.length}   missing-from-one-side: ${missing.length}`);
  if (missing.length) console.log(`\nMISSING: ${missing.join(", ")}`);
  if (diff.length) { console.log("\n--- DIFFERENCES ---"); diff.forEach((d) => console.log("  " + d)); }
  process.exit(diff.length || missing.length ? 1 : 0);
}

// Examples live in the OpenAPI spec, NOT in /api/pricing — the same source
// scripts/test-all.js drives from. Reading pricing instead produced 183 of 222
// tools answering 400, i.e. a "baseline" of error messages that would have
// compared equal before and after and proven exactly nothing.
const spec = await (await fetch(`${TARGET}/openapi.json`)).json();
const pricing = await (await fetch(`${TARGET}/api/pricing`)).json();
const payable = new Set(pricing.endpoints.filter((e) => e.computePayable === true).map((e) => e.path));
const out = {};
for (const [path, methods] of Object.entries(spec.paths)) {
  if (!payable.has(path)) continue;                // pure-CPU only: no upstream, no egress
  const method = Object.keys(methods).find((m) => ["get", "post"].includes(m));
  if (!method) continue;
  const op = methods[method];
  if (((op.tags && op.tags[0]) || "") === "workflows") continue;
  const slug = path.replace(/^\/api\//, "");
  let url = `${TARGET}${path}`, init = {};
  if (method === "get") {
    const qs = new URLSearchParams();
    for (const prm of op.parameters ?? []) {
      if (prm.example !== undefined) qs.set(prm.name, typeof prm.example === "string" ? prm.example : JSON.stringify(prm.example));
    }
    if ([...qs].length) url += `?${qs}`;
  } else {
    init = { method: "POST", headers: { "content-type": "application/json" },
             body: JSON.stringify(op.requestBody?.content?.["application/json"]?.example ?? {}) };
  }
  if (/\/api\/memory/.test(path)) url += (url.includes("?") ? "&" : "?") + "ns=golden";
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(25000) });
    const text = await r.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
    out[slug] = {
      status: r.status,
      nondet: NONDET.test(slug),
      shape: shape(parsed),
      body: typeof parsed === "string" ? parsed.slice(0, 4000) : JSON.stringify(parsed).slice(0, 4000),
    };
  } catch (err) { out[slug] = { status: "ERR", nondet: false, shape: "err", body: String(err.message) }; }
}
console.log(JSON.stringify(out, null, 0));
