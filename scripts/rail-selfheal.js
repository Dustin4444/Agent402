#!/usr/bin/env node
// Bring a recovered rail back WITHOUT a human.
//
//   node scripts/rail-selfheal.js            # report only
//   RAILWAY_TOKEN=... node scripts/rail-selfheal.js   # report + restart on recovery
//
// WHY: src/payments.js drops a rail whose facilitator cannot be reached, so one
// dead third party costs one chain instead of every paid route. That decision is
// made ONCE AT BOOT - its own warning reads "a dropped rail returns on the next
// boot where its facilitator answers". So when the third party recovers, the
// rail stays dead until a human redeploys. Celo sat exactly that way while the
// service advertised twelve chains and served eleven.
//
// A live in-process swap of the offer was prototyped and REJECTED: rebuilding
// `accepts` while serving produced an EMPTY offer under test, and the failure
// mode there is "nobody can pay". Restarting re-runs the boot sequence, which is
// the most tested path in the system (quiet gate, drain, healthcheck). Boring
// beats clever on the payment path.
//
// THE RULE, and it is deliberately strict: restart only when BOTH hold
//   1. /api/rails reports a configured rail that is NOT offered, and
//   2. that rail's own facilitator answers /supported RIGHT NOW.
// A rail that is genuinely down is reported and left alone - restarting would
// not fix it and would just churn production on someone else's outage.
const TARGET = (process.env.TARGET_URL || "https://agent402.tools").replace(/\/+$/, "");

// Rails with a DEDICATED facilitator are the ones that can drop on their own;
// the rest ride CDP/PayAI and fall with them. Public endpoints, no secrets.
// scripts/test-rail-selfheal.js asserts this covers every dedicated-facilitator
// rail payments.js knows about, so the map cannot silently drift.
const FACILITATORS = {
  celo: process.env.CELO_FACILITATOR_URL || "https://api.x402.celo.org",
  monad: process.env.MONAD_FACILITATOR_URL || "https://x402-facilitator.molandak.org",
  robinhood: process.env.ROBINHOOD_FACILITATOR_URL || "",
  stellar: process.env.STELLAR_FACILITATOR_URL || "https://channels.openzeppelin.com/x402",
  algorand: process.env.ALGORAND_FACILITATOR_URL || "https://facilitator.goplausible.xyz",
};

const j = async (url, opts = {}) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000), ...opts });
  return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) };
};

const rails = await j(`${TARGET}/api/rails`);
if (!rails.ok || !rails.body) {
  console.log(`rail-selfheal: /api/rails unreadable (${rails.status}) - doing nothing.`);
  console.log("An unreadable signal is not evidence of a healthy offer, but it is also not evidence of a broken one.");
  process.exit(0);
}
const { configured, offered, degraded, rails: rows } = rails.body;
console.log(`rail-selfheal: configured=${configured} offered=${offered} degraded=${degraded}`);
if (!degraded) { console.log("every configured rail is offered - nothing to heal."); process.exit(0); }

const down = rows.filter((r) => !r.offered);
for (const r of down) console.log(`  DEGRADED ${r.network}: ${r.reason}`);

// Which of the degraded rails is actually healthy again upstream?
const recovered = [];
for (const r of down) {
  const url = FACILITATORS[r.network];
  if (!url) { console.log(`  ${r.network}: no dedicated facilitator known - cannot confirm recovery, leaving alone`); continue; }
  try {
    const s = await j(`${url.replace(/\/+$/, "")}/supported`);
    if (s.ok && Array.isArray(s.body?.kinds)) {
      console.log(`  ${r.network}: facilitator ANSWERS again (${s.status}) - recovered upstream`);
      recovered.push(r.network);
    } else {
      console.log(`  ${r.network}: facilitator still failing (${s.status}) - genuinely down, not restarting for it`);
    }
  } catch (e) {
    console.log(`  ${r.network}: facilitator unreachable (${String(e?.message || e).slice(0, 60)}) - still down`);
  }
}

if (!recovered.length) {
  console.log("\nNothing recovered upstream. Reporting only - a restart would not bring these back.");
  process.exit(0);
}

console.log(`\n${recovered.join(", ")} recovered upstream but the running process still has them dropped (boot-time decision).`);
const token = process.env.RAILWAY_TOKEN, service = process.env.RAILWAY_SERVICE_ID, envId = process.env.RAILWAY_ENVIRONMENT_ID;
if (!token || !service || !envId) {
  console.log("RAILWAY_TOKEN/SERVICE_ID/ENVIRONMENT_ID not set - cannot restart. Redeploy to pick the rail back up.");
  process.exit(0);
}

// Restart the CURRENT deployment: same build, fresh boot, rails re-probed.
// Deliberately not a redeploy - that would rebuild from main and could ship
// unrelated commits as a side effect of a third party's recovery.
const q = {
  query: `mutation($id:String!,$env:String!){serviceInstanceRedeploy(serviceId:$id, environmentId:$env)}`,
  variables: { id: service, env: envId },
};
const res = await fetch("https://backboard.railway.com/graphql/v2", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify(q),
  signal: AbortSignal.timeout(30_000),
});
const out = await res.json().catch(() => null);
if (!res.ok || out?.errors) {
  console.error(`restart FAILED: ${res.status} ${JSON.stringify(out?.errors || out).slice(0, 200)}`);
  process.exit(1);
}
console.log(`restart triggered - ${recovered.join(", ")} will be re-offered once the new container serves.`);
