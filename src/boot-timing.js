// Boot-time warm-start timing (2026-08-25). Prod's first instrumented deploy
// recorded a 17.1 s event-loop stall right after module evaluation, with every
// timed post-listen start under 200 ms - so the block is inside a warm-start
// that parses a /data cache synchronously in an async continuation. Each such
// loader wraps itself in timedSync() and names the file, its size and the
// milliseconds when it held the loop for more than a moment. Nothing on the
// request path; a log line per slow load at boot, nothing otherwise.
import { statSync } from "node:fs";

export function timedSync(label, file, fn, { warnMs = 200 } = {}) {
  const t0 = performance.now();
  try { return fn(); }
  finally {
    const ms = Math.round(performance.now() - t0);
    if (ms > warnMs) {
      let size = "?";
      try { size = `${(statSync(file).size / 1_048_576).toFixed(1)} MB`; } catch { /* absent or unreadable - the load failed too */ }
      console.warn(`[boot] ${label} (${file}, ${size}) held the event loop for ${ms}ms`);
    }
  }
}
