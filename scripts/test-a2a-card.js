// A2A Agent Card validator — offline unit tests. No network.
//   node scripts/test-a2a-card.js
import { validateAgentCard, SAMPLE_AGENT_CARD, A2A_WELL_KNOWN_PATHS } from "../src/tools/a2a-card.js";

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`ok - ${msg}`); }
  else { failed++; console.error(`FAIL - ${msg}`); }
};

// the shipped sample must be VALID — it is both tools' discovery example
const sample = validateAgentCard(SAMPLE_AGENT_CARD);
ok(sample.valid && sample.errors.length === 0, `SAMPLE_AGENT_CARD is valid (errors: ${JSON.stringify(sample.errors)})`);
ok(sample.summary.name === "Sample Weather Agent" && sample.summary.skillCount === 1, "sample summary carries name + skillCount");
ok(sample.summary.preferredTransport === "JSONRPC", "sample summary reads the declared transport");

// required-field enforcement
const missing = validateAgentCard({ name: "x" });
ok(!missing.valid, "card missing core fields is invalid");
for (const f of ["description", "url", "version", "capabilities", "defaultInputModes", "defaultOutputModes", "skills"]) {
  ok(missing.errors.some((e) => e.includes(`"${f}"`)), `missing "${f}" is reported`);
}

// non-object input never throws
ok(validateAgentCard(null).valid === false, "null card → invalid, no throw");
ok(validateAgentCard("{}").valid === false, "string card → invalid, no throw");

// skill shape
const badSkill = validateAgentCard({ ...SAMPLE_AGENT_CARD, skills: [{ id: "a", name: "A", description: "d", tags: ["t"] }, { id: "a", name: "B", description: "d", tags: ["t"] }] });
ok(badSkill.errors.some((e) => e.includes("unique")), "duplicate skill ids are an error");
const noTags = validateAgentCard({ ...SAMPLE_AGENT_CARD, skills: [{ id: "a", name: "A", description: "d" }] });
ok(noTags.errors.some((e) => e.includes("tags")), "skill without tags is an error");

// url + transport rules
ok(validateAgentCard({ ...SAMPLE_AGENT_CARD, url: "ftp://x" }).errors.some((e) => e.includes("http")), "non-http url is an error");
ok(validateAgentCard({ ...SAMPLE_AGENT_CARD, url: "http://x.example" }).warnings.some((w) => w.includes("https")), "plain-http url is a warning, not an error");
ok(validateAgentCard({ ...SAMPLE_AGENT_CARD, preferredTransport: "CARRIER_PIGEON" }).warnings.some((w) => w.includes("registered transport")), "unknown transport warns");
const noTransport = validateAgentCard((({ preferredTransport, ...rest }) => rest)(SAMPLE_AGENT_CARD));
ok(noTransport.valid && noTransport.warnings.some((w) => w.includes("JSONRPC")), "absent transport is valid + assumed-JSONRPC warning");

// empty skills = warning, not error
const empty = validateAgentCard({ ...SAMPLE_AGENT_CARD, skills: [] });
ok(empty.valid && empty.warnings.some((w) => w.includes("skills is empty")), "empty skills array warns but stays valid");

// additionalInterfaces shape
const badIf = validateAgentCard({ ...SAMPLE_AGENT_CARD, additionalInterfaces: [{ url: "https://x.example" }] });
ok(badIf.errors.some((e) => e.includes("additionalInterfaces[0]")), "malformed additionalInterfaces entry is an error");

// resolution order constant (a2a-card-fetch depends on canonical-first)
ok(A2A_WELL_KNOWN_PATHS[0] === "/.well-known/agent-card.json" && A2A_WELL_KNOWN_PATHS[1] === "/.well-known/agent.json", "well-known resolution order is canonical-first");

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
