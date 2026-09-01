// Record refund debts for external buyers charged by packs that could not work.
//
// Nine packs answered HTTP 200 with zero successful steps for every buyer
// between 2026-07-08 and 2026-08-31 (see CLAUDE.md). Because those were 200s,
// the normal charged-but-failed detector never saw them: it mints a debt only
// when a settle receipt succeeds on a NON-200 response. So the refund ledger
// has no rows for them and this backfills what it structurally could not see.
//
// Reads the sales ledger (which carries the settle tx per sale) and mints one
// debt per EXTERNAL settlement of an affected slug inside the window. Internal
// rows - our own canaries and burners, which are most of the volume - are
// skipped: refunding ourselves is a no-op that would only burn gas.
//
// SAFETY. This only RECORDS debts; it sends nothing. scripts/refund-run.js is
// still the only thing that pays, it is dry-run by default, and before every
// send it re-derives the inbound payment from the chain and fails closed. So a
// wrong row here cannot become a wrong payment - it becomes a held row.
// recordRefundOwed is idempotent on the settle tx, so re-running is safe.
//
//   node scripts/refund-backfill-broken-packs.js          # dry run, prints
//   node scripts/refund-backfill-broken-packs.js --write  # mints the debts
//
// Must run where the /data volume is (the ledgers are SQLite on it).
import { recordRefundOwed, listRefunds } from "../src/refund-ledger.js";
import Database from "better-sqlite3";

// Total non-delivery only. Packs that returned SOME real work (crypto-dossier
// delivered 5 of 6 steps) are deliberately excluded: the buyer got value, and
// refunding a partial in full would be its own inaccuracy. Widen this list
// only with a reason.
const DEAD_SLUGS = [
  "skill-earnings-deep-dive", "skill-options-analytics", "skill-fixed-income-desk",
  "skill-defi-protocol-scanner", "skill-openapi-audit", "skill-fred-snapshot",
  "skill-competitor-scan", "skill-schema-evolution", "skill-api-investigation",
];
// The packs shipped broken on 2026-07-08 and were fixed on 2026-08-31. A sale
// outside that window is not evidence of this defect.
const FROM = Date.parse("2026-07-08T00:00:00Z");
const UNTIL = Date.parse("2026-09-01T00:00:00Z");

const WRITE = process.argv.includes("--write");
const DB_FILE = process.env.SALES_DB_FILE || "/data/agent402-sales.db";

let db;
try { db = new Database(DB_FILE, { readonly: true, fileMustExist: true }); }
catch (err) { console.error(`cannot open the sales ledger at ${DB_FILE}: ${err.message}`); process.exit(1); }

const rows = db.prepare(`
  SELECT ts, slug, price_usd, network, payer, tx
    FROM sales
   WHERE internal = 0 AND ts >= ? AND ts < ?
     AND slug IN (${DEAD_SLUGS.map(() => "?").join(",")})
   ORDER BY ts ASC
`).all(FROM, UNTIL, ...DEAD_SLUGS);

console.log(`${rows.length} external settlement(s) of a non-delivering pack in the window`);
let minted = 0, already = 0, noTx = 0, owedUsd = 0;
const byPayer = new Map();

for (const r of rows) {
  owedUsd += Number(r.price_usd) || 0;
  byPayer.set(r.payer, (byPayer.get(r.payer) || 0) + (Number(r.price_usd) || 0));
  if (!r.tx) {
    // Without the settle tx there is no idempotency key and nothing for the
    // executor to verify against the chain, so such a row would be unpayable
    // anyway. Count it out loud rather than mint something unverifiable.
    noTx++; continue;
  }
  if (!WRITE) continue;
  const ok = recordRefundOwed({
    slug: r.slug, network: r.network, payer: r.payer,
    priceUsd: Number(r.price_usd) || 0, tx: r.tx,
    httpStatus: 200, synthetic: false,
  });
  if (ok) minted++; else already++;
}

console.log(`total owed: $${owedUsd.toFixed(4)}`);
for (const [payer, usd] of [...byPayer].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${payer}: $${usd.toFixed(4)}`);
}
if (noTx) console.log(`${noTx} row(s) carry no settle tx and were skipped (nothing to verify on-chain)`);
if (!WRITE) { console.log("\nDRY RUN - nothing recorded. Re-run with --write to mint these debts."); process.exit(0); }
console.log(`minted ${minted} new debt(s), ${already} already recorded`);
console.log(`refund ledger now holds ${listRefunds({ status: "owed", limit: 500 }).length} owed row(s)`);
