// What a PAID call to an external seller actually returned, kept.
//
// The daily dataset records SUPPLY: who exists, what they advertise, what they
// charge, what settled to their wallet. Every row of it is derived from
// documents a seller publishes about itself or from public chain reads. None
// of it can say whether paying that seller produces the thing they promised,
// and no amount of crawling will ever say so.
//
// The seller sweep answers that, and it answers it the only way the question
// can be answered: by spending real money on 1,109 endpoints and grading each
// answer against the contract that seller publishes. Measured 2026-09-12 for
// $2.82: 483 sellers took payment, 311 returned the shape they promised, 54
// returned something their own published contract does not describe, and 10
// returned nothing at all.
//
// That artifact lived in a GitHub Actions run and expired with it. This keeps
// it: one dated object per sweep, in the same bucket as the daily snapshot,
// under its own prefix so the frozen v1 tables are untouched and a day with no
// sweep is simply a day with no verification rather than a hole in a table
// that is supposed to be daily.
//
// WHY THE SERVER WRITES IT RATHER THAN THE WORKFLOW. The bucket credentials
// live here and nowhere else. The sweep runs in the `spending` environment
// with a funded burner key; giving that same job write access to the dataset
// bucket would widen what one compromised workflow can reach, for no gain.
// The workflow posts what it observed and the server decides what to keep -
// the same split as POST /api/status/probe, and for the same reason.
import { putObject, backupConfigured } from "./backup.js";

export const VERIFICATION_PREFIX = "datasets/v1/verification";

// Verdicts the sweep may report. A payload naming anything else is refused
// rather than stored: this is an operator-posted document and the vocabulary
// is the contract between the two halves.
const VERDICTS = new Set([
  "paid_delivers", "paid_hollow", "paid_ungraded", "paid_no_answer",
  "input_rejected", "payment_refused", "served_no_receipt", "seller_error",
  "no_challenge", "no_base_accept", "over_cap", "unreachable", "run_cap_reached", "would_pay",
]);

// Columns kept per row. An allowlist, never a denylist: the sweep's artifact
// carries whatever the driver put in it, and a field added there must not
// silently become a published column here.
const ROW_COLUMNS = ["origin", "route", "method", "verdict", "listedUsd", "quotedUsd", "paidStatus", "ms", "declares", "guaranteedPaths", "missingKeys", "emptyArrays", "settlementTx"];

let last = null;

/** Project and validate one sweep row. Returns null for anything unusable. */
function projectRow(r) {
  if (!r || typeof r !== "object") return null;
  const origin = typeof r.origin === "string" ? r.origin.slice(0, 300) : null;
  if (!origin || !VERDICTS.has(r.verdict)) return null;
  const out = {};
  for (const c of ROW_COLUMNS) {
    const v = r[c];
    out[c] = v === undefined ? null
      : Array.isArray(v) ? v.slice(0, 40).map((x) => String(x).slice(0, 120))
      : typeof v === "number" || typeof v === "boolean" ? v
      : v === null ? null
      : String(v).slice(0, 300);
  }
  // The seller's RESPONSE BODY is never stored, only the shape verdict. Their
  // content is theirs; what we can publish is what we observed about the
  // contract they publish.
  delete out.bodyKeys;
  return out;
}

/**
 * Store one sweep result as a dated object.
 *
 * Idempotent per day: a second sweep on the same day overwrites, exactly as
 * the daily snapshot does. Never mutates a PAST day - a sweep can only write
 * the day it ran, because a dated record whose contents can change later is
 * not a record.
 */
export async function recordSellerVerification(payload, { now = () => Date.now(), put = putObject, configured = backupConfigured } = {}) {
  if (!configured()) return { stored: false, reason: "no bucket configured" };
  if (!payload || typeof payload !== "object") throw Object.assign(new Error("payload must be an object"), { statusCode: 400 });
  const rows = (Array.isArray(payload.rows) ? payload.rows : []).map(projectRow).filter(Boolean);
  if (!rows.length) throw Object.assign(new Error("no usable rows in the payload"), { statusCode: 400 });

  const day = new Date(now()).toISOString().slice(0, 10);
  const tally = {};
  for (const r of rows) tally[r.verdict] = (tally[r.verdict] || 0) + 1;
  const paid = ["paid_delivers", "paid_hollow", "paid_ungraded", "paid_no_answer"].reduce((n, k) => n + (tally[k] || 0), 0);

  const manifest = {
    dataset: "agent402-seller-verification",
    version: "v1",
    day,
    writtenAt: new Date(now()).toISOString(),
    method: "One paid call per seller from our own wallet, graded against the output contract that seller publishes in its own 402 or OpenAPI. Not a crawl: every row here cost money.",
    limits: "The claim stops at SHAPE. A seller returning every promised key with wrong values reads as paid_delivers, and nothing here checks whether an answer is correct or useful. Rows are one observation on one date with one input - the seller's own published example where they publish one - never a rating.",
    privacy: "No response bodies are stored. Seller origins and routes are published (they are public endpoints); the buyer is always us.",
    sellers: rows.length,
    paidSellers: paid,
    spentUsd: Number(payload.spentUsd) || 0,
    capUsd: Number(payload.capUsd) || null,
    tally,
  };
  const body = Buffer.from(rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  await put(`${VERIFICATION_PREFIX}/dt=${day}/verification.ndjson`, body);
  await put(`${VERIFICATION_PREFIX}/dt=${day}/manifest.json`, Buffer.from(JSON.stringify(manifest, null, 2), "utf8"));
  last = { day, at: Date.now(), sellers: rows.length, paidSellers: paid, tally, spentUsd: manifest.spentUsd };
  return { stored: true, day, sellers: rows.length, paidSellers: paid, tally };
}

/** Counts only, for the operator surface. */
export const sellerVerificationStatus = () => (last ? { ...last, at: new Date(last.at).toISOString() } : { day: null, sellers: 0 });
