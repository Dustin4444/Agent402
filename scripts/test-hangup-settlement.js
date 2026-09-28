// A buyer whose connection is gone before the first response byte is never
// charged (src/hangup-settlement.js); only a close during the settle call
// itself is charged, and that one is booked as owed in the refund ledger.
//
// Why: @x402/express decides whether to settle from res.statusCode alone and
// never asks whether the buyer is still connected, so a client with a 20 s
// timeout against a 40 s media run used to produce a settled charge the buyer
// never received plus a refund-ledger debt. Once repaid, that is exactly what
// not settling would have produced, plus refund gas and manual work.
//
// Part 1 drives the hook, the client-gone predicate and the credits gate
// directly, and pins from source the seams the booted part cannot isolate.
// Part 2 boots the REAL paid server against a stub facilitator and a stub
// OpenRouter (scripts/lib/openrouter-stub-preload.js sends every openrouter.ai
// fetch to it; the preload refuses to load without a stub, so this can never
// spend upstream), sends real HTTP requests and destroys the socket at chosen
// moments:
//   a. connected control: settled, nothing owed;
//   b. close during a slow /settle (the residual window): settled once, owed once;
//   c. close during verify: the handler never runs, nothing settles, no strike;
//   d. close mid-handler: the handler ran, nothing settles, nothing owed,
//      the spent credential cannot buy a second run;
//   e. three such hang-ups from one wallet: the fourth call is refused 429
//      before the handler; another wallet is unaffected;
//   g. close AFTER the whole answer arrived: an ordinary settled sale.
import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { createHangupSettlementHook, clientGoneBeforeFirstByte, clientGoneError, isClientGoneAbort, CLIENT_GONE_TEXT } from "../src/hangup-settlement.js";
import { createCredits } from "../src/credits.js";
import { getFreePorts } from "./lib/free-port.js";

let pass = 0, proc = null, facilitator = null, orStub = null;
const serverLog = [];
const TMP = mkdtempSync(join(tmpdir(), "hangup-"));
const cleanup = () => { proc?.kill("SIGKILL"); facilitator?.close(); orStub?.close(); rmSync(TMP, { recursive: true, force: true }); };
const fail = (m) => { console.error("FAIL:", m); for (const l of serverLog.slice(-30)) console.error("  server:", l); cleanup(); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (app) => new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve({ server: s, url: `http://127.0.0.1:${s.address().port}` })); });
const waitFor = async (cond, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(20); } return cond(); };

// Send a request and destroy the socket when `abortWhen` resolves (or after a
// fixed delay), before any reply. Resolves once the socket is gone.
const hangUp = (url, { method = "GET", headers = {}, body = null, abortAfterMs = null, abortWhen = null } = {}) => new Promise((resolve) => {
  const req = httpRequest(url, { method, headers });
  let done = false;
  const finish = () => { if (!done) { done = true; resolve(); } };
  req.on("error", finish);
  req.on("response", (r) => { r.resume(); finish(); });
  if (body) req.write(body);
  req.end();
  const kill = () => { req.destroy(); finish(); };
  if (abortWhen) abortWhen.then(kill); else setTimeout(kill, abortAfterMs ?? 100);
});

// ---------------------------------------------------------------- part 1

// 1a. The hook marks the request only for a close before the first byte.
{
  const seen = [];
  const flags = {};
  const app = express();
  app.use(createHangupSettlementHook({ onUndelivered: (req, _res, kind) => seen.push({ path: req.path, kind }) }));
  // A buffered "gate": holds the handler's end, then ends after a delay, the
  // way every paid gate does once settlement returns.
  app.get("/buffered", (req, res) => { setTimeout(() => { flags.buffered = Object.hasOwn(req, "__a402ClientGoneAt"); flags.bufferedGone = clientGoneBeforeFirstByte(req); res.json({ ok: 1 }); }, 300); });
  app.get("/plain", (req, res) => { res.json({ ok: 1 }); res.on("close", () => { flags.plain = Object.hasOwn(req, "__a402ClientGoneAt"); }); });
  // A stream that has already sent headers when the client leaves.
  app.get("/stream", (req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.write("part"); setTimeout(() => { flags.stream = Object.hasOwn(req, "__a402ClientGoneAt"); flags.streamGone = clientGoneBeforeFirstByte(req); res.end("rest"); }, 300); });
  const { server, url } = await listen(app);
  await hangUp(`${url}/buffered`, { abortAfterMs: 80 });
  await sleep(450);
  ok(flags.buffered === true && flags.bufferedGone === true, "a close before the first byte marks the request (__a402ClientGoneAt) and the predicate reads it");
  ok(seen.length === 1 && seen[0].path === "/buffered" && seen[0].kind === "end", `the response ended after the client left is reported once, at end (${JSON.stringify(seen)})`);
  await fetch(`${url}/plain`);
  await sleep(50);
  ok(flags.plain === false && seen.length === 1, "a normal completion is neither marked nor reported");
  await new Promise((resolve) => { const r = httpRequest(`${url}/stream`, (res) => { res.once("data", () => { r.destroy(); resolve(); }); }); r.on("error", () => resolve()); r.end(); });
  await sleep(450);
  ok(flags.stream === false && flags.streamGone === false && seen.length === 1, "a stream the client left part way through (headers already sent) is neither marked nor reported");
  server.close();
}

