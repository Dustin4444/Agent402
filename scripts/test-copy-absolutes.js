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
    // THE CLASS, not one string. The first cut matched the exact sentence
    // "Only sellers with proven on-chain settlement are routable" and passed
    // green over three more live phrasings of the same claim: /x402-101 said
    // "proven settlement" (no "on-chain"), the README said "routes only to
    // sellers with proven on-chain settled volume", and the resolver's own
    // comment said "we route ONLY to sellers with proven settled volume". A
    // claim has as many phrasings as people who write it down, so this matches
    // the SHAPE: an exclusivity word near "seller" near "proven".
    re: /\b(?:only|exclusively)\b[^.]{0,60}sellers?[^.]{0,80}proven|\bproven\b[^.]{0,60}sellers?[^.]{0,40}\bonly\b/i,
    why: "the unproven Solana tier makes the exclusive form false; render routingProofSentence() or name the chain it is true of",
    // The claim is always about ROUTING or ELIGIBILITY. Without this the rule
    // also read a payTo-mismatch comment ("we only refuse on a positive
    // MISMATCH, so sellers proven by a source...") as the same claim.
    requires: /\brout|eligib|dispatch/i,
    // True as written when it names the rail it is scoped to, IN THE SAME
    // SENTENCE: a chain named three lines away is prose, not a scope.
    scopedBy: /\bBase\b|\bSolana\b|\bTempo\b|\bAlgorand\b/,
    scopeWindow: 0,
    exempt: new Map([
      ["src/changelog.js", "dated release notes are a historical record: each entry describes what shipped on its date"],
      ["src/routing-proof.js", "the module that renders the honest sentence quotes the old one to explain it"],
    ]),
  },
  {
    // Same shape for the no-model claim. Every honest use on the site scopes it
    // ("of the utility tools", "the deterministic tools"); the README's
    // hand-written /why copy did not, and said the service runs no model at all.
    re: /\bno (?:model|LLM)\b[^.]{0,30}serving path/i,
    why: "the /v1 tiers, the reports and the media tools run models; scope the claim to the utility or deterministic tools",
    scopedBy: /utility|deterministic|these tools|those tools|this kit|pure[- ]CPU/i,
    scopeWindow: 3,
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
    const lines = text.split("\n");
    for (const { re, why, scopedBy, exempt, requires, scopeWindow = 0 } of FORBIDDEN) {
      if (exempt?.has(rel)) continue;
      for (let i = 0; i < lines.length; i++) {
        const sentence = `${lines[i]} ${lines[i + 1] || ""}`;
        const m = sentence.match(re);
        if (!m) continue;
        if (requires && !requires.test(sentence)) continue;      // a different subject entirely
        const near = scopeWindow
          ? lines.slice(Math.max(0, i - scopeWindow), i + 2).join(" ")
          : sentence;
        if (scopedBy?.test(near)) continue;                      // scoped in its own sentence
        found.push(`${rel} carries "${m[0].trim()}" (${why})`);
        break;
      }
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
// /api/pricing publishes `modelBacked` per row, which is a MACHINE-READABLE
// claim on 580+ endpoints and so a worse place to be wrong than the prose this
// guard started with. The first cut asserted only that the symbols EXIST, with
// a comment claiming a new model-backed kit "cannot be counted as deterministic
// by omission" - and that was false: dropping a whole kit from
// MODEL_BACKED_KITS published modelBacked:false for every one of its tools and
// left all guards green (measured). Membership is derived from the kits' own
// SOURCE here instead: a file that reaches a model upstream must have its tool
// array in the list, directly or through one alias hop.
{
  const server = read("src/server.js") || "";
  ok(/MODEL_BACKED_SLUGS/.test(server) && /export function isModelBacked/.test(server),
     "the catalog derives modelBacked from the kits rather than a hand-kept slug list");

  const MODEL_UPSTREAM = /openrouter\.ai|api\.openai\.com|callOpenRouter|OPENROUTER_API_KEY|anthropic\.com\/v1\/messages/;
  const kitFiles = files.filter((f) => f.startsWith("src/tools/") && MODEL_UPSTREAM.test(read(f) || ""));
  ok(kitFiles.length >= 15, `found ${kitFiles.length} kits that reach a model upstream (a collapsed list must not pass)`);

  // `const NAME = [ ...A, ...B ];` in server.js, so one alias hop resolves -
  // GATEWAY_TOOLS_ENABLED is really the gateway plus the Messages and Responses
  // kits, and without the hop those three would read as uncovered.
  const spreadsIn = (name) => {
    const m = server.match(new RegExp(`const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\n\\];`));
    return m ? new Set(m[1].match(/\.\.\.([A-Z0-9_]+)/g)?.map((x) => x.slice(3)) || []) : new Set();
  };
  const listed = spreadsIn("MODEL_BACKED_KITS");
  ok(listed.size > 0, "MODEL_BACKED_KITS is readable from source");
  const reachable = new Set(listed);
  for (const n of listed) for (const inner of spreadsIn(n)) reachable.add(inner);

  // A function, so the control drives the SAME code path: an "assert no
  // findings" check with no control passes just as happily when it is broken.
  const exportsOf = (f) => ((read(f) || "").match(/^export const ([A-Z0-9_]+_TOOLS[A-Z0-9_]*)/gm) || [])
    .map((x) => x.replace("export const ", ""));
  function uncovered(kits, inList, exports = exportsOf) {
    const out = [];
    for (const f of kits) {
      const ex = exports(f);
      if (!ex.length) continue;                     // helper-only module
      if (ex.some((n) => inList.has(n))) continue;  // covered, directly or via an alias
      out.push(`${f} exports ${ex.join(", ")}`);
    }
    return out;
  }
  ok(uncovered(["<control>"], reachable, () => ["NOT_IN_THE_LIST_TOOLS"]).length === 1,
     "control: a model-reaching kit absent from MODEL_BACKED_KITS is reported by this exact code path");

  const missing = uncovered(kitFiles, reachable);
  ok(missing.length === 0,
     `every kit that reaches a model upstream is in MODEL_BACKED_KITS${missing.length ? ` - MISSING: ${missing.join(" | ")}` : ""}`);
}

// --- the class rules are pinned in BOTH directions -------------------------
// A shape-matching rule earns its keep only if the honest phrasings are proven
// to pass; otherwise the next author suppresses it and the guard is decoration.
{
  const MUST_FAIL = [
    "Only sellers with proven on-chain settlement are routable.",
    "Only sellers with proven settlement are routable.",
    "it routes only to sellers with proven on-chain settled volume",
    "So we route ONLY to sellers with proven settled volume",
    "open source and self-hostable, no model in the tool serving path.",
    "no LLM in the serving path - the same input always yields the same output",
    // Wrapped across lines, the way a comment or a paragraph really wraps.
    // Without joining the pair the claim is invisible to a line-by-line match.
    "// So we route ONLY to sellers with\n// proven settled volume: the leaderboard is real deliveries",
    // A chain named three lines EARLIER is prose, not a scope: still a failure.
    // (The window reads backward, so this is the side that pins scopeWindow 0.)
    "We settle on Base.\nOne payment in, result out.\nPrices are flat.\nOnly sellers with proven settlement are routable."
  ];
  const MUST_PASS = [
    "On Base we route ONLY to sellers with proven settled volume",
    "Sellers are routable on proven on-chain settlement, with one exception: a Solana seller with no settlement history yet is tried only after every proven candidate.",
    "no LLM in the serving path of the utility tools - the same input always yields the same output",
    "The deterministic tools run no model in their serving path",
    "the leaderboard ranks sellers by settlements actually observed on chain",
    "UNKNOWN does not block - we only refuse on a positive MISMATCH, so sellers proven by a source that cannot name an address are unaffected",
    "instead of USDC - no money and no AI tokens (no model in the serving path of these tools)",
    // The no-model rule DOES read a small window: its honest uses open a
    // paragraph with the scope and qualify a clause a line or three below.
    "Agent-kit - the deterministic tools an agent needs most:\nexact token counting and chunking. All pure-CPU,\nno network,\nno LLM in the serving path.",
  ];
  const hits = (t) => sweep([["<case>", t]]).length;
  const missed = MUST_FAIL.filter((t) => hits(t) === 0);
  const wrong = MUST_PASS.filter((t) => hits(t) > 0);
  ok(missed.length === 0, `every known phrasing of the class is caught${missed.length ? ` - MISSED: ${missed.join(" | ")}` : ""}`);
  ok(wrong.length === 0, `honest, scoped phrasings are NOT caught${wrong.length ? ` - FALSE POSITIVE: ${wrong.join(" | ")}` : ""}`);
}

console.log(`test-copy-absolutes: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
