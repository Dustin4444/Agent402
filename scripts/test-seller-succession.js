#!/usr/bin/env node
// A seller moving to a permanent domain keeps how long we have known them.
//
// Asked for by a seller on 2026-09-12: they had been listed for weeks on a
// *.workers.dev host, moved to their own domain, and found no way to do it
// except register fresh and become a second, brand-new identity. Nothing in
// the register flow offered a migration, and the thing the move actually costs
// is narrow - `first_seen` is origin-keyed, so a seller listed for months reset
// to "new today".
//
// What it does NOT do, deliberately:
//   - It never demotes, retires or edits the predecessor. A register call that
//     could retire another seller's listing is a weapon whatever proof rides
//     with it; the old origin ages out the honest way, by not answering.
//   - It never transfers settlement evidence. Evidence is keyed by payTo and
//     follows the wallet already, and the shared-payTo guard that withholds
//     chain proof while two live origins claim one wallet stays exactly as it
//     is - a migration window is when a listing should be handled carefully,
//     not when the guard should be relaxed.
//   - It only ever moves the date BACKWARD, so no claim can make an origin
//     look newer, or younger, than it is.
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// stats.js opens a fixed path under its own DATA_DIR, so this drives the real
// store and uses run-unique origins rather than trying to redirect the file.
const dir = mkdtempSync(join(tmpdir(), "a402-succ-"));
process.env.SALES_LEDGER_DB = join(dir, "sales.db");
process.env.ALLOW_EPHEMERAL_STATS = "true";
const TAG = Math.random().toString(36).slice(2, 8);
const STATS_DB = existsSync("/data") ? "/data/agent402-stats.db" : "/tmp/agent402-stats.db";

const { recordSellerRegistrationSeen, sellerRegistrationFirstSeen, getSellerRegistrations } = await import("../src/stats.js");

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); n++; };

const OLD = `https://seller-${TAG}.workers.dev`;
const NEW = `https://api.seller-${TAG}.com`;

// --- the date moves, and only backward -------------------------------------
{
  recordSellerRegistrationSeen(OLD, {});
  const old0 = sellerRegistrationFirstSeen(OLD);
  ok(Number.isFinite(old0), "the predecessor has a first_seen");

  // Backdate it so "months ago" is a real gap rather than a same-millisecond tie.
  const { default: Database } = await import("better-sqlite3");
  const raw = new Database(STATS_DB);
  const MONTHS_AGO = Date.now() - 90 * 86_400_000;
  raw.prepare("UPDATE seller_registrations SET first_seen = ? WHERE origin = ?").run(MONTHS_AGO, OLD);
  raw.close();
  eq(sellerRegistrationFirstSeen(OLD), MONTHS_AGO, "the predecessor now reads as registered 90 days ago");

  recordSellerRegistrationSeen(NEW, { inheritFirstSeenFrom: OLD });
  eq(sellerRegistrationFirstSeen(NEW), MONTHS_AGO,
     "the successor INHERITS the date: a seller who has been listed for months does not read as new today because they bought a domain");
  eq(sellerRegistrationFirstSeen(OLD), MONTHS_AGO, "and the predecessor is untouched - succession copies, it never moves or retires anything");

  // Re-registering later must not push the date forward.
  recordSellerRegistrationSeen(NEW, {});
  eq(sellerRegistrationFirstSeen(NEW), MONTHS_AGO, "a later plain re-registration does not reset the inherited date");
}

// --- a claim can never push a date FORWARD ---------------------------------
// The rule is MIN, so inheriting from an origin registered AFTER us must be
// inert. Without it a succession claim could make a long-listed seller look
// newer than they are, which is the same lie in the other direction.
{
  const { default: Database } = await import("better-sqlite3");
  const ANCIENT = `https://ancient-${TAG}.example`;
  const RECENT = `https://recent-${TAG}.example`;
  recordSellerRegistrationSeen(ANCIENT, {});
  const LONG_AGO = Date.now() - 200 * 86_400_000;
  const raw2 = new Database(STATS_DB);
  raw2.prepare("UPDATE seller_registrations SET first_seen = ? WHERE origin = ?").run(LONG_AGO, ANCIENT);
  raw2.close();
  recordSellerRegistrationSeen(RECENT, {}); // registered today, i.e. NEWER than ANCIENT
  eq(sellerRegistrationFirstSeen(ANCIENT), LONG_AGO, "control: the ancient origin reads as 200 days old");
  recordSellerRegistrationSeen(ANCIENT, { inheritFirstSeenFrom: RECENT });
  eq(sellerRegistrationFirstSeen(ANCIENT), LONG_AGO,
     "inheriting from a NEWER origin is inert: the rule is MIN, so a claim can only ever pull a date earlier, never make a seller look newer than they are");
}

// --- an unknown or absent predecessor changes nothing -----------------------
{
  const A = `https://alone-${TAG}.example`;
  recordSellerRegistrationSeen(A, { inheritFirstSeenFrom: `https://never-${TAG}.example` });
  ok(Number.isFinite(sellerRegistrationFirstSeen(A)), "inheriting from an origin we have never seen is a no-op, not a crash or a null date");
  const B = `https://plain-${TAG}.example`;
  recordSellerRegistrationSeen(B, {});
  ok(Number.isFinite(sellerRegistrationFirstSeen(B)), "and the ordinary path is unchanged");
  eq(sellerRegistrationFirstSeen(`https://nothing-${TAG}.example`), null, "an origin that never registered reads null");
}

// --- the predecessor is never removed from the table ------------------------
{
  const rows = getSellerRegistrations();
  ok(rows.some((r) => r.origin === OLD), "the predecessor is STILL LISTED after a succession - nothing about this retires a seller");
  ok(rows.some((r) => r.origin === NEW), "and the successor is listed beside it");
}

rmSync(dir, { recursive: true, force: true });
console.log(`test-seller-succession: ${n} assertions OK`);
