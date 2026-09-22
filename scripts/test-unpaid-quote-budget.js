#!/usr/bin/env node
// Hourly budget on unpaid price checks per client (src/unpaid-quote-budget.js).
//
// An unpaid request to a priced route earns a 402 with the route's challenges.
// That is free to read and every indexer starts there; the budget exists to
// stop one client walking the whole catalog many times an hour, and must never
// touch the traffic it is not about. So the pure half pins the arithmetic
// (env parsing where a typo must not switch it off, the hour window, the
// Retry-After countdown, bounded memory) and the booted half pins who is NOT
// counted, on a real paid server, because a regression there throttles a
// buyer or an indexer rather than a burst:
//
//   budget 5, one User-Agent: five unpaid requests pass, the sixth is a 429 with
//   Retry-After and a hint that points at /crawler; a POST alias and a HEAD on
//   another priced route count against the same client;
//   a request carrying a payment header, a proof-of-work solution or any
//   Authorization is never a 429 (it reaches the gates and may be a 402);
//   named indexers (x402scan, a search crawler), our own CI sweep User-Agent, a
//   signed heartbeat probe and the MCP connector's loopback are never counted;
//   a second User-Agent from the same address is its own client;
//   the discovery documents, pages and unknown paths are never budgeted;
//   /crawler quotes the budget the gate enforces and /robots.txt points at it;
//   UNPAID_QUOTE_BUDGET_PER_HOUR=off never throttles; a FREE_MODE boot never
//   throttles (no paywall there, and CI sweeps boot in that mode).
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFreePorts } from "./lib/free-port.js";

const POW_SECRET = "test-unpaid-quote-budget-secret";
process.env.POW_SECRET = POW_SECRET;
delete process.env.UNPAID_QUOTE_BUDGET_PER_HOUR;

const {
  DEFAULT_UNPAID_QUOTE_BUDGET_PER_HOUR, createUnpaidQuoteBudget, unpaidQuoteBudgetPerHour,
  hasCredentialHeader, isExemptUserAgent, isMcpLoopback, isExemptPath, secondsToHourBoundary,
} = await import("../src/unpaid-quote-budget.js");
const { crawlerPage, catalogCrawlSection } = await import("../src/crawler-page.js");
const { issueHeartbeatToken } = await import("../src/pow.js");

