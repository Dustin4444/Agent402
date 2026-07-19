// P1.5 / FR4-10: x402VerifierFromExpress — a first-party verifyX402 that owns
// timeout + cancellation. Grants on next(), denies on a 402 write, honors the
// gate's AbortSignal (opts.signal), backstops with its own timeout, and rejects
// on a thrown middleware. Offline, no network.
//
//   node scripts/test-tollbooth-verifier.js
import { x402VerifierFromExpress } from "../tollbooth/index.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };
const req = { headers: { "x-payment": "sig" } };
const settled = (p) => p.then((v) => ({ v }), (e) => ({ e }));

// grant: middleware calls next()
{
  const v = x402VerifierFromExpress((_req, _res, next) => next());
  ok((await v(req, {})) === true, "grants (true) when the middleware calls next()");
}
// deny: middleware writes a 402 response
{
  const v = x402VerifierFromExpress((_req, res) => res.status(402).json({ error: "no payment" }));
  ok((await v(req, {})) === false, "denies (false) when the middleware writes a 402");
}
// deny via send()/end() too
{
  const v = x402VerifierFromExpress((_req, res) => res.end());
  ok((await v(req, {})) === false, "denies when the middleware ends the response without next()");
}
// honors an already-aborted signal
{
  const ac = new AbortController(); ac.abort();
  const v = x402VerifierFromExpress(() => { /* would hang */ });
  ok((await v(req, { signal: ac.signal })) === false, "an already-aborted signal → not verified (no hang)");
}
// honors an abort that fires mid-verification
{
  const ac = new AbortController();
  const v = x402VerifierFromExpress(() => { /* never resolves */ });
  const p = settled(v(req, { signal: ac.signal }));
  setTimeout(() => ac.abort(), 20);
  const r = await p;
  ok(r.v === false, "an abort during verification → resolves false (gate not left hanging)");
}
// own timeout backstop when no signal is passed
{
  const v = x402VerifierFromExpress(() => { /* hangs */ }, { timeoutMs: 30 });
  ok((await v(req, {})) === false, "own timeoutMs backstops a hung middleware (no signal needed)");
}
// a thrown middleware rejects (gate maps it to a 402)
{
  const v = x402VerifierFromExpress(() => { throw new Error("boom"); });
  const r = await settled(v(req, {}));
  ok(r.e instanceof Error, "a thrown middleware rejects (gate .catch → 402)");
}
// a late resolution after abort cannot flip the result back to granted
{
  const ac = new AbortController();
  let stashedNext;
  const v = x402VerifierFromExpress((_req, _res, next) => { stashedNext = next; });
  const p = settled(v(req, { signal: ac.signal }));
  ac.abort();
  const r1 = await p;
  stashedNext?.(); // middleware "grants" late — must be ignored
  ok(r1.v === false, "a settlement that completes AFTER the abort cannot grant (no charged-then-denied flip)");
}
// bad input
{
  let threw = false; try { x402VerifierFromExpress(null); } catch { threw = true; }
  ok(threw, "throws if not given a middleware function");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
