// Solana SPL leaderboard: inbound USDC credits per seller payTo on Solana,
// scanned in one batched pass, hour-fresh, persisted, and PRIMED into the
// pay-time proven-seller gate.
//
// Why (2026-09-02): Solana was the one rail where proven-ness rested on a
// pay-time read alone. Every routed buy re-read the seller's USDC token
// account (getSignaturesForAddress + up to 120 getTransaction reads), the
// resolver had no settled/payers evidence for Solana rows (the Base
// leaderboard is eth_getLogs and cannot see SPL), and nothing public said
// which Solana sellers are actually paid. Measured 2026-09-02: Solana x402
// volume is essentially ONE payTo (sol.blockrun, 3,000+ credits per 15h) plus
// a handful of small ones - a fact the pay-time gate discovered one buy at a
// time and the leaderboard could not show at all.
//
// The read is the gate's own `solanaInboundCount` (pre/post token-balance
// deltas on the seller's USDC account, self-funded transfers excluded), run
// over every Solana payTo the index knows with a small concurrency and the
// same per-payTo read cap; a payTo past the cap is reported `truncated` with
// the count it reached (which is at or past the proof floor, the only thing a
// router needs to know). Counts are CREDITS, not distinct funders: on Solana
// x402 the debited account is usually a shared facilitator, so distinct
// funders collapses to 1 for a real seller (the gate's own comment).
//
// Never a per-transaction feed on the public surface; rows are counts.
import { readFileSync, writeFileSync, renameSync } from "node:fs";

export const SOLANA_LB_CACHE_FILE = process.env.SOLANA_LB_CACHE_FILE || "/data/solana-leaderboard.json";
const REFRESH_MS = Number(process.env.SOLANA_LB_REFRESH_MS) || 60 * 60_000;
// One payTo at a time: each read already fans out 12 concurrent getTransaction
// calls, and two payTos in parallel drew Alchemy 429s + 6 s timeouts on 37 of
// 357 payTos on the first live scan (2026-09-02). A failed read is retried
// once after a pause before the row is marked unreadable.
const CONCURRENCY = Number(process.env.SOLANA_LB_CONCURRENCY) || 1;
const RETRY_PAUSE_MS = Number(process.env.SOLANA_LB_RETRY_PAUSE_MS) || 1500;
const MAX_PAYTOS = Number(process.env.SOLANA_LB_MAX_PAYTOS) || 600;
const STALE_MS = 3 * REFRESH_MS;

let current = { at: 0, rows: [], scanned: 0, errors: 0, windowHours: null, durationMs: 0, warm: false };
let inFlight = null;
let timer = null, kick = null, kick2 = null;

export function solanaLeaderboardEnabled() {
  return String(process.env.SOLANA_LEADERBOARD || "on").toLowerCase() !== "off";
}

