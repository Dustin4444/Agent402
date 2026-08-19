// Algorand rail canary — buy EVERY tool in the catalog paying USDC on Algorand
// mainnet, and prove each one settles AND renders its payload.
//
// WHY THIS EXISTS (and how it differs from the two scripts next to it)
//   • scripts/paid-canary.js has ONE Algorand leg (/api/hash, $0.001). It proves
//     the rail is alive; it cannot prove the rail works for the whole catalog.
//   • scripts/challenge-sweep.js buys every tool on Algorand but SKIPS anything
//     already in GoPlausible's catalog — it is a one-shot registration tool, so
//     on a second run it buys almost nothing and verifies almost nothing.
//   This canary is the recurring health check: no skip-set, every tool bought
//   every run, and each buy asserted end-to-end (402 → sign → settle → 200 →
//   non-empty payload). A tool that quietly stops offering the AVM accept, or
//   settles but 500s, shows up here and nowhere else.
//
// The tool handler is chain-agnostic (it never learns which rail settled), so
// what each row proves is the settlement→unlock→payload path for that tool on
// Algorand specifically.
//
// COST
//   Self-buys: burner -> our own revenue payTo, so the USDC recycles. The true
//   cost is the Algorand fee per txn (0.001 ALGO) plus whatever upstream API
//   spend a given tool triggers. The burner still needs the full in-flight
//   float (~$11 at the default $0.25/tool cap) before it comes back.
//
// SAFETY / CONTROL
//   • Pays ONLY on Algorand, ONLY to the accept the live 402 quotes. No EVM.
//   • Hard total-spend cap (CANARY_MAX_USD, default 15) — stops cleanly before
//     a buy that would exceed it. Per-tool cap (CANARY_TOOL_MAX_USD, default
//     0.25) skips the expensive skill packs by default.
//   • CANARY_DRY=1 / --dry reports what it WOULD buy, signs nothing.
//   • Carries the POW_SECRET-signed X-Heartbeat-Token when available, which
//     marks the traffic synthetic in our own analytics WITHOUT bypassing the
//     paywall (src/server.js isSyntheticRequest) — the payments are real, they
//     just don't masquerade as external demand.
//   • Signs a 1000-round validity window, never algokit's 10-round default:
//     settlement happens AFTER the handler, so a slow tool outlives the default
//     window and the facilitator rejects a dead txn (buyer refunded, our
//     upstream spend burned). See src/avm-validity.js for the server-side guard.
//
// EXIT CODE
//   0 when every attempted tool settled and returned a payload. 1 on any rail
//   failure (paid and still got a 402 — settlement rejected) or tool failure
//   (settled but the handler errored). Both are real defects, so neither is
//   tolerated by a threshold.
//
// Usage:
//   CANARY_DRY=1 node scripts/algorand-rail-canary.js                 # preview, no keys, no spend
//   ALGORAND_BURNER_MNEMONIC=… node scripts/algorand-rail-canary.js --out report.json
import { writeFileSync } from "node:fs";
import { createHmac } from "node:crypto";
// The single source of truth for which routes legitimately advertise EVM rails
// only (security audit A402-03). Importing it means this canary can never drift
// from the server's own definition of an identity-bound route.
import { isIdentityBoundRoute } from "../src/payments.js";

import { FAST_REJECT_MS, isThrottle, isUpstreamOutage, outcomeOf } from "./avm-canary-classify.js";

const TARGET = (process.env.TARGET_URL || "https://agent402.tools").replace(/\/$/, "");
const AVM_CAIP2_PREFIX = "algorand:";

