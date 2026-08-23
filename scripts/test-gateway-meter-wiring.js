// The meter must be WIRED, and must fail safe.
//
// The pricing rule is unit-tested in test-gateway-meter.js. This checks the
// half a unit test cannot see: that the sentinel actually leaves the gateway,
// that the binder consumes it, and above all that the sentinel NEVER reaches a
// buyer - it carries our upstream bill, which is the one number the gateway
// strips from every response.
import { readFileSync } from "node:fs";

let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error("FAIL:", m); process.exit(1); } };

const kit = readFileSync("src/tools/llm-gateway-kit.js", "utf8");
const server = readFileSync("src/server.js", "utf8");

ok(/data\.__meterUpstreamUsd = upstreamUsd/.test(kit), "the gateway reports its real upstream cost on the response sentinel");
ok(/typeof upstreamUsd === "number"/.test(kit),
  "and only when upstream actually reported a number: a missing cost must mean 'no meter', never 'free'");

ok(/__meterUpstreamUsd/.test(server), "the route binder consumes the sentinel");
ok(/delete result\.__meterUpstreamUsd/.test(server),
  "the binder DELETES it before the body is sent: it is our upstream bill, and the gateway strips every other billing field for the same reason");

const block = server.slice(server.indexOf("if (result && typeof result.__meterUpstreamUsd"), server.indexOf("if (result && result.__binary)"));
ok(/isMeterable\(req\)/.test(block), "it only meters an upto payment (an exact payment fixed its amount at the 402)");
ok(/GATEWAY_METER_ON/.test(block), "it is behind a switch, so changing what buyers are charged is a deliberate act");
ok(/!res\.headersSent/.test(block), "it refuses once headers are sent: the override rides a response header and a late write is silently lost");
ok(/catch/.test(block) && /settling at the ceiling/.test(block),
  "anything thrown leaves NO override, so the buyer settles at the ceiling they authorized rather than an accidental amount");

// The switch must default OFF. A metering default that flips on with a deploy
// would change every gateway buyer's bill without anyone choosing it.
ok(/GATEWAY_METERED_BILLING \|\| ""\)\.toLowerCase\(\) === "on"/.test(server),
  "metering is OFF unless GATEWAY_METERED_BILLING is explicitly 'on'");

console.log(`\n${pass} passed, 0 failed`);
