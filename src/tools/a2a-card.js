// A2A (Agent2Agent protocol) Agent Card validation — shared by the pure-CPU
// a2a-card-validate tool (agent-kit) and the egress a2a-card-fetch tool
// (network-kit). Built for the "minia2a" demand cluster (#461): agents keep
// asking the resolver for minimal A2A interop, and the deterministic slice of
// that is card discovery + structural validation.
//
// Validates the structural core of an A2A AgentCard (spec v0.3 line: required
// fields, skill shape, transport names, capability flags). Keywords outside
// this set are ignored, never silently "passing" something unchecked — same
// honesty rule as agent-kit's JSON-Schema validator. Deterministic, no LLM.

const KNOWN_TRANSPORTS = new Set(["JSONRPC", "GRPC", "HTTP+JSON"]);
const CAPABILITY_FLAGS = ["streaming", "pushNotifications", "stateTransitionHistory"];

const isStr = (v) => typeof v === "string" && v.length > 0;
const isArr = Array.isArray;
const isObj = (v) => typeof v === "object" && v !== null && !isArr(v);

/** The well-known paths an A2A server publishes its card at, in resolution
 *  order (v0.3 canonical path first, the older agent.json second). */
export const A2A_WELL_KNOWN_PATHS = ["/.well-known/agent-card.json", "/.well-known/agent.json"];

/**
 * Structurally validate an A2A AgentCard object.
 * Returns { valid, errors, warnings, summary } — errors are spec violations,
 * warnings are interop smells that don't make the card invalid.
 */
