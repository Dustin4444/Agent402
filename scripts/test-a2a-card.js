// A2A Agent Card validator — offline unit tests. No network.
//   node scripts/test-a2a-card.js
import { validateAgentCard, SAMPLE_AGENT_CARD, A2A_WELL_KNOWN_PATHS, buildOurAgentCard } from "../src/tools/a2a-card.js";

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

// OUR OWN CARD (2026-09-18). We sold card validation and card fetching and
// served no card of our own. It is judged by the validator we sell, and the
// assertions below are the ones that keep it HONEST rather than merely valid:
// a card that claims a transport we do not run, or capabilities we do not
// have, is the manifest-overstatement defect wearing a different hat.
{
  const card = buildOurAgentCard({ baseUrl: "https://agent402.tools", version: "2.1.0", toolCount: 607 });
  const v = validateAgentCard(card);
  ok(v.valid, `our own card passes our own validator (${JSON.stringify(v.errors)})`);
  ok(v.warnings.length === 0, `and raises no interop warnings (${JSON.stringify(v.warnings)})`);
  ok(card.preferredTransport === "HTTP+JSON", "it declares HTTP+JSON, because we run no A2A JSON-RPC endpoint");
  ok(card.capabilities.streaming === false, "it does not claim A2A task streaming (our SSE is on the LLM routes)");
  ok(card.capabilities.pushNotifications === false && card.capabilities.stateTransitionHistory === false, "nor push notifications or state history");
  ok(card.provider.organization === "Havok Holdings LLC", "the provider is the operating entity, never a person");
  ok(card.url.startsWith("https://agent402.tools"), "the url points at our own origin");
  ok(new Set(card.skills.map((s) => s.id)).size === card.skills.length && card.skills.length >= 3, "skills are unique and there are enough to be useful");
  ok(card.skills.every((s) => s.tags.length > 0), "every skill carries tags an A2A client can match on");
  const stale = buildOurAgentCard({ baseUrl: "https://agent402.tools/", version: "2.1.0" });
  ok(stale.url === "https://agent402.tools/api", "a trailing slash on the base url never doubles");
  ok(/500\+ priced endpoints/.test(stale.description), "an unreadable catalog count falls back to the evergreen claim, never to a wrong number");
  ok(/607 priced endpoints/.test(card.description), "and a live count is used when there is one");
}

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
