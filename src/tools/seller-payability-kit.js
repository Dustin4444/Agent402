// Payability check: buy ONE call from an x402 seller and report what happened.
//
// WHY (2026-09-11). Three sellers wrote to us in one week because their
// endpoints looked healthy and nobody was paying them, and in each case the
// answer was only visible from OUTSIDE: one advertised the wrong EIP-712
// domain name on its Base accept, so every stock buyer's signature recovered
// to nobody and nothing had settled for a month; one had a live 402 that
// disagreed with its own manifest; one was fine and had simply never been
// tried. We answered each by hand with scripts/external-seller-probe.js - a
// dispatch-only script that pays one call from the spending wallet and prints
// the raw legs. This is that script as a product: the seller-facing twin of
// seller-dossier, which reports what we already KNOW. This one goes and finds
// out, right now, with real money.
//
// WHAT IT RETURNS: the bare 402 decoded (accepts, payTo, asset, price, and the
// chain-truth verdict on the accept's EIP-712 domain name), whether the signed
// payment was accepted, the settle receipt and transaction, a bounded slice of
// the response body, and the wall time of each leg - then sentence FLAGS, no
// score. Every field is something we observed in this call; nothing is
// inferred from the index.
//
// MONEY. The upstream is the seller's own price, capped by `maxUsd` (default
// $0.01, hard ceiling MAX_SPEND_USD) and re-checked by payX402 against the
// accept it actually signs, so a seller cannot quote one price and charge
// another. Every spend books against the Base wallet's daily ceiling through
// the same guard route-execute uses, so the aggregate is bounded even if this
// tool is hammered. At $0.10 a check against at most $0.02 of upstream plus
// Base gas, the margin holds at the 70% bound.
//
// WHY A CALLER CANNOT FARM US. The obvious abuse is pointing the tool at your
// own endpoint to collect our payment: it loses money for the attacker (they
// pay $0.10 to receive at most $0.02), the per-call cap is enforced against
// the signed accept, and the wallet's daily ceiling bounds the total. The
// target must also pass the SSRF guard and answer a real 402. The seller's
// response body is third-party text, so it is truncated and marked untrusted.
import { markUntrusted } from "./provenance.js";
import { maySpend as realMaySpend, noteSpend as realNoteSpend, adjustSpend as realAdjustSpend } from "../external-spend-guard.js";
import { usdcDomainVerdict, usdcDomainMismatchDetail } from "../evm-usdc-domain.js";
import { acceptsFromLive402, quoteFromAccepts } from "../x402-live-quote.js";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

/** Hard ceiling on what one check may spend upstream, whatever `maxUsd` asks
 *  for. The price is $0.10; this keeps the worst case inside the margin rule
 *  even when a caller asks for the maximum. */
export const MAX_SPEND_USD = 0.02;
const DEFAULT_MAX_USD = 0.01;
const BODY_SLICE = 2000;
const PROBE_TIMEOUT_MS = 15_000;
const PAY_TIMEOUT_MS = 45_000;

/** Accept the shapes a buyer actually types. Returns a validated https URL. */
export function normalizeTarget(raw) {
  const s = String(raw ?? "").trim();
  if (!s) throw bad('"url" is required - the seller endpoint to check, e.g. https://api.example.com/tool');
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { throw bad(`"${s.slice(0, 80)}" is not a URL`); }
  if (u.protocol !== "https:") throw bad("Only https endpoints are checked - an x402 seller that settles real money should not be served over http");
  if (u.username || u.password) throw bad("Credentials in the URL are not accepted");
  return u.toString();
}