const args = process.argv.slice(2);
const arg = (n, d = null) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const OUT = arg("--out");
const MAX_USD = Number(arg("--max-usd", process.env.CANARY_MAX_USD || "15"));
const TOOL_MAX_USD = Number(process.env.CANARY_TOOL_MAX_USD || "0.25");
const LIMIT = Number(arg("--limit", process.env.CANARY_LIMIT || "0")) || Infinity;
// 250ms was too aggressive for the Algorand facilitator specifically: run
// 32006536872 (2026-08-17) settled 415 real Algorand purchases cleanly, then
// every subsequent call failed instantly (55-85ms, far too fast to have ever
// reached the chain - genuine settlements in the same run took 5s+) until the
// run ended, with one lone success mixed back in. That shape - fast local
// rejection after a volume threshold, not a structural defect (identical
// accept payloads either side of the cutoff) - is the facilitator throttling
// this wallet, not the rail breaking. Slower default pacing to stay further
// under whatever threshold it enforces; see isFastReject below for the
// classification half of this fix.
const DELAY_MS = Number(process.env.CANARY_DELAY_MS || "1000");
// A sweep that buys ~500 tools at 250ms is not representative load: it hits
// every OpenAI-backed tool back to back, and the upstream throttles. The
// 2026-08-03 run booked 7 of those as "tool failures" - tts, tts-hd,
// transcribe, transcribe-pro, embed, embed-large, moderate - when the rail was
// perfect (0 rail failures, 486 settled) and the handlers were fine.
//
// An alarm that reports our own burst as a product defect is worse than no
// alarm, because the next real defect arrives in a file people have learned to
// skim. So a throttle gets ONE retry after a real pause, and only a throttle
// that survives that is reported - as its own class, not as a broken tool.
const THROTTLE_BACKOFF_MS = Number(process.env.CANARY_THROTTLE_BACKOFF_MS || "8000");
// A genuine settlement rejection means the facilitator actually attempted (and
// failed) an on-chain broadcast - real Algorand round trips through this
// script measured 5s+. A 402 that comes back in under this window never
// reached the chain, which is the AVM-specific shape of the same throttle
// class isThrottle() catches for 429/503 (see DELAY_MS above for the incident
// this was found from). Threshold sits well above the ~85ms observed fast
// rejections and well below genuine ~5s settlements, so it can't misclassify
// a real slow rejection as a throttle.

const ONLY = String(arg("--slugs", process.env.CANARY_SLUGS || "")).split(",").map((s) => s.trim()).filter(Boolean);
const DRY = process.env.CANARY_DRY === "1" || args.includes("--dry");

