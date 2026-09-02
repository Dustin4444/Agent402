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
import { recordUpstreamSpend } from "./stats.js";
import { provenPayToMatches } from "./settlement-proof.js";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// Per-chain buyer config. x402 v1 accepts label the network as a bare string
// ("base") not CAIP-2, and v2 uses CAIP-2; a seller may advertise either. The
// mainnet-USDC asset pin is what actually enforces the chain (that asset id
// only exists on the given MAINNET, so a testnet/other-chain entry can't match
// even if it borrows the label). Amounts are atomic 6dp on both chains (Circle
// USDC on Base and the USDC ASA on Algorand both have 6 decimals), so the
// margin guard and spend-window belt are chain-agnostic.
export const BUYER_CHAINS = {
  base: {
    caip2: "eip155:8453",
    networkLabels: new Set(["eip155:8453", "base", "base-mainnet"]),
    // Circle USDC on Base — the ONLY asset the EVM spending wallet holds and
    // will pay. Pinning the accept to it means a seller can't quote a cheap
    // decoy in USDC and get us to sign an expensive one in another token.
    asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  },
  algorand: {
    caip2: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
    networkLabels: new Set(["algorand:wghe2pwdvd7s12bl5faop20egyesn73ktic1qzkkit8=", "algorand", "algorand-mainnet"]),
    asset: "31566704", // USDC ASA on Algorand mainnet
  },
  solana: {
    caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    // Mainnet labels ONLY: devnet's genesis hash is a different CAIP-2 suffix
    // and must never match (paying a devnet accept with mainnet USDC signs a
    // transaction that can never settle).
    networkLabels: new Set(["solana:5eykt4usfv8p8njdtrepy1vzqkqzkvdp", "solana", "solana-mainnet", "solana-mainnet-beta"]),
    // Circle USDC mint on Solana mainnet. Base58 is case-sensitive; the
    // lowercase compare in pickPayableAccept stays a valid equality test
    // because both sides are folded the same way.
    asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  },
};
const DEFAULT_MAX_BYTES = 512 * 1024;

/** Pin the exact accept the client will sign for `chain` — right network label,
 *  scheme "exact", and the chain's mainnet USDC asset — or null. Pure; exported
 *  for offline tests (decoy-ordering and cross-chain confusion cases). */
export function pickPayableAccept(accepts, chain) {
  const cfg = BUYER_CHAINS[chain];
  if (!cfg) return null;
  return (accepts || []).find((a) =>
    cfg.networkLabels.has(String(a.network || "").toLowerCase()) &&
    String(a.scheme || "exact") === "exact" &&
    String(a.asset || "").toLowerCase() === cfg.asset.toLowerCase()
  ) || null;
}

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
  if (!pk) throw bad("Upstream buyer wallet not configured (X402_UPSTREAM_BUYER_KEY) - this path pays an upstream x402 seller and cannot run without a funded spending wallet", 503);
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

let avmBuyerPromise = null;
/** True when the DEDICATED Algorand spending wallet is configured — the gate
 *  route-execute uses to advertise/refuse Algorand external routing. */
export function avmBuyerConfigured() {
  return !!(process.env.ALGORAND_UPSTREAM_BUYER_MNEMONIC || "").trim();
}
/** Lazy singleton x402 client signing Algorand payments with the dedicated AVM
 *  spending wallet (ALGORAND_UPSTREAM_BUYER_MNEMONIC — a low-balance hot wallet
 *  opted in to the USDC ASA; NEVER the treasury or the CI burner). Signs with
 *  the protocol-max 1000-round validity window: external sellers settle AFTER
 *  their handler runs, so algokit's 10-round (~28s) default would make any
 *  slow seller a guaranteed dead-txn burn (the image-gen-premium lesson,
 *  sweep run 29974531159). algod rides the CF relay when configured — Nodely
 *  403s Railway's egress IP outright, so prod cannot reach the public bases. */
