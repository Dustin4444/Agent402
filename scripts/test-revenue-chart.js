#!/usr/bin/env node
// Offline test: the /revenue chart's free-tier (proof-of-work) lane.
//
// Free calls settle nowhere, so they are invisible to the settlement ledger the
// rest of the chart is built from — they come from a second endpoint and are
// merged client-side. The invariants that matter:
//
//   * a free call earns $0, so the free lane must NEVER appear under the
//     "Revenue $" metric (drawing it there would inflate revenue by call count)
//   * picking one of the two mutually-exclusive controls corrects the other,
//     rather than rendering a meaningless combination
//   * free tier is not a chain, so it never takes a chain colour
//   * a failure of the free endpoint must not blank the revenue chart
//
// Runs the real page script in jsdom against stubbed endpoints.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { revenueChartSection } from "../src/revenue-live.js";

// CSP hardening (2026-08-16) moved the chart's IIFE out of an inline <script>
// into assets/js/revenue-chart.js, referenced via <script src>. jsdom does
// not fetch external script resources in this offline test (no server, no
// resourceLoader configured) - so the real file's content is inlined back in
// before parsing, exactly simulating what a browser does when it loads that
// src. This keeps testing the REAL file (no drift risk from a copy) while
// still running fully offline.
const REVENUE_CHART_JS = readFileSync(new URL("../assets/js/revenue-chart.js", import.meta.url), "utf8");
function inlineRevenueChartScript(html) {
  const tag = '<script src="/js/revenue-chart.js"></script>';
  if (!html.includes(tag)) throw new Error("revenueChartSection() no longer references /js/revenue-chart.js - did the src path change?");
  return html.replace(tag, `<script>${REVENUE_CHART_JS}</script>`);
}

const REV_DAYS = [
  // Base day carries a SOR (spending-wallet-settled) subset: $0.50 of the $1.50.
  { day: "2026-06-20", chain: "base", extUsd: 1.5, intUsd: 0.2, extTx: 3, intTx: 1, extMppUsd: 0, intMppUsd: 0, extMppTx: 0, intMppTx: 0, extSorUsd: 0.5, extSorTx: 1, intSorUsd: 0, intSorTx: 0 },
  { day: "2026-06-21", chain: "solana", extUsd: 0.5, intUsd: 0, extTx: 2, intTx: 0, extMppUsd: 0, intMppUsd: 0, extMppTx: 0, intMppTx: 0, extSorUsd: 0, extSorTx: 0, intSorUsd: 0, intSorTx: 0 },
  // Internal-only canary buys on rails outside the 8 named palette slots —
  // they fold into "Other" on the chart but must stay itemized there.
  { day: "2026-06-21", chain: "sei", extUsd: 0, intUsd: 0.003, extTx: 0, intTx: 3, extMppUsd: 0, intMppUsd: 0, extMppTx: 0, intMppTx: 0, extSorUsd: 0, extSorTx: 0, intSorUsd: 0, intSorTx: 0 },
  { day: "2026-06-21", chain: "optimism", extUsd: 0, intUsd: 0.002, extTx: 0, intTx: 2, extMppUsd: 0, intMppUsd: 0, extMppTx: 0, intMppTx: 0, extSorUsd: 0, extSorTx: 0, intSorUsd: 0, intSorTx: 0 },
];
const BUYER_DAYS = [
  { day: "2026-06-20", buyers: 3, newBuyers: 3, returningBuyers: 0, cumulative: 3, unattributed: 0 },
  { day: "2026-06-21", buyers: 4, newBuyers: 1, returningBuyers: 3, cumulative: 4, unattributed: 0 },
];
const CONC = { buyers: 4, payments: 40, topSharePct: 55.0, top5SharePct: 100 };
const FREE_DAYS = [
  { day: "2026-06-20", usdc: 4, pow: 40, heartbeat: 2 },
  { day: "2026-06-21", usdc: 2, pow: 60, heartbeat: 1 },
];

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

