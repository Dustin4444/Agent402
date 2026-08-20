// Tempo settlement confirmation — the stellar-confirm doctrine on the MPP
// rail: VERIFICATION, NEVER A RE-BROADCAST. Built 2026-08-20 after a live
// incident: the Tempo relay's /v1/mpp/broadcast reported
// `invalid_payment: "Broadcast transaction hash does not match the signed
// transaction"` for TWO payments that had both SETTLED on-chain
// (0xbb2e11e3… and 0x753f5655…, AgentCore/Privy buyer) — the buyer was told
// 402, retried, and was charged twice. Mechanism: the buyer's packed
// signature ends with a yParity-style v byte (0x00/0x01); the node accepts
// the transaction and stores the canonical 27/28 form, so the canonical
// txid no longer equals keccak(submitted bytes) and the relay's
// post-broadcast hash comparison fails a payment that landed.
//
// The fix exploits the same fact that makes the failure confusing: a txid
// commits to the ENTIRE signed transaction, so the credential's own bytes
// determine exactly which transaction could have landed — the submitted
// form and its v-normalized twin. Look those two receipts up on the chain;
// if one exists, succeeded, and carries the challenge's transfer
// (currency, recipient, >= amount), the payment settled and the buyer must
// be served, whatever the relay said. There is no time-window heuristic and
// no payer matching, so one buyer's genuine payment can never vouch for a
// DIFFERENT purchase (the Stellar deep-review lesson) — the binding is the
// transaction hash itself. Fails closed on every uncertainty: an RPC error,
// a missing receipt, a reverted transaction, a transfer that does not match
// the challenge — all return null and the original relay failure stands
// (buyer answered 402, exactly as before this module existed).
import { Credential } from "mppx";
import { keccak256, fromRlp } from "viem";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** The txids this signed transaction could have landed under: the submitted
 *  bytes, and (when the trailing byte is a recognisable v) the v-swapped
 *  twin — yParity (0/1) <-> legacy (27/28). Tempo's type-0x76 envelope ends
 *  with the 65-byte packed signature as its LAST RLP field, so the final
 *  byte of the whole envelope IS v; that is verified against the decoded
 *  RLP before any swap (a tx whose last field is not the packed signature
 *  gets only the identity candidate — never a blind byte edit). */
export function candidateTxIds(signedTx) {
  const out = [];
  const hex = String(signedTx || "").toLowerCase();
  if (!/^0x76[0-9a-f]{2,}$/.test(hex) || hex.length % 2 !== 0) return out;
  out.push(keccak256(hex));
  let fields;
  try { fields = fromRlp(`0x${hex.slice(4)}`, "hex"); } catch { return out; }
  const last = fields[fields.length - 1];
  const sigIsLast = typeof last === "string" && last.length === 2 + 65 * 2 && hex.endsWith(last.slice(2));
  if (!sigIsLast) return out;
  const swap = { "00": "1b", "01": "1c", "1b": "00", "1c": "01" }[hex.slice(-2)];
  if (swap) out.push(keccak256(hex.slice(0, -2) + swap));
  return out;
}

async function rpcCall(fetchImpl, rpcUrl, method, params) {
  const res = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`rpc ${method} HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`rpc ${method}: ${String(body.error.message || body.error.code)}`);
  return body.result;
}

/** Did this credential's transaction settle on-chain despite what the relay
 *  said? Returns { txId, amountAtomic } when a candidate receipt exists,
 *  succeeded, and pays the challenge's recipient at least the challenge's
 *  amount in the challenge's currency — else null. Polls briefly (the
 *  transaction may still be sitting in a block the RPC has not indexed when
 *  the relay answers). Never throws. */
export async function confirmTempoSettlement(authorizationHeader, {
  rpcUrl = process.env.TEMPO_RPC_URL || "https://rpc.tempo.xyz",
  fetchImpl = fetch,
  attempts = 4,
  delayMs = 2000,
} = {}) {
  try {
    const credential = Credential.deserialize(authorizationHeader);
    const ch = credential?.challenge;
    const payload = credential?.payload;
    if (!ch || ch.method !== "tempo" || payload?.type !== "transaction") return null;
    const r = ch.request || {};
    const currency = String(r.currency || "").toLowerCase();
    const recipient = String(r.recipient || "").toLowerCase();
    let minAmount;
    try { minAmount = BigInt(String(r.amount)); } catch { return null; }
    if (!currency.startsWith("0x") || !recipient.startsWith("0x") || !(minAmount > 0n)) return null;
    const candidates = candidateTxIds(payload.signature);
    if (!candidates.length) return null;

    for (let i = 0; i < attempts; i++) {
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      for (const txId of candidates) {
        let receipt;
        try { receipt = await rpcCall(fetchImpl, rpcUrl, "eth_getTransactionReceipt", [txId]); } catch { continue; }
        if (!receipt || receipt.status !== "0x1") continue;
        for (const log of receipt.logs || []) {
          if (String(log.address || "").toLowerCase() !== currency) continue;
          if ((log.topics || [])[0] !== TRANSFER_TOPIC) continue;
          const to = `0x${String(log.topics[2] || "").slice(-40)}`.toLowerCase();
          if (to !== recipient) continue;
          let value;
          try { value = BigInt(log.data); } catch { continue; }
          if (value >= minAmount) return { txId, amountAtomic: value };
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}
