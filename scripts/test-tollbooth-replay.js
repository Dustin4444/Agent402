// Tollbooth atomic replay + origin binding (audit F05 / F18). The Cloudflare
// Worker's KV replay claim was get-then-put (eventually consistent), so
// concurrent duplicate PoW solutions across isolates could both pass. The fix is
// a Durable Object claim — atomic because a DO instance serializes all requests
// to one id. And PoW proofs now bind the canonical ORIGIN + METHOD, not just
// path, so a proof can't transfer across sites/methods.
//
//   node scripts/test-tollbooth-replay.js
import { TollboothReplay, durableObjectStore } from "../tollbooth/worker.js";
import { createPow } from "../tollbooth/pow.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

// Fake Durable Object state: a per-id storage map. The runtime guarantees one
// DO id processes requests serially, which is what makes the get-then-put here
// atomic; this fake preserves that (awaited calls run in order).
function makeState() {
  const m = new Map();
  return { storage: {
    async get(k) { return m.get(k); },
    async put(k, v) { m.set(k, v); },
    async setAlarm() { /* */ },
    async deleteAll() { m.clear(); },
  } };
}

// --- F05: the DO grants a token exactly once ---------------------------------
{
  const doInst = new TollboothReplay(makeState());
  const claim = () => doInst.fetch(new Request("https://r/claim", { method: "POST", body: JSON.stringify({ expMs: Date.now() + 60000 }) })).then((r) => r.json());
  const first = await claim();
  const second = await claim();
  ok(first.granted === true, "first claim of a token is granted");
  ok(second.granted === false, "second claim of the SAME token is denied (single-use)");
}

// NOTE ON CONCURRENCY: the "100 concurrent claims -> exactly 1 grant" property
// is provided by the Durable Object RUNTIME, which serializes all requests to a
// single DO id through its input gate. It is NOT a property of the get-then-put
// code alone (which, run truly-concurrently WITHOUT that gate, would race — the
// exact failure the KV store had). It therefore can only be validated in the
// real Cloudflare environment (the audit's "100 concurrent across multiple
// Worker locations" acceptance). Here we lock the SEQUENTIAL single-use logic
// (above) and the adapter routing (below); the runtime provides the atomicity.

// --- F05: the durableObjectStore adapter routes per-token and returns boolean --
{
  const instances = new Map();
  const namespace = {
    idFromName: (k) => k, // identity id for the test
    get: (id) => ({ fetch: (url, init) => (instances.get(id) || instances.set(id, new TollboothReplay(makeState())).get(id)).fetch(new Request(url, init)) }),
  };
  const store = durableObjectStore(namespace);
  ok((await store.claim("tokA", Date.now() + 60000)) === true, "adapter: first claim of tokA granted");
  ok((await store.claim("tokA", Date.now() + 60000)) === false, "adapter: replay of tokA denied");
  ok((await store.claim("tokB", Date.now() + 60000)) === true, "adapter: a DIFFERENT token (tokB) is independent");
}

// --- F18: a PoW proof is bound to its resource (origin + method + path) --------
{
  const pow = createPow({ secret: "test-secret", difficulty: 1 });
  // Mint + solve a challenge for one origin-bound resource.
  const resA = "GET https://a.example/report";
  const ch = pow.challenge(resA, 1);
  // brute a tiny nonce (difficulty 1)
  const { createHash } = await import("node:crypto");
  const [chal] = ch.token.split(".");
  let nonce = 0;
  while (require_bits(createHash("sha256").update(`${chal}:${nonce}`).digest()) < 1) nonce++;
  const solved = `${ch.token}:${nonce}`;
  ok(pow.verify(solved, resA).ok === true, "a solved proof verifies against its own origin+method+path");
  ok(pow.verify(solved, "GET https://b.example/report").reason === "wrong resource", "the SAME proof is rejected for a different ORIGIN");
  ok(pow.verify(solved, "POST https://a.example/report").reason === "wrong resource", "the SAME proof is rejected for a different METHOD");
}
function require_bits(buf) { let bits = 0; for (const byte of buf) { if (byte === 0) { bits += 8; continue; } let m = 0x80; while (m && !(byte & m)) { bits++; m >>= 1; } break; } return bits; }

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
