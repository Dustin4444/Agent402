#!/usr/bin/env node
// Auto top-up for the paid-canary's Base burner, from a DEDICATED refill wallet.
//
// Why a separate wallet: the treasury key must never enter CI, and the
// Blockscout spending wallet is dedicated by rule. The refill wallet inverts
// the burner's risk profile — the burner's key is exercised by every canary
// run (high exposure, so it carries a small float), while the refill key is
// touched only by this one tiny job (low exposure, so it can hold a month of
// runway). The owner's job shrinks to funding the refill wallet when an issue
// asks, roughly quarterly.
//
// Safety properties, all pinned by scripts/test-canary-refill.js:
//   • the recipient is a CONSTANT — no input, env var, or dispatch parameter
//     can redirect funds anywhere but the burner
//   • sends only when the burner is under the floor, only up to the target,
//     and never more than MAX_PER_RUN in one run — a bug loops at $12/day
//     worst case, not a drained wallet in one shot
//   • every amount is integer USDC micro-units; no float money math
//
// Env: CANARY_REFILL_KEY (GitHub Actions secret — never Railway, never repo).
// Tunables (repo vars via workflow env): REFILL_FLOOR_USD (default 8),
// REFILL_TARGET_USD (15), REFILL_MAX_PER_RUN_USD (12).
import { createWalletClient, createPublicClient, http, erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

// The canary burner (docs: credential rotation 2026-07-17). CONSTANT on purpose.
export const BURNER = "0x902dCf34E53695bDEA2fFB354b1a2e58bD598256";
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

/**
 * Pure decision: given balances in micro-USDC, decide what to do.
 * Returns { action: "skip" | "send" | "refill-empty", amountMicro? }.
 */
export function decideRefill({ burnerMicro, refillMicro, floorUsd = 8, targetUsd = 15, maxPerRunUsd = 12 }) {
  const floor = Math.round(floorUsd * 1e6);
  const target = Math.round(targetUsd * 1e6);
  const cap = Math.round(maxPerRunUsd * 1e6);
  if (!Number.isFinite(burnerMicro) || !Number.isFinite(refillMicro)) return { action: "refill-empty" }; // unreadable = loud, never a blind send
  if (burnerMicro >= floor) return { action: "skip" };
  const want = Math.min(target - burnerMicro, cap);
  if (refillMicro < want) return { action: "refill-empty", amountMicro: want };
  return { action: "send", amountMicro: want };
}

async function main() {
  const pk = process.env.CANARY_REFILL_KEY;
  if (!pk) { console.error("CANARY_REFILL_KEY is not set"); process.exit(2); }
  const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
  console.log(`refill wallet: ${account.address}`);

  const pub = createPublicClient({ chain: base, transport: http() });
  const balOf = (addr) => pub.readContract({ address: USDC_BASE, abi: erc20Abi, functionName: "balanceOf", args: [addr] });
  const burnerMicro = Number(await balOf(BURNER));
  const refillMicro = Number(await balOf(account.address));
  console.log(`burner: $${(burnerMicro / 1e6).toFixed(4)} | refill wallet: $${(refillMicro / 1e6).toFixed(4)}`);

  const decision = decideRefill({
    burnerMicro, refillMicro,
    floorUsd: num(process.env.REFILL_FLOOR_USD, 8),
    targetUsd: num(process.env.REFILL_TARGET_USD, 15),
    maxPerRunUsd: num(process.env.REFILL_MAX_PER_RUN_USD, 12),
  });

  if (decision.action === "skip") { console.log("burner above the floor — nothing to do"); return; }
  if (decision.action === "refill-empty") {
    console.error(`REFILL WALLET EMPTY — cannot cover a $${((decision.amountMicro ?? 0) / 1e6).toFixed(2)} top-up. Fund ${account.address} with USDC on Base (plus a little ETH for gas).`);
    process.exit(3); // the workflow turns exit 3 into the "fund me" issue
  }

  const wallet = createWalletClient({ account, chain: base, transport: http() });
  const hash = await wallet.writeContract({
    address: USDC_BASE, abi: erc20Abi, functionName: "transfer",
    args: [BURNER, BigInt(decision.amountMicro)],
  });
  console.log(`sent $${(decision.amountMicro / 1e6).toFixed(2)} USDC to the burner — tx ${hash}`);
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") { console.error(`transfer tx ${hash} did not succeed (${receipt.status})`); process.exit(1); }
  console.log(`confirmed in block ${receipt.blockNumber} — burner topped up`);
}

// Import-safe for tests: only run when executed directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e?.message || e); process.exit(1); });
}