export async function getUpstreamBuyerAvm() {
  const mnemonic = (process.env.ALGORAND_UPSTREAM_BUYER_MNEMONIC || "").trim();
  if (!mnemonic) throw bad("Algorand upstream buyer wallet not configured (ALGORAND_UPSTREAM_BUYER_MNEMONIC) - this path pays an Algorand x402 seller and cannot run without a funded AVM spending wallet", 503);
  avmBuyerPromise ??= (async () => {
    const [{ x402Client, x402HTTPClient }, { ExactAvmScheme }, { toClientAvmSigner }, algosdk, { AlgorandClient }] = await Promise.all([
      import("@x402/core/client"), import("@x402/avm/exact/client"), import("@x402/avm"),
      import("algosdk").then((m) => m.default ?? m), import("@algorandfoundation/algokit-utils/algorand-client"),
    ]);
    const account = algosdk.mnemonicToSecretKey(mnemonic);
    const relayUrl = (process.env.ALGORAND_RELAY_URL || "").trim().replace(/\/+$/, "");
    const relayToken = (process.env.ALGORAND_RELAY_TOKEN || "").trim();
    const algodConfig = relayUrl && relayToken
      ? { server: `${relayUrl}/algod`, token: { Authorization: `Bearer ${relayToken}` } }
      : { server: (process.env.ALGORAND_ALGOD_URL || "https://mainnet-api.algonode.cloud").trim(), token: "" };
    const algorandClient = AlgorandClient.fromConfig({ algodConfig }).setDefaultValidityWindow(1000);
    const client = new x402Client();
    client.register("algorand:*", new ExactAvmScheme(toClientAvmSigner(Buffer.from(account.sk).toString("base64")), { algorandClient }));
    return { client, http: new x402HTTPClient(client), address: account.addr.toString() };
  })();
  return avmBuyerPromise;
}

