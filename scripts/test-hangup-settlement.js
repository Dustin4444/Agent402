// A paid call whose client hangs up is charged once, and owed back once.
//
// The rule on every rail: once the handler has done the work and produced a
// <400, the payment settles whether or not the client is still connected (so a
// hang-up is never a free handler run). If the client left before anything
// reached it, the buyer paid for a response they never received: that charge
// is recorded as owed in the refund ledger. Node never fires "finish" on a
// destroyed socket, so the finish-based charged-failure path cannot see this
// case; src/hangup-settlement.js does.
//
// Part 1 drives the hook directly (credits flag, partial stream, normal
// completion). Part 2 boots the REAL paid server against a stub facilitator
// whose /settle is slow: a real x402 client mints a real payment, the raw
// request is sent and the socket destroyed after the handler ran but before
// settlement finished. Settlement must still happen, exactly one debt must be
// recorded, and a connected control buyer must record none.
import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { createHangupSettlementHook } from "../src/hangup-settlement.js";
import { getFreePort } from "./lib/free-port.js";

let pass = 0, proc = null, facilitator = null;
const TMP = mkdtempSync(join(tmpdir(), "hangup-"));
const cleanup = () => { proc?.kill("SIGKILL"); facilitator?.close(); rmSync(TMP, { recursive: true, force: true }); };
const fail = (m) => { console.error("FAIL:", m); cleanup(); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (app) => new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve({ server: s, url: `http://127.0.0.1:${s.address().port}` })); });
// Send a request and destroy the socket after `abortAfterMs`, before any reply.
const hangUp = (url, headers, abortAfterMs) => new Promise((resolve) => {
  const req = httpRequest(url, { headers });
  req.on("error", () => resolve());
  req.on("response", () => resolve());
  req.end();
  setTimeout(() => { req.destroy(); resolve(); }, abortAfterMs);
});

// ---------------------------------------------------------------- part 1

{
  const seen = [];
  const app = express();
  app.use(createHangupSettlementHook({ onUndelivered: (req, _res, kind) => seen.push({ path: req.path, kind }) }));
  // A buffered "gate": holds the handler's end, then ends after a delay, the
  // way every paid gate does once settlement returns.
  app.get("/buffered", (req, res) => { setTimeout(() => res.json({ ok: 1 }), 300); });
  // A stream that has already sent headers when the client leaves.
  app.get("/stream", (req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.write("part"); setTimeout(() => res.end("rest"), 300); });
  // Credits settle inside their own close listener; the hook must see it.
  app.get("/credits", (req, res) => {
    res.on("close", () => { if (!res.writableFinished) req.creditsChargedOnClose = 0.01; });
    setTimeout(() => { try { res.json({ ok: 1 }); } catch { /* gone */ } }, 400);
  });
  const { server, url } = await listen(app);
  await hangUp(`${url}/buffered`, {}, 80);
  await sleep(450);
  ok(seen.length === 1 && seen[0].path === "/buffered" && seen[0].kind === "end", `a response ended after the client hung up is reported once (${JSON.stringify(seen)})`);
  await fetch(`${url}/buffered`);
  await sleep(50);
  ok(seen.length === 1, "a response delivered to a connected client is never reported");
  await new Promise((resolve) => { const r = httpRequest(`${url}/stream`, (res) => { res.once("data", () => { r.destroy(); resolve(); }); }); r.on("error", () => resolve()); r.end(); });
  await sleep(450);
  ok(seen.length === 1, "a stream the client left part way through (headers already sent) is not reported as undelivered");
  await hangUp(`${url}/credits`, {}, 80);
  await sleep(100);
  ok(seen.length === 2 && seen[1].path === "/credits" && seen[1].kind === "close", `a credits charge taken on close is reported without waiting for the handler (${JSON.stringify(seen)})`);
  await sleep(500);
  ok(seen.length === 2, `and the handler ending later does not report the same request a second time - a credits debt has no tx to dedupe on (${seen.length})`);
  server.close();
}

