#!/usr/bin/env node
// The Algorand accept leaves SUB-CENT routes while the facilitator's sponsored
// sub-cent allowance for our payTo is spent (src/avm-sponsorship.js), and a
// facilitator billing refusal is never the buyer's settle failure.
//
// Found 2026-09-28 in the deploy logs: the facilitator refused every sub-cent
// settle with `subcent_quota_exceeded`, our 402s kept offering Algorand on
// those routes, @x402/express served each paid call before settling it, and
// the settle breaker then refused the buyer with a message blaming their
// wallet. Part 1 pins the pure rules; part 2 boots a PAID server against stub
// facilitators (EVM + Algorand, both local) with a stub /sponsorship/status,
// and drives the real 402, the real matching and the real settle path.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { getFreePorts } from "./lib/free-port.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const g = await import("../src/avm-sponsorship.js");
const ALGO = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
const PAYTO = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ";
const OTHER = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const exhaustedRow = { chain: "algorand", usedMonth: 1013, quota: 1000, suBalance: 0 };
const headroomRow = { chain: "algorand", usedMonth: 12, quota: 1000, suBalance: 0 };
const req = (amount, over = {}) => ({ scheme: "exact", network: ALGO, asset: "31566704", amount: String(amount), payTo: PAYTO, maxTimeoutSeconds: 300, extra: {}, ...over });
const base = (amount) => ({ scheme: "exact", network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: String(amount), payTo: "0xdead", extra: {} });

