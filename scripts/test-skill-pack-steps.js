// Every sold skill pack must have a real step config.
//
// Four packs (earnings-deep-dive, options-analytics, fixed-income-desk,
// defi-protocol-scanner) were listed in SKILL_PACKS with prices, catalog
// entries and live tool pages, and no PACK_STEPS entry at all. getStepConfig
// falls back to a stub whose every mapInput throws todoError(), so each call
// returned HTTP 200 with "0/N steps succeeded" - deterministically, for every
// buyer, from 2026-07-08 to 2026-08-31.
//
// Nothing caught it because the partial-success envelope is valid whatever the
// steps did: the "answers its own example" sweep asserts status and documented
// keys, not outcomes, and three of the four are additionally skipped there to
// avoid live Brave spend. So the guard cannot live in that sweep - it lives
// here, offline, over the source of truth.
//
// Also checks the inverse: a step naming a slug no tool provides. That is how
// a retirement cut would silently hollow out a pack that still sells.
import assert from "node:assert/strict";
import { SKILL_PACKS, PACK_PRICES } from "../src/skills.js";
import { PACK_STEPS } from "../src/tools/skill-runner.js";

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log("ok -", msg); };

const missing = SKILL_PACKS.filter((p) => !PACK_STEPS[p.slug]);
ok(
  missing.length === 0,
  `every pack in SKILL_PACKS has a PACK_STEPS entry (a pack without one answers 200 with 0/N steps and still charges)${missing.length ? `: ${missing.map((p) => `${p.slug} ($${PACK_PRICES[p.slug] ?? 0.05})`).join(", ")}` : ""}`
);

// No step may declare a slug the pack itself does not list, and no listed tool
// should be silently dropped: the pack's toolSlugs are what the tool page, the
// catalog description and the claudePrompt all promise the buyer.
for (const pack of SKILL_PACKS) {
  const config = PACK_STEPS[pack.slug];
  if (!config) continue;
  const stepSlugs = config.steps.map((s) => s.slug);
  ok(stepSlugs.length > 0, `${pack.slug}: declares at least one step`);
  ok(
    config.mode === "chain" || config.mode === "fanout",
    `${pack.slug}: mode is chain or fanout (got ${config.mode})`
  );
  for (const s of config.steps) {
    // Either shape is valid: mapInput builds one input, mapInputs offers
    // ordered candidates the runner tries until one works. A step with
    // neither is a step that can never run.
    const buildable = typeof s.mapInput === "function" || typeof s.mapInputs === "function";
    ok(buildable, `${pack.slug}: step ${s.slug} can build its input (mapInput or mapInputs)`);
  }
  const promised = new Set(pack.toolSlugs || []);
  const undeclared = stepSlugs.filter((s) => promised.size && !promised.has(s));
  ok(
    undeclared.length === 0,
    `${pack.slug}: every step is a tool the pack advertises in toolSlugs${undeclared.length ? ` (extra: ${undeclared.join(", ")})` : ""}`
  );
}

// crypto-dossier's extract step is the reason mapInputs exists: it reads
// whichever news site ranked first, and that failed 43.5% of the time (37 of
// 85 runs over 60 days) while every other step in the pack ran at 100%. The
// candidates must be the ranked results IN ORDER, deduped, and must always end
// with a page we know is readable so the step cannot be lost to a bad ranking.
{
  const extract = PACK_STEPS["crypto-dossier"].steps.find((s) => s.slug === "extract");
  const prior = { search: { results: [
    { url: "https://blocked.example/a" },
    { url: "https://blocked.example/a" },
    { url: "https://ok.example/b" },
  ] } };
  const candidates = extract.mapInputs({ coin: "bitcoin" }, prior);
  ok(candidates.length > 1, `extract offers more than one candidate (got ${candidates.length})`);
  ok(candidates[0].url === "https://blocked.example/a", "extract tries the top-ranked result first");
  ok(candidates[1].url === "https://ok.example/b", "extract dedupes repeated URLs before falling through");
  // No hardcoded fallback. The first version appended the coin's own CoinGecko
  // page as a "readable" last resort; measured, that page answers 403 to our
  // fetcher, so it was a guaranteed-dead candidate dressed as a safety net.
  // Walking more real results is the honest version, and a step with no
  // reachable source should fail rather than pretend.
  ok(
    !candidates.some((c) => /coingecko\.com/.test(c.url)),
    "extract offers no hardcoded fallback page (the CoinGecko one 403s to our fetcher)"
  );
  const noResults = extract.mapInputs({ coin: "bitcoin" }, { search: {} });
  ok(
    noResults.length === 0,
    "extract offers nothing when the search returned nothing, rather than a dead candidate"
  );
}

console.log(`\n${passed} passed, 0 failed (${SKILL_PACKS.length} packs checked)`);
