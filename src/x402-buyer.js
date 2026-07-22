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
import { assertPublicUrl, ssrfDispatcher } from "./tools/fetch-guard.js";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

const UPSTREAM_CHAIN = "eip155:8453"; // Base (CAIP-2) — where our spending wallet holds USDC
// x402 v1 accepts label the network as a bare string ("base") not CAIP-2, and v2
// uses "eip155:8453"; a seller may advertise either. Accept both Base labels —
// the mainnet-USDC asset pin below is what actually enforces the chain (that
// contract only exists on Base MAINNET, so a testnet/other-chain entry can't
// match even if it borrows a "base"-ish label).
const BASE_NETWORK_LABELS = new Set(["eip155:8453", "base", "base-mainnet"]);
// Circle USDC on Base — the ONLY asset our spending wallet holds and will pay.
// The margin guard pins the accept to this asset so a seller can't quote a
// cheap decoy in USDC and get us to sign an expensive one in another token.
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
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

// Pre-payment read (bare 200 = free tool, no spend yet): a bad body can throw
// safely because nothing was paid.
async function readCapped(res, maxBytes) {
  const text = await res.text();
  if (text.length > maxBytes) throw bad("Upstream response exceeded the size cap", 502);
  try { return JSON.parse(text); } catch { throw bad("Upstream returned non-JSON", 502); }
}
// F3: POST-payment read. Once we've spent, throwing a 4xx/5xx would cancel the
// BUYER's settlement (@x402/express settles after the handler) — so we'd pay
// and not get paid, a forced free-drain when the attacker owns both seller and
// buyer. So NEVER throw here: oversize → truncated, non-JSON → wrapped string.
// The buyer gets a 200 (is charged, covering our spend) with a best-effort body.
export async function readAfterSpend(res, maxBytes) {
  let text;
  try { text = await res.text(); } catch { return { relayError: "upstream body unreadable" }; }
  const truncated = text.length > maxBytes;
  const body = truncated ? text.slice(0, maxBytes) : text;
  try { const j = JSON.parse(body); return truncated ? { ...(j && typeof j === "object" && !Array.isArray(j) ? j : { value: j }), _truncated: true } : j; }
  catch { return { raw: body.slice(0, 4000), ...(truncated ? { _truncated: true } : {}) }; }
}

