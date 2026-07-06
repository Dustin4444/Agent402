// Locks the ReDoS guard for caller-supplied regexes (json-validate, html-links).
// A user regex runs on the shared event loop, so a catastrophic-backtracking
// pattern is an unauthenticated, free-tier server-wide DoS — this guard rejects
// the dangerous shapes before compiling. Offline, deterministic.
import { compileUserRegex, escapeRegex } from "../src/tools/safe-regex.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const rejects = (p) => { try { compileUserRegex(p); return false; } catch (e) { return e.statusCode === 400; } };

ok(rejects("(a+)+$"), "rejects the classic nested-quantifier ReDoS (a+)+$");
ok(rejects("([a-z]+)+"), "rejects ([a-z]+)+");
ok(rejects("(.*)*"), "rejects (.*)*");
ok(rejects("(\\d+)*"), "rejects (\\d+)*");
ok(rejects("a".repeat(201)), "rejects an over-long pattern (>200 chars)");
ok(compileUserRegex("^[a-z0-9]+$").test("abc1") === true, "compiles + runs a legit anchored pattern");
ok(compileUserRegex("^\\S+@\\S+\\.\\S+$").test("a@b.co") === true, "compiles a legit email-ish pattern");
try { compileUserRegex("("); ok(false, "invalid regex should throw"); }
catch (e) { ok(e.statusCode === 400, "invalid regex throws a 400"); }
ok(escapeRegex("(a+)+$") === "\\(a\\+\\)\\+\\$", "escapeRegex neutralizes a regex-injection value");
ok(new RegExp(`^${escapeRegex("a.b")}$`).test("a.b") && !new RegExp(`^${escapeRegex("a.b")}$`).test("axb"),
  "an escaped value matches literally, not as a regex metacharacter");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
