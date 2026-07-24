// MPP (Machine Payments Protocol) dual-stack shim — serve MPP clients from the
// same routes as x402 clients, with @x402/express keeping SOLE settlement
// authority. MPP (tempoxyz/mpp, IETF-track "Payment" HTTP auth scheme,
// paymentauth.org) uses the same 402 lifecycle as x402 with standard headers:
//
//   challenge   WWW-Authenticate: Payment …     (x402: PAYMENT-REQUIRED)
//   credential  Authorization: Payment <b64url> (x402: PAYMENT-SIGNATURE)
//   receipt     Payment-Receipt: <b64url>       (x402: PAYMENT-RESPONSE)
//
// MPP's `evm` method is the same primitive as x402 exact (EIP-3009
// transferWithAuthorization), so this shim is a pure header translation layer:
//
//   OUTBOUND  every paywall 402 that carries PAYMENT-REQUIRED also gains a
//             WWW-Authenticate: Payment challenge per EVM `accepts` entry,
//             HMAC-bound via MPP_SECRET_KEY (spec challenge-id binding). The
//             exact advertised accepts entry rides along in challenge meta
//             (client MUST echo opaque unchanged), so the inbound direction is
//             stateless and byte-exact.
//   INBOUND   Authorization: Payment credentials whose challenge HMAC-verifies
//             are re-encoded as a PAYMENT-SIGNATURE header and fall through to
//             @x402/express untouched — verify + settle happen exactly once,
//             and every paywall invariant (replay guard, payer attribution,
//             settlement ordering, idempotency) keys off the same header it
//             always has. Invalid/expired MPP credentials are simply ignored:
//             the paywall answers with a fresh 402 carrying new challenges.
//   RECEIPT   on a settled 200 for an MPP-credential request, the paywall's
//             PAYMENT-RESPONSE is mirrored as an MPP Payment-Receipt.
//
// EVM stablecoin rails only (eip155:*) — SVM/Stellar/Algorand accepts entries
// are never offered as MPP challenges (their payloads aren't EIP-3009).
// Enabled only when MPP_SECRET_KEY is set (env-gated no-op, like other
// optional rails). mppx is the reference MPP implementation; we use only its
// codec primitives here — its request-guard/settlement path is deliberately
// NOT mounted (double-settle risk vs @x402/express).
import { Challenge, Credential, PaymentRequest, Receipt, x402, evm } from "mppx";

/** Replay of the paywall's own header names (see @x402/core http). */
const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
const PAYMENT_SIGNATURE_HEADER = "payment-signature"; // req.headers keys are lowercase
const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

/** Challenge meta key carrying the verbatim advertised x402 accepts entry. */
const META_ACCEPTS_KEY = "x402";

/** All our EVM rails settle 6-decimal stablecoins (Circle USDC + Paxos USDG). */
const STABLECOIN_DECIMALS = 6;

// Which EVM chains get an MPP challenge on each 402. A stock mppx client can
// only natively sign assets in its built-in registry (Base + Celo mainnets),
// and every extra challenge adds ~800 bytes to EVERY 402 (a high-volume,
// crawler-swept response) — so the default covers exactly what stock clients
// can pay. MPP_CHALLENGE_NETWORKS overrides: "all" (every eip155 accepts
// entry) or a CSV of chain ids. Call-time read, like other rollout knobs.
const DEFAULT_CHALLENGE_CHAIN_IDS = new Set([8453, 42220]);

/** @param {number} chainId */
function challengeEnabledForChain(chainId) {
  const raw = (process.env.MPP_CHALLENGE_NETWORKS || "").trim();
  if (!raw) return DEFAULT_CHALLENGE_CHAIN_IDS.has(chainId);
  if (raw.toLowerCase() === "all") return true;
  return raw.split(",").some((s) => Number(s.trim()) === chainId);
}

/**
 * Builds the Express middleware. Returns null when no secret is configured —
 * caller mounts nothing and the server stays pure-x402.
 *
 * @param {object} opts
 * @param {string} opts.secretKey - HMAC secret binding challenge ids (MPP_SECRET_KEY).
 * @param {string} opts.realm - Protection-space identifier (our hostname).
 * @returns {import("express").RequestHandler|null}
 */
export function createMppShim({ secretKey, realm }) {
  if (!secretKey) return null;

  return function mppShim(req, res, next) {
    // ---- INBOUND: Authorization: Payment → PAYMENT-SIGNATURE ----
    // Never touch a request that already speaks x402 (incl. mppx clients using
    // their bare-x402 protocol path) — pass-through is the no-regression rule.
    const auth = req.headers.authorization;
    if (
      typeof auth === "string" &&
      /^payment\s/i.test(auth) &&
      !req.headers[PAYMENT_SIGNATURE_HEADER] &&
      !req.headers["x-payment"]
    ) {
      const paymentSignature = translateCredential(auth, { secretKey });
      if (paymentSignature) {
        req.headers[PAYMENT_SIGNATURE_HEADER] = paymentSignature;
        // The scheme is consumed; leaving it would only invite double-reads.
        delete req.headers.authorization;
        req.mppCredential = true;
      }
      // Invalid credential: fall through untranslated — the paywall re-issues
      // a 402 whose outbound hook below mints fresh MPP challenges.
    }

    // ---- OUTBOUND: append WWW-Authenticate on 402s, Payment-Receipt on 200s ----
    const origWriteHead = res.writeHead;
    res.writeHead = function mppWriteHead(...args) {
      try {
        if (res.statusCode === 402 && !res.getHeader("WWW-Authenticate")) {
          const pr = res.getHeader(PAYMENT_REQUIRED_HEADER);
          if (pr) {
            const header = challengeHeaderFromPaymentRequired(String(pr), { secretKey, realm });
            if (header) res.setHeader("WWW-Authenticate", header);
          }
        } else if (res.statusCode === 200 && req.mppCredential) {
          const settle = res.getHeader(PAYMENT_RESPONSE_HEADER);
          if (settle) {
            const receipt = receiptFromPaymentResponse(String(settle));
            if (receipt) res.setHeader("Payment-Receipt", receipt);
          }
        }
      } catch {
        // Translation is strictly additive — never let it break the response.
      }
      return origWriteHead.apply(this, args);
    };

    next();
  };
}

