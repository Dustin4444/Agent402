/**
 * Extract the verified payer wallet address from the x402 payment header.
 * The payment middleware has already verified the signature before any
 * route handler runs, so the `from` address here is cryptographically bound
 * to the payment — the wallet IS the account.
 *
 * We read ONLY `payload.payload.authorization.from` — the exact field the
 * EIP-3009 transferWithAuthorization signature the middleware verified covers.
 * Loose fallbacks (top-level `from`, `permit.owner`, etc.) are deliberately
 * NOT accepted: an unsigned field there could attribute a verified payment to a
 * different wallet, letting a caller act under a victim's memory namespace.
 */
// EVM 0x+40hex (normalized lowercase), Solana base58 (case-sensitive),
// Stellar G+55 base32, Algorand base32 (58 chars, case-sensitive) — anything
// else is not a wallet we can attribute.
export function normalizePayerAddress(from) {
  if (typeof from !== "string" || !from) return null;
  if (/^0x[0-9a-fA-F]{40}$/.test(from)) return from.toLowerCase();
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(from)) return from; // Solana base58
  if (/^G[A-Z2-7]{55}$/.test(from)) return from; // Stellar ed25519 public key
  if (/^[A-Z2-7]{58}$/.test(from)) return from; // Algorand ed25519 public key — NEVER lowercase
  return null;
}

/**
 * Fallback attribution from the facilitator's settle receipt: the x402 v2
 * SettleResponse carries `payer` — the wallet the facilitator VERIFIED and
 * settled from — on every chain, including the SVM and Stellar schemes whose
 * request payloads don't carry an EIP-3009 authorization.from. Telemetry and
 * sales attribution only: memory identity keeps payerFromRequest, whose
 * signature binding is what the namespace security model relies on.
 */
export function payerFromPaymentResponse(headerValue) {
  if (typeof headerValue !== "string" || !headerValue) return null;
  try {
    const receipt = JSON.parse(Buffer.from(headerValue, "base64").toString("utf-8"));
    return normalizePayerAddress(receipt?.payer);
  } catch {
    return null;
  }
}

export function payerFromRequest(req) {
  // x402 v2 clients send the authorization in `X-PAYMENT` (what @x402/fetch and
  // the middleware use); `payment-signature` is the legacy name. Read X-PAYMENT
  // first so real buyers aren't silently attributed to null — every other
  // consumer (replay-guard, the gate) already reads both.
  const header = req.header("x-payment") || req.header("payment-signature");
  if (!header) return null;
  try {
    const payload = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
    const from = payload?.payload?.authorization?.from || null;
    if (typeof from !== "string") return null;
    // EVM ONLY, deliberately: this `from` is covered by the EIP-3009 signature
    // the facilitator verifies before settlement, so it can carry memory
    // identity. Non-EVM schemes (AVM/SVM/Stellar) don't sign an
    // authorization.from — accepting one here would let a buyer mint a
    // signature-free namespace. Their attribution path is
    // payerFromPaymentResponse (the facilitator-verified settle receipt).
    if (/^0x[0-9a-fA-F]{40}$/.test(from)) return from.toLowerCase();
    return null;
  } catch {
    return null;
  }
}
