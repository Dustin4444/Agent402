// Offline tests for src/x402-live-quote.js.
//
// Fixtures are the REAL shapes, captured from a live seller on 2026-08-07 who
// reported 39 endpoints indexed at price:null while every one of them returns a
// textbook 402. If these assertions pass against anything less than that real
// challenge, they are not testing what went wrong.
import { acceptsFromLive402, quoteFromAccepts, probeMethodsFor, isQuoteResponse } from "../src/x402-live-quote.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// The accepts entry exactly as the reporting seller's 402 carries it: $0.99 as
// 990000 atomic units of Base USDC, with the name in `extra`.
const REAL_ACCEPT = {
  scheme: "exact",
  network: "eip155:8453",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  amount: "990000",
  payTo: "0x0bac88e8B47D9F2dC38E66dB9dA4b41032d24065",
  maxTimeoutSeconds: 60,
  extra: { name: "USDC", version: "2" },
};
const HEADER = Buffer.from(JSON.stringify({ x402Version: 2, accepts: [REAL_ACCEPT] })).toString("base64");

// --- reading the challenge ---------------------------------------------------
{
  ok(acceptsFromLive402({ header: HEADER })?.[0]?.amount === "990000",
    "accepts are read from the base64 payment-required HEADER (x402 v2's home for them)");

  // The same seller ALSO nests it in the body under `payment`. A reader that
  // only understood a top-level `accepts` would have missed it.
  const body = JSON.stringify({ error: { code: "PAYMENT_REQUIRED" }, payment: { rail: "cdp_x402", accepts: [REAL_ACCEPT] } });
  ok(acceptsFromLive402({ body })?.[0]?.payTo === REAL_ACCEPT.payTo,
    "accepts are read from a body that NESTS them under `payment`");

  ok(acceptsFromLive402({ body: JSON.stringify({ accepts: [REAL_ACCEPT] }) })?.length === 1,
    "a plain top-level accepts body still works");

  ok(acceptsFromLive402({ header: "not-base64-at-all", body: JSON.stringify({ accepts: [REAL_ACCEPT] }) })?.length === 1,
    "an undecodable header falls through to the body rather than giving up");

  ok(acceptsFromLive402({ header: "", body: "<html>nope</html>" }) === null,
    "an unreadable challenge is null - never an empty-but-truthy quote");
  ok(acceptsFromLive402({}) === null, "nothing in, null out");
}

// --- pricing -----------------------------------------------------------------
{
  const q = quoteFromAccepts([REAL_ACCEPT]);
  ok(q.price === 0.99, `990000 atomic USDC prices as $0.99, not 990000 (got ${q.price})`);
  ok(q.networks.includes("eip155:8453"), "the network travels with the quote");
  ok(q.payTo === REAL_ACCEPT.payTo, "the payTo is captured so the router can check where money goes");

  // Base USDC wins over another chain, matching bazaarItemToTool's order, so a
  // live-probed row and a Bazaar row are comparable.
  const multi = quoteFromAccepts([
    { network: "solana:x", amount: "5000000", payTo: "sol", extra: { name: "USDC" } },
    REAL_ACCEPT,
  ]);
  ok(multi.price === 0.99 && multi.network === "eip155:8453",
    `Base USDC is preferred when several chains are offered (got ${multi.price} on ${multi.network})`);
  ok(multi.networks.length === 2, "every offered chain is still recorded");
}

{
  // THE MONEY ASSERTION. An asset we cannot price must not become $0 - that
  // would publish a paid tool as free, and "free" is the one wrong answer a
  // buyer acts on immediately.
  const unknown = quoteFromAccepts([{ network: "eip155:8453", amount: "12345", payTo: "0xabc", extra: { name: "WEIRDTOKEN" } }]);
  ok(unknown.price === null, `an unpriceable asset yields null, never 0 (got ${unknown.price})`);
  ok(unknown.networks.includes("eip155:8453"),
    "…but the network is still recorded, so the row reads payable-on-Base rather than unknown");

  const explicit = quoteFromAccepts([{ network: "eip155:1", amount: "1500000000000000000", payTo: "0x1", extra: { name: "DAI", decimals: 18 } }]);
  ok(explicit.price === 1.5, `an explicit decimals hint is honoured (got ${explicit.price})`);

  ok(quoteFromAccepts([{ network: "eip155:8453", amount: "-5", extra: { name: "USDC" } }]).price === null,
    "a negative amount is corrupt, not free");
  ok(quoteFromAccepts([{ network: "eip155:8453", amount: "abc", extra: { name: "USDC" } }]).price === null,
    "a non-numeric amount does not become NaN dollars");
  ok(quoteFromAccepts([{ network: "eip155:8453", amount: "0", extra: { name: "USDC" } }]).price === 0,
    "an explicit zero IS free and is reported as such");
  ok(quoteFromAccepts([]) === null && quoteFromAccepts(null) === null, "no accepts, no quote");
}

// --- which methods to probe --------------------------------------------------
{
  // The defect in one assertion: the reporting seller's routes 404 on GET and
  // 402 on POST. A GET-only prober sees a dead catalogue.
  ok(probeMethodsFor({ method: "GET", methodInferred: true }).includes("POST"),
    "an INFERRED GET still tries POST - the seller whose routes 404 on GET and 402 on POST");
  ok(probeMethodsFor({}).join(",") === "GET,POST", "no stated method tries both, GET first (cheapest)");
  ok(probeMethodsFor({ method: "POST" }).join(",") === "POST", "a stated POST is taken at its word");
  ok(probeMethodsFor({ method: "GET", methodInferred: false }).join(",") === "GET,POST",
    "a stated GET still falls back to POST, because a 404 costs one request and a missed catalogue costs a seller");

  // An unpaid probe must never be able to mutate a stranger's server.
  for (const m of ["PUT", "PATCH", "DELETE"]) {
    ok(probeMethodsFor({ method: m }).length === 0, `${m} is never probed - an unpaid probe must not mutate anything`);
  }
}

{
  ok(isQuoteResponse(402) === true, "402 is the healthy answer to an unpaid call");
  ok(isQuoteResponse(200) === false, "200 means the route is not paywalled, which is not a quote");
  ok(isQuoteResponse(404) === false && isQuoteResponse(500) === false, "errors are not quotes");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
