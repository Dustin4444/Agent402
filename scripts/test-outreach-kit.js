#!/usr/bin/env node
// outreach-kit — offline. payX402 and the spend guard are stubs; validation,
// the per-payer and global daily budgets, the seller body mapping, the error
// mapping (never a 402 of our own), the spend booking and the envelope run for
// real. Registrations pinned from source.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.X402_INDEX_CRAWL = "off";
const kit = await import("../src/tools/outreach-kit.js");
const guard = await import("../src/external-spend-guard.js");
const { makeOutreachHandlers, OUTREACH_TOOLS, OUTREACH_ROUTES, OUTREACH_MAX_ATOMIC, normalizePhone, normalizeEmail, budgetCheck, budgetNote, __resetBudgets, payerKeyOf } = kit;

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); };
const eq = (a, b, m) => { n++; assert.equal(a, b, m); };
const rejects = async (fn, status, re) => { n++; try { await fn(); assert.fail(`expected ${status}`); } catch (e) { assert.equal(e.statusCode, status, `${String(e.message).slice(0, 100)} -> status`); if (re) assert.match(String(e.message), re); } };

// --- validation
eq(normalizePhone(" +1 (415) 555-2671 "), "+14155552671", "E.164 with punctuation");
eq(normalizePhone("4155552671"), null, "no + -> refused");
eq(normalizePhone("+0123"), null, "too short / leading zero refused");
eq(normalizePhone("+1234567890123456"), null, "16 digits refused");
eq(normalizeEmail("Agent@Example.com"), "Agent@Example.com", "email kept");
eq(normalizeEmail("nope"), null, "junk email refused");

// --- budgets
__resetBudgets();
const t0 = Date.parse("2026-09-03T12:00:00Z");
ok(budgetCheck("evm:0xa", { now: t0, perPayer: 2, global: 3 }).ok, "fresh payer allowed");
budgetNote("evm:0xa", t0); budgetNote("evm:0xa", t0);
ok(!budgetCheck("evm:0xa", { now: t0, perPayer: 2, global: 3 }).ok, "per-payer cap reached");
ok(budgetCheck("evm:0xb", { now: t0, perPayer: 2, global: 3 }).ok, "another payer still allowed");
budgetNote("evm:0xb", t0);
ok(!budgetCheck("evm:0xc", { now: t0, perPayer: 2, global: 3 }).ok, "global cap reached");
ok(budgetCheck("evm:0xa", { now: t0 + 86_400_000, perPayer: 2, global: 3 }).ok, "a new day resets");
eq(payerKeyOf({ ip: "1.2.3.4" }), "ip:1.2.3.4", "unsigned request keys on the ip");
eq(payerKeyOf({ mppTempoPayer: "did:pkh:x" }), "tempo:did:pkh:x", "tempo payer keyed");

// --- handlers against stubs
__resetBudgets(); guard.__reset();
const calls = [];
const stubPay = async (url, opts) => { calls.push({ url, opts }); return { result: { id: "msg_1", status: "queued" }, quote: { atomic: "1000", usd: 0.001, network: "eip155:8453" }, receipt: { transaction: "0x" + "ab".repeat(32), network: "eip155:8453" } }; };
const logs = [];
const H = makeOutreachHandlers({ payX402: stubPay, now: () => t0, log: (l) => logs.push(l) });
const req = { ip: "9.9.9.9" };

await rejects(() => H["sms-send"]({ to: "4155552671", message: "hi" }, req), 400, /E\.164/);
await rejects(() => H["sms-send"]({ to: "+14155552671", message: "" }, req), 400, /required/);
await rejects(() => H["sms-send"]({ to: "+14155552671", message: "x".repeat(1001) }, req), 400, /over 1000/);
eq(calls.length, 0, "nothing paid on a refusal");
const sms = await H["sms-send"]({ to: "+1 415 555 2671", message: "Report ready" }, req);
eq(calls[0].url, "https://win.oneshotagent.com/v1/tools/sms/send", "seller route");
assert.deepEqual(calls[0].opts.body, { to_number: "+14155552671", message: "Report ready" }, "seller body mapping"); n++;
eq(calls[0].opts.maxAtomic, OUTREACH_MAX_ATOMIC["sms-send"], "margin guard rides as maxAtomic");
eq(calls[0].opts.chain, "base", "paid from the Base wallet");
ok(sms.sent === true && sms.channel === "sms" && sms.seller === "win.oneshotagent.com" && sms.upstream.usd === 0.001 && sms.upstream.tx === "0x" + "ab".repeat(32) && sms.result.id === "msg_1" && sms.to === "+14155552671" && sms.chars === 12, "sms envelope");
ok(logs.length === 1 && !logs[0].includes("4155552671"), "the destination is hashed in the log, never in clear");
const spent = guard.walletDailySpentUsd("base");
ok(spent > 0 && spent <= 0.0011, `spend booked against base and corrected to the quote (${spent})`);