// AVM spending-wallet balance status — the upstreamBuyerStatus pattern
// (blockscout-kit) applied to the Algorand hot wallet: when it runs dry,
// Algorand external routing fails 502s (buyers never charged) — the heartbeat
// alarms on "low" BEFORE that. Bucketed status only; the balance number never
// leaves the server. Also surfaces optedIn:false when the wallet has not
// opted in to the USDC ASA (settlement would fail on-chain — needs action).
const AVM_BUYER_LOW_USD = () => Number(process.env.ALGORAND_UPSTREAM_BUYER_LOW_USD || "0.5");
const AVM_STATUS_CACHE_MS = 5 * 60_000;
let avmStatusCache = null;
export async function avmBuyerStatus() {
  if (!avmBuyerConfigured()) return { configured: false, status: "unconfigured" };
  if (avmStatusCache && Date.now() - avmStatusCache.at < AVM_STATUS_CACHE_MS) return avmStatusCache.result;
  let result;
  try {
    const [algosdk, { ALGORAND_ALGOD_BASES, getJsonAcross }] = await Promise.all([
      import("algosdk").then((m) => m.default ?? m), import("./revenue-live.js"),
    ]);
    // A bad mnemonic is a CONFIG defect, not an RPC blip — name it so "unknown"
    // never hides it again (found 2026-07-23: a 24-word paste read as a silent
    // permanent "unknown", indistinguishable from a relay outage). The word
    // count is safe to log; the words never are.
    let address;
    try {
      address = algosdk.mnemonicToSecretKey((process.env.ALGORAND_UPSTREAM_BUYER_MNEMONIC || "").trim()).addr.toString();
    } catch {
      const words = (process.env.ALGORAND_UPSTREAM_BUYER_MNEMONIC || "").trim().split(/\s+/).filter(Boolean).length;
      console.error(`[avm-buyer] ALGORAND_UPSTREAM_BUYER_MNEMONIC does not decode (${words} words - Algorand mnemonics are 25)`);
      result = { configured: true, status: "unknown", reason: "mnemonic-invalid" };
      avmStatusCache = { at: Date.now(), result };
      return result;
    }
    // 404 = fresh unfunded account: real answer, not an error — balance 0.
    const { ok, status, json } = await getJsonAcross(ALGORAND_ALGOD_BASES, `/v2/accounts/${address}`, { okStatuses: [404] });
    if (!ok) {
      result = { configured: true, status: "unknown", reason: "rpc-unreachable" };
    } else if (status === 404) {
      result = { configured: true, status: "low", optedIn: false };
    } else {
      const asa = (json?.assets || []).find((a) => Number(a["asset-id"]) === 31566704);
      const usd = asa ? Number(asa.amount) / 1e6 : 0;
      result = {
        configured: true,
        status: !asa || usd < AVM_BUYER_LOW_USD() ? "low" : "ok",
        ...(asa ? {} : { optedIn: false }),
      };
    }
  } catch (e) {
    console.error(`[avm-buyer] status read failed: ${String(e?.message || e).slice(0, 120)}`);
    result = { configured: true, status: "unknown", reason: "rpc-unreachable" };
  }
  avmStatusCache = { at: Date.now(), result };
  return result;
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
// Sellers that REFUSED a payment we sent (402/401 on the paid retry, and the
// chain shows no debit). A seller whose verifier rejects stock x402 payments
// on a chain will reject the next one too, and while it ranks first every
// buyer's call spends one full 402 -> sign -> refuse round trip on it before
// the fallthrough reaches a seller that works (api.xfuel.app on Solana,
// 2026-09-02: the reference @x402/svm client got the same refusal). Keyed by
// origin + chain, TTL-bounded, size-bounded; consulted by the SOR resolver so
// the refused seller is skipped at resolve time, and forgotten after the TTL
// so a seller that fixes its rail is tried again without a redeploy.
const SELLER_REFUSAL_TTL_MS = Number(process.env.SOR_SELLER_REFUSAL_TTL_MS || 6 * 3600 * 1000);
const SELLER_REFUSAL_MAX = 500;
const sellerRefusals = new Map(); // "chain|origin" -> { at, status }
const refusalKey = (origin, chain) => `${chain}|${String(origin || "").toLowerCase().replace(/\/+$/, "")}`;
export function noteSellerRefusal(origin, chain, status) {
  if (!origin || !chain) return;
  if (sellerRefusals.size >= SELLER_REFUSAL_MAX) sellerRefusals.delete(sellerRefusals.keys().next().value);
  sellerRefusals.set(refusalKey(origin, chain), { at: Date.now(), status });
}
export function sellerRefusedRecently(origin, chain, now = Date.now()) {
  const hit = sellerRefusals.get(refusalKey(origin, chain));
  if (!hit) return null;
  if (now - hit.at > SELLER_REFUSAL_TTL_MS) { sellerRefusals.delete(refusalKey(origin, chain)); return null; }
  return hit;
}
export function __resetSellerRefusalsForTest() { sellerRefusals.clear(); }

export function reserveSpend(atomic) {
  const now = Date.now();
  if (now - spendWindowStart > SPEND_WINDOW_MS) { spendWindowStart = now; spentThisWindow = 0n; }
  const amt = BigInt(atomic);
  if (spentThisWindow + amt > SPEND_CAP_ATOMIC) throw bad("Upstream spend budget for this window is exhausted - try again shortly", 429);
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
export async function payX402(url, { maxAtomic, method = "GET", body, headers = {}, timeoutMs = 20000, maxBytes = DEFAULT_MAX_BYTES, trusted = false, chain = "base", provenPayTo = null, sellerProof = null, notDebited = null } = {}) {
  if (maxAtomic == null) throw bad("payX402 requires maxAtomic (the margin-guard ceiling)", 500);
  const chainCfg = BUYER_CHAINS[chain];
  if (!chainCfg) throw bad(`payX402: unknown chain "${chain}" (known: ${Object.keys(BUYER_CHAINS).join(", ")})`, 500);
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
    throw bad(`payX402: ${method} request cannot carry a body - pass params in the URL`, 400);
  }
  const buyer = chain === "algorand" ? await getUpstreamBuyerAvm()
    : chain === "solana" ? await (await import("./solana-buyer.js")).getUpstreamBuyerSvm()
    : await getUpstreamBuyer();
  const { client, http } = buyer;
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
  const reject3xx = (r) => { if (r.status >= 300 && r.status < 400) throw bad("Seller returned a redirect - refusing to follow off the validated host", 502); };
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

  // F2: pin to the EXACT accept the client will actually sign — the requested
  // chain + scheme "exact" + that chain's mainnet USDC asset — and cap-check
  // THAT entry, not a decoy accepts[0]. A seller can't slip a cheap non-exact/
  // other-asset decoy first and an expensive exact/USDC entry behind it: we
  // hand the client a single validated accept, so what we cap-check is what
  // we sign.
  const payable = pickPayableAccept(paymentRequired.accepts, chain);
  if (!payable) throw bad(`Seller offers no ${chain}/exact/USDC accept - cannot pay from the ${chain} spending wallet`, 502);
  const quotedAtomic = payable.amount ?? payable.maxAmountRequired;
  if (!quoteWithinCap(quotedAtomic, maxAtomic)) {
    throw bad(`Seller quote ${quotedAtomic} atomic exceeds the ${maxAtomic} cap - refusing to pay`, 402);
  }
  // THE ADDRESS THAT EARNED PROVEN-NESS MUST BE THE ADDRESS WE PAY.
  //
  // The router's reliability gate joins an origin's ADVERTISED payTo to
  // settlements we watched arrive on-chain, so the evidence is about an
  // address, never about the origin. Nothing in the wire stops a seller
  // advertising an address it does not own: name a heavily-settled wallet,
  // inherit its history, clear the gate, then ask for payment somewhere else.
  //
  // resolveExternalSeller already refuses a PROBE whose 402 names a different
  // address, but this is a second, independent request and the seller writes
  // both answers - so that check alone is defeated by anyone who reads it. This
  // one runs against `payable`, the single accept we are about to sign, for the
  // same reason F2 cap-checks that entry rather than accepts[0]: what we verify
  // has to be what we sign.
  //
  // Refuses ONLY on a positive mismatch. No address on record (a seller proven
  // by a source that cannot name one) and an unreadable payTo are both UNKNOWN,
  // and unknown must not block an honest seller - see provenPayToMatches.
  if (provenPayTo) {
    const verdict = provenPayToMatches({ provenPayTo, livePayTo: payable.payTo });
    if (verdict.verdict === "mismatch") {
      // Report the NORMALIZED addresses off the verdict, never the raw
      // `payable.payTo`. That string is written by the seller and this message
      // is relayed to the buyer (route-execute) and read by operators, so it
      // must not be an unbounded attacker-controlled span. Today the raw value
      // happens to be safe - a "mismatch" verdict is only reachable once the
      // address matched /^0x[0-9a-f]{40}$/ - but that is an invariant owned by
      // another module, and widening it there (a non-EVM rail is the obvious
      // reason to) would silently turn this line into an injection surface.
      // The verdict already vouches for what it returns, so use that.
      throw bad(
        `Refusing to pay ${verdict.livePayTo}: ${verdict.reason} (proven ${verdict.provenPayTo}). ` +
        `Nothing was signed.`,
        502,
      );
    }
  }
  // SOLANA PROVEN-SELLER GATE (pay time, fail closed - the Tempo lesson):
  // the address that gets paid is only authoritative on THIS 402's accept, so
  // the chain evidence is checked against `payable.payTo` right before
  // signing. sellerProof is injectable for offline tests; the default reads
  // mainnet. Non-Solana chains have their own gates (Base: settled/payers in
  // the resolver; Algorand: registry verifications; Tempo: payTempo's own).
  if (chain === "solana") {
    const { assertProvenSolanaSeller } = await import("./solana-buyer.js");
    await (sellerProof || assertProvenSolanaSeller)(payable.payTo);
  }
  const spendToken = reserveSpend(quotedAtomic); // F3 belt — before signing (throws 429 if over the window budget)
  let committed = false;
  try {
    // Normalize v1-style accepts before signing: sellers that quote ONLY via
    // maxAmountRequired (no `amount`) crash the scheme's BigInt(amount) with
    // "Cannot convert undefined to a BigInt" — hit live 2026-07-23 buying
    // Stelar's /telemetry. quotedAtomic already read either field; sign the
    // same value we cap-checked.
    const signable = { ...payable, amount: String(quotedAtomic) };
    // SOLANA: build the payload WITHOUT @x402/svm's scheme, whose kit RPC
    // transport throws undici "invalid content-length header" after any
    // custom-dispatcher (ssrf) seller fetch - see createSvmPaymentPayload.
    // Every other chain uses the registered scheme unchanged.
    const payload = chain === "solana"
      ? await (await import("./solana-buyer.js")).createSvmPaymentPayload(buyer.signer, { ...paymentRequired, accepts: [signable] })
      : await client.createPaymentPayload({ ...paymentRequired, accepts: [signable] });
    const payHeaders = http.encodePaymentSignatureHeader(payload);
    // Header-name compatibility: @x402/core emits only PAYMENT-SIGNATURE; some
    // sellers read only the X-PAYMENT name (Stelar, found 2026-07-23). Mirror
    // the identical value under both so either implementation sees the payment.
    if (payHeaders["PAYMENT-SIGNATURE"] && !payHeaders["X-PAYMENT"]) payHeaders["X-PAYMENT"] = payHeaders["PAYMENT-SIGNATURE"];
    // Fresh timeout AND a fresh pinned connection for the paid leg. The
    // timeout must not inherit the bare leg's spent budget, and the paid
    // retry must not reuse the bare leg's kept-alive socket: a live seller's
    // edge corrupts the connection after its 402 (2026-09-01, sol.blockrun -
    // the reused socket died as an uncaught "invalid content-length header"
    // inside undici, with our signed payment never delivered). guardedLookup
    // still pins the IP, so the SSRF discipline is unchanged.
    const { freshSsrfDispatcher } = await import("./tools/fetch-guard.js");
    const paidDispatcher = freshSsrfDispatcher();
    const paidHeaders = { ...reqInit.headers, ...payHeaders, "Access-Control-Expose-Headers": "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE" };
    // Wall-clock mark BEFORE the payment header leaves: the chain-truth check
    // after a refusal asks "did our wallet move since here".
    const sentAtUnix = Math.floor(Date.now() / 1000);
    let paid;
    try {
      paid = await fetch(url, { ...reqInit, dispatcher: paidDispatcher, signal: AbortSignal.timeout(timeoutMs), headers: paidHeaders });
    } catch (fetchErr) {
      // SELLER-EDGE COMPAT (measured live 2026-09-01, sol.blockrun.ai): their
      // edge emits response framing that undici's fetch() path rejects as
      // "invalid content-length header" through ANY explicit dispatcher, while
      // undici.request() on the SAME pinned agent reads it fine - and a plain
      // browser or default fetch also tolerates it. The signed payment was
      // never being delivered. Retry ONCE over request() with the SAME
      // dispatcher (same guardedLookup pin - SSRF discipline unchanged), with
      // a manually capped body read, and wrap the result as a Response so the
      // rest of this function cannot tell the difference. Only this exact
      // cause takes the fallback; every other failure still throws.
      const cause = String(fetchErr?.cause || "");
      if (!/invalid content-length/i.test(cause)) { paidDispatcher.close().catch(() => {}); throw fetchErr; }
      console.warn(`[x402-buyer] paid leg fell back to undici.request for ${(() => { try { return new URL(url).host; } catch { return "seller"; } })()} (fetch rejected: ${cause.slice(0, 80)})`);
      const { request } = await import("undici");
      const r = await request(url, {
        dispatcher: paidDispatcher,
        method,
        headers: paidHeaders,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
        maxRedirections: 0,
      });
      const chunks = []; let total = 0;
      for await (const c of r.body) {
        total += c.length;
        if (total > maxBytes) { r.body.destroy?.(); break; }
        chunks.push(c);
      }
      const flat = {};
      for (const [k, v] of Object.entries(r.headers)) flat[k] = Array.isArray(v) ? v.join(", ") : String(v);
      // Response refuses bodies on 204/304 and any status < 200; none of
      // those carries a deliverable paid result anyway.
      const bodyBuf = Buffer.concat(chunks);
      paid = new Response(r.statusCode >= 200 && ![204, 304].includes(r.statusCode) ? bodyBuf : null, { status: r.statusCode, headers: flat });
    } finally {
      // close() waits for in-flight bodies; never block the buy on teardown.
      paidDispatcher.close().catch(() => {});
    }
    // ANY seen response (2xx/3xx/4xx/5xx) means the signed X-PAYMENT header
    // reached the seller and the authorization may have been broadcast — keep
    // the spend hold. We only refund when the paid leg never got a response
    // (sign threw, or the fetch rejected on network error / timeout).
    committed = true;
    // Every throw from here on is POST-COMMIT: the signed authorization
    // reached the seller and MAY have been settled. Stamp committed on it so a
    // caller trying multiple sellers (route-execute's fallthrough) knows this
    // is NOT safe to retry elsewhere - we cannot prove we were not charged, so
    // a second seller would be a second, uncorrelated spend. Pre-commit throws
    // (unreachable, bad 402, cap, sign failure) never reach here and carry no
    // such flag, so those ARE safe to fall through on.
    try {
    // A 3xx/non-200 residual (paid, no deliverable result) is inherent to
    // spend-before-settle; bounded by the window budget + low wallet balance.
    reject3xx(paid);
    if (paid.status !== 200) {
      // Log WHY, because the status alone cannot distinguish "their backend
      // broke" from "they refused our payment" - and that distinction decides
      // whether we wait or fix something. Measured 2026-08-30: an upstream we
      // pay went 500 on every paid retry for two days and the only evidence we
      // had kept was the number 500. Same gap as the facilitator diagnostics,
      // where 200 characters of Cloudflare HTML hid an outage-vs-egress-block.
      //
      // Server-side ONLY. The buyer-facing message stays status-only: a
      // seller's error body is their text, and relaying it verbatim to our
      // buyers is the leak the 2026-08-19 review closed for the MPP relay.
      let why = "";
      try {
        const raw = (await paid.text()).slice(0, 400);
        why = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
      } catch { why = "(body unreadable)"; }
      const where = (() => { try { return new URL(url).host; } catch { return "seller"; } })();
      console.warn(`[x402-buyer] ${where} rejected the paid retry: HTTP ${paid.status} content-type=${paid.headers.get("content-type") || "-"} body=${why || "(empty)"}`);
      // A 402/401 on the PAID retry is the seller refusing the payment. Their
      // word alone is not proof we were not charged (they control the status
      // line), but on Solana the CHAIN is: if our wallet's USDC did not move
      // since the header went out, nothing settled, the hold is released and
      // the caller may try the next seller. An unreadable chain, or a debit,
      // keeps the post-commit stance. Base has no equivalent yet (an EIP-3009
      // nonce could be checked the same way; not built).
      if ((paid.status === 402 || paid.status === 401) && chain === "solana") {
        let verdict = null;
        try {
          const check = notDebited || (await import("./solana-buyer.js")).confirmSvmNotDebited;
          verdict = await check({ wallet: buyer.address, sinceUnix: sentAtUnix });
        } catch (e) {
          console.warn(`[x402-buyer] ${where}: refusal chain check unreadable (${String(e?.message || e).slice(0, 80)}) - keeping the hold`);
        }
        if (verdict && verdict.debited === false) {
          committed = false; // provably unpaid: the finally releases the hold
          const origin = (() => { try { return new URL(url).origin; } catch { return null; } })();
          noteSellerRefusal(origin, chain, paid.status);
          console.warn(`[x402-buyer] ${where} refused the payment and the chain shows no debit (${verdict.observed} tx read) - not charged, seller memoized as refusing on ${chain}`);
          const e = bad(`Seller refused the payment (HTTP ${paid.status}); chain shows no debit, nothing charged`, 502);
          e.refused = true;
          e.committed = false;
          throw e;
        }
      }
      throw bad(`Seller rejected the paid retry (HTTP ${paid.status})`, 502);
    }
    } catch (postCommitErr) {
      // `committed:false` is set ONLY by the chain-truth refusal path above,
      // after the wallet was read; every other post-commit throw is stamped
      // true, as before.
      if (postCommitErr && typeof postCommitErr === "object" && postCommitErr.committed !== false) postCommitErr.committed = true;
      throw postCommitErr;
    }

    // Pull the settle tx out of the receipt header for our own receipt.
    let tx = null, net = null;
    const receiptHdr = paid.headers.get("payment-response") || paid.headers.get("x-payment-response");
    if (receiptHdr) {
      try { const r = JSON.parse(Buffer.from(receiptHdr, "base64").toString("utf8")); tx = r?.transaction || null; net = r?.network || null; } catch { /* best-effort */ }
    }
    recordUpstreamSpend("x402-buyer", Number(quotedAtomic) / 1e6);
    return {
      // F3: post-spend read never throws — the buyer must be charged (we paid).
      result: await readAfterSpend(paid, maxBytes),
      quote: { atomic: String(quotedAtomic), usd: Number(quotedAtomic) / 1e6, network: chainCfg.caip2 },
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
