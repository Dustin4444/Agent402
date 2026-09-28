#!/usr/bin/env node
// What a paid external purchase leaves behind when it does not deliver: the
// spend hold, the chain wallet's 24 h booking, the fallthrough to another
// seller, and the router's refusal memo. Offline: stub sellers (global fetch,
// or a local socket), a throwaway signing key, and an injected chain reader, so
// nothing is spent and no network is touched.
//
// Three rules, each with the honest path beside it as a control:
//
//   1. A paid request that got NO answer (a timeout, a reset) may have been
//      paid. It keeps its hold and its booking, and the router tries no other
//      seller for that request - unless no byte of it ever left us (a connect-
//      phase error), and the booking is lowered only when the chain shows the
//      credential expired unused.
//   2. A candidate that provably spent nothing (unreachable, a bad 402, over
//      the cap, a refusal the chain proved unpaid) leaves no booking on the
//      chain's day, so a run of failures cannot pause routing for everyone.
//   3. The router's origin-wide refusal memo is written only by the router's
//      own purchase refused with 402/401 - never by a check whose URL a caller
//      chose, and never for a 4xx the caller's own input produced.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "router-paid-outcomes-"));
process.env.X402_UPSTREAM_BUYER_KEY = "0x" + randomBytes(32).toString("hex");
process.env.WALLET_DAILY_LEDGER_FILE = join(scratch, "wallet-daily-spend.json");
process.env.OUTBOUND_LEDGER_FILE = join(scratch, "outbound-spend.ndjson");
process.env.X402_INDEX_CRAWL = "off";

const buyer = await import("../src/x402-buyer.js");
const guard = await import("../src/external-spend-guard.js");
const { buildRouteExecuteTool, EXEC_TIERS } = await import("../src/tools/route-execute.js");
const { buildSellerPayabilityTool } = await import("../src/tools/seller-payability-kit.js");
const { payTempo } = await import("../src/tempo-buyer.js");

const origFetch = globalThis.fetch;
const origWarn = console.warn; const origLog = console.log;
let pass = 0, fail = 0;
// The payer logs every refusal it meets; those lines are muted below, so the
// verdicts write through the saved console.
const ok = (c, m) => { if (c) { pass++; origLog(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const quiet = () => { console.warn = () => {}; console.log = () => {}; };
const loud = () => { console.warn = origWarn; console.log = origLog; };

// ---------------------------------------------------------------------------
// Stub sellers, keyed by host. Each decides its bare answer and its paid answer.
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const accept = (amount = "1000") => ({ scheme: "exact", network: "eip155:8453", asset: USDC, amount, payTo: "0x" + "5e".repeat(20), maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } });
const r402 = (amount) => new Response("{}", { status: 402, headers: { "payment-required": b64({ x402Version: 2, accepts: [accept(amount)] }), "content-type": "application/json" } });
const receipt = b64({ success: true, transaction: "0x" + "ab".repeat(32), network: "eip155:8453" });
const timeoutErr = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");
const netErr = (code) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });
const SELLERS = {
  // answers the bare call, then the paid request never comes back
  "hang.example": { paid: () => { throw timeoutErr(); } },
  // the connection carrying the paid request is reset mid-exchange
  "reset.example": { paid: () => { throw netErr("UND_ERR_SOCKET"); } },
  // the paid request's connection is refused: nothing left us
  "refused-conn.example": { paid: () => { throw netErr("ECONNREFUSED"); } },
  // takes the payment and delivers
  "good.example": { paid: () => new Response(JSON.stringify({ answer: 42 }), { status: 200, headers: { "content-type": "application/json", "payment-response": receipt } }) },
  // refuses the payment itself
  "refuser.example": { paid: () => new Response(JSON.stringify({ error: "payment_verification_failed" }), { status: 402, headers: { "content-type": "application/json" } }) },
  "unauth.example": { paid: () => new Response("{}", { status: 401, headers: { "content-type": "application/json" } }) },
  // judges the REQUEST after verifying payment: the caller's input was wrong
  "picky.example": { paid: () => new Response(JSON.stringify({ error: "url is required" }), { status: 400, headers: { "content-type": "application/json" } }) },
  "picky422.example": { paid: () => new Response(JSON.stringify({ error: "invalid params" }), { status: 422, headers: { "content-type": "application/json" } }) },
  // fails after payment with no receipt
  "broken.example": { paid: () => new Response("Internal Server Error", { status: 500, headers: { "content-type": "text/plain" } }) },
  // fail BEFORE anything is signed
  "bare500.example": { bare: () => new Response("down", { status: 500 }) },
  "notfound.example": { bare: () => new Response("nope", { status: 404 }) },
  "overcap.example": { bare: () => r402("9000000") },
  // wrong EIP-712 domain on the Base accept: unsignable, refused before signing
  "wrongdomain.example": { bare: () => new Response("{}", { status: 402, headers: { "payment-required": b64({ x402Version: 2, accepts: [{ ...accept(), extra: { name: "USDC", version: "2" } }] }) } }) },
};
const hits = {};
const stubFetch = async (url, init = {}) => {
  const host = new URL(String(url)).host;
  const s = SELLERS[host];
  if (!s) throw netErr("ENOTFOUND");
  const h = init.headers || {};
  const paidReq = !!(h["PAYMENT-SIGNATURE"] || h["payment-signature"] || h["X-PAYMENT"]);
  const k = `${host} ${paidReq ? "paid" : "bare"}`;
  hits[k] = (hits[k] || 0) + 1;
  if (paidReq) return s.paid();
  return s.bare ? s.bare() : r402();
};
const count = (host, leg) => hits[`${host} ${leg}`] || 0;

