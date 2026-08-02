#!/usr/bin/env node
// The self-healer must know about every rail that can drop on its own.
//
//   node scripts/test-rail-selfheal.js
//
// WHY: scripts/rail-selfheal.js restarts the service only when a degraded rail's
// OWN facilitator answers again. That check needs a network -> facilitator map,
// and a map maintained by hand rots: add a chain with a dedicated facilitator,
// forget this file, and that chain can never self-heal. It would sit dropped
// exactly like Celo did, except now with a healer running that quietly skips it.
//
// So the map is asserted against payments.js rather than trusted. A rail with a
// dedicated facilitator there must appear here.
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const payments = readFileSync(new URL("../src/payments.js", import.meta.url), "utf8");
const healer = readFileSync(new URL("./rail-selfheal.js", import.meta.url), "utf8");

// Every *_FACILITATOR_URL payments.js reads is a rail that can fall on its own.
// Only NETWORKS matter here. payments.js also names facilitator VENDORS
// (payai, solvador) in the same shape; those serve many chains and fall with
// the chains they serve, so they are not something a single rail can heal from.
const { NETWORKS } = await import("../src/payments.js");
const networkNames = new Set(Object.keys(NETWORKS));
const dedicated = [...payments.matchAll(/([A-Z0-9]+)_FACILITATOR_URL/g)]
  .map((m) => m[1].toLowerCase())
  .filter((n) => networkNames.has(n));
const known = [...new Set(dedicated)];
ok(known.length > 0, `found the dedicated-facilitator rails in payments.js (${known.join(", ")})`);

for (const rail of known) {
  ok(new RegExp(`\\b${rail}\\s*:`, "i").test(healer),
    `${rail} has an entry in the healer's facilitator map - without it, that rail can never self-heal`);
}

// The healer must never restart on a rail it cannot confirm. That refusal is
// the whole safety property: restarting for a genuinely-down third party churns
// production without fixing anything.
ok(/cannot confirm recovery, leaving alone/.test(healer),
  "an unknown rail is left alone rather than triggering a speculative restart");
ok(/genuinely down, not restarting for it/.test(healer),
  "a still-failing facilitator does NOT trigger a restart");
ok(/Nothing recovered upstream/.test(healer),
  "with nothing recovered the healer reports and exits without acting");

// It must restart the CURRENT build, never rebuild from main - a third party's
// recovery must not become a vehicle for shipping unrelated commits.
ok(/serviceInstanceRedeploy/.test(healer) && !/gh workflow run deploy/.test(healer),
  "recovery restarts the running deployment, it does not trigger a rebuild from main");

// The healer must work with the secrets that EXIST. Only RAILWAY_TOKEN is
// configured on this repo; a healer demanding RAILWAY_SERVICE_ID and
// RAILWAY_ENVIRONMENT_ID would run green forever while never healing anything,
// which is worse than no healer at all - the dashboard would say it is working.
ok(/RAILWAY_PROJECT_NAME|projects \{ edges/.test(healer),
  "service and environment are RESOLVED from the token, not demanded as extra secrets");
ok(!/secrets\.RAILWAY_SERVICE_ID/.test(readFileSync(new URL("../.github/workflows/rail-selfheal.yml", import.meta.url), "utf8")),
  "the workflow does not depend on a secret that was never created");
ok(/cannot resolve the Railway service to restart/.test(healer),
  "a failure to resolve the service EXITS NONZERO rather than silently no-oping");

// --- a degraded rail must SURFACE, not just be survivable -------------------
//
// The healer brings a rail back once its facilitator recovers, but nothing told
// anyone it went down in the first place. Celo sat dropped for days: revenue
// kept flowing on the other rails, /health stayed 200, and it surfaced only
// because someone asked why the revenue page looked short. Survivable is not
// the same as visible.
{
  const hb = readFileSync(new URL("../.github/workflows/heartbeat.yml", import.meta.url), "utf8");
  ok(/\/api\/rails/.test(hb), "the heartbeat reads /api/rails");
  ok(/Settlement rail DEGRADED/.test(hb), "a degraded rail opens a tracked issue");
  ok(/gh issue close .* --comment "Recovered: every configured rail/.test(hb)
     || /Recovered: every configured rail/.test(hb),
    "the issue closes itself when every rail is offered again");

  // The trap this class of check keeps falling into: a failed curl looks like
  // a healthy response, so the alarm closes itself during an outage. That is
  // how the charged-failure alarm went years without firing.
  ok(/unreadable - not treating that as healthy/.test(hb),
    "an unreadable /api/rails does NOT count as healthy and does not close an open issue");

  // A degraded rail is not an outage - the other chains still earn - so it must
  // not page.
  // Scope to the Rail check STEP only. Splitting on the step name and reading
  // everything after it also swallows every later step, including ones that
  // legitimately page on production being down - which is what the first
  // version of this assertion did, and it failed for the wrong reason.
  const railStep = (hb.match(/- name: Rail check[\s\S]*?(?=\n      - name: )/) || [""])[0];
  ok(railStep.length > 200, "the Rail check step was located for scoped assertions");
  ok(!/production DOWN/.test(railStep),
    "a degraded rail is reported as a notice, never escalated to a production-down page");
  ok(/This is a notice, not an outage/.test(railStep),
    "the issue text says plainly that revenue continues on the other rails");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
