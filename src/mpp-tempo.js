// Tempo support for MPP — a SECOND, independent settlement path alongside
// mpp-shim.js's "evm" translation. Tempo (tempoxyz, Stripe+Paradigm-backed,
// EVM chain id 4217, live mainnet since 2026-03) is MPP's own native payment
// method, built on TIP-1034/TIP-20 primitives that are NOT EIP-3009 — so it
// cannot be translated into our existing x402 PAYMENT-SIGNATURE header the
// way "evm" (Base/Celo) is. No x402 facilitator anywhere supports Tempo
// (checked against docs.x402.org's own network-support page, 2026-08-17), so
// "add a RAILS chain + a facilitator client" — the pattern used for every
// other rail — is not available here.
//
// Instead this rides Tempo's own hosted MPP relay (api.tempo.xyz's
// /v1/mpp/validate + /v1/mpp/broadcast, exposed by mppx's `tempo.charge({
// relay })`), which splits cleanly into a non-mutating `validate` and a
// separate terminal `broadcast` — the same "check first, commit only after
// the handler succeeds" shape as @x402/express's own settlement-ordering
// invariant (see the "x402 settlement ordering" note in CLAUDE.md). We never
// hold a Tempo signing key: the relay broadcasts on our behalf, we only
// supply a receiving address.
//
// Scope: the one-shot `tempo.charge()` method only. Tempo also has a
// stateful session/channel protocol (TIP-1034, for pay-per-token streaming)
// — deliberately out of scope here; see the approved plan.
import { Challenge, Credential, Method, Receipt } from "mppx";
import { tempo } from "mppx/server";

const DEFAULT_DECIMALS = 6; // matches every other stablecoin rail this repo settles

function envRecipient() {
  return process.env.TEMPO_RECIPIENT_ADDRESS || process.env.WALLET_ADDRESS || "";
}
function envCurrency() {
  return process.env.TEMPO_CURRENCY || "";
}
function envDecimals() {
  const n = Number(process.env.TEMPO_DECIMALS);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_DECIMALS;
}

/** Rollout switch — mirrors MPP_SECRET_KEY's own env-gated-no-op posture.
 *  Call-time read, never cached, like every other rollout knob in this repo. */
export function tempoEnabled() {
  return !!(process.env.TEMPO_API_KEY && envRecipient() && envCurrency());
}

// The configured Method.Server is cheap to hold but not free to rebuild per
// request; memoize it, keyed on the config values that actually shape it so
// an env change (redeploy-time only, never mid-process) rebuilds cleanly.
let cachedMethod = null;
let cachedKey = "";

function tempoMethod() {
  const key = `${process.env.TEMPO_API_KEY || ""}|${envRecipient()}|${envCurrency()}|${envDecimals()}|${process.env.TEMPO_API_BASE_URL || ""}`;
  if (cachedMethod && cachedKey === key) return cachedMethod;
  cachedMethod = tempo.charge({
    currency: envCurrency(),
    decimals: envDecimals(),
    recipient: envRecipient(),
    relay: {
      apiKey: process.env.TEMPO_API_KEY,
      ...(process.env.TEMPO_API_BASE_URL ? { apiBaseUrl: process.env.TEMPO_API_BASE_URL } : {}),
    },
  });
  cachedKey = key;
  return cachedMethod;
}

/** Mint an HMAC-bound `method: "tempo"` MPP challenge for a route's USD
 *  price. Returns null when the feature is disabled or a route has no
 *  parseable price — callers must never advertise a challenge nobody can
 *  actually settle. `secretKey` is the same MPP_SECRET_KEY the "evm" side
 *  already uses (one HMAC secret, not a second one to provision). */
export function mintTempoChallenge({ priceUsd, description, realm, secretKey, timeoutSeconds = 300 }) {
  if (!tempoEnabled()) return null;
  const amount = Number(priceUsd);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const challenge = Challenge.from({
    realm,
    method: "tempo",
    intent: "charge",
    expires: new Date(Date.now() + timeoutSeconds * 1000),
    request: {
      amount: amount.toFixed(envDecimals()),
      currency: envCurrency(),
      decimals: envDecimals(),
      recipient: envRecipient(),
      ...(description ? { description: String(description).slice(0, 200) } : {}),
    },
    secretKey,
  });
  return Challenge.serialize(challenge);
}

