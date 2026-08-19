// Native MPP on Tempo for the tollbooth (0.9.0) - offline, stub relay.
// Run from the repo root (uses mppx from the root node_modules only to prove
// our dependency-free challenge interoperates with the reference codec).
import express from "express";
import { Challenge } from "mppx";
import { createTollbooth, tempoConfig, mintTempoChallenges, parseTempoCredential, checkTempoBinding, toBaseUnits, tempoFromEnv, TEMPO_USDC_E } from "./index.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };
const SECRET = "tollbooth-tempo-test-secret";
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const FEE_TO = "0x2222222222222222222222222222222222222222";
const b64url = (s) => Buffer.from(s, "utf8").toString("base64url");
const listen = (app) => new Promise((resolve) => { const server = app.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })); });

// ---- config + minting ----
ok(toBaseUnits("$0.001") === 1000n && toBaseUnits(0.05) === 50000n && toBaseUnits("1") === 1000000n, "toBaseUnits: $0.001 -> 1000, 0.05 -> 50000 at 6 decimals");
let threw = null; try { tempoConfig({ apiKey: "k", recipient: RECIPIENT, splits: [{ recipient: FEE_TO, amount: "0.001" }] }); } catch (e) { threw = e; }
ok(threw === null, "config: splits validated at config time (a split alone is fine - price check happens at mint)");
threw = null; try { tempoConfig({ apiKey: "", recipient: RECIPIENT }); } catch (e) { threw = e; }
ok(/apiKey/.test(threw?.message || ""), "config: apiKey required");
threw = null; try { tempoConfig({ apiKey: "k", recipient: "nope" }); } catch (e) { threw = e; }
ok(/recipient/.test(threw?.message || ""), "config: recipient must be a 0x address");
threw = null; try { tempoConfig({ apiKey: "k", recipient: RECIPIENT, splits: Array.from({ length: 11 }, () => ({ recipient: FEE_TO, amount: "0.0001" })) }); } catch (e) { threw = e; }
ok(/at most 10/.test(threw?.message || ""), "config: at most 10 splits");
const cfg = tempoConfig({ apiKey: "k", recipient: RECIPIENT, splits: [{ recipient: FEE_TO, amount: "0.0002" }], description: "tollbooth test" });
const www = mintTempoChallenges({ price: "$0.001", realm: "site.test", secretKey: SECRET, tempo: cfg });
ok(typeof www === "string" && /^Payment /.test(www), "mint: WWW-Authenticate value minted");
const parsed = Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": www }));
ok(parsed.length === 1 && parsed[0].method === "tempo" && parsed[0].intent === "charge", "mint: mppx parses our challenge as tempo/charge");
ok(Challenge.verify(parsed[0], { secretKey: SECRET }), "mint: mppx Challenge.verify agrees with our HMAC id binding");
const req0 = parsed[0].request;
ok(req0.amount === "1000" && req0.currency === TEMPO_USDC_E && req0.recipient === RECIPIENT && req0.methodDetails?.chainId === 4217 && req0.decimals === undefined, `mint: wire request is base units, no decimals, methodDetails.chainId (${JSON.stringify(req0).slice(0, 120)})`);
ok(Array.isArray(req0.methodDetails?.splits) && req0.methodDetails.splits[0].recipient === FEE_TO && req0.methodDetails.splits[0].amount === "200", "mint: splits ride in methodDetails in base units");
ok(mintTempoChallenges({ price: "$0.0001", realm: "site.test", secretKey: SECRET, tempo: cfg }) === null, "mint: a price the splits would exceed mints NOTHING (never an unpayable challenge)");
ok(mintTempoChallenges({ price: "$0.001", realm: "site.test", secretKey: SECRET, tempo: tempoConfig({ apiKey: "k", recipient: RECIPIENT, currencies: [TEMPO_USDC_E, "0x20c0000000000000000000000000000000000000"] }) }).split(", Payment ").length === 2, "mint: one challenge per configured currency");

