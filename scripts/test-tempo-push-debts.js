// Tempo PUSH transfers that reach us unclaimed are booked as owed, and a
// claim that is later served voids that debt (src/tempo-push-debts.js wired
// into createTempoGate, against the REAL refund ledger in a scratch dir).
//
//   - refused on input, never retried: exactly one owed row (hash, chain
//     sender, amount), no charged failure;
//   - refused on input, then presented again with a corrected body and
//     served: the row is void ("claimed on retry") and the sale booked once;
//   - refused twice: booked once;
//   - finalize refused: one owed row AND one genuine charged failure (not for
//     our own synthetic traffic); an already-claimed hash books nothing;
//   - a transfer whose debt is being refunded no longer pays for a request.
// The relay and the chain are stubs: offline, nothing moves.
import express from "express";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Challenge, Credential } from "mppx";

process.env.REFUND_DB_DIR = mkdtempSync(join(tmpdir(), "a402-push-debts-"));
const TREASURY = "0x000000000000000000000000000000000000dEaD";
const CUR = "0x2000000000000000000000000000000000000000";
process.env.TEMPO_API_KEY = "test-tempo-key";
process.env.TEMPO_RECIPIENT_ADDRESS = TREASURY;
process.env.TEMPO_CURRENCY = CUR;

const { createTempoGate } = await import("../src/mpp-tempo.js");
const { createTempoPushDebts, PUSH_INPUT_REFUSED_NOTE, PUSH_CLAIMED_NOTE, PUSH_FINALIZE_FAILURE_STATUS, PUSH_HANGUP_AFTER_CLAIM_NOTE } = await import("../src/tempo-push-debts.js");
const { isRepeatHangup, isLastingEffectHangup, HANGUP_STATUS } = await import("./refund-run.js");
const ledger = await import("../src/refund-ledger.js");
const { createReplayGuard } = await import("../src/replay-guard.js");

let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error("FAIL:", m); process.exit(1); } };

const SECRET = "push-debts-secret";
const REALM = "test.local";
const SENDER = "0x5555555555555555555555555555555555555555";
const priceFor = (_m, path) => (path === "/paid" ? { priceUsd: 0.05 } : null);
let n = 0;
const hashFor = (i) => `0x${i.toString(16).padStart(64, "0")}`;
function pushCred(hash) {
  const challenge = Challenge.from({ realm: REALM, method: "tempo", intent: "charge", expires: new Date(Date.now() + 60_000), request: { amount: "50000", currency: CUR, decimals: 6, recipient: TREASURY, methodDetails: { chainId: 4217 } }, secretKey: SECRET });
  return Credential.serialize({ challenge, payload: { hash, type: "hash" }, source: "did:pkh:eip155:4217:0x1111111111111111111111111111111111111111" });
}

