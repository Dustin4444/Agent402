// Per-request timeout on every Soroban RPC call the Stellar SDK makes.
//
// Why this exists: the 60s /settle bound in index.js is a LAST line - it
// fires after the caller (the x402 server's facilitator client, 30s by
// vendor default) has already given up, so from the caller's side a stalled
// RPC is indistinguishable from a dead facilitator, and the error body that
// would have carried `payer` (the hook the caller's chain-confirmation
// fallback needs) never arrives. Seen live twice in five days (2026-08-14,
// 2026-08-19): /verify answers in ~1s, then /settle stalls inside an RPC
// round-trip to the configured provider and nothing is ever submitted.
//
// The SDK's rpc.Server documents a `timeout` option but its constructor
// reads only `headers`, and @x402/stellar constructs a fresh rpc.Server
// internally per call (getRpcClient(), not injectable). What IS honoured is
// the per-instance `httpClient.defaults.timeout` (the fetch/axios client
// merges defaults into every request and aborts on it). So this patches
// every method on rpc.Server.prototype to set that default the first time an
// instance is used - same seam as rpc-diagnostics.js, same rule: change
// nothing about what the caller sees except that a request that would have
// hung now rejects with "timeout of Nms exceeded".
//
// A stalled call is thereby surfaced within RPC_TIMEOUT_MS (default 10s,
// well inside the caller's 30s), the facilitator answers with a real error
// body incl. the best-effort `payer`, and the caller's chain check decides.
// Note the same ambiguity any timeout has: a sendTransaction whose REQUEST
// timed out may still have reached the network - which is exactly why the
// caller confirms on-chain before believing any failure.
import { rpc } from "@stellar/stellar-sdk";

let installed = false;

/** Ensure `client.defaults.timeout` is set (only when not already positive -
 *  an explicitly configured instance is respected). Exported for tests. */
export function ensureRpcTimeout(client, ms) {
  if (!client || typeof client !== "object" || !client.defaults || typeof client.defaults !== "object") return false;
  if (client.defaults.timeout > 0) return false;
  client.defaults.timeout = ms;
  return true;
}

export function installRpcRequestTimeout(ms) {
  if (installed) return;
  installed = true;
  const timeoutMs = Number(ms);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    console.warn("[startup] RPC request timeout DISABLED (FACILITATOR_RPC_TIMEOUT_MS <= 0) - a stalled RPC call is bounded only by the per-endpoint timeouts");
    return;
  }
  const proto = rpc.Server.prototype;
  let patched = 0;
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === "constructor") continue;
    const d = Object.getOwnPropertyDescriptor(proto, name);
    if (!d || typeof d.value !== "function" || !d.writable) continue;
    const original = d.value;
    Object.defineProperty(proto, name, {
      ...d,
      value: function rpcWithRequestTimeout(...args) {
        ensureRpcTimeout(this.httpClient, timeoutMs);
        return original.apply(this, args);
      },
    });
    patched++;
  }
  console.log(`[startup] RPC request timeout installed: ${timeoutMs}ms per Soroban RPC request (${patched} rpc.Server methods)`);
}
