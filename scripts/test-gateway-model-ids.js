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
import {
  TIERS, AUTO_RANKINGS, SPEECH_MODELS, MODEL_COST, FLEX_MODELS, costFor, tierFor, tierAllows,
} from "../src/tools/llm-gateway-kit.js";

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
  const dead = tier.prefixes.filter((p) => !resolves(p));
  ok(dead.length === 0, `${slug}: every advertised model id resolves upstream${dead.length ? ` (dead: ${dead.join(", ")})` : ""}`);
  const deadFb = (tier.fallbacks || []).filter((m) => !ids.has(m));
  ok(deadFb.length === 0, `${slug}: every failover link exists upstream${deadFb.length ? ` (dead: ${deadFb.join(", ")})` : ""}`);
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
// 4. Price floor: for every live model a tier admits, MODEL_COST must not price
//    it UNDER its live list price while that price sits inside the tier's
//    max_price bound (above the bound OpenRouter refuses the provider anyway).
//    Underestimating = the margin clamp lets too many tokens through.
const under = [];
for (const m of models) {
  const slug = tierFor(m.id);
  if (!slug) continue;
  const tier = TIERS[slug];
  const p = Number(m.pricing?.prompt) * 1e6, c = Number(m.pricing?.completion) * 1e6;
  if (!Number.isFinite(p) || !Number.isFinite(c)) continue;
  if (tier.maxPrice && (p > tier.maxPrice.prompt || c > tier.maxPrice.completion)) continue;
  const table = costFor(m.id);
  if (!table) { under.push(`${m.id} (no MODEL_COST entry)`); continue; }
  if (p > table.prompt + 1e-9 || c > table.completion + 1e-9) under.push(`${m.id} live $${p}/$${c} vs table $${table.prompt}/$${table.completion} (${slug})`);
}
ok(under.length === 0, `MODEL_COST never underestimates a live admitted model${under.length ? `:\n    ${under.join("\n    ")}` : ""}`);
// 5. Expiring models: OpenRouter stamps expiration_date; anything we rank or
//    fail over to that expires within 14 days fails now, not on the day.
const soon = Date.now() + 14 * 86_400_000;
const watched = new Set([...Object.values(AUTO_RANKINGS).flatMap((b) => Object.values(b).flat()), ...Object.values(TIERS).flatMap((t) => t.fallbacks || [])]);
const expiring = models.filter((m) => watched.has(m.id) && m.expiration_date && Date.parse(m.expiration_date) < soon).map((m) => `${m.id} (${m.expiration_date})`);
ok(expiring.length === 0, `no ranked/fallback model expires within 14 days${expiring.length ? ` (${expiring.join(", ")})` : ""}`);

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