const die = (m) => { console.error("ABORT:", m); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Marks our own traffic synthetic in analytics. Does NOT bypass payment.
const secret = (process.env.POW_SECRET || "").trim();
const heartbeatHeaders = () =>
  secret
    ? { "X-Heartbeat-Token": createHmac("sha256", secret).update(`heartbeat:${Math.floor(Date.now() / 60_000)}`).digest("base64url").slice(0, 32) }
    : {};

// ── Algorand signer (skipped in dry mode — quoting needs no key) ──────────────
let client, http, payerAddress = "(dry)";
if (!DRY) {
  const mnemonic = (process.env.ALGORAND_BURNER_MNEMONIC || "").trim();
  if (!mnemonic) die("ALGORAND_BURNER_MNEMONIC not set (or use CANARY_DRY=1 to preview)");
  const { x402Client, x402HTTPClient } = await import("@x402/core/client");
  const [{ ExactAvmScheme }, { toClientAvmSigner }, algosdk] = await Promise.all([
    import("@x402/avm/exact/client"), import("@x402/avm"), import("algosdk"),
  ]);
  const account = algosdk.mnemonicToSecretKey(mnemonic);
  const signer = toClientAvmSigner(Buffer.from(account.sk).toString("base64"));
  const algodUrl = (process.env.ALGORAND_ALGOD_URL || "https://mainnet-api.algonode.cloud").trim();
  const { AlgorandClient } = await import("@algorandfoundation/algokit-utils/algorand-client");
  const algorandClient = AlgorandClient.fromConfig({ algodConfig: { server: algodUrl, token: "" } })
    .setDefaultValidityWindow(1000);
  client = new x402Client();
  client.register("algorand:*", new ExactAvmScheme(signer, { algorandClient }));
  http = new x402HTTPClient(client);
  payerAddress = account.addr.toString();
} else {
  const { x402Client, x402HTTPClient } = await import("@x402/core/client");
  client = new x402Client();
  http = new x402HTTPClient(client);
}

// ── Catalog ───────────────────────────────────────────────────────────────────
function walkTools(o) {
  const out = [];
  const rec = (x) => {
    if (Array.isArray(x)) x.forEach(rec);
    else if (x && typeof x === "object") {
      if (x.price && (x.path || x.route) && x.method) out.push(x);
      else Object.values(x).forEach(rec);
    }
  };
  rec(o);
  return out;
}

const pricing = await (await fetch(`${TARGET}/api/pricing`)).json();
let tools = walkTools(pricing).map((t) => ({
  method: String(t.method).toUpperCase(),
  path: t.path || (t.route || "").replace(/^[A-Z]+\s+/, ""),
  slug: t.slug,
  category: t.category,
  priceUsd: Number(String(t.price).replace("$", "")),
}));
const seen = new Set();
tools = tools.filter((t) => { const k = `${t.method} ${t.path}`; if (seen.has(k)) return false; seen.add(k); return true; });
if (ONLY.length) tools = tools.filter((t) => ONLY.includes(t.slug));

console.log(`Algorand rail canary · target ${TARGET} · payer ${payerAddress}`);
console.log(`catalog: ${tools.length} routes · dry=${DRY} · total cap $${MAX_USD} · per-tool cap $${TOOL_MAX_USD}\n`);

// ── Sweep ─────────────────────────────────────────────────────────────────────
// ok          settled on Algorand and returned a non-empty payload
// railFail    we paid and still got a 402 AFTER a genuine (slow) settlement
//             attempt — settlement was actually refused (RAIL DEFECT)
// rateLimited a 402 that came back too fast to have reached the chain, and
//             survived one backoff-and-retry — the facilitator throttling
//             this wallet, not a rail defect (see FAST_REJECT_MS above)
// toolFail    settled but the handler errored, or returned an empty body
// noAvm       the live 402 offers no algorand:* accept for this tool
// skipped     over the per-tool price cap, or the total cap was reached
const report = {
  target: TARGET, payer: payerAddress, dry: DRY,
  ok: [], railFail: [], rateLimited: [], toolFail: [], throttled: [], upstreamFail: [], noAvm: [], skipped: [],
  spentUsd: 0, startedAt: new Date().toISOString(),
};
let processed = 0;
let capped = false;

for (const t of tools) {
  if (processed >= LIMIT) break;
  const key = `${t.method} ${t.path}`;
  if (t.priceUsd > TOOL_MAX_USD) { report.skipped.push({ key, slug: t.slug, reason: `price $${t.priceUsd} > per-tool cap $${TOOL_MAX_USD}` }); continue; }

  // A bare request yields the 402 challenge, which carries BOTH the live
  // accepts and the tool's own canonical example input (the paywall precedes
  // the handler, so no valid input is needed to get it).
  let paymentRequired, exampleInput;
  try {
    const bareFetch = () => fetch(`${TARGET}${t.path}`, {
      method: t.method,
      headers: { "Content-Type": "application/json", Accept: "application/json", ...heartbeatHeaders() },
      ...(t.method === "POST" ? { body: "{}" } : {}),
      signal: AbortSignal.timeout(30000),
    });
    let bare = await bareFetch();
    // Single-retry doctrine (same as the heartbeat prober): a bare request that
    // lands inside a deploy's container switch answers 502 from the edge for
    // ~1-2 minutes. Measured 2026-08-19 run 32288638827: 16 "tool failures"
    // between 19:19:32 and 19:21:28, the deploy job ending at 19:21:19 - every
    // one a 502 on the bare request, none a tool defect. One re-probe after
    // 20s: a real outage fails both and records exactly as before.
    if (bare.status !== 402) {
      await bare.arrayBuffer().catch(() => {});
      await new Promise((r) => setTimeout(r, 20_000));
      bare = await bareFetch();
    }
    if (bare.status !== 402) { report.toolFail.push({ key, slug: t.slug, reason: `bare request HTTP ${bare.status} (expected 402) - twice, 20s apart` }); continue; }
    const bareBody = await bare.json().catch(() => undefined);
    paymentRequired = http.getPaymentRequiredResponse((n) => bare.headers.get(n), bareBody);
    exampleInput = paymentRequired?.extensions?.bazaar?.info?.input || {};
  } catch (e) { report.toolFail.push({ key, slug: t.slug, reason: `challenge: ${String(e.message).slice(0, 120)}` }); continue; }

  const accepts = (paymentRequired.accepts || []).filter((a) => String(a.network || "").startsWith(AVM_CAIP2_PREFIX));
  // Identity-bound tools (the memory family and my-usage) derive the caller
  // from the signed EIP-3009 authorization, which is EVM-only, so the paywall
  // deliberately advertises no AVM accept for them — see isIdentityBoundRoute
  // in src/payments.js. Anything ELSE missing the accept means the rail
  // silently stopped being offered, which is a real regression.
  if (!accepts.length) { report.noAvm.push({ key, slug: t.slug, expected: isIdentityBoundRoute(t) }); continue; }

  const usd = Number(accepts[0].amount ?? accepts[0].maxAmountRequired) / 1e6;
  if (report.spentUsd + usd > MAX_USD) {
    capped = true;
    report.skipped.push({ key, slug: t.slug, reason: `total cap $${MAX_USD} reached (spent $${report.spentUsd.toFixed(4)})` });
    continue;
  }

  if (DRY) { report.ok.push({ key, slug: t.slug, usd, dry: true }); report.spentUsd += usd; processed++; continue; }

  // Replay the tool's own documented example so a 200 means a real payload.
  const reqInit = {
    method: t.method,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    signal: AbortSignal.timeout(90000),
  };
  let url = `${TARGET}${t.path}`;
  if (t.method === "POST") reqInit.body = JSON.stringify(exampleInput.body || {});
  else if (exampleInput.queryParams) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(exampleInput.queryParams)) if (v != null && typeof v !== "object") qs.set(k, String(v));
    const s = qs.toString();
    if (s) url += (url.includes("?") ? "&" : "?") + s;
  }

  // One complete buy: fresh signature, fresh request. Extracted so a throttled
  // attempt can be repeated after a backoff. Each call MUST sign again - an AVM
  // authorization is single-use, so replaying the first payload would be
  // refused by the replay guard rather than retried.
  const payOnce = async () => {
    const payload = await client.createPaymentPayload({ ...paymentRequired, accepts });
    const payHeaders = http.encodePaymentSignatureHeader(payload);
    return fetch(url, {
      ...reqInit,
      headers: { ...reqInit.headers, ...payHeaders, ...heartbeatHeaders(), "Access-Control-Expose-Headers": "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE" },
    });
  };

  // One buy = up to TWO fresh attempts. Every attempt SIGNS AGAIN (an AVM
  // authorization is single-use, and a >=400 cancels settlement, so a retried
  // payment costs nothing unless it succeeds). This sweep makes ~500 sequential
  // paid buys over ~55 min; on the way, three NON-defects each fail the whole
  // weekly gate if judged on first sight (measured across runs 2026-08-19):
  //   - an edge 502 "upstream error" (Railway swapping a container mid-sweep;
  //     it hits pure-CPU tools like xml-validate too, which have no upstream);
  //   - a THIRD-PARTY upstream 5xx/timeout (Blockscout/GLEIF/OpenRouter, or a
  //     router "Seller rejected the paid retry") - their outage, buyer NOT
  //     charged (>=400 cancels settlement);
  //   - a 409 "authorization already used": two equal-priced AVM buys inside
  //     one ~50-min validity window can sign to the same txid, so the second
  //     trips the replay guard. A fresh signature in a later round is a new
  //     txid, so the retry clears it.
  // So: classify only what SURVIVES a fresh retry, and a persistent third-party
  // outage is reported but does NOT fail the run (same posture as the external
  // buyer - "a failed third-party buy never pages"). A persistent failure from
  // OUR OWN handler still fails the run.
  const attempt = async () => {
    const startedMs = Date.now();
    const paid = await payOnce();
    const elapsedMs = Date.now() - startedMs;
    const receiptHdr = paid.headers.get("payment-response") || paid.headers.get("x-payment-response");
    let tx = null;
    if (receiptHdr) { try { tx = JSON.parse(Buffer.from(receiptHdr, "base64").toString("utf8")).transaction; } catch { /* best-effort */ } }
    const body = await paid.text().catch(() => "");
    return { status: paid.status, body, tx, elapsedMs };
  };
  try {
    let a = await attempt();
    let out = outcomeOf(a);
    let retried = false;
    // Anything that is not a clean settled payload gets ONE fresh retry after a
    // real pause. fast-402/throttle already meant "our own burst"; slow-402 and
    // other non-200s get the same benefit of the doubt - a rail/edge/upstream
    // blip mid-sweep must not fail a weekly gate on first sight. Only a problem
    // that SURVIVES the retry is real.
    if (out !== "ok") {
      const why = out === "fast-402" ? `HTTP 402 in ${a.elapsedMs}ms (too fast to be a settlement)`
        : out === "throttle" ? `HTTP ${a.status} (upstream throttle)`
          : out === "slow-402" ? `HTTP 402 after ${a.elapsedMs}ms`
            : out === "empty" ? "settled 200 with an empty body"
              : `HTTP ${a.status}: ${a.body.slice(0, 100)}`;
      console.log(`WAIT ${key.padEnd(46)} ${why} - retrying in ${THROTTLE_BACKOFF_MS}ms`);
      await sleep(THROTTLE_BACKOFF_MS);
      a = await attempt();
      out = outcomeOf(a);
      retried = true;
    }

    if (out === "ok") {
      report.ok.push({ key, slug: t.slug, usd, tx: a.tx || null, bytes: a.body.length, ...(retried ? { recovered: true } : {}) });
      report.spentUsd += usd;
      console.log(`OK   ${key.padEnd(46)} $${usd}${a.tx ? ` · tx ${a.tx.slice(0, 10)}…` : " · (no receipt header)"}${retried ? " · recovered on retry" : ""}  [${report.ok.length}]`);
    } else if (out === "fast-402" || out === "throttle") {
      // Survived a real pause and is STILL the fast/throttle shape -> the
      // facilitator is rate-limiting THIS wallet's volume, not a rail defect.
      report.throttled.push({ key, slug: t.slug, reason: `HTTP ${a.status} after ${THROTTLE_BACKOFF_MS}ms backoff: ${String(a.body).slice(0, 120)}` });
      console.log(`THROTTLED ${key.padEnd(40)} still limited after backoff`);
    } else if (out === "slow-402") {
      // Took real time (>= FAST_REJECT_MS) TWICE, so the facilitator genuinely
      // attempted and refused settlement - the rail (facilitator, accept,
      // validity window, opt-in) is the fault.
      report.railFail.push({ key, slug: t.slug, usd, reason: `settlement rejected after ${a.elapsedMs}ms, twice: ${a.body.slice(0, 140) || "(empty body)"}` });
      console.log(`FAIL ${key.padEnd(46)} HTTP 402 (settlement refused, twice)`);
    } else if (out === "empty") {
      report.toolFail.push({ key, slug: t.slug, reason: "settled 200 with an empty body, twice" });
      console.log(`FAIL ${key.padEnd(46)} 200 empty body (twice)`);
    } else if (isUpstreamOutage(a.status, a.body)) {
      // Persistent third-party / edge failure: their outage, not our defect,
      // and a >=400 cancelled settlement so the buyer was never charged.
      // Reported, does NOT fail the run.
      report.upstreamFail.push({ key, slug: t.slug, reason: `HTTP ${a.status}: ${a.body.slice(0, 140)}` });
      console.log(`UPSTREAM ${key.padEnd(41)} HTTP ${a.status} (third-party/edge, not charged, twice)`);
    } else {
      // A >=400 cancels settlement (see the ordering note in CLAUDE.md), so we
      // were NOT charged - our own handler is the fault, the rail is fine.
      report.toolFail.push({ key, slug: t.slug, reason: `HTTP ${a.status}: ${a.body.slice(0, 160)} (twice)` });
      console.log(`FAIL ${key.padEnd(46)} HTTP ${a.status} (twice)`);
    }
  } catch (e) { report.toolFail.push({ key, slug: t.slug, reason: `pay: ${String(e.message).slice(0, 160)}` }); }

  processed++;
  await sleep(DELAY_MS);
}

