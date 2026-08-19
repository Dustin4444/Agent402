#!/usr/bin/env node
// Tempo MPP volume runner - buys our own cheapest route over MPP's native
// tempo/charge method N times from the canary burner (USDC.e on Tempo).
//
// Why a separate scheduled run and not the daily canary: Mike wants ~1,000
// settled Tempo transactions a day at $0.001 (real on-chain volume for the
// MPP leaderboard window, the router's proven-seller gate and Tempo's
// transfer feed). One wallet cannot sign 1,000 credentials in parallel
// safely (nonces), and sequentially that is ~45 minutes - too long for the
// canary job. So tempo-volume.yml runs this every 2 hours with
// TEMPO_VOLUME_TX=84 (12 x 84 = 1,008/day); the daily canary keeps its ONE
// graded mpp-tempo settle as the rail proof (its volume knob stays at 1).
//
// Every buy is a fresh 402 -> tempo challenge -> credential -> settle
// (credentials are single-use). Requests carry the heartbeat token so our
// own stats file them as internal, not as external revenue; the on-chain
// transfer is real either way and that is what the leaderboard reads.
//
// Exit 0 when >= TEMPO_VOLUME_MIN_SUCCESS (default 80%) settled; 1 otherwise;
// 2 when the preflight (balance / challenge) refuses to start. Balance
// guard: refuses to run below TEMPO_VOLUME_MIN_BALANCE_USD (default $2) so a
// draining wallet is never ground to zero by the volume runner itself - the
// canary's funding sweep pages at $0.50 for the same wallet.
import { createHmac } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";

const TARGET = (process.env.TARGET_URL || "https://agent402.tools").replace(/\/$/, "");
const ROUTE = process.env.TEMPO_VOLUME_ROUTE || "/api/uuid";
const COUNT = Math.max(1, Math.min(5000, Number(process.env.TEMPO_VOLUME_TX || 84)));
const MIN_SUCCESS = Number(process.env.TEMPO_VOLUME_MIN_SUCCESS || 0.8);
const MIN_BALANCE_USD = Number(process.env.TEMPO_VOLUME_MIN_BALANCE_USD || 2);
const PACE_MS = Number(process.env.TEMPO_VOLUME_PACE_MS || 250); // small gap between buys; ~1,000/day must never look like a flood to our own gate
const TEMPO_RPC = process.env.TEMPO_RPC_URL || "https://rpc.tempo.xyz";
const USDCE = "0x20C000000000000000000000b9537d11c60E8b50";
const PATHUSD = "0x20c0000000000000000000000000000000000000";

const key = (process.env.BURNER_KEY || "").trim();
if (!key) { console.error("no BURNER_KEY"); process.exit(2); }
const account = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`);
const secret = (process.env.POW_SECRET || "").trim();
const heartbeatHeaders = () => {
  if (!secret) return {};
  const minute = Math.floor(Date.now() / 60_000);
  return { "X-Heartbeat-Token": createHmac("sha256", secret).update(`heartbeat:${minute}`).digest("base64url").slice(0, 32) };
};

async function erc20(token) {
  try {
    const data = "0x70a08231" + account.address.slice(2).toLowerCase().padStart(64, "0");
    const r = await fetch(TEMPO_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: token, data }, "latest"] }), signal: AbortSignal.timeout(10_000) });
    const j = await r.json();
    return Number(BigInt(j.result || "0x0")) / 1e6;
  } catch { return null; }
}

const [{ Mppx, tempo }, { Challenge, Receipt }] = await Promise.all([import("mppx/client"), import("mppx")]);
const client = Mppx.create({ methods: [tempo.charge({ account, autoSwap: true })], polyfill: false });
const url = `${TARGET}${ROUTE}`;

const usdce = await erc20(USDCE), pathusd = await erc20(PATHUSD);
console.log(`tempo-volume: ${COUNT} x ${ROUTE} from ${account.address} | balances USDC.e ${usdce ?? "?"} PathUSD ${pathusd ?? "?"}`);
const spendable = (usdce ?? 0) + (pathusd ?? 0);
if (usdce !== null && spendable < MIN_BALANCE_USD) {
  console.error(`REFUSING to run: burner holds $${spendable.toFixed(3)} on Tempo, below TEMPO_VOLUME_MIN_BALANCE_USD $${MIN_BALANCE_USD} - top up (USDC.e preferred) before the next run`);
  process.exit(2);
}

let ok = 0, fail = 0, lastErr = null, refs = [];
const t0 = Date.now();
const classify = (res, body) => {
  if (res.status === 200 && res.headers.get("payment-receipt")) return null;
  const problem = body && typeof body === "object" && body.type ? `${body.type.split("/").pop()}: ${String(body.detail || "").slice(0, 120)}` : "";
  return `HTTP ${res.status} ${problem || JSON.stringify(body || {}).slice(0, 120)}`;
};
for (let i = 0; i < COUNT; i++) {
  try {
    const bare = await fetch(url, { headers: heartbeatHeaders(), signal: AbortSignal.timeout(15_000) });
    const www = bare.headers.get("www-authenticate") || "";
    await bare.arrayBuffer().catch(() => {});
    const ch = www ? Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": www })).find((c) => c.method === "tempo" && c.intent === "charge") : null;
    if (!ch) {
      if (i === 0) { console.error(`REFUSING to run: no tempo/charge challenge on ${url} (HTTP ${bare.status}) - TEMPO_API_KEY unset on prod, or the route is not paid`); process.exit(2); }
      fail++; lastErr = `no tempo challenge (HTTP ${bare.status})`; continue;
    }
    const credential = await client.createCredential(new Response(null, { status: 402, headers: { "WWW-Authenticate": Challenge.serialize(ch) } }));
    const paid = await fetch(url, { headers: { ...heartbeatHeaders(), Authorization: credential }, signal: AbortSignal.timeout(60_000) });
    const body = await paid.json().catch(() => ({}));
    const err = classify(paid, body);
    if (!err) {
      ok++;
      try { const ref = Receipt.deserialize(paid.headers.get("payment-receipt"))?.reference; if (ref && refs.length < 3) refs.push(ref); } catch { /* best effort */ }
    } else { fail++; lastErr = err; }
  } catch (e) {
    fail++; lastErr = (e?.message || String(e)).slice(0, 160);
  }
  if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${COUNT}: ${ok} settled, ${fail} failed${lastErr ? ` (last: ${lastErr})` : ""} [${((Date.now() - t0) / 1000).toFixed(0)}s]`);
  if (fail >= 10 && ok === 0) { console.error("10 failures with no success - stopping (rail or burner problem, not a volume problem)"); break; }
  if (PACE_MS) await new Promise((r) => setTimeout(r, PACE_MS));
}
const secs = ((Date.now() - t0) / 1000).toFixed(0);
const rate = ok / COUNT;
console.log(`\ntempo-volume: ${ok}/${COUNT} settled at $0.001 in ${secs}s (${fail} failed${lastErr ? `, last: ${lastErr}` : ""})${refs.length ? `\n  sample txs: ${refs.map((r) => `https://explore.tempo.xyz/tx/${r}`).join(" ")}` : ""}`);
const after = await erc20(USDCE);
if (after !== null) console.log(`  USDC.e after: ${after} (spent ~$${((usdce ?? after) - after).toFixed(3)})`);
if (rate < MIN_SUCCESS) { console.error(`TEMPO VOLUME UNDER ${Math.round(MIN_SUCCESS * 100)}% (${ok}/${COUNT})`); process.exit(1); }
process.exit(0);
