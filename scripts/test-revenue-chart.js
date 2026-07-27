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
import { JSDOM } from "jsdom";
import { revenueChartSection } from "../src/revenue-live.js";

const REV_DAYS = [
  { day: "2026-06-20", chain: "base", extUsd: 1.5, intUsd: 0.2, extTx: 3, intTx: 1, extMppUsd: 0, intMppUsd: 0, extMppTx: 0, intMppTx: 0 },
  { day: "2026-06-21", chain: "solana", extUsd: 0.5, intUsd: 0, extTx: 2, intTx: 0, extMppUsd: 0, intMppUsd: 0, extMppTx: 0, intMppTx: 0 },
];
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
  const html = `<!doctype html><html><body>${revenueChartSection()}</body></html>`;
  // fetch must exist BEFORE the inline script runs, so the chart's own IIFE is
  // the one under test — re-evaluating it afterwards would double every
  // listener and make the segmented controls toggle twice per click.
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(w) {
      w.fetch = (url) => {
        if (String(url).includes("/api/revenue/daily")) return Promise.resolve({ json: () => Promise.resolve({ days: REV_DAYS }) });
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

console.log(failures ? `\nFAILED (${failures})` : "\nall passed");
process.exit(failures ? 1 : 0);