// 1b. clientGoneBeforeFirstByte truth table, including the belt a request
// without the hook (FREE_MODE, a unit app) falls back to.
{
  const reqWith = (res, extra = {}) => Object.assign({ res, socket: extra.socket || { destroyed: false } }, extra.own || {});
  ok(clientGoneBeforeFirstByte(null) === false && clientGoneBeforeFirstByte(undefined) === false && clientGoneBeforeFirstByte({}) === false, "no request / no response: not gone");
  ok(clientGoneBeforeFirstByte({ __a402ClientGoneAt: Date.now() }) === true, "the hook's own-property flag alone says gone");
  ok(clientGoneBeforeFirstByte(Object.create({ __a402ClientGoneAt: Date.now() })) === false, "a flag on the PROTOTYPE is ignored (a polluted prototype must not make every request unsettled)");
  ok(clientGoneBeforeFirstByte(reqWith({ headersSent: false, destroyed: true })) === true, "belt: no flag, nothing sent, response destroyed -> gone");
  ok(clientGoneBeforeFirstByte(reqWith({ headersSent: false, destroyed: false }, { socket: { destroyed: true } })) === true, "belt: no flag, nothing sent, socket destroyed -> gone");
  ok(clientGoneBeforeFirstByte(reqWith({ headersSent: true, destroyed: true }, { socket: { destroyed: true } })) === false, "belt: headers already sent -> partly delivered, not this case");
  ok(clientGoneBeforeFirstByte(reqWith({ headersSent: false, destroyed: false })) === false, "belt: connected -> not gone");
  const e = clientGoneError();
  ok(isClientGoneAbort(e) && e.statusCode === 499 && e.name === "AbortError" && e.message === CLIENT_GONE_TEXT, "clientGoneError is a 499 AbortError carrying the standard text");
  ok(!isClientGoneAbort(new Error("x")) && !isClientGoneAbort(null) && !isClientGoneAbort(Object.assign(new Error("x"), { statusCode: 499 })), "isClientGoneAbort recognises only its own errors");
  // The belt in a real app with no hook mounted.
  const seenGone = [];
  const app = express();
  app.get("/slow", async (req, res) => { await sleep(250); seenGone.push(clientGoneBeforeFirstByte(req)); try { res.json({ ok: 1 }); } catch { /* gone */ } });
  const { server, url } = await listen(app);
  await hangUp(`${url}/slow`, { abortAfterMs: 60 });
  await fetch(`${url}/slow`);
  await sleep(350);
  ok(seenGone.length === 2 && seenGone[0] === true && seenGone[1] === false, `without the hook the belt still sees an abandoned socket and a connected one (${JSON.stringify(seenGone)})`);
  server.close();
}