/** Pure: rank rows by credits desc, then payers, then payTo. Marks the host's own payTo. */
export function rankSolanaRows(rows, { self = null } = {}) {
  const s = self ? String(self) : null;
  return [...rows]
    .map((r) => ({ ...r, self: !!(s && r.payTo === s) }))
    .sort((a, b) => (b.credits - a.credits) || ((b.payers || 0) - (a.payers || 0)) || String(a.payTo).localeCompare(String(b.payTo)))
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

/**
 * One batched scan. `payTos`: Map(payTo -> Set(origins)). `readFn(payTo)`
 * resolves { credits, payers, truncated } (the gate's counter in detail mode).
 * Failures are counted, never fatal - the previous row for that payTo is kept
 * marked stale so one RPC hiccup does not zero a proven seller.
 */
export async function scanSolanaSellers(payTos, { readFn, concurrency = CONCURRENCY, now = Date.now(), previous = current.rows, maxPayTos = MAX_PAYTOS, windowHours = null, retryPauseMs = RETRY_PAUSE_MS } = {}) {
  const prevBy = new Map((previous || []).map((r) => [r.payTo, r]));
  const list = [...payTos.entries()].slice(0, maxPayTos);
  const rows = [];
  let errors = 0, cursor = 0;
  const started = now;
  const worker = async () => {
    for (;;) {
      const entry = list[cursor++];
      if (!entry) return;
      const [payTo, origins] = entry;
      try {
        let r;
        try { r = await readFn(payTo); }
        catch (first) { await new Promise((res) => setTimeout(res, retryPauseMs)); r = await readFn(payTo); }
        rows.push({ payTo, origins: [...origins].sort(), credits: Number(r?.credits) || 0, payers: Number(r?.payers) || 0, truncated: !!r?.truncated, at: Date.now() });
      } catch (e) {
        errors++;
        const prev = prevBy.get(payTo);
        if (prev) rows.push({ ...prev, origins: [...origins].sort(), stale: true, error: String(e?.message || e).slice(0, 80) });
        else rows.push({ payTo, origins: [...origins].sort(), credits: 0, payers: 0, truncated: false, at: Date.now(), unreadable: true, error: String(e?.message || e).slice(0, 80) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return { at: Date.now(), rows, scanned: list.length, errors, windowHours, durationMs: Date.now() - started, warm: false };
}

/** Evidence maps for the router: origin -> credits / payers (max across a seller's payTos). */
export function solanaEvidenceByOrigin(snapshot = current) {
  const settled = new Map(), payers = new Map();
  for (const r of snapshot.rows || []) {
    for (const o of r.origins || []) {
      const k = String(o).replace(/\/+$/, "").toLowerCase();
      settled.set(k, Math.max(settled.get(k) || 0, r.credits || 0));
      payers.set(k, Math.max(payers.get(k) || 0, r.payers || 0));
    }
  }
  return { settled, payers };
}

export function getSolanaLeaderboardSnapshot({ self = null, now = Date.now() } = {}) {
  // Public rows carry counts and flags, never the RPC's own words (the
  // leaderboard-redaction rule: an error string on a public surface is a
  // provider detail at best and a key-bearing URL at worst).
  const rows = rankSolanaRows(current.rows.map(({ error, ...r }) => r), { self });
  return {
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    asset: "USDC",
    measure: "inbound USDC credits to the seller's payTo over the window (self-funded transfers excluded); truncated rows reached the per-seller read cap",
    windowHours: current.windowHours,
    scannedAt: current.at ? new Date(current.at).toISOString() : null,
    stale: !current.at || now - current.at > STALE_MS,
    warmStarted: !!current.warm,
    sellers: current.scanned,
    errors: current.errors,
    active: rows.filter((r) => r.credits > 0).length,
    rows,
  };
}

export function persistSolanaLeaderboard(file = SOLANA_LB_CACHE_FILE) {
  try {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(current));
    renameSync(tmp, file);
  } catch { /* the volume is best-effort; the next scan rebuilds */ }
}
export function loadPersistedSolanaLeaderboard(file = SOLANA_LB_CACHE_FILE) {
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    if (j && Array.isArray(j.rows)) { current = { ...j, warm: true }; return true; }
  } catch { /* cold start */ }
  return false;
}
export function __setSolanaLeaderboardForTest(snap) { current = { ...current, ...snap }; }
export function __resetSolanaLeaderboardForTest() { current = { at: 0, rows: [], scanned: 0, errors: 0, windowHours: null, durationMs: 0, warm: false }; }

/** Rebuild: list payTos from the index, scan, prime the gate, persist. Deduped in flight. */
export async function refreshSolanaLeaderboard({ listPayTos, readFn, prime, windowHours = null } = {}) {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const payTos = await listPayTos();
      const next = await scanSolanaSellers(payTos, { readFn, windowHours });
      current = next;
      if (typeof prime === "function") for (const r of next.rows) if (!r.unreadable && !r.stale) { try { prime(r.payTo, r.credits); } catch { /* priming is a nicety */ } }
      persistSolanaLeaderboard();
      console.log(`[solana-leaderboard] scanned ${next.scanned} payTos in ${next.durationMs}ms: ${next.rows.filter((r) => r.credits > 0).length} active, ${next.errors} unreadable`);
    } catch (e) {
      console.warn(`[solana-leaderboard] rebuild failed (previous board kept): ${String(e?.message || e).slice(0, 120)}`);
    } finally { inFlight = null; }
  })();
  return inFlight;
}

export function startSolanaLeaderboard({ listPayTos, readFn, prime, windowHours = null, delayMs = 180_000 } = {}) {
  if (!solanaLeaderboardEnabled()) { console.log("[solana-leaderboard] disabled (SOLANA_LEADERBOARD=off)"); return; }
  if (loadPersistedSolanaLeaderboard()) console.log(`[solana-leaderboard] warm-started ${current.rows.length} payTos from ${SOLANA_LB_CACHE_FILE}`);
  const run = () => refreshSolanaLeaderboard({ listPayTos, readFn, prime, windowHours });
  kick = setTimeout(run, delayMs); kick.unref?.();
  kick2 = setTimeout(run, delayMs + 12 * 60_000); kick2.unref?.();
  timer = setInterval(run, REFRESH_MS); timer.unref?.();
}
export function stopSolanaLeaderboard() { for (const t of [timer, kick, kick2]) if (t) clearTimeout(t), clearInterval(t); timer = kick = kick2 = null; }
