// outreach-kit — agent outreach routed to an outside x402 seller.
//
// Three tools an agent can pay us for and we fulfil by paying an outside
// seller from our own Base spending wallet, the way the Blockscout kit buys
// upstream: `sms-send`, `email-send` and `voice-call`, all served by
// win.oneshotagent.com (`/v1/tools/sms/send`, `/v1/tools/email/send`,
// `/v1/tools/voice/call`; $0.001 each on Base at the time of writing, read from
// the seller's LIVE 402 on every call, never from this file). Chosen 2026-09-03
// from our own index: the one origin that is router-dispatch-eligible on Base
// for all three channels, with 7,175 settlements from 18 distinct buyers on the
// leaderboard, so it clears our floor on its own evidence.
//
// Why a pinned seller and not the router: the router resolves a TASK to the
// best seller at call time and is the right thing for "do X" queries; these
// tools are a stable contract (this input shape, this channel, this price) an
// agent can put in a skill pack and rely on. The seller is one variable
// (`OUTREACH_ORIGIN`) so a replacement is a config change, and the pay path is
// payX402 with a margin guard, so a seller that reprices above our cap is
// refused before anything is signed.
//
// Abuse: sending messages to third parties on behalf of anyone with $0.01 is
// a spam vector, and the seller sees OUR wallet as the sender of record. So:
// destinations are validated (E.164 numbers, RFC-shaped addresses), bodies are
// length-capped, and every payer gets a daily message budget
// (OUTREACH_MAX_PER_PAYER_DAY, default 25) under a global daily budget
// (OUTREACH_MAX_PER_DAY, default 500); over either is a 429 before any upstream
// spend, and a >= 400 cancels the buyer's settlement. Destinations are hashed in
// logs, never written in clear. WALLET_BLOCKLIST applies at the paywall as it
// does everywhere. The spend itself is bounded by the margin guard
// (`maxAtomic`, under 70% of the tool's price) and by the Base wallet's daily
// spend ceiling (external-spend-guard), booked before the buy and corrected to
// the seller's real quote after it.
import { createHash } from "node:crypto";
import { payX402 } from "../x402-buyer.js";
import { maySpend, noteSpend, adjustSpend } from "../external-spend-guard.js";
import { payerFromRequest } from "../payer.js";

export const OUTREACH_ORIGIN = () => (process.env.OUTREACH_ORIGIN || "https://win.oneshotagent.com").replace(/\/+$/, "");
export const OUTREACH_ROUTES = {
  "sms-send": "/v1/tools/sms/send",
  "email-send": "/v1/tools/email/send",
  "voice-call": "/v1/tools/voice/call",
};
// Margin guard per tool, in atomic USDC (6dp): the most we pay the seller for
// one call. Each sits under 70% of the tool's price.
export const OUTREACH_MAX_ATOMIC = { "sms-send": 5000n, "email-send": 5000n, "voice-call": 14000n };
const TIMEOUT_MS = { "sms-send": 45_000, "email-send": 45_000, "voice-call": 60_000 };
const SMS_MAX_CHARS = 1000;
const EMAIL_SUBJECT_MAX = 200;
const EMAIL_BODY_MAX = 20_000;
const VOICE_TEXT_MAX = 4000;
const VOICE_MAX_MINUTES = 10;

function envInt(name, dflt) {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v >= 0 ? v : dflt;
}
function bad(message, statusCode = 400) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

// ---- validation -----------------------------------------------------------
/** E.164: a leading +, 8 to 15 digits, no premium-rate tricks hidden in spaces. */
export function normalizePhone(v) {
  const s = String(v ?? "").replace(/[\s().-]/g, "");
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}
export function normalizeEmail(v) {
  const s = String(v ?? "").trim();
  if (s.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) return null;
  return s;
}
function text(v, max, name) {
  const s = String(v ?? "").trim();
  if (!s) throw bad(`"${name}" is required`, 400);
  if (s.length > max) throw bad(`"${name}" is over ${max} characters`, 400);
  return s;
}

