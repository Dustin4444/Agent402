// Chain truth for the EIP-712 domain of each USDC we can pay or list, and the
// verdict on what a seller's 402 advertises against it.
//
// WHY. An x402 exact/EVM payment is an EIP-3009 authorization signed under the
// TOKEN's own EIP-712 domain, and a stock client (@x402/evm, and ours through
// it) signs under whatever `extra.name` the seller's accept carries. Circle's
// deployments do not share one name: Base, Polygon, Arbitrum, Avalanche and
// Optimism USDC are "USD Coin"; Monad, Celo and Sei USDC are "USDC" (every one
// verified on chain, see src/payments.js). A seller who copies "USDC" onto a
// Base accept publishes a challenge NO stock buyer can pay: the signature
// recovers to nobody, the facilitator answers invalid_payload, nothing settles
// - and the seller reads as "healthy, zero external settlements".
//
// Measured: a live seller's 39-endpoint catalog (2026-08-07, the fixture in
// test-x402-live-quote) and HumanMirror (2026-09-10, proven with the external
// seller probe: $0.01 cap, refused, zero inbound USDC on their payTo). The
// buyer-side twin (an AgentCore signer hardcoding "USDC" against our own Base
// accept) lives in src/mpp-evm-domain.js; this module is the SELLER side, read
// from the accept alone, no signature needed.
//
// Dependency-free on purpose: the index, the router label and the buyer all
// read it, and none of them should pull the payment stack in to ask a
// question about a string.

/** Mainnet USDC per CAIP-2 network: contract + the EIP-712 domain name it
 *  signs under. Addresses lower-cased for comparison. The names are pinned
 *  against src/payments.js (the money parsers) and @x402/evm's registry by
 *  scripts/test-evm-usdc-domain.js, so this table cannot drift from what the
 *  paywall itself advertises. */
export const USDC_DOMAIN_BY_NETWORK = Object.freeze({
  "eip155:8453": Object.freeze({ chain: "Base", asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", name: "USD Coin", version: "2" }),
  "eip155:137": Object.freeze({ chain: "Polygon", asset: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", name: "USD Coin", version: "2" }),
  "eip155:42161": Object.freeze({ chain: "Arbitrum", asset: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", name: "USD Coin", version: "2" }),
  "eip155:143": Object.freeze({ chain: "Monad", asset: "0x754704bc059f8c67012fed69bc8a327a5aafb603", name: "USDC", version: "2" }),
  "eip155:42220": Object.freeze({ chain: "Celo", asset: "0xceba9300f2b948710d2653dd7b07f33a8b32118c", name: "USDC", version: "2" }),
  "eip155:43114": Object.freeze({ chain: "Avalanche", asset: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", name: "USD Coin", version: "2" }),
  "eip155:1329": Object.freeze({ chain: "Sei", asset: "0xe15fc38f6d8c56af07bbcbe3baf5708a2bf42392", name: "USDC", version: "2" }),
  "eip155:10": Object.freeze({ chain: "Optimism", asset: "0x0b2c639c533813f4aa9d7837caf62653d097ff85", name: "USD Coin", version: "2" }),
});

const lc = (s) => (typeof s === "string" ? s.trim().toLowerCase() : "");

/**
 * What a seller's EVM accept advertises against the chain's own USDC domain.
 *
 * Refuses ONLY on a positive mismatch: the accept names the chain's USDC
 * contract AND carries a domain name that is not that contract's. Everything
 * else is "unknown" - a chain not in the table, a different asset (USDG, a
 * bridged USDC, a seller's own token), or no name at all (the client's
 * registry then supplies the default, which is right on every chain listed).
 *
 * @param {object} accept  an x402 accepts entry ({network, asset, extra:{name}})
 *                         or the index's observation ({asset, name}) with `network`
 * @returns {{verdict:"matches"|"wrong_domain"|"unknown", expectedName?:string, advertisedName?:string, chain?:string}}
 */
export function usdcDomainVerdict(accept, network = accept?.network) {
  const truth = USDC_DOMAIN_BY_NETWORK[String(network || "")];
  if (!truth) return { verdict: "unknown" };
  if (lc(accept?.asset) !== truth.asset) return { verdict: "unknown" };
  const advertised = typeof accept?.name === "string" ? accept.name : accept?.extra?.name;
  if (typeof advertised !== "string" || !advertised.trim()) return { verdict: "unknown" };
  if (lc(advertised) === lc(truth.name)) return { verdict: "matches", expectedName: truth.name, chain: truth.chain };
  return { verdict: "wrong_domain", expectedName: truth.name, advertisedName: advertised.trim().slice(0, 40), chain: truth.chain };
}

/** The domain each EVM accept advertises, keyed by network - what the index
 *  stores beside payToByNetwork so the label and the router can read it later
 *  without the 402. First accept per network wins (a seller that offers two
 *  entries on one chain is priced from the first anyway). Bounded strings. */
export function evmDomainsOfAccepts(accepts) {
  const out = {};
  for (const a of Array.isArray(accepts) ? accepts : []) {
    const net = typeof a?.network === "string" ? a.network : "";
    if (!net.startsWith("eip155:") || out[net]) continue;
    const asset = typeof a?.asset === "string" ? a.asset.trim().slice(0, 42) : "";
    const name = typeof a?.extra?.name === "string" ? a.extra.name.trim().slice(0, 40) : "";
    if (!asset || !name) continue;
    out[net] = { asset, name };
  }
  return out;
}

/** One sentence for a wrong_domain verdict, written for the seller who has to fix it. */
export function usdcDomainMismatchDetail({ advertisedName, expectedName, chain } = {}) {
  return `the ${chain || "chain"} USDC accept advertises extra.name ${JSON.stringify(advertisedName)} but that token signs under ${JSON.stringify(expectedName)}, so every stock x402 buyer (this router included) produces a signature the facilitator refuses and nothing settles`;
}