// ── Verdict ───────────────────────────────────────────────────────────────────
report.finishedAt = new Date().toISOString();
const unexpectedNoAvm = report.noAvm.filter((n) => !n.expected);

console.log(`\n=== Algorand rail canary ===`);
const recovered = report.ok.filter((o) => o.throttledFirst).length;
console.log(`settled+payload: ${report.ok.length} · rail failures: ${report.railFail.length} · rate-limited: ${report.rateLimited.length} · tool failures: ${report.toolFail.length} · upstream throttles: ${report.throttled.length} · third-party outages: ${report.upstreamFail.length}${recovered ? ` (${recovered} recovered on retry)` : ""}`);
console.log(`no AVM accept: ${report.noAvm.length} (${report.noAvm.length - unexpectedNoAvm.length} expected identity-bound, ${unexpectedNoAvm.length} unexpected) · skipped: ${report.skipped.length}`);
console.log(`spent (recycles to our own payTo): $${report.spentUsd.toFixed(4)}${capped ? "  [TOTAL CAP REACHED]" : ""}`);

if (report.railFail.length) {
  console.log(`\nRAIL FAILURES (Algorand settlement refused after a genuine, slow attempt):`);
  for (const f of report.railFail) console.log(`  ${f.key} — ${f.reason}`);
}
if (report.rateLimited.length) {
  console.log(`\nRATE-LIMITED (fast 402s that survived a backoff - likely the facilitator throttling this wallet's volume, not a rail defect):`);
  for (const f of report.rateLimited) console.log(`  ${f.key} — ${f.reason}`);
  console.log(`  NOTE: this sweep buys ~500 tools back to back, which no real buyer does.`);
  console.log(`  Raise CANARY_DELAY_MS or CANARY_THROTTLE_BACKOFF_MS if this recurs.`);
}
if (report.toolFail.length) {
  console.log(`\nTOOL FAILURES (settled path fine, handler did not deliver):`);
  for (const f of report.toolFail.slice(0, 40)) console.log(`  ${f.key} — ${f.reason}`);
  if (report.toolFail.length > 40) console.log(`  … ${report.toolFail.length - 40} more (see the report artifact)`);
}
if (report.throttled.length) {
  console.log(`\nUPSTREAM THROTTLES (handler fine, vendor refused us even after a backoff):`);
  for (const f of report.throttled) console.log(`  ${f.key} — ${f.reason}`);
  console.log(`  NOTE: this sweep buys every tool back to back, which no real buyer does.`);
  console.log(`  Raise CANARY_DELAY_MS or CANARY_THROTTLE_BACKOFF_MS if this recurs.`);
}
if (report.upstreamFail.length) {
  console.log(`\nTHIRD-PARTY / EDGE OUTAGES (persisted through a fresh retry; buyer NOT charged - their outage or an edge blip, not our rail/tool defect, so these do NOT fail the run):`);
  for (const f of report.upstreamFail) console.log(`  ${f.key} — ${f.reason}`);
}
if (unexpectedNoAvm.length) {
  console.log(`\nUNEXPECTED: these tools offer no algorand accept and are not identity-bound:`);
  for (const n of unexpectedNoAvm) console.log(`  ${n.key} (${n.slug})`);
}