// ---- per-payer + global daily budgets (in memory; a restart resets the day) --
const budgets = new Map(); // key -> { day, n }
function dayKey(now) { return Math.floor(now / 86_400_000); }
export function budgetCheck(payerKey, { now = Date.now(), perPayer = envInt("OUTREACH_MAX_PER_PAYER_DAY", 25), global = envInt("OUTREACH_MAX_PER_DAY", 500) } = {}) {
  const day = dayKey(now);
  const read = (k) => { const r = budgets.get(k); return r && r.day === day ? r.n : 0; };
  if (read("*") >= global) return { ok: false, reason: "the daily outreach budget for this server is spent; retry tomorrow." };
  if (read(payerKey) >= perPayer) return { ok: false, reason: `this wallet has sent ${perPayer} messages today, the daily limit per payer.` };
  return { ok: true };
}
export function budgetNote(payerKey, now = Date.now()) {
  const day = dayKey(now);
  for (const k of ["*", payerKey]) {
    const r = budgets.get(k);
    budgets.set(k, r && r.day === day ? { day, n: r.n + 1 } : { day, n: 1 });
  }
}
export function __resetBudgets() { budgets.clear(); }

/** Who is sending: the signed EVM payer, else the Tempo payer, else the IP. */
export function payerKeyOf(req) {
  try {
    const p = payerFromRequest(req);
    if (p) return `evm:${String(p).toLowerCase()}`;
  } catch { /* fall through */ }
  if (req?.mppTempoPayer) return `tempo:${req.mppTempoPayer}`;
  return `ip:${req?.ip || "unknown"}`;
}
const hashDest = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 12);

// ---- the seller call, one bounded paid attempt ---------------------------------
async function buyOnce(slug, body, deps) {
  const capAtomic = OUTREACH_MAX_ATOMIC[slug];
  const capUsd = Number(capAtomic) / 1e6;
  const allowed = deps.spend.maySpend(null, capUsd, { chain: "base" });
  if (!allowed.ok) throw bad(`Outreach is briefly paused: ${allowed.reason} Nothing was charged; retry later.`, 503);
  const handle = deps.spend.noteSpend(null, capUsd, { chain: "base" });
  let paid;
  try {
    paid = await deps.payX402(`${OUTREACH_ORIGIN()}${OUTREACH_ROUTES[slug]}`, {
      maxAtomic: capAtomic, method: "POST", body, trusted: true, timeoutMs: TIMEOUT_MS[slug], chain: "base",
    });
  } catch (e) {
    // payX402 speaks in its own statuses; to OUR buyer every one of these is
    // "the seller did not deliver, nothing was charged". Never relay a 402: it
    // would read as our paywall. A 503 for the wallet, 502 for the seller.
    const msg = String(e?.message || e);
    if (/not configured|spending wallet/i.test(msg)) throw bad("Outreach needs the Base spending wallet (X402_UPSTREAM_BUYER_KEY), which is not configured on this server. Nothing was charged.", 503);
    if (/exceeds the .* cap|quote .* exceeds/i.test(msg)) throw bad(`The outreach seller quoted more than this tool's upstream ceiling ($${capUsd}); refusing to pay. Nothing was charged.`, 503);
    throw bad(`The outreach seller did not deliver (${msg.slice(0, 160)}). Nothing was charged.`, 502);
  }
  if (paid?.quote && Number.isFinite(paid.quote.usd)) deps.spend.adjustSpend(handle, paid.quote.usd);
  return paid;
}

/**
 * Build the three handlers. `deps.payX402` and `deps.spend` are injectable so
 * the whole decision path runs offline (scripts/test-outreach-kit.js).
 */
