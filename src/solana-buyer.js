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
 * Recent VERIFIED-INBOUND-USDC evidence for a seller payTo: the number of
 * distinct funders who CREDITED the seller's own USDC token account inside the
 * window. It is not enough to count signatures on the account
 * (getSignaturesForAddress returns outbound and self-transfers too) - a seller
 * can manufacture ~20 self-transfers for a few cents of fees and look
 * "proven" (2026-09-01 security review). So each recent transaction is
 * inspected: the ATA's post-USDC balance must EXCEED its pre-balance (a
 * credit, not a debit or a no-op), and the payer must be someone OTHER than
 * the seller itself (self-transfers do not count). The evidence is the count
 * of DISTINCT such payers - the same "distinct wallets actually paid" signal
 * the Base rail's reliability gate uses, not raw activity.
 *
 * Bounded: getTransaction is called per signature but stops the moment the
 * floor is met (`stopAt`) or a hard fetch cap is hit, so a genuine seller
 * verifies in ~20-25 reads and a cold address gives up quickly. Throws on RPC
 * failure - the CALLER treats that as refusal (fail closed).
 */
export async function solanaInboundCount(payTo, { windowMs = 15 * 3600 * 1000, limit = 200, fetchImpl = fetch, stopAt = Infinity, maxTxReads = 120 } = {}) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(payTo || ""))) throw new Error("payTo is not a plausible Solana address");
  const accounts = await rpcCall("getTokenAccountsByOwner", [payTo, { mint: USDC_MINT }, { encoding: "jsonParsed" }], { fetchImpl });
  const ata = accounts?.value?.[0]?.pubkey;
  if (!ata) return 0; // no USDC account = nobody has ever paid this address USDC
  const sigs = await rpcCall("getSignaturesForAddress", [ata, { limit }], { fetchImpl });
  const cutoff = (Date.now() - windowMs) / 1000;
  const recent = (sigs || []).filter((sig) => !sig.err && Number(sig.blockTime || 0) >= cutoff).map((sig) => sig.signature);
  // Read transactions CONCURRENTLY in chunks - 20 sequential round-trips on a
  // slow public RPC blew the pay-path budget (503 fail-closed, 2026-09-01).
  // Between chunks, stop once the floor is met or the hard read cap is hit.
  const toRead = recent.slice(0, maxTxReads);
  const CHUNK = Number(process.env.SOR_SVM_TX_CONCURRENCY || "12");
  const readOne = (signature) =>
    rpcCall("getTransaction", [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }], { fetchImpl })
      .catch(() => null);                            // one unreadable tx is not fatal
  let credits = 0;
  for (let off = 0; off < toRead.length && credits < stopAt; off += CHUNK) {
    const batch = await Promise.all(toRead.slice(off, off + CHUNK).map(readOne));
    for (const tx of batch) {
    if (credits >= stopAt) break;
    const meta = tx?.meta;
    if (!meta || meta.err) continue;
    const pre = (meta.preTokenBalances || []).find((b) => b?.mint === USDC_MINT && b?.owner === payTo);
    const post = (meta.postTokenBalances || []).find((b) => b?.mint === USDC_MINT && b?.owner === payTo);
    const preAmt = Number(pre?.uiTokenAmount?.amount || 0);
    const postAmt = Number(post?.uiTokenAmount?.amount || 0);
    if (!(postAmt > preAmt)) continue;               // the seller's balance did NOT rise: outbound or no-op, not a payment received
    // SELF-TRANSFER DEFENCE. Some USDC account OTHER than the seller must be
    // the one debited, or this is the seller funding itself to fake volume
    // (the spoof the review flagged). On Solana x402 that debited account is
    // typically a shared FACILITATOR, not the buyer - so we count the CREDIT,
    // not distinct funders (distinct-funder collapses to 1 for a real,
    // facilitator-intermediated seller: measured 2026-09-01, sol.blockrun has
    // 49 buyers on x402scan but one on-chain sender). Residual: a seller with
    // a SECOND wallet can still fund payTo for ~$0.001/tx in fees; that costs
    // real money per fake and is bounded downstream by cap + the per-payer
    // spend ceiling. Closing it fully needs parsing the x402 buyer identity
    // from the payment instruction, deferred.
    const fundedByOther = (meta.preTokenBalances || []).some((b) => {
      if (b?.mint !== USDC_MINT || b?.owner === payTo) return false;
      const p2 = (meta.postTokenBalances || []).find((x) => x?.accountIndex === b.accountIndex);
      return Number(b?.uiTokenAmount?.amount || 0) > Number(p2?.uiTokenAmount?.amount || 0);
    });
    if (fundedByOther) credits++;
    }
  }
  return credits;
}

/**
 * The pay-time proven-seller gate. Floor defaults to the router's global
 * SOR_MIN_SETTLED_TX doctrine (env SOR_SVM_MIN_SETTLED_TX overrides for this
 * rail alone). Fails CLOSED: an unreadable chain refuses the spend with a 503
 * the buyer is never charged for, exactly like the Tempo gate.
 */
export async function assertProvenSolanaSeller(payTo, { minCount = Number(process.env.SOR_SVM_MIN_SETTLED_TX || process.env.SOR_MIN_SETTLED_TX || "20"), inboundFn = solanaInboundCount } = {}) {
  let inbound;
  try { inbound = await inboundFn(payTo, { stopAt: minCount }); }
  catch (e) { throw bad(`Cannot verify seller settlement history on Solana (${String(e?.message || e).slice(0, 80)}) - refusing to spend`, 503); }
  if (inbound < minCount) {
    throw bad(`Seller payTo ${String(payTo).slice(0, 8)}… has ${inbound} recent inbound USDC payments on Solana (floor ${minCount}) - not routable yet`, 409);
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

/**
 * Resolve-time twin of the pay-time gate, for the router's candidate loop: a
 * candidate whose live 402 names an UNPROVEN payTo is SKIPPED (the next
 * candidate gets tried) instead of aborting the whole call at pay time - the
 * first live proof run failed exactly that way, with an unproven seller
 * ranking above workable ones and the 409 taking the whole request down.
 * Parses the probe's own v2 402 header (v1 body as fallback); anything
 * unreadable or unproven is { ok:false, reason } - the caller logs and moves
 * on. The pay-time gate in payX402 stays: this reads the PROBE's 402, the
 * seller writes both answers, and what we verify last must be what we sign.
 */
export async function passesSolanaResolveGate({ header, body, inboundFn = solanaInboundCount, minCount = Number(process.env.SOR_SVM_MIN_SETTLED_TX || process.env.SOR_MIN_SETTLED_TX || "20") } = {}) {
  let payTo = null;
  try {
    const doc = header
      ? JSON.parse(Buffer.from(String(header), "base64").toString("utf8"))
      : JSON.parse(String(body || "{}"));
    const accept = (doc.accepts || []).find((a) => SOLANA_NETWORK_LABELS.has(String(a.network || "").toLowerCase()));
    payTo = accept?.payTo || null;
  } catch { /* unreadable challenge = not a candidate */ }
  if (!payTo) return { ok: false, payTo: null, reason: "no readable solana accept on the live 402" };
  let inbound;
  try { inbound = await inboundFn(payTo, { stopAt: minCount }); }
  catch (e) { return { ok: false, payTo, reason: `chain unreadable (${String(e?.message || e).slice(0, 60)})` }; }
  if (inbound < minCount) return { ok: false, payTo, reason: `${inbound} recent inbound USDC payments (floor ${minCount})` };
  return { ok: true, payTo, inbound };
}
