// Offline unit test for the /status probe store and its aggregation.
//
// The properties worth pinning are the honesty ones. A status page is easy to
// make look good by accident: count an unmeasured day as green, report 100%
// from two samples, or call a component "operational" on the strength of an
// observation from yesterday. Each of those is asserted against here.
//
// Run: node scripts/test-status-store.js
import { existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "a402-status-"));
process.env.STATUS_DB_PATH = join(dir, "status.db");

const {
  recordProbe, recordProbes, probeRows, latestByComponent, totalObservations, earliestObservation,
  uptimeFrom, dailyFrom, incidentsFrom, stateFrom, _resetForTest,
} = await import("../src/status-store.js");

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log(`ok - ${name}`); }
  else { fail++; console.error(`FAIL - ${name}`); }
};

const DAY = 86400000;
const NOW = Date.UTC(2026, 6, 25, 12, 0, 0); // 2026-07-25T12:00:00Z

// ── Pure aggregation ─────────────────────────────────────────────────────────
{
  const u = uptimeFrom([{ ok: 1 }, { ok: 1 }, { ok: 0 }, { ok: 1 }]);
  check("uptime counts up/down and percentage", u.observed === 4 && u.up === 3 && u.down === 1 && Math.abs(u.pct - 75) < 1e-9);
  check("uptime over nothing is null, never 100", uptimeFrom([]).pct === null);
}

// A day we never probed must not render as uptime.
{
  const rows = [{ ts: NOW - 1 * DAY, ok: 1 }, { ts: NOW - 1 * DAY + 1000, ok: 1 }];
  const d = dailyFrom(rows, { days: 4, nowMs: NOW });
  check("daily returns one bucket per requested day", d.length === 4);
  const measured = d.find((x) => x.observed > 0);
  const unmeasured = d.filter((x) => x.observed === 0);
  check("a measured day reports 100% from 2 observations", measured.pct === 100 && measured.observed === 2);
  check("unmeasured days are pct null, NOT 100", unmeasured.length === 3 && unmeasured.every((x) => x.pct === null));
  check("every bucket carries its observation count (denominator visible)", d.every((x) => typeof x.observed === "number"));
}

{
  const rows = [{ ts: NOW - 2000, ok: 1 }, { ts: NOW - 1000, ok: 0 }];
  const d = dailyFrom(rows, { days: 1, nowMs: NOW });
  check("a day with one failure is not 100%", d[0].pct === 50 && d[0].down === 1);
}

// ── Incidents ────────────────────────────────────────────────────────────────
{
  const rows = [
    { ts: NOW - 10 * 3600_000, ok: 1 },
    { ts: NOW - 9 * 3600_000, ok: 0, detail: "/health" },
    { ts: NOW - 9 * 3600_000 + 900_000, ok: 0 },
    { ts: NOW - 8 * 3600_000, ok: 1 },
    { ts: NOW - 1 * 3600_000, ok: 0, detail: "mcp" },
  ];
  const inc = incidentsFrom(rows);
  check("consecutive failures collapse into one incident", inc.length === 2);
  check("incidents are newest first", inc[0].startedAt > inc[1].startedAt);
  check("a grouped incident counts its probes and duration", inc[1].probes === 2 && inc[1].durationMs === 900_000);
  check("a lone failed probe still counts as an incident", inc[0].probes === 1);
  check("incident keeps the failure detail", inc[1].detail === "/health");
  check("all-ok history yields no incidents", incidentsFrom([{ ts: 1, ok: 1 }, { ts: 2, ok: 1 }]).length === 0);
}

// Failures far apart are separate incidents, not one long one.
{
  const rows = [{ ts: NOW - 20 * 3600_000, ok: 0 }, { ts: NOW - 2 * 3600_000, ok: 0 }];
  check("failures separated by more than the gap are distinct incidents", incidentsFrom(rows).length === 2);
}

// ── Current state ────────────────────────────────────────────────────────────
{
  check("no observation ever is 'unknown'", stateFrom(null, { nowMs: NOW }).state === "unknown");
  check("a fresh ok observation is operational", stateFrom({ ts: NOW - 60_000, ok: 1 }, { nowMs: NOW }).state === "operational");
  check("a fresh failed observation is an outage", stateFrom({ ts: NOW - 60_000, ok: 0 }, { nowMs: NOW }).state === "outage");
  const stale = stateFrom({ ts: NOW - 6 * 3600_000, ok: 1 }, { nowMs: NOW });
  check("a STALE ok observation is 'unknown', not 'operational'", stale.state === "unknown" && /recent/.test(stale.reason));
}

