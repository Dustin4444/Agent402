// Per-item page title heights (/tools/:slug, /skills/:slug, /docs/:slug,
// /guides/:slug) must be BOUNDED regardless of item name length. Tool names
// range from 3 chars ("hex") to 50+ ("EDGAR XBRL company-concept (one tag,
// full history)") across 530 tools; skill pack, wiki doc and guide titles
// run shorter but hit the identical mechanism. All four page types' H1
// sits in a single-column layout whose available width shrinks
// continuously as the viewport narrows - unlike the per-chain marketplace
// pages (a 2-column grid with one collapse breakpoint), there's no single
// width to hook a "reserve the worst case" min-height fix to without
// wasting a lot of blank space on the majority of items whose names never
// come close to needing it.
//
// Measured live before this fix: the longest real tool names wrapped up to
// 5 lines at narrow widths (up to 190px tall) while short names stayed at
// 1 line (38px) - a real, unbounded, per-item layout shift a visitor would
// feel browsing between pages of the same type, the same class of bug
// already fixed on the per-chain marketplace pages. Fixed with a 2-line
// CSS clamp (-webkit-line-clamp) instead of a reservation: bounds every
// page's H1 to AT MOST 2 lines at any viewport width. /tools, /skills and
// /guides preserve the full name via the H1's own title attribute for the
// handful of names long enough to actually truncate (and it's always the
// real page <title> either way); /docs' H1 comes from marked's markdown
// rendering rather than a controlled template string, so it gets the
// height-bounding clamp only, no title attribute - checked separately below
// since the assertion shape differs from the other three.
//
// Requires a booted server (same TARGET_URL convention as the other page tests):
//   FREE_MODE=true PORT=3000 node src/server.js
//   TARGET_URL=http://127.0.0.1:3000 node scripts/test-title-clamp-coverage.js
const BASE = process.env.TARGET_URL || "http://127.0.0.1:3000";
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

// --- /docs/:slug (~30 wiki pages) - clamp only, no title attribute --------
{
  const slugs = ["API-Reference", "AWS-Bedrock-AgentCore", "Architecture", "Code-Execution", "MCP-Connector", "Skill-Packs", "x402-Index-and-Router"];
  let found = 0;
  for (const slug of slugs) {
    const res = await fetch(`${BASE}/docs/${slug}`);
    if (res.status !== 200) continue;
    found++;
    const html = await res.text();
    ok(html.includes("-webkit-line-clamp:2"), `/docs/${slug}: H1 carries the 2-line clamp rule`);
  }
  ok(found >= 5, `enough real doc slugs resolved to make this check non-vacuous (got ${found}/${slugs.length})`);
}

// --- /guides/:slug (9 guides) -----------------------------------------------
{
  const slugs = ["x402-in-5-minutes", "durable-memory-for-agents", "sell-your-api-over-x402", "create-agent-wallet", "smart-order-router"];
  let found = 0;
  for (const slug of slugs) {
    const res = await fetch(`${BASE}/guides/${slug}`);
    if (res.status !== 200) continue;
    found++;
    const html = await res.text();
    ok(html.includes("-webkit-line-clamp:2"), `/guides/${slug}: H1 carries the 2-line clamp rule`);
    // guides.js uses a plain title="" attribute (not HTML-escaped beyond esc()'s
    // own rules) around known, hardcoded guide titles - safe to check literally.
    const titleMatch = html.match(/<h1 title="([^"]*)">/);
    ok(!!titleMatch, `/guides/${slug}: full title preserved via the H1's title attribute`);
  }
  ok(found >= 3, `enough real guide slugs resolved to make this check non-vacuous (got ${found}/${slugs.length})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