// Source pins for the two halves the booted test below cannot reach: credits
// (a real key needs a card purchase) and the mount ORDER, which is what makes
// every gate's captured res.end the hook's wrapper.
{
  const { readFileSync } = await import("node:fs");
  const credits = readFileSync(new URL("../src/credits.js", import.meta.url), "utf8");
  ok(/res\.on\("close",[^\n]*settle\([^\n]*req\.creditsChargedOnClose = c\.chargedUsd/.test(credits), "credits: a charge taken on close sets the flag the hook reads");
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const hookAt = server.indexOf("app.use(createHangupSettlementHook(");
  const firstGate = Math.min(...["app.use(tempoGate)", "app.use(mppShim)", "app.use(stripeGate)", "app.use(_credits.gate("].map((s) => server.indexOf(s)).filter((i) => i >= 0));
  ok(hookAt > 0 && hookAt < firstGate, "server.js mounts the hang-up hook before every payment gate");
  ok(/else if \(req\.creditsSettled && Number\(req\.creditsChargedOnClose\) > 0\)/.test(server), "the debt recorder books a credits charge taken on close");
}

// ---------------------------------------------------------------- part 2

const [PORT, FAC_PORT] = [await getFreePort(), await getFreePort()];
const B = `http://127.0.0.1:${PORT}`;
const TREASURY = "0x000000000000000000000000000000000000dEaD";
const TX = `0x${"5e".repeat(32)}`;
const OP = "test-hangup-operator-token-0123456789";
const facCalls = { verify: 0, settle: 0 };
let settleDelayMs = 0;
facilitator = createServer((req, res) => {
  let b = ""; req.on("data", (c) => { b += c; });
  req.on("end", async () => {
    if (req.url === "/settle" && settleDelayMs) await sleep(settleDelayMs);
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === "/supported") return res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} }));
    const parsed = b ? JSON.parse(b) : {};
    const payer = parsed.paymentPayload?.payload?.authorization?.from;
    if (req.url === "/verify") { facCalls.verify++; return res.end(JSON.stringify({ isValid: true, payer })); }
    if (req.url === "/settle") { facCalls.settle++; return res.end(JSON.stringify({ success: true, transaction: TX, network: "eip155:8453", payer })); }
    res.end("{}");
  });
});
await new Promise((r) => facilitator.listen(FAC_PORT, r));
proc = spawn("node", ["src/server.js"], {
  env: { ...process.env, PORT: String(PORT), FREE_MODE: "", WALLET_ADDRESS: TREASURY, NETWORK: "base",
    FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, PAYMENT_NETWORKS: "base",
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off",
    AGENT402_OPERATOR_TOKEN: OP, REFUND_DB_DIR: TMP },
  stdio: "ignore",
});

const refunds = async () => {
  const r = await fetch(`${B}/__operator/refunds.json?status=all`, { headers: { Authorization: `Bearer ${OP}` } });
  const j = await r.json();
  return (j.refunds || []).filter((row) => row.slug === "uuid");
};

try {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${B}/health`)).ok) break; } catch {} await sleep(500); }
  const [{ privateKeyToAccount, generatePrivateKey }, { x402Client }, { registerExactEvmScheme }, { wrapFetchWithPayment }] =
    await Promise.all([import("viem/accounts"), import("@x402/core/client"), import("@x402/evm/exact/client"), import("@x402/fetch")]);

  // Control: a connected buyer settles and nothing is owed.
  {
    const client = new x402Client();
    registerExactEvmScheme(client, { signer: privateKeyToAccount(generatePrivateKey()) });
    const r = await wrapFetchWithPayment(fetch, client)(`${B}/api/uuid`);
    ok(r.status === 200, `control: a connected x402 buyer is served (${r.status})`);
    await sleep(200);
    ok((await refunds()).length === 0, "control: a delivered paid call records no debt");
  }

  // Mint a real payment without spending it, then send it ourselves and hang up.
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: privateKeyToAccount(generatePrivateKey()) });
  let minted = null, mintedHeader = null;
  const capturing = async (input, init) => {
    const r = input instanceof Request ? input : new Request(input, init);
    for (const name of ["payment-signature", "x-payment"]) { const v = r.headers.get(name); if (v) { minted = v; mintedHeader = name; } }
    if (minted) return new Response("{}", { status: 402, headers: { "Content-Type": "application/json" } });
    return fetch(input, init);
  };
  await wrapFetchWithPayment(capturing, client)(`${B}/api/uuid`).catch(() => {});
  ok(!!minted, "captured a genuine signed payment header");

  settleDelayMs = 1_200;
  const settlesBefore = facCalls.settle;
  await hangUp(`${B}/api/uuid`, { [mintedHeader]: minted }, 400);
  await sleep(2_000);
  settleDelayMs = 0;
  ok(facCalls.settle - settlesBefore === 1, `the handler's 200 is settled although the client hung up (settles +${facCalls.settle - settlesBefore}) - a hang-up is not a free run`);
  const rows = await refunds();
  ok(rows.length === 1, `exactly one debt is recorded for the charge the buyer never received (${rows.length})`);
  ok(rows[0].evidence === TX && rows[0].wire === "x402" && rows[0].httpStatus === 499 && (rows[0].network === "base" || rows[0].network === "eip155:8453") && rows[0].status === "owed",
    `the debt carries the settle tx, rail and a 499 marker (${JSON.stringify(rows[0])})`);

  // The same credential cannot buy a second run.
  const again = await fetch(`${B}/api/uuid`, { headers: { [mintedHeader]: minted } });
  ok(again.status !== 200 && facCalls.settle - settlesBefore === 1, `re-sending the spent credential is refused (${again.status}), no second settle`);
  ok((await refunds()).length === 1, "and no second debt is minted");

  console.log(`\nPASS - ${pass} checks (hang-up settlement)`);
  cleanup();
  process.exit(0);
} catch (e) {
  fail(`unexpected: ${e?.stack || e}`);
}