// 1c. Credits: a hang-up before the first byte RELEASES the hold (it used to
// charge it and book a debt); the hook still reports the undelivered end once,
// with no charge evidence on the request.
{
  const dir = join(TMP, "credits");
  const sessions = { cs_paid: { id: "cs_paid", mode: "payment", payment_status: "paid", payment_intent: "pi_1", customer_details: { email: "c@example.com" }, metadata: { credits_pack: "credits-20" } } };
  const stripe = { checkout: { sessions: { create: async () => ({ id: "x", url: "https://example.com" }), retrieve: async (id) => sessions[id] } } };
  const cr = createCredits({ stripe, baseUrl: "https://agent402.tools", storeDir: dir, log: () => {} });
  const { key } = await cr.claim("cs_paid");
  const seen = [];
  const app = express();
  app.use(createHangupSettlementHook({ onUndelivered: (req, res, kind) => seen.push({ kind, creditsSettled: req.creditsSettled === true, charged: req.creditsCharged ?? null, receipt: res.getHeader("PAYMENT-RESPONSE") || null }) }));
  app.use(cr.gate((m, p) => (p === "/paid" ? { priceUsd: 0.25, slug: "paid" } : null)));
  app.get("/paid", (req, res) => { setTimeout(() => { try { res.json({ ok: 1 }); } catch { /* gone */ } }, 300); });
  const { server, url } = await listen(app);
  await hangUp(`${url}/paid`, { headers: { Authorization: `Bearer ${key}` }, abortAfterMs: 80 });
  await sleep(450);
  const bal = cr.balance(key);
  ok(bal.balanceUsd === 20 && bal.heldUsd === 0 && bal.calls === 0, `credits: the hold is released when the buyer leaves before the first byte (balance ${bal.balanceUsd}, held ${bal.heldUsd}, calls ${bal.calls})`);
  ok(seen.length === 1 && seen[0].kind === "end" && seen[0].creditsSettled && seen[0].charged === null && seen[0].receipt === null, `credits: the hook reports the undelivered end once, with no charge evidence (${JSON.stringify(seen)})`);
  const r = await fetch(`${url}/paid`, { headers: { Authorization: `Bearer ${key}` } });
  ok(r.status === 200 && cr.balance(key).balanceUsd === 19.75 && seen.length === 1, "credits: a connected buyer is debited once and the hook stays quiet");
  server.close();
}

