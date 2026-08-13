// Loads the facilitator's own Stellar signer and network config from the
// environment.
//
// NETWORK defaults to testnet and stays there unless FACILITATOR_NETWORK is
// set to the EXACT string "pubnet" - no fuzzy matching, no other value
// switches it. Mainnet is an explicit opt-in, never a default: this file
// used to hardcode testnet outright, and the same "fail closed to the safe
// value" intent carries forward now that mainnet is reachable at all.
//
// FACILITATOR_STELLAR_SECRET is a distinct name from STELLAR_FACILITATOR_KEY,
// which already means something else (a Bearer auth token for OpenZeppelin's
// channel service) in the main app's src/payments.js.
import { createEd25519Signer } from "@x402/stellar";

const WANTS_MAINNET = (process.env.FACILITATOR_NETWORK || "").trim() === "pubnet";

export const NETWORK = WANTS_MAINNET ? "stellar:pubnet" : "stellar:testnet";

// @x402/stellar ships a working default RPC for testnet but NONE for
// mainnet (confirmed in its own README - "Mainnet requires custom RPC URL").
// Fail loudly at startup rather than let ExactStellarScheme fail confusingly
// on the first request.
const MAINNET_RPC_URL = (process.env.FACILITATOR_MAINNET_RPC_URL || "").trim();
if (WANTS_MAINNET && !MAINNET_RPC_URL) {
  throw new Error(
    "FACILITATOR_NETWORK=pubnet requires FACILITATOR_MAINNET_RPC_URL - " +
    "@x402/stellar has no default mainnet RPC endpoint.",
  );
}
export const RPC_CONFIG = WANTS_MAINNET ? { url: MAINNET_RPC_URL } : undefined;

// Stellar StrKey secret seeds: "S" + 55 base32 chars (RFC 4648 alphabet,
// A-Z and 2-7 only - no 0/1/8/9, which is why this is stricter than a bare
// [A-Z0-9] check would be.
const SECRET_SEED_RE = /^S[A-Z2-7]{55}$/;

export function loadSigner() {
  const secret = (process.env.FACILITATOR_STELLAR_SECRET || "").trim();
  if (!secret) {
    throw new Error(
      WANTS_MAINNET
        ? "FACILITATOR_STELLAR_SECRET is not set. FACILITATOR_NETWORK=pubnet is set - this " +
          "must be a REAL, FUNDED mainnet secret seed. Never generate or fund this casually."
        : "FACILITATOR_STELLAR_SECRET is not set. Generate a testnet keypair, fund it via " +
          "https://friendbot.stellar.org, and set FACILITATOR_STELLAR_SECRET to its secret seed " +
          "(starts with 'S').",
    );
  }
  if (!SECRET_SEED_RE.test(secret)) {
    throw new Error("FACILITATOR_STELLAR_SECRET does not look like a valid Stellar secret seed.");
  }
  return createEd25519Signer(secret, NETWORK);
}