// Chain readers the payer consults after a refusal or an unanswered request.
const CHAIN = {
  unused: async () => ({ debited: false, observed: 1, expired: true }),
  consumed: async () => ({ debited: true, observed: 1 }),
  live: async () => ({ debited: false, observed: 1, expired: false }),
  unreadable: async () => { throw new Error("RPC 429"); },
};
let chainReader = CHAIN.consumed;
let chainAsked = null;
const notDebited = async (q) => { chainAsked = q; return chainReader(q); };
const buy = (host, opts = {}) => buyer.payX402(`https://${host}/x`, { maxAtomic: 500000n, trusted: true, method: "POST", body: {}, chain: "base", notDebited, ...opts }).then((r) => ({ r }), (e) => ({ e }));

globalThis.fetch = stubFetch;
quiet();

// ===========================================================================
// 1. A PAID REQUEST THAT GOT NO ANSWER
// ===========================================================================
{
  // Pure classifier: only errors that prove no byte left us are "never sent".
  const { neverLeftUs } = buyer;
  ok(typeof neverLeftUs === "function", "the payer exports its never-sent classifier");
  if (typeof neverLeftUs === "function") {
    ok(neverLeftUs(netErr("ECONNREFUSED")) && neverLeftUs(netErr("ENOTFOUND")) && neverLeftUs(netErr("UND_ERR_CONNECT_TIMEOUT")) && neverLeftUs(netErr("ESSRFBLOCKED")),
      "refused, unresolvable, connect-timeout and SSRF-blocked connections are never-sent");
    ok(!neverLeftUs(timeoutErr()) && !neverLeftUs(netErr("UND_ERR_SOCKET")) && !neverLeftUs(netErr("ECONNRESET")) && !neverLeftUs(new Error("boom")),
      "a timeout, a reset, a socket closed mid-exchange and an unknown error may have delivered the header");
    const agg = (codes) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new AggregateError(codes.map((c) => Object.assign(new Error(c), { code: c }))), { code: codes[0] }) });
    ok(neverLeftUs(agg(["ECONNREFUSED", "ECONNREFUSED"])) && !neverLeftUs(agg(["ECONNREFUSED", "ECONNRESET"])), "an aggregate counts as never-sent only when every attempt was");
  }

  // RULE: the paid request times out. The seller may already hold our signed
  // authorization, so the attempt is committed and the hold stands.
  for (const [label, reader] of [["the chain shows the nonce consumed", CHAIN.consumed], ["the chain is unreadable", CHAIN.unreadable], ["the credential is still live", CHAIN.live]]) {
    chainReader = reader; chainAsked = null;
    const held = buyer._spentThisWindow();
    const { e } = await buy("hang.example");
    ok(e && e.committed === true && e.paidUnanswered === true, `timeout on the paid request, ${label} -> committed + paidUnanswered (got committed=${e?.committed}, paidUnanswered=${e?.paidUnanswered})`);
    ok(buyer._spentThisWindow() === held + 1000n, `timeout, ${label} -> the spend hold STANDS (held ${buyer._spentThisWindow() - held} of 1000)`);
    ok(e && e.statusCode === 502 && /may have settled/.test(e.message), `timeout, ${label} -> 502 saying the payment may have settled`);
  }
  ok(chainAsked && /^0x[0-9a-f]{64}$/i.test(chainAsked.nonce || "") && Number.isFinite(chainAsked.untilUnix) && chainAsked.chain === "base",
    "the unanswered path asks the chain about the nonce we signed, until its expiry (the refusal path's own reader)");

  // The chain proves the credential expired unused: the hold is released,
  // the error says nothing was charged - and still carries paidUnanswered.
  chainReader = CHAIN.unused;
  {
    const held = buyer._spentThisWindow();
    const { e } = await buy("hang.example");
    ok(e && e.committed === false && e.paidUnanswered === true && buyer._spentThisWindow() === held, "timeout + the chain shows the credential expired unused -> hold released, uncommitted, still flagged unanswered");
    ok(e && /expired unused, nothing charged/.test(e.message), "and the error says nothing was charged");
  }
  // A reset mid-exchange is treated like a timeout.
  chainReader = CHAIN.consumed;
  {
    const held = buyer._spentThisWindow();
    const { e } = await buy("reset.example");
    ok(e && e.committed === true && e.paidUnanswered === true && buyer._spentThisWindow() === held + 1000n, "a socket reset on the paid request -> committed, hold stands");
  }
  // CONTROL: a connect-phase failure sent nothing - hold released, no stamp,
  // exactly as before.
  {
    const held = buyer._spentThisWindow();
    const { e } = await buy("refused-conn.example");
    ok(e && e.committed !== true && e.paidUnanswered !== true && buyer._spentThisWindow() === held, "CONTROL: a refused connection on the paid leg sent nothing -> no stamp, hold released");
  }
  // CONTROL: a delivered purchase is unchanged.
  {
    const { r, e } = await buy("good.example");
    ok(r && r.result?.answer === 42 && r.receipt?.transaction, `CONTROL: a delivered purchase returns the result and receipt${e ? ` (threw ${e.message})` : ""}`);
  }

  // A REAL SOCKET: the seller accepts the paid request and never answers.
  // undici's own timeout error must take the same path.
  loud(); globalThis.fetch = origFetch; quiet();
  const sockets = new Set();
  let paidSeen = 0;
  const srv = createServer((req, res) => {
    const paid = req.headers["payment-signature"] || req.headers["x-payment"];
    if (!paid) {
      res.writeHead(402, { "payment-required": b64({ x402Version: 2, accepts: [accept()] }), "content-type": "application/json" });
      return res.end("{}");
    }
    paidSeen++; // read the request, never answer
  });
  srv.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  chainReader = CHAIN.consumed;
  const held = buyer._spentThisWindow();
  let e = null;
  try { await buyer.payX402(`http://127.0.0.1:${srv.address().port}/x`, { maxAtomic: 500000n, trusted: true, method: "POST", body: {}, chain: "base", timeoutMs: 400, notDebited }); } catch (x) { e = x; }
  ok(paidSeen === 1, "real socket: the seller received the paid request");
  ok(e && e.committed === true && e.paidUnanswered === true && e.cause?.name === "TimeoutError", `real socket: undici's timeout is committed + paidUnanswered (cause ${e?.cause?.name})`);
  ok(buyer._spentThisWindow() === held + 1000n, "real socket: the hold stands");

  // The same rule on the payer's second transport: a seller edge whose framing
  // fetch() rejects is retried once over undici.request with the SAME payment
  // header, so an unanswered retry is committed too. fetch() is made to reject
  // the paid leg that way; the retry reaches the real socket and hangs.
  paidSeen = 0;
  globalThis.fetch = async (url, init = {}) => {
    const h = init.headers || {};
    if (h["PAYMENT-SIGNATURE"] || h["X-PAYMENT"]) throw Object.assign(new TypeError("fetch failed"), { cause: new Error("invalid content-length header") });
    return origFetch(url, init);
  };
  const held2 = buyer._spentThisWindow();
  let e2 = null;
  try { await buyer.payX402(`http://127.0.0.1:${srv.address().port}/x`, { maxAtomic: 500000n, trusted: true, method: "POST", body: {}, chain: "base", timeoutMs: 400, notDebited }); } catch (x) { e2 = x; }
  ok(paidSeen === 1, "fallback transport: the retry reached the seller with the payment header");
  ok(e2 && e2.committed === true && e2.paidUnanswered === true && buyer._spentThisWindow() === held2 + 1000n, `fallback transport: an unanswered retry is committed and keeps the hold (committed=${e2?.committed})`);
  for (const s of sockets) s.destroy();
  srv.close();
  globalThis.fetch = stubFetch;
}