/**
 * OUTBOUND half: decode our own PAYMENT-REQUIRED header and mint one
 * HMAC-bound MPP challenge per EVM accepts entry.
 *
 * @param {string} paymentRequiredHeader - Encoded PAYMENT-REQUIRED value.
 * @param {{secretKey: string, realm: string}} opts
 * @returns {string|null} WWW-Authenticate header value, or null when no entry qualifies.
 */
export function challengeHeaderFromPaymentRequired(paymentRequiredHeader, { secretKey, realm }) {
  // Envelope decode, not the strict schema: our accepts list also carries
  // non-EVM rails (solana:/stellar:/algorand:) that mppx's eip155-typed
  // PaymentRequirementsSchema rejects — filter per entry like mppx's own
  // client protocol does.
  const paymentRequired = x402.Header.decodePaymentRequiredEnvelope(paymentRequiredHeader);
  const challenges = [];
  for (const rawAccepts of paymentRequired.accepts) {
    const parsed = x402.PaymentRequirementsSchema.safeParse(rawAccepts);
    if (!parsed.success) continue;
    const accepts = parsed.data;
    if (accepts.scheme !== "exact") continue;
    if (typeof accepts.network !== "string" || !accepts.network.startsWith("eip155:")) continue;
    const chainId = Number(accepts.network.slice("eip155:".length));
    if (!Number.isInteger(chainId)) continue;
    if (!challengeEnabledForChain(chainId)) continue;
    challenges.push(
      Challenge.from({
        realm,
        method: "evm",
        intent: "charge",
        // Native MPP clients sign validBefore = expires; keep it inside the
        // advertised x402 window so facilitator timeout semantics match.
        expires: new Date(Date.now() + accepts.maxTimeoutSeconds * 1000),
        request: {
          amount: accepts.amount,
          currency: accepts.asset,
          recipient: accepts.payTo,
          methodDetails: {
            chainId,
            credentialTypes: ["authorization"],
            decimals: STABLECOIN_DECIMALS,
          },
        },
        // The verbatim accepts entry (RAW, not schema-parsed — parsing strips
        // unknown fields and the paywall's requirement matching deep-equals the
        // full advertised object), HMAC-bound via the challenge id (meta folds
        // into `opaque`, slot 6 of the id binding) and echoed back by the
        // client — inbound rebuilds `accepted` byte-exact and stateless.
        meta: { [META_ACCEPTS_KEY]: JSON.stringify(rawAccepts) },
        secretKey,
      })
    );
  }
  if (challenges.length === 0) return null;
  return challenges.map((c) => Challenge.serialize(c)).join(", ");
}

/**
 * INBOUND half: MPP credential → encoded x402 PAYMENT-SIGNATURE value.
 * Returns null for anything that isn't a valid, unexpired, HMAC-bound
 * evm/charge credential of ours — callers fall through to the plain paywall.
 *
 * @param {string} authorizationHeader - Full `Payment <b64url>` header value.
 * @param {{secretKey: string}} opts
 * @returns {string|null}
 */
export function translateCredential(authorizationHeader, { secretKey }) {
  let credential;
  try {
    credential = Credential.deserialize(authorizationHeader);
  } catch {
    return null;
  }
  const challenge = credential.challenge;
  if (challenge.method !== "evm" || challenge.intent !== "charge") return null;
  // HMAC binding (spec: servers MUST bind ids to challenge params). This also
  // proves the echoed accepts entry in meta is ours and untampered.
  if (!Challenge.verify(challenge, { secretKey })) return null;
  if (challenge.expires && Date.parse(challenge.expires) < Date.now()) return null;
  // Deserialized challenges keep the wire-shaped `opaque` (base64url JCS)
  // rather than a decoded `meta` — accept either.
  let meta = challenge.meta;
  if (!meta && challenge.opaque) {
    try {
      meta = PaymentRequest.deserialize(challenge.opaque);
    } catch {
      return null;
    }
  }
  const acceptedJson = meta?.[META_ACCEPTS_KEY];
  if (!acceptedJson) return null;
  let accepted;
  try {
    accepted = JSON.parse(acceptedJson);
  } catch {
    return null;
  }
  const payload = evm.AuthorizationPayloadSchema.safeParse(credential.payload);
  if (!payload.success) return null;
  const { from, to, value, validAfter, validBefore, nonce, signature } = payload.data;
  return x402.Header.encodePaymentSignature({
    x402Version: 2,
    accepted,
    payload: {
      authorization: { from, to, value, validAfter, validBefore, nonce },
      signature,
    },
  });
}

/**
 * RECEIPT half: settled PAYMENT-RESPONSE → MPP Payment-Receipt value.
 *
 * @param {string} paymentResponseHeader - Encoded PAYMENT-RESPONSE value.
 * @returns {string|null}
 */
export function receiptFromPaymentResponse(paymentResponseHeader) {
  const settle = x402.Header.decodePaymentResponse(paymentResponseHeader);
  if (!settle.success) return null;
  return Receipt.serialize({
    method: "evm",
    status: "success",
    reference: settle.transaction,
    timestamp: new Date().toISOString(),
  });
}
