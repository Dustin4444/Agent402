// Per-item page title heights (/tools/:slug and /skills/:slug) must be
// BOUNDED regardless of item name length. Tool names range from 3 chars
// ("hex") to 50+ ("EDGAR XBRL company-concept (one tag, full history)")
// across 530 tools; skill pack titles run shorter but hit the identical
// mechanism. Both pages' H1 sits in a single-column layout whose available
// width shrinks continuously as the viewport narrows - unlike the per-chain
// marketplace pages (a 2-column grid with one collapse breakpoint), there's
// no single width to hook a "reserve the worst case" min-height fix to
// without wasting a lot of blank space on the majority of items whose names
// never come close to needing it.
//
// Measured live before this fix: the longest real tool names wrapped up to
// 5 lines at narrow widths (up to 190px tall) while short names stayed at
// 1 line (38px) - a real, unbounded, per-item layout shift a visitor would
// feel browsing between tool/skill pages, the same class of bug already
// fixed on the per-chain marketplace pages. Fixed with a 2-line CSS clamp
// (-webkit-line-clamp) instead of a reservation: bounds every page's H1 to
// AT MOST 2 lines at any viewport width, with the full name preserved via
// the H1's own title attribute (and always the real page <title>) for the
// handful of names long enough to actually truncate.
//
// Requires a booted server (same TARGET_URL convention as the other page tests):
//   FREE_MODE=true PORT=3000 node src/server.js
//   TARGET_URL=http://localhost:3000 node scripts/test-title-clamp-coverage.js
const BASE = process.env.TARGET_URL || "http://localhost:3000";
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

async function checkClamp(pathPrefix, slug, expectedName, escapedName) {
  const html = await (await fetch(`${BASE}${pathPrefix}${slug}`)).text();
  ok(html.includes("-webkit-line-clamp:2"), `${pathPrefix}${slug}: H1 carries the 2-line clamp rule`);
  ok(html.includes(`title="${escapedName}"`), `${pathPrefix}${slug}: full name preserved via the H1's title attribute`);
}
const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// --- /tools/:slug (530 tools) -----------------------------------------------
{
  // The known longest real tool name at the time this was written - re-derived
  // live below rather than hardcoded as the ONLY check, so a future longer
  // tool name is still covered.
  const KNOWN_LONG_SLUG = "edgar-company-concept";
  const pricing = await (await fetch(`${BASE}/api/pricing`)).json();
  const endpoints = pricing.endpoints || [];
  ok(endpoints.length > 400, `catalog has a substantial tool set to check against (got ${endpoints.length})`);

  const longest = endpoints.reduce((a, b) => ((a.name || "").length >= (b.name || "").length ? a : b));
  ok(longest.name.length >= 40, `found a genuinely long tool name to test the clamp against (got "${longest.name}", ${longest.name.length} chars)`);

  for (const slug of [longest.slug, KNOWN_LONG_SLUG, "hex", "hash"]) {
    const tool = endpoints.find((e) => e.slug === slug);
    if (tool) await checkClamp("/tools/", slug, tool.name, escapeHtml(tool.name));
  }
}

// --- /skills/:slug (103 skill packs) ---------------------------------------
{
  const skillsJson = await (await fetch(`${BASE}/api/skill-packs.json`)).json();
  const packs = skillsJson.packs || [];
  ok(packs.length > 50, `skill-pack set has a substantial catalog to check against (got ${packs.length})`);

  const longest = packs.reduce((a, b) => ((a.title || "").length >= (b.title || "").length ? a : b));
  for (const slug of [longest.slug, "ssl-audit"]) {
    const pack = packs.find((p) => p.slug === slug);
    if (pack) await checkClamp("/skills/", slug, pack.title, escapeHtml(pack.title));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
