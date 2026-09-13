#!/usr/bin/env node
// Four false absolutes, and the guard that stops the class coming back.
//
//   node scripts/test-copy-absolutes.js        (offline, no server)
//
// An absolute is the most expensive kind of sentence to write, because it is
// true on the day it ships and stops being true the day a feature widens the
// service. Four of ours had already stopped:
//
//   1. "N deterministic tools" on /api/pricing, where N was the WHOLE catalog
//      count and 37 of those entries plus every /v1 tier are model-backed.
//   2. "Every tool is deterministic, no model in the serving path" on /why and
//      /faq and as a BOOLEAN `deterministic: true` on the service manifest -
//      false since the gateway tiers and the report products shipped.
//   3. "Only sellers with proven on-chain settlement are routable" on four
//      pages - false since the unproven Solana tier shipped 2026-09-02, which
//      is LIVE on its default.
//   4. "Agent402 never holds, receives, signs, or sends funds" - false since
//      prepaid credits shipped, and the correctly scoped version was already
//      being served on /security, /company, /terms and /api/reliability while
//      these pages kept the absolute.
//
// Every one was caught by reading, not by a test, and three of them had a
// correct scoped twin somewhere else on the same site - which is the tell that
// the problem is copies, not judgment. So: the routing sentence is DERIVED
// from the router's own constant (nothing may type it), the manifest fields
// are strings that state their own scope (a boolean cannot), and the phrasings
// that were wrong are forbidden outright in served copy.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// Everything a reader or an agent can actually be shown. This walks
// RECURSIVELY and includes the published package READMEs, because the first
// version of this guard read `src/*.js` at the top level only and `README.md`
// for four packages - and the very sweep that shipped it left a forbidden
// string live in `adapters/agentkit/README.md` (a published npm package) and
// three copies of the count claim on /pricing. A guard that names its scope
// narrower than the claim's scope is a guard that certifies the gap.
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", "assets"]);
function walk(rel, out, depth = 0) {
  let names = [];
  try { names = readdirSync(join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const d of names) {
    if (SKIP_DIRS.has(d.name)) continue;
    const next = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) { if (depth < 4) walk(next, out, depth + 1); }
    else if (/\.(js|md)$/.test(d.name)) out.push(next);
  }
  return out;
}
const files = [];
for (const d of ["src", "wiki", "docs", "adapters", "openclaw"]) walk(d, files);
// The package roots carry served/published prose; their source is tested by
// their own suites, so only the docs are swept here.
for (const d of ["mcp", "client", "tollbooth"]) {
  for (const f of walk(d, [])) if (f.endsWith(".md")) files.push(f);
}
files.push("README.md");

const read = (rel) => { try { return readFileSync(join(root, rel), "utf8"); } catch { return null; } };

const FORBIDDEN = [
  {
    // Must be derived from routingProofSentence(), never typed. The wiki is
    // hand-maintained prose and carries the rendered sentence, so it is
    // matched on the ABSOLUTE form only.
    re: /Only sellers with proven on-chain settlement are routable/,
    why: "the unproven Solana tier makes this false on its default; use routingProofSentence()",
  },
  {
    re: /Agent402 never holds(?:,| ) ?(?:receives|signs|sends|funds)/,
    why: "a prepaid credits balance is money we hold; scope the subject to the tools",
  },
  {
    re: /never holds, receives, signs, or sends\s+funds/,
    why: "same absolute, hyphen-wrapped in markdown; scope the subject to the tools",
  },
  {
    re: /\bnon-custodial and never hold your funds\b/,
    why: "scope it: say what does not happen on THIS rail",
  },
  {
    re: /(?:\d|\}|\b[Aa]ll|\b[Ee]very) deterministic (?:\w+ )?tools\b/,
    why: "the catalog count includes model-backed entries; say priced endpoints",
  },
  {
    re: /[Ee]very tool is deterministic/,
    why: "the /v1 tiers, the report products and the media tools are model-backed",
  },
];

function sweep(entries) {
  const found = [];
  for (const [rel, text] of entries) {
    if (text == null) continue;
    for (const { re, why } of FORBIDDEN) {
      const m = text.match(re);
      if (m) found.push(`${rel} carries "${m[0]}" (${why})`);
    }
  }
  return found;
}

