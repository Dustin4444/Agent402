// Heading LEVEL is structure, not size. A screen reader announces it, so h1
// straight to h3 tells a listener there is a section title they have missed and
// sends them looking for something that is not there.
//
// Three pages skipped a level, and in every case the reason was the same: a
// section with no heading at all. The fix was to name the section, which is a
// content improvement a sighted reader never sees. This pins that the fix holds
// and that a new page cannot quietly reintroduce the gap.
//
//   TARGET_URL=http://127.0.0.1:3000 node scripts/test-heading-order.js
const BASE = (process.env.TARGET_URL || "http://localhost:3000").replace(/\/$/, "");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// Every page a human lands on from the nav or a link in copy.
const PAGES = ["/", "/reports", "/monitors", "/quickstart", "/pricing", "/docs", "/marketplace",
  "/leaderboard", "/revenue", "/sell", "/tools", "/why", "/proof", "/company", "/security",
  "/transparency", "/privacy", "/terms", "/faq", "/credits", "/markets", "/skills"];

const headings = (html) => {
  const h = html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ");
  return [...h.matchAll(/<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi)]
    .map((m) => ({ level: Number(m[1][1]), text: m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() }));
};

// CONTROL. A sweep that has never seen a skip cannot tell "clean" from "blind",
// and this one parses HTML, which is the part most likely to be silently wrong.
{
  const planted = headings(`<h1>A</h1><p>x</p><h3>B</h3>`);
  ok(planted.length === 2 && planted[0].level === 1 && planted[1].level === 3,
    "control: the extractor reads levels out of real markup");
  let skips = 0, prev = 0;
  for (const { level } of planted) { if (prev && level > prev + 1) skips++; prev = level; }
  ok(skips === 1, "control: and the rule flags a planted h1 to h3 skip");
}

for (const path of PAGES) {
  let html;
  try { const r = await fetch(BASE + path); if (!r.ok) { ok(false, `${path} -> HTTP ${r.status}`); continue; } html = await r.text(); }
  catch (e) { ok(false, `${path} -> ${e.message}`); continue; }

  const hs = headings(html);
  ok(hs.length > 0, `${path}: has headings at all (${hs.length})`);
  const h1s = hs.filter((h) => h.level === 1);
  ok(h1s.length === 1, `${path}: exactly one h1 (${h1s.length}) - the page's own title, once`);

  const skips = [];
  let prev = 0;
  for (const { level, text } of hs) {
    if (prev && level > prev + 1) skips.push(`h${prev} -> h${level} at "${text.slice(0, 40)}"`);
    prev = level;
  }
  ok(skips.length === 0, `${path}: no skipped heading level${skips.length ? ` (${skips.join(", ")})` : ""}`);

  // A heading with no text is worse than no heading: it announces a section
  // and names nothing.
  const empty = hs.filter((h) => !h.text);
  ok(empty.length === 0, `${path}: no empty headings${empty.length ? ` (${empty.length})` : ""}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