export function makeOutreachHandlers(deps = {}) {
  const d = { payX402: deps.payX402 || payX402, spend: deps.spend || { maySpend, noteSpend, adjustSpend }, now: deps.now || Date.now, log: deps.log || console.log };
  const gate = (req, slug, dest) => {
    const key = payerKeyOf(req);
    const b = budgetCheck(key, { now: d.now() });
    if (!b.ok) throw bad(`Refused: ${b.reason} Nothing was charged.`, 429);
    return () => { budgetNote(key, d.now()); d.log(`[outreach] ${slug} payer=${key.slice(0, 16)}… dest=${hashDest(dest)} seller=${new URL(OUTREACH_ORIGIN()).host}`); };
  };
  const envelope = (slug, paid, channel, extra) => ({
    sent: true,
    channel,
    seller: new URL(OUTREACH_ORIGIN()).host,
    sellerRoute: OUTREACH_ROUTES[slug],
    upstream: paid?.quote ? { usd: paid.quote.usd, network: paid.quote.network, tx: paid.receipt?.transaction || null } : { usd: 0, network: null, tx: null },
    ...extra,
    result: paid?.result ?? null,
  });

  return {
    "sms-send": async (input, req) => {
      const to = normalizePhone(input?.to);
      if (!to) throw bad('"to" must be an E.164 phone number, e.g. +14155552671', 400);
      const message = text(input?.message, SMS_MAX_CHARS, "message");
      const done = gate(req, "sms-send", to);
      const paid = await buyOnce("sms-send", { to_number: to, message }, d);
      done();
      return envelope("sms-send", paid, "sms", { to, chars: message.length });
    },
    "email-send": async (input, req) => {
      const to = normalizeEmail(input?.to);
      if (!to) throw bad('"to" must be an email address', 400);
      const subject = text(input?.subject, EMAIL_SUBJECT_MAX, "subject");
      const body = text(input?.body, EMAIL_BODY_MAX, "body");
      const fromName = input?.fromName != null ? text(input.fromName, 80, "fromName") : undefined;
      const replyTo = input?.replyToEmailId != null ? text(input.replyToEmailId, 120, "replyToEmailId") : undefined;
      const done = gate(req, "email-send", to);
      const sellerBody = { to_address: to, subject, body, ...(fromName ? { from_name: fromName } : {}), ...(replyTo ? { reply_to_email_id: replyTo } : {}) };
      const paid = await buyOnce("email-send", sellerBody, d);
      done();
      return envelope("email-send", paid, "email", { to, subject });
    },
    "voice-call": async (input, req) => {
      const to = normalizePhone(input?.to);
      if (!to) throw bad('"to" must be an E.164 phone number, e.g. +14155552671', 400);
      const objective = text(input?.objective, VOICE_TEXT_MAX, "objective");
      const persona = input?.persona != null ? text(input.persona, 400, "persona") : undefined;
      const context = input?.context != null ? text(input.context, VOICE_TEXT_MAX, "context") : undefined;
      let maxMinutes = input?.maxMinutes == null ? undefined : Number(input.maxMinutes);
      if (maxMinutes !== undefined && !(Number.isInteger(maxMinutes) && maxMinutes >= 1 && maxMinutes <= VOICE_MAX_MINUTES)) throw bad(`"maxMinutes" must be an integer from 1 to ${VOICE_MAX_MINUTES}`, 400);
      const done = gate(req, "voice-call", to);
      const sellerBody = { target_number: to, objective, ...(persona ? { caller_persona: persona } : {}), ...(context ? { context } : {}), ...(maxMinutes ? { max_duration_minutes: maxMinutes } : {}) };
      const paid = await buyOnce("voice-call", sellerBody, d);
      done();
      return envelope("voice-call", paid, "voice", { to, objective });
    },
  };
}

const handlers = makeOutreachHandlers();
const SELLER_NOTE = "Fulfilled by an outside x402 seller (win.oneshotagent.com) paid from this server's wallet; its own response is relayed under `result` as-is. Every payer has a daily message budget; over it is a 429, nothing charged.";

