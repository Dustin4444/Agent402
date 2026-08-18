// Tempo MPP settlement (src/mpp-tempo.js) — two deliberately separate groups:
//
//   1. Spawns the real server (src/server.js) with TEMPO_API_KEY etc set to
//      prove the 402 challenge-minting wiring — a tempo/charge challenge
//      rides alongside the existing evm one, HMAC-verifies, and disappears
//      entirely when TEMPO_API_KEY is unset (the rollout switch). No relay
//      call is ever made on this path: an unpaid GET never validates or
//      broadcasts anything.
//   2. A standalone in-process Express app driving createTempoGate() with
//      INJECTED validate/broadcast stubs (same pattern mpp-index.js uses for
//      its own injectable `verify`) — proves the settlement-ordering
//      invariant precisely: the route handler always runs before broadcast,
//      a failed handler never triggers a broadcast at all, and a broadcast
//      failure AFTER a successful handler answers 402 (buyer never charged
//      for undelivered settlement), never a 200 with a broken receipt.
//
// Wire-format compatibility with Tempo's REAL relay (api.tempo.xyz) is
// UNVERIFIED until a real TEMPO_API_KEY exists — see the approved plan's
// "Verification" section. This file proves OUR logic, not their API.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import express from "express";
import { Challenge, Credential } from "mppx";
import { createTempoGate, mintTempoChallenge, tempoEnabled } from "../src/mpp-tempo.js";
import { createReplayGuard } from "../src/replay-guard.js";

let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error("FAIL:", m); process.exit(1); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Group 1: real server, challenge-minting wiring only.
// ---------------------------------------------------------------------------
const PORT = 3079;
const FAC_PORT = 3080;
const B = `http://localhost:${PORT}`;
const SECRET = "test-mpp-secret";
const TREASURY = "0x000000000000000000000000000000000000dEaD";
const TEMPO_CURRENCY = "0x2000000000000000000000000000000000000000";

// Minimal stub facilitator — only /supported is ever hit in this file (no
// evm/x402 payment is sent), but the boot /supported guard needs SOMETHING
// reachable or it fail-opens into 500ing every paid route (unrelated to
// Tempo — see src/payments.js's boot guard).
const facilitator = createServer((req, res) => {
  if (req.url === "/supported") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} }));
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => facilitator.listen(FAC_PORT, r));

const bootBaseEnv = {
  ...process.env, PORT: String(PORT), FREE_MODE: "",
  WALLET_ADDRESS: TREASURY, NETWORK: "base",
  FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`,
  MPP_SECRET_KEY: SECRET,
  CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYMENT_NETWORKS: "base",
};

async function waitHealthy() {
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`${B}/health`)).ok) return; } catch {}
    await sleep(500);
  }
  throw new Error("server never became healthy");
}

let proc = spawn("node", ["src/server.js"], {
  env: { ...bootBaseEnv, TEMPO_API_KEY: "test-tempo-key", TEMPO_RECIPIENT_ADDRESS: TREASURY, TEMPO_CURRENCY },
  stdio: "ignore",
});
try {
  await waitHealthy();
  const r402 = await fetch(`${B}/api/uuid`);
  ok(r402.status === 402, "unpaid catalog GET -> 402 (tempo enabled)");
  const wwwAuth = r402.headers.get("www-authenticate");
  ok(!!wwwAuth, "402 carries WWW-Authenticate");
  const challenges = Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": wwwAuth }));
  const tempoCh = challenges.find((c) => c.method === "tempo" && c.intent === "charge");
  ok(!!tempoCh, "a tempo/charge challenge is offered alongside evm");
  // Regression lock for a bug caught live 2026-08-17: mintTempoChallenge()
  // originally formatted amount as a DECIMAL string ("0.001000"), which a
  // real mppx client rejects with "Cannot convert 0.001000 to a BigInt"
  // before it ever reaches signing — no offline test caught it because
  // Group 2 below only ever hand-builds its own (already-correct) fixture
  // credential, never exercises mintTempoChallenge()'s own formatting.
  // Amount must be a raw integer string in base units, same convention the
  // evm challenge's x402 accepts entry already uses.
  ok(/^\d+$/.test(tempoCh?.request?.amount || ""), `tempo challenge amount is a raw integer string, not decimal (got ${tempoCh?.request?.amount})`);
  ok(tempoCh?.request?.amount === "1000", `tempo challenge amount matches the uuid tool's $0.001 price in base units (got ${tempoCh?.request?.amount})`);
  // Wire shape must be what mppx's OWN builder emits (Challenge.fromMethod
  // through the tempo/charge schema): chainId under methodDetails, and NO
  // `decimals` key on the wire (a parsing input the schema strips). The
  // first hand-assembled version shipped `decimals` and no methodDetails.
  ok(tempoCh?.request?.methodDetails?.chainId === 4217, `tempo challenge carries methodDetails.chainId 4217 (Tempo mainnet) (got ${JSON.stringify(tempoCh?.request?.methodDetails)})`);
  ok(!("decimals" in (tempoCh?.request || {})), "tempo challenge request does not carry `decimals` on the wire (schema-canonical shape)");
  ok(Challenge.verify(tempoCh, { secretKey: SECRET }), "tempo challenge id HMAC-verifies");
  ok(Date.parse(tempoCh.expires) > Date.now(), "tempo challenge carries a future expires");
  const evmCh = challenges.find((c) => c.method === "evm" && c.intent === "charge");
  ok(!!evmCh, "the evm challenge is STILL offered (Tempo is additive, no regression)");
} finally {
  proc.kill("SIGKILL");
}

