// Payer concentration on leaderboard rows.
//
// Why this test exists: the #1 seller by settled volume on 2026-09-13 drew
// 99.5% of its settlements and 99.0% of its dollars from ONE wallet, and every
// public surface we ran reported its call count and buyer count with nothing
// that could tell a reader so. Nine of the top 22 Base sellers are over 85%
// single-payer. The counts were true; the impression they left was not.
//
// What is pinned here is the honesty of the derivation, not the numbers:
//   - no payer ADDRESS ever reaches a row (their customer list, not ours)
//   - uniqueBuyers is unchanged by the switch from a Set to per-payer tallies
//   - an empty window is not a concentrated window
//   - both axes can trip the flag, because the seller that prompted this is a
//     MINORITY of calls and a supermajority of dollars
//   - the reference wallet is ONE wallet, and the row says when dollars are
//     concentrated somewhere its call share cannot see
import { payerConcentration, finalizeLeaderboard, initWalletAccumulator, foldTransfers, CONCENTRATION } from "../src/leaderboard.js";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}${JSON.stringify(a) === JSON.stringify(b) ? "" : ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`);

const pm = (o) => new Map(Object.entries(o));

// --- the shape that started this: minority of calls, supermajority of dollars
{
  // BlockRun's real 7d shape, rounded: one wallet 41% of calls, 95% of dollars.
  const m = pm({ whale: { calls: 41, usd: 94.7 }, a: { calls: 30, usd: 2.6 }, b: { calls: 29, usd: 2.7 } });
  const r = payerConcentration(m, 100, 100);
  eq(r.topPayerCallsShare, 0.41, "call share reported");
  eq(r.topPayerUsdShare, 0.947, "dollar share reported");
  eq(r.concentration, "single-payer-supermajority",
     "a MINORITY of calls still flags when dollars are a supermajority - a call-count-only rule would have called this seller unremarkable");
  eq(r.withoutTopPayer, { callsSettled: 59, totalUsd: 5.3, uniqueBuyers: 2 }, "residual removes that same wallet on both axes");
  ok(r.topPayerIsAlsoTopUsd === true, "busiest payer is also the dollar leader here");
}

// --- dollars concentrated on a DIFFERENT wallet than calls
{
  const m = pm({ chatty: { calls: 90, usd: 1 }, rich: { calls: 10, usd: 99 } });
  const r = payerConcentration(m, 100, 100);
  ok(r.topPayerIsAlsoTopUsd === false,
     "says so when a different payer carries the dollars, so topPayerUsdShare is not read as the whole story");
  eq(r.topPayerCallsShare, 0.9, "reference wallet stays the busiest by calls");
  eq(r.topPayerUsdShare, 0.01, "and reports ITS dollar share, not the other wallet's");
  eq(r.concentration, "single-payer-supermajority", "still flagged, on the call axis");
}

// --- an empty window is not a concentrated window
{
  eq(payerConcentration(new Map(), 0, 0).concentration, null, "no payers: no flag");
  eq(payerConcentration(new Map(), 0, 0).topPayerCallsShare, null, "no payers: no invented share");
  // A payer row present but zero settled calls: the flag alone does not catch a
  // missing guard here (0/0 is NaN, and NaN fails both threshold comparisons,
  // so `concentration` still reads null while the SHARE is garbage). Assert the
  // share, which is the field that would ship NaN into a public JSON surface.
  const zero = payerConcentration(pm({ a: { calls: 0, usd: 0 } }), 0, 0);
  eq(zero.concentration, null, "zero calls: no flag");
  eq(zero.topPayerCallsShare, null, "zero calls: share is null, never NaN");
  eq(zero.withoutTopPayer, null, "zero calls: no residual");
}

// --- a genuinely broad seller is not flagged
{
  const wide = new Map();
  for (let i = 0; i < 100; i++) wide.set(`p${i}`, { calls: 1, usd: 0.01 });
  const r = payerConcentration(wide, 100, 1);
  eq(r.concentration, null, "100 payers at 1 call each: no flag");
  eq(r.topPayerCallsShare, 0.01, "share is honest at 1%");
}

// --- one payer is 100%, and says so rather than hiding behind a small count
{
  const r = payerConcentration(pm({ only: { calls: 5, usd: 5 } }), 5, 5);
  eq(r.topPayerCallsShare, 1, "sole payer reads 1.0");
  eq(r.withoutTopPayer, { callsSettled: 0, totalUsd: 0, uniqueBuyers: 0 }, "nothing is left without them");
  eq(r.concentration, "single-payer-supermajority", "flagged");
}

// --- threshold boundaries are inclusive, as the published legend says
{
  // Spread the remainder across enough payers that none of them outranks `a`,
  // or the "just under" case simply promotes the other wallet to reference and
  // the assertion tests nothing. (First draft did exactly that.)
  const at = (share) => {
    const m = pm({ a: { calls: share * 100, usd: share * 100 } });
    const rest = 100 - share * 100;
    for (let i = 0; i < 10; i++) m.set(`r${i}`, { calls: rest / 10, usd: rest / 10 });
    return payerConcentration(m, 100, 100).concentration;
  };
  eq(at(CONCENTRATION.majority), "single-payer-majority", "exactly at the majority threshold flags");
  eq(at(CONCENTRATION.supermajority), "single-payer-supermajority", "exactly at the supermajority threshold flags");
  eq(at(0.49), null, "just under does not");
}

// --- NO PAYER ADDRESS REACHES A ROW
{
  const by = initWalletAccumulator([{ wallet: "0xseller", name: "S", origins: [], homepage: "https://s.example", endpoints: 1, network: "base" }]);
  foldTransfers(by, [
    { wallet: "0xseller", payer: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef", usd: 0.5 },
    { wallet: "0xseller", payer: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef", usd: 0.5 },
    { wallet: "0xseller", payer: "0xcafebabecafebabecafebabecafebabecafebabe", usd: 0.1 },
  ]);
  const [row] = finalizeLeaderboard(by);
  const blob = JSON.stringify(row).toLowerCase();
  ok(!blob.includes("deadbeef") && !blob.includes("cafebabe"),
     "no payer address appears anywhere in a published row - a seller's payer roster is their customer list");
  eq(row.uniqueBuyers, 2, "uniqueBuyers is unchanged by the per-payer switch (it is perPayer.size)");
  eq(row.topPayerCallsShare, 0.6667, "concentration computed through the real fold path");
  eq(row.withoutTopPayer.uniqueBuyers, 1, "residual buyer count excludes the top payer");
  ok(!("perPayer" in row) && !("buyers" in row), "the internal tally map never leaks onto the row");
}

// --- rows with no payer attribution at all still rank, without a fabricated flag
{
  const by = initWalletAccumulator([{ wallet: "0xq", name: "Q", origins: [], homepage: "https://q.example", endpoints: 1, network: "base" }]);
  foldTransfers(by, [{ wallet: "0xq", payer: null, usd: 0.2 }]);
  const [row] = finalizeLeaderboard(by);
  eq(row.callsSettled, 1, "the settlement still counts");
  eq(row.uniqueBuyers, 0, "with no attributable payer");
  eq(row.concentration, null, "and no flag is invented from an unattributed call");
}

// --- the legend is published, so the flag is reproducible from the two shares
{
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/concentrationLegend/.test(src), "/api/leaderboard publishes a concentration legend");
  ok(/payerAddresses: "never published/.test(src), "the legend states that payer addresses are never published");
  ok(/thresholds: CONCENTRATION/.test(src), "and carries the live thresholds, not a typed copy that can drift");
  ok(/selfRow:/.test(src), "and says our own row is measured on the same terms");
}

console.log(`\ntest-payer-concentration: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