// credential builder (payload shape a tempo client sends; the stub relay validates it)
const credFor = (challenge, over = {}) => `Payment ${b64url(JSON.stringify({ challenge: { ...challenge, ...over }, payload: { type: "transaction", signature: `0x${"ab".repeat(70)}` } }))}`;
const chObj = { id: parsed[0].id, realm: parsed[0].realm, method: "tempo", intent: "charge", request: www.match(/request="([^"]+)"/)[1], expires: parsed[0].expires };
const cred = parseTempoCredential(credFor(chObj));
ok(cred && cred.challenge.id === chObj.id && cred.payload.type === "transaction", "parseTempoCredential: well-formed tempo credential parses");
ok(parseTempoCredential("Payment zzz") === null && parseTempoCredential(`Payment ${b64url(JSON.stringify({ challenge: { ...chObj, method: "evm" }, payload: { type: "authorization" } }))}`) === null, "parseTempoCredential: garbage and evm credentials are not tempo");
ok(checkTempoBinding(cred, { secretKey: SECRET, realm: "site.test", price: "$0.001", tempo: cfg }).ok === true, "binding: our own challenge at this price binds");
ok(/HMAC/.test(checkTempoBinding(parseTempoCredential(credFor(chObj, { id: "x".repeat(43) })), { secretKey: SECRET, realm: "site.test", price: "$0.001", tempo: cfg }).reason), "binding: tampered id refused");
ok(/below this route's price/.test(checkTempoBinding(cred, { secretKey: SECRET, realm: "site.test", price: "$0.01", tempo: cfg }).reason), "binding: a $0.001 challenge does not buy a $0.01 route");
ok(/realm/.test(checkTempoBinding(cred, { secretKey: SECRET, realm: "other.test", price: "$0.001", tempo: cfg }).reason), "binding: realm must be ours");

// ---- env ----
ok(tempoFromEnv({}) === null, "env: no TOLLBOOTH_TEMPO_API_KEY -> off");
const envCfg = tempoFromEnv({ TOLLBOOTH_TEMPO_API_KEY: "k", TOLLBOOTH_TEMPO_RECIPIENT: RECIPIENT, TOLLBOOTH_TEMPO_SPLITS: `${FEE_TO}:0.0002` });
ok(envCfg.apiKey === "k" && envCfg.recipient === RECIPIENT && envCfg.splits[0].amount === "0.0002", "env: key, recipient, splits parse");

// ---- gate end to end (tempo-only, no x402 middleware) ----
const calls = { validate: [], broadcast: [] };
let broadcastOk = true, validateOk = true;
const relay = {
  async validate(input) { calls.validate.push(input); return validateOk ? { ok: true } : { ok: false, error: "relay HTTP 400 invalid_payment" }; },
  async broadcast(input, { idempotencyKey }) { calls.broadcast.push({ input, idempotencyKey }); return broadcastOk ? { ok: true, receipt: { method: "tempo", reference: `0x${"cd".repeat(32)}`, timestamp: new Date().toISOString() } } : { ok: false, error: "relay HTTP 503 temporarily_unavailable" }; },
};
const app = express();
let handlerRuns = 0, handlerStatus = 200;
app.use(createTollbooth({ price: "$0.001", mode: "all", pow: false, powSecret: SECRET, resourceBaseUrl: "https://site.test", tempo: { apiKey: "k", recipient: RECIPIENT, splits: [{ recipient: FEE_TO, amount: "0.0002" }], relay } }));
app.get("/paid", (req, res) => { handlerRuns++; res.status(handlerStatus).json({ result: "ok", runs: handlerRuns }); });
const { server, url } = await listen(app);

const r402 = await fetch(`${url}/paid`);
const wwwLive = r402.headers.get("www-authenticate") || "";
ok(r402.status === 402 && /method="tempo"/.test(wwwLive) && /realm="site.test"/.test(wwwLive), "gate: unpaid -> 402 with a tempo challenge (realm = resource base host), no x402 middleware needed");
const liveCh = Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": wwwLive }))[0];
const liveChObj = { id: liveCh.id, realm: liveCh.realm, method: "tempo", intent: "charge", request: wwwLive.match(/request="([^"]+)"/)[1], expires: liveCh.expires };
const paid = await fetch(`${url}/paid`, { headers: { Authorization: credFor(liveChObj) } });
const paidBody = await paid.json();
ok(paid.status === 200 && paidBody.result === "ok" && paid.headers.get("x-tollbooth-paid") === "mpp-tempo", `gate: a bound tempo credential is validated, served and broadcast (got ${paid.status})`);
ok(calls.validate.length === 1 && calls.broadcast.length === 1 && calls.broadcast[0].idempotencyKey.startsWith("mpp_") && calls.broadcast[0].input.challenge.id === liveCh.id, "gate: relay validate once BEFORE the handler, broadcast once AFTER with an idempotency key");
const receipt = paid.headers.get("payment-receipt");
ok(receipt && JSON.parse(Buffer.from(receipt, "base64url").toString()).method === "tempo", "gate: Payment-Receipt rides on the 200 (base64url JSON, method tempo)");
ok(handlerRuns === 1, "gate: handler ran exactly once");
// replay of the same credential
const again = await fetch(`${url}/paid`, { headers: { Authorization: credFor(liveChObj) } });
const againBody = await again.json();
ok(again.status === 402 && againBody.problem?.type === "https://paymentauth.org/problems/invalid-challenge" && /already used/.test(againBody.problem.detail) && handlerRuns === 1 && calls.broadcast.length === 1, "gate: replaying a spent credential -> 402 invalid-challenge problem, handler not run, nothing broadcast");
// handler failure -> no broadcast
const fresh = async () => { const r = await fetch(`${url}/paid`); const w = r.headers.get("www-authenticate"); const c = Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": w }))[0]; return { id: c.id, realm: c.realm, method: "tempo", intent: "charge", request: w.match(/request="([^"]+)"/)[1], expires: c.expires }; };
handlerStatus = 500;
const failed = await fetch(`${url}/paid`, { headers: { Authorization: credFor(await fresh()) } });
ok(failed.status === 500 && calls.broadcast.length === 1, "gate: a failing handler is never broadcast (buyer not charged), its own status passes through");
handlerStatus = 200;
// broadcast failure after success -> 402, body discarded
broadcastOk = false;
const bfail = await fetch(`${url}/paid`, { headers: { Authorization: credFor(await fresh()) } });
const bfailBody = await bfail.json();
ok(bfail.status === 402 && bfailBody.problem?.type === "https://paymentauth.org/problems/verification-failed" && bfailBody.result === undefined && /temporarily_unavailable/.test(bfailBody.problem.detail), "gate: broadcast failure after a successful handler -> 402 verification-failed, handler body discarded, relay reason surfaced");
broadcastOk = true;
// validate failure -> 402, handler never runs
validateOk = false;
const before = handlerRuns;
const vfail = await fetch(`${url}/paid`, { headers: { Authorization: credFor(await fresh()) } });
const vfailBody = await vfail.json();
ok(vfail.status === 402 && vfailBody.problem?.type === "https://paymentauth.org/problems/verification-failed" && handlerRuns === before && /invalid_payment/.test(vfailBody.problem.detail), "gate: relay validate failure -> 402 before the handler runs");
validateOk = true;
// tampered / insufficient
const tampered = await fetch(`${url}/paid`, { headers: { Authorization: credFor(await fresh(), { id: "y".repeat(43) }) } });
ok(tampered.status === 402 && (await tampered.json()).problem?.type === "https://paymentauth.org/problems/invalid-challenge" && /method="tempo"/.test(tampered.headers.get("www-authenticate") || ""), "gate: tampered credential -> 402 invalid-challenge WITH fresh challenges");
server.close();

// ---- stats + x402 coexistence: tempoPaid counted; evm + tempo challenges side by side ----
{
  const app2 = express();
  const gate = createTollbooth({ price: "$0.001", mode: "all", pow: false, powSecret: SECRET, resourceBaseUrl: "https://site.test", tempo: { apiKey: "k", recipient: RECIPIENT, relay } });
  app2.use(gate);
  app2.get("/p", (req, res) => res.json({ ok: 1 }));
  const s2 = await listen(app2);
  const r = await fetch(`${s2.url}/p`);
  const c = Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": r.headers.get("www-authenticate") }))[0];
  const w = r.headers.get("www-authenticate");
  await fetch(`${s2.url}/p`, { headers: { Authorization: credFor({ id: c.id, realm: c.realm, method: "tempo", intent: "charge", request: w.match(/request="([^"]+)"/)[1], expires: c.expires }) } });
  ok(gate.stats().tempoPaid === 1, `stats: tempoPaid counted (${gate.stats().tempoPaid})`);
  s2.server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
