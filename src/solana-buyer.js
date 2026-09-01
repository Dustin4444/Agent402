// External buying on Solana - the SVM counterpart of the AVM/Tempo spending
// paths. route-execute pays a PROVEN external Solana seller from a DEDICATED
// SVM spending hot wallet (SOLANA_UPSTREAM_BUYER_KEY - never the treasury,
// never the CI burner), chain-matched: a buyer who paid us on Solana funds a
// purchase on Solana. Everything here is env-gated: with no key configured,
// Solana external routing is simply not offered (the Algorand pattern).
//
// Signing rides the same stack the daily paid canary has proven against our
// own routes since July: @x402/svm exact scheme + @solana/kit keypair signer.
//
// PROOF GATE (the Tempo lesson, applied to Solana): discovery ranks a
// candidate, but the address that gets paid is only known from the live 402,
// so proven-ness is enforced AT PAY TIME against the accept we are about to
// sign - recent inbound USDC transfers on Solana to that payTo's own token
// account, read from the chain, failing CLOSED on any RPC error. A seller
// nobody pays is not routable, whatever a registry says.

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const SOLANA_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
// Devnet's genesis hash is a DIFFERENT CAIP-2 suffix - an accept labeled
// solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1... must never match mainnet.
export const SOLANA_NETWORK_LABELS = new Set([
  SOLANA_CAIP2.toLowerCase(),
  "solana",
  "solana-mainnet",
  "solana-mainnet-beta",
]);

const RPC_URL = () => (process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com").trim();

const bad = (msg, statusCode) => Object.assign(new Error(msg), { statusCode });

/** True when the DEDICATED Solana spending wallet is configured - the gate
 *  route-execute uses to advertise/refuse Solana external routing. */
export function svmBuyerConfigured() {
  return !!(process.env.SOLANA_UPSTREAM_BUYER_KEY || "").trim();
}

let svmBuyerPromise = null;
/** Lazy singleton x402 client signing Solana payments with the dedicated SVM
 *  spending wallet. Key format matches the canary's: a base58 secret key or a
 *  JSON byte array. */
export async function getUpstreamBuyerSvm() {
  const raw = (process.env.SOLANA_UPSTREAM_BUYER_KEY || "").trim();
  if (!raw) throw bad("Solana upstream buyer wallet not configured (SOLANA_UPSTREAM_BUYER_KEY) - this path pays a Solana x402 seller and cannot run without a funded SVM spending wallet", 503);
  svmBuyerPromise ??= (async () => {
    const [{ x402Client, x402HTTPClient }, { ExactSvmScheme }, kit] = await Promise.all([
      import("@x402/core/client"), import("@x402/svm/exact/client"), import("@solana/kit"),
    ]);
    const bytes = raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : new Uint8Array(kit.getBase58Encoder().encode(raw));
    const signer = await kit.createKeyPairSignerFromBytes(bytes);
    const client = new x402Client();
    // Registered by hand rather than via registerExactSvmScheme so the scheme
    // reads OUR RPC (SOLANA_RPC_URL) for mint metadata instead of the
    // library's hardcoded default - and so an offline test can point it at a
    // stub RPC. The accept's extra.recentBlockhash (which real facilitator
    // 402s carry) means signing then needs no blockhash fetch at all.
    client.register("solana:*", new ExactSvmScheme(signer, { rpcUrl: RPC_URL() }));
    return { client, http: new x402HTTPClient(client), address: signer.address };
  })();
  return svmBuyerPromise;
}

/** One JSON-RPC call against the Solana mainnet RPC. Injectable for tests. */
async function rpcCall(method, params, { fetchImpl = fetch, timeoutMs = 6000 } = {}) {
  const res = await fetchImpl(RPC_URL(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Solana RPC HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`Solana RPC error: ${String(body.error.message || body.error.code).slice(0, 120)}`);
  return body.result;
}

/**
 * Recent inbound-USDC evidence for a seller payTo: how many signatures touched
 * the seller's own USDC token account inside the window. Two reads, no PDA
 * math - the token account's address comes from the chain itself
 * (getTokenAccountsByOwner), so a seller with NO USDC account scores 0 rather
 * than erroring. Throws on RPC failure - the CALLER treats that as refusal
 * (fail closed), never as zero-is-fine or unknown-is-proven.
 */
export async function solanaInboundCount(payTo, { windowMs = 15 * 3600 * 1000, limit = 100, fetchImpl = fetch } = {}) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(payTo || ""))) throw new Error("payTo is not a plausible Solana address");
  const accounts = await rpcCall("getTokenAccountsByOwner", [payTo, { mint: USDC_MINT }, { encoding: "jsonParsed" }], { fetchImpl });
  const ata = accounts?.value?.[0]?.pubkey;
  if (!ata) return 0; // no USDC account = nobody has ever paid this address USDC
  const sigs = await rpcCall("getSignaturesForAddress", [ata, { limit }], { fetchImpl });
  const cutoff = (Date.now() - windowMs) / 1000;
  return (sigs || []).filter((s) => !s.err && Number(s.blockTime || 0) >= cutoff).length;
}

/**
 * The pay-time proven-seller gate. Floor defaults to the router's global
 * SOR_MIN_SETTLED_TX doctrine (env SOR_SVM_MIN_SETTLED_TX overrides for this
 * rail alone). Fails CLOSED: an unreadable chain refuses the spend with a 503
 * the buyer is never charged for, exactly like the Tempo gate.
 */
export async function assertProvenSolanaSeller(payTo, { minCount = Number(process.env.SOR_SVM_MIN_SETTLED_TX || process.env.SOR_MIN_SETTLED_TX || "20"), inboundFn = solanaInboundCount } = {}) {
  let inbound;
  try { inbound = await inboundFn(payTo); }
  catch (e) { throw bad(`Cannot verify seller settlement history on Solana (${String(e?.message || e).slice(0, 80)}) - refusing to spend`, 503); }
  if (inbound < minCount) {
    throw bad(`Seller payTo ${String(payTo).slice(0, 8)}… has ${inbound} recent inbound USDC transfers on Solana (floor ${minCount}) - not routable yet`, 409);
  }
  return inbound;
}

/** Bucketed SVM spending-wallet status for /api/gateway-status - the
 *  upstreamBuyerAvm pattern. Numbers never leave the server. */
export async function svmBuyerStatus({ fetchImpl = fetch } = {}) {
  if (!svmBuyerConfigured()) return { status: "unconfigured" };
  try {
    const { address } = await getUpstreamBuyerSvm();
    const accounts = await rpcCall("getTokenAccountsByOwner", [address, { mint: USDC_MINT }, { encoding: "jsonParsed" }], { fetchImpl });
    const usd = Number(accounts?.value?.[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0);
    const low = Number(process.env.SOLANA_UPSTREAM_BUYER_LOW_USD || "0.5");
    return { status: usd < low ? "low" : "ok", asset: "USDC", chain: SOLANA_CAIP2 };
  } catch {
    return { status: "unknown", asset: "USDC", chain: SOLANA_CAIP2 };
  }
}
