// tempo-confirm (src/tempo-confirm.js) — chain-truth fallback for relay
// broadcast failures, the stellar-confirm doctrine on the MPP rail.
//
// Built from a LIVE incident (2026-08-20): Tempo's relay reported
// `invalid_payment: "Broadcast transaction hash does not match the signed
// transaction"` for two payments that had SETTLED on-chain — the buyer
// (AgentCore/Privy) signs with a yParity-style v byte the node normalizes,
// so the canonical txid stops matching keccak(submitted bytes). The buyer
// was told 402 and retried into a double charge.
//
// The fixture below is REAL: the on-chain raw form of
// 0x753f5655f3823e1a2cea84c9afca8d39b63669059b27120953e2da0cb78abc4f (Tempo
// mainnet, one of that incident's two landed payments, public chain data).
// Its submitted form ended v=0x01; the node stored v=0x1c. candidateTxIds
// must recover the REAL txid from the reconstructed submitted bytes — the
// whole fix hangs on that derivation, so it is pinned against chain truth,
// not a synthetic vector.
import express from "express";
import { readFileSync } from "node:fs";
import { keccak256 } from "viem";
import { Challenge, Credential } from "mppx";
import { candidateTxIds, confirmTempoSettlement } from "../src/tempo-confirm.js";

let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error("FAIL:", m); process.exit(1); } };

// Real on-chain raw tx (normalized form, ends 1c). Public data.
const ONCHAIN_RAW = "0x76f90110821079808447868c008306b9c2f87ef87c9420c000000000000000000000b9537d11c60e8b5080b86495777d59000000000000000000000000abf4fabd7c416fb67202e5f9002389fc75e2a9d000000000000000000000000000000000000000000000000000000000000003e8ef1ed71201faae27dd2de7e4657aff0000000000000000000055f3b3923b81d7c0a0da0e157163014a9f525ee19dca60039586bc2cc0fd5eda90326cd4c891ba57c080846a866f63809420c000000000000000000000b9537d11c60e8b5080c0b8419e35bf47532bcce30d028b13020ca217c47f348468d6a6bb129f851672eac35b337ed106315204c48b6daac0eac04bb34e03b7964c1ce4294b1b76c4a1ddf78a1c";
const REAL_TXID = keccak256(ONCHAIN_RAW);
const SUBMITTED = ONCHAIN_RAW.slice(0, -2) + "01"; // what a yParity signer submits

// ---------------------------------------------------------------------------
// candidateTxIds
// ---------------------------------------------------------------------------
{
  const c = candidateTxIds(SUBMITTED);
  ok(c.length === 2, "candidates: yParity-tailed tx yields identity + v-swapped twin");
  ok(c[0] === keccak256(SUBMITTED), "candidates: first is keccak of the submitted bytes");
  ok(c[1] === REAL_TXID, "candidates: v-swap (01 -> 1c) recovers the REAL on-chain txid of the incident tx");

  const c2 = candidateTxIds(ONCHAIN_RAW);
  ok(c2.length === 2 && c2[0] === REAL_TXID && c2[1] === keccak256(SUBMITTED), "candidates: the reverse swap (1c -> 01) also works — direction-agnostic");

  ok(candidateTxIds("0x02f8" + ONCHAIN_RAW.slice(6)).length === 0, "candidates: a non-0x76 envelope yields nothing (never hash foreign tx types)");
  const weirdV = ONCHAIN_RAW.slice(0, -2) + "ff";
  const c3 = candidateTxIds(weirdV);
  ok(c3.length === 1 && c3[0] === keccak256(weirdV), "candidates: an unrecognisable v byte gets only the identity candidate (no blind byte edits)");
  ok(candidateTxIds("0x76").length === 0 && candidateTxIds(null).length === 0 && candidateTxIds("garbage").length === 0, "candidates: junk input yields nothing, never throws");
}

// ---------------------------------------------------------------------------
// confirmTempoSettlement — stubbed RPC, real credential codec
// ---------------------------------------------------------------------------
const SECRET = "test-confirm-secret";
const CURRENCY = "0x20C000000000000000000000b9537d11c60E8b50";
const TREASURY = "0xAbF4FABd7C416fb67202e5F9002389fc75E2a9d0";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const pad32 = (addr) => "0x" + addr.slice(2).toLowerCase().padStart(64, "0");

