// Charged-but-not-served on a client hang-up: one rule on every rail.
//
// Every paid rail settles AFTER the handler has done the work and produced a
// <400 response, whether or not the client is still connected: @x402/express
// (and the MPP evm shim, which is x402 underneath) settles once the handler
// ends; the Tempo and Stripe gates broadcast/capture once the buffered handler
// ends; the credits gate converts its hold when the socket closes after
// dispatch. That keeps a hang-up from buying a free handler run.
//
// The other half is the buyer: if the socket closed before anything reached
// them, they paid for a response they never received. Node never fires
// "finish" on a destroyed socket, so the charged-failure path in server.js
// (a res.on("finish") listener) never sees it. This hook does.
//
// Mechanism: mounted BEFORE every payment gate, it wraps the REAL res.end, so
// each gate's captured "originalEnd" is this wrapper. When a gate finally
// ends a response whose client already hung up, the settlement evidence is on
// the request by then (PAYMENT-RESPONSE header, req.tempoSettled,
// req.stripeSettled) and the hook hands it to `onUndelivered`, which records
// a refund-ledger debt. Credits settle on the "close" event itself, so the
// hook also checks after every close listener has run (setImmediate).
//
// Only a close that happened BEFORE any header reached the client counts: a
// stream that was cut part way through was (partly) delivered, the same as
// x402 treats it today.

/**
 * @param {object} opts
 * @param {(req: any, res: any, kind: "end"|"close") => void} opts.onUndelivered
 *        called at most once per request, when the client hung up before any
 *        byte was sent and a gate then ended (or credits settled) the response.
 *        The callback decides whether settlement evidence is present.
 */
export function createHangupSettlementHook({ onUndelivered }) {
  return function hangupSettlementHook(req, res, next) {
    let closedEarly = false;
    let fired = false;
    const fire = (kind) => {
      if (fired) return;
      fired = true;
      try { onUndelivered(req, res, kind); } catch { /* recording a debt never breaks serving */ }
    };
    res.once("close", () => {
      if (res.writableFinished) return; // normal completion
      if (res.headersSent) return; // partly delivered (streaming): not this case
      closedEarly = true;
      // Credits settle inside their own close listener; look after they ran.
      setImmediate(() => { if (req.creditsChargedOnClose) fire("close"); });
    });
    const realEnd = res.end;
    res.end = function hangupAwareEnd(...args) {
      if (closedEarly) fire("end");
      return realEnd.apply(this, args);
    };
    next();
  };
}