// ── Persistence ──────────────────────────────────────────────────────────────
{
  recordProbe({ ts: NOW - 3000, source: "heartbeat", component: "api", ok: true });
  recordProbe({ ts: NOW - 2000, source: "heartbeat", component: "api", ok: false, detail: "/health", url: "https://example.test/run/1" });
  check("rows persist and read back in time order", probeRows("api", 0).length === 2 && probeRows("api", 0)[0].ts < probeRows("api", 0)[1].ts);

  // Idempotency is what makes re-running the backfill safe.
  const before = totalObservations();
  recordProbe({ ts: NOW - 3000, source: "heartbeat", component: "api", ok: true });
  check("duplicate (source, component, ts) is ignored", totalObservations() === before);

  const written = recordProbes([
    { ts: NOW - 5000, source: "backfill", component: "api", ok: true },
    { ts: NOW - 4000, source: "backfill", component: "api", ok: true },
    { ts: NOW - 5000, source: "backfill", component: "api", ok: true }, // dup within the batch
  ]);
  check("batch insert reports only genuinely new rows", written === 2);

  check("earliest observation is the oldest ts", earliestObservation() === NOW - 5000);
  check("sinceMs filter excludes older rows", probeRows("api", NOW - 2500).length === 1);

  recordProbe({ ts: NOW - 1000, source: "heartbeat", component: "mcp", ok: true });
  const latest = latestByComponent();
  check("latestByComponent returns one row per component", latest.length === 2 && latest.some((r) => r.component === "mcp"));
  const api = latest.find((r) => r.component === "api");
  check("latest row is the newest for that component", api.ts === NOW - 2000 && api.ok === 0);
  check("failure detail round-trips through storage", api.detail === "/health");
}

// ── Per-component staleness (src/status.js) ──────────────────────────────────
// The paid canary runs once a day. Judging it by the heartbeat's 45-minute
// threshold would leave settlement reading "unknown" for 23 hours out of 24 and
// drag the whole page to "degraded" — a cadence mismatch dressed up as an
// incident. Each component carries the threshold that matches its observer.
{
  const { COMPONENTS } = await import("../src/status.js");
  const byKey = Object.fromEntries(COMPONENTS.map((c) => [c.key, c]));
  check("every component declares a staleness threshold", COMPONENTS.every((c) => Number.isFinite(c.staleAfterMs)));
  check("heartbeat-fed components use a ~45 min threshold", byKey.api.staleAfterMs === 45 * 60_000);
  check("the daily canary component tolerates over 24h", byKey.settlement.staleAfterMs > 24 * 3600_000);

  const dayOld = { ts: NOW - 20 * 3600_000, ok: 1 };
  check("a 20h-old canary result is still operational under its own threshold",
    stateFrom(dayOld, { nowMs: NOW, staleAfterMs: byKey.settlement.staleAfterMs }).state === "operational");
  check("the same 20h-old result WOULD be unknown under the heartbeat threshold",
    stateFrom(dayOld, { nowMs: NOW, staleAfterMs: byKey.api.staleAfterMs }).state === "unknown");
  check("a canary result older than its threshold is still unknown",
    stateFrom({ ts: NOW - 30 * 3600_000, ok: 1 }, { nowMs: NOW, staleAfterMs: byKey.settlement.staleAfterMs }).state === "unknown");
}

// ── Overall rollup (src/status.js) ───────────────────────────────────────────
{
  const { overallState } = await import("../src/status.js");
  const c = (state, observed = 10) => ({ observed, current: { state } });
  check("all operational rolls up to operational", overallState([c("operational"), c("operational")]) === "operational");
  check("one outage dominates everything else", overallState([c("operational"), c("outage")]) === "outage");
  check("a mix of fresh and stale is degraded", overallState([c("operational"), c("unknown")]) === "degraded");
  check("ALL stale is 'unknown', not 'degraded' (we don't know, vs we know it's bad)", overallState([c("unknown"), c("unknown")]) === "unknown");
  check("never-observed components do not vote", overallState([c("operational"), c("outage", 0)]) === "operational");
  check("nothing observed at all is unknown", overallState([c("unknown", 0)]) === "unknown");
}

_resetForTest();
try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
check("scratch DB cleaned up", !existsSync(join(dir, "status.db")));

console.log(`\ntest-status-store: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
