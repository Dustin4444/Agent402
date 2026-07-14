// Offline regression test for cert-transparency's crt.sh → certspotter fallback.
// crt.sh is notoriously flaky (routinely cold-times-out, and has multi-minute
// outages where every retry 502s); a live probe hitting one of those windows
// used to fail the endpoint. The handler now retries crt.sh then falls back to
// certspotter so it keeps answering. This pins that behavior by stubbing
// globalThis.fetch (the handler passes ssrfDispatcher, but the call itself is the
// global fetch) — no network, deterministic.
import { NETWORK_TOOLS2 } from "../src/tools/network-kit2.js";

const tool = NETWORK_TOOLS2.find((t) => t.slug === "cert-transparency");
const realFetch = globalThis.fetch;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.error("FAIL -", m); } };

const jsonRes = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const errRes = (status) => ({ ok: false, status, text: async () => "upstream error" });

// A crt.sh row and a certspotter issuance for the same domain.
const CRT_ROWS = [
  { id: 1, serial_number: "AA", issuer_name: "Let's Encrypt", common_name: "a.example.com",
    name_value: "a.example.com\nb.example.com", not_before: "2026-01-01", not_after: "2026-04-01" },
];
const CS_ROWS = [
  { id: "9", cert_sha256: "deadbeef", dns_names: ["a.example.com", "c.example.com"],
    issuer: { name: "C=US, O=Let's Encrypt, CN=R3" }, not_before: "2026-01-01",
    not_after: "2999-01-01" },
];

function stub(handler) { globalThis.fetch = (url) => handler(String(url)); }
async function restore() { globalThis.fetch = realFetch; }

try {
  // 1. crt.sh healthy → served from crt.sh, certspotter never called.
  let csHit = false;
  stub((url) => {
    if (url.includes("crt.sh")) return Promise.resolve(jsonRes(CRT_ROWS));
    if (url.includes("certspotter")) { csHit = true; return Promise.resolve(jsonRes(CS_ROWS)); }
    return Promise.reject(new Error("unexpected host"));
  });
  let r = await tool.handler({ domain: "example.com" });
  ok(r.source === "crt.sh", "crt.sh healthy → source=crt.sh");
  ok(!csHit, "crt.sh healthy → certspotter NOT called (no wasted fallback)");
  ok(r.subdomains.includes("a.example.com") && r.subdomains.includes("b.example.com"), "crt.sh SANs → subdomains");

  // 2. crt.sh 502 on every attempt → falls back to certspotter, returns 200.
  let crtAttempts = 0;
  stub((url) => {
    if (url.includes("crt.sh")) { crtAttempts++; return Promise.resolve(errRes(502)); }
    if (url.includes("certspotter")) return Promise.resolve(jsonRes(CS_ROWS));
    return Promise.reject(new Error("unexpected host"));
  });
  r = await tool.handler({ domain: "example.com" });
  ok(r.source === "certspotter", "crt.sh down → source=certspotter (fallback fired)");
  ok(crtAttempts >= 2, "crt.sh retried before falling back (attempts: " + crtAttempts + ")");
  ok(r.subdomains.includes("c.example.com"), "certspotter dns_names → subdomains");

  // 3. crt.sh cold-times-out first, succeeds on retry → served from crt.sh.
  let n = 0;
  stub((url) => {
    if (url.includes("crt.sh")) { n++; return n === 1 ? Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" })) : Promise.resolve(jsonRes(CRT_ROWS)); }
    return Promise.reject(new Error("certspotter should not be reached"));
  });
  r = await tool.handler({ domain: "example.com" });
  ok(r.source === "crt.sh" && n === 2, "crt.sh cold-first then retry-success → served from crt.sh, no fallback");

  // 4. Both sources down → clean 502 (not a hang, not a 500).
  stub(() => Promise.resolve(errRes(503)));
  let threw = null;
  try { await tool.handler({ domain: "example.com" }); } catch (e) { threw = e; }
  ok(threw && threw.statusCode === 502, "both sources down → 502 (was: " + (threw && threw.statusCode) + ")");

  // 5. certspotter honors includeExpired=false (drops an expired cert).
  stub((url) => url.includes("crt.sh") ? Promise.resolve(errRes(502))
    : Promise.resolve(jsonRes([{ id: "x", cert_sha256: "old", dns_names: ["old.example.com"], not_after: "2000-01-01" }])));
  r = await tool.handler({ domain: "example.com" });
  ok(r.count === 0, "certspotter fallback drops expired cert when includeExpired=false");

  // 6. Missing domain → 400 before any fetch (client error, no fallback).
  let fetched = false;
  stub(() => { fetched = true; return Promise.resolve(jsonRes([])); });
  let bad400 = null;
  try { await tool.handler({}); } catch (e) { bad400 = e; }
  ok(bad400 && bad400.statusCode === 400 && !fetched, "missing domain → 400, no upstream call");
} finally {
  await restore();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