// Control FIRST: a planted file must be reported by the same code path the
// real sweep uses, or a clean run proves nothing.
const control = sweep([["<control>", "Only sellers with proven on-chain settlement are routable."],
                       ["<control>", "Agent402 never holds funds."],
                       ["<control>", "Flat pricing for ${n} deterministic web tools."],
                       ["<control>", "Every tool is deterministic."]]);
ok(control.length === 4, `control: the sweep reports all 4 planted violations through its real code path (got ${control.length})`);

for (const hit of sweep(files.map((rel) => [rel, read(rel)]))) { fail++; console.error(`FAIL - ${hit}`); }
ok(files.length >= 300, `swept ${files.length} copy surfaces (a collapsed file list must fail, not pass quietly)`);
ok((read("src/why.js") || "").length > 500 && (read("adapters/agentkit/README.md") || "").length > 500,
   "...and the sweep really reached both a served page and a published package README");

// --- the routing sentence is derived, and honest in BOTH directions --------
{
  const mod = await import("../src/routing-proof.js");
  const before = process.env.SOR_SVM_UNPROVEN_MAX_USD;

  delete process.env.SOR_SVM_UNPROVEN_MAX_USD;   // the shipped default
  const live = mod.routingProofSentence();
  ok(/proven on-chain settlement/.test(live), "the sentence still leads with the proof requirement");
  ok(/one exception/.test(live) && /\$0\.01/.test(live),
     "with the tier on its live default the sentence NAMES the exception and its ceiling");
  ok(/after every proven candidate/.test(live) && /flagged unproven/.test(live),
     "...and says the two things that make the exception bounded: ordering and the receipt flag");

  process.env.SOR_SVM_UNPROVEN_MAX_USD = "off";
  const off = mod.routingProofSentence();
  ok(!/exception/.test(off), "switch the tier off and the absolute comes back on its own, rather than being stale in the other direction");

  process.env.SOR_SVM_UNPROVEN_MAX_USD = "0.25";
  ok(/\$0\.25/.test(mod.routingProofSentence()), "the ceiling is read from the env the router reads, not typed");

  if (before === undefined) delete process.env.SOR_SVM_UNPROVEN_MAX_USD;
  else process.env.SOR_SVM_UNPROVEN_MAX_USD = before;

  // Every page that makes the claim must call the function. A page that
  // reworded the absolute by hand would pass the regex sweep above.
  for (const rel of ["src/why.js", "src/glossary.js", "src/agentic-finance.js", "src/blog.js"]) {
    ok(/routingProofSentence\(\)/.test(read(rel) || ""), `${rel} renders the routing claim from the shared function`);
  }
}

// --- the manifest states its own scope, which a boolean cannot -------------
{
  const { serviceManifest } = await import("../src/discovery.js");
  const m = serviceManifest({
    baseUrl: "https://agent402.tools", network: "base", networks: ["base"],
    wallet: "0x0000000000000000000000000000000000000000", walletName: "agent402.base.eth",
    catalog: {}, toolCount: 0, powSlugs: [], powDifficulty: 16, prices: {},
  });
  const flat = JSON.stringify(m);
  const grab = (k) => {
    const seen = [];
    const walk = (o, d = 0) => {
      if (d > 6 || !o || typeof o !== "object" || seen.includes(o)) return undefined;
      seen.push(o);
      if (Object.hasOwn(o, k)) return o[k];
      for (const v of Object.values(o)) { const r = walk(v, d + 1); if (r !== undefined) return r; }
      return undefined;
    };
    return walk(m);
  };
  for (const k of ["deterministic", "testedBeforeEveryDeploy"]) {
    const v = grab(k);
    ok(typeof v === "string" && v.length > 40,
       `${k} is a sentence that states its own exceptions, not a boolean that cannot (${typeof v})`);
  }
  ok(/model-backed/.test(flat) && /metered/.test(flat),
     "...and those sentences actually name what is excluded");
}

// --- the catalog knows which of its own entries are model-backed -----------
{
  const src = read("src/server.js") || "";
  ok(/MODEL_BACKED_SLUGS/.test(src) && /export function isModelBacked/.test(src),
     "model-backed entries are derived from the kits themselves, so a new model-backed kit cannot be counted as deterministic by omission");
}

console.log(`test-copy-absolutes: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