async function boot({ freeFails = false } = {}) {
  const html = `<!doctype html><html><body>${inlineRevenueChartScript(revenueChartSection())}</body></html>`;
  // fetch must exist BEFORE the inline script runs, so the chart's own IIFE is
  // the one under test — re-evaluating it afterwards would double every
  // listener and make the segmented controls toggle twice per click.
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(w) {
      w.fetch = (url) => {
        if (String(url).includes("/api/revenue/daily")) return Promise.resolve({ json: () => Promise.resolve({ days: REV_DAYS, buyers: BUYER_DAYS, concentration: CONC }) });
        if (String(url).includes("/api/calls/daily")) {
          return freeFails ? Promise.reject(new Error("down"))
            : Promise.resolve({ json: () => Promise.resolve({ days: FREE_DAYS, recordingSince: "2026-06-20" }) });
        }
        return Promise.resolve({ json: () => Promise.resolve({}) });
      };
    },
  });
  await new Promise((r) => setTimeout(r, 80));
  return dom.window;
}

const click = (w, segId, v) => {
  const b = w.document.querySelector(`#${segId} button[data-v="${v}"]`);
  assert.ok(b, `${segId} has no "${v}" button`);
  b.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
};
const activeOf = (w, segId) => w.document.querySelector(`#${segId} button.on`)?.dataset.v;
const legend = (w) => w.document.getElementById("rvzLegend").textContent;

console.log("revenue chart — free-tier lane");

