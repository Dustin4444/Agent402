// Shared x402 BUYER primitive — the server acting as a paying client, first
// proven by blockscout-kit (buy Blockscout Pro data upstream) and reused by the
// Smart Order Router's external-execution path (pay any indexed x402 seller).
//
// One spending wallet (X402_UPSTREAM_BUYER_KEY) signs every outbound payment: a
// DEDICATED low-balance hot wallet, never the treasury or the CI burner. Its
// bucketed balance is surfaced for the heartbeat alarm (blockscout-kit's
// upstreamBuyerStatus). Every buy is a spend-BEFORE-our-settle: a failed buyer
// settlement can cost us the one upstream payment (the LLM-gateway risk class),
// so the margin guard below refuses any upstream quote over the caller's cap.
import { assertPublicUrl } from "./tools/fetch-guard.js";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

const UPSTREAM_CHAIN = "eip155:8453"; // Base — where our spending wallet holds USDC
const DEFAULT_MAX_BYTES = 512 * 1024;

/** True only for a well-formed atomic-USDC quote at or under `maxAtomic`.
 *  Strict digit-string first: BigInt("") is 0n, so a missing/empty quote would
 *  otherwise sail under the ceiling and sign a malformed payment. */
export function quoteWithinCap(amountAtomic, maxAtomic) {
  if (!/^\d+$/.test(String(amountAtomic ?? ""))) return false;
  try { return BigInt(amountAtomic) <= BigInt(maxAtomic); } catch { return false; }
}

let buyerPromise = null;
/** Lazy singleton x402 client signing with the dedicated spending wallet.
 *  Throws 503 (self-explaining) when X402_UPSTREAM_BUYER_KEY is unset, so a
 *  fresh clone never tries to pay upstream without a funded wallet. */
export async function getUpstreamBuyer() {
  const pk = (process.env.X402_UPSTREAM_BUYER_KEY || "").trim();
  if (!pk) throw bad("Upstream buyer wallet not configured (X402_UPSTREAM_BUYER_KEY) — this path pays an upstream x402 seller and cannot run without a funded spending wallet", 503);
  buyerPromise ??= (async () => {
    const [{ privateKeyToAccount }, { x402Client, x402HTTPClient }, { registerExactEvmScheme }] = await Promise.all([
      import("viem/accounts"), import("@x402/core/client"), import("@x402/evm/exact/client"),
    ]);
    const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
    const client = new x402Client();
    registerExactEvmScheme(client, { signer: account });
    return { client, http: new x402HTTPClient(client), address: account.address };
  })();
  return buyerPromise;
}

async function readCapped(res, maxBytes) {
  const text = await res.text();
  if (text.length > maxBytes) throw bad("Upstream response exceeded the size cap", 502);
  try { return JSON.parse(text); } catch { throw bad("Upstream returned non-JSON", 502); }
}

/**
 * Pay one x402 seller endpoint and return { result, quote, receipt }.
 *
 * @param url        the seller endpoint (http/https). SSRF-guarded via
 *                   assertPublicUrl unless {trusted:true} (a fixed first-party
 *                   allowlist like Blockscout's api host, verified by caller).
 * @param maxAtomic  hard ceiling on the upstream quote in atomic USDC (6dp) —
 *                   the margin guard. A quote above it fails 502, never signs.
 * @param method/body  request shape (POST body is a JSON-serializable object).
 * @param timeoutMs / maxBytes  bounds.
 *
 * A 200 on the bare request means the endpoint is free — returned with no
 * spend. Only a 402 triggers a payment; anything else is a 502.
 */
export async function payX402(url, { maxAtomic, method = "GET", body, headers = {}, timeoutMs = 20000, maxBytes = DEFAULT_MAX_BYTES, trusted = false } = {}) {
  if (maxAtomic == null) throw bad("payX402 requires maxAtomic (the margin-guard ceiling)", 500);
  if (!trusted) {
    // SSRF: paying an arbitrary URL with a real wallet is the same egress-abuse
    // risk as any fetch — resolve + pin to a public address before spending.
    try { await assertPublicUrl(url); }
    catch { throw bad("Seller URL resolves to a private/blocked address", 400); }
  }
  const { client, http } = await getUpstreamBuyer();
  const reqInit = {
    method,
    headers: { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  };
  let bare;
  try { bare = await fetch(url, reqInit); }
  catch (e) { throw bad(`Seller unreachable: ${String(e?.message || e).slice(0, 80)}`, 502); }
  if (bare.status === 200) return { result: await readCapped(bare, maxBytes), quote: null, receipt: null };
  if (bare.status === 404) throw bad("Seller returned 404 for that request", 404);
  if (bare.status !== 402) throw bad(`Seller upstream error (HTTP ${bare.status})`, 502);

  let paymentRequired;
  try {
    const bareBody = await bare.json().catch(() => undefined);
    paymentRequired = http.getPaymentRequiredResponse((n) => bare.headers.get(n), bareBody);
  } catch { throw bad("Seller sent an unparseable 402 challenge", 502); }

  // We can only pay on Base (that's where the spending wallet holds USDC).
  const accepts = (paymentRequired.accepts || []).filter((a) => String(a.network || "") === UPSTREAM_CHAIN);
  if (!accepts.length) throw bad("Seller does not offer Base settlement — cannot pay from the Base spending wallet", 502);
  const quotedAtomic = accepts[0].amount ?? accepts[0].maxAmountRequired;
  if (!quoteWithinCap(quotedAtomic, maxAtomic)) {
    throw bad(`Seller quote ${quotedAtomic} atomic exceeds the ${maxAtomic} cap — refusing to pay`, 402);
  }
  const payload = await client.createPaymentPayload({ ...paymentRequired, accepts });
  const payHeaders = http.encodePaymentSignatureHeader(payload);
  const paid = await fetch(url, { ...reqInit, headers: { ...reqInit.headers, ...payHeaders, "Access-Control-Expose-Headers": "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE" } });
  if (paid.status !== 200) throw bad(`Seller rejected the paid retry (HTTP ${paid.status})`, 502);

  // Pull the settle tx out of the receipt header for our own receipt.
  let tx = null, net = null;
  const receiptHdr = paid.headers.get("payment-response") || paid.headers.get("x-payment-response");
  if (receiptHdr) {
    try { const r = JSON.parse(Buffer.from(receiptHdr, "base64").toString("utf8")); tx = r?.transaction || null; net = r?.network || null; } catch { /* best-effort */ }
  }
  return {
    result: await readCapped(paid, maxBytes),
    quote: { atomic: String(quotedAtomic), usd: Number(quotedAtomic) / 1e6, network: UPSTREAM_CHAIN },
    receipt: { transaction: tx, network: net },
  };
}