export function validateAgentCard(card) {
  const errors = [];
  const warnings = [];
  if (!isObj(card)) {
    return { valid: false, errors: ['card must be a JSON object'], warnings, summary: null };
  }

  // --- required core (AgentCard, spec v0.3) --------------------------------
  for (const f of ["name", "description", "url", "version"]) {
    if (!isStr(card[f])) errors.push(`missing or empty required string "${f}"`);
  }
  if (isStr(card.url)) {
    if (!/^https?:\/\//i.test(card.url)) errors.push('"url" must be an http(s) URL');
    else if (!/^https:\/\//i.test(card.url)) warnings.push('"url" is not https - most A2A clients require TLS');
  }
  if (!isObj(card.capabilities)) errors.push('missing required object "capabilities"');
  else {
    for (const flag of CAPABILITY_FLAGS) {
      if (flag in card.capabilities && typeof card.capabilities[flag] !== "boolean") {
        warnings.push(`capabilities.${flag} should be a boolean`);
      }
    }
  }
  for (const f of ["defaultInputModes", "defaultOutputModes"]) {
    if (!isArr(card[f]) || card[f].length === 0) errors.push(`missing or empty required array "${f}"`);
    else if (!card[f].every(isStr)) errors.push(`"${f}" entries must be non-empty strings (media types)`);
  }
  if (!isArr(card.skills)) errors.push('missing required array "skills"');
  else {
    if (card.skills.length === 0) warnings.push("skills is empty - clients cannot discover what this agent does");
    card.skills.forEach((s, i) => {
      if (!isObj(s)) { errors.push(`skills[${i}] must be an object`); return; }
      for (const f of ["id", "name", "description"]) {
        if (!isStr(s[f])) errors.push(`skills[${i}] missing required string "${f}"`);
      }
      if (!isArr(s.tags) || !s.tags.every(isStr)) errors.push(`skills[${i}] missing required string array "tags"`);
    });
    const ids = card.skills.filter(isObj).map((s) => s.id).filter(isStr);
    if (new Set(ids).size !== ids.length) errors.push("skill ids must be unique");
  }

  // --- interop smells (warnings) -------------------------------------------
  if (!isStr(card.protocolVersion)) warnings.push('no "protocolVersion" - clients will assume a spec version');
  if (isStr(card.preferredTransport)) {
    if (!KNOWN_TRANSPORTS.has(card.preferredTransport)) {
      warnings.push(`preferredTransport "${card.preferredTransport}" is not a registered transport (JSONRPC, GRPC, HTTP+JSON)`);
    }
  } else if ("preferredTransport" in card) {
    errors.push('"preferredTransport" must be a string when present');
  } else {
    warnings.push('no "preferredTransport" - clients will assume JSONRPC at "url"');
  }
  if (isArr(card.additionalInterfaces)) {
    card.additionalInterfaces.forEach((it, i) => {
      if (!isObj(it) || !isStr(it.url) || !isStr(it.transport)) {
        errors.push(`additionalInterfaces[${i}] must be { url, transport }`);
      } else if (!KNOWN_TRANSPORTS.has(it.transport)) {
        warnings.push(`additionalInterfaces[${i}].transport "${it.transport}" is not a registered transport`);
      }
    });
  }
  if (isObj(card.provider) && !isStr(card.provider.organization)) {
    warnings.push('provider present but missing "organization"');
  }

  const valid = errors.length === 0;
  // Amplification bound: a hostile ~512KB card with thousands of malformed
  // skills would otherwise emit one error string each. Cap both lists and say
  // so — validity is judged on the FULL count above, never the capped view.
  const MAX_REPORTED = 50;
  if (errors.length > MAX_REPORTED) {
    const dropped = errors.length - MAX_REPORTED;
    errors.length = MAX_REPORTED;
    errors.push(`… ${dropped} more error(s) truncated`);
  }
  if (warnings.length > MAX_REPORTED) {
    const dropped = warnings.length - MAX_REPORTED;
    warnings.length = MAX_REPORTED;
    warnings.push(`… ${dropped} more warning(s) truncated`);
  }
  const summary = {
    name: isStr(card.name) ? card.name : null,
    version: isStr(card.version) ? card.version : null,
    protocolVersion: isStr(card.protocolVersion) ? card.protocolVersion : null,
    url: isStr(card.url) ? card.url : null,
    preferredTransport: isStr(card.preferredTransport) ? card.preferredTransport : "JSONRPC (assumed)",
    provider: isObj(card.provider) && isStr(card.provider.organization) ? card.provider.organization : null,
    capabilities: isObj(card.capabilities)
      ? Object.fromEntries(CAPABILITY_FLAGS.map((f) => [f, card.capabilities[f] === true]))
      : null,
    skillCount: isArr(card.skills) ? card.skills.length : 0,
    skills: isArr(card.skills)
      ? card.skills.filter(isObj).slice(0, 20).map((s) => ({ id: s.id ?? null, name: s.name ?? null }))
      : [],
    interfaces: [
      ...(isStr(card.url) ? [{ url: card.url, transport: isStr(card.preferredTransport) ? card.preferredTransport : "JSONRPC" }] : []),
      ...(isArr(card.additionalInterfaces) ? card.additionalInterfaces.filter((it) => isObj(it) && isStr(it.url)) : []),
    ].slice(0, 10),
  };
  return { valid, errors, warnings, summary };
}

/** A minimal VALID example card — the discovery example for both tools and the
 *  static sample served at /samples/a2a-agent-card.json (clearly a sample: it
 *  describes a fictional weather agent, not this server). */
export const SAMPLE_AGENT_CARD = {
  protocolVersion: "0.3.0",
  name: "Sample Weather Agent",
  description: "A sample A2A Agent Card served as a static example for card tooling. This describes a fictional weather agent, not a live A2A endpoint.",
  url: "https://example.com/a2a/v1",
  preferredTransport: "JSONRPC",
  version: "1.0.0",
  provider: { organization: "Example Org", url: "https://example.com" },
  capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: false },
  defaultInputModes: ["application/json", "text/plain"],
  defaultOutputModes: ["application/json"],
  skills: [
    {
      id: "get-forecast",
      name: "Get weather forecast",
      description: "Returns a city's 5-day forecast.",
      tags: ["weather", "forecast"],
      examples: ["What is the weather in Paris this week?"],
    },
  ],
};