let pass = 0;
const procs = [];
let facilitator = null;
const dirs = [];
const cleanup = () => {
  for (const p of procs) { try { p.kill("SIGKILL"); } catch { /* gone */ } }
  try { facilitator?.close(); } catch { /* closed */ }
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } }
};
const fail = (m) => { console.error("FAIL:", m); cleanup(); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOUR = 3_600_000;

// ---- pure half -------------------------------------------------------------
ok(DEFAULT_UNPAID_QUOTE_BUDGET_PER_HOUR === 3000, "the default budget is 3000 unpaid price checks per client per hour");
ok(unpaidQuoteBudgetPerHour({}) === 3000, "unset reads as the default");
ok(unpaidQuoteBudgetPerHour({ UNPAID_QUOTE_BUDGET_PER_HOUR: "" }) === 3000, "empty reads as the default");
ok(unpaidQuoteBudgetPerHour({ UNPAID_QUOTE_BUDGET_PER_HOUR: "0" }) === 0, "\"0\" disables");
ok(unpaidQuoteBudgetPerHour({ UNPAID_QUOTE_BUDGET_PER_HOUR: "off" }) === 0 && unpaidQuoteBudgetPerHour({ UNPAID_QUOTE_BUDGET_PER_HOUR: " OFF " }) === 0, "\"off\" disables, case and spaces ignored");
ok(unpaidQuoteBudgetPerHour({ UNPAID_QUOTE_BUDGET_PER_HOUR: "abc" }) === 3000, "a malformed value reads as unset, never as off");
ok(unpaidQuoteBudgetPerHour({ UNPAID_QUOTE_BUDGET_PER_HOUR: "-5" }) === 3000, "a negative value reads as unset, never as off");
ok(unpaidQuoteBudgetPerHour({ UNPAID_QUOTE_BUDGET_PER_HOUR: "12.7" }) === 12 && unpaidQuoteBudgetPerHour({ UNPAID_QUOTE_BUDGET_PER_HOUR: "5" }) === 5, "a positive value is taken, whole requests");

ok(secondsToHourBoundary(10 * HOUR + HOUR - 1000) === 1, "Retry-After one second before the hour is 1");
ok(secondsToHourBoundary(10 * HOUR) === 3600, "Retry-After exactly on the hour is the whole hour");
ok(secondsToHourBoundary(10 * HOUR + 1) === 3600 && secondsToHourBoundary(10 * HOUR + 1800_000) === 1800, "Retry-After counts down to the top of the hour");

{
  const b = createUnpaidQuoteBudget({ budget: 2, isPriced: () => true });
  const t0 = 50 * HOUR + 10_000;
  const r1 = b.hit("a", t0), r2 = b.hit("a", t0 + 1), r3 = b.hit("a", t0 + 2);
  ok(!r1.limited && !r2.limited && r3.limited && r3.count === 3, "budget 2: the third request in the hour is limited");
  ok(!b.hit("b", t0 + 3).limited, "a different key has its own count");
  ok(!b.hit("a", t0 + HOUR).limited, "the count resets when the UTC hour turns");
  const off = createUnpaidQuoteBudget({ budget: 0, isPriced: () => true });
  let limited = false;
  for (let i = 0; i < 50; i++) limited = limited || off.hit("a", t0 + i).limited;
  ok(!limited, "budget 0 never limits");
}
{
  const b = createUnpaidQuoteBudget({ budget: 10, isPriced: () => true, keyCap: 3 });
  const t = 60 * HOUR;
  b.hit("k1", t); b.hit("k2", t); b.hit("k3", t);
  b.hit("k1", t);          // k1 is now the most recently seen
  b.hit("k4", t);          // over the cap: the least recently seen (k2) goes
  ok(b.stats().clientsThisHour === 3, "memory is bounded at the key cap");
  ok(b.hit("k2", t).count === 1 && b.hit("k1", t).count === 3, "the least recently seen key is dropped first, an active one is kept");
}
ok(hasCredentialHeader({ "payment-signature": "x" }) && hasCredentialHeader({ "x-payment": "x" }) && hasCredentialHeader({ authorization: "Bearer junk" }) && hasCredentialHeader({ "x-pow-solution": "a:b" }), "payment-signature, x-payment, any Authorization and x-pow-solution each mark a request as not a price check");
ok(!hasCredentialHeader({}) && !hasCredentialHeader({ authorization: "  " }) && !hasCredentialHeader({ "user-agent": "x" }), "an absent or blank header is not a credential");
ok(isExemptUserAgent("x402scan/1.0") && isExemptUserAgent("Mozilla/5.0 (compatible; Googlebot/2.1)") && isExemptUserAgent("agent402-ci-sweep/1.0 (+https://agent402.tools/crawler)"), "named indexers, search crawlers and our own User-Agents are exempt");
ok(!isExemptUserAgent("curl/8.4") && !isExemptUserAgent("") && !isExemptUserAgent("python-httpx/0.27"), "an unnamed client is not exempt");
ok(isMcpLoopback({ headers: { "x-agent402-via": "mcp" }, socket: { remoteAddress: "127.0.0.1" } }) && isMcpLoopback({ headers: { "x-agent402-via": "MCP" }, socket: { remoteAddress: "::ffff:127.0.0.1" } }), "the MCP connector's loopback is recognized");
ok(!isMcpLoopback({ headers: { "x-agent402-via": "mcp" }, socket: { remoteAddress: "10.0.0.5" } }), "the loopback marker from a non-local socket is ignored (the header alone is caller-settable)");
ok(!isMcpLoopback({ headers: {}, socket: { remoteAddress: "127.0.0.1" } }), "a local socket without the marker is not the connector");
ok(isExemptPath("/mcp") && isExemptPath("/api/pricing") && isExemptPath("/openapi.json") && isExemptPath("/.well-known/x402") && !isExemptPath("/api/uuid"), "/mcp and the discovery surfaces are exempt paths, a tool route is not");

{
  const b = createUnpaidQuoteBudget({ budget: 1, isPriced: (m, p) => m === "GET" && p === "/api/uuid" });
  const req = (over = {}) => ({ method: "GET", path: "/api/uuid", headers: { "user-agent": "walker/1" }, socket: { remoteAddress: "10.0.0.9" }, ...over });
  ok(b.isCounted(req()), "an unpaid GET on a priced route is counted");
  ok(b.isCounted(req({ method: "HEAD" })) && b.isCounted(req({ method: "POST" })), "HEAD and a POST alias on a priced route are counted");
  ok(!b.isCounted(req({ method: "PUT" })) && !b.isCounted(req({ method: "OPTIONS" })), "methods no gate chain serves are not counted");
  ok(!b.isCounted(req({ path: "/tools" })) && !b.isCounted(req({ path: "/api/not-a-tool" })), "a page and an unpriced path are not counted");
  const synth = createUnpaidQuoteBudget({ budget: 1, isPriced: () => true, isSynthetic: (r) => r.headers["x-heartbeat-token"] === "yes" });
  ok(!synth.isCounted(req({ headers: { "user-agent": "walker/1", "x-heartbeat-token": "yes" } })), "a signed probe of our own is not counted");
  const broken = createUnpaidQuoteBudget({ budget: 1, isPriced: () => true, isSynthetic: () => { throw new Error("boom"); } });
  ok(broken.isCounted(req()), "an unreadable synthetic check counts the request (an unverified token is not ours)");
}

{
  const page = crawlerPage("https://x.test", { unpaidQuoteBudget: 1234 });
  ok(page.includes("Crawling this catalog") && page.includes('id="crawling-this-catalog"'), "/crawler carries the section, anchored");
  ok(page.includes("Past 1,234 in an hour"), "/crawler quotes the budget it is handed, formatted");
  ok(page.includes("If-None-Match") && page.includes("/api/pricing") && page.includes("/.well-known/x402"), "/crawler names the three documents and the conditional read");
  ok(!/\u2014|\u2013/.test(catalogCrawlSection(1234).p.join(" ")), "the section carries no em or en dashes");
  ok(crawlerPage("https://x.test", { unpaidQuoteBudget: 0 }).includes("sets no hourly budget"), "with the budget off the page says no budget is enforced, never a number");
  ok(crawlerPage("https://x.test").includes(`Past ${DEFAULT_UNPAID_QUOTE_BUDGET_PER_HOUR.toLocaleString("en-US")} in an hour`), "with no figure handed in, the page derives the gate's own default");
}

// ---- booted half -----------------------------------------------------------
// A count that straddles the hour would reset mid-test: start clear of it.
if (secondsToHourBoundary() < 90) {
  const wait = secondsToHourBoundary() * 1000 + 2000;
  console.log(`(waiting ${Math.round(wait / 1000)} s for the hour to turn so the count cannot reset mid-test)`);
  await sleep(wait);
}

const [PAID, OFF, FREE, FAC] = await getFreePorts(4);
facilitator = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} }));
});
await new Promise((r) => facilitator.listen(FAC, "127.0.0.1", r));