const failures = [];
const sales = [];
let synthetic = false;
let failNext = null;
const debts = createTempoPushDebts({
  recordOwed: ledger.recordRefundOwed, voidOnClaim: ledger.voidOwedOnClaim, renoteOwed: ledger.renoteOwedRefund, promoteToHangup: ledger.promoteOwedToHangup, refundByEvidence: ledger.refundByEvidence,
  recordChargedFailure: (slug, status) => failures.push({ slug, status }),
  isSynthetic: () => synthetic,
  slugOf: () => "paid-tool",
});
const app = express();
app.use(express.json());
// server.js's finish path, reduced to what matters here: a settled 200 is a
// sale, and a served push claim voids its debt.
// served() is called on EVERY finish here (server.js calls it on a 200 only):
// its own guard must refuse to void anything that was not a served claim.
app.use((req, res, next) => { res.on("finish", () => { if (res.statusCode === 200 && req.tempoSettled) sales.push(req.mppTempoPushHash); debts.served(req, res); }); next(); });
app.use(createTempoGate({
  secretKey: SECRET, realm: REALM, priceFor, replayGuard: createReplayGuard(),
  preValidate: (req) => (req.body?.text ? null : { status: 400, body: { error: "Missing required parameter: text" } }),
  validate: async () => ({ ok: true, validation: {} }),
  broadcast: async () => { if (failNext) { const f = failNext; failNext = null; return f; } return { ok: true, receipt: { method: "tempo", status: "success", reference: `0xr${++n}`, timestamp: new Date().toISOString() } }; },
  pushSender: async () => SENDER,
  onPushNotClaimed: (req, info) => debts.notClaimed(req, info),
  onPushInputRefused: (req, info) => debts.inputRefused(req, info),
  pushClaimAllowed: (hash) => !["sending", "paid"].includes(ledger.refundByEvidence(hash)?.status),
}));
app.use((req, res, next) => (req.tempoSettling ? next() : res.status(402).json({ error: "Payment Required" })));
app.post("/paid", (req, res) => (req.body?.text === "boom" ? res.status(500).json({ error: "handler failed" }) : res.json({ ok: true })));
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const url = `http://127.0.0.1:${server.address().port}/paid`;
const post = async (cred, body) => { const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", Authorization: cred }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const rowsFor = (hash) => ledger.listRefunds({ status: "all", limit: 1000 }).filter((r) => r.evidence === hash);

// Control: a clean push buy books a sale and no debt.
{
  const h = hashFor(1);
  const r = await post(pushCred(h), { text: "x" });
  ok(r.status === 200 && sales.filter((s) => s === h).length === 1 && rowsFor(h).length === 0 && failures.length === 0, "control: a push buy with a valid body is served, booked once, and owes nothing");
}

// Refused on input, never retried: one owed row under the chain sender.
{
  const h = hashFor(2);
  const r = await post(pushCred(h), {});
  const rows = rowsFor(h);
  ok(r.status === 400 && r.body.transferClaimed === false && /recorded as owed/.test(r.body.payment || ""), `input refused: 400, transfer unclaimed, and the answer says it is recorded as owed (${JSON.stringify(r.body)})`);
  ok(rows.length === 1 && rows[0].status === "owed" && rows[0].network === "tempo" && rows[0].payer === SENDER && rows[0].priceUsd === 0.05 && rows[0].note === PUSH_INPUT_REFUSED_NOTE && rows[0].wire === "mpp-tempo" && rows[0].httpStatus === 400,
    `input refused and never retried: exactly one owed row keyed on the hash, under the chain-read sender (${JSON.stringify(rows)})`);
  ok(failures.length === 0 && sales.every((s) => s !== h), "input refused: no charged failure counted (the buyer can still claim it) and no sale");
}

// Refused twice (same credential), then retried with a corrected body: one
// row, void on the served claim, one sale.
{
  const h = hashFor(3);
  const cred = pushCred(h);
  await post(cred, {});
  await post(cred, {});
  ok(rowsFor(h).length === 1 && rowsFor(h)[0].status === "owed", "refused twice: booked once");
  const r = await post(cred, { text: "fixed" });
  const rows = rowsFor(h);
  ok(r.status === 200 && rows.length === 1 && rows[0].status === "void" && rows[0].note.includes(PUSH_CLAIMED_NOTE) && rows[0].note.includes(PUSH_INPUT_REFUSED_NOTE),
    `refused then served on retry: the debt is void ("${rows[0]?.note}"), never both refunded and served`);
  ok(sales.filter((s) => s === h).length === 1 && failures.length === 0, "...and the sale is booked exactly once");
  // A later refusal of the (now claimed) credential books nothing new: the
  // replay guard refuses it before the input check.
  const again = await post(cred, {});
  ok(again.status === 402 && rowsFor(h).length === 1 && rowsFor(h)[0].status === "void", "the claimed credential presented again is a replay, and the void row stays void");
}

// Refused on input, then claimed on retry but the handler FAILED: the debt
// stands (the transfer is claimed and nothing was delivered).
{
  const h = hashFor(9);
  const cred = pushCred(h);
  await post(cred, {});
  const r = await post(cred, { text: "boom" });
  ok(r.status === 500 && rowsFor(h).length === 1 && rowsFor(h)[0].status === "owed" && sales.every((s) => s !== h), `refused, then claimed but the handler failed: the debt stays owed (${r.status}, ${rowsFor(h)[0]?.status})`);
}

// Finalize refused: owed and counted as a genuine charged failure, once.
{
  const h = hashFor(4);
  failNext = { ok: false, cls: "unknown", error: "relay said no", reason: "relay said no" };
  const r = await post(pushCred(h), { text: "x" });
  const rows = rowsFor(h);
  ok(r.status === 402 && r.body.details?.refundOwed === true && rows.length === 1 && rows[0].status === "owed" && rows[0].payer === SENDER, `finalize refused: 402 with the debt booked (${JSON.stringify(rows)})`);
  ok(failures.length === 1 && failures[0].status === PUSH_FINALIZE_FAILURE_STATUS && failures[0].status !== 402, `finalize refused: one charged failure, recorded with a status the genuine count includes (${JSON.stringify(failures)})`);
  // The same hash refused on input earlier, then refused at finalize: still
  // one row, and counted once when it becomes a finalize failure.
  const h2 = hashFor(5);
  const c2 = pushCred(h2);
  await post(c2, {});
  failNext = { ok: false, cls: "unknown", error: "relay said no", reason: "relay said no" };
  await post(c2, { text: "x" });
  ok(rowsFor(h2).length === 1 && rowsFor(h2)[0].status === "owed" && failures.length === 2, `input refused then finalize refused: one row, one charged failure (${failures.length})`);
  ok(debts.notClaimed({ method: "POST", path: "/paid" }, { hash: h2, payer: SENDER, amountUsd: 0.05 }) === true && failures.length === 2, "a repeat finalize failure for the same hash counts nothing new");
  // Our own synthetic traffic: booked (flagged) but not counted.
  synthetic = true;
  const h3 = hashFor(6);
  failNext = { ok: false, cls: "unknown", error: "relay said no", reason: "relay said no" };
  await post(pushCred(h3), { text: "x" });
  synthetic = false;
  ok(rowsFor(h3).length === 1 && rowsFor(h3)[0].synthetic === 1 && failures.length === 2, "synthetic finalize failure: booked and flagged, not counted as a charged failure");
  // Already claimed for an earlier request: no debt, no count.
  const h4 = hashFor(7);
  failNext = { ok: false, cls: "replay", error: "Transaction hash has already been used", reason: "already used" };
  await post(pushCred(h4), { text: "x" });
  ok(rowsFor(h4).length === 0 && failures.length === 2, "finalize refused as already claimed: no debt, no count");
}

// A transfer whose debt is being refunded no longer pays for a request.
{
  const h = hashFor(8);
  const cred = pushCred(h);
  await post(cred, {});
  const row = rowsFor(h)[0];
  ok(ledger.claimRefundForSend(row.id, "test"), "setup: the debt is claimed for sending");
  const r = await post(cred, { text: "fixed" });
  ok(r.status === 402 && r.body.details?.reason === "refunded" && sales.every((s) => s !== h) && rowsFor(h)[0].status === "sending", `a transfer being refunded is refused, not claimed and served (${r.status} ${JSON.stringify(r.body.details)})`);
}

// Refused on input, then the corrected retry is claimed and the buyer hangs up
// before the first byte. server.js's recordHangupDebt books a 499 on the same
// hash; INSERT OR IGNORE kept the stale 400 "input refused" row, so the
// planner's hang-up holds never applied. hungUp promotes it.
{
  const h = hashFor(10);
  await post(pushCred(h), {});
  const hangupRow = { slug: "paid-tool", network: "tempo", payer: SENDER, priceUsd: 0.05, tx: h, httpStatus: HANGUP_STATUS, synthetic: false, wire: "mpp-tempo", hangupReason: "payer budget" };
  ok(ledger.recordRefundOwed(hangupRow) === false, "setup: the disconnect insert on the same hash is ignored (the input-refused row holds it)");
  ok(debts.hungUp(h, "payer budget") === true, "hungUp promotes the owed input-refused row");
  const [row] = rowsFor(h);
  ok(rowsFor(h).length === 1 && row.status === "owed" && row.httpStatus === 499 && row.hangupReason === "payer budget" && row.note.includes(PUSH_INPUT_REFUSED_NOTE) && row.note.includes(PUSH_HANGUP_AFTER_CLAIM_NOTE),
    `the row is now the disconnect it is: 499, the reason, and a note that says it was claimed then disconnected (${JSON.stringify(row)})`);
  ok(isRepeatHangup(row) === true, "...so the planner's repeat-hang-up hold applies to it");
  ok(isLastingEffectHangup({ ...row, slug: "route-execute" }) === true, "...and so does the lasting-effect hold (keyed on 499 + slug)");
  ok(debts.hungUp(h, "no ticket") === false && rowsFor(h)[0].hangupReason === "payer budget", "a second promotion changes nothing (the note no longer reads the input refusal)");
  // Controls: never a row that is being sent, paid or void; never a finalize-refused row.
  const hs = hashFor(11);
  await post(pushCred(hs), {});
  // Claimed with its note unchanged, so only the status guard stands between it and a rewrite.
  ok(ledger.claimRefundForSend(rowsFor(hs)[0].id, PUSH_INPUT_REFUSED_NOTE), "setup: claimed for sending, note unchanged");
  ok(debts.hungUp(hs, "no ticket") === false && rowsFor(hs)[0].status === "sending" && rowsFor(hs)[0].httpStatus === 400, "a row being sent is never rewritten");
  const hv = hashFor(12);
  const cv = pushCred(hv);
  await post(cv, {}); await post(cv, { text: "fixed" });
  ok(rowsFor(hv)[0].status === "void" && debts.hungUp(hv, "no ticket") === false && rowsFor(hv)[0].httpStatus === 400, "a void row (claimed and served) is never rewritten");
  const hf = hashFor(13);
  failNext = { ok: false, cls: "unknown", error: "relay said no", reason: "relay said no" };
  await post(pushCred(hf), { text: "x" });
  ok(debts.hungUp(hf, "no ticket") === false && rowsFor(hf)[0].httpStatus === 402, "a finalize-refused row is not a disconnect and is never rewritten");
  ok(debts.hungUp(hashFor(14), "no ticket") === false && rowsFor(hashFor(14)).length === 0, "no row, nothing written");
}

// The void path never touches a row that is not owed, and needs a note.
{
  ok(ledger.voidOwedOnClaim(hashFor(8), PUSH_CLAIMED_NOTE) === false && rowsFor(hashFor(8))[0].status === "sending", "voidOwedOnClaim leaves a row being sent alone");
  ok(ledger.voidOwedOnClaim(hashFor(2), "") === false && rowsFor(hashFor(2))[0].status === "owed", "voidOwedOnClaim requires a note");
}

// Wiring pin: server.js builds these hooks from the same module and runs the
// served() void at the sale.
{
  const src = (await import("node:fs")).readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/createTempoPushDebts\(\{[\s\S]{0,300}recordOwed: recordRefundOwed[\s\S]{0,300}recordChargedFailure/.test(src), "server.js builds the push-debt hooks on the refund ledger and the charged-failure tally");
  ok(/onPushNotClaimed: \(req, info\) => tempoPushDebts\.notClaimed/.test(src) && /onPushInputRefused: \(req, info\) => tempoPushDebts\.inputRefused/.test(src) && /pushClaimAllowed:/.test(src), "server.js passes all three push hooks to the Tempo gate");
  ok(/countChargedFailuresGenuine = db\.prepare\("SELECT COUNT\(\*\) AS n FROM charged_failures WHERE status <> 402"\)/.test((await import("node:fs")).readFileSync(new URL("../src/stats.js", import.meta.url), "utf8")) && PUSH_FINALIZE_FAILURE_STATUS !== 402, "the genuine charged-failure count excludes only status 402, and a push finalize failure is not recorded as 402");
  ok(/recordSale\(\{[\s\S]{0,1200}tempoPushDebts\?\.served\(req, res\)/.test(src), "server.js voids a served push claim's debt right after booking the sale");
  const hang = src.slice(src.indexOf("function recordHangupDebt("), src.indexOf("function recordHangupOutcome("));
  ok(/tx: req\.tempoSettled \? \(tempoPushHashOf\(req\) \|\|/.test(hang), "a push disconnect is keyed on the credential's (lowercased) hash, the evidence the input-refused row used");
  ok(/if \(!created && req\.tempoSettled && tempoPushHashOf\(req\) === row\.tx\) created = tempoPushDebts\?\.hungUp\(row\.tx, hangupReason\)/.test(hang), "recordHangupDebt promotes an existing input-refused row instead of ignoring it");
  ok(/promoteToHangup: promoteOwedToHangup/.test(src), "server.js wires the promotion to the refund ledger");
  ok(/const tx = req\.tempoSettled \? \(tempoPushHashOf\(req\) \|\| tempoTxFromReceiptHeader/.test(src), "a push handler failure is keyed on the same hash too, so a mixed-case relay reference cannot book a second row for one transfer");
}

server.close();
console.log(`\n${pass} passed, 0 failed`);
process.exit(0);
