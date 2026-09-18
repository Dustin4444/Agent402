// Boot-time initialisation of the x402 HTTP resource server, driven by US
// rather than by @x402/express, so a facilitator problem at boot can never
// take the process down.
//
// Why this exists (2026-09-18, the @x402 2.22 -> 2.26 bump): since 2.25
// `paymentMiddleware()` starts `httpServer.initialize()` eagerly and hangs
// `attachBackgroundInitHandler` on it, which calls `process.exit(1)` when the
// init rejects with a RouteConfigurationError (a route advertises a network no
// reachable facilitator supports) or a FacilitatorCapabilityError. Before
// 2.25 the same failure was swallowed and every PAID route answered 500 per
// request while the free tier kept serving - the shape of the 2026-08-01 Celo
// outage, and the shape the boot /supported guard in payments.js exists to
// prevent. With the vendor's handler in place the guard's own escape hatch
// (`X402_SUPPORTED_GUARD=off`) became a crash lever: one dead facilitator and
// the container exits in a loop, free tier included. The fail-open branch
// (every probe failed) had the same exposure whenever the vendor's own init
// then reached a facilitator the probe had not.
//
// So the middleware is constructed with `syncFacilitatorOnStart = false`
// (nothing for the vendor's handler to exit on) and THIS module owns the init:
//   - eager: one attempt starts at construction, like the vendor's;
//   - never fatal: a rejection is logged with its class and message, the
//     process stays up, paid routes answer 500 exactly as they did before
//     2.25 (the core still refuses to build a 402 for a kind it has not seen);
//   - self-healing: every paid request that finds the server uninitialised
//     awaits the in-flight attempt or starts a fresh one - the vendor's
//     per-request retry, kept;
//   - latched: once an attempt succeeds nothing re-initialises, so a
//     facilitator dying mid-run costs only its own rail's verify/settle
//     (the "runtime death" leg of scripts/test-supported-guard.js).
// X402_SYNC_ON_START=false skips it entirely, as before (offline tests).
// Pinned by scripts/test-x402-boot-init.js and test-supported-guard leg 4.

/**
 * @param {{ initialize: () => Promise<void> }} httpServer - an @x402 x402HTTPResourceServer
 * @param {{ log?: (line: string) => void, eager?: boolean }} [opts]
 * @returns {{ ensure: () => Promise<boolean>, initialized: () => boolean, attempts: () => number }}
 */
export function createGuardedInit(httpServer, { log = console.error, eager = true, retryAfterMs = 1000, now = Date.now } = {}) {
  let initialized = false;
  let inflight = null;
  let attempts = 0;
  let lastFailureAt = 0;
  const ensure = () => {
    if (initialized) return Promise.resolve(true);
    if (!inflight) {
      // A burst of paid requests during an outage must not fan out into one
      // facilitator fetch each: inside the cooldown they fall through to the
      // vendor's 500 with no new attempt.
      if (lastFailureAt && now() - lastFailureAt < retryAfterMs) return Promise.resolve(false);
      attempts++;
      const n = attempts;
      inflight = Promise.resolve()
        .then(() => httpServer.initialize())
        .then(() => { initialized = true; return true; })
        .catch((e) => {
          log(
            `[payments] x402 init attempt ${n} failed (${e?.name || "Error"}: ${String(e?.message || e).slice(0, 300)}) - ` +
              "paid routes answer 500 until a retry succeeds; the free tier is unaffected. The process stays up."
          );
          lastFailureAt = now();
          return false;
        })
        .finally(() => { inflight = null; });
    }
    return inflight;
  };
  if (eager) void ensure();
  return { ensure, initialized: () => initialized, attempts: () => attempts };
}

/**
 * Wrap the vendor middleware so a PAID request never reaches it before one
 * init attempt has run (free routes pass straight through, as the vendor's
 * own `requiresPayment` gate would have sent them to next()). A failed
 * attempt falls through: the vendor answers the pre-2.25 500 for a kind it
 * cannot build, never charging anyone.
 */
export function withGuardedInit(middleware, init, httpServer) {
  const paid = (req) => {
    try { return httpServer.requiresPayment({ path: req.path, method: req.method }); } catch { return true; }
  };
  return async function guardedPaymentMiddleware(req, res, next) {
    if (!init.initialized() && paid(req)) await init.ensure();
    return middleware(req, res, next);
  };
}
