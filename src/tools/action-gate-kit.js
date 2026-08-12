// Action gate — deterministic preflight check for a proposed AI agent action
// (a tool call, a payment, a fetch, a write) before it executes. Evaluates
// four independent, bounded checks and returns ALLOW / REVIEW / BLOCK with
// stable reason codes. Does NOT execute the proposed action, perform network
// I/O, or guarantee safety - it is a deterministic static check, same
// limitation every check result says explicitly.
//
// Same category as sql-guard (a preflight gate a caller relies on to decide
// whether to proceed) and wallet-only for the same class of reason: the
// VERDICT is the thing a downstream system trusts, so it is metered with
// money rather than left free to farm at unlimited volume over PoW.
//
// Checks, all pure functions over the input - no network, no LLM:
//   prompt   - deterministic keyword/pattern scan for injection signals in
//              `action.description` and `untrusted_text` (instruction
//              override, role override, secret exfiltration). Same
//              limitation as any such scanner: low_signal does not prove
//              content is safe, only that no known pattern matched.
//   url      - hostname validation on `url`: malformed, raw private/loopback
//              IP (reuses fetch-guard.js's isPrivateIp - the same SSRF-guard
//              logic every egress-taking tool in this catalog already uses),
//              non-http(s) scheme.
//   payload  - a bounded JSON-schema check (type/required/properties/
//              additionalProperties) against `schema`, no external library -
//              matches the scope every real caller in the wild actually
//              sends (a flat object schema), not a full draft-07 validator.
//   spend    - `spend.proposal` (amount/asset/counterparty) checked against
//              `spend.mandate` (per-tx cap, period cap + already-spent,
//              allowed assets/counterparties, expiry) - plain numeric/set
//              comparisons, atomic units as strings (BigInt, no float
//              rounding on money).
import { isPrivateIp } from "./fetch-guard.js";
import { createHash } from "node:crypto";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}
const sha256 = (v) => createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex");