const em = await H["email-send"]({ to: "agent@example.com", subject: "Hello", body: "Body", fromName: "Agent402" }, req);
assert.deepEqual(calls[1].opts.body, { to_address: "agent@example.com", subject: "Hello", body: "Body", from_name: "Agent402" }, "email body mapping"); n++;
eq(em.channel, "email", "email envelope");
await rejects(() => H["email-send"]({ to: "nope", subject: "s", body: "b" }, req), 400, /email/);

const vc = await H["voice-call"]({ to: "+14155552671", objective: "Confirm", persona: "Assistant", maxMinutes: 3 }, req);
assert.deepEqual(calls[2].opts.body, { target_number: "+14155552671", objective: "Confirm", caller_persona: "Assistant", max_duration_minutes: 3 }, "voice body mapping"); n++;
eq(calls[2].opts.maxAtomic, 14000n, "voice cap");
eq(vc.channel, "voice", "voice envelope");
await rejects(() => H["voice-call"]({ to: "+14155552671", objective: "x", maxMinutes: 11 }, req), 400, /1 to 10/);
await rejects(() => H["voice-call"]({ to: "+14155552671", objective: "x", maxMinutes: 1.5 }, req), 400, /integer/);

// --- per-payer budget refuses 429 before any spend
__resetBudgets();
process.env.OUTREACH_MAX_PER_PAYER_DAY = "1";
const before = calls.length;
await H["sms-send"]({ to: "+14155552671", message: "one" }, req);
await rejects(() => H["sms-send"]({ to: "+14155552671", message: "two" }, req), 429, /daily limit per payer/);
eq(calls.length, before + 1, "the refused send never reached the seller");
delete process.env.OUTREACH_MAX_PER_PAYER_DAY;
__resetBudgets();

// --- error mapping: never our own 402; wallet 503; seller 502; over-cap 503
const mk = (err) => makeOutreachHandlers({ payX402: async () => { throw err; }, now: () => t0, log: () => {} });
await rejects(() => mk(Object.assign(new Error("Upstream buyer wallet not configured (X402_UPSTREAM_BUYER_KEY) - ..."), { statusCode: 503 }))["sms-send"]({ to: "+14155552671", message: "m" }, req), 503, /spending wallet/);
await rejects(() => mk(Object.assign(new Error("Seller quote 20000 atomic exceeds the 5000 cap - refusing to pay"), { statusCode: 402 }))["sms-send"]({ to: "+14155552671", message: "m" }, req), 503, /ceiling/);
await rejects(() => mk(Object.assign(new Error("Seller upstream error (HTTP 500)"), { statusCode: 502 }))["sms-send"]({ to: "+14155552671", message: "m" }, req), 502, /did not deliver/);
const paused = makeOutreachHandlers({ payX402: stubPay, spend: { maySpend: () => ({ ok: false, reason: "wallet daily ceiling reached." }), noteSpend: () => null, adjustSpend: () => {} }, now: () => t0, log: () => {} });
await rejects(() => paused["sms-send"]({ to: "+14155552671", message: "m" }, req), 503, /paused/);

// --- catalog + registrations
eq(OUTREACH_TOOLS.length, 3, "three tools");
for (const t of OUTREACH_TOOLS) {
  ok(t.route === `POST /api/${t.slug}` && t.discovery.bodyType === "json" && OUTREACH_ROUTES[t.slug], `${t.slug}: POST route, bodyType, seller route`);
  const priceAtomic = BigInt(Math.round(parseFloat(t.price.replace("$", "")) * 1e6));
  ok(OUTREACH_MAX_ATOMIC[t.slug] <= (priceAtomic * 7n) / 10n, `${t.slug}: upstream cap under 70% of price`);
  ok(!/\+1[2-9]\d{9}/.test(JSON.stringify(t.discovery.input).replace("+15005550006", "")), `${t.slug}: example carries no real-looking number`);
}
const pow = readFileSync(new URL("../src/pow.js", import.meta.url), "utf8");
ok(/"sms-send", "email-send", "voice-call"/.test(pow), "wallet-only (never PoW: spends from the wallet)");
const nm = readFileSync(new URL("./test-non-metered-examples.js", import.meta.url), "utf8");
ok(/"sms-send", "email-send", "voice-call"/.test(nm), "metered in CI (no wallet there)");
const ta = readFileSync(new URL("./test-all.js", import.meta.url), "utf8");
ok(ta.includes('"/api/sms-send", "/api/email-send", "/api/voice-call"'), "test-all NETWORK");
const runner = readFileSync(new URL("../src/tools/skill-runner.js", import.meta.url), "utf8");
ok(runner.includes('"agent-outreach": {'), "agent-outreach pack has steps");

console.log(`test-outreach-kit: ${n} assertions ok`);