{
  const w = await boot();

  check("default view is paid revenue, no free lane", () => {
    assert.equal(activeOf(w, "rvzTraffic"), "paid");
    assert.equal(activeOf(w, "rvzMetric"), "usd");
    assert.ok(!legend(w).includes("Free tier"), "free lane must not show under Revenue $");
  });

  check("choosing Free forces the metric off Revenue $ (a free call earns $0)", () => {
    click(w, "rvzTraffic", "free");
    assert.equal(activeOf(w, "rvzMetric"), "tx", "metric must switch to Transactions");
    assert.ok(legend(w).includes("Free tier"), "free lane should be charted");
  });

  check("the free lane carries the real counts", () => {
    const txt = w.document.getElementById("rvzTable").textContent;
    // cumulative mode: 40 then 40+60=100
    assert.ok(txt.includes("100"), `expected cumulative 100 free calls, got: ${txt.slice(0, 200)}`);
  });

  check("free tier never takes a chain colour", () => {
    const html = w.document.getElementById("rvzLegend").innerHTML;
    const m = html.match(/background:\s*([^;"]+)/);
    assert.ok(m, "legend swatch has no colour");
    // --sfree resolves to the neutral grey, never a chain slot colour.
    assert.ok(!/#2a78d6|#eb6834|#1baf7a/i.test(html), "free lane used a chain colour");
  });

  check("switching back to Revenue $ forces traffic back to Paid", () => {
    click(w, "rvzMetric", "usd");
    assert.equal(activeOf(w, "rvzTraffic"), "paid", "Revenue $ must imply paid-only");
    assert.ok(!legend(w).includes("Free tier"));
  });

  check("Both shows chains and the free lane together", () => {
    click(w, "rvzTraffic", "both");
    const l = legend(w);
    assert.ok(l.includes("Free tier"), "free lane missing");
    assert.ok(l.includes("Base") || l.includes("Solana"), "chain lanes missing");
  });

  check("External view says WHEN canary settlements exist but are hidden", () => {
    // The chart defaults to External, which is right: the canary buys from us
    // with our own wallet and must never inflate revenue. But that made "the
    // canary stopped running" and "the canary is filtered out" look identical
    // on screen, and the default view was read as the former on a day the
    // canary had settled on 11 of 12 rails.
    click(w, "rvzTraffic", "paid");
    click(w, "rvzScope", "ext");
    const n = w.document.getElementById("rvzScopeNote");
    assert.notEqual(n.style.display, "none", "note must show when internal traffic exists and is hidden");
    assert.ok(/canary/i.test(n.textContent), "note must name the canary");
    assert.ok(/Internal|Both/.test(n.textContent), "note must name the control that reveals them");
    assert.ok(/own wallet|excluded from revenue/i.test(n.textContent),
      "note must say WHY they are excluded, or it reads as a bug rather than a choice");
  });

  check("the note disappears once the canary is actually on screen", () => {
    click(w, "rvzScope", "both");
    const n = w.document.getElementById("rvzScopeNote");
    assert.equal(n.style.display, "none", "nothing is hidden, so there is nothing to disclose");
    // Restore what these two checks changed. These cases share one jsdom
    // window, so a control left flipped is read by the NEXT check as the
    // page's own behaviour - it made the free-note case fail on a note that
    // was working perfectly.
    click(w, "rvzScope", "ext");
    click(w, "rvzTraffic", "both");
  });

  check("the note explains the $0 rule and when recording began", () => {
    const n = w.document.getElementById("rvzFreeNote");
    assert.notEqual(n.style.display, "none");
    assert.ok(/\$0/.test(n.textContent), "note must say free calls earn $0");
    assert.ok(n.textContent.includes("2026-06-20"), "note must name the recording-since date");
    assert.ok(/heartbeat/i.test(n.textContent), "note must say heartbeat probes are excluded");
  });
}

{
  const w = await boot({ freeFails: true });
  check("a free-endpoint outage never blanks the revenue chart", () => {
    assert.ok(legend(w).includes("Base") || legend(w).includes("Solana"), "revenue lanes should still render");
    const wrap = w.document.querySelector(".rvz-wrap").innerHTML;
    assert.ok(!wrap.includes("series unavailable"), "revenue chart was blanked by the free endpoint failing");
  });
}

{
  const w = await boot();
  check("Buyers shows new and returning lanes, not chains", () => {
    click(w, "rvzMode", "daily");
    click(w, "rvzMetric", "buyers");
    const l = legend(w);
    assert.ok(l.includes("New buyers"), "new-buyer lane missing");
    assert.ok(l.includes("Returning buyers"), "returning lane missing");
    assert.ok(!l.includes("Base") && !l.includes("Solana"), "buyers must not be split by chain");
  });

  check("cumulative buyers is the server union, never a sum of daily counts", () => {
    click(w, "rvzMode", "cum");
    const txt = w.document.getElementById("rvzTable").textContent;
    // Daily counts are 3 and 4; summing them would render 7. The true distinct
    // total is 4, which is what the server's cumulative field carries.
    assert.ok(txt.includes("4"), "expected the union value 4");
    assert.ok(!/\b7\b/.test(txt), `summed daily counts leaked into the cumulative view: ${txt.slice(0, 160)}`);
  });

  check("the note answers the concentration question with real numbers", () => {
    const n = w.document.getElementById("rvzBuyersNote");
    assert.notEqual(n.style.display, "none");
    assert.ok(n.textContent.includes("55"), "top-wallet share missing");
    assert.ok(/union/i.test(n.textContent), "must explain the cumulative is a union");
  });

  check("picking an internal scope leaves the buyers view rather than lying", () => {
    click(w, "rvzScope", "int");
    assert.equal(w.document.querySelector("#rvzMetric button.on").dataset.v, "tx",
      "buyers is external-only; an internal scope must switch the metric");
  });

  check("Buyers forces traffic back to paid (a free call has no buyer wallet)", () => {
    click(w, "rvzTraffic", "free");
    click(w, "rvzMetric", "buyers");
    assert.equal(w.document.querySelector("#rvzTraffic button.on").dataset.v, "paid");
  });
}

console.log("revenue chart — settled-to (SOR) lane");

{
  const w = await boot();

  check("SOR lane is the spending-wallet subset ($0.50 of $1.50)", () => {
    click(w, "rvzSettle", "sor");
    const txt = w.document.getElementById("rvzTable").textContent;
    assert.ok(txt.includes("$0.50"), `expected $0.50 SOR revenue, got: ${txt.slice(0, 200)}`);
    assert.ok(!txt.includes("$1.50"), "SOR view must not show the full total");
  });

  check("Direct is the remainder, never a separate count (All === SOR + Direct)", () => {
    click(w, "rvzSettle", "direct");
    const txt = w.document.getElementById("rvzTable").textContent;
    // base $1.00 (1.5-0.5) + solana $0.50 → cumulative total $1.50 on day 2
    assert.ok(txt.includes("$1.00"), `expected $1.00 direct on base, got: ${txt.slice(0, 200)}`);
  });

  check("SOR lane and wire filter are mutually exclusive (no fabricated intersection)", () => {
    click(w, "rvzSettle", "all");
    click(w, "rvzWire", "mpp");
    click(w, "rvzSettle", "sor");
    assert.equal(activeOf(w, "rvzWire"), "all", "picking SOR must reset the wire filter");
    click(w, "rvzWire", "x402");
    assert.equal(activeOf(w, "rvzSettle"), "all", "picking a wire must reset the SOR lane");
  });

  check("SOR lane forces paid traffic (free settles nowhere)", () => {
    click(w, "rvzSettle", "all");
    click(w, "rvzMetric", "tx");
    click(w, "rvzTraffic", "free");
    click(w, "rvzSettle", "sor");
    assert.equal(activeOf(w, "rvzTraffic"), "paid");
  });

  check("Buyers metric resets the SOR lane (buyers series has no wallet split)", () => {
    click(w, "rvzMetric", "buyers");
    assert.equal(activeOf(w, "rvzSettle"), "all");
  });

  check("the settle note explains the lane only when active", () => {
    const note = w.document.getElementById("rvzSettleNote");
    assert.equal(note.style.display, "none", "note hidden at settle=all");
    click(w, "rvzMetric", "tx");
    click(w, "rvzSettle", "sor");
    assert.equal(note.style.display, "block", "note visible on the SOR lane");
    assert.ok(note.textContent.includes("spending wallet"), "note names the spending wallet");
  });
}

// --- "Other" stays itemized: the 8-hue fold is visual, never informational ----
{
  const w = await boot();

  check("legend names the chains folded into Other", () => {
    click(w, "rvzMetric", "tx");
    click(w, "rvzScope", "int");
    const l = legend(w);
    assert.ok(l.includes("Other"), "Other lane missing from the legend");
    assert.ok(l.includes("Optimism") && l.includes("Sei"), `legend must name the folded chains: ${l}`);
  });

  check("table breaks Other down per chain without double counting the total", () => {
    const tb = w.document.getElementById("rvzTable");
    assert.ok(tb.textContent.includes("· Optimism") && tb.textContent.includes("· Sei"), "Other sub-columns missing");
    const rows = tb.querySelectorAll("tr");
    const cells = [...rows[rows.length - 1].querySelectorAll("td")].map((t) => t.textContent);
    // day, Base, Other, · Optimism, · Sei, total (cumulative int tx; Solana
    // has no internal rows so its column drops out under this scope)
    assert.equal(cells[2], "5", `Other aggregate should be 5 (got ${cells[2]})`);
    assert.equal(cells[3], "2", `Optimism sub-column should be 2 (got ${cells[3]})`);
    assert.equal(cells[4], "3", `Sei sub-column should be 3 (got ${cells[4]})`);
    assert.equal(cells[cells.length - 1], "6", `sub-columns must not inflate the total (got ${cells[cells.length - 1]})`);
  });

  check("internal-only folded chains never leak into the external view", () => {
    click(w, "rvzScope", "ext");
    assert.ok(!legend(w).includes("Sei"), "internal-only Sei leaked into the external legend");
  });
}

console.log(failures ? `\nFAILED (${failures})` : "\nall passed");
process.exit(failures ? 1 : 0);
