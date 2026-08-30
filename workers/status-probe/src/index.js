// status-probe — Cloudflare Worker that observes agent402.tools from OUTSIDE
// production on a cron trigger, and records what it saw on /api/status/probe.
//
// Why this exists: /status is only as good as its observer, and the observer
// was a single GitHub Actions schedule. GitHub delivers a "*/15" cron roughly
// once an HOUR (measured 2026-07-27: 60-72 min gaps, plus a 3.3h stall), so a
// perfectly healthy production kept reading "degraded" — every component past
// its 45-minute staleness threshold with nobody looking. The heartbeat now
// re-probes within each run, which covers routine throttling, but nothing
// covers GitHub simply not running for hours. This does: Cloudflare cron
// triggers are a completely independent scheduler on independent infra, so a
// GitHub outage and a Cloudflare outage are not the same event.
//
// WHAT IT DELIBERATELY DOES NOT DO: the paid-call probe. That requires solving
// a 16-bit proof-of-work AND minting an X-Heartbeat-Token from POW_SECRET.
// Copying POW_SECRET onto a second platform widens the blast radius of that
// secret, and WITHOUT it every probe would be counted as genuine external
// free-tier demand — 288 synthetic calls a day against ~130 real ones, which
// would corrupt the free-tier series on /revenue outright. So paid-call stays
// the GitHub heartbeat's job, and src/status.js sizes that component's
// staleness against ITS observer, not this one.
//
// Deploy: see README.md. Requires the OPERATOR_TOKEN secret.

const REQUIRED_NETWORK = "eip155:8453"; // Base is always expected in the offer
const CATALOG_FLOOR = 400; // matches the heartbeat + sync-count floor

/** Fetch with a hard timeout so one hung endpoint can't stall the whole run. */
async function grab(url, init = {}, ms = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Observe production. Returns { components, fails } where components maps the
 * /status component keys to {ok, detail}. Any thrown error is a failed check,
 * never a failed run: an observation we could not make must be recorded as a
 * failure or not at all, never silently as success.
 */
export async function probe(prod) {
  const components = {};
  const fails = [];
  const mark = (key, ok, detail) => {
    components[key] = { ok, detail: ok ? null : detail || "failed" };
    if (!ok) fails.push(`${key}(${detail || "failed"})`);
  };

  // api — is it serving at all
  try {
    const r = await grab(`${prod}/health`);
    mark("api", r.ok, r.ok ? null : `health ${r.status}`);
  } catch (e) {
    mark("api", false, `health ${String(e?.message || e).slice(0, 60)}`);
  }

  // catalog — every route still mounted and advertised
  try {
    const r = await grab(`${prod}/api/pricing`);
    const j = await r.json();
    const n = Array.isArray(j?.endpoints) ? j.endpoints.length : 0;
    mark("catalog", n >= CATALOG_FLOOR, `${n} endpoints`);
  } catch (e) {
    mark("catalog", false, String(e?.message || e).slice(0, 60));
  }

  // mcp — the connector agents actually attach to
  try {
    const r = await grab(`${prod}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "cf-status-probe", version: "1" } },
      }),
    });
    const body = await r.text();
    mark("mcp", body.includes('"agent402"'), `mcp ${r.status}`);
  } catch (e) {
    mark("mcp", false, String(e?.message || e).slice(0, 60));
  }

  // paywall + rails — one unpaid request answers both. The paywall must be
  // ENGAGED (402, not 200: a 200 here is silent revenue loss), and the 402's
  // accepts must still carry Base, because a rail dropping out of the offer
  // loses that chain's revenue with no error anywhere.
  try {
    const r = await grab(`${prod}/api/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    const is402 = r.status === 402;
    mark("paywall", is402, `paywall ${r.status}`);
    if (!is402) {
      mark("rails", false, "no 402 to read the offer from");
    } else {
      const hdr = r.headers.get("payment-required") || "";
      let nets = [];
      try {
        const decoded = JSON.parse(atob(hdr));
        nets = (decoded?.accepts || []).map((a) => a?.network).filter(Boolean);
      } catch {
        /* fall through to the unparsed branch below */
      }
      if (!nets.length) mark("rails", false, "offer unparsed");
      else mark("rails", nets.includes(REQUIRED_NETWORK), `base missing: ${nets.join(",").slice(0, 80)}`);
    }
  } catch (e) {
    mark("paywall", false, String(e?.message || e).slice(0, 60));
    mark("rails", false, "paywall probe threw");
  }

  return { components, fails };
}

/**
 * Probe with one retry: a deploy switchover blip lasts seconds, but a recorded
 * failure ambers the whole day's bar on /status - which reads as "currently
 * degraded" against a perfectly healthy service (2026-07-29: 6 of 7 amber days
 * traced to single probes landing inside deploy restarts). Only a failure that
 * SURVIVES the pause is recorded; a real outage fails both attempts and is
 * recorded exactly as before. The first attempt's failure still goes to the
 * worker log, so the blip itself is never invisible.
 */
export async function observe(prod, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), retryDelayMs = 20000 } = {}) {
  const first = await probe(prod);
  if (!first.fails.length) return { ...first, retried: false };
  await sleep(retryDelayMs);
  const second = await probe(prod);
  console.log(`status-probe: first attempt FAILS ${first.fails.join(" ")} - after ${retryDelayMs}ms retry: ${second.fails.length ? `FAILS ${second.fails.join(" ")}` : "clean (transient blip, not recorded as down)"}`);
  return { ...second, retried: true };
}

