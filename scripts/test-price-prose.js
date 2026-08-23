// Any PRICE QUOTED IN PROSE on a served page must match a real price.
//
// scripts/test-docs-truth.js checks the price stated beside a ROUTE. It cannot
// see a sentence, and a sentence is what search engines and link previews show:
// after the 2026-08-23 repricing, /reports advertised "$1 or $2 by card and
// $0.20 to $1.10" and /monitors advertised "$3 a month" for a full day, in the
// meta and og:description of both pages, because prices live in three places
// and the prose quoting them was not one of them.
//
// The fix was to DERIVE those strings. This is the guard that keeps them
// derived: it fails on any dollar figure in a page description that is not an
// actual product price.
import { HUMAN_PRODUCTS } from "../src/human-checkout.js";
import { MONITOR_PRODUCTS } from "../src/stripe-subscriptions.js";
import { priceUsdFor } from "../src/report-tiers.js";
import { humanReportsPage } from "../src/human-reports-page.js";
import { monitorsPage } from "../src/monitors-page.js";

let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error("FAIL:", m); process.exit(1); } };

// Every number that is legitimately a price today.
const real = new Set();
for (const p of Object.values(HUMAN_PRODUCTS)) {
  real.add((p.price / 100).toFixed(2));
  const a = priceUsdFor(p.slug);
  if (Number.isFinite(a)) real.add(a.toFixed(2));
}
for (const p of Object.values(MONITOR_PRODUCTS)) real.add((p.price / 100).toFixed(2));
// Credit packs are fixed denominations, not product prices.
for (const pack of ["20.00", "50.00", "100.00"]) real.add(pack);
ok(real.size > 3, `collected ${real.size} real price values from the product tables`);

const descOf = (html) => (html.match(/name="description" content="([^"]*)"/) || [])[1] || "";

for (const [name, html] of [["/reports", humanReportsPage("https://agent402.tools")], ["/monitors", monitorsPage("https://agent402.tools")]]) {
  const desc = descOf(html);
  ok(desc.length > 0, `${name} has a meta description`);
  const quoted = [...desc.matchAll(/\$(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]).toFixed(2));
  ok(quoted.length > 0, `${name} description quotes ${quoted.length} price(s) - if this ever hits zero the check below is vacuous`);
  const bogus = quoted.filter((q) => !real.has(q));
  ok(bogus.length === 0, `${name}: every price quoted in its description is a real product price${bogus.length ? ` (not real: ${[...new Set(bogus)].join(", ")})` : ""}`);
  // And the og:description, which is what a link preview actually renders.
  const og = (html.match(/property="og:description" content="([^"]*)"/) || [])[1] || "";
  if (og) {
    const ogBogus = [...og.matchAll(/\$(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]).toFixed(2)).filter((q) => !real.has(q));
    ok(ogBogus.length === 0, `${name}: og:description too${ogBogus.length ? ` (not real: ${[...new Set(ogBogus)].join(", ")})` : ""}`);
  }
}

console.log(`\n${pass} passed, 0 failed`);
