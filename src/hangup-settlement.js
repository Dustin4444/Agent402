// A buyer whose connection is gone before the first response byte is never
// charged: one rule on every rail.
//
// The signal is the ServerResponse "close" event fired while nothing has been
// written (!res.writableFinished && !res.headersSent). Every paid gate (the
// x402 middleware, the MPP evm shim that rides it, the Tempo and Stripe gates)
// buffers writeHead/write/end/flushHeaders until after it settles, so on those
// rails "headers not sent" means both that no byte reached the buyer AND that
// settlement has not been broadcast yet. This hook records that moment on the
// request (req.__a402ClientGoneAt) and every settlement point reads it through
// clientGoneBeforeFirstByte() before it moves money:
//   - x402 (and MPP evm): an onBeforeSettle hook aborts settlement with
//     reason "client_disconnected" before any facilitator call
//     (registerClientGoneSettleHook in src/payments.js);
//   - Tempo and Stripe: the gate checks the same condition after the handler
//     and before the broadcast / capture, and answers 499 with nothing spent;
//   - credits: the gate releases its hold when the socket closes before the
//     first byte (a stream that already began is settled, as before).
// The dispatcher also refuses to START a handler for a request whose client
// is already gone, and a report composite's per-request upstream calls are
// cut off the moment the buyer leaves (src/drain-abort.js clientGoneSignal).
//
// What is left in the refund ledger is the one window no check can close: a
// close that lands while the settle, broadcast or capture call is itself in
// flight. The money has moved by the time the gate can see the socket is gone,
// so that charge is booked as owed (server.js recordHangupDebt), exactly as
// before. A cancelled charge is NOT a debt and writes no ledger row.
//
// Mechanism: mounted BEFORE every payment gate, the hook wraps the REAL
// res.end, so each gate's captured "originalEnd" is this wrapper. When a gate
// finally ends a response whose client already left, `onUndelivered` sees the
// request with whatever settlement evidence is on it (PAYMENT-RESPONSE,
// req.tempoSettled, req.stripeSettled) and decides whether it is the residual
// debt or a cancelled charge.
//
// Only a close that happened BEFORE any header reached the client counts: a
// stream that was cut part way through was (partly) delivered.

export const CLIENT_GONE_TEXT = "The connection closed before the response was ready, so the payment was not settled and nothing was charged.";

/** The error every client-gone refusal carries: a 499 (>= 400 cancels settlement on every rail). */
export function clientGoneError(msg = CLIENT_GONE_TEXT) {
  return Object.assign(new Error(msg), { name: "AbortError", statusCode: 499, clientGone: true });
}

/** True for an error produced by clientGoneError(). */
export function isClientGoneAbort(err) {
  return !!err && typeof err === "object" && err.clientGone === true;
}

/**
 * True when the buyer's connection closed before any byte of the response was
 * sent. Reads the flag the hook sets (own property only: a polluted prototype
 * must not make every request look abandoned and therefore unsettled); where
 * the hook is not mounted (FREE_MODE, a unit app) it falls back to the socket
 * state itself.
 */
export function clientGoneBeforeFirstByte(req) {
  if (!req || typeof req !== "object") return false;
  if (Object.hasOwn(req, "__a402ClientGoneAt") && Number(req.__a402ClientGoneAt) > 0) return true;
  const res = req.res;
  if (!res || typeof res !== "object" || res.headersSent) return false;
  return res.destroyed === true || req.socket?.destroyed === true;
}

/**
 * @param {object} opts
 * @param {(req: any, res: any, kind: "end") => void} opts.onUndelivered
 *        called at most once per request, when the client left before any
 *        byte was sent and a gate then ended the response. The callback
 *        decides whether settlement evidence is present (the residual window)
 *        or the charge was cancelled.
 */
export function createHangupSettlementHook({ onUndelivered }) {
  return function hangupSettlementHook(req, res, next) {
    let closedEarly = false;
    let fired = false;
    const fire = (kind) => {
      if (fired) return;
      fired = true;
      try { onUndelivered(req, res, kind); } catch { /* recording an outcome never breaks serving */ }
    };
    res.once("close", () => {
      if (res.writableFinished) return; // normal completion
      if (res.headersSent) return; // partly delivered (streaming): not this case
      closedEarly = true;
      req.__a402ClientGoneAt = Date.now();
    });
    const realEnd = res.end;
    res.end = function hangupAwareEnd(...args) {
      if (closedEarly) fire("end");
      return realEnd.apply(this, args);
    };
    next();
  };
}
