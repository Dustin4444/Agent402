#!/usr/bin/env node
// Seller payability check (2026-09-11): buy one call from an x402 seller and
// report the legs. Offline - a stub seller and a stub payer, so this asserts
// the contract, the spend bound and every refusal without spending a cent.
//
// The defect this product exists for is real: a seller advertised the wrong
// EIP-712 domain name on its Base accept and nothing settled for a month while
// every surface it owned read healthy (2026-09-10). The domain leg below is
// that case.
import { buildSellerPayabilityTool, normalizeTarget, readChallenge, domainFindings, payabilityFlags, MAX_SPEND_USD } from "../src/tools/seller-payability-kit.js";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const accept = (over = {}) => ({ scheme: "exact", network: "eip155:8453", asset: BASE_USDC, amount: "10000", payTo: "0x" + "11".repeat(20), maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" }, ...over });
const challengeHeader = (accepts) => Buffer.from(JSON.stringify({ x402Version: 2, accepts })).toString("base64");
const res402 = (accepts) => ({ status: 402, headers: new Map([["payment-required", challengeHeader(accepts)], ["content-type", "application/json"]]), text: async () => "{}" });
const plain = (status, body = "{}") => ({ status, headers: new Map([["content-type", "application/json"]]), text: async () => body });
for (const r of []) void r;
const hdr = (m) => ({ get: (k) => m.get(k.toLowerCase()) ?? null });
const wrap = (r) => ({ ...r, headers: hdr(r.headers) });

/** A tool wired to stubs; `spent` records what the guard was asked for. */
function toolWith({ bare, pay, spendOk = true } = {}) {
  const spent = { may: [], note: [], adjust: [] };
  const tool = buildSellerPayabilityTool({
    pay: pay || (async () => ({ result: { ok: true }, quote: null, receipt: { network: "eip155:8453", payer: "0xpayer", transaction: "0xtx", success: true } })),
    fetchImpl: async () => wrap(bare || res402([accept()])),
    assertPublicUrl: async () => {},
    maySpend: (p, usd, o) => { spent.may.push({ usd, chain: o?.chain }); return spendOk ? { ok: true } : { ok: false, code: "wallet_daily_ceiling" }; },
    noteSpend: (p, usd, o) => { spent.note.push({ usd, chain: o?.chain }); return { handle: 1 }; },
    adjustSpend: (h, usd) => spent.adjust.push(usd),
    now: () => 1_757_000_000_000,
  });
  return { tool, spent };
}

// --- input handling --------------------------------------------------------
{
  ok(normalizeTarget("api.example.com/x") === "https://api.example.com/x", "a bare host is normalised to https");
  const throws = (fn, substr, msg) => { let e = null; try { fn(); } catch (x) { e = x; } ok(e && String(e.message).includes(substr), `${msg} (got ${e ? String(e.message).slice(0, 70) : "no throw"})`); };
  throws(() => normalizeTarget("http://api.example.com"), "https", "http is refused: a seller settling real money should not be on http");
  throws(() => normalizeTarget("https://u:p@api.example.com"), "Credentials", "credentials in the URL are refused");
  throws(() => normalizeTarget(""), '"url" is required', "an empty url is refused by name");
  const { tool } = toolWith();
  const rejects = async (input, substr, msg) => { let e = null; try { await tool.handler(input, {}); } catch (x) { e = x; } ok(e && String(e.message).includes(substr), `${msg} (got ${e ? String(e.message).slice(0, 70) : "no throw"})`); return e; };
  await rejects({ url: "https://s.example", method: "DELETE" }, "GET or POST", "a mutating verb is refused: a check never sends one");
  await rejects({ url: "https://s.example", body: "nope" }, '"body" must be', "a non-object body is refused");
  await rejects({ url: "https://s.example", maxUsd: 0 }, "positive", "maxUsd must be positive");
  const over = await rejects({ url: "https://s.example", maxUsd: 1 }, `capped at $${MAX_SPEND_USD}`, "maxUsd above the hard ceiling is refused, naming the ceiling");
  ok(over?.statusCode === 400, "and it is a 400 the caller can act on");
}

// --- the money bound -------------------------------------------------------
{
  const price = Number("0.10");
  ok(MAX_SPEND_USD <= price * 0.7, `the hard spend ceiling $${MAX_SPEND_USD} is inside 70% of the $${price} price (the margin rule)`);
  const { tool, spent } = toolWith();
  await tool.handler({ url: "https://s.example" }, {});
  ok(spent.may[0]?.chain === "base" && spent.may[0].usd === 0.01, "every check asks the Base wallet's daily ceiling BEFORE any call, for the cap");
  ok(spent.note[0]?.usd === 0.01, "and books the cap against that ceiling up front");
  ok(spent.adjust[0] === 0.01, "then corrects the booking down to the seller's actual quote");
  const blocked = toolWith({ spendOk: false });
  let e = null; try { await blocked.tool.handler({ url: "https://s.example" }, {}); } catch (x) { e = x; }
  ok(e?.statusCode === 429 && /daily ceiling/.test(e.message), "a wallet at its daily ceiling refuses 429 before spending, and says so");
  ok(blocked.spent.note.length === 0, "and books nothing");
}

// --- a healthy seller ------------------------------------------------------
{
  const { tool } = toolWith();
  const r = await tool.handler({ url: "https://s.example", body: { q: "hi" } }, {});
  ok(r.payable === true, "a seller that 402s, accepts the signed payment and settles reads payable:true");
  ok(r.unpaidCall.status === 402 && r.challenge.readable && r.challenge.priceUsd === 0.01, "the unpaid leg and the decoded quote are reported");
  ok(r.payment.attempted && r.payment.settled === true && r.payment.receipt.transaction === "0xtx", "the settle receipt and transaction are carried through");
  ok(r.flags.length === 1 && /nothing to fix/.test(r.flags[0]), `a clean seller gets one flag saying so (got ${JSON.stringify(r.flags)})`);
  ok(r.untrustedContent === true, "the seller's own text is marked untrusted");
  ok(typeof r.responseSlice === "string" && r.responseSlice.length <= 2000, "the response body is bounded");
}

// --- the wrong-domain seller: the case this product exists for -------------
{
  const { tool } = toolWith({ bare: res402([accept({ extra: { name: "USDC", version: "2" } })]) });
  const r = await tool.handler({ url: "https://s.example" }, {});
  const f = r.domainFindings[0];
  ok(f?.verdict === "wrong_domain" && f.advertisedName === "USDC" && f.expectedName === "USD Coin", "a Base accept naming \"USDC\" is reported wrong_domain with both names");
  ok(r.flags.some((x) => /extra\.name/.test(x) && /USD Coin/.test(x)), "and the flag tells the seller which field to change");
  const clean = toolWith();
  const rc = await clean.tool.handler({ url: "https://s.example" }, {});
  ok(rc.domainFindings[0]?.verdict === "matches" && !rc.flags.some((x) => /extra\.name/.test(x)), "a correct accept reports matches and raises no domain flag");
  ok(domainFindings([{ network: "eip155:1", asset: BASE_USDC, domainName: "USDC" }]).length === 0, "a chain we hold no truth for is silent, never guessed");
}

// --- the seller shapes that are NOT payable --------------------------------
{
  const notPaywalled = toolWith({ bare: plain(200, '{"data":1}') });
  const r200 = await notPaywalled.tool.handler({ url: "https://s.example" }, {});
  ok(r200.payable === false && r200.payment.attempted === false, "a 200 to an unpaid call is not payable and no payment is attempted");
  ok(r200.flags.some((f) => /not paywalled/.test(f)), "and the flag says the endpoint is not paywalled");
  ok(notPaywalled.spent.adjust.length === 0, "nothing is spent, so nothing is corrected");

  const wrongStatus = toolWith({ bare: plain(404) });
  const r404 = await wrongStatus.tool.handler({ url: "https://s.example" }, {});
  ok(r404.flags.some((f) => /404/.test(f) && /not 402/.test(f)), "a non-402 status is reported with what a buyer's client does next");

  const junk402 = toolWith({ bare: { status: 402, headers: new Map([["content-type", "text/html"]]), text: async () => "<html>pay me</html>" } });
  const rj = await junk402.tool.handler({ url: "https://s.example" }, {});
  ok(rj.challenge.readable === false && rj.payment.attempted === false && rj.flags.some((f) => /could not be parsed/.test(f)), "a 402 with no parseable accepts is reported and never paid");

  const refuses = toolWith({ pay: async () => { throw Object.assign(new Error("Seller refused the payment (HTTP 402); the credential expired unused, nothing charged"), { statusCode: 502, refused: true }); } });
  const rr = await refuses.tool.handler({ url: "https://s.example" }, {});
  ok(rr.payable === false && rr.payment.status === 402 && rr.payment.settled === false, "a seller that refuses our signed payment is reported as refused, not as our error");
  ok(rr.flags.some((f) => /stock client produces/.test(f)), "and the flag names the thing the seller has to fix");

  const overCap = toolWith({ bare: res402([accept({ amount: "500000" })]) });
  const ro = await overCap.tool.handler({ url: "https://s.example" }, {});
  ok(ro.payment.attempted === false && ro.flags[0].includes("above the $0.01 cap"), "a quote above the cap is reported, not paid");
  ok(overCap.spent.adjust.length === 0, "and books no correction");

  const unreachable = buildSellerPayabilityTool({
    pay: async () => { throw new Error("unused"); },
    fetchImpl: async () => { throw new Error("getaddrinfo ENOTFOUND"); },
    assertPublicUrl: async () => {}, maySpend: () => ({ ok: true }), noteSpend: () => ({}), adjustSpend: () => {},
  });
  const ru = await unreachable.handler({ url: "https://gone.example" }, {});
  ok(ru.unpaidCall.error && ru.payable === false && ru.payment.attempted === false, "an unreachable seller is reported with the error, never paid");

  const priv = buildSellerPayabilityTool({
    pay: async () => ({}), fetchImpl: async () => plain(200), assertPublicUrl: async () => { throw new Error("private"); },
    maySpend: () => ({ ok: true }), noteSpend: () => ({}), adjustSpend: () => {},
  });
  let e = null; try { await priv.handler({ url: "https://internal.example" }, {}); } catch (x) { e = x; }
  ok(e?.statusCode === 400 && /private or blocked/.test(e.message), "a private target is refused before the spend guard is even asked (SSRF)");
}

// --- pure helpers ----------------------------------------------------------
{
  ok(readChallenge({ header: challengeHeader([accept()]) }).priceUsd === 0.01, "readChallenge prices a Base USDC accept");
  ok(readChallenge({ header: "not-base64", body: "nope" }).readable === false, "an unreadable challenge says so rather than throwing");
  const f = payabilityFlags({ bare: { status: 402 }, challenge: { readable: true, priceUsd: 0.01 }, domains: [], paid: { status: 200 }, settled: true });
  ok(f.length === 1 && /nothing to fix/.test(f[0]), "flags: a clean run says so and nothing else");
  const f2 = payabilityFlags({ bare: { status: 200 }, challenge: {}, domains: [], paid: null, settled: null });
  ok(f2.some((x) => /not paywalled/.test(x)) && !f2.some((x) => /nothing to fix/.test(x)), "flags: a 200 never reads as clean");
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