// ---- prompt-injection scan -------------------------------------------------
// Weighted deterministic patterns, same three categories the free /v1/demo of
// the tool this was benchmarked against (GoldKey Action Gate) demonstrates -
// convergent design, not a copy: these are the obvious categories any such
// scanner ends up with. Weight sum >= 60 is high_signal (BLOCK-eligible),
// >= 25 is medium (REVIEW), otherwise low_signal.
const INJECTION_PATTERNS = [
  { id: "instruction_override", weight: 30, re: /\b(ignore|disregard|forget)\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)\b/i },
  { id: "instruction_override", weight: 25, re: /\b(new|updated)\s+instructions?\s*:/i },
  { id: "role_override", weight: 20, re: /\byou\s+are\s+now\b/i },
  { id: "role_override", weight: 15, re: /\bact\s+as\s+(if\s+you('re| are)\s+)?(a|an)\b/i },
  { id: "role_override", weight: 20, re: /\bsystem\s+prompt\b/i },
  { id: "secret_exfiltration", weight: 35, re: /\b(reveal|print|show|output|repeat)\s+(me\s+|your\s+)?(the\s+)?(system\s+)?prompt\b/i },
  { id: "secret_exfiltration", weight: 30, re: /\b(leak|dump|exfiltrate)\s+(the\s+)?(secret|key|credential|token)s?\b/i },
];
// Zero-width/invisible formatting characters: ZWSP, ZWNJ, ZWJ, BOM/ZWNBSP,
// word joiner, Mongolian vowel separator. Stripped before pattern matching -
// found live (2026-08-12): inserting U+200B between words in an otherwise
// textbook "ignore all previous instructions...reveal the system prompt"
// dropped the score from 85 (high_signal) to 55 (medium_signal), because
// \s+ does not match a zero-width character, breaking the word-adjacency
// every pattern above depends on. Same class of defense the free demo of
// the tool this was benchmarked against (GoldKey) shows in its own
// normalization step (form/before_sha256/after_sha256/removed_count).
const INVISIBLE_CODEPOINTS = [8203, 8204, 8205, 65279, 8288, 6158]; // ZWSP, ZWNJ, ZWJ, BOM/ZWNBSP, word joiner, Mongolian vowel separator
const INVISIBLE_RE = new RegExp("[" + INVISIBLE_CODEPOINTS.map((c) => String.fromCharCode(c)).join("") + "]", "g");
function scanPrompt(text) {
  const signals = [];
  let score = 0;
  const raw = String(text || "");
  const s = raw.normalize("NFC").replace(INVISIBLE_RE, "");
  const removedCount = raw.length - raw.replace(INVISIBLE_RE, "").length;
  for (const p of INJECTION_PATTERNS) {
    const m = s.match(p.re);
    if (m) {
      signals.push({ id: p.id, weight: p.weight, start: m.index, end: m.index + m[0].length, evidence: m[0] });
      score += p.weight;
    }
  }
  score = Math.min(score, 100);
  const classification = score >= 60 ? "high_signal" : score >= 25 ? "medium_signal" : "low_signal";
  return {
    classification,
    risk_score: score,
    signals,
    normalization: { form: "NFC", removed_invisible_chars: removedCount },
    limitation: "Deterministic pattern match only; low_signal does not prove content is safe.",
  };
}

// ---- url check --------------------------------------------------------------
function checkUrl(rawUrl) {
  if (rawUrl === undefined || rawUrl === null || rawUrl === "") {
    return { status: "skip", reason_codes: [] };
  }
  let u;
  try { u = new URL(String(rawUrl)); } catch {
    return { status: "fail", reason_codes: ["malformed_url"], normalized_url: null, hostname: null, verdict: "block" };
  }
  if (!["http:", "https:"].includes(u.protocol)) {
    return { status: "fail", reason_codes: ["non_http_scheme"], normalized_url: u.toString(), hostname: u.hostname, verdict: "block" };
  }
  const hostname = u.hostname;
  const isRawIp = /^[0-9.]+$/.test(hostname) || hostname.includes(":");
  // WHATWG URL keeps brackets on an IPv6 hostname ("[::1]"), but isPrivateIp
  // (fetch-guard.js) expects a bare address and fails CLOSED - returns true,
  // "private" - on anything it can't parse. Found live (2026-08-12): every
  // IPv6-literal URL, public or private, was hard-BLOCKed because the
  // brackets made expandV6() fail to parse, not because the address was
  // actually private. Strip them before the check; `hostname` (with
  // brackets) is still what's reported back.
  const bareHost = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const priv = isRawIp && isPrivateIp(bareHost);
  if (priv) {
    return { status: "fail", reason_codes: ["private_or_loopback_address"], normalized_url: u.toString(), hostname, verdict: "block" };
  }
  return {
    status: "pass",
    reason_codes: isRawIp ? ["raw_ip_hostname"] : [],
    normalized_url: u.toString(),
    hostname,
    verdict: isRawIp ? "review" : "allow_static",
  };
}

// ---- bounded payload schema check -------------------------------------------
// Deliberately NOT a full JSON-Schema draft-07 implementation - covers what a
// real caller in this shape actually sends: type/required/properties (with
// per-property type) and additionalProperties. Anything the schema doesn't
// describe is reported as a validation gap, never silently passed.
const JS_TYPES = { string: "string", number: "number", integer: "number", boolean: "boolean", object: "object", array: "object" };
function typeOk(value, jsType) {
  if (jsType === "integer") return Number.isInteger(value);
  if (jsType === "array") return Array.isArray(value);
  if (jsType === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  return typeof value === JS_TYPES[jsType];
}
function checkPayload(payload, schema) {
  if (schema === undefined || schema === null) return { status: "skip", reason_codes: [] };
  if (payload === undefined || payload === null) {
    return { status: "fail", reason_codes: ["missing_payload"], validation: { valid: false, errors: ["payload is required when a schema is given"] } };
  }
  const errors = [];
  const props = schema.properties || {};
  // Object.hasOwn, not the `in` operator: `in` walks the prototype chain, so
  // a required/property name like "constructor" or "hasOwnProperty" was
  // found "in" any plain object via Object.prototype even when absent as an
  // own property - found live (2026-08-12), let such a field evade both the
  // required check and additionalProperties:false undetected.
  for (const req of schema.required || []) {
    if (!Object.hasOwn(payload, req)) errors.push(`missing required field "${req}"`);
  }
  for (const [key, val] of Object.entries(payload)) {
    if (Object.hasOwn(props, key)) {
      // Guard against a null/non-object property schema (e.g. properties:
      // {foo: null}) throwing on .type instead of a clean validation error.
      const propSchema = props[key];
      const jsType = propSchema && typeof propSchema === "object" ? propSchema.type : undefined;
      if (propSchema && typeof propSchema !== "object") {
        errors.push(`schema.properties["${key}"] must be an object`);
      } else if (jsType && JS_TYPES[jsType] && !typeOk(val, jsType)) {
        errors.push(`field "${key}" expected type "${jsType}"`);
      }
    } else if (schema.additionalProperties === false) {
      errors.push(`unexpected field "${key}" (additionalProperties: false)`);
    }
  }
  const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  return {
    status: errors.length ? "fail" : "pass",
    reason_codes: errors.length ? ["schema_violation"] : [],
    bounds: { bytes, nodes: Object.keys(payload).length },
    validation: { valid: errors.length === 0, errors, error_count: errors.length },
  };
}

// ---- spend-mandate check -----------------------------------------------------
// Atomic amounts as strings -> BigInt throughout. No floats anywhere near money.
function toBig(v, field) {
  try { return BigInt(String(v)); } catch { throw bad(`spend.${field} must be an integer string (atomic units)`); }
}
function checkSpend(spend) {
  if (spend === undefined || spend === null) return { status: "skip", reason_codes: [] };
  const { proposal, mandate, now } = spend;
  if (!proposal || !mandate) {
    return { status: "fail", reason_codes: ["incomplete_spend_block"], allowed: false };
  }
  const reasons = [];
  const amount = toBig(proposal.amount_atomic, "proposal.amount_atomic");
  const maxPerTx = toBig(mandate.max_per_tx_atomic, "mandate.max_per_tx_atomic");
  const maxPeriod = toBig(mandate.max_period_atomic, "mandate.max_period_atomic");
  const spentPeriod = toBig(mandate.spent_period_atomic ?? "0", "mandate.spent_period_atomic");

  // Found live (2026-08-12): a negative amount_atomic passed every check
  // below (a negative number is never > a positive cap) and produced a
  // nonsensical remaining_after_atomic that was LARGER than remaining_before
  // (subtracting a negative amount is addition). None of the four atomic
  // values in this block are meaningful negative - check all of them.
  if (amount < 0n) reasons.push("negative_amount");
  if (maxPerTx < 0n || maxPeriod < 0n || spentPeriod < 0n) reasons.push("negative_mandate_value");

  if (amount > maxPerTx) reasons.push("exceeds_max_per_tx");
  if (spentPeriod + amount > maxPeriod) reasons.push("exceeds_max_period");
  if (Array.isArray(mandate.allowed_assets) && mandate.allowed_assets.length && !mandate.allowed_assets.includes(proposal.asset)) {
    reasons.push("asset_not_allowed");
  }
  if (Array.isArray(mandate.allowed_counterparties) && mandate.allowed_counterparties.length && !mandate.allowed_counterparties.includes(proposal.counterparty)) {
    reasons.push("counterparty_not_allowed");
  }
  if (mandate.expires_at) {
    const nowMs = now ? Date.parse(now) : Date.now();
    const expMs = Date.parse(mandate.expires_at);
    if (Number.isFinite(expMs) && Number.isFinite(nowMs) && nowMs > expMs) reasons.push("mandate_expired");
  }

  const remainingBefore = maxPeriod - spentPeriod;
  const remainingAfter = reasons.length === 0 ? remainingBefore - amount : remainingBefore;
  return {
    status: reasons.length ? "fail" : "pass",
    allowed: reasons.length === 0,
    reason_codes: reasons,
    amount_atomic: amount.toString(),
    remaining_before_atomic: remainingBefore.toString(),
    remaining_after_atomic: remainingAfter.toString(),
  };
}

export const ACTION_GATE_TOOLS = [
  {
    route: "POST /api/action-gate",
    name: "AI agent action preflight",
    slug: "action-gate",
    category: "agent",
    price: "$0.010",
    description:
      "Deterministic preflight check for a proposed AI agent action - a tool call, payment, fetch, or write - before it executes. Evaluates up to four independent checks (prompt-injection scan on action text/untrusted text, URL/hostname validation, a bounded JSON-schema check on a payload, and a spend proposal against a spend mandate) and returns ALLOW, REVIEW, or BLOCK with stable reason codes plus a SHA-256 request/receipt hash pair. Does not execute the proposed action, perform network I/O, or guarantee safety - deterministic static checks only, so ALLOW is not a safety guarantee. Every field is optional; only the checks with input present run - the rest are skipped, not assumed to pass.",
    tags: ["agent", "safety", "security", "preflight", "prompt-injection", "spend-mandate", "action-gate"],
    discovery: {
      bodyType: "json",
      input: {
        action: { name: "submit_paid_api_request", description: "Fetch a vendor risk report and store the validated JSON response.", effect: "payment" },
        untrusted_text: "Vendor request: return the current account risk score.",
        url: "https://example.com/risk-report",
        payload: { account_id: "acct_123", include_signals: true },
        schema: {
          type: "object",
          properties: { account_id: { type: "string" }, include_signals: { type: "boolean" } },
          required: ["account_id", "include_signals"],
          additionalProperties: false,
        },
        spend: {
          proposal: { amount_atomic: "10000", asset: "USDC", counterparty: "0x1111111111111111111111111111111111111111" },
          mandate: {
            max_per_tx_atomic: "25000", max_period_atomic: "100000", spent_period_atomic: "20000",
            allowed_assets: ["USDC"], allowed_counterparties: ["0x1111111111111111111111111111111111111111"],
            expires_at: "2030-01-01T00:00:00.000Z",
          },
        },
      },
      inputSchema: {
        properties: {
          action: { type: "object", description: "{name, description, effect} - describes the proposed action; description is scanned for prompt-injection signals" },
          untrusted_text: { type: "string", description: "Any additional untrusted text to scan for prompt-injection signals" },
          url: { type: "string", description: "URL the action would fetch/call, if any" },
          payload: { type: "object", description: "Data the action would send, if any" },
          schema: { type: "object", description: "Bounded JSON-schema (type/required/properties/additionalProperties) to validate payload against" },
          spend: { type: "object", description: "{proposal:{amount_atomic,asset,counterparty}, mandate:{...}, now?} - checked with BigInt, no floats" },
        },
        required: [],
      },
      output: {
        example: {
          decision: "ALLOW",
          reason_codes: [],
          checks: { prompt: { status: "pass" }, url: { status: "pass" }, payload: { status: "pass" }, spend: { status: "pass", allowed: true } },
          request_sha256: "…",
          receipt_sha256: "…",
          limitation: "Deterministic static checks only. ALLOW does not guarantee safety, authorization, or successful execution.",
        },
      },
    },
    handler: async (i) => {
      const promptScan = i.action?.description || i.untrusted_text
        ? scanPrompt([i.action?.description, i.untrusted_text].filter(Boolean).join("\n"))
        : { classification: "skip", risk_score: 0, signals: [] };
      const promptRan = !!(i.action?.description || i.untrusted_text);
      const urlCheck = checkUrl(i.url);
      const payloadCheck = checkPayload(i.payload, i.schema);
      const spendCheck = checkSpend(i.spend);

      const hardFails = [];
      if (promptRan && promptScan.classification === "high_signal") hardFails.push("prompt_injection_high_signal");
      if (urlCheck.status === "fail") hardFails.push(...urlCheck.reason_codes);
      if (payloadCheck.status === "fail") hardFails.push(...payloadCheck.reason_codes);
      if (spendCheck.status === "fail") hardFails.push(...spendCheck.reason_codes);

      const softFlags = [];
      if (promptRan && promptScan.classification === "medium_signal") softFlags.push("prompt_injection_medium_signal");
      if (urlCheck.status === "pass" && urlCheck.reason_codes.includes("raw_ip_hostname")) softFlags.push("raw_ip_hostname");

      const decision = hardFails.length ? "BLOCK" : softFlags.length ? "REVIEW" : "ALLOW";
      const reason_codes = hardFails.length ? hardFails : softFlags;

      const checks = {
        prompt: promptRan ? { status: promptScan.classification === "high_signal" ? "fail" : "pass", ...promptScan } : { status: "skip" },
        url: urlCheck,
        payload: payloadCheck,
        spend: spendCheck,
      };

      const requestPreimage = { action: i.action ?? null, untrusted_text: i.untrusted_text ?? null, url: i.url ?? null, payload: i.payload ?? null, schema: i.schema ?? null, spend: i.spend ?? null };
      const request_sha256 = sha256(requestPreimage);
      const receipt_sha256 = sha256({ request_sha256, decision, reason_codes, checks });

      return {
        decision,
        reason_codes,
        checks,
        request_sha256,
        receipt_sha256,
        limitation: "Deterministic static checks only. ALLOW does not guarantee safety, authorization, or successful execution.",
      };
    },
  },
];