// ---------------------------------------------------------------------------
// Route-execute on top: fallthrough and the chain's 24 h booking.
const PRO = EXEC_TIERS.find((t) => t.slug === "route-execute-pro");
const cand = (host, price = "$0.001") => ({ seller: `https://${host}`, slug: host.split(".")[0], url: `https://${host}/x`, method: "POST", price, networks: ["eip155:8453"] });
const routeTool = (list) => buildRouteExecuteTool({
  getCatalog: () => ({}), tier: PRO,
  resolveExternal: async () => list,
  // Wired the way server.js wires the router: memoizeDelivery on.
  payExternal: (url, opts) => buyer.payX402(url, { ...opts, trusted: true, memoizeDelivery: true, notDebited }),
  externalEnabled: () => true, externalChains: () => ["base"],
});
let ipSeq = 0;
const route = async (list, params = {}) => {
  const req = { ip: `198.51.100.${++ipSeq}` };
  try { return { r: await routeTool(list).handler({ task: "t", include: "external", params }, req), payer: `ip:${req.ip}` }; }
  catch (e) { return { e, payer: `ip:${req.ip}` }; }
};
const baseDay = () => guard.walletDailySpentUsd("base");
const near = (a, b) => Math.abs(a - b) < 1e-9;

// ===========================================================================
// 1b. ROUTE-EXECUTE: NO SECOND SELLER AFTER AN UNANSWERED PAID REQUEST
// ===========================================================================
{
  for (const [label, reader] of [["possibly paid", CHAIN.consumed], ["chain unreadable", CHAIN.unreadable]]) {
    guard.__reset(); chainReader = reader;
    const before = count("good.example", "paid");
    const { e, payer } = await route([cand("hang.example"), cand("good.example")]);
    ok(e && e.statusCode === 502 && count("good.example", "paid") === before, `RULE (${label}): a timed-out paid request is not followed by a second seller in the same request (good.example paid ${count("good.example", "paid") - before}x)`);
    ok(near(baseDay(), PRO.underlyingMaxUsd) && near(guard.payerExposureUsd(payer), PRO.underlyingMaxUsd), `RULE (${label}): the worst-case booking stands on the chain day and the payer ($${baseDay()})`);
  }
  // The chain proves the credential expired unused: the booking goes, the
  // fallthrough still does not happen in this request.
  guard.__reset(); chainReader = CHAIN.unused;
  {
    const before = count("good.example", "paid");
    const { e, payer } = await route([cand("hang.example"), cand("good.example")]);
    ok(e && count("good.example", "paid") === before, "timed out + chain proves unused -> still no second seller in this request");
    ok(near(baseDay(), 0) && near(guard.payerExposureUsd(payer), 0), `timed out + chain proves unused -> nothing stays booked ($${baseDay()})`);
  }
  // CONTROL: a connection refused on the paid leg sent nothing; the router
  // moves on and the next seller serves, as before.
  guard.__reset(); chainReader = CHAIN.consumed;
  {
    const { r, e } = await route([cand("refused-conn.example"), cand("good.example")]);
    ok(r && r.result?.answer === 42 && r.receipt?.seller === "https://good.example", `CONTROL: a never-sent paid leg still falls through to the next seller${e ? ` (threw ${e.message})` : ""}`);
    ok(near(baseDay(), 0.001), `CONTROL: only the delivered purchase stays booked ($${baseDay()})`);
  }
  // CONTROL: a refusal the chain proves unpaid still falls through.
  guard.__reset(); chainReader = CHAIN.unused;
  {
    const { r } = await route([cand("refuser.example"), cand("good.example")]);
    ok(r && r.receipt?.seller === "https://good.example" && near(baseDay(), 0.001), `CONTROL: a chain-proven refusal falls through and leaves only the delivered purchase booked ($${baseDay()})`);
  }
}