/** POST the observation. Returns true only if production accepted it. */
async function record(prod, token, components, url) {
  const r = await grab(`${prod}/api/status/probe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Operator-Token": token },
    body: JSON.stringify({ source: "cloudflare-cron", ts: Date.now(), url, components }),
  }, 20000);
  return r.ok;
}

// ---------------------------------------------------------------------------
// Keep the GitHub heartbeat actually running.
//
// heartbeat.yml carries EIGHTEEN alarm checks - every wallet balance, Postgres
// reachability, settlement freshness, the PayAI and CDP quota watches - and it
// is the only observer for them. GitHub does not deliver its schedule:
// measured 2026-08-30, `*/15` produced gaps of 2-12 hours, and moving to a
// gentler `9,39` produced ONE run in 9.8 hours. Tuning the cron is a dead end;
// GitHub throttles scheduled events on a busy repo regardless of what is asked.
//
// This Worker's own 5-minute cron IS honoured, so it kicks the workflow when
// GitHub has not run it lately. Bounded and idempotent:
//   - it reads the last run first and only dispatches past HEARTBEAT_MAX_AGE_MIN
//   - a dispatch already in progress or queued counts as recent, so a slow run
//     is never piled on
//   - no token, no kicking: an env-gated no-op, like OPERATOR_TOKEN above
//
// The token is a FINE-GRAINED PAT scoped to this one repository with Actions
// read+write and nothing else. It cannot read code, secrets or other repos.
const HEARTBEAT_WORKFLOW = "heartbeat.yml";
const HEARTBEAT_REPO = "MikeyPetrillo/Agent402";
const HEARTBEAT_MAX_AGE_MIN_DEFAULT = 20;

async function gh(path, token, init = {}) {
  return grab(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "agent402-status-probe",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers || {}),
    },
  }, 15000);
}

/** @returns {{kicked:boolean, reason:string, ageMin:number|null}} */
export async function kickHeartbeat(env, now = Date.now()) {
  const token = env.GITHUB_DISPATCH_TOKEN;
  if (!token) return { kicked: false, reason: "no GITHUB_DISPATCH_TOKEN (kick disabled)", ageMin: null };
  const maxAge = Number(env.HEARTBEAT_MAX_AGE_MIN) || HEARTBEAT_MAX_AGE_MIN_DEFAULT;
  try {
    const r = await gh(`/repos/${HEARTBEAT_REPO}/actions/workflows/${HEARTBEAT_WORKFLOW}/runs?per_page=5`, token);
    if (!r.ok) return { kicked: false, reason: `runs read failed (${r.status})`, ageMin: null };
    const runs = (await r.json()).workflow_runs || [];
    // Anything not yet finished counts as recent - never pile onto a slow run.
    if (runs.some((x) => x.status !== "completed")) return { kicked: false, reason: "a run is already in flight", ageMin: 0 };
    const newest = runs[0] && Date.parse(runs[0].created_at);
    const ageMin = newest ? (now - newest) / 60000 : null;
    if (ageMin != null && ageMin < maxAge) return { kicked: false, reason: `last run ${ageMin.toFixed(0)}m ago`, ageMin };
    const d = await gh(`/repos/${HEARTBEAT_REPO}/actions/workflows/${HEARTBEAT_WORKFLOW}/dispatches`, token, {
      method: "POST",
      body: JSON.stringify({ ref: "main" }),
    });
    if (!d.ok) return { kicked: false, reason: `dispatch failed (${d.status})`, ageMin };
    return { kicked: true, reason: ageMin == null ? "no prior run found" : `last run ${ageMin.toFixed(0)}m ago`, ageMin };
  } catch (e) {
    return { kicked: false, reason: `error: ${String(e?.message || e).slice(0, 80)}`, ageMin: null };
  }
}

async function run(env) {
  const prod = env.PROD || "https://agent402.tools";
  if (!env.OPERATOR_TOKEN) {
    // Fail loudly in the log rather than posting unauthenticated: a silent skip
    // is exactly what let a different alarm sit dead for months.
    console.error("status-probe: OPERATOR_TOKEN is not set — refusing to probe");
    return { ok: false, error: "no OPERATOR_TOKEN" };
  }
  const { components, fails } = await observe(prod);
  // When production is unreachable this POST cannot land either. That absence
  // is the evidence: /status renders a missing observation as a gap, never as
  // uptime, so there is nothing to fake here.
  const recorded = await record(prod, env.OPERATOR_TOKEN, components, "https://github.com/MikeyPetrillo/Agent402/tree/main/workers/status-probe")
    .catch(() => false);
  // Independent of the probe result: the heartbeat must run even when we are
  // healthy, because most of what it watches is not on this page.
  const heartbeat = await kickHeartbeat(env);
  console.log(`status-probe: ${fails.length ? `FAILS ${fails.join(" ")}` : "all healthy"} | recorded=${recorded} | heartbeat ${heartbeat.kicked ? "KICKED" : "not kicked"} (${heartbeat.reason})`);
  return { ok: true, recorded, fails, components, heartbeat };
}

export default {
  // Cloudflare's scheduler. Independent of GitHub Actions by design.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(run(env));
  },
  // Manual trigger for verifying a deploy. Token-gated so this Worker cannot be
  // used by anyone else to generate observations.
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/run") return new Response("status-probe: POST /run with X-Operator-Token to trigger manually\n", { status: 200 });
    if (!env.OPERATOR_TOKEN || request.headers.get("X-Operator-Token") !== env.OPERATOR_TOKEN) {
      return new Response("unauthorized\n", { status: 401 });
    }
    const out = await run(env);
    return new Response(JSON.stringify(out, null, 2), { headers: { "Content-Type": "application/json" } });
  },
};
