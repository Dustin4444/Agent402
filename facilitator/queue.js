// A minimal promise-chain serializer. Used to make settlement calls
// genuinely one-at-a-time (not just "usually" - the facilitator's single
// signer account has one Stellar sequence number, and two concurrent
// settlements both reading it before either submits is a proven, live-tested
// failure mode: one of them gets rejected before it ever reaches a ledger).
//
// Deliberately NOT a generic job queue with concurrency limits, retries, or
// backpressure - just enough to guarantee ordering for this one call site.
export function createSerialQueue() {
  let tail = Promise.resolve();
  return function enqueue(fn) {
    const result = tail.then(fn, fn);
    // Swallow so one failed job never poisons the chain for the next job -
    // each caller still gets its own rejection via `result`.
    tail = result.then(() => {}, () => {});
    return result;
  };
}