/** True when `authorizationHeader` deserializes to a WELL-FORMED credential
 *  bound to a `method: "tempo"` challenge — used to decide whether a request
 *  belongs on the Tempo path at all before doing anything mutating. Never
 *  throws; an unparseable header is simply "not ours". */
export function isTempoCredential(authorizationHeader) {
  if (typeof authorizationHeader !== "string" || !/^payment\s/i.test(authorizationHeader)) return false;
  try {
    const credential = Credential.deserialize(authorizationHeader);
    return credential?.challenge?.method === "tempo";
  } catch {
    return false;
  }
}

/** Non-mutating check (HMAC binding, expiry, credential shape, relay
 *  pre-validation). Never broadcasts, never moves money. */
export async function validateTempoCredential(authorizationHeader) {
  try {
    const validation = await Method.validateCredential([tempoMethod()], authorizationHeader);
    return { ok: true, validation };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 300) };
  }
}

/** Terminal — actually settles via Tempo's relay. Callers MUST only invoke
 *  this after a successful (<400) handler response; see the server wiring
 *  in server.js for the buffer-then-decide discipline this depends on. */
export async function broadcastTempoCredential(authorizationHeader) {
  try {
    const receipt = await Method.broadcastCredential([tempoMethod()], authorizationHeader);
    return { ok: true, receipt };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 300) };
  }
}

/** mppx's broadcastCredential already returns a properly-shaped
 *  Receipt.Receipt ({method:"tempo", status:"success", reference, timestamp})
 *  — this just serializes it for the Payment-Receipt header, same as
 *  mpp-shim.js's receiptFromPaymentResponse does for the evm side. */
export function tempoReceiptHeader(receipt) {
  try {
    return Receipt.serialize(receipt);
  } catch {
    return null;
  }
}

/** Reverse of the above — decodes OUR OWN Payment-Receipt response header
 *  back to its tx reference, for the sales-ledger tally in server.js (the
 *  same role txFromPaymentResponse plays for the x402 settle receipt). */
export function tempoTxFromReceiptHeader(header) {
  try {
    return Receipt.deserialize(String(header)).reference || null;
  } catch {
    return null;
  }
}

// Test-only hook: force the memoized method to rebuild on the next call.
export function __testResetMethodCache() {
  cachedMethod = null;
  cachedKey = "";
}

// ---------------------------------------------------------------------------
// Express wiring — two SEPARATE middlewares, both no-ops unless tempoEnabled().
// Deliberately not folded into mpp-shim.js: that file is a pure evm↔x402
// translator, and Tempo settles through a wholly different path (Tempo's own
// relay, never @x402/express). See server.js for exact mount order.
// ---------------------------------------------------------------------------

/** OUTBOUND: append a `method: "tempo"` challenge to a 402's WWW-Authenticate
 *  header, alongside whatever mpp-shim.js already put there for "evm". Reads
 *  the route's price via `priceFor` (server.js supplies a CATALOG lookup) —
 *  never invents a price, and mints nothing for a route it can't price.
 *  Returns null (mount nothing) when tempoEnabled() is false. */
export function createTempoChallengeAppender({ realm, secretKey, priceFor }) {
  if (!tempoEnabled()) return null;
  return function tempoChallengeAppender(req, res, next) {
    const origWriteHead = res.writeHead;
    res.writeHead = function tempoWriteHead(...args) {
      try {
        if (res.statusCode === 402) {
          const item = priceFor(req.method, req.path);
          if (item) {
            const header = mintTempoChallenge({
              priceUsd: item.priceUsd,
              description: item.description,
              realm,
              secretKey,
            });
            if (header) {
              const existing = res.getHeader("WWW-Authenticate");
              res.setHeader("WWW-Authenticate", existing ? `${existing}, ${header}` : header);
            }
          }
        }
      } catch {
        // Additive only — never let challenge-minting break the response.
      }
      return origWriteHead.apply(this, args);
    };
    next();
  };
}

