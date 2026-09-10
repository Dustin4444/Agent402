// OpenAI tool NAMESPACES on the gateway's chat and Responses wires.
//
// Why (2026-09-09, from the daily tool-error alert): one buyer sent ~130
// requests to /v1/metered/chat/completions carrying
//   { type: "namespace", name, description, tools: [{ type: "function", name, ... }] }
// and every one was refused 400 "Unsupported tools entry (type namespace)".
// A namespace is OpenAI's Responses-API grouping of function tools (their
// docs: "Tool namespaces let you group tools"; the FunctionCall output item
// carries a separate `namespace` field). OpenAI's Chat Completions reference
// lists no namespace type at all, and OpenRouter's support is unverified, so
// this module FLATTENS: every nested function becomes a plain function tool
// the model already understands, with the namespace's name and description
// folded into the function's description so the grouping context survives.
// On the Responses wire the mapping name -> namespace is kept so a
// function_call in the (non-streamed) output gets its `namespace` back.
//
// Cost-neutral: flattened tools are ordinary function tools, priced as input
// tokens by the margin clamp and the metered quote exactly like any other.
// Nested entries that are not function tools (custom, server tools) are
// refused by name, never dropped: a buyer must not believe a tool was offered.
import { bad } from "./llm-gateway-kit.js";

export const MAX_NAMESPACE_TOOLS = 64;
const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** Description shown to the model for a flattened function: "[ns] ns description. fn description". */
function foldDescription(ns, fn) {
  const head = `[${ns.name}]${typeof ns.description === "string" && ns.description.trim() ? ` ${ns.description.trim().replace(/\.?$/, ".")}` : ""}`;
  const own = typeof fn.description === "string" ? fn.description.trim() : "";
  return own ? `${head} ${own}` : head;
}

/** Read one nested function in either shape: Responses {type:"function", name,
 *  description, parameters, strict} or chat {type:"function", function:{...}}. */
function nestedFunction(t, where) {
  if (!t || typeof t !== "object") throw bad(`${where} must be a function tool object`);
  const type = String(t.type ?? "");
  if (type !== "function") {
    throw bad(`${where}: type "${type.slice(0, 40)}" is not served inside a namespace - only function tools are (custom and server-side tools are not offered on this route)`);
  }
  const f = t.function && typeof t.function === "object" ? t.function : t;
  if (typeof f.name !== "string" || !NAME_RE.test(f.name)) throw bad(`${where}.name must be a string of up to 64 letters, digits, "_", "-" or "."`);
  return { name: f.name, description: f.description, parameters: f.parameters, strict: f.strict };
}

/** Validate the namespace envelope and return its nested functions. */
function readNamespace(entry, where) {
  if (!entry || typeof entry !== "object" || entry.type !== "namespace") throw bad(`${where} is not a namespace tool`);
  if (typeof entry.name !== "string" || !NAME_RE.test(entry.name)) throw bad(`${where}.name (the namespace name) must be a string of up to 64 letters, digits, "_", "-" or "."`);
  if (entry.description !== undefined && typeof entry.description !== "string") throw bad(`${where}.description must be a string`);
  if (!Array.isArray(entry.tools) || entry.tools.length === 0 || entry.tools.length > MAX_NAMESPACE_TOOLS) {
    throw bad(`${where}.tools must be a non-empty array of up to ${MAX_NAMESPACE_TOOLS} function tools`);
  }
  return entry.tools.map((t, i) => nestedFunction(t, `${where}.tools[${i}]`));
}

/** Chat Completions wire: namespace -> [{type:"function", function:{...}}]. */
export function flattenNamespaceForChat(entry, where = "tools[]") {
  return readNamespace(entry, where).map((fn) => ({
    type: "function",
    function: {
      name: fn.name,
      description: foldDescription(entry, fn),
      ...(fn.parameters !== undefined ? { parameters: fn.parameters } : {}),
      ...(fn.strict !== undefined ? { strict: fn.strict } : {}),
    },
  }));
}

/** Responses wire: namespace -> [{type:"function", name, ...}] plus the
 *  name -> namespace map the output attribution needs. */
export function flattenNamespaceForResponses(entry, where = "tools[]") {
  const tools = readNamespace(entry, where).map((fn) => ({
    type: "function",
    name: fn.name,
    description: foldDescription(entry, fn),
    ...(fn.parameters !== undefined ? { parameters: fn.parameters } : {}),
    ...(fn.strict !== undefined ? { strict: fn.strict } : {}),
  }));
  const namespaceOf = {};
  for (const t of tools) namespaceOf[t.name] = entry.name;
  return { tools, namespaceOf };
}

/** Responses output: a function_call whose name came from a namespace gets
 *  the `namespace` field OpenAI's FunctionCall item carries. In place; a
 *  call that already names one is left alone. Never throws. */
export function attributeNamespaces(output, namespaceOf) {
  if (!Array.isArray(output) || !namespaceOf || typeof namespaceOf !== "object") return output;
  for (const item of output) {
    if (item && typeof item === "object" && item.type === "function_call" && typeof item.name === "string"
        && item.namespace === undefined && Object.hasOwn(namespaceOf, item.name)) {
      item.namespace = namespaceOf[item.name];
    }
  }
  return output;
}