// ===========================================================================
// 2. PROVABLY UNPAID CANDIDATES LEAVE NO BOOKING ON THE CHAIN'S DAY
// ===========================================================================
{
  guard.__reset(); chainReader = CHAIN.consumed;
  const failing = [cand("bare500.example"), cand("overcap.example"), cand("notfound.example")];
  // RULE: route-execute-pro calls whose candidates all fail before anything
  // is signed, from a fresh payer each time (every call is refused, so none is
  // ever charged), leave nothing on the chain's day: more of them than the
  // day's ceiling could hold at the tier cap still leave routing open.
  const outcomes = [];
  for (let i = 0; i < 6; i++) outcomes.push(await route(failing));
  ok(near(baseDay(), 0), `RULE: six all-failing pro calls leave $0 booked on the Base day (got $${baseDay()})`);
  ok(outcomes.every(({ e }) => e && !/paused for everyone/.test(e.message)), `RULE: no call is refused as "paused for everyone" (${outcomes.map(({ e }) => e?.statusCode).join(",")})`);
  ok(guard.maySpend("ip:203.0.113.9", PRO.underlyingMaxUsd, { chain: "base" }).ok, "RULE: a new buyer can still book a pro call on Base afterwards");
  ok(count("notfound.example", "bare") >= 6, `each call reaches every candidate: a pre-signature miss no longer uses up the payer's ceiling (third candidate tried ${count("notfound.example", "bare")}x)`);

  // CONTROL: a candidate that MAY have been paid keeps its booking.
  guard.__reset();
  {
    const { e } = await route([cand("broken.example")]);
    ok(e && near(baseDay(), PRO.underlyingMaxUsd), `CONTROL: a paid leg answering 500 with no receipt keeps the worst-case booking ($${baseDay()})`);
  }
  // CONTROL: a delivered purchase books what the seller quoted.
  guard.__reset();
  {
    const { r } = await route([cand("good.example")]);
    ok(r && near(baseDay(), 0.001), `CONTROL: a delivered purchase books the quote ($${baseDay()})`);
  }
  // CONTROL: the day's ceiling still refuses when real spend fills it.
  guard.__reset();
  {
    guard.noteSpend("ip:192.0.2.1", 24.5, { chain: "base" });
    const { e } = await route([cand("good.example")]);
    ok(e && e.statusCode === 429 && /paused for everyone/.test(e.message), "CONTROL: spend that really left the wallet still pauses the chain at its ceiling");
  }

  // Tempo: every failure after the credential is handed over is stamped
  // committed (nothing on that rail proves otherwise), so route-execute keeps
  // its booking; a refusal before minting carries no stamp.
  loud(); globalThis.fetch = origFetch; quiet();
  const { Challenge } = await import("mppx");
  const TEMPO_USDC = "0x20C000000000000000000000b9537d11c60E8b50";
  const tempoChallenge = (amount = "2000") => Challenge.serialize(Challenge.from({
    realm: "seller.test", method: "tempo", intent: "charge", expires: new Date(Date.now() + 60_000),
    request: { amount, currency: TEMPO_USDC, recipient: "0x" + "11".repeat(20), methodDetails: { chainId: 4217, feePayer: true } }, secretKey: "seller-secret",
  }));
  let tempoMode = "reject";
  const tsrv = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (/^Payment /.test(req.headers.authorization || "")) {
        if (tempoMode === "hang") return; // never answers
        res.writeHead(tempoMode === "reject" ? 402 : 500, { "www-authenticate": tempoChallenge() });
        return res.end("{}");
      }
      res.writeHead(402, { "www-authenticate": tempoChallenge(tempoMode === "expensive" ? "900000" : "2000") });
      res.end("{}");
    });
  });
  const tsock = new Set();
  tsrv.on("connection", (s) => { tsock.add(s); s.on("close", () => tsock.delete(s)); });
  await new Promise((r) => tsrv.listen(0, "127.0.0.1", r));
  const tempoBuy = () => payTempo(`http://127.0.0.1:${tsrv.address().port}/v1/scrape`, { method: "POST", body: {}, maxAtomic: 5000n, trusted: true, timeoutMs: 400, createCredential: async () => "Payment ZmFrZQ", proof: async () => 4000 }).then(() => null, (e) => e);
  for (const mode of ["reject", "fail", "hang"]) {
    tempoMode = mode;
    const e = await tempoBuy();
    ok(e && e.committed === true, `Tempo: a paid request answered ${mode === "reject" ? "402" : mode === "fail" ? "500" : "with nothing"} is committed (the booking stays)`);
  }
  tempoMode = "expensive";
  {
    const e = await tempoBuy();
    ok(e && e.committed !== true && /exceeds this call's ceiling/.test(e.message), "Tempo CONTROL: an over-cap quote refused before minting carries no stamp (nothing spent)");
  }
  for (const s of tsock) s.destroy();
  tsrv.close();
  globalThis.fetch = stubFetch;
}