// ---- Part 1: the pure rules ------------------------------------------------
{
  const logs = [];
  g._resetAvmSponsorshipForTest({ logger: (m) => logs.push(m) });

  // The facilitator's own document: usedMonth lives only in the chains[] row.
  ok(g.sponsorshipRowOf({ quota: 1000, chains: [{ chain: "base" }, exhaustedRow] }) === exhaustedRow, "the Algorand row is read from chains[]");
  ok(g.sponsorshipRowOf({ quota: 1000 }) === null && g.sponsorshipRowOf(null) === null, "no chains[] row -> null");
  ok(g.isSponsorshipExhausted(exhaustedRow), "used >= quota with no purchased units is exhausted");
  ok(!g.isSponsorshipExhausted(headroomRow), "used < quota is headroom");
  ok(!g.isSponsorshipExhausted({ ...exhaustedRow, suBalance: 25000 }), "purchased Settlement Units are headroom even past the quota");
  ok(!g.isSponsorshipExhausted({ chain: "algorand", quota: "n/a" }) && !g.isSponsorshipExhausted(null), "an unreadable row is NOT exhausted (fail open)");

  // Which requirement is sub-cent Algorand USDC.
  ok(g.isAvmSubcentRequirement(req(1000)) && g.isAvmSubcentRequirement(req(9999)), "$0.001 and $0.009999 on Algorand USDC are sub-cent");
  ok(!g.isAvmSubcentRequirement(req(10000)) && !g.isAvmSubcentRequirement(req(50000)), "one cent and above is not");
  ok(!g.isAvmSubcentRequirement(base(1000)), "an EVM requirement never is");
  ok(!g.isAvmSubcentRequirement(req(1000, { asset: "12345" })), "an asset whose decimals we do not know is left alone");
  ok(!g.isAvmSubcentRequirement(req("0.001")) && !g.isAvmSubcentRequirement(req(1000, { amount: undefined })), "an unreadable amount is left alone");
  ok(g.isAvmSubcentRequirement(req(1000, { asset: "10458941", network: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe" })), "testnet USDC counts the same (six decimals)");

  // The filter.
  const list = [base(1000), req(1000), req(1000, { payTo: OTHER })];
  const pausedOnly = (p) => p === PAYTO;
  const out = g.withoutPausedSubcentAvm(list, pausedOnly);
  ok(out.length === 2 && out[0] === list[0] && out[1] === list[2], "drops the sub-cent Algorand requirement of the paused payTo, keeps Base and the other payTo");
  ok(g.withoutPausedSubcentAvm([base(10000), req(10000)], () => true).length === 2, "a one-cent route keeps Algorand while paused");
  ok(g.withoutPausedSubcentAvm(list, () => false) === list, "nothing paused -> the SAME array back");
  ok(g.withoutPausedSubcentAvm([req(1000)], () => true).length === 1, "never empties the list (a 402 nobody can pay is worse)");

  // Status reads drive the pause; transitions log once each.
  const t0 = Date.UTC(2026, 8, 28, 2, 0, 0);
  ok(!g.isSubcentPaused(PAYTO, t0), "nothing known -> offered");
  ok(g.noteSponsorshipStatus(PAYTO, null, { now: t0 }) === "unreadable" && !g.isSubcentPaused(PAYTO, t0), "an unreadable status on a fresh boot keeps Algorand offered");
  ok(g.noteSponsorshipStatus(PAYTO, exhaustedRow, { now: t0 }) === "exhausted" && g.isSubcentPaused(PAYTO, t0 + 1000), "an exhausted status pauses the payTo");
  ok(!g.isSubcentPaused(OTHER, t0 + 1000), "...and only that payTo");
  g.noteSponsorshipStatus(PAYTO, exhaustedRow, { now: t0 + 60_000 });
  ok(logs.filter((l) => /PAUSED/.test(l)).length === 1, `logged once per transition, not per read (got ${logs.filter((l) => /PAUSED/.test(l)).length})`);
  ok(logs.some((l) => /PAUSED/.test(l) && /1013\/1000/.test(l) && !l.includes(PAYTO)), "the log names the facilitator's own figures and masks the payTo");
  ok(g.noteSponsorshipStatus(PAYTO, null, { now: t0 + 120_000 }) === "unreadable" && g.isSubcentPaused(PAYTO, t0 + 120_000), "an unreadable read keeps fresh evidence");
  ok(!g.isSubcentPaused(PAYTO, t0 + 60_000 + g.STALE_MS + 1), "evidence older than the stale window offers the rail again (fail open)");
  {
    // Crossed while the evidence is still FRESH (40 s old), so only the month
    // rule can reopen it: a check days later would pass on staleness alone.
    const lastSecond = Date.UTC(2026, 8, 30, 23, 59, 30);
    g.noteSponsorshipStatus(OTHER, exhaustedRow, { now: lastSecond });
    ok(g.isSubcentPaused(OTHER, lastSecond + 20_000), "paused in the month's last minute");
    ok(!g.isSubcentPaused(OTHER, Date.UTC(2026, 9, 1, 0, 0, 10)), "the UTC month turning offers it again at once, on fresh evidence (the allowance resets on the 1st)");
    g.noteSponsorshipStatus(OTHER, headroomRow, { now: lastSecond + 60_000 });
  }
  ok(g.noteSponsorshipStatus(PAYTO, headroomRow, { now: t0 + 180_000 }) === "headroom" && !g.isSubcentPaused(PAYTO, t0 + 180_000), "a status read showing headroom clears the pause");
  ok(logs.filter((l) => /OFFERED again/.test(l) && /headroom/.test(l) && l.includes("AAAAAA…HFKQ")).length === 1, "...and says so, once");

  // The settle refusal itself pauses at once, and a read that began BEFORE it cannot clear it.
  const t1 = t0 + 300_000;
  ok(!g.noteAvmSettleRefusal({ network: ALGO, payTo: PAYTO, reason: "insufficient_funds", now: t1 }) && !g.isSubcentPaused(PAYTO, t1), "a buyer-side refusal pauses nothing");
  ok(!g.noteAvmSettleRefusal({ network: "eip155:43114", payTo: PAYTO, reason: "subcent_quota_exceeded", now: t1 }), "a non-Algorand network pauses nothing");
  ok(g.noteAvmSettleRefusal({ network: ALGO, payTo: PAYTO, reason: "[Algorand (x)] subcent_quota_exceeded", now: t1 }) && g.isSubcentPaused(PAYTO, t1 + 1), "a subcent_quota_exceeded settle pauses the payTo immediately");
  ok(g.noteSponsorshipStatus(PAYTO, headroomRow, { now: t1 + 500, readStartedAt: t1 - 200 }) === "predates-refusal" && g.isSubcentPaused(PAYTO, t1 + 500), "a headroom read that STARTED before the refusal does not clear it");
  ok(g.noteSponsorshipStatus(PAYTO, headroomRow, { now: t1 + 900, readStartedAt: t1 + 600 }) === "headroom" && !g.isSubcentPaused(PAYTO, t1 + 900), "a headroom read started after it does");

  // /api/rails wording: status words and times, never the payTo or the counts.
  g.noteSponsorshipStatus(PAYTO, exhaustedRow, { now: Date.now() });
  const st = g.avmSubcentOfferStatus();
  ok(st.length === 1 && st[0].network === "algorand" && st[0].status === "paused" && typeof st[0].since === "string", "a pause is published for /api/rails");
  ok(!JSON.stringify(st).includes(PAYTO) && !/1013|1000/.test(JSON.stringify(st)), "...without the payTo or the facilitator's counts");
  g.noteSponsorshipStatus(PAYTO, headroomRow, { now: Date.now() });
  ok(g.avmSubcentOfferStatus().length === 0, "and nothing when open");

  // The switch.
  process.env.AVM_SUBCENT_GATE = "off";
  ok(!g.noteAvmSettleRefusal({ network: ALGO, payTo: PAYTO, reason: "subcent_quota_exceeded" }), "AVM_SUBCENT_GATE=off disarms the refusal flip");
  delete process.env.AVM_SUBCENT_GATE;

  // The prototype patch: once, filtering the finished list, keeping the inner patch's marker.
  const { installAcceptOutputSchema } = await import("../src/accept-output-schema.js");
  class FakeServer {
    async buildPaymentRequirementsFromOptions(options) { return options.map((o) => ({ ...o })); }
    findMatchingRequirements(avail, p) { return avail.find((r) => r.network === p?.accepted?.network) || null; }
  }
  ok(installAcceptOutputSchema(FakeServer) === true, "the outputSchema patch installs first");
  ok(g.installAvmSubcentGate(FakeServer) === true && g.installAvmSubcentGate(FakeServer) === false, "the gate installs once");
  ok(installAcceptOutputSchema(FakeServer) === false, "...and the outputSchema patch still sees its own marker through it (no double wrap)");
  g._resetAvmSponsorshipForTest({ logger: () => {} });
  g.noteSponsorshipStatus(PAYTO, exhaustedRow);
  const built = await new FakeServer().buildPaymentRequirementsFromOptions([base(1000), req(1000), req(10000)]);
  ok(built.length === 2 && built.every((r) => !g.isAvmSubcentRequirement(r)), "the patched build drops the paused sub-cent Algorand requirement and keeps the one-cent one");

  // The refresher: reads the live status on its own timer, fails open, recovers.
  g._resetAvmSponsorshipForTest({ logger: () => {} });
  let mode = "exhausted"; const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (mode === "error") return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ quota: 1000, chains: [mode === "exhausted" ? exhaustedRow : headroomRow] }) };
  };
  const stop = g.startAvmSponsorshipRefresher({ facilitatorUrl: "http://facilitator.test/", payTos: [PAYTO], intervalMs: 20, firstDelayMs: 1, fetchImpl });
  await sleep(80);
  ok(urls[0] === `http://facilitator.test/sponsorship/status?wallet=${PAYTO}` && g.isSubcentPaused(PAYTO), "the timer reads /sponsorship/status for our payTo and pauses on an exhausted answer");
  mode = "error"; await sleep(80);
  ok(g.isSubcentPaused(PAYTO), "an unreadable status keeps the fresh evidence");
  mode = "headroom"; await sleep(80);
  ok(!g.isSubcentPaused(PAYTO), "headroom on a later read offers Algorand again");
  stop();
  const n = urls.length; await sleep(60);
  ok(urls.length === n, "stop() ends the reads");
  ok(g.startAvmSponsorshipRefresher({ facilitatorUrl: "", payTos: [PAYTO], fetchImpl })() === undefined, "no facilitator URL -> no timer (and a harmless stop)");

  // Where it is wired (source pins).
  const pay = readFileSync(new URL("../src/payments.js", import.meta.url), "utf8");
  ok(pay.indexOf("installAvmSubcentGate(x402ResourceServer)") > pay.indexOf("installAcceptOutputSchema(x402ResourceServer)"), "payments.js installs the gate after the outputSchema patch, so it filters the finished list");
  ok(/if \(isFacilitatorBillingRefusal\([^)]*\)\) \{[\s\S]{0,700}noteAvmSettleRefusal\(/.test(pay), "the settle-failure hook flips the pause on the refusal itself");
  const callSites = (readFileSync(new URL("../src/server.js", import.meta.url), "utf8").match(/startAvmSponsorshipRefresher\(/g) || []).length;
  ok(callSites === 0 && (pay.match(/startAvmSponsorshipRefresher\(/g) || []).length === 1, "the status read starts once, at boot, never from a request path");
}

// ---- Part 2: booted, against stub facilitators ------------------------------
{
  const [PORT, FAC] = await getFreePorts(2);
  const B = `http://127.0.0.1:${PORT}`;
  let status = "error", settleMode = "quota", verifies = 0, settles = 0;
  const fac = createServer((rq, rs) => {
    let body = ""; rq.on("data", (c) => (body += c)); rq.on("end", () => {
      const reply = (code, obj) => { rs.writeHead(code, { "Content-Type": "application/json" }); rs.end(JSON.stringify(obj)); };
      const [pathOnly] = rq.url.split("?");
      if (pathOnly === "/evm/supported") return reply(200, { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
      if (pathOnly === "/avm/supported") return reply(200, { kinds: [{ x402Version: 2, scheme: "exact", network: ALGO }], extensions: [], signers: {} });
      if (pathOnly === "/avm/sponsorship/status") {
        if (status === "error") return reply(500, { error: "down" });
        return reply(200, { quota: 1000, chains: [status === "exhausted" ? exhaustedRow : headroomRow] });
      }
      if (pathOnly.endsWith("/verify")) { verifies++; return reply(200, { isValid: true, payer: PAYTO }); }
      if (pathOnly === "/avm/settle") {
        settles++;
        if (settleMode === "quota") return reply(200, { success: false, errorReason: "subcent_quota_exceeded", errorMessage: "subcent_quota_exceeded", transaction: "", network: ALGO });
        if (settleMode === "quota-thrown") return reply(400, { success: false, errorReason: "subcent_quota_exceeded", transaction: "", network: ALGO });
        return reply(200, { success: true, transaction: "TX" + settles, network: ALGO, payer: PAYTO });
      }
      if (pathOnly.endsWith("/settle")) { settles++; return reply(200, { success: true, transaction: "0x" + "cd".repeat(32), network: "eip155:8453" }); }
      return reply(404, {});
    });
  });
  await new Promise((r) => fac.listen(FAC, "127.0.0.1", r));
  const serverLog = [];
  const proc = spawn("node", ["src/server.js"], {
    env: {
      ...process.env, PORT: String(PORT), FREE_MODE: "",
      WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
      PAYMENT_NETWORKS: "base,algorand", ALGORAND_WALLET_ADDRESS: PAYTO,
      CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", FACILITATOR_URL: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "",
      PAYAI_FACILITATOR_URL: `http://127.0.0.1:${FAC}/evm`, ALGORAND_FACILITATOR_URL: `http://127.0.0.1:${FAC}/avm`,
      ALGORAND_UPSTREAM_BUYER_ADDRESS: "", MPP_SECRET_KEY: "", PAYMENT_SETTLE_FALLBACK: "", AVM_SUBCENT_GATE: "",
      AVM_SPONSORSHIP_REFRESH_MS: "250", AGENT402_BASE_RPC: `http://127.0.0.1:${FAC}/rpc`,
      GATEWAY_SETTLE_BREAKER_MAX: "3", GATEWAY_SETTLE_BREAKER_WINDOW_MS: "600000",
      X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", WALLET_DIGEST: "off", SOLANA_LEADERBOARD: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const keep = (c) => { for (const l of String(c).split("\n")) if (l.trim()) serverLog.push(l.slice(0, 400)); if (serverLog.length > 200) serverLog.splice(0, serverLog.length - 200); };
  proc.stdout.on("data", keep); proc.stderr.on("data", keep);
  const done = (code) => { proc.kill("SIGKILL"); fac.close(); if (code) for (const l of serverLog.slice(-30)) console.error("  server:", l); console.log(`\n${pass} passed, ${fail} failed`); process.exit(code); };

  const HASH = { path: "/api/hash", body: JSON.stringify({ text: "x" }) };          // $0.001, sub-cent
  const CENT = { path: "/api/solidity-scan", body: JSON.stringify({ source: "pragma solidity ^0.8.0;\ncontract C { function f() external {} }" }) }; // $0.01
  const offer402 = async (t) => {
    const r = await fetch(`${B}${t.path}`, { method: "POST", headers: { "content-type": "application/json" }, body: t.body });
    const pr = r.status === 402 ? JSON.parse(Buffer.from(r.headers.get("payment-required") || "", "base64").toString("utf8")) : null;
    return { status: r.status, pr, avm: (pr?.accepts || []).find((a) => String(a.network).startsWith("algorand:")) || null };
  };
  let n = 0;
  const payAvm = async (t, accepted) => fetch(`${B}${t.path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "payment-signature": Buffer.from(JSON.stringify({ x402Version: 2, accepted, payload: { paymentGroup: [Buffer.from(`group-${++n}-${Date.now()}`).toString("base64")], paymentIndex: 0 } })).toString("base64") },
    body: t.body,
  });
  const waitFor = async (cond, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await sleep(100); } return false; };

  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) { try { up = (await fetch(`${B}/health`)).ok; } catch { /* booting */ } if (!up) await sleep(500); }
    if (!up) { ok(false, "paid server booted"); done(1); }
    await sleep(700); // a few status reads (all failing: status "error")

    // Unreadable status: fail open.
    const h0 = await offer402(HASH), c0 = await offer402(CENT);
    ok(h0.status === 402 && !!h0.avm && h0.avm.amount === "1000", `unreadable status: the $0.001 route still offers Algorand (amount ${h0.avm?.amount})`);
    ok(!!c0.avm && c0.avm.amount === "10000", "and the $0.01 route offers it");
    const rails0 = await (await fetch(`${B}/api/rails`)).json();
    ok(Array.isArray(rails0.restrictions) && rails0.restrictions.length === 0, "/api/rails lists no restriction while open");

    // Exhausted status: the sub-cent 402 drops Algorand, the one-cent 402 keeps it.
    status = "exhausted";
    ok(await waitFor(async () => !(await offer402(HASH)).avm), "exhausted status: the $0.001 route stops offering Algorand");
    const h1 = await offer402(HASH), c1 = await offer402(CENT);
    ok(h1.pr.accepts.some((a) => a.network === "eip155:8453"), "...and still offers Base");
    {
      const { parsePaymentRequired } = await import("@x402/core/schemas");
      const parsed = parsePaymentRequired(h1.pr);
      ok(parsed.success && h1.pr.accepts[0]?.outputSchema !== undefined, `the withdrawn 402 is still valid under the protocol's own schema, first accept still carrying outputSchema (${parsed.success ? "valid" : parsed.error.issues[0]?.message})`);
    }
    ok(!!c1.avm, "the $0.01 route keeps its Algorand accept");
    const rails1 = await (await fetch(`${B}/api/rails`)).json();
    ok(rails1.restrictions?.[0]?.network === "algorand" && rails1.restrictions[0].status === "paused" && !JSON.stringify(rails1).includes(PAYTO), "/api/rails publishes the pause, status words only");
    ok(serverLog.some((l) => /\[avm-subcent\] Algorand PAUSED/.test(l)), "the transition is logged");

    // A buyer holding the earlier Algorand accept is refused BEFORE the handler.
    {
      const v = verifies, s = settles;
      const r = await payAvm(HASH, h0.avm);
      const b = await r.json().catch(() => ({}));
      ok(r.status === 402 && verifies === v && settles === s, `an Algorand payment on the withdrawn route is a pre-handler 402: nothing verified, nothing served, nothing settled (status ${r.status}, verifies +${verifies - v}, settles +${settles - s})`);
      ok(b.retry === "choose-offered-option" && /not offered/.test(b.hint || ""), `...and the refusal says to pick an offered network (got ${b.reason}: ${String(b.hint).slice(0, 80)})`);
    }

    // Headroom: Algorand returns to sub-cent routes.
    status = "headroom";
    ok(await waitFor(async () => !!(await offer402(HASH)).avm), "headroom on a later read: the $0.001 route offers Algorand again");

    // The settle refusal itself flips it, without waiting for a status read.
    status = "error"; await sleep(400);
    for (const mode of ["quota", "quota-thrown"]) {
      settleMode = mode;
      const accepted = (await offer402(HASH)).avm;
      if (!accepted) { ok(await waitFor(async () => !!(await offer402(HASH)).avm, 1500), `(${mode}) Algorand offered before the paid call`); }
      const s = settles;
      const r = await payAvm(HASH, accepted || (await offer402(HASH)).avm);
      const b = await r.json().catch(() => ({}));
      ok(r.status === 402 && settles === s + 1, `(${mode}) a sub-cent Algorand payment was served and then refused at settle (status ${r.status})`);
      ok(b.reason === "facilitator-quota" && b.retry === "other-network" && /Algorand facilitator/.test(b.hint || "") && /not because of your wallet/.test(b.hint || ""), `(${mode}) the 402 names the rail and clears the wallet (got ${b.reason}: ${String(b.hint).slice(0, 70)})`);
      const after = await offer402(HASH);
      ok(!after.avm && after.pr.accepts.length > 0, `(${mode}) the very next sub-cent 402 no longer offers Algorand (flipped by the refusal)`);
      ok(!!(await offer402(CENT)).avm, `(${mode}) the $0.01 route keeps Algorand`);
      // Clear it for the next mode: a status read started after the refusal, showing headroom.
      status = "headroom";
      ok(await waitFor(async () => !!(await offer402(HASH)).avm), `(${mode}) headroom read afterwards restores it`);
      status = "error"; await sleep(400);
    }

    // A one-cent route settles normally throughout.
    settleMode = "ok";
    {
      const r = await payAvm(CENT, (await offer402(CENT)).avm);
      ok(r.status === 200, `a $0.01 Algorand payment settles (status ${r.status})`);
    }
  } catch (e) {
    ok(false, `booted leg threw: ${e?.stack || e}`);
  }
  done(fail ? 1 : 0);
}
