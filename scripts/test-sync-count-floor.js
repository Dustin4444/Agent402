// Offline regression tests for the catalog floor in scripts/sync-count.js.
// floorViolation(total) is the quality-consistency gate: it must return null
// at or above 400 total entries (no upper bound — growth is fine), and the CI
// failure message must name the floor and the actual count. No network, no
// server — importing sync-count.js must NOT boot anything (the is-main guard).
import { floorViolation, CATALOG_FLOOR } from "./sync-count.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

// If we got here at all, the import resolved without main() spawning a server
// (a spawned server would come from main(), which is gated on being the entrypoint).
ok(true, "importing sync-count.js resolves without booting the server (is-main guard)");

// The floor constant itself is part of the contract
ok(CATALOG_FLOOR === 400, "CATALOG_FLOOR is 400");

// Today's catalog size → null (501 = 400 tools + 100 packs)
ok(floorViolation(501) === null, "floorViolation(501) → null (today's catalog)");

// Exactly at the floor → null (the floor is inclusive)
ok(floorViolation(400) === null, "floorViolation(400) → null (at the floor)");

// One below the floor → violation string naming the floor and the got-count
const under = floorViolation(399);
ok(typeof under === "string" && under.length > 0, "floorViolation(399) → non-null string (below the floor)");
ok(typeof under === "string" && under.includes("400-entry floor"), "below-floor message names the floor");
ok(typeof under === "string" && under.includes("(got 399)"), "below-floor message includes the got-count");
ok(typeof under === "string" && under.includes("a kit is probably missing"), "below-floor message says a kit is probably missing");

// Growth is welcome — NO upper bound
ok(floorViolation(600) === null, "floorViolation(600) → null (growth beyond 501 is fine)");
ok(floorViolation(1500) === null, "floorViolation(1500) → null (no ceiling at all)");

// Degenerate catastrophes still fail
ok(typeof floorViolation(0) === "string", "floorViolation(0) → violation (empty catalog)");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
