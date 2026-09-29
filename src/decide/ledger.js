// Decisions the main app sold, their execution credits and execution runs.
//
// This is money state, so it lives beside the other payment ledgers (SQLite on
// the volume) rather than in the decide service: the execute route prices its
// 402 from it synchronously, and a credit must never depend on another
// service being up to be honoured. Amounts are integer micro-dollars.
//
// CREDIT LIFECYCLE. minted `pending` when a decision is answered; `active`
// only once that answer's payment SETTLED (the dispatcher's final-status hook);
// `redeemed` atomically by one execute run; back to `active` if that run
// fails before spending. A pending credit (its payment never settled) can
// never be redeemed. The token is shown once; only its hash is stored.

import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

const micro = (usd) => Math.round(Number(usd) * 1e6);
const usd = (m) => Math.round(Number(m)) / 1e6;
export const hashToken = (t) => createHash("sha256").update(String(t)).digest("hex");

export function openDecideLedger(path = process.env.DECIDE_LEDGER_DB || join(existsSync("/data") ? "/data" : "/tmp", "agent402-decide.db")) {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, depth TEXT NOT NULL,
      price_micro INTEGER NOT NULL, payer TEXT, plan_json TEXT NOT NULL,
      cost_via_micro INTEGER NOT NULL, settled INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS credits (
      token_hash TEXT PRIMARY KEY, decision_id TEXT NOT NULL, payer TEXT,
      amount_micro INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      state TEXT NOT NULL, run_id TEXT, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS credits_decision ON credits (decision_id);
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, decision_id TEXT NOT NULL, payer TEXT, status TEXT NOT NULL,
      budget_micro INTEGER NOT NULL, spent_micro INTEGER NOT NULL DEFAULT 0,
      credit_micro INTEGER NOT NULL DEFAULT 0, steps_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL, finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS runs_payer ON runs (payer, created_at);
    CREATE TABLE IF NOT EXISTS feedback (
      decision_id TEXT NOT NULL, step INTEGER NOT NULL, tool_id TEXT,
      outcome TEXT NOT NULL, quality INTEGER, latency_ms INTEGER, created_at INTEGER NOT NULL,
      PRIMARY KEY (decision_id, step)
    );
    CREATE INDEX IF NOT EXISTS runs_created ON runs (created_at);
  `);

  // Added after the first schema: the hash of the decision's feedback token.
  try { db.exec("ALTER TABLE decisions ADD COLUMN feedback_hash TEXT"); } catch { /* already there */ }

  const st = {
    saveDecision: db.prepare("INSERT OR REPLACE INTO decisions (id, created_at, depth, price_micro, payer, plan_json, cost_via_micro, settled, feedback_hash) VALUES (?,?,?,?,?,?,?,0,?)"),
    feedback: db.prepare("INSERT INTO feedback (decision_id, step, tool_id, outcome, quality, latency_ms, created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(decision_id, step) DO UPDATE SET tool_id = excluded.tool_id, outcome = excluded.outcome, quality = excluded.quality, latency_ms = excluded.latency_ms, created_at = excluded.created_at"),
    feedbackExisting: db.prepare("SELECT 1 FROM feedback WHERE decision_id = ? AND step = ?"),
    getDecision: db.prepare("SELECT * FROM decisions WHERE id = ?"),
    settleDecision: db.prepare("UPDATE decisions SET settled = 1 WHERE id = ?"),
    mint: db.prepare("INSERT INTO credits (token_hash, decision_id, payer, amount_micro, expires_at, state, created_at) VALUES (?,?,?,?,?, 'pending', ?)"),
    activate: db.prepare("UPDATE credits SET state = 'active' WHERE token_hash = ? AND state = 'pending'"),
    credit: db.prepare("SELECT * FROM credits WHERE token_hash = ?"),
    redeem: db.prepare("UPDATE credits SET state = 'redeemed', run_id = ? WHERE token_hash = ? AND decision_id = ? AND state = 'active' AND expires_at > ?"),
    restore: db.prepare("UPDATE credits SET state = 'active', run_id = NULL WHERE token_hash = ? AND state = 'redeemed' AND run_id = ?"),
    createRun: db.prepare("INSERT INTO runs (id, decision_id, payer, status, budget_micro, credit_micro, created_at) VALUES (?,?,?, 'running', ?, ?, ?)"),
    finishRun: db.prepare("UPDATE runs SET status = ?, spent_micro = ?, steps_json = ?, finished_at = ? WHERE id = ?"),
    getRun: db.prepare("SELECT * FROM runs WHERE id = ?"),
    payerSince: db.prepare("SELECT COALESCE(SUM(spent_micro),0) AS s FROM runs WHERE payer = ? AND created_at >= ?"),
    payerRunning: db.prepare("SELECT COALESCE(SUM(budget_micro),0) AS s FROM runs WHERE payer = ? AND status = 'running'"),
    globalSince: db.prepare("SELECT COALESCE(SUM(spent_micro),0) AS s FROM runs WHERE created_at >= ?"),
    globalRunning: db.prepare("SELECT COALESCE(SUM(budget_micro),0) AS s FROM runs WHERE status = 'running'"),
  };

  return {
    db,
    saveDecision({ decisionId, depth, priceUsd, payer, plan, costViaUsd, feedbackHash = null, now = Date.now() }) {
      st.saveDecision.run(decisionId, now, depth, micro(priceUsd), payer || null, JSON.stringify(plan), micro(costViaUsd), feedbackHash);
    },
    /** True when `token` is the feedback token minted with this decision. */
    feedbackTokenOk(decisionId, token) {
      if (typeof token !== "string" || !token) return false;
      const r = st.getDecision.get(String(decisionId || ""));
      return !!r && !!r.feedback_hash && r.feedback_hash === hashToken(token);
    },
    /** One verdict per (decision, step); a later report replaces it. Returns
     *  true when this replaced an earlier one. */
    saveFeedback({ decisionId, step, toolId, outcome, quality = null, latencyMs = null, now = Date.now() }) {
      const had = !!st.feedbackExisting.get(decisionId, step);
      st.feedback.run(decisionId, step, toolId || null, outcome, quality, latencyMs, now);
      return had;
    },
    getDecision(id) {
      const r = st.getDecision.get(String(id || ""));
      if (!r) return null;
      return { id: r.id, createdAt: r.created_at, depth: r.depth, priceUsd: usd(r.price_micro), payer: r.payer, plan: JSON.parse(r.plan_json), costViaUsd: usd(r.cost_via_micro), settled: !!r.settled };
    },
    markDecisionSettled(id) { st.settleDecision.run(id); },

    /** `expiresAt` wins over `ttlMs`: a leftover credit inherits its decision's
     *  expiry, so no credit ever outlives the decision it came from. */
    mintCredit({ decisionId, amountUsd, ttlMs, expiresAt: fixedExpiry = null, payer, now = Date.now() }) {
      const token = `dc_${randomBytes(24).toString("base64url")}`;
      const expiresAt = Number.isFinite(fixedExpiry) ? fixedExpiry : now + ttlMs;
      st.mint.run(hashToken(token), decisionId, payer || null, micro(amountUsd), expiresAt, now);
      return { token, hash: hashToken(token), amountUsd: usd(micro(amountUsd)), expiresAt };
    },
    activateCredit(hash) { return st.activate.run(hash).changes === 1; },
    /** Spendable amount of a credit for this decision right now, or 0. Read-only. */
    creditAvailableUsd(token, decisionId, now = Date.now()) {
      if (typeof token !== "string" || !token) return 0;
      const r = st.credit.get(hashToken(token));
      if (!r || r.decision_id !== decisionId || r.state !== "active" || r.expires_at <= now) return 0;
      return usd(r.amount_micro);
    },
    creditState(token) { const r = typeof token === "string" ? st.credit.get(hashToken(token)) : null; return r ? { state: r.state, expiresAt: r.expires_at, amountUsd: usd(r.amount_micro), decisionId: r.decision_id } : null; },
    /** Atomic: exactly one run can redeem a credit. Returns the amount or 0. */
    redeemCredit(token, decisionId, runId, now = Date.now()) {
      if (typeof token !== "string" || !token) return 0;
      const h = hashToken(token);
      const ok = st.redeem.run(runId, h, decisionId, now).changes === 1;
      return ok ? usd(st.credit.get(h).amount_micro) : 0;
    },
    restoreCredit(token, runId) { if (typeof token === "string" && token) st.restore.run(hashToken(token), runId); },

    createRun({ runId, decisionId, payer, budgetUsd, creditUsd, now = Date.now() }) { st.createRun.run(runId, decisionId, payer || null, micro(budgetUsd), micro(creditUsd), now); },
    finishRun({ runId, status, spentUsd, steps, now = Date.now() }) { st.finishRun.run(status, micro(spentUsd), JSON.stringify(steps || []), now, runId); },
    getRun(id) { const r = st.getRun.get(id); return r ? { ...r, budgetUsd: usd(r.budget_micro), spentUsd: usd(r.spent_micro), creditUsd: usd(r.credit_micro), steps: JSON.parse(r.steps_json) } : null; },
    /** Spent in the window plus everything still running (its whole budget). */
    payerExposureUsd(payer, sinceMs) { return usd(st.payerSince.get(payer || "", sinceMs).s + st.payerRunning.get(payer || "").s); },
    globalExposureUsd(sinceMs) { return usd(st.globalSince.get(sinceMs).s + st.globalRunning.get().s); },
  };
}