// 1d. Source pins for the seams the booted test cannot isolate, and for the
// vendor shape the x402 hook depends on.
{
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const payments = readFileSync(new URL("../src/payments.js", import.meta.url), "utf8");
  const tempo = readFileSync(new URL("../src/mpp-tempo.js", import.meta.url), "utf8");
  const stripeGate = readFileSync(new URL("../src/mpp-stripe.js", import.meta.url), "utf8");
  const credits = readFileSync(new URL("../src/credits.js", import.meta.url), "utf8");
  const hookAt = server.indexOf("app.use(createHangupSettlementHook(");
  const firstGate = Math.min(...["app.use(tempoGate)", "app.use(mppShim)", "app.use(stripeGate)", "app.use(_credits.gate("].map((s) => server.indexOf(s)).filter((i) => i >= 0));
  ok(hookAt > 0 && hookAt < firstGate, "server.js mounts the hang-up hook before every payment gate");
  ok(/app\.use\(createHangupSettlementHook\(\{ onUndelivered: recordHangupOutcome \}\)\)/.test(server), "the hook reports to recordHangupOutcome (debt or cancelled charge)");
  ok(/registerWalletBlocklistHook\(server\);\s*\n\s*registerClientGoneSettleHook\(server\);/.test(payments), "payments.js registers the client-gone settle hook beside the wallet blocklist");
  ok(/transportContext\?\.request\?\.adapter\?\.req/.test(payments) && /reason: "client_disconnected"/.test(payments), "the x402 hook reads the request from the transport context and aborts as client_disconnected");
  const belt = server.indexOf("if (clientGoneBeforeFirstByte(req)) throw clientGoneError(");
  const handlerCall = server.indexOf("? await runInAbortableScope(() => tool.handler(input, req)");
  ok(belt > 0 && handlerCall > belt && handlerCall - belt < 1500, "the dispatcher's belt runs immediately before the handler call");
  ok(/\bif \(isClientGoneAbort\(err\)\) status = 499;|\) \{ status = 499;/.test(server) && /req\.__a402HandlerStatus = status;/.test(server), "the dispatcher maps a client-gone throw to 499 and records the handler status");
  for (const [name, src, call] of [["mpp-tempo", tempo, "let b = await broadcast(auth);"], ["mpp-stripe", stripeGate, "const b = await settle(auth);"]]) {
    const check = src.indexOf("if (clientGoneBeforeFirstByte(req)) {");
    ok(check > 0 && src.indexOf(call) > check && src.indexOf(call) - check < 1200, `${name}: the client-gone check precedes the ${call.includes("broadcast") ? "broadcast" : "capture"}`);
  }
  ok(!/creditsChargedOnClose/.test(credits) && /if \(res\.headersSent\) \{ const c = settle\([^\n]*\n\s*else release\(a\.hash, a\.heldMicro\);/.test(credits), "credits: a close settles only a stream that began; otherwise the hold is released");
  ok(!/creditsChargedOnClose/.test(server), "the debt recorder no longer has a credits-on-close branch (unreachable)");
  // Vendor shape: @x402/express hands the settle hooks `{ request: context, ... }`
  // where context.adapter is an ExpressAdapter holding the Express request. A
  // bump that moves it would silently revert to settle-then-owe; fail here.
  const vendor = readFileSync(new URL("../node_modules/@x402/express/dist/esm/index.mjs", import.meta.url), "utf8");
  ok(/\{ request: context, responseBody, responseHeaders \}/.test(vendor) && /const adapter = new ExpressAdapter\(req\);/.test(vendor) && /const context = \{\s*adapter,/.test(vendor), "vendor: @x402/express passes { request: context } with context.adapter = new ExpressAdapter(req)");
  ok(/var ExpressAdapter = class \{[\s\S]{0,400}this\.req = req;/.test(vendor), "vendor: ExpressAdapter keeps the Express request as this.req");
}

// ---------------------------------------------------------------- part 2

const [PORT, FAC_PORT, OR_PORT] = await getFreePorts(3);
const B = `http://127.0.0.1:${PORT}`;
const TREASURY = "0x000000000000000000000000000000000000dEaD";
const TX = `0x${"5e".repeat(32)}`;
const OP = "test-hangup-operator-token-0123456789";

// Stub facilitator: verify/settle counters with optional delays.
const fac = { verify: 0, settle: 0, verifyDelayMs: 0, settleDelayMs: 0 };
facilitator = createServer((req, res) => {
  let b = ""; req.on("data", (c) => { b += c; });
  req.on("end", async () => {
    const reply = (obj) => { if (res.destroyed) return; res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url === "/supported") return reply({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    if (req.url === "/rpc") return reply({ jsonrpc: "2.0", id: 1, result: "0x0" });
    let parsed = {}; try { parsed = b ? JSON.parse(b) : {}; } catch { /* ignore */ }
    const payer = parsed.paymentPayload?.payload?.authorization?.from;
    if (req.url === "/verify") { fac.verify++; if (fac.verifyDelayMs) await sleep(fac.verifyDelayMs); return reply({ isValid: true, payer }); }
    if (req.url === "/settle") { fac.settle++; if (fac.settleDelayMs) await sleep(fac.settleDelayMs); return reply({ success: true, transaction: TX, network: "eip155:8453", payer }); }
    reply({});
  });
});
await new Promise((r) => facilitator.listen(FAC_PORT, "127.0.0.1", r));

// Stub OpenRouter: counts requests and counts its own inbound requests that
// were closed before it answered (an upstream call we cut off).
const or = { chat: 0, chatDelayMs: 0, chatClosedEarly: 0, images: 0, imagesDelayMs: 0, imagesClosedEarly: 0, imagesClosedAt: 0, other: 0 };
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
orStub = createServer((req, res) => {
  let b = ""; req.on("data", (c) => { b += c; });
  req.on("end", () => {
    const url = String(req.url || "").split("?")[0];
    const send = (status, obj) => { if (res.destroyed || res.writableEnded) return; res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    const trackEarlyClose = (key, atKey) => res.on("close", () => { if (!res.writableFinished) { or[key]++; if (atKey) or[atKey] = Date.now(); } });
    if (req.method === "POST" && url === "/api/v1/chat/completions") {
      or.chat++; trackEarlyClose("chatClosedEarly");
      setTimeout(() => send(200, { id: "gen-test", object: "chat.completion", created: Math.floor(Date.now() / 1000), model: "openai/gpt-6-luna", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }), or.chatDelayMs);
      return;
    }
    if (req.method === "GET" && /^\/api\/v1\/images\/models\/.+\/endpoints$/.test(url)) return send(200, { data: { endpoints: [] } });
    if (req.method === "POST" && url === "/api/v1/images") {
      or.images++; trackEarlyClose("imagesClosedEarly", "imagesClosedAt");
      setTimeout(() => send(200, { created: Math.floor(Date.now() / 1000), data: [{ b64_json: PNG_B64 }], usage: { prompt_tokens: 0, completion_tokens: 0 } }), or.imagesDelayMs);
      return;
    }
    or.other++;
    send(404, { error: { message: "not stubbed" } });
  });
});
await new Promise((r) => orStub.listen(OR_PORT, "127.0.0.1", r));

proc = spawn("node", ["--import", "./scripts/lib/openrouter-stub-preload.js", "src/server.js"], {
  env: { ...process.env, PORT: String(PORT), FREE_MODE: "", WALLET_ADDRESS: TREASURY, NETWORK: "base",
    FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, AGENT402_BASE_RPC: `http://127.0.0.1:${FAC_PORT}/rpc`, PAYMENT_NETWORKS: "base",
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", MPP_SECRET_KEY: "", TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", POSTHOG_API_KEY: "",
    OPENROUTER_API_KEY: "test-key-never-used", OPENROUTER_MANAGEMENT_KEY: "", OPENROUTER_STUB_URL: `http://127.0.0.1:${OR_PORT}`, OPENROUTER_FLEX: "off",
    GATEWAY_SETTLE_BREAKER_MAX: "3", GATEWAY_SETTLE_BREAKER_WINDOW_MS: "600000", GATEWAY_SETTLE_BREAKER_GLOBAL_MAX: "3",
    COMPOSITE_GUARD_MAX_FAILS: "3", COMPOSITE_GUARD_GLOBAL_MAX_FAILS: "3",
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", WALLET_DIGEST: "off",
    AGENT402_OPERATOR_TOKEN: OP, REFUND_DB_DIR: TMP },
  stdio: ["ignore", "pipe", "pipe"],
});
const keepLog = (chunk) => { for (const line of String(chunk).split("\n")) { if (line.trim()) serverLog.push(line.slice(0, 500)); } };
proc.stdout.on("data", keepLog); proc.stderr.on("data", keepLog);
const logSince = (i) => serverLog.slice(i).join("\n");

const refunds = async () => {
  const r = await fetch(`${B}/__operator/refunds.json?status=all`, { headers: { Authorization: `Bearer ${OP}` } });
  const j = await r.json();
  return j.refunds || [];
};

// Crafted credentials: the stub facilitator is the only verifier, so a
// credential names its payer in authorization.from and a fresh nonce makes it
// a fresh authorization from the SAME wallet.
let nonceN = 0;
const credential = (accepted, payer) => Buffer.from(JSON.stringify({
  x402Version: 2, resource: accepted.resource, accepted,
  payload: { signature: "0x" + "11".repeat(65), authorization: { from: payer, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: "9999999999", nonce: "0x" + (0x7000 + ++nonceN).toString(16).padStart(64, "0") } },
})).toString("base64");
const CHAT = { path: "/v1/nano/chat/completions", method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "say ok" }], max_tokens: 16 }) };
const accepts = {};
const acceptFor = async (t) => {
  if (accepts[t.path]) return accepts[t.path];
  const r = await fetch(`${B}${t.path}`, { method: t.method, headers: { "content-type": "application/json" }, body: t.body });
  ok(r.status === 402, `unpaid ${t.method} ${t.path} -> 402 (got ${r.status})`);
  const req402 = JSON.parse(Buffer.from(r.headers.get("payment-required"), "base64").toString("utf-8"));
  accepts[t.path] = (req402.accepts || []).find((a) => a.network === "eip155:8453" && a.scheme === "exact");
  ok(!!accepts[t.path], `${t.path} offers exact on Base`);
  return accepts[t.path];
};
const headersFor = async (t, payer) => ({ "content-type": "application/json", "payment-signature": credential(await acceptFor(t), payer) });
const pay = async (t, payer) => fetch(`${B}${t.path}`, { method: t.method, headers: await headersFor(t, payer), body: t.body });
const wallet = (n) => `0x${n.toString(16).padStart(40, "0")}`;

try {
  let up = false;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${B}/health`)).ok) { up = true; break; } } catch { /* booting */ } await sleep(500); }
  ok(up, "paid server booted with the OpenRouter stub preload");
  const [{ privateKeyToAccount, generatePrivateKey }, { x402Client }, { registerExactEvmScheme }, { wrapFetchWithPayment }] =
    await Promise.all([import("viem/accounts"), import("@x402/core/client"), import("@x402/evm/exact/client"), import("@x402/fetch")]);

  // a. Control: a connected buyer (a real x402 client) settles, nothing owed.
  {
    const client = new x402Client();
    registerExactEvmScheme(client, { signer: privateKeyToAccount(generatePrivateKey()) });
    const r = await wrapFetchWithPayment(fetch, client)(`${B}/api/uuid`);
    ok(r.status === 200, `a. control: a connected x402 buyer is served (${r.status})`);
    await sleep(200);
    ok((await refunds()).length === 0, "a. control: a delivered paid call records no debt");
  }

  // b. The residual window: the buyer leaves while /settle itself is in
  // flight. The money moves; the charge is booked as owed, once.
  {
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
    ok(!!minted, "b. captured a genuine signed payment header");
    fac.settleDelayMs = 1_200;
    const settlesBefore = fac.settle, logAt = serverLog.length;
    const settleSeen = waitFor(() => fac.settle > settlesBefore, 5000);
    await hangUp(`${B}/api/uuid`, { headers: { [mintedHeader]: minted }, abortWhen: settleSeen.then(() => sleep(100)) });
    await sleep(1_800);
    fac.settleDelayMs = 0;
    ok(fac.settle - settlesBefore === 1, `b. a close during the settle call itself: the payment settled (settles +${fac.settle - settlesBefore})`);
    const rows = (await refunds()).filter((row) => row.slug === "uuid");
    ok(rows.length === 1, `b. exactly one debt is recorded for the charge the buyer never received (${rows.length})`);
    ok(rows[0].evidence === TX && rows[0].wire === "x402" && rows[0].httpStatus === 499 && (rows[0].network === "base" || rows[0].network === "eip155:8453") && rows[0].status === "owed",
      `b. the debt carries the settle tx, rail and a 499 marker (${JSON.stringify(rows[0])})`);
    ok(/\[hangup\] CHARGED-BUT-NOT-SERVED/.test(logSince(logAt)), "b. the log says CHARGED-BUT-NOT-SERVED");
    const again = await fetch(`${B}/api/uuid`, { headers: { [mintedHeader]: minted } });
    ok(again.status !== 200 && fac.settle - settlesBefore === 1, `b. re-sending the spent credential is refused (${again.status}), no second settle`);
    ok((await refunds()).length === 1, "b. and no second debt is minted");
  }

  // c. The buyer leaves while the payment is being verified: the handler never
  // runs, nothing settles, nothing is owed, and the refusal is no strike.
  {
    const W = wallet(0xc1);
    fac.verifyDelayMs = 1_200;
    or.chatDelayMs = 0;
    for (let i = 1; i <= 3; i++) {
      const v0 = fac.verify, s0 = fac.settle, c0 = or.chat;
      const verifySeen = waitFor(() => fac.verify > v0, 5000);
      await hangUp(`${B}${CHAT.path}`, { method: "POST", headers: await headersFor(CHAT, W), body: CHAT.body, abortWhen: verifySeen.then(() => sleep(150)) });
      await sleep(1_500);
      ok(fac.verify - v0 === 1 && fac.settle === s0 && or.chat === c0, `c${i}. gone during verify: verified once, the handler never ran (chat stub +${or.chat - c0}), nothing settled (settles +${fac.settle - s0})`);
    }
    fac.verifyDelayMs = 0;
    ok((await refunds()).length === 1, "c. no debt for a payment that was never settled");
    const s0 = fac.settle;
    const r = await pay(CHAT, W);
    ok(r.status === 200 && fac.settle === s0 + 1, `c. three refusals that spent nothing are no strikes: the same wallet is then served (status ${r.status}, settles +${fac.settle - s0})`);
  }

  // d. The buyer leaves mid-handler on a non-composite route: the handler
  // runs to the end, the payment is not settled, nothing is owed, and the
  // spent credential cannot buy a second run.
  const WD = wallet(0xd1);
  {
    or.chatDelayMs = 1_500;
    const s0 = fac.settle, c0 = or.chat, logAt = serverLog.length;
    const headers = await headersFor(CHAT, WD);
    const upstreamSeen = waitFor(() => or.chat > c0, 5000);
    await hangUp(`${B}${CHAT.path}`, { method: "POST", headers, body: CHAT.body, abortWhen: upstreamSeen.then(() => sleep(150)) });
    await sleep(2_000);
    ok(or.chat - c0 === 1 && fac.settle === s0, `d. gone mid-handler: the handler ran (chat stub +${or.chat - c0}), the payment was NOT settled (settles +${fac.settle - s0})`);
    ok((await refunds()).length === 1, "d. a cancelled charge is not a refund-ledger debt: no row");
    const log = logSince(logAt);
    ok(/\[hangup\] NOT CHARGED: [^\n]*POST \/v1\/nano\/chat\/completions rail=x402/.test(log) && !/CHARGED-BUT-NOT-SERVED/.test(log), "d. the log says NOT CHARGED (and not CHARGED-BUT-NOT-SERVED)");
    // The replay guard marks the key consumed on close (statusCode is still
    // the default 200 then). No code carries this outcome by itself, so no
    // mutation can kill it; the outcome is what is asserted.
    const c1 = or.chat;
    const again = await fetch(`${B}${CHAT.path}`, { method: "POST", headers, body: CHAT.body });
    ok(again.status === 409 && or.chat === c1, `d. re-sending the same credential is refused 409 and runs nothing (status ${again.status}, chat stub +${or.chat - c1})`);
  }

  // e. Strikes: two more hang-ups from the same wallet (three with d), then a
  // fourth call is refused 429 BEFORE the handler; another wallet is served.
  {
    for (let i = 2; i <= 3; i++) {
      const c0 = or.chat, s0 = fac.settle;
      const upstreamSeen = waitFor(() => or.chat > c0, 5000);
      await hangUp(`${B}${CHAT.path}`, { method: "POST", headers: await headersFor(CHAT, WD), body: CHAT.body, abortWhen: upstreamSeen.then(() => sleep(150)) });
      await sleep(2_000);
      ok(or.chat - c0 === 1 && fac.settle === s0, `e. hang-up ${i} from the same wallet: ran, not settled`);
    }
    or.chatDelayMs = 0;
    const c0 = or.chat, s0 = fac.settle;
    const r = await pay(CHAT, WD);
    const body = await r.json().catch(() => ({}));
    ok(r.status === 429 && or.chat === c0 && fac.settle === s0, `e. the fourth call from that wallet is refused 429 before the handler (status ${r.status}, chat stub +${or.chat - c0}, settles +${fac.settle - s0})`);
    ok(/^\d+$/.test(r.headers.get("retry-after") || "") && /Nothing was charged/.test(body.error || "") && /abandoned before their answer arrived/.test(body.error || ""), `e. the 429 carries Retry-After and names both causes (${String(body.error).slice(0, 90)}...)`);
    const r2 = await pay(CHAT, wallet(0xe2));
    ok(r2.status === 200 && fac.settle === s0 + 1, `e. another wallet is served and settles (status ${r2.status}) - strikes never feed the global pause`);
    ok((await refunds()).length === 1, "e. still no debt for any cancelled charge");
  }

  // g. Control: the buyer reads the WHOLE answer, then drops the socket. An
  // ordinary settled sale: no debt, no hang-up line, no strike.
  {
    const WG = wallet(0x61);
    or.chatDelayMs = 0;
    const s0 = fac.settle, logAt = serverLog.length;
    const headers = await headersFor(CHAT, WG);
    const status = await new Promise((resolve) => {
      const req = httpRequest(`${B}${CHAT.path}`, { method: "POST", headers });
      req.on("response", (res) => { let n = 0; res.on("data", (c) => { n += c.length; }); res.on("end", () => { req.destroy(); resolve(res.statusCode); }); });
      req.on("error", () => resolve(0));
      req.write(CHAT.body); req.end();
    });
    await sleep(300);
    ok(status === 200 && fac.settle === s0 + 1, `g. a buyer who read the whole answer and then closed: served and settled once (status ${status})`);
    ok((await refunds()).length === 1 && !/\[hangup\]/.test(logSince(logAt)), "g. no debt and no hang-up line for a delivered answer");
    const r = await pay(CHAT, WG);
    ok(r.status === 200, `g. and no strike: that wallet's next call is served (${r.status})`);
  }

  if (process.env.HANGUP_TEST_SHOW_LOG) console.log(serverLog.filter((l) => /\[hangup\]/.test(l)).join("\n"));
  console.log(`\nPASS - ${pass} checks (a buyer gone before the first byte is not charged)`);
  cleanup();
  process.exit(0);
} catch (e) {
  fail(`unexpected: ${e?.stack || e}`);
}