/** The decoded 402, or a reason it could not be read. Never throws. */
export function readChallenge({ header, body }) {
  const accepts = acceptsFromLive402({ header, body }) || [];
  if (!accepts.length) return { readable: false, reason: "the 402 carried no accepts we could parse (neither the PAYMENT-REQUIRED header nor the body)", accepts: [] };
  const quote = quoteFromAccepts(accepts) || {};
  return {
    readable: true,
    networks: [...new Set(accepts.map((a) => a?.network).filter((n) => typeof n === "string"))].slice(0, 16),
    priceUsd: quote.price ?? null,
    payTo: typeof quote.payTo === "string" ? quote.payTo.slice(0, 80) : null,
    asset: typeof quote.asset === "string" ? quote.asset.slice(0, 80) : null,
    pricedFrom: quote.network ?? null,
    accepts: accepts.slice(0, 16).map((a) => ({
      scheme: typeof a?.scheme === "string" ? a.scheme.slice(0, 24) : null,
      network: typeof a?.network === "string" ? a.network.slice(0, 60) : null,
      asset: typeof a?.asset === "string" ? a.asset.slice(0, 80) : null,
      payTo: typeof a?.payTo === "string" ? a.payTo.slice(0, 80) : null,
      amount: a?.amount ?? a?.maxAmountRequired ?? null,
      domainName: typeof a?.extra?.name === "string" ? a.extra.name.slice(0, 40) : null,
      maxTimeoutSeconds: Number.isFinite(Number(a?.maxTimeoutSeconds)) ? Number(a.maxTimeoutSeconds) : null,
    })),
  };
}

/** The EIP-712 domain verdict for every EVM accept we could judge. A wrong
 *  name is the defect that made a whole catalog unpayable for a month, and it
 *  is readable from the accept alone - see src/evm-usdc-domain.js. */
export function domainFindings(accepts) {
  const out = [];
  for (const a of accepts || []) {
    const v = usdcDomainVerdict({ asset: a.asset, name: a.domainName }, a.network);
    if (v.verdict === "unknown") continue;
    out.push({ network: a.network, verdict: v.verdict, advertisedName: v.advertisedName ?? a.domainName, expectedName: v.expectedName, chain: v.chain });
  }
  return out;
}

/** Sentence flags, in the order a seller should act on them. No score: a
 *  number reads as a verdict we did not measure (the dossier's own rule). */
export function payabilityFlags({ bare, challenge, domains, paid, receipt, settled }) {
  const flags = [];
  if (bare?.status === 200) flags.push("the endpoint answered 200 to an unpaid call: it is not paywalled, so an x402 buyer never pays for it");
  else if (bare?.status !== 402) flags.push(`an unpaid call answered HTTP ${bare?.status ?? "nothing"}, not 402: a buyer's client sees no payment challenge and stops here`);
  if (bare?.status === 402 && !challenge?.readable) flags.push(`the 402 could not be parsed: ${challenge?.reason}`);
  for (const d of domains || []) {
    if (d.verdict === "wrong_domain") flags.push(`${usdcDomainMismatchDetail(d)} - fix extra.name on the ${d.network} accept`);
  }
  if (challenge?.readable && challenge.priceUsd == null) flags.push("the accepts carry no amount we could price: a buyer that checks the quote before paying cannot");
  if (paid && paid.status === 402) flags.push("the signed payment was refused and the route answered 402 again: the credential your gate rejected is the one a stock client produces");
  else if (paid && paid.status >= 400) flags.push(`the paid call answered HTTP ${paid.status}: the payment was accepted or not, but the buyer got no result`);
  if (settled === false && paid?.status === 200) flags.push("the call answered 200 with no settlement receipt: the buyer was served for free, which is money you are not collecting");
  if (settled && paid?.status === 200 && !flags.length) flags.push("a stock buyer can pay this endpoint and get a result: nothing to fix");
  return flags;
}

/** Deps are injectable so the whole flow is testable offline with a stub
 *  seller; the defaults are the real spend guard, the real payer and the real
 *  SSRF-guarded fetch. */
