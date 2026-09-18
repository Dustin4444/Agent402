#!/usr/bin/env node
// Live guard for the gateway's model tables. Network test (public OpenRouter
// catalog, no key): fails CI when a model id we ADVERTISE or FAIL OVER TO no
// longer exists upstream, or when MODEL_COST underestimates a live price
// inside a tier's max_price bound.
//
// Why: the stale-id class has bitten three times - gemini-2.0-flash(-lite)
// vanished while leading every auto band (2026-08-04, a failed round-trip per
// routed call), ministral-3b/8b were renamed and claude-3.5-haiku left while
// still advertised on /v1/models, and the TTS chain carried zyphra/zonos with
// ZERO endpoints (2026-08-19, a wasted round-trip on every walk past link 3).
// Each was found by a human reading the live catalog. This reads it in CI.
//
// It FAILS on network error rather than skipping: a skipped guard is the same
// silent green that let every one of those ship.
import { readFileSync } from "node:fs";
import {
  TIERS, AUTO_RANKINGS, SPEECH_MODELS, MODEL_COST, FLEX_MODELS, REASONING_MODELS, reasoningRowMatches, costFor, tierFor, tierAllows, STEALTH_MODEL_IDS, modelsList,
} from "../src/tools/llm-gateway-kit.js";
import { PRIMARY_PREFERENCE } from "../openclaw/models.js";

// STEALTH listings (stealth/ox-alpha) are the ONE id class this guard must not
// fail on. A cloaked model is published under a pseudonym while a lab collects
// traffic and is DELETED without notice the moment it is unmasked - that is
// the expected end of its life, not a defect in our tables, and failing CI on
// it would block every unrelated change on somebody else's release schedule.
// Losing one is still reported loudly (and production drops the tier on its
// own - see probeOxAlphaAvailability in llm-gateway-kit.js), just not as a
// failure. Nothing else gets this treatment: every other dead id is a bug.
const STEALTH = new Set(STEALTH_MODEL_IDS);
const isStealth = (p) => STEALTH.has(p);
const warn = (m) => console.log(`WARN - ${m}`);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

async function catalog(url, minEntries) {
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const j = await res.json();
  // A catalog that suddenly shrinks below the floor is a read failure, not a
  // verdict - refuse to grade against it (the speech list is ~18 today).
  if (!Array.isArray(j?.data) || j.data.length < minEntries) throw new Error(`${url} -> implausible catalog (${j?.data?.length} entries)`);
  return j.data;
}
let models, speech;
try {
  [models, speech] = await Promise.all([
    catalog("https://openrouter.ai/api/v1/models", 100),
    catalog("https://openrouter.ai/api/v1/models?output_modalities=speech", 5),
  ]);
} catch (e) {
  console.error(`FAIL - could not read the live OpenRouter catalog (${e.message}); refusing to report green`);
  process.exit(1);
}
const ids = new Set(models.map((m) => m.id));
const speechIds = new Set(speech.map((m) => m.id));
console.log(`live catalog: ${ids.size} models, ${speechIds.size} speech models`);

// 1. Every advertised concrete prefix resolves to at least one live id under
//    the tier's own match rule (exact, "-suffix" or ":variant"). Family
//    prefixes ("deepseek/") only need one live id under them.
const resolves = (p) => p.endsWith("/")
  ? [...ids].some((id) => id.startsWith(p))
  : ids.has(p) || [...ids].some((id) => id.startsWith(p + "-") || id.startsWith(p + ":"));