// ===========================================================================
// 3. THE REFUSAL MEMO: ONLY THE ROUTER'S OWN PURCHASE, ONLY 402/401
// ===========================================================================
{
  const memo = (host) => buyer.sellerRefusedRecently(`https://${host}`, "base");
  chainReader = CHAIN.unused;
  // RULE: a check whose URL and body the caller chose (no memoizeDelivery)
  // writes nothing, whatever the seller answers.
  buyer.__resetSellerRefusalsForTest();
  for (const host of ["picky.example", "refuser.example", "wrongdomain.example"]) await buy(host);
  ok(!memo("picky.example") && !memo("refuser.example") && !memo("wrongdomain.example"), "RULE: a caller-directed purchase (no memoizeDelivery) benches no origin - a 400, a 402 or an unsignable accept alike");

  // RULE: the router's own purchase answered 400/422 - the seller judging the
  // caller's input - is not a refusal of our payment.
  buyer.__resetSellerRefusalsForTest();
  for (const host of ["picky.example", "picky422.example"]) {
    const { e } = await buy(host, { memoizeDelivery: true });
    ok(!memo(host), `RULE: the router's purchase answered ${host === "picky.example" ? 400 : 422} (the caller's input) writes no refusal memo`);
    ok(e && e.committed === false, `...and the chain's proof still releases the hold (${host})`);
  }
  // Through route-execute with the caller's params producing that 4xx.
  guard.__reset();
  {
    const { e } = await route([cand("picky.example")], { wrong: "params" });
    ok(e && !memo("picky.example"), "RULE: a route-execute caller's bad params bench no seller");
  }
  // Through the seller-payability tool, wired as server.js wires it (the payer
  // with the caller's options passed through unchanged).
  {
    const tool = buildSellerPayabilityTool({
      pay: (url, opts) => buyer.payX402(url, { ...opts, trusted: true, notDebited }),
      fetchImpl: (url, init) => stubFetch(url, init),
      assertPublicUrl: async () => {},
    });
    for (const host of ["refuser.example", "picky.example"]) {
      const out = await tool.handler({ url: `https://${host}/x`, body: { any: "thing" } }, { ip: "192.0.2.50" });
      ok(out && out.payment?.attempted === true && !memo(host), `RULE: a $0.10 payability check against ${host} benches nothing in the router`);
    }
  }

  // CONTROL: the router's own purchase refused with 402 or 401, the chain
  // proving it unpaid, is memoized exactly as before.
  buyer.__resetSellerRefusalsForTest();
  for (const [host, st] of [["refuser.example", 402], ["unauth.example", 401]]) {
    const { e } = await buy(host, { memoizeDelivery: true });
    ok(memo(host)?.status === st && e?.refused === true && e?.committed === false, `CONTROL: the router's purchase refused with ${st} (chain: unused) is memoized and falls through as before`);
  }
  // CONTROL: an unsignable accept met by the router is memoized as before.
  {
    const { e } = await buy("wrongdomain.example", { memoizeDelivery: true });
    ok(e?.refused === true && memo("wrongdomain.example")?.status === 402, "CONTROL: the router meeting an unsignable Base accept still memoizes the origin");
  }
  // CONTROL: a refusal the chain has not proven is still never memoized.
  buyer.__resetSellerRefusalsForTest();
  chainReader = CHAIN.live;
  {
    const { e } = await buy("refuser.example", { memoizeDelivery: true });
    ok(!memo("refuser.example") && e?.committed === true, "CONTROL: a refusal with the credential still live is neither memoized nor released");
  }
}

