// MPP (Machine Payments Protocol) for the tollbooth - dependency-free codec.
//
// MPP is the IETF-track "Payment" HTTP authentication scheme (tempoxyz/mpp,
// paymentauth.org): the same 402 lifecycle as x402 with standard headers:
//
//   challenge   WWW-Authenticate: Payment id="...", realm="...", method="evm",
//               intent="charge", request="<b64url JSON>", expires="...", opaque="..."
//   credential  Authorization: Payment <b64url JSON{challenge, payload, source?}>
//   receipt     Payment-Receipt: <b64url JSON{method, status, reference, timestamp}>
//
// MPP's `evm` charge method is the same primitive as x402 `exact` on EVM
// (an EIP-3009 transferWithAuthorization signed by the buyer), so a tollbooth
// that already settles x402 through the operator's @x402/express middleware can
// accept MPP clients as pure header translation - settlement authority stays
// with the x402 stack, exactly once per purchase:
//
//   OUTBOUND  the middleware's own PAYMENT-REQUIRED header (its advertised
//             `accepts`) is turned into one HMAC-bound MPP challenge per
//             eligible EVM entry; the verbatim accepts entry rides in the
//             challenge's opaque slot so inbound is stateless and byte-exact.
//   INBOUND   an Authorization: Payment credential whose challenge id
//             HMAC-verifies is re-encoded as a PAYMENT-SIGNATURE header and
//             handed to the SAME middleware, which verifies + settles it as if
//             an x402 client had sent it.
//   RECEIPT   the settled PAYMENT-RESPONSE is mirrored as an MPP Payment-Receipt.
//
// No mppx dependency: it pulls in ox/zod and a viem peer, too heavy for a
// drop-in middleware, and the wire is small. Byte-compatibility with the
// reference client is proven by scripts/test-tollbooth-mpp.js in the parent
// repo, which drives a REAL mppx client through this codec.
import { createHmac, timingSafeEqual } from "node:crypto";

const SCHEME = "Payment";
const META_ACCEPTS_KEY = "x402";
const STABLECOIN_DECIMALS = 6; // Circle USDC + Paxos USDG on every EVM rail
// What a stock mppx client can auto-sign (its built-in asset registry covers
// Base + Celo mainnets); every extra challenge costs ~800 bytes on every 402.
export const DEFAULT_MPP_CHAIN_IDS = [8453, 42220];

// ---- encoding primitives ---------------------------------------------------
export const b64url = (s) => Buffer.from(s, "utf8").toString("base64url");
export const unb64url = (s) => Buffer.from(String(s), "base64url").toString("utf8");
const b64std = (s) => Buffer.from(s, "utf8").toString("base64");
const unb64std = (s) => Buffer.from(String(s), "base64").toString("utf8");

/** RFC 8785-style canonical JSON (sorted object keys, no whitespace) - what the
 *  reference implementation uses for the `request`/`opaque` slots. */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}
const encodeRequest = (obj) => b64url(canonicalJson(obj));