export function buildSellerPayabilityTool({
  pay, spendChain = "base", fetchImpl, assertPublicUrl, now = () => Date.now(),
  maySpend = realMaySpend, noteSpend = realNoteSpend, adjustSpend = realAdjustSpend,
} = {}) {
  async function handler(input, req) {
    const url = normalizeTarget(input?.url);
    const method = String(input?.method ?? "POST").toUpperCase();
    if (!["GET", "POST"].includes(method)) throw bad('"method" must be GET or POST - a payability check never sends a verb that could mutate the seller');
    let body;
    if (input?.body !== undefined) {
      if (input.body === null || typeof input.body !== "object" || Array.isArray(input.body)) throw bad('"body" must be a JSON object (the input the seller\'s route expects)');
      body = input.body;
    }
    const asked = input?.maxUsd === undefined ? DEFAULT_MAX_USD : Number(input.maxUsd);
    if (!Number.isFinite(asked) || asked <= 0) throw bad('"maxUsd" must be a positive number of dollars');
    if (asked > MAX_SPEND_USD) throw bad(`"maxUsd" is capped at $${MAX_SPEND_USD} per check - a seller quoting above that is not checked here (the check costs $0.10 and cannot carry more)`);
    const maxUsd = asked;

    // SSRF before anything: paying an arbitrary URL is egress abuse with a
    // wallet attached, so resolve and refuse a private target up front. The
    // payer re-guards and pins the connection before it signs.
    try { await assertPublicUrl(url); } catch { throw bad("That URL resolves to a private or blocked address", 400); }

    // The wallet's daily ceiling, the same guard route-execute books against.
    // Keyed on the chain, so this tool cannot walk past the day's bound even
    // if every caller asks at once.
    const allowed = maySpend(null, maxUsd, { chain: spendChain });
    if (!allowed?.ok) {
      throw bad(allowed?.code === "wallet_daily_ceiling"
        ? "The Base spending wallet has reached its daily ceiling; payability checks resume tomorrow (nobody was charged)"
        : "Upstream spend is paused right now; try again shortly (nobody was charged)", 429);
    }
    const spendHandle = noteSpend(null, maxUsd, { chain: spendChain });

    const t0 = now();
    // LEG 1: the bare call. What a buyer's client sees before it pays.
    let bare = { status: null, error: null };
    let challenge = { readable: false, reason: "no 402 was returned" };
    try {
      const res = await fetchImpl(url, {
        method,
        headers: { Accept: "application/json", ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
        ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      const text = await res.text().catch(() => "");
      bare = { status: res.status, contentType: (res.headers.get("content-type") || "").slice(0, 80) || null, error: null };
      if (res.status === 402) challenge = readChallenge({ header: res.headers.get("payment-required"), body: text.slice(0, 64_000) });
      bare.bodySlice = text.slice(0, 400);
    } catch (e) {
      bare = { status: null, error: String(e?.message || e).slice(0, 120) };
    }
    const bareMs = now() - t0;

    const domains = challenge.readable ? domainFindings(challenge.accepts) : [];

    // LEG 2: pay it, but only when the first leg says a payment is possible
    // and the quote is inside the cap. A 200 or an unreadable challenge means
    // there is nothing to buy, and we never spend to learn that twice.
    let paid = null, receipt = null, settled = null, result = null, payError = null, payMs = null;
    const quoted = challenge.readable ? challenge.priceUsd : null;
    const payable = bare.status === 402 && challenge.readable;
    const overCap = payable && quoted != null && quoted > maxUsd;
    if (payable && !overCap) {
      const t1 = now();
      try {
        const out = await pay(url, {
          maxAtomic: BigInt(Math.round(maxUsd * 1e6)),
          method,
          ...(method === "POST" ? { body: body ?? {} } : {}),
          chain: spendChain,
          timeoutMs: PAY_TIMEOUT_MS,
        });
        paid = { status: 200 };
        receipt = out?.receipt ?? null;
        settled = !!(receipt && (receipt.success === true || receipt.transaction || receipt.tx));
        result = typeof out?.result === "string" ? out.result.slice(0, BODY_SLICE) : JSON.stringify(out?.result ?? null).slice(0, BODY_SLICE);
        // Correct the day's booking down to what the seller actually quoted.
        if (quoted != null) adjustSpend(spendHandle, quoted);
      } catch (e) {
        // payX402's own refusals carry a statusCode; a 402 means the seller
        // rejected the credential a stock client produces, which is the
        // single most useful thing this check can tell a seller.
        payError = String(e?.message || e).slice(0, 300);
        paid = { status: e?.statusCode === 402 || /refused the payment/i.test(payError) ? 402 : (e?.statusCode ?? null) };
        settled = false;
      }
      payMs = now() - t1;
    }

    const flags = payabilityFlags({ bare, challenge, domains, paid, receipt, settled });
    if (overCap) flags.unshift(`the seller quotes $${quoted}, above the $${maxUsd} cap this check was asked to spend, so no payment was attempted - raise maxUsd (up to $${MAX_SPEND_USD}) to buy it`);

    return markUntrusted({
      url,
      method,
      checkedAt: new Date(now()).toISOString(),
      payable: paid?.status === 200 && settled === true,
      unpaidCall: { status: bare.status, contentType: bare.contentType ?? null, error: bare.error, ms: bareMs, bodySlice: bare.bodySlice ?? null },
      challenge,
      domainFindings: domains,
      payment: paid
        ? { attempted: true, status: paid.status, settled, error: payError, ms: payMs, receipt: receipt ? { network: receipt.network ?? null, payer: receipt.payer ?? null, transaction: receipt.transaction ?? receipt.tx ?? null, success: receipt.success ?? null } : null }
        : { attempted: false, reason: overCap ? "quote above the cap" : bare.status === 402 ? "the 402 could not be parsed" : "the endpoint did not answer 402", settled: null },
      responseSlice: result,
      flags,
    });
  }

  return {
    route: "POST /api/seller-payability",
    name: "x402 seller payability check",
    slug: "seller-payability",
    aliases: ["payability-check", "can-i-pay-this", "seller-payment-check", "x402-payability"],
    category: "x402",
    price: "$0.10",
    description:
      "Buy one call from an x402 seller endpoint right now and report exactly what happened: the unpaid call's status, the 402 decoded (accepts, chains, payTo, asset, price), whether the accept's EIP-712 domain name matches the token it names (the defect that silently makes a whole catalog unpayable), whether a stock client's signed payment was accepted, the settlement receipt and transaction, a slice of the response body, and the time each leg took. Ends in plain-English flags, never a score. This is the live counterpart to seller-dossier, which reports what we already know: this one spends real USDC from our own wallet to find out. Point it at your own endpoint before you launch, or at a seller you are about to route money to. Up to $0.02 of the seller's price per check.",
    tags: ["x402", "seller", "payability", "payment", "402", "check", "verify", "settlement", "debug", "pre-launch",
      "is my endpoint payable", "why is nobody paying me", "test my x402 endpoint", "can an agent pay this", "eip-712", "domain"],
    discovery: {
      bodyType: "json",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "The seller endpoint to check (https), e.g. https://api.example.com/tools/summarize" },
          method: { type: "string", description: "GET or POST (default POST) - never a verb that could mutate the seller" },
          body: { type: "object", description: "Optional JSON body the seller's route expects (POST only)" },
          maxUsd: { type: "number", description: `Most to spend on the seller's own price, default ${DEFAULT_MAX_USD}, capped at ${MAX_SPEND_USD}` },
        },
        required: ["url"],
      },
      input: { url: "https://api.example.com/tools/summarize", method: "POST", body: { text: "hello" } },
      output: {
        example: {
          url: "https://api.example.com/tools/summarize",
          method: "POST",
          checkedAt: "2026-09-11T02:00:00.000Z",
          payable: true,
          unpaidCall: { status: 402, contentType: "application/json", error: null, ms: 180, bodySlice: "{}" },
          challenge: { readable: true, networks: ["eip155:8453"], priceUsd: 0.01, payTo: "0x…", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", pricedFrom: "eip155:8453", accepts: [] },
          domainFindings: [{ network: "eip155:8453", verdict: "matches", advertisedName: "USD Coin", expectedName: "USD Coin", chain: "Base" }],
          payment: { attempted: true, status: 200, settled: true, error: null, ms: 2400, receipt: { network: "eip155:8453", payer: "0x…", transaction: "0x…", success: true } },
          responseSlice: "{\"summary\":\"…\"}",
          flags: ["a stock buyer can pay this endpoint and get a result: nothing to fix"],
        },
      },
    },
    handler,
  };
}