/** INBOUND: the settlement gate itself. Buffers the real route handler's
 *  response (mirrors @x402/express's own writeHead/write/end/flushHeaders
 *  buffering, node_modules/@x402/express/dist/esm/index.mjs) so broadcast —
 *  the terminal, money-moving call — only ever happens AFTER a successful
 *  (<400) handler response. A non-tempo request is untouched: this is a
 *  no-op unless the Authorization header is a well-formed tempo credential.
 *  `validate`/`broadcast` are injectable (default to the real relay-backed
 *  functions above) so the ordering invariant — handler runs before
 *  broadcast, broadcast only on a successful handler — can be proven in a
 *  fast, deterministic offline test without needing Tempo's real relay wire
 *  format, same pattern mpp-index.js uses for its own injectable `verify`. */
export function createTempoGate({ validate = validateTempoCredential, broadcast = broadcastTempoCredential } = {}) {
  if (!tempoEnabled()) return null;
  return function tempoGate(req, res, next) {
    const auth = req.headers.authorization;
    if (!isTempoCredential(auth)) return next();

    validate(auth).then(async (v) => {
      if (!v.ok) return next(); // invalid credential — fall through to a fresh 402, same as an invalid evm credential today

      // From here on, money can move — buffer the handler's response and
      // decide after it completes. Bypass every x402-specific gate
      // downstream (PoW/replay-guard/x402mw): none of it applies to a
      // credential that was never an x402 payment header.
      req.tempoSettling = true;

      // Buffering mechanics verified against node_modules/@x402/express's
      // own paymentVerified branch (dist/esm/index.mjs) rather than
      // reinvented: while res.end is overridden to only buffer, Node's real
      // 'finish' event NEVER fires (the underlying socket write never
      // happens) — so the synchronization primitive has to be an explicit
      // promise resolved INSIDE the buffered res.end, not res.on("finish").
      const originalWriteHead = res.writeHead.bind(res);
      const originalWrite = res.write.bind(res);
      const originalEnd = res.end.bind(res);
      let bufferedCalls = [];
      let settled = false;
      let endCalled;
      const endPromise = new Promise((resolve) => { endCalled = resolve; });
      const restore = () => {
        settled = true;
        res.writeHead = originalWriteHead;
        res.write = originalWrite;
        res.end = originalEnd;
      };
      res.writeHead = (...a) => { if (!settled) { bufferedCalls.push(["writeHead", a]); return res; } return originalWriteHead(...a); };
      res.write = (...a) => { if (!settled) { bufferedCalls.push(["write", a]); return true; } return originalWrite(...a); };
      res.end = (...a) => { if (!settled) { bufferedCalls.push(["end", a]); endCalled(); return res; } return originalEnd(...a); };
      const replay = () => {
        for (const [fn, a] of bufferedCalls) {
          if (fn === "writeHead") originalWriteHead(...a);
          else if (fn === "write") originalWrite(...a);
          else originalEnd(...a);
        }
        bufferedCalls = [];
      };

      try {
        next(); // dispatch into the rest of the chain / the real route handler
      } catch (err) {
        restore();
        return next(err);
      }

      await endPromise; // resolves once the (buffered) handler tries to end its response

      if (res.statusCode >= 400) {
        // Handler failed — never broadcast, buyer was never going to be
        // charged, same invariant as every other rail.
        restore();
        replay();
        return;
      }
      const b = await broadcast(auth);
      if (!b.ok) {
        // Broadcast failed AFTER a successful handler — discard the
        // buffered body and answer 402, mirroring @x402/express's own
        // "settlement of a <400 response fails → discard, return 402".
        bufferedCalls = [];
        restore();
        res.status(402).json({ error: "Tempo settlement failed", reason: b.error });
        return;
      }
      const receiptHeader = tempoReceiptHeader(b.receipt);
      restore();
      if (receiptHeader) res.setHeader("Payment-Receipt", receiptHeader);
      // Settlement-attribution flag for server.js's shared per-catalog-route
      // stats tally (mounted much later in the chain, after this gate) — a
      // Tempo settlement carries no PAYMENT-RESPONSE header (no @x402/express
      // involvement), so without this it would fall through that code's
      // default and get mislabeled as plain x402.
      req.tempoSettled = true;
      replay();
    }).catch(() => next()); // validation itself threw — fall through untouched
  };
}
