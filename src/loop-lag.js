// Event-loop lag monitor, always on.
//
// Built 2026-08-30 to answer one question with evidence instead of a hypothesis:
// seven Solana verifies failed with `fetch failed [UND_ERR_CONNECT_TIMEOUT]`
// while CDP answered from outside in 15-37 ms. A CONNECT timeout means undici's
// timer fired before a TCP connection was established - and that timer is a
// TIMER, so a blocked event loop produces exactly this error with a perfectly
// healthy network. Everything else was ruled out: rate limits return 429 (an
// answer, and their ceiling is 500 writes / 10 s), IPv6 is already forced off
// process-wide, the client uses plain fetch and so inherits that, and CDP was
// reachable throughout.
//
// We only ever instrumented BOOT (boot-profile.js, written after a 15.5 s hold),
// so a stall four hours into a container's life was invisible. This closes that:
// the next CDP timeout either coincides with a logged stall or it does not, and
// one occurrence settles which side the fault is on.
//
// Deliberately cheap: one timer, no sampling profiler, no allocation per tick.
// The measurement is the only honest one available in-process - schedule a timer
// for N ms and see how late it actually fires. Lateness IS the lag.

import { monitorEventLoopDelay } from "node:perf_hooks";

const TICK_MS = Number(process.env.LOOP_LAG_TICK_MS) || 500;
const WARN_MS = Number(process.env.LOOP_LAG_WARN_MS) || 1000;
// Blocks from this size up are COUNTED (per minute, in the [loop-stats] line)
// even though only blocks over WARN_MS get a line of their own.
const COUNT_MS = Number(process.env.LOOP_LAG_COUNT_MS) || 200;
const STATS_MS = 60_000;
// Optional context for a stall line (the oldest in-flight requests), set by
// the server once its request tracker exists. Must be cheap and never throw.
let stallContext = null;
export function setStallContext(fn) { stallContext = typeof fn === "function" ? fn : null; }
let minute = { blocks200: 0, blockedMs: 0 };
const state = { worstMs: 0, worstAt: null, stalls: 0, lastStallMs: 0, lastStallAt: null, startedAt: null };

/** @returns {{worstMs:number, worstAt:string|null, stalls:number, lastStallMs:number, lastStallAt:string|null, watching:boolean}} */
export function loopLagStatus() {
  return {
    watching: state.startedAt !== null,
    worstMs: Math.round(state.worstMs),
    worstAt: state.worstAt,
    stalls: state.stalls,
    lastStallMs: Math.round(state.lastStallMs),
    lastStallAt: state.lastStallAt,
    lastMinute: state.lastMinute || null,
  };
}

/** Reset the high-water mark (the operator endpoint offers this; alarms do not). */
export function resetLoopLag() {
  state.worstMs = 0; state.worstAt = null; state.stalls = 0; state.lastStallMs = 0; state.lastStallAt = null;
}

export function startLoopLagMonitor({ tickMs = TICK_MS, warnMs = WARN_MS, statsMs = STATS_MS, log = console.warn, statsLog = console.log } = {}) {
  if (state.startedAt) return () => {};
  state.startedAt = Date.now();
  // One [loop-stats] line a minute, from this same timer (one timer total):
  // event-loop delay percentiles from the runtime's own histogram, how many
  // blocks passed COUNT_MS and their total, and heap/RSS, so a slow drift is
  // visible as well as a spike.
  let hist = null;
  try { hist = monitorEventLoopDelay({ resolution: 10 }); hist.enable(); } catch { hist = null; }
  let statsDue = Date.now() + statsMs;
  const emitStats = () => {
    const mem = process.memoryUsage();
    const ms = (ns) => Math.round(ns / 1e6);
    const h = hist ? `p50=${ms(hist.percentile(50))}ms p99=${ms(hist.percentile(99))}ms max=${ms(hist.max)}ms` : "hist=n/a";
    state.lastMinute = { p50: hist ? ms(hist.percentile(50)) : null, p99: hist ? ms(hist.percentile(99)) : null, max: hist ? ms(hist.max) : null, blocks200: minute.blocks200, blockedMs: Math.round(minute.blockedMs), heapMb: Math.round(mem.heapUsed / 1048576), rssMb: Math.round(mem.rss / 1048576), at: new Date().toISOString() };
    statsLog(`[loop-stats] ${h} blocks>=${COUNT_MS}ms=${minute.blocks200} blocked=${Math.round(minute.blockedMs)}ms heap=${state.lastMinute.heapMb}MB rss=${state.lastMinute.rssMb}MB`);
    minute = { blocks200: 0, blockedMs: 0 };
    if (hist) hist.reset();
  };
  let expected = Date.now() + tickMs;
  const timer = setInterval(() => {
    const now = Date.now();
    if (now >= statsDue) { statsDue = now + statsMs; try { emitStats(); } catch { /* stats are best-effort */ } }
    const late = now - expected;          // how much later than scheduled it ran
    expected = now + tickMs;
    if (late <= 0) return;
    if (late > state.worstMs) { state.worstMs = late; state.worstAt = new Date(now).toISOString(); }
    if (late >= COUNT_MS) { minute.blocks200++; minute.blockedMs += late; }
    if (late >= warnMs) {
      state.stalls++; state.lastStallMs = late; state.lastStallAt = new Date(now).toISOString();
      // One line, with the number, so it can be correlated against a payment
      // failure by timestamp. The in-flight list names what was being served;
      // the stall profiler (src/stall-profiler.js) names the code.
      let ctx = "";
      try { const c = stallContext ? stallContext() : null; if (c && c.length) ctx = ` in-flight: ${c.join(", ")}`; } catch { /* context is best-effort */ }
      log(`[loop-lag] event loop blocked ${Math.round(late)}ms (stall #${state.stalls}) - in-flight sockets can hit connect timeouts while this lasts${ctx}`);
    }
  }, tickMs);
  // Never hold the process open: a diagnostic must not change shutdown.
  if (typeof timer.unref === "function") timer.unref();
  return () => { clearInterval(timer); if (hist) hist.disable(); state.startedAt = null; };
}