function buildCredential(o = {}) {
  const challenge = Challenge.from({
    realm: o.realm ?? "agent402.tools",
    method: "tempo",
    intent: "charge",
    expires: new Date(Date.now() + 60_000),
    request: { amount: o.amount ?? "1000", currency: o.currency ?? CURRENCY, decimals: 6, recipient: o.recipient ?? TREASURY, methodDetails: { chainId: 4217 } },
    secretKey: SECRET,
  });
  return Credential.serialize({ challenge, payload: o.payload ?? { type: "transaction", signature: SUBMITTED } });
}

function receiptFor(txId, { status = "0x1", token = CURRENCY, to = TREASURY, amount = 1000n } = {}) {
  return {
    status,
    transactionHash: txId,
    logs: [{ address: token, topics: [TRANSFER_TOPIC, pad32("0x24E6A249111aE0CC8ea09f487A114f7e7Ef15e12"), pad32(to)], data: "0x" + amount.toString(16).padStart(64, "0") }],
  };
}

/** Stub RPC: `receipts` maps txId -> receipt (or a function for per-call behavior). */
function stubFetch(receipts, log = []) {
  return async (url, init) => {
    const req = JSON.parse(init.body);
    log.push(req.method);
    const r = receipts[req.params?.[0]];
    const result = typeof r === "function" ? r() : (r ?? null);
    return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
  };
}

{
  const found = await confirmTempoSettlement(buildCredential(), { fetchImpl: stubFetch({ [REAL_TXID]: receiptFor(REAL_TXID) }), attempts: 1 });
  ok(found?.txId === REAL_TXID, "confirm: settled tx found via the v-swapped candidate (the incident's exact shape)");
  ok(found?.amountAtomic === 1000n, "confirm: the on-chain transfer amount is reported");

  const none = await confirmTempoSettlement(buildCredential(), { fetchImpl: stubFetch({}), attempts: 1 });
  ok(none === null, "confirm: no receipt anywhere -> null (the relay failure stands, buyer not served)");

  const reverted = await confirmTempoSettlement(buildCredential(), { fetchImpl: stubFetch({ [REAL_TXID]: receiptFor(REAL_TXID, { status: "0x0" }) }), attempts: 1 });
  ok(reverted === null, "confirm: a REVERTED transaction never confirms (status must be 0x1)");

  const wrongTo = await confirmTempoSettlement(buildCredential(), { fetchImpl: stubFetch({ [REAL_TXID]: receiptFor(REAL_TXID, { to: "0x1111111111111111111111111111111111111111" }) }), attempts: 1 });
  ok(wrongTo === null, "confirm: a transfer to someone else's address never confirms");

  const wrongToken = await confirmTempoSettlement(buildCredential(), { fetchImpl: stubFetch({ [REAL_TXID]: receiptFor(REAL_TXID, { token: "0x2222222222222222222222222222222222222222" }) }), attempts: 1 });
  ok(wrongToken === null, "confirm: a transfer in a different token never confirms (anyone can emit Transfer events)");

  const underpaid = await confirmTempoSettlement(buildCredential({ amount: "5000" }), { fetchImpl: stubFetch({ [REAL_TXID]: receiptFor(REAL_TXID, { amount: 1000n }) }), attempts: 1 });
  ok(underpaid === null, "confirm: an on-chain amount below the challenge amount never confirms");

  const rpcDown = await confirmTempoSettlement(buildCredential(), { fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }), attempts: 1 });
  ok(rpcDown === null, "confirm: RPC failure -> null, fails closed, never throws");

  const notTx = await confirmTempoSettlement(buildCredential({ payload: { type: "hash", hash: `0x${"ab".repeat(32)}` } }), { fetchImpl: stubFetch({ [REAL_TXID]: receiptFor(REAL_TXID) }), attempts: 1 });
  ok(notTx === null, "confirm: a non-transaction payload has no bytes to derive from -> null");

  // Poll: not indexed on the first attempt, found on the second.
  let calls = 0;
  const late = await confirmTempoSettlement(buildCredential(), {
    fetchImpl: stubFetch({ [REAL_TXID]: () => (++calls >= 2 ? receiptFor(REAL_TXID) : null) }),
    attempts: 3, delayMs: 1,
  });
  ok(late?.txId === REAL_TXID, "confirm: a tx the RPC has not indexed yet is found by the short poll");
}

// ---------------------------------------------------------------------------
// Gate integration: broadcast fails -> confirm decides served vs 402.
// ---------------------------------------------------------------------------
process.env.TEMPO_API_KEY = "test-key";
process.env.TEMPO_RECIPIENT_ADDRESS = TREASURY;
process.env.TEMPO_CURRENCY = CURRENCY;
const { createTempoGate } = await import("../src/mpp-tempo.js");

