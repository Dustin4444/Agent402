// Loads the facilitator's own Stellar signer from the environment.
//
// NETWORK is hardcoded, not env-configurable — this is Phase 1, testnet only.
// There is deliberately no code path that can register "stellar:pubnet" here;
// that's a later phase with its own explicit go-ahead once this is proven
// correct against testnet.
//
// FACILITATOR_STELLAR_SECRET is a distinct name from STELLAR_FACILITATOR_KEY,
// which already means something else (a Bearer auth token for OpenZeppelin's
// channel service) in the main app's src/payments.js.
import { createEd25519Signer } from "@x402/stellar";

export const NETWORK = "stellar:testnet";

// Stellar StrKey secret seeds: "S" + 55 base32 chars (RFC 4648 alphabet,
// A-Z and 2-7 only - no 0/1/8/9, which is why this is stricter than a bare
// [A-Z0-9] check would be.
const SECRET_SEED_RE = /^S[A-Z2-7]{55}$/;

export function loadSigner() {
  const secret = (process.env.FACILITATOR_STELLAR_SECRET || "").trim();
  if (!secret) {
    throw new Error(
      "FACILITATOR_STELLAR_SECRET is not set. Generate a testnet keypair, fund it via " +
      "https://friendbot.stellar.org, and set FACILITATOR_STELLAR_SECRET to its secret seed " +
      "(starts with 'S'). This facilitator is testnet-only in Phase 1 - never put a mainnet " +
      "secret here.",
    );
  }
  if (!SECRET_SEED_RE.test(secret)) {
    throw new Error("FACILITATOR_STELLAR_SECRET does not look like a valid Stellar secret seed.");
  }
  return createEd25519Signer(secret, NETWORK);
}