proc = spawn("node", ["src/server.js"], {
  env: { ...bootBaseEnv, TEMPO_API_KEY: "", TEMPO_RECIPIENT_ADDRESS: "", TEMPO_CURRENCY: "" },
  stdio: "ignore",
});
try {
  await waitHealthy();
  const r402 = await fetch(`${B}/api/uuid`);
  const wwwAuth = r402.headers.get("www-authenticate") || "";
  const challenges = wwwAuth ? Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": wwwAuth })) : [];
  ok(!challenges.some((c) => c.method === "tempo"), "no tempo challenge when TEMPO_API_KEY is unset (rollout switch)");
} finally {
  proc.kill("SIGKILL");
}

const PATH_USD_ADDRESS = "0x20c0000000000000000000000000000000000000";
proc = spawn("node", ["src/server.js"], {
  env: { ...bootBaseEnv, TEMPO_API_KEY: "test-tempo-key", TEMPO_RECIPIENT_ADDRESS: TREASURY, TEMPO_CURRENCY: "" },
  stdio: "ignore",
});
try {
  await waitHealthy();
  const r402 = await fetch(`${B}/api/uuid`);
  const wwwAuth = r402.headers.get("www-authenticate");
  const challenges = Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": wwwAuth }));
  const tempoCh = challenges.find((c) => c.method === "tempo");
  ok(!!tempoCh, "tempo challenge still minted with TEMPO_CURRENCY unset (currency now has a default)");
  ok(tempoCh?.request?.currency === PATH_USD_ADDRESS, `defaults to PathUSD's verified address when TEMPO_CURRENCY is unset (got ${tempoCh?.request?.currency})`);
} finally {
  proc.kill("SIGKILL");
}

// TEMPO_CURRENCY is a CSV: one tempo/charge challenge per currency, in order.
// A stock mppx client pays the FIRST tempo challenge (no cross-challenge
// balance check, auto-swap off by default), so ORDER is the operator's
// "which currency do my buyers hold" decision - the ecosystem's is USDC.e.
const USDC_E = "0x20C000000000000000000000b9537d11c60E8b50";
proc = spawn("node", ["src/server.js"], {
  env: { ...bootBaseEnv, TEMPO_API_KEY: "test-tempo-key", TEMPO_RECIPIENT_ADDRESS: TREASURY, TEMPO_CURRENCY: `usdc, ${PATH_USD_ADDRESS}` },
  stdio: "ignore",
});
try {
  await waitHealthy();
  const r402 = await fetch(`${B}/api/uuid`);
  const challenges = Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": r402.headers.get("www-authenticate") }));
  const tempoChs = challenges.filter((c) => c.method === "tempo");
  ok(tempoChs.length === 2, `TEMPO_CURRENCY CSV mints one tempo challenge per currency (got ${tempoChs.length})`);
  ok(tempoChs[0]?.request?.currency === USDC_E && tempoChs[1]?.request?.currency === PATH_USD_ADDRESS, "challenges keep the CSV order (first = preferred), and the 'usdc' alias resolves to USDC.e");
  ok(tempoChs.every((c) => c.request.amount === "1000" && Challenge.verify(c, { secretKey: SECRET })), "both carry the same base-units amount and HMAC-verify");
} finally {
  proc.kill("SIGKILL");
}

// ---------------------------------------------------------------------------
// Group 2: settlement-ordering invariant, in-process, injected validate/broadcast.
// ---------------------------------------------------------------------------
process.env.TEMPO_API_KEY = "test-tempo-key";
process.env.TEMPO_RECIPIENT_ADDRESS = TREASURY;
process.env.TEMPO_CURRENCY = TEMPO_CURRENCY;
ok(tempoEnabled(), "tempoEnabled() true once env is set (test setup sanity check)");