// F3 belt: bound external spend per rolling window regardless of buyer
// settlement, so a forced-cancellation drain can't be farmed even before the
// low hot-wallet balance runs out. Per-process; Date.now() is fine server-side.
const SPEND_WINDOW_MS = 60_000;
const SPEND_CAP_ATOMIC = BigInt(process.env.SOR_SPEND_CAP_ATOMIC || "2000000"); // $2/min default
let spendWindowStart = 0, spentThisWindow = 0n;
// Reserve budget BEFORE signing (holds it against concurrent calls in the same
// tick), returning a window token. If the spend then never happens (sign throws,
// paid leg errors/times out, non-200) the caller releases the hold so a seller
// that reliably fails the paid leg can't inflate the counter into false 429s
// for everyone (self-DoS). Refund only within the SAME window — a rolled window
// already zeroed the counter.
export function reserveSpend(atomic) {
  const now = Date.now();
  if (now - spendWindowStart > SPEND_WINDOW_MS) { spendWindowStart = now; spentThisWindow = 0n; }
  const amt = BigInt(atomic);
  if (spentThisWindow + amt > SPEND_CAP_ATOMIC) throw bad("Upstream spend budget for this window is exhausted — try again shortly", 429);
  spentThisWindow += amt;
  return spendWindowStart; // token: identifies the window this hold belongs to
}
export function releaseSpend(atomic, token) {
  if (token !== spendWindowStart) return; // window rolled — the hold is already gone
  const amt = BigInt(atomic);
  spentThisWindow = spentThisWindow > amt ? spentThisWindow - amt : 0n;
}
export function _spentThisWindow() { return spentThisWindow; } // test hook

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
  // A GET/HEAD with a body is refused by undici with a message that reads as
  // "seller unreachable" — fail it loudly as OUR bug instead. Callers convert
  // params to query strings for GET sellers (route-execute does).
  if (body !== undefined && (method === "GET" || method === "HEAD")) {
    throw bad(`payX402: ${method} request cannot carry a body — pass params in the URL`, 400);
  }
  const { client, http } = await getUpstreamBuyer();
  const reqInit = {
    method,
    headers: { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    // F1: pin every connection to the validated IP and re-validate each redirect
    // hop (ssrfDispatcher) — a one-shot assertPublicUrl is TOCTOU-rebindable and
    // wouldn't re-check a redirect target. redirect:"manual" + reject any 3xx so
    // a public seller can't 302 us onto an internal host (which would relay
    // internal data or forward our signed X-PAYMENT header).
    dispatcher: ssrfDispatcher,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  };
  const reject3xx = (r) => { if (r.status >= 300 && r.status < 400) throw bad("Seller returned a redirect — refusing to follow off the validated host", 502); };
  let bare;
  try { bare = await fetch(url, reqInit); }
  catch (e) { throw bad(`Seller unreachable: ${String(e?.message || e).slice(0, 80)}`, 502); }
  reject3xx(bare);
  if (bare.status === 200) return { result: await readCapped(bare, maxBytes), quote: null, receipt: null };
  if (bare.status === 404) throw bad("Seller returned 404 for that request", 404);
  if (bare.status !== 402) throw bad(`Seller upstream error (HTTP ${bare.status})`, 502);

  let paymentRequired;
  try {
    const bareBody = await bare.json().catch(() => undefined);
    paymentRequired = http.getPaymentRequiredResponse((n) => bare.headers.get(n), bareBody);
  } catch { throw bad("Seller sent an unparseable 402 challenge", 502); }

  // F2: pin to the EXACT accept the client will actually sign — Base + scheme
  // "exact" + Circle USDC — and cap-check THAT entry, not a decoy accepts[0].
  // A seller can't slip a cheap non-exact/other-asset decoy first and an
  // expensive exact/USDC entry behind it: we hand the client a single validated
  // accept, so what we cap-check is what we sign.
  const payable = (paymentRequired.accepts || []).find((a) =>
    BASE_NETWORK_LABELS.has(String(a.network || "").toLowerCase()) &&
    String(a.scheme || "exact") === "exact" &&
    String(a.asset || "").toLowerCase() === USDC_BASE
  );
  if (!payable) throw bad("Seller offers no Base/exact/USDC accept — cannot pay from the Base USDC spending wallet", 502);
  const quotedAtomic = payable.amount ?? payable.maxAmountRequired;
  if (!quoteWithinCap(quotedAtomic, maxAtomic)) {
    throw bad(`Seller quote ${quotedAtomic} atomic exceeds the ${maxAtomic} cap — refusing to pay`, 402);
  }
  const spendToken = reserveSpend(quotedAtomic); // F3 belt — before signing (throws 429 if over the window budget)
  let committed = false;
  try {
    const payload = await client.createPaymentPayload({ ...paymentRequired, accepts: [payable] });
    const payHeaders = http.encodePaymentSignatureHeader(payload);
    // Fresh timeout for the paid leg — it must not inherit the bare leg's
    // already-spent budget from the shared reqInit.signal.
    const paid = await fetch(url, { ...reqInit, signal: AbortSignal.timeout(timeoutMs), headers: { ...reqInit.headers, ...payHeaders, "Access-Control-Expose-Headers": "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE" } });
    // ANY seen response (2xx/3xx/4xx/5xx) means the signed X-PAYMENT header
    // reached the seller and the authorization may have been broadcast — keep
    // the spend hold. We only refund when the paid leg never got a response
    // (sign threw, or the fetch rejected on network error / timeout).
    committed = true;
    // A 3xx/non-200 residual (paid, no deliverable result) is inherent to
    // spend-before-settle; bounded by the window budget + low wallet balance.
    reject3xx(paid);
    if (paid.status !== 200) throw bad(`Seller rejected the paid retry (HTTP ${paid.status})`, 502);

    // Pull the settle tx out of the receipt header for our own receipt.
    let tx = null, net = null;
    const receiptHdr = paid.headers.get("payment-response") || paid.headers.get("x-payment-response");
    if (receiptHdr) {
      try { const r = JSON.parse(Buffer.from(receiptHdr, "base64").toString("utf8")); tx = r?.transaction || null; net = r?.network || null; } catch { /* best-effort */ }
    }
    return {
      // F3: post-spend read never throws — the buyer must be charged (we paid).
      result: await readAfterSpend(paid, maxBytes),
      quote: { atomic: String(quotedAtomic), usd: Number(quotedAtomic) / 1e6, network: UPSTREAM_CHAIN },
      receipt: { transaction: tx, network: net },
    };
  } finally {
    // Refund the hold ONLY when no payment authorization could have gone out:
    // createPaymentPayload threw, or the paid fetch rejected before we saw a
    // response (network error / timeout). A seen response (any status) leaves
    // committed=true so the hold stands.
    if (!committed) releaseSpend(quotedAtomic, spendToken);
  }
}