// Positional HMAC binding of the challenge id - the same slot layout the
// reference implementation uses, so its Challenge.verify() agrees with ours
// given the same secret (handy in tests; the spec only requires that WE bind).
function challengeId(secretKey, c) {
  const input = [c.realm, c.method, c.intent, c.request, c.expires ?? "", c.digest ?? "", c.opaque ?? ""].join("|");
  return createHmac("sha256", Buffer.from(secretKey, "utf8")).update(input, "utf8").digest("base64url");
}
function idMatches(secretKey, c) {
  const a = Buffer.from(String(c.id || ""), "utf8");
  const b = Buffer.from(challengeId(secretKey, c), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
const authParam = (name, value) => {
  const v = String(value);
  if (/[\r\n]/.test(v)) throw new Error("invalid auth-param value");
  return `${name}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
};

// ---- OUTBOUND: PAYMENT-REQUIRED -> WWW-Authenticate: Payment ---------------
/**
 * Decode an x402 v2 PAYMENT-REQUIRED header (base64 JSON envelope) and mint one
 * HMAC-bound MPP evm/charge challenge per eligible EVM `accepts` entry.
 * @returns {string|null} WWW-Authenticate value, or null when nothing qualifies.
 */
export function challengesFromPaymentRequired(paymentRequiredHeader, { secretKey, realm, chainIds = DEFAULT_MPP_CHAIN_IDS } = {}) {
  if (!secretKey || !paymentRequiredHeader) return null;
  let envelope;
  try { envelope = JSON.parse(unb64std(paymentRequiredHeader)); } catch { return null; }
  const accepts = Array.isArray(envelope?.accepts) ? envelope.accepts : [];
  const allowAll = chainIds === "all";
  const allowed = new Set(allowAll ? [] : (chainIds || []).map(Number));
  const out = [];
  for (const a of accepts) {
    if (!a || a.scheme !== "exact" || typeof a.network !== "string" || !a.network.startsWith("eip155:")) continue;
    const chainId = Number(a.network.slice("eip155:".length));
    if (!Number.isInteger(chainId)) continue;
    if (!allowAll && !allowed.has(chainId)) continue;
    if (typeof a.amount !== "string" || typeof a.asset !== "string" || typeof a.payTo !== "string") continue;
    const timeout = Number(a.maxTimeoutSeconds) > 0 ? Number(a.maxTimeoutSeconds) : 300;
    const c = {
      realm,
      method: "evm",
      intent: "charge",
      request: encodeRequest({
        amount: a.amount,
        currency: a.asset,
        recipient: a.payTo,
        methodDetails: { chainId, credentialTypes: ["authorization"], decimals: STABLECOIN_DECIMALS },
      }),
      // Native MPP clients sign validBefore = expires; keep it inside the
      // advertised x402 window so facilitator timeout semantics match.
      expires: new Date(Date.now() + timeout * 1000).toISOString(),
      // The verbatim accepts entry (RAW, not normalised - the middleware's
      // requirement matching deep-equals the full advertised object).
      opaque: encodeRequest({ [META_ACCEPTS_KEY]: JSON.stringify(a) }),
    };
    c.id = challengeId(secretKey, c);
    out.push([
      authParam("id", c.id), authParam("realm", c.realm), authParam("method", c.method), authParam("intent", c.intent),
      authParam("request", c.request), authParam("expires", c.expires), authParam("opaque", c.opaque),
    ].join(", "));
  }
  if (!out.length) return null;
  return out.map((p) => `${SCHEME} ${p}`).join(", ");
}

// ---- INBOUND: Authorization: Payment -> PAYMENT-SIGNATURE ------------------
const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;
const HEX_32 = /^0x[0-9a-fA-F]{64}$/;
const HEX_SIG = /^0x[0-9a-fA-F]+$/;
const UINT = /^\d+$/;

/**
 * Validate an MPP credential against our HMAC binding and re-encode it as an
 * x402 v2 PAYMENT-SIGNATURE value. Returns null for anything that is not a
 * valid, unexpired, HMAC-bound evm/charge credential of ours.
 */
export function translateCredential(authorizationHeader, { secretKey } = {}) {
  if (!secretKey || typeof authorizationHeader !== "string") return null;
  const m = authorizationHeader.match(/^Payment\s+([A-Za-z0-9_-]+=*)\s*$/i);
  if (!m) return null;
  let wire;
  try { wire = JSON.parse(unb64url(m[1])); } catch { return null; }
  const ch = wire?.challenge;
  if (!ch || typeof ch !== "object") return null;
  if (ch.method !== "evm" || ch.intent !== "charge") return null;
  if (typeof ch.request !== "string" || typeof ch.opaque !== "string") return null;
  // HMAC binding (spec: servers MUST bind ids to challenge params). This also
  // proves the echoed accepts entry in opaque is ours and untampered.
  if (!idMatches(secretKey, ch)) return null;
  if (ch.expires && !(Date.parse(ch.expires) > Date.now())) return null;
  let accepted;
  try {
    const meta = JSON.parse(unb64url(ch.opaque));
    accepted = JSON.parse(meta[META_ACCEPTS_KEY]);
  } catch { return null; }
  if (!accepted || typeof accepted !== "object") return null;
  const p = wire.payload;
  if (!p || p.type !== "authorization") return null;
  const { from, to, value, validAfter, validBefore, nonce, signature } = p;
  if (!HEX_ADDR.test(String(from)) || !HEX_ADDR.test(String(to)) || !HEX_32.test(String(nonce)) || !HEX_SIG.test(String(signature))) return null;
  if (!UINT.test(String(value)) || !UINT.test(String(validAfter)) || !UINT.test(String(validBefore))) return null;
  return b64std(JSON.stringify({
    x402Version: 2,
    accepted,
    payload: { authorization: { from, to, value: String(value), validAfter: String(validAfter), validBefore: String(validBefore), nonce }, signature },
  }));
}

// ---- RECEIPT: PAYMENT-RESPONSE -> Payment-Receipt -------------------------
export function receiptFromPaymentResponse(paymentResponseHeader) {
  let settle;
  try { settle = JSON.parse(unb64std(paymentResponseHeader)); } catch { return null; }
  if (!settle || settle.success !== true || typeof settle.transaction !== "string") return null;
  return b64url(JSON.stringify({ method: "evm", status: "success", reference: settle.transaction, timestamp: new Date().toISOString() }));
}

/** True when the header looks like an MPP credential (scheme check only). */
export function isMppCredential(authorizationHeader) {
  return typeof authorizationHeader === "string" && /^Payment\s+\S/i.test(authorizationHeader);
}
