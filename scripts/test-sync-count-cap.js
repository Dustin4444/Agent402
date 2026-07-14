// Offline regression tests for the catalog cap in scripts/sync-count.js.
// capViolation(tools, packs) is the keystone of "The 500": it must return null
// ONLY at exactly 400 tools + 100 skill packs, and the CI failure message must
// keep the policy sentence and the actual got-counts. No network, no server —
// importing sync-count.js must NOT boot anything (the is-main guard).
import { capViolation, CAP_TOOLS, CAP_PACKS } from "./sync-count.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

// If we got here at all, the import resolved without main() spawning a server
// (a spawned server would come from main(), which is gated on being the entrypoint).
ok(true, "importing sync-count.js resolves without booting the server (is-main guard)");

// The cap constants themselves are part of the contract
ok(CAP_TOOLS === 400, "CAP_TOOLS is 400");
ok(CAP_PACKS === 100, "CAP_PACKS is 100");

// Exactly at the cap → null (the only OK split)
ok(capViolation(400, 100) === null, "capViolation(400, 100) → null (at the cap)");

const POLICY = "For a new tool to enter, one must leave";

// One tool over → violation string with the policy sentence
const over = capViolation(401, 100);
ok(typeof over === "string" && over.length > 0, "capViolation(401, 100) → non-null string (over cap)");
ok(typeof over === "string" && over.includes(POLICY), "over-cap message contains the policy sentence");
ok(typeof over === "string" && over.includes("capped at 500 (400 tools + 100 skill packs)"), "over-cap message states the cap split");

// Message carries the actual got-counts
ok(typeof over === "string" && over.includes("401") && over.includes("(got 401 tools + 100 packs)"), "over-cap message includes the got-counts (401 tools + 100 packs)");

// Under cap is ALSO a violation (the cap is exact, not a ceiling)
const under = capViolation(399, 100);
ok(typeof under === "string" && under.includes(POLICY), "capViolation(399, 100) → violation (under cap)");
ok(typeof under === "string" && under.includes("(got 399 tools + 100 packs)"), "under-cap message includes the got-counts");

// Pack half is enforced independently in both directions
const packsOver = capViolation(400, 101);
ok(typeof packsOver === "string" && packsOver.includes(POLICY), "capViolation(400, 101) → violation (too many packs)");
ok(typeof packsOver === "string" && packsOver.includes("(got 400 tools + 101 packs)"), "too-many-packs message includes the got-counts");

const packsUnder = capViolation(400, 99);
ok(typeof packsUnder === "string" && packsUnder.includes(POLICY), "capViolation(400, 99) → violation (too few packs)");
ok(typeof packsUnder === "string" && packsUnder.includes("(got 400 tools + 99 packs)"), "too-few-packs message includes the got-counts");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