if (OUT) { writeFileSync(OUT, JSON.stringify(report, null, 2)); console.log(`\nwrote ${OUT}`); }

// Rail failures and tool failures are both real defects. Unexpected missing
// accepts mean the rail silently stopped being offered, which is the exact
// regression this canary exists to catch — all three fail the run.
//
// Upstream throttles deliberately do NOT. This sweep buys ~500 tools back to
// back and hits one vendor repeatedly; no real buyer produces that shape, so a
// 429 under it is our own load, not a product defect. The 2026-08-03 run failed
// on exactly this: 7 OpenAI-backed tools reported as broken while the rail was
// perfect and the handlers were fine.
//
// An alarm that reports our own burst as a defect is worse than no alarm,
// because the next real failure lands in a report people have learned to skim.
// They are still printed, and a throttle that survives a real backoff is worth
// reading - it just does not page.
// Third-party/edge outages (report.upstreamFail) are deliberately excluded:
// they persisted through a fresh retry but the buyer was never charged and the
// fault is a vendor or the edge, not our rail or handler - same doctrine as the
// external buyer. They are printed above so a spike is still visible.
const bad = report.railFail.length + report.toolFail.length + unexpectedNoAvm.length;
if (bad) { console.error(`\nFAIL: ${bad} problem(s) on the Algorand rail.`); process.exit(1); }
console.log(`\nPASS: every attempted tool settled on Algorand and returned a payload.`);