export const OUTREACH_TOOLS = [
  {
    route: "POST /api/sms-send",
    name: "Send an SMS",
    slug: "sms-send",
    category: "agent",
    price: "$0.010",
    description: `Send one SMS text message to an E.164 phone number (up to ${SMS_MAX_CHARS} characters). ${SELLER_NOTE}`,
    tags: ["sms", "text-message", "outreach", "notify", "phone", "routed"],
    discovery: {
      bodyType: "json",
      input: { to: "+15005550006", message: "Your report is ready: https://agent402.tools/r/example" },
      inputSchema: {
        properties: {
          to: { type: "string", description: "Destination phone number in E.164 form, e.g. +14155552671" },
          message: { type: "string", description: `Message text, up to ${SMS_MAX_CHARS} characters` },
        },
        required: ["to", "message"],
      },
      output: { example: { sent: true, channel: "sms", seller: "win.oneshotagent.com", sellerRoute: "/v1/tools/sms/send", upstream: { usd: 0.001, network: "eip155:8453", tx: "0x9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b" }, to: "+15005550006", chars: 58, result: {} } },
    },
    handler: handlers["sms-send"],
  },
  {
    route: "POST /api/email-send",
    name: "Send an email",
    slug: "email-send",
    category: "agent",
    price: "$0.010",
    description: `Send one email (subject up to ${EMAIL_SUBJECT_MAX} characters, body up to ${EMAIL_BODY_MAX}) from the seller's provisioned sending domain, with an optional display name. ${SELLER_NOTE}`,
    tags: ["email", "send", "outreach", "notify", "routed"],
    discovery: {
      bodyType: "json",
      input: { to: "agent@example.com", subject: "Your report is ready", body: "The market brief you asked for is at https://agent402.tools/r/example" },
      inputSchema: {
        properties: {
          to: { type: "string", description: "Destination email address" },
          subject: { type: "string", description: `Subject line, up to ${EMAIL_SUBJECT_MAX} characters` },
          body: { type: "string", description: `Plain-text body, up to ${EMAIL_BODY_MAX} characters` },
          fromName: { type: "string", description: "Optional display name for the sender (the address is the seller's)" },
          replyToEmailId: { type: "string", description: "Optional: the seller's id of an inbound email this replies to" },
        },
        required: ["to", "subject", "body"],
      },
      output: { example: { sent: true, channel: "email", seller: "win.oneshotagent.com", sellerRoute: "/v1/tools/email/send", upstream: { usd: 0.001, network: "eip155:8453", tx: "0x9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b" }, to: "agent@example.com", subject: "Your report is ready", result: {} } },
    },
    handler: handlers["email-send"],
  },
  {
    route: "POST /api/voice-call",
    name: "Make an AI voice call",
    slug: "voice-call",
    category: "agent",
    price: "$0.020",
    description: `Place an AI voice call to an E.164 phone number with an objective for the call, an optional caller persona and context, and a duration cap of up to ${VOICE_MAX_MINUTES} minutes. ${SELLER_NOTE}`,
    tags: ["voice", "phone-call", "outreach", "telephony", "routed"],
    discovery: {
      bodyType: "json",
      input: { to: "+15005550006", objective: "Confirm the delivery window for order 4821 and note any change.", persona: "A polite assistant calling on behalf of Agent402", maxMinutes: 3 },
      inputSchema: {
        properties: {
          to: { type: "string", description: "Destination phone number in E.164 form" },
          objective: { type: "string", description: `What the call should achieve, up to ${VOICE_TEXT_MAX} characters` },
          persona: { type: "string", description: "Optional: who the caller presents as" },
          context: { type: "string", description: "Optional background the caller may use" },
          maxMinutes: { type: "integer", description: `Optional duration cap, 1 to ${VOICE_MAX_MINUTES}` },
        },
        required: ["to", "objective"],
      },
      output: { example: { sent: true, channel: "voice", seller: "win.oneshotagent.com", sellerRoute: "/v1/tools/voice/call", upstream: { usd: 0.001, network: "eip155:8453", tx: "0x9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b" }, to: "+15005550006", objective: "Confirm the delivery window for order 4821 and note any change.", result: {} } },
    },
    handler: handlers["voice-call"],
  },
];
