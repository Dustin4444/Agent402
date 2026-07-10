// Scan USDC (ASA 31566704) received by the Algorand revenue wallet and
// identify genuine external x402 payments — the Algorand counterpart of
// revenue-scan-stellar.js, closing the gap between the daily digest and the
// live /revenue page (which has had an Algorand card since the rail went
// live 2026-07-10).
//
// Deliberately a THIN ADAPTER: all AlgoNode logic (balance by asset-id,
// inbound axfer decoding, external/internal classification) lives in
// src/revenue-live.js's exported algorandRail() — the exact code the live
// page runs. Reusing it means this scanner CANNOT drift from the /revenue
// card the way the EVM digest scanner once did.
//
// Emits the same machine-readable stdout JSON shape as the sibling scanners:
//   { balanceUsd, payments, totalUsd, external: [{ when, usd, payer, tx }] }
//
// Best-effort: any AlgoNode failure → scanSkipped result, exit 0 (never fail
// the digest workflow).
//
// Run: ALGORAND_REVENUE_WALLET=<58-char address> node scripts/revenue-scan-algorand.js
import { fileURLToPath } from "node:url";
import { algorandRail } from "../src/revenue-live.js";

const WALLET = (process.env.ALGORAND_REVENUE_WALLET || "").trim();
const log = (...a) => console.error(...a);

// --- pure mapper (unit-tested in scripts/test-revenue-scan.js) ---------------

/** Map algorandRail()'s output to the digest scanners' common JSON contract.
 *  Rows keep the Algorand address casing verbatim (base32 is case-sensitive —
 *  never lowercase). `external` rides the rail's own per-entry classification
 *  so digest and live page always agree. */
export function digestFromAlgorandRail(rail) {
  const recent = Array.isArray(rail?.recent) ? rail.recent : [];
  const rows = recent.map((r) => ({ when: r.when || null, usd: r.usd || 0, payer: r.from || null, tx: r.tx || null }));
  const external = recent.filter((r) => r.external).map((r) => ({ when: r.when || null, usd: r.usd || 0, payer: r.from || null, tx: r.tx || null }));
  return {
    balanceUsd: rail?.balance == null ? null : Number(rail.balance),
    payments: rows.length,
    totalUsd: Number(rows.reduce((s, r) => s + (r.usd || 0), 0).toFixed(6)),
    scannedPayments: rows.length,
    external,
  };
}

async function main() {
  if (!WALLET) {
    log("ALGORAND_REVENUE_WALLET is not set — nothing to scan.");
    console.log(JSON.stringify({ balanceUsd: null, payments: 0, totalUsd: 0, external: [], scanSkipped: true, reason: "no ALGORAND_REVENUE_WALLET" }, null, 2));
    return;
  }
  const rail = await algorandRail(WALLET);
  if (rail.error) {
    log(`algorand revenue scan skipped (transient): ${rail.error}`);
    console.log(JSON.stringify({ balanceUsd: rail.balance ?? null, payments: 0, totalUsd: 0, external: [], scanSkipped: true, reason: rail.error }, null, 2));
    return;
  }
  const out = digestFromAlgorandRail(rail);
  log(`USDC balance of ${WALLET} on Algorand: $${(out.balanceUsd ?? 0).toFixed(4)} | ${out.payments} recent inbound payment(s), ${out.external.length} external`);
  console.log(JSON.stringify(out, null, 2));
}

// Run only as a CLI; importing for tests must not hit the network.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
