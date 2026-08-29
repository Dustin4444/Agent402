#!/usr/bin/env node
// The 402 challenge header has a hard ceiling that is NOT ours to set.
//
// Measured 2026-08-29 against an external seller: a stock x402 client echoes
// every extension it is offered straight back into the payment payload -
// `info` AND the full JSON `schema` for each - so a rich 402 becomes a rich
// REQUEST header on the buyer's retry. That seller's challenge produced a
// 13,680-byte payment header; their own edge answered 431 Request Header
// Fields Too Large, and their facilitator rejected the payload before that.
// Their endpoint is effectively unpayable by a stock client.
//
// Ours is smaller but the same shape: /v1/metered was 10,723 bytes on the day
// this was written, of which one extension was 3,215. Common proxy limits sit
// at 8 KB per header and 16 KB total, so a buyer echoing our challenge is not
// far from the same cliff. This test is the ratchet-stop: the challenge may
// not grow past a size a buyer can send back.
import { readFileSync } from "node:fs";

const TARGET = process.env.TARGET_URL || "http://127.0.0.1:3000";
// A buyer's retry carries roughly the challenge plus its own signature and
// authorization (~700 bytes measured), so budget below the common 8 KB limit.
const MAX_HEADER_BYTES = Number(process.env.MAX_CHALLENGE_HEADER_BYTES) || 12_000;
const WARN_HEADER_BYTES = Number(process.env.WARN_CHALLENGE_HEADER_BYTES) || 9_000;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

const routes = (process.env.CHALLENGE_ROUTES || "/api/hash,/v1/metered/chat/completions").split(",").map((r) => r.trim()).filter(Boolean);
let worst = { route: null, bytes: 0 };
for (const route of routes) {
  let res;
  try {
    res = await fetch(`${TARGET}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(20000) });
  } catch (e) { ok(false, `${route}: could not be probed (${String(e.message).slice(0, 60)})`); continue; }
  if (res.status !== 402) { console.log(`skip - ${route} answered ${res.status}, not a paywalled 402`); continue; }
  const h = res.headers.get("payment-required") || "";
  if (!h) { ok(false, `${route}: a 402 with no PAYMENT-REQUIRED header`); continue; }
  const bytes = h.length;
  if (bytes > worst.bytes) worst = { route, bytes };
  ok(bytes <= MAX_HEADER_BYTES, `${route}: challenge header ${bytes} bytes (ceiling ${MAX_HEADER_BYTES}; a buyer echoes this back and proxies refuse oversized headers)`);
  if (bytes > WARN_HEADER_BYTES && bytes <= MAX_HEADER_BYTES) console.log(`   WARNING: ${route} is ${bytes} bytes, past the ${WARN_HEADER_BYTES} watch line - trim an extension before adding a rail`);
}
console.log(`\nlargest challenge: ${worst.route || "(none probed)"} at ${worst.bytes} bytes`);
console.log(`${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