const quiet = {
  X402_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off",
  FREE_ALERTS: "off", FOLLOWUPS: "off", WALLET_DIGEST: "off", SOLANA_LEADERBOARD: "off",
};
const paidEnv = {
  FREE_MODE: "", WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
  FACILITATOR_URL: `http://127.0.0.1:${FAC}`, CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYMENT_NETWORKS: "base",
  MPP_SECRET_KEY: "",
  // A paid boot needs the facilitator handshake (against the local stub above)
  // or @x402/core answers 500 where it should build a 402; the leaderboard's
  // first chain refresh is pushed past the test so the boot makes no RPC reads.
  X402_SYNC_ON_START: "", LEADERBOARD_FIRST_REFRESH_DELAY_MS: "3600000",
};
function boot(port, env) {
  const trafficDir = mkdtempSync(join(tmpdir(), "a402-unpaid-budget-"));
  dirs.push(trafficDir);
  const p = spawn(process.execPath, ["src/server.js"], {
    env: { ...process.env, ...quiet, PORT: String(port), POW_SECRET, TRAFFIC_DIR: trafficDir, AGENT402_OPERATOR_TOKEN: "test-unpaid-budget-operator", ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  p.__log = "";
  p.stderr.on("data", (b) => { p.__log = (p.__log + b.toString()).slice(-4000); });
  procs.push(p);
  return p;
}
async function waitUp(base, p) {
  for (let i = 0; i < 180; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* booting */ }
    await sleep(500);
  }
  fail(`server at ${base} never answered /health\n${p.__log}`);
}
const call = (base, path, { method = "GET", ua = "budget-walker/1.0", headers = {}, body } = {}) =>
  fetch(`${base}${path}`, { method, headers: { "user-agent": ua, ...(body ? { "content-type": "application/json" } : {}), ...headers }, body });

const pPaid = boot(PAID, { ...paidEnv, UNPAID_QUOTE_BUDGET_PER_HOUR: "5" });
const pOff = boot(OFF, { ...paidEnv, UNPAID_QUOTE_BUDGET_PER_HOUR: "off" });
const pFree = boot(FREE, { FREE_MODE: "true", UNPAID_QUOTE_BUDGET_PER_HOUR: "5" });
const P = `http://127.0.0.1:${PAID}`, O = `http://127.0.0.1:${OFF}`, F = `http://127.0.0.1:${FREE}`;

try {
  await Promise.all([waitUp(P, pPaid), waitUp(O, pOff), waitUp(F, pFree)]);

  // Budget 5 from one client.
  const firstFive = [];
  for (let i = 0; i < 5; i++) firstFive.push((await call(P, "/api/uuid")).status);
  ok(firstFive.every((s) => s !== 429), `the first five unpaid price checks pass (got ${firstFive.join(",")})`);
  ok(firstFive.every((s) => s === 402), `and they are the paywall's own 402s (got ${firstFive.join(",")})`);
  const sixth = await call(P, "/api/uuid");
  ok(sixth.status === 429, `the sixth unpaid price check from the same client is a 429 (got ${sixth.status})`);
  const ra = Number(sixth.headers.get("retry-after"));
  ok(Number.isInteger(ra) && ra >= 1 && ra <= 3600, `the 429 carries Retry-After in seconds to the hour (got ${sixth.headers.get("retry-after")})`);
  const body = await sixth.json();
  ok(body.ok === false && body.error === "rate-limited", "the 429 body says rate-limited");
  ok(typeof body.hint === "string" && body.hint.includes("/crawler") && body.hint.includes("unpaid price checks") && body.hint.includes("budget 5"), "the hint names unpaid price checks, the budget and /crawler");
  ok(body.retryAfterSeconds === ra, "retryAfterSeconds matches the header");
  ok(!sixth.headers.get("payment-required"), "a throttled request is answered before the paywall builds a challenge");
  ok((await call(P, "/api/uuid", { method: "POST", body: "{}" })).status === 429, "a POST alias on the same priced route counts against the same client");
  ok((await call(P, "/api/hash", { method: "HEAD" })).status === 429, "a HEAD on another priced route counts against the same client");

  // Requests that carry something are never budgeted.
  const paidTry = await call(P, "/api/uuid", { headers: { "payment-signature": "bm90LWEtcGF5bWVudA" } });
  ok(paidTry.status !== 429 && paidTry.status === 402, `a request with a payment-signature header is never a 429 (got ${paidTry.status})`);
  const xpay = await call(P, "/api/uuid", { headers: { "x-payment": "bm90LWEtcGF5bWVudA" } });
  ok(xpay.status !== 429, `a request with an x-payment header is never a 429 (got ${xpay.status})`);
  const pow = await call(P, "/api/uuid", { headers: { "x-pow-solution": "not-a-token:1" } });
  ok(pow.status !== 429, `a request with a proof-of-work solution is never a 429 (got ${pow.status})`);
  const bearer = await call(P, "/api/uuid", { headers: { authorization: "Bearer a402_notarealkey" } });
  ok(bearer.status !== 429, `a request with any Authorization is never a 429 (got ${bearer.status})`);

  // Named clients and our own traffic are never budgeted.
  for (const [label, ua] of [["an x402scan", "x402scan-indexer/2.0"], ["our CI sweep", "agent402-ci-sweep/1.0 (+https://agent402.tools/crawler)"], ["a search crawler", "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"]]) {
    const got = [];
    for (let i = 0; i < 9; i++) got.push((await call(P, "/api/uuid", { ua })).status);
    ok(got.every((s) => s !== 429), `${label} User-Agent is never throttled (9 requests, got ${[...new Set(got)].join(",")})`);
  }
  const hb = [];
  for (let i = 0; i < 8; i++) hb.push((await call(P, "/api/uuid", { headers: { "x-heartbeat-token": issueHeartbeatToken() } })).status);
  ok(hb.every((s) => s !== 429), `a signed heartbeat probe from the throttled client is never budgeted (got ${[...new Set(hb)].join(",")})`);
  const forged = await call(P, "/api/uuid", { headers: { "x-heartbeat-token": "forged-token-value-000000000000" } });
  ok(forged.status === 429, `a forged heartbeat token is counted like any other request (got ${forged.status})`);
  const mcp = await call(P, "/api/uuid", { headers: { "x-agent402-via": "mcp" } });
  ok(mcp.status !== 429, `the MCP connector's loopback (local socket + marker) is not budgeted (got ${mcp.status})`);

  // One address, two programs: two clients.
  const other = await call(P, "/api/uuid", { ua: "other-walker/2.0" });
  ok(other.status === 402, `a different User-Agent from the same address has its own count (got ${other.status})`);

  // Discovery, pages and unpriced paths stay open to the throttled client.
  for (const path of ["/api/pricing", "/openapi.json", "/.well-known/x402", "/llms.txt", "/health"]) {
    const r = await call(P, path);
    ok(r.status === 200, `${path} is never throttled (got ${r.status})`);
  }
  ok((await call(P, "/api/pricing", { method: "HEAD" })).status === 200, "a HEAD on /api/pricing is never throttled");
  const miss = await call(P, "/api/this-is-not-a-tool");
  ok(miss.status !== 429, `an unpriced /api path is never budgeted (got ${miss.status})`);
  const crawler = await call(P, "/crawler");
  const crawlerHtml = await crawler.text();
  ok(crawler.status === 200 && crawlerHtml.includes("Past 5 in an hour"), "/crawler quotes the budget the running gate enforces");
  const robots = await (await call(P, "/robots.txt")).text();
  ok(robots.includes(`${P}/crawler`) && /^# Crawling this catalog/m.test(robots), "/robots.txt points crawlers at /crawler");

  // The operator read carries counts only.
  const op = await (await fetch(`${P}/__operator/traffic.json?days=1`, { headers: { authorization: "Bearer test-unpaid-budget-operator" } })).json();
  const ub = op.unpaidQuoteBudget || {};
  ok(ub.budget === 5 && ub.throttledSinceBoot === 4 && ub.clientsThrottledThisHour === 1 && ub.clientsThisHour === 2, `the operator traffic read reports the budget and throttled counts (got ${JSON.stringify(ub)})`);
  ok(!/127\.0\.0\.1|::1|budget-walker/.test(JSON.stringify(ub)), "the operator figures carry no address and no User-Agent");

  // Budget off: never throttles.
  const offGot = [];
  for (let i = 0; i < 9; i++) offGot.push((await call(O, "/api/uuid")).status);
  ok(offGot.every((s) => s !== 429), `UNPAID_QUOTE_BUDGET_PER_HOUR=off never throttles (got ${[...new Set(offGot)].join(",")})`);
  ok((await (await call(O, "/crawler")).text()).includes("sets no hourly budget"), "with the budget off, /crawler says so instead of quoting a number");

  // FREE_MODE: never throttles, even with a budget set.
  const freeGot = [];
  for (let i = 0; i < 9; i++) freeGot.push((await call(F, "/api/uuid")).status);
  ok(freeGot.every((s) => s !== 429), `a FREE_MODE boot never throttles (got ${[...new Set(freeGot)].join(",")})`);
  ok(freeGot.every((s) => s === 200), `and FREE_MODE still serves the tool (got ${[...new Set(freeGot)].join(",")})`);

  console.log(`\nPASS - ${pass} checks (unpaid price-check budget)`);
  cleanup();
  process.exit(0);
} catch (e) {
  fail(e?.stack || String(e));
}