function buildTempoCredential() {
  const challenge = Challenge.from({
    realm: "test.local",
    method: "tempo",
    intent: "charge",
    expires: new Date(Date.now() + 60_000),
    // Raw integer string in base units (50000 = $0.05 at 6 decimals) — NOT a
    // decimal string. Matches mintTempoChallenge()'s real format; a real
    // mppx client throws "Cannot convert 0.05 to a BigInt" on a decimal
    // string (caught live 2026-08-17 against a real client, see mpp-tempo.js).
    request: { amount: "50000", currency: TEMPO_CURRENCY, decimals: 6, recipient: TREASURY },
    secretKey: "irrelevant-to-this-group — validate() is stubbed, HMAC binding is proven in group 1",
  });
  return Credential.serialize({ challenge, payload: { hash: `0x${"ab".repeat(32)}`, type: "hash" } });
}

async function listen(app) {
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

// Case A: valid credential, handler succeeds -> handler runs BEFORE broadcast, receipt attached.
{
  const callOrder = [];
  const app = express();
  app.use(createTempoGate({
    validate: async () => { callOrder.push("validate"); return { ok: true, validation: {} }; },
    broadcast: async () => { callOrder.push("broadcast"); return { ok: true, receipt: { method: "tempo", status: "success", reference: "0xdeadbeef", timestamp: new Date().toISOString() } }; },
  }));
  app.get("/paid", (req, res) => { callOrder.push("handler"); res.status(200).json({ result: "ok" }); });
  const { server, url } = await listen(app);
  const res = await fetch(`${url}/paid`, { headers: { Authorization: buildTempoCredential() } });
  const body = await res.json();
  ok(res.status === 200, "case A: successful handler -> 200");
  ok(body.result === "ok", "case A: original handler body is delivered");
  ok(!!res.headers.get("payment-receipt"), "case A: Payment-Receipt header attached");
  ok(isDeepOrderOk(callOrder, ["validate", "handler", "broadcast"]), `case A: strict order validate -> handler -> broadcast (got ${callOrder.join(",")})`);
  server.close();
}

// Case B: valid credential, handler FAILS -> broadcast never called, buyer never charged.
{
  const callOrder = [];
  let broadcastCalled = false;
  const app = express();
  app.use(createTempoGate({
    validate: async () => { callOrder.push("validate"); return { ok: true, validation: {} }; },
    broadcast: async () => { broadcastCalled = true; return { ok: true, receipt: {} }; },
  }));
  app.get("/paid", (req, res) => { callOrder.push("handler"); res.status(500).json({ error: "upstream broke" }); });
  const { server, url } = await listen(app);
  const res = await fetch(`${url}/paid`, { headers: { Authorization: buildTempoCredential() } });
  const body = await res.json();
  ok(res.status === 500, "case B: handler's own failure status is preserved");
  ok(body.error === "upstream broke", "case B: original error body is delivered");
  ok(broadcastCalled === false, "case B: broadcast is NEVER called after a failed handler (buyer not charged)");
  server.close();
}

// Case C: valid credential, handler succeeds, broadcast FAILS -> 402, not a 200 with a broken receipt.
{
  const app = express();
  app.use(createTempoGate({
    validate: async () => ({ ok: true, validation: {} }),
    broadcast: async () => ({ ok: false, error: "relay temporarily unavailable" }),
  }));
  app.get("/paid", (req, res) => res.status(200).json({ result: "should never reach the buyer" }));
  const { server, url } = await listen(app);
  // This path was SILENT through the first live settlement (2026-08-18): a
  // 23s broadcast failure answered 402 with nothing in our logs. Capture
  // console.warn and require the failure to be logged with per-phase timing.
  const warned = [];
  const origWarn = console.warn;
  console.warn = (...a) => { warned.push(a.join(" ")); };
  let res, body;
  try {
    res = await fetch(`${url}/paid`, { headers: { Authorization: buildTempoCredential() } });
    body = await res.json();
  } finally { console.warn = origWarn; }
  ok(res.status === 402, "case C: broadcast failure after a successful handler -> 402, not 200");
  ok(body.result === undefined, "case C: the handler's original body is discarded, never leaked to the buyer");
  ok(typeof body.reason === "string" && body.reason.includes("unavailable"), "case C: the failure reason is surfaced");
  const line = warned.find((w) => w.includes("[mpp-tempo] broadcast failed"));
  ok(!!line && line.includes("unavailable"), "case C: the broadcast failure is LOGGED with the relay's reason (was a silent 402 before 2026-08-18)");
  ok(!!line && /validate=\d+ms handler=\d+ms broadcast=\d+ms/.test(line), "case C: the log line carries per-phase timing (validBefore is 25s on this rail; latency vs verdict must be distinguishable)");
  server.close();
}

// Case D: credential present but validate() rejects -> falls through untouched, no handler bypass flag set.
{
  const app = express();
  app.use(createTempoGate({
    validate: async () => ({ ok: false, error: "expired" }),
    broadcast: async () => ({ ok: true, receipt: {} }),
  }));
  app.use((req, res) => res.status(402).json({ fallenThrough: true, tempoSettling: !!req.tempoSettling }));
  const { server, url } = await listen(app);
  const res = await fetch(`${url}/anything`, { headers: { Authorization: buildTempoCredential() } });
  const body = await res.json();
  ok(res.status === 402, "case D: invalid credential falls through to the next middleware's own 402");
  ok(body.fallenThrough === true, "case D: request reaches downstream middleware untouched");
  ok(body.tempoSettling === false, "case D: req.tempoSettling is never set for a rejected credential");
  server.close();
}

// Case E: no tempo credential at all (plain request) -> completely unaffected, validate/broadcast never invoked.
{
  let validateCalled = false, broadcastCalled = false;
  const app = express();
  app.use(createTempoGate({
    validate: async () => { validateCalled = true; return { ok: true, validation: {} }; },
    broadcast: async () => { broadcastCalled = true; return { ok: true, receipt: {} }; },
  }));
  app.get("/free", (req, res) => res.status(200).json({ untouched: true }));
  const { server, url } = await listen(app);
  const res = await fetch(`${url}/free`);
  const body = await res.json();
  ok(res.status === 200 && body.untouched === true, "case E: a plain request (no tempo credential) passes through unaffected");
  ok(!validateCalled && !broadcastCalled, "case E: validate/broadcast are never invoked for a non-tempo request");
  server.close();
}

// Case F: the SAME credential fired CONCURRENTLY at the same route -> the
// replay guard rejects the second before its handler ever runs. This is
// the real vulnerability the guard closes: without it, this gate bypasses
// the whole PoW/replay-guard/x402mw dispatcher (replay-guard.js only
// understands EIP-3009 nonces), so one signed credential could trigger N
// free handler executions before Tempo's relay ever sees the duplicate.
{
  const replayGuard = createReplayGuard();
  let handlerRuns = 0;
  const app = express();
  app.use(createTempoGate({
    validate: async () => ({ ok: true, validation: {} }),
    broadcast: async () => ({ ok: true, receipt: { method: "tempo", status: "success", reference: "0xdeadbeef", timestamp: new Date().toISOString() } }),
    replayGuard,
  }));
  app.get("/paid", async (req, res) => {
    handlerRuns++;
    await sleep(150); // widen the race window so both requests are genuinely in flight together
    res.status(200).json({ result: "ok" });
  });
  const { server, url } = await listen(app);
  const cred = buildTempoCredential();
  const [r1, r2] = await Promise.all([
    fetch(`${url}/paid`, { headers: { Authorization: cred } }),
    fetch(`${url}/paid`, { headers: { Authorization: cred } }),
  ]);
  const statuses = [r1.status, r2.status].sort();
  ok(handlerRuns === 1, `case F: the SAME credential fired concurrently -> the handler runs exactly once, not twice (got ${handlerRuns})`);
  ok(statuses[0] === 200 && statuses[1] === 409, `case F: one request succeeds, the concurrent replay is rejected 409 (got ${statuses.join(",")})`);
  server.close();
}

// Case G: release-on-failure -> a credential whose attempt failed (never
// consumed) can be legitimately retried, same as replay-guard.js's own
// "release when NOT granted" rule for the x402 side.
{
  const replayGuard = createReplayGuard();
  let handlerRuns = 0;
  const app = express();
  app.use(createTempoGate({
    validate: async () => ({ ok: true, validation: {} }),
    broadcast: async () => ({ ok: true, receipt: { method: "tempo", status: "success", reference: "0xdeadbeef", timestamp: new Date().toISOString() } }),
    replayGuard,
  }));
  app.get("/paid", (req, res) => {
    handlerRuns++;
    res.status(handlerRuns === 1 ? 500 : 200).json({ result: handlerRuns === 1 ? "boom" : "ok" });
  });
  const { server, url } = await listen(app);
  const cred = buildTempoCredential();
  const r1 = await fetch(`${url}/paid`, { headers: { Authorization: cred } });
  ok(r1.status === 500, "case G: first attempt fails (handler error) -> claim released, not consumed");
  const r2 = await fetch(`${url}/paid`, { headers: { Authorization: cred } });
  ok(r2.status === 200, "case G: the SAME credential retried after a released failure succeeds (not treated as a replay)");
  ok(handlerRuns === 2, `case G: handler ran for both the failed attempt and the successful retry (got ${handlerRuns})`);
  server.close();
}

function isDeepOrderOk(actual, expected) {
  return actual.length === expected.length && actual.every((v, i) => v === expected[i]);
}

facilitator.close();
console.log(`\n${pass} passed, 0 failed`);
