// A promise that never settles (a stalled RPC call, not a rejected one -
// Node's fetch/http stack can hang on a dead connection with no error and
// no built-in ceiling) otherwise blocks forever: the caller's HTTP
// connection, and - for /settle specifically, since it runs through the
// serialized queue - every OTHER queued settlement behind it too. Racing
// against a timer bounds that, but the loser is never truly cancelled (no
// AbortController reaches into @x402/stellar), so its eventual settlement
// still runs to completion in the background - see index.js's /settle
// handler for what that trade-off requires downstream.
//
// Split into its own module (no imports, no side effects) so it can be
// unit-tested directly without pulling in index.js's top-level code, which
// requires FACILITATOR_STELLAR_SECRET to be set just to import - same
// reasoning as shape.js and queue.js already being separate from index.js.

export class TimeoutError extends Error {
  constructor(label, ms) {
    super(`${label} timed out after ${ms}ms`);
    this.code = "FACILITATOR_TIMEOUT";
  }
}

export function withTimeout(promise, ms, label) {
  const wrapped = Promise.resolve(promise);
  wrapped.catch(() => {}); // the loser's eventual rejection must never surface as unhandled
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  return Promise.race([wrapped, timeout]).finally(() => clearTimeout(timer));
}
