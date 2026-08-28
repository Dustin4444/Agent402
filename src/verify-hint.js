// A rejected payment answered in the buyer's language.
//
// Every verify failure in the logs this week read the same way to the buyer:
// "invalid_payload: contract call failed: unable to call contract: execution
// reverted". That is CDP simulating the USDC transferWithAuthorization and the
// transfer reverting - an empty wallet, or an authorization already spent or
// expired - and the buyers' clients answered it by retrying the same signed
// header ~400 times an hour (2026-08-26, 08-28). Nothing in that message tells
// an agent which of the two it is, so it cannot adapt. This module does the
// one thing the facilitator will not: read the payer's own USDC balance on
// Base (a public eth_call, cached a minute) and say plainly whether the wallet
// is short or the authorization is stale, on the 402 itself, with a
// machine-readable `retry` verb.
//
// Bounded: one RPC read per payer per minute, 3 s timeout, hint memory 5 min
// per payer, 2,000 payers; no balance leaves the process except to the payer
// who owns it (the hint goes only to a request carrying that payer's own
// signed authorization); telemetry gets a BUCKET, never an address.
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_RPC = () => process.env.AGENT402_BASE_RPC || "https://mainnet.base.org";
const BALANCE_TTL_MS = 60_000;
const HINT_TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 2_000;
const balances = new Map(); // payer -> { usd, at }
const hints = new Map();    // payer -> { hint, retry, balanceUsd, priceUsd, network, reason, at }

const bounded = (m) => { if (m.size > MAX_ENTRIES) { const first = m.keys().next().value; m.delete(first); } };

/** USDC balance of `address` on Base, in USD (6 decimals). null when unreadable. */
export async function usdcBalanceOnBase(address, { fetchImpl = fetch, rpcUrl = BASE_RPC(), now = Date.now } = {}) {
  const key = String(address || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(key)) return null;
  const c = balances.get(key);
  if (c && now() - c.at < BALANCE_TTL_MS) return c.usd;
  try {
    const data = "0x70a08231" + key.slice(2).padStart(64, "0"); // balanceOf(address)
    const res = await fetchImpl(rpcUrl, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: USDC_BASE, data }, "latest"] }),
      signal: AbortSignal.timeout(3_000),
    });
    const j = await res.json();
    if (typeof j?.result !== "string" || !/^0x[0-9a-fA-F]*$/.test(j.result)) return null;
    const usd = Number(BigInt(j.result || "0x0")) / 1e6;
    balances.set(key, { usd, at: now() }); bounded(balances);
    return usd;
  } catch { return null; }
}

/** Bucket for telemetry (never the number, never the address). */
export function balanceBucket(balanceUsd, priceUsd) {
  if (balanceUsd == null) return "unknown";
  if (balanceUsd <= 0) return "zero";
  if (Number.isFinite(priceUsd) && balanceUsd < priceUsd) return "under-price";
  return "covers-price";
}

/** The plain-language hint. Pure; exported for tests. */
export function hintFor({ reason, balanceUsd, priceUsd, network, payer }) {
  const r = String(reason || "");
  const price = Number.isFinite(priceUsd) ? `$${priceUsd.toFixed(priceUsd < 0.01 ? 4 : 3)}` : "the listed price";
  const short = payer ? `${payer.slice(0, 6)}...${payer.slice(-4)}` : "your wallet";
  const reverted = /execution reverted|contract call failed|insufficient|balance/i.test(r);
  if (reverted && balanceUsd != null && (balanceUsd <= 0 || (Number.isFinite(priceUsd) && balanceUsd < priceUsd))) {
    return {
      retry: "fund-wallet",
      hint: `${short} holds $${balanceUsd.toFixed(4)} USDC on Base and this call costs ${price}. Fund the wallet (or pay on another network listed in accepts), then sign a NEW authorization; re-sending this one will keep failing.`,
    };
  }
  if (reverted) {
    return {
      retry: "fresh-authorization",
      hint: `${short} covers ${price}, so the authorization itself was refused on-chain: its nonce was already spent or its validity window has passed. Never re-send a signed authorization; sign a fresh one for this request.`,
    };
  }
  if (/expired|validBefore|valid_before/i.test(r)) return { retry: "fresh-authorization", hint: "The authorization's validity window has passed. Sign a fresh one." };
  if (/nonce|already used|replay/i.test(r)) return { retry: "fresh-authorization", hint: "That authorization nonce was already used. Sign a fresh one; a settled call is never re-charged." };
  if (/network|unsupported|scheme/i.test(r)) return { retry: "other-network", hint: `Pay on a network listed in accepts${network ? ` (the header named ${network})` : ""}.` };
  return { retry: "fresh-authorization", hint: "The payment was refused before settlement. Sign a fresh authorization exactly matching one entry in accepts; nothing was charged." };
}

/** Called from the x402 onVerifyFailure hook. Reads the balance (bounded), remembers the hint for this payer. */
export async function noteVerifyFailure({ payer, network, reason, priceUsd, now = Date.now, balanceReader = usdcBalanceOnBase }) {
  const key = String(payer || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(key)) return null;
  const isBase = /^eip155:8453$/.test(String(network || ""));
  const balanceUsd = isBase ? await balanceReader(key) : null;
  const h = hintFor({ reason, balanceUsd, priceUsd, network, payer: key });
  const entry = { ...h, balanceUsd, priceUsd, network, reason: String(reason || "").slice(0, 200), at: now() };
  hints.set(key, entry); bounded(hints);
  return { ...entry, bucket: balanceBucket(balanceUsd, priceUsd) };
}

export function hintForPayer(payer, { now = Date.now } = {}) {
  const key = String(payer || "").toLowerCase();
  const h = hints.get(key);
  if (!h || now() - h.at > HINT_TTL_MS) return null;
  return h;
}

/** Express middleware: a 402 answered to a request that CARRIED a payment
 *  header gets the payer's hint merged into its JSON body (`error` and
 *  `accepts` untouched) and a Retry-After that slows a loop. Requests with
 *  no payment header, and every non-402, pass through byte-identical. */
export function verifyHintMiddleware({ payerOf }) {
  return function verifyHint(req, res, next) {
    if (!(req.headers["payment-signature"] || req.headers["x-payment"])) return next();
    const origJson = res.json.bind(res);
    res.json = function hintedJson(body) {
      if (res.statusCode === 402 && body && typeof body === "object" && !Array.isArray(body)) {
        let payer = null;
        try { payer = payerOf(req); } catch { payer = null; }
        const h = payer ? hintForPayer(payer) : null;
        if (h) {
          if (!res.headersSent) res.setHeader("Retry-After", h.retry === "fund-wallet" ? "60" : "5");
          return origJson({ ...body, hint: h.hint, retry: h.retry, ...(h.balanceUsd != null ? { payerUsdcOnBase: Number(h.balanceUsd.toFixed(6)) } : {}) });
        }
      }
      return origJson(body);
    };
    next();
  };
}

export const _testResetForTest = () => { balances.clear(); hints.clear(); };
