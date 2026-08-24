#!/usr/bin/env node
// The submission ceiling was a lifetime bucket: an origin entered and nothing
// ever took it out, so the front door filled once and stayed full. A seller
// arriving later got "submission list is full" no matter how many of the
// origins ahead of them had gone dark months earlier.
//
// This pins the policy that gives a slot back. Everything here is about
// REFUSING to release, because a wrong release drops a real seller's listing
// and the pass runs unattended every cycle.
import { selectReleasableOrigins } from "../src/x402-index.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error("FAIL:", m); } };
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const row = (origin, o = {}) => ({
  origin,
  first_seen: NOW - 200 * DAY,
  last_routable_seen: NOW - 1 * DAY,
  last_settled_seen: null,
  ...o,
});
const run = (opts) => selectReleasableOrigins({
  now: NOW, cycleOkFraction: 1, isSubmitted: () => true, hasSettled: () => false, ...opts,
});

// --- the case it exists for -------------------------------------------------
ok(run({ registrations: [row("https://gone.example", { last_routable_seen: NOW - 40 * DAY })] })
  .join() === "https://gone.example", "a month-dead submission was not released");

// --- refusals ---------------------------------------------------------------
ok(run({ registrations: [row("https://alive.example")] }).length === 0,
  "released an origin that answered yesterday");
ok(run({ registrations: [row("https://recent.example", { last_routable_seen: NOW - 29 * DAY })] }).length === 0,
  "released at 29 days - the window is 30");

// Money outranks liveness. Releasing a seller who has been PAID through us
// drops a real counterparty over an outage we cannot see the end of.
ok(run({ registrations: [row("https://paid.example", { last_routable_seen: NOW - 400 * DAY, last_settled_seen: NOW - 300 * DAY })] }).length === 0,
  "released an origin that had settled a payment");
ok(run({ registrations: [row("https://paid2.example", { last_routable_seen: NOW - 400 * DAY })], hasSettled: (o) => o === "https://paid2.example" }).length === 0,
  "released an origin the ledger says has settled");

// Not ours to release: a registry-discovered or operator-seeded origin holds no
// submission slot, so releasing one would just delete a listing for nothing.
ok(run({ registrations: [row("https://discovered.example", { last_routable_seen: NOW - 400 * DAY })], isSubmitted: () => false }).length === 0,
  "released an origin that holds no submission slot");

// --- the outage guard, which is the whole safety story ----------------------
// Every seller looks dead when the failure is OURS. A blocked egress IP or a
// bad deploy would otherwise release the entire list in a single pass.
const allDead = [
  row("https://a.example", { last_routable_seen: NOW - 90 * DAY }),
  row("https://b.example", { last_routable_seen: NOW - 90 * DAY }),
];
ok(run({ registrations: allDead, cycleOkFraction: 0.2 }).length === 0,
  "released during a cycle where 80% of crawls failed - that is our outage, not theirs");
ok(run({ registrations: allDead, cycleOkFraction: 0 }).length === 0,
  "released during a cycle where everything failed");
ok(run({ registrations: allDead, cycleOkFraction: null }).length === 0,
  "released on an UNKNOWN cycle health - must fail closed");
ok(run({ registrations: allDead, cycleOkFraction: undefined }).length === 0,
  "released when cycle health was not supplied at all");
ok(run({ registrations: allDead, cycleOkFraction: NaN }).length === 0,
  "NaN cycle health passed the guard - comparison must reject it, not invert");
ok(run({ registrations: allDead, cycleOkFraction: 0.5 }).length === 2,
  "a healthy-enough cycle (exactly at the floor) released nothing");

// --- rows that should not crash or be immortal ------------------------------
ok(run({ registrations: [{ origin: "https://norec.example", first_seen: NOW - 400 * DAY, last_routable_seen: null }] })
  .join() === "https://norec.example",
  "a row with no last_routable_seen was immortal - it must fall back to first_seen");
ok(run({ registrations: [{ origin: "https://blank.example" }] }).length === 0,
  "a row with no timestamps at all was released on a guess");
ok(run({ registrations: [null, undefined, {}, { origin: 42 }, row("https://ok.example")] }).length === 0,
  "malformed rows were not skipped safely");
ok(run({ registrations: [] }).length === 0, "empty input produced releases");

// --- the window is configurable and actually read ---------------------------
ok(run({ registrations: [row("https://x.example", { last_routable_seen: NOW - 10 * DAY })], maxIdleMs: 5 * DAY })
  .join() === "https://x.example", "maxIdleMs was ignored");

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