// ---------------------------------------------------------------------------
// Call-site pins: the rules above are inert unless the callers use them.
{
  const { readFileSync } = await import("node:fs");
  const re = readFileSync(new URL("../src/tools/route-execute.js", import.meta.url), "utf8");
  const katch = re.slice(re.indexOf("} catch (e) {", re.indexOf("paid = await payExternal(")), re.indexOf("const ts = new Date().toISOString();", re.indexOf("paid = await payExternal(")));
  ok(/if \(!spentMaybe\) adjustSpend\(spendHandle, 0\)/.test(katch), "route-execute lowers a candidate's booking only when the payer did not stamp it committed");
  ok(/!spentMaybe && !unanswered && chain !== "tempo"/.test(katch), "route-execute falls through only when the attempt is neither committed nor unanswered");
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/payExternal: \(url, opts\) => \(opts\?\.chain === "tempo" \? payTempo\(url, opts\) : payX402\(url, \{ \.\.\.opts, memoizeDelivery: true \}\)\)/.test(server),
    "only the router's own purchases opt into the memos (server.js payExternal)");
  const pay = readFileSync(new URL("../src/x402-buyer.js", import.meta.url), "utf8");
  ok(/if \(memoizeDelivery\) noteSellerRefusal\(/.test(pay) && /const memoize = memoizeDelivery && \(paid\.status === 402 \|\| paid\.status === 401\);\n\s*if \(memoize\) noteSellerRefusal\(sellerOrigin, chain, paid\.status\)/.test(pay),
    "both refusal-memo writes in the payer are gated on the router's opt-in, the paid-retry one on 402/401");
  ok((pay.match(/noteSellerRefusal\(/g) || []).length === 3, "no other refusal-memo write exists in the payer (definition + two gated calls)");
}

loud();
globalThis.fetch = origFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
