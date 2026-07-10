// Unit tests for the revenue detector's classification logic — the part that
// decides what counts as a real external x402 payment. Guards against the bug
// where non-x402 transfers (funding/tests/swaps, e.g. $1/$5 from the owner's
// other wallet) were mislabeled as "external customer payments". Pure, no network.
import { isExternalPayment, payerFromLog } from "./revenue-scan.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

const OURS = new Set(["0xfeda7403aabe9a492ed70e810b396d8548a4a022"]);
const MAX = 0.5;
const ext = (row) => isExternalPayment(row, { ourWallets: OURS, maxUsd: MAX });

// payerFromLog: pulls the address out of the padded Transfer `from` topic.
ok(payerFromLog({ topics: ["0xddf2...", "0x000000000000000000000000abcdef0000000000000000000000000000001234", "0x..."] }) === "0xabcdef0000000000000000000000000000001234", "payerFromLog extracts from topics[1]");
ok(payerFromLog({ topics: ["0xddf2..."] }) === null, "payerFromLog null when no from topic");

// The exact false positives that triggered this fix: $1/$1/$5 inbound. Even from
// an unknown wallet, they exceed the per-call ceiling → NOT external customers.
ok(ext({ payer: "0x1111111111111111111111111111111111111111", usd: 1 }) === false, "$1 inbound excluded (over ceiling)");
ok(ext({ payer: "0x2222222222222222222222222222222222222222", usd: 5 }) === false, "$5 inbound excluded (over ceiling)");

// A real per-call payment from an unknown wallet IS external.
ok(ext({ payer: "0x3333333333333333333333333333333333333333", usd: 0.005 }) === true, "$0.005 from unknown wallet = external");
ok(ext({ payer: "0x4444444444444444444444444444444444444444", usd: 0.02 }) === true, "$0.02 (max price) from unknown wallet = external");

// Our own burner is never external, even at a per-call amount.
ok(ext({ payer: "0xFEDA7403AABE9A492ED70E810B396D8548A4A022", usd: 0.005 }) === false, "our burner excluded (case-insensitive)");

// Degenerate rows.
ok(ext({ payer: null, usd: 0.005 }) === false, "null payer excluded");
ok(ext({ payer: "0x5555555555555555555555555555555555555555", usd: 0 }) === false, "zero amount excluded");
ok(ext({ payer: "0x6666666666666666666666666666666666666666", usd: -1 }) === false, "negative amount excluded");

// Exactly at the ceiling is allowed; just over is not.
ok(ext({ payer: "0x7777777777777777777777777777777777777777", usd: 0.5 }) === true, "exactly at ceiling allowed");
ok(ext({ payer: "0x8888888888888888888888888888888888888888", usd: 0.50001 }) === false, "just over ceiling excluded");

// --- Stellar digest adapter (scripts/revenue-scan-stellar.js) ----------------
// The daily-digest Stellar scanner is a thin mapper over src/revenue-live.js's
// stellarRail() — the same code the live /revenue card runs, so the two
// surfaces cannot drift. These assertions pin the digest JSON contract.
const { digestFromStellarRail } = await import("./revenue-scan-stellar.js");
{
  const rail = { balance: 12.5, recent: [
    { when: "2026-07-09T00:00:00Z", usd: 0.001, from: "GABCDEF", tx: "https://stellar.expert/explorer/public/tx/aa", external: true, internal: false },
    { when: "2026-07-09T01:00:00Z", usd: 0.001, from: "GBA2DDJ4", tx: "https://stellar.expert/explorer/public/tx/bb", external: false, internal: true },
  ] };
  const d = digestFromStellarRail(rail);
  ok(d.balanceUsd === 12.5 && d.payments === 2, "stellar: balance + payment count map through");
  ok(Math.abs(d.totalUsd - 0.002) < 1e-9, "stellar: totalUsd sums all recent inbound");
  ok(d.external.length === 1 && d.external[0].payer === "GABCDEF", "stellar: only rail-classified external rows; G… casing preserved");
  ok(d.external[0].tx.startsWith("https://stellar.expert/"), "stellar: tx link passes through for the digest's [tx]() rendering");
}
{
  const d = digestFromStellarRail({ balance: null, recent: [] });
  ok(d.balanceUsd === null && d.payments === 0 && d.external.length === 0 && d.totalUsd === 0, "stellar: empty rail maps to an empty digest");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