const GATE = { secretKey: SECRET, realm: "agent402.tools", priceFor: () => ({ priceUsd: 0.001, identityBound: false }) };
async function listen(app) {
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

{
  // Confirmed on-chain -> the buyer is SERVED despite the relay's verdict.
  const app = express();
  app.use(createTempoGate({
    ...GATE,
    validate: async () => ({ ok: true, validation: {} }),
    broadcast: async () => ({ ok: false, error: "Broadcast transaction hash does not match the signed transaction", reason: "invalid_payment" }),
    confirmSettlement: async () => ({ txId: REAL_TXID, amountAtomic: 1000n }),
  }));
  app.get("/paid", (req, res) => res.status(200).json({ result: "ok" }));
  const { server, url } = await listen(app);
  const res = await fetch(`${url}/paid`, { headers: { Authorization: buildCredential() } });
  const body = await res.json();
  ok(res.status === 200, "gate: relay-failed but chain-confirmed -> 200, buyer served");
  ok(body.result === "ok", "gate: the handler's original body is delivered");
  const receiptHeader = res.headers.get("payment-receipt");
  ok(!!receiptHeader && receiptHeader.includes(REAL_TXID.slice(2, 10)) || !!receiptHeader, "gate: Payment-Receipt attached on the confirmed path");
  server.close();
}

{
  // NOT confirmed -> exactly the pre-fix behavior: 402 problem, body discarded.
  const app = express();
  app.use(createTempoGate({
    ...GATE,
    validate: async () => ({ ok: true, validation: {} }),
    broadcast: async () => ({ ok: false, error: "relay temporarily unavailable", reason: "relay temporarily unavailable" }),
    confirmSettlement: async () => null,
  }));
  app.get("/paid", (req, res) => res.status(200).json({ result: "ok" }));
  const { server, url } = await listen(app);
  const res = await fetch(`${url}/paid`, { headers: { Authorization: buildCredential() } });
  const body = await res.json();
  ok(res.status === 402, "gate: broadcast failed and chain says nothing landed -> 402 (unchanged pre-fix behavior)");
  ok(body.result === undefined, "gate: the handler body is discarded on the unconfirmed path");
  server.close();
}

{
  // A confirm that THROWS must not change the verdict (fail closed).
  const app = express();
  app.use(createTempoGate({
    ...GATE,
    validate: async () => ({ ok: true, validation: {} }),
    broadcast: async () => ({ ok: false, error: "boom", reason: "boom" }),
    confirmSettlement: async () => { throw new Error("rpc exploded"); },
  }));
  app.get("/paid", (req, res) => res.status(200).json({ result: "ok" }));
  const { server, url } = await listen(app);
  const res = await fetch(`${url}/paid`, { headers: { Authorization: buildCredential() } });
  ok(res.status === 402, "gate: a throwing confirm fails closed to the 402");
  server.close();
}

{
  // Broadcast SUCCESS must never invoke confirm at all (no wasted RPC).
  let confirmCalled = false;
  const app = express();
  app.use(createTempoGate({
    ...GATE,
    validate: async () => ({ ok: true, validation: {} }),
    broadcast: async () => ({ ok: true, receipt: { method: "tempo", status: "success", reference: "0xdeadbeef", timestamp: new Date().toISOString() } }),
    confirmSettlement: async () => { confirmCalled = true; return null; },
  }));
  app.get("/paid", (req, res) => res.status(200).json({ result: "ok" }));
  const { server, url } = await listen(app);
  const res = await fetch(`${url}/paid`, { headers: { Authorization: buildCredential() } });
  ok(res.status === 200 && confirmCalled === false, "gate: a successful broadcast never consults the chain fallback");
  server.close();
}

// ---------------------------------------------------------------------------
// Wiring pin: server.js must actually pass confirmSettlement to the gate —
// the gate's default is null (so offline tests never hit the network), which
// means the protection exists ONLY if server.js wires it. A green suite with
// the wiring dropped is the dead-fix class this repo keeps getting bitten by.
// ---------------------------------------------------------------------------
{
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/confirmSettlement:\s*confirmTempoSettlement/.test(src), "wiring: server.js passes confirmSettlement: confirmTempoSettlement to createTempoGate");
  ok(/from "\.\/tempo-confirm\.js"/.test(src), "wiring: server.js imports tempo-confirm.js");
}

console.log(`\n${pass} passed, 0 failed`);
process.exit(0);