for (const [slug, tier] of Object.entries(TIERS)) {
  const allDead = tier.prefixes.filter((p) => !resolves(p));
  const deadStealth = allDead.filter(isStealth);
  const dead = allDead.filter((p) => !isStealth(p));
  for (const p of deadStealth) {
    warn(`${slug}: stealth listing ${p} is GONE from the live catalog - EXPECTED for a cloaked model. Not a CI failure. Production drops the tier at boot (503 + off /v1/models, never a charge); set OX_ALPHA_ENABLED=off to remove the route, or repoint the tier at the unmasked id.`);
  }
  ok(dead.length === 0, `${slug}: every advertised model id resolves upstream${dead.length ? ` (dead: ${dead.join(", ")})` : ""}`);
  const deadFb = (tier.fallbacks || []).filter((m) => !ids.has(m));
  ok(deadFb.length === 0, `${slug}: every failover link exists upstream${deadFb.length ? ` (dead: ${deadFb.join(", ")})` : ""}`);
}
// 1b. Every id GET /v1/models lists (family wildcards aside) must be an EXACT
//     live id - an agent sends what it reads there verbatim. Check 1 only asks
//     whether something resolves UNDER a prefix, which let a bare family
//     prefix ("anthropic/claude-opus") ride the list until a live buyer sent
//     it and OpenRouter rejected it (2026-08-26).
{
  // Exempt: family wildcards, the TTS chain (speech catalog), and the OpenAI-
  // direct embeddings ids (no "/": not OpenRouter ids at all).
  const listed = modelsList().data.map((m) => m.id).filter((id) => !id.endsWith("*") && id.includes("/") && !speechIds.has(id));
  const notExact = listed.filter((id) => !ids.has(id) && !isStealth(id));
  ok(notExact.length === 0, `every id on /v1/models is an exact live upstream id${notExact.length ? ` (not ids: ${notExact.join(", ")})` : ""}`);
}
// 2. Auto-router rankings are exact ids and must all be live.
for (const [q, byCat] of Object.entries(AUTO_RANKINGS)) {
  for (const [cat, list] of Object.entries(byCat)) {
    const dead = list.filter((m) => !ids.has(m));
    ok(dead.length === 0, `AUTO_RANKINGS.${q}.${cat}: all ranked ids live${dead.length ? ` (dead: ${dead.join(", ")})` : ""}`);
  }
}
// 3. TTS chain: every link is in the live speech list.
for (const link of SPEECH_MODELS) ok(speechIds.has(link.id), `speech chain link ${link.id} is live`);
// 1b. Every speech row's costPerChar is at or above the DEAREST live endpoint
//     for that model, not the catalog headline. TTS bills per INPUT char, so
//     this row IS the worst-case bound the $0.06 chain and the $0.005 lite tier
//     are priced under, and the headline can be any one endpoint: Kokoro's
//     headline read 0.000004 (Together) while DeepInfra served at 0.00000062,
//     and Voxtral's headline read 0.000016 while one Mistral endpoint bills
//     0.0000176. Provider pinning is not honoured on /audio/speech (measured
//     2026-09-18), so the max is the only honest bound. Nothing here noticed
//     until an audit did (tts-lite was loss-making at its old cap).
{
  const under = [];
  for (const link of SPEECH_MODELS) {
    let prices = [];
    try {
      const j = await (await fetch(`https://openrouter.ai/api/v1/models/${link.id}/endpoints`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) })).json();
      prices = (j?.data?.endpoints || []).map((e) => Number(e?.pricing?.prompt)).filter(Number.isFinite);
    } catch { /* fall through to the headline */ }
    const headline = Number(speech.find((m) => m.id === link.id)?.pricing?.prompt);
    if (Number.isFinite(headline)) prices.push(headline);
    if (!prices.length) continue; // liveness already asserted above; an unpriced row is not an under-count
    const live = Math.max(...prices);
    if (live > link.costPerChar) under.push(`${link.id}: row ${link.costPerChar} < dearest live endpoint ${live}/char (${prices.length} price(s) read)`);
  }
  ok(under.length === 0, `no speech costPerChar row is under its dearest live endpoint price${under.length ? `:\n    ${under.join("\n    ")}` : ""}`);
}
// 4. Price floor: for every live model a tier admits, MODEL_COST must not price
//    it UNDER the DEAREST endpoint a default-tier call can be routed to, prompt
//    and completion taken separately, while that endpoint sits inside the
//    tier's max_price bound (an endpoint above the bound is refused by the
//    provider.max_price every flat-tier call carries). The catalog HEADLINE is
//    one endpoint's price and was what this rule compared against until
//    2026-09-18: gpt-5.6-sol's headline read $2/$10 while its azure/us and
//    azure/eu endpoints billed $5.5/$33 inside the premium bound, and every
//    Claude model's regional endpoints bill 10% over the headline - so the
//    clamp was letting through ~2.75x the tokens the bound allowed on a sol
//    fallback. Same shape as the speech rule above (1b).
//
//    Endpoints tagged "*/fast" are the PRIORITY service tier (openai/fast,
//    anthropic/fast: 2x list). OpenRouter routes to them only for
//    service_tier "priority", which no wire here ever sends - pinned from
//    source below, with the flex literal as the control that proves the scan
//    sees the field at all - so they bound nothing we serve and are excluded.
//    Underestimating = the margin clamp lets too many tokens through.
{
  const wires = ["llm-gateway-kit.js", "llm-messages-kit.js", "llm-responses-kit.js", "llm-images-fast-kit.js"]
    .map((f) => readFileSync(new URL(`../src/tools/${f}`, import.meta.url), "utf8")).join("\n");
  ok(!/service_tier\s*[:=]\s*["'`]priority["'`]/.test(wires) && /service_tier\s*:\s*["']flex["']/.test(wires), 'no wire sends service_tier "priority" (so */fast endpoints never serve a call and rule 4 may exclude them); the flex literal is the control');
}
// Priority-tier tags read two ways on the live catalog: "openai/fast" /
// "anthropic/fast" and "google-vertex/global/priority" / "xai/zdr/priority".
const PRIORITY_TAG = /\/(fast|priority)$/;
async function endpointPrices(id) {
  try {
    const r = await fetch(`https://openrouter.ai/api/v1/models/${id}/endpoints`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) return null;
    const eps = (await r.json())?.data?.endpoints;
    if (!Array.isArray(eps)) return null;
    return eps.map((e) => ({ tag: String(e?.tag || ""), p: Number(e?.pricing?.prompt) * 1e6, c: Number(e?.pricing?.completion) * 1e6 })).filter((e) => Number.isFinite(e.p) && Number.isFinite(e.c));
  } catch { return null; }
}
const admitted = models.filter((m) => {
  // ":batch" (async) and ":online" (per-request web billing) are refused by
  // refuseCostVariants on every wire, so their live prices bound nothing we
  // serve (qwen3.8-2.4t-a95b:batch listed ABOVE its own base model, 2026-08-28).
  if (/:(batch|online)$/.test(m.id)) return false;
  return !!tierFor(m.id);
});
const under = [];
let endpointReads = 0, headlineOnly = 0, priorityExcluded = 0;
{
  const queue = [...admitted];
  const worker = async () => {
    for (let m = queue.shift(); m; m = queue.shift()) {
      const slug = tierFor(m.id);
      const tier = TIERS[slug];
      const eps = await endpointPrices(m.id);
      let prices = [];
      if (eps) {
        endpointReads++;
        priorityExcluded += eps.filter((e) => PRIORITY_TAG.test(e.tag)).length;
        prices = eps.filter((e) => !PRIORITY_TAG.test(e.tag));
      } else {
        headlineOnly++;
      }
      const hp = Number(m.pricing?.prompt) * 1e6, hc = Number(m.pricing?.completion) * 1e6;
      if (Number.isFinite(hp) && Number.isFinite(hc)) prices.push({ tag: "headline", p: hp, c: hc });
      // An endpoint above the tier bound on EITHER unit is refused by provider.max_price.
      if (tier.maxPrice) prices = prices.filter((e) => e.p <= tier.maxPrice.prompt && e.c <= tier.maxPrice.completion);
      if (!prices.length) continue;
      const p = Math.max(...prices.map((e) => e.p)), c = Math.max(...prices.map((e) => e.c));
      const table = costFor(m.id);
      if (!table) { under.push(`${m.id} (no MODEL_COST entry; dearest routable endpoint $${p}/$${c})`); continue; }
      if (p > table.prompt + 1e-9 || c > table.completion + 1e-9) {
        const dearP = prices.find((e) => e.p === p)?.tag, dearC = prices.find((e) => e.c === c)?.tag;
        under.push(`${m.id} dearest routable endpoint $${p} (${dearP}) / $${c} (${dearC}) vs table $${table.prompt}/$${table.completion} (${slug}; ${prices.length} endpoint price(s) read)`);
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
}
console.log(`rule 4: ${admitted.length} admitted live models, ${endpointReads} endpoint lists read, ${headlineOnly} graded on the headline alone, ${priorityExcluded} priority-tier endpoint(s) excluded`);
ok(endpointReads >= admitted.length / 2, `rule 4 read endpoint lists for most admitted models (${endpointReads} of ${admitted.length}); a headline-only run would be the old, weaker check`);
ok(under.length === 0, `MODEL_COST never underestimates a live admitted model's dearest routable endpoint${under.length ? `:\n    ${under.join("\n    ")}` : ""}`);
// 5. Expiring models: OpenRouter stamps expiration_date; anything we rank or
//    fail over to that expires within 14 days fails now, not on the day.
const soon = Date.now() + 14 * 86_400_000;
const expiryOf = (m) => m.expiration_date || m.deprecation_date || null;
const watched = new Set([...Object.values(AUTO_RANKINGS).flatMap((b) => Object.values(b).flat()), ...Object.values(TIERS).flatMap((t) => t.fallbacks || [])]);
const expiring = models.filter((m) => watched.has(m.id) && expiryOf(m) && Date.parse(expiryOf(m)) < soon).map((m) => `${m.id} (${expiryOf(m)})`);
ok(expiring.length === 0, `no ranked/fallback model expires within 14 days${expiring.length ? ` (${expiring.join(", ")})` : ""}`);
// 5b. DEFAULTS have no horizon: a tier's defaultModel is what a caller who names
//     no model is served, and OpenClaw's PRIMARY_PREFERENCE is what `setup`
//     writes into a user's config. A chain can walk past an expiring link; a
//     default needs a decided successor, so ANY expiration date upstream fails
//     now. Built 2026-09-18 for claude-haiku-4.5 (metered default + OpenClaw's
//     first pick; retirement floor 2026-10-15, no notice yet, no haiku-5 in the
//     catalog to switch to) - the old rule watched ranked/fallback ids only.
{
  const defaults = new Set([
    ...Object.values(TIERS).map((t) => t.defaultModel).filter(Boolean),
    ...PRIMARY_PREFERENCE,
  ]);
  ok(defaults.has("anthropic/claude-haiku-4.5") && PRIMARY_PREFERENCE[0] === "anthropic/claude-haiku-4.5", "the default set covers the metered tier default and OpenClaw's first pick (haiku-4.5 today)");
  for (const id of defaults) {
    const m = models.find((x) => x.id === id);
    if (!m && isStealth(id)) { warn(`default ${id} is a stealth listing and is gone - expected, not a failure`); continue; }
    ok(!!m, `default model ${id} is live upstream`);
    if (!m) continue;
    const exp = expiryOf(m);
    ok(!exp, `default model ${id} carries no expiration/deprecation date upstream${exp ? ` (marked ${exp}: pick a successor - it is served to callers who name no model)` : ""}`);
  }
}

// 6. Flex table: every FLEX_MODELS entry must still carry a "*/flex" endpoint
//    upstream - flex on a model without one 404s and costs a failed attempt
//    per call (the same wasted-round-trip class as a dead chain link).
for (const id of FLEX_MODELS) {
  let tags = null;
  try {
    const r = await fetch(`https://openrouter.ai/api/v1/models/${id}/endpoints`, { signal: AbortSignal.timeout(30_000) });
    if (r.ok) tags = ((await r.json())?.data?.endpoints || []).map((e) => String(e.tag || ""));
  } catch { /* reported below */ }
  ok(Array.isArray(tags) && tags.some((t) => /\/flex$/.test(t)), `flex: ${id} still has a flex endpoint upstream${tags ? ` (tags: ${tags.join(", ")})` : " (endpoints unreadable)"}`);
}
// Informational, never fails: ranked/fallback models that gained flex since the table was written.
{
  const watchedIds = [...new Set([...Object.values(AUTO_RANKINGS).flatMap((b) => Object.values(b).flat()), ...Object.values(TIERS).flatMap((t) => t.fallbacks || [])])]
    .filter((m) => /^(openai|google)\//.test(m) && !FLEX_MODELS.some((p) => m === p || m.startsWith(p + "-")));
  const gained = [];
  for (const id of watchedIds) {
    try {
      const r = await fetch(`https://openrouter.ai/api/v1/models/${id}/endpoints`, { signal: AbortSignal.timeout(30_000) });
      if (r.ok && ((await r.json())?.data?.endpoints || []).some((e) => /\/flex$/.test(String(e.tag || "")))) gained.push(id);
    } catch { /* informational */ }
  }
  if (gained.length) console.log(`note - ranked models with a flex endpoint not yet in FLEX_MODELS: ${gained.join(", ")}`);
}

// 7. Reasoning table: every REASONING_MODELS entry must still describe a live
//    reasoning model whose supported_efforts contain every effort we list
//    (an effort we might inject that upstream dropped = a 400 per call), and
//    whose reasoning is default-on or mandatory (else the default injection is
//    pointless). Prefix rows (gpt-5.6-) are checked against every live id
//    that matches.
for (const row of REASONING_MODELS) {
  const label = row.id || row.prefix;
  const matches = models.filter((m) => reasoningRowMatches(row, m.id));
  if (matches.length === 0 && isStealth(label)) {
    warn(`reasoning: stealth listing ${label} is gone from the live catalog - EXPECTED, not a CI failure (see above).`);
    continue;
  }
  ok(matches.length > 0, `reasoning: ${label} matches at least one live model`);
  for (const m of matches) {
    const r = m.reasoning || {};
    const live = Array.isArray(r.supported_efforts) ? r.supported_efforts : [];
    const missing = row.efforts.filter((e) => !live.includes(e));
    ok(missing.length === 0, `reasoning: ${m.id} supports every effort we list${missing.length ? ` (missing upstream: ${missing.join(", ")}; live: ${live.join(", ")})` : ""}`);
    ok(r.mandatory === true || r.default_enabled === true, `reasoning: ${m.id} still reasons by default (mandatory=${r.mandatory}, default_enabled=${r.default_enabled}) - else drop it from the table`);
  }
}
// Informational: ranked/fallback models that reason by default but are NOT in the table
// (they would get no default effort and could return paid empty "length" answers).
{
  const watchedIds = [...new Set([...Object.values(AUTO_RANKINGS).flatMap((b) => Object.values(b).flat()), ...Object.values(TIERS).flatMap((t) => t.fallbacks || [])])];
  const untabled = watchedIds.filter((id) => { const m = models.find((x) => x.id === id); const r = m?.reasoning; return r && (r.mandatory === true || r.default_enabled === true) && Array.isArray(r.supported_efforts) && !REASONING_MODELS.some((row) => reasoningRowMatches(row, id)); });
  if (untabled.length) console.log(`note - ranked/fallback models that reason by default but have no REASONING_MODELS row: ${untabled.join(", ")}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
