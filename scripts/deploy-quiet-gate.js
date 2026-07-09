// Deploy quiet gate — hold the Railway deploy until external paid traffic has
// a lull, so a container swap never lands in the middle of a buyer's burst.
//
// Reads the free /api/stats surface (recentCalls: newest-first, ISO timestamps,
// paidWith: "usdc" | "proof-of-work" | "heartbeat") and waits until the most
// recent USDC-settled call is at least QUIET_SECS old. Only USDC blocks the
// gate: those calls took real money, and cutting one mid-flight is the
// "charged but didn't serve" failure. PoW callers risk only compute, and
// heartbeat entries are our own 15-minute probe.
//
// Fail-open by design — this gate must never be able to strand a deploy:
//   - stats unreachable/malformed FAILS_OPEN_AFTER times in a row → proceed
//     (prod may be down, and the deploy may be the fix)
//   - still busy after MAX_WAIT_SECS → proceed with a loud warning (the
//     in-server SIGTERM drain + RAILWAY_DEPLOYMENT_DRAINING_SECONDS still
//     protect whatever is in flight)
//   - QUIET_GATE=off → skip entirely
//
// Env: TARGET_URL (required), QUIET_SECS (180), POLL_SECS (15),
//      MAX_WAIT_SECS (1200), QUIET_GATE ("off" to skip).

const FAILS_OPEN_AFTER = 4;

/** Seconds since the most recent USDC-settled call in a /api/stats payload.
 *  Infinity when none is visible (quiet, or it aged out of the 25-row feed —
 *  either way, old). Malformed input → Infinity (fail-open, caller warns). */
export function lastPaidAgeSeconds(stats, nowMs) {
  const calls = Array.isArray(stats?.recentCalls) ? stats.recentCalls : null;
  if (!calls) return Infinity;
  let newest = -Infinity;
  for (const c of calls) {
    if (c?.paidWith !== "usdc") continue;
    const t = Date.parse(c.at);
    if (Number.isFinite(t) && t > newest) newest = t;
  }
  if (newest === -Infinity) return Infinity;
  return Math.max(0, (nowMs - newest) / 1000);
}

export function isQuiet(stats, nowMs, quietSecs) {
  return lastPaidAgeSeconds(stats, nowMs) >= quietSecs;
}

async function fetchStats(targetUrl) {
  const res = await fetch(new URL("/api/stats", targetUrl), {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`/api/stats returned HTTP ${res.status}`);
  return res.json();
}

async function main() {
  if ((process.env.QUIET_GATE || "").toLowerCase() === "off") {
    console.log("quiet gate: QUIET_GATE=off — skipping");
    return;
  }
  const targetUrl = process.env.TARGET_URL;
  if (!targetUrl) {
    console.error("quiet gate: TARGET_URL is required");
    process.exit(1);
  }
  const quietSecs = Number(process.env.QUIET_SECS) || 180;
  const pollSecs = Number(process.env.POLL_SECS) || 15;
  const maxWaitSecs = Number(process.env.MAX_WAIT_SECS) || 1200;

  console.log(`quiet gate: waiting for ${quietSecs}s without an external USDC call on ${targetUrl} (max wait ${maxWaitSecs}s)`);
  const startedAt = Date.now();
  let consecutiveFailures = 0;

  for (;;) {
    let age = null;
    try {
      const stats = await fetchStats(targetUrl);
      consecutiveFailures = 0;
      age = lastPaidAgeSeconds(stats, Date.now());
    } catch (e) {
      consecutiveFailures++;
      console.log(`quiet gate: stats fetch failed (${consecutiveFailures}/${FAILS_OPEN_AFTER}): ${e.message}`);
      if (consecutiveFailures >= FAILS_OPEN_AFTER) {
        console.log("quiet gate: stats unreachable — failing OPEN so the deploy (which may be the fix) can proceed");
        return;
      }
    }

    if (age !== null) {
      if (age >= quietSecs) {
        console.log(`quiet gate: PASS — last paid call was ${age === Infinity ? "not in the recent window" : `${Math.round(age)}s ago`}`);
        return;
      }
      console.log(`quiet gate: paid traffic ${Math.round(age)}s ago (need ${quietSecs}s of quiet) — waiting`);
    }

    if ((Date.now() - startedAt) / 1000 + pollSecs > maxWaitSecs) {
      console.log(`::warning::quiet gate: still seeing paid traffic after ${maxWaitSecs}s — proceeding anyway; the SIGTERM drain window protects in-flight calls`);
      return;
    }
    await new Promise((r) => setTimeout(r, pollSecs * 1000));
  }
}

// Run only when invoked directly (the test imports the pure helpers above).
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    // The gate itself erroring must not block a deploy.
    console.log(`::warning::quiet gate crashed (${e.message}) — failing open`);
  });
}
