// E2B cost/output caps (audit F12). stdout/stderr/result/traceback were
// returned unbounded; now an aggregate UTF-8 budget truncates them with an
// explicit marker, and a global concurrency ceiling refuses new sandboxes
// before creation. Offline unit test of the cap logic + config.
//
//   node scripts/test-code-run-caps.js
import { __test } from "../src/tools/code-run-kit.js";

const { capUtf8, TIERS, E2B_MAX_CONCURRENT } = __test;
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

// Under budget: unchanged, not truncated.
{
  const r = capUtf8("hello world", 1024);
  ok(r.text === "hello world" && !r.truncated && r.used === 11, "under-budget output is returned unchanged");
}

// Over budget: truncated to the byte budget with a marker + truncated flag.
{
  const r = capUtf8("x".repeat(100_000), 1024);
  ok(r.truncated === true, "over-budget output is flagged truncated");
  ok(/output truncated at 1024 bytes/.test(r.text), "carries an explicit truncation marker");
  ok(r.used === 1024, "accounts exactly the budget it consumed");
}

// UTF-8 safety: cutting mid-multibyte-char must not emit a broken/oversized string.
{
  const r = capUtf8("😀".repeat(1000), 10); // each emoji is 4 bytes
  ok(r.truncated, "multibyte output truncates");
  ok(!r.text.slice(0, r.text.indexOf("\n")).includes("�"), "no replacement char from a split multibyte boundary");
}

// Aggregate budgeting: a shared budget drained field-by-field (as the handler does).
{
  let budget = 1000;
  const take = (v) => { const c = capUtf8(v, Math.max(0, budget)); budget -= c.used; return c; };
  const a = take("a".repeat(600));
  const b = take("b".repeat(600)); // only ~400 bytes of budget left
  ok(!a.truncated && a.used === 600, "first field fits");
  ok(b.truncated && b.used === 400, "second field truncated to the REMAINING budget (aggregate cap)");
  ok(budget === 0, "aggregate budget fully consumed, never negative");
}

// Config sanity.
{
  ok(TIERS["code-run"].maxOutputBytes === 256 * 1024 && TIERS["code-run-pro"].maxOutputBytes === 1024 * 1024, "tiers carry an output byte cap");
  ok(typeof E2B_MAX_CONCURRENT === "number" && E2B_MAX_CONCURRENT >= 1, `global sandbox concurrency ceiling is set (${E2B_MAX_CONCURRENT})`);
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
