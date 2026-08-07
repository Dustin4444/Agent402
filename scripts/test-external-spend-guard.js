// Offline tests for src/external-spend-guard.js.
//
// The hole it closes: settlement runs AFTER the handler, and the external
// routing handler pays a third-party seller from our wallet. A payment that
// VERIFIES and then fails to SETTLE leaves us out the upstream spend with the
// buyer charged nothing. Self-dealt - one wallet listing the seller and buying
// from it - every drained dollar returns to the attacker.
import {
  maySpend, noteSpend, resolveSpend, payerExposureUsd, exposureSnapshot, __reset,
} from "../src/external-spend-guard.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const A = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01";

// --- the attack, in one block ------------------------------------------------
{
  __reset();
  // An explicit ceiling, not the shipped default: this block is about the
  // MECHANISM, and tying it to whatever the default happens to be today would
  // make it pass for the wrong reason the next time a tier moves.
  const CEIL = { maxUnsettledUsd: 0.75 };
  // Call 1: allowed, we spend upstream.
  ok(maySpend(A, 0.5, CEIL).ok, "a fresh payer may spend");
  const h1 = noteSpend(A, 0.5);
  ok(payerExposureUsd(A) === 0.5, "the spend counts as exposure while unresolved");

  // Their payment FAILS to settle. This is the whole point: handler success is
  // not revenue, and the exposure must survive it.
  resolveSpend(h1, false);
  ok(payerExposureUsd(A) === 0.5,
    `an UNSETTLED spend keeps counting against the payer (got ${payerExposureUsd(A)})`);

  // Call 2 from the same wallet is refused before we spend a second time.
  const second = maySpend(A, 0.5, CEIL);
  ok(second.ok === false, "a second call is refused while the first is unpaid - the drain stops at one");
  ok(/has not settled/i.test(second.reason), `the refusal explains itself (got: ${second.reason})`);
}

{
  // The honest buyer's path: settle, and exposure clears immediately.
  __reset();
  const h = noteSpend(A, 0.5);
  resolveSpend(h, true);
  ok(payerExposureUsd(A) === 0, "a SETTLED spend clears the exposure at once");
  ok(maySpend(A, 0.5, { maxUnsettledUsd: 0.75 }).ok, "and the payer may immediately spend again - this is a debt ceiling, not a reputation");
}

{
  // A wallet that pays reliably is never impeded, however many calls it makes.
  __reset();
  let everRefused = false;
  for (let i = 0; i < 25; i++) {
    if (!maySpend(A, 0.5).ok) everRefused = true;
    resolveSpend(noteSpend(A, 0.5), true);
  }
  ok(!everRefused && payerExposureUsd(A) === 0 && maySpend(A, 0.5).ok,
    "25 settled calls in a row are never refused and leave zero exposure - a good buyer never hits the ceiling");
}

// --- identity handling -------------------------------------------------------
{
  __reset();
  const h = noteSpend(A.toLowerCase(), 0.5);
  resolveSpend(h, false);
  ok(payerExposureUsd(A.toUpperCase().replace("0X", "0x")) === 0.5,
    "EVM addresses are case-insensitive, so a payer cannot reset their ledger by changing case");

  // base58 / Stellar / Algorand are case-SENSITIVE: folding them merges
  // distinct payers, the same rule src/payer.js enforces.
  const s1 = "GDNJXCKW7ZM7GEEVP674TWPU26YJNBQ2FI4ZIPRKTPTNUEJMDHFJWWRL";
  const h2 = noteSpend(s1, 0.4);
  resolveSpend(h2, false);
  ok(payerExposureUsd(s1.toLowerCase()) === 0,
    "a base58/Stellar address is NOT case-folded - folding would merge distinct payers");
}

{
  __reset();
  // An unattributable payer (free mode, a rail whose payer we cannot read) is
  // allowed: refusing would break every legitimate buyer on those rails, and a
  // single call is still bounded by the tier cap.
  const v = maySpend(null, 0.5);
  ok(v.ok === true && /not attributable/i.test(v.reason),
    "an unreadable payer is allowed and says why - the tier cap still bounds the call");
  ok(noteSpend(null, 0.5) === null, "…and nothing is recorded for a payer we cannot name");
}

// --- ceiling arithmetic ------------------------------------------------------
{
  __reset();
  ok(maySpend(A, 0.5, { maxUnsettledUsd: 0.5 }).ok, "exactly at the ceiling is allowed");
  const h = noteSpend(A, 0.5);
  resolveSpend(h, false);
  ok(maySpend(A, 0.01, { maxUnsettledUsd: 0.5 }).ok === false,
    "one cent past the ceiling is refused - the check is on the TOTAL, not the single call");
}

{
  // An unresolved row must not bar a payer forever (a process restart, a
  // response that never finished), but must not clear so fast a loop outruns it.
  __reset();
  const now = 1_000_000;
  noteSpend(A, 0.5, now);
  ok(payerExposureUsd(A, now + 60_000) === 0.5, "exposure stands a minute later");
  ok(payerExposureUsd(A, now + 11 * 60_000) === 0, "an unresolved spend ages out after the stale window");
}

{
  __reset();
  const h = noteSpend(A, 0.25);
  resolveSpend(h, false);
  const snap = exposureSnapshot();
  ok(snap.length === 1 && snap[0].unsettledUsd === 0.25 && snap[0].calls === 1,
    `the operator view reports who owes upstream spend (got ${JSON.stringify(snap)})`);
}

{
  // resolveSpend must never throw on junk - it runs inside a response
  // finish handler, where an exception would break the response.
  __reset();
  let threw = null;
  try { resolveSpend(null, true); resolveSpend({ payer: "nope", id: 9 }, true); resolveSpend(undefined, false); }
  catch (e) { threw = e; }
  ok(!threw, "resolving an unknown or missing handle is a no-op, never a throw");
}

// --- the coupling that would silently kill a tier ----------------------------
// If the ceiling is ever smaller than the largest execution tier's underlying
// cap, that tier is dead on arrival: a single legitimate call exceeds the
// ceiling and EVERY payer is refused, honest ones included. Nothing else would
// report this - the tier would simply never succeed - so it gets an assertion
// rather than the comment it started as.
{
  __reset();
  const { EXEC_TIERS } = await import("../src/tools/route-execute.js");
  const { __config } = await import("../src/external-spend-guard.js");
  const biggest = Math.max(...EXEC_TIERS.map((t) => t.underlyingMaxUsd));
  ok(__config.DEFAULT_MAX_UNSETTLED_USD >= biggest,
    `the unsettled ceiling ($${__config.DEFAULT_MAX_UNSETTLED_USD}) covers the largest tier's underlying cap ($${biggest}) - otherwise that tier can never run`);
  ok(maySpend("0x1111111111111111111111111111111111111111", biggest).ok,
    "a single largest-tier call is allowed for a payer with no exposure");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
