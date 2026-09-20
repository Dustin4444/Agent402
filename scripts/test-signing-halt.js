// H-01/H-03: one lever halts every signing path, and the daily ceiling survives
// a restart.
//
// Both halves run their CONTROL FIRST. A guard that only ever refuses would pass
// while proving nothing, and a persistence test whose ceiling never refuses in
// the first place proves nothing either.
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// ── H-01: the halt ──────────────────────────────────────────────────────────
const { signingHalted, assertSigningAllowed } = await import("../src/signing-halt.js");
const halted = (v) => { process.env.SIGNING_HALTED = v; return signingHalted(); };

ok(halted("") === false, "control: unset permits signing");
ok(halted("off") === false, "explicit off permits signing");
ok(halted("false") === false, "false permits signing");
ok(halted("0") === false, "0 permits signing");

ok(halted("1") === true, "1 halts");
ok(halted("true") === true, "true halts");
ok(halted("  ON  ") === true, "whitespace and case tolerated");
// The property that matters most: a typo must stop spending, not permit it.
ok(halted("disabled") === true, "a MALFORMED value HALTS - fails closed, never open");
ok(halted("no-really-off") === true, "an almost-off value halts");

process.env.SIGNING_HALTED = "1";
try { assertSigningAllowed("a test payment"); ok(false, "halted state throws"); }
catch (e) {
  // 503 and not 4xx: a halt is our configuration, not the caller's error, and a
  // status >= 400 already cancels settlement so nobody pays to meet it.
  ok(e.statusCode === 503, `the refusal is 503, not ${e.statusCode}`);
  ok(/not attempted/i.test(e.message) && /Nothing was charged/i.test(e.message),
    "the refusal states nothing was charged");
}
process.env.SIGNING_HALTED = "";
try { assertSigningAllowed("x"); ok(true, "permitted state does not throw"); }
catch { ok(false, "permitted state does not throw"); }

// EVERY signing path consults it, pinned from source: a new signing path added
// without the check fails here rather than shipping unguarded.
const MUST_GUARD = [
  "src/x402-buyer.js", "src/solana-buyer.js", "src/tempo-buyer.js",
  "src/tools/attest-kit.js", "src/tools/blockscout-kit.js", "src/mpp-subscriptions.js",
];
for (const f of MUST_GUARD) {
  const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
  ok(/assertSigningAllowed\(/.test(src), `${f} consults the halt`);
}

// ── H-03: the ceiling survives a restart ────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), "spendguard-"));
process.env.WALLET_DAILY_LEDGER_FILE = join(dir, "wallet-daily-spend.json");
process.env.SOR_WALLET_DAILY_MAX_USD = "1.00";

const g1 = await import("../src/external-spend-guard.js?boot=1");
const h = g1.maySpend("0xpayer-a", 0.90, { chain: "base" });
ok(h && h.ok !== false, "control: a first spend under the cap is permitted");
g1.noteSpend("0xpayer-a", 0.90, { chain: "base" });
const refused = g1.maySpend("0xpayer-b", 0.90, { chain: "base" });
ok(refused?.ok === false, "control: the chain ceiling refuses once the day is spent");

await new Promise((r) => setTimeout(r, 2400));
ok(existsSync(process.env.WALLET_DAILY_LEDGER_FILE), "the chain ledger reached disk");

// A fresh module instance IS a restart.
const g2 = await import("../src/external-spend-guard.js?boot=2");
const after = g2.maySpend("0xpayer-c", 0.90, { chain: "base" });
ok(after?.ok === false, "after a RESTART the day is still spent - the ceiling did not reset");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
