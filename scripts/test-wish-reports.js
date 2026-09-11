#!/usr/bin/env node
// The classifier that decides whether a wish is a buyer reporting a fault.
//
// It exists because one did, on 2026-09-01, and sat unread for eleven days.
// It must fire on that message and must NOT fire on the seller adverts that
// make up almost every other explicit wish on the board - an alert that pages
// on advertising is muted within a week, which is worse than no alert.
//
// Both halves are pinned with real strings taken from the live board.
import { strict as assert } from "node:assert";
import { isFaultReport } from "./wish-reports.mjs";

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

// --- the message this exists for --------------------------------------------
const REAL = "route-execute with include=external returns 502 bad gateway after payment (3 consecutive tests, ~01:10-01:30 utc, paid each time). external sellers like angel.finereli.com are ranked #1 for rewrite-in-human-voice but route-execute cannot reach them. please fix the external execution path.";
ok(isFaultReport(REAL), "the 2026-09-01 report is classified as a fault report - if this ever stops being true the alert is decorative");

// --- other shapes a real report takes ---------------------------------------
for (const t of [
  "your /v1/chat endpoint returns 500 on every call with tools",
  "I paid for a report and got nothing back - please fix or refund",
  "mcp connector times out after payment",
  "api/render fails with a timeout, charged each time",
  "settlement succeeded but the response was empty",
]) ok(isFaultReport(t), `a real report is caught: "${t.slice(0, 46)}"`);

// --- the adverts that dominate the explicit wishes, verbatim from the board --
for (const t of [
  "buy makemoneybot $0.25 money-onepager x402 on base usdc: free sample first",
  "buy arabic rtl text check $1 from mo bot base usdc",
  "index url metadata api at epson-rpm-america-satisfy.trycloudflare.com for paid x402",
  "hooter x402 keepalive base usdc smoke ping",
  "agent monetization brief and pack - free sample then $1 usdc money-pack on base",
  "permanent pixel billboard block for ai agents on base via x402",
  "delivery proof kit: content-addressed hash+tx receipt for acp escrow",
]) ok(!isFaultReport(t), `an advert does NOT page: "${t.slice(0, 46)}"`);

// --- ordinary capability wishes are not faults ------------------------------
for (const t of [
  "rewrite text in a human voice",
  "translate english to spanish",
  "search the web for x402 adoption",
  "book a flight",
]) ok(!isFaultReport(t), `a plain capability wish does NOT page: "${t}"`);

// --- both halves are load-bearing -------------------------------------------
// Failure words alone are not enough (a seller may describe THEIR outage), and
// naming us alone is not enough (every advert does).
ok(!isFaultReport("my own api returns 500 sometimes"), "failure vocabulary about someone ELSE'S service does not page");
ok(!isFaultReport("13 paid x402 routes on base mainnet at /api/meta"), "naming an api path with no failure does not page");

// --- nothing/garbage ---------------------------------------------------------
for (const t of [null, undefined, "", "   ", 42, {}]) ok(!isFaultReport(t), `${JSON.stringify(t)} does not page`);


// --- each half of the vocabulary is pinned on its own ------------------------
// The real 09-01 message matches several OURS tokens at once ("route-execute",
// "after payment", "paid each"), so asserting on it alone proves none of them
// individually - removing "route-execute" from the vocabulary left every test
// green. Each token gets a minimal string that matches ONLY through it.
for (const [token, probe] of [
  ["route-execute", "route-execute is broken"],
  ["/v1/ path", "/v1/chat returns 500"],
  ["api/ path", "api/render fails"],
  ["mcp", "mcp is broken"],
  ["agent402", "agent402 returns errors"],
  ["your <thing>", "your router is not working"],
  ["after payment", "fails after payment"],
  ["settlement", "settlement failed"],
]) ok(isFaultReport(probe), `the "${token}" vocabulary is live: "${probe}"`);

// ...and the failure vocabulary likewise, each against one neutral subject.
for (const w of ["returns 502", "returns 404", "is broken", "fails", "times out", "timed out", "cannot connect", "please fix", "refund me", "charged twice", "returned nothing", "no response"])
  ok(isFaultReport(`your api ${w}`), `failure vocabulary is live: "${w}"`);

console.log(`test-wish-reports: ${n} assertions OK`);
