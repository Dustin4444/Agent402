// One-call tool resolver. Instead of an agent spending tokens searching the web
// and reading pages just to discover how to do something, it sends a task
// description here and gets back the best-matching tool(s) with everything needed
// to call them directly: route, price, input schema, and a ready example.
// Deterministic lexical ranking (no LLM, no tokens), consistent with the MCP
// connector's search_tools weighting.
import { toolList } from "./pages.js";
import { rankSkillPacks } from "./skills.js";
import { UNIT_CATEGORIES } from "./tools/convert-gen.js";
import { UNIT_ALIASES } from "./tools/kit2.js";

// Common English stopwords that contribute noise instead of intent. Kept short
// on purpose — every word here matches many tool descriptions, so dropping it
// from the query sharpens ranking without affecting recall on the intent words.
const STOPWORDS = new Set([
  "a", "an", "the", "of", "in", "on", "to", "for", "with", "by", "and", "or",
  "is", "are", "was", "were", "be", "been", "this", "that", "it", "as", "at",
  "from", "into", "onto", "my", "me", "i", "you", "your", "we", "our",
  "do", "does", "did", "can", "will", "would", "should",
]);

// Every unit word the retired ~970 pairwise convert-<from>-to-<to> slugs used
// to lexical-match, derived from the live conversion table (full ids split on
// hyphens, e.g. "nautical-miles" → nautical + miles) plus the short aliases
// unit-convert accepts (km, kg, mph, …). A query containing any of these words
// gets the synthetic term "units" appended, which maps it onto unit-convert's
// curated "units" tag — so "convert stones to kg"-style tasks still resolve to
// the one surviving converter instead of tying across unrelated *-convert
// tools. "per"/"us" are dropped: they appear inside compound ids
// (miles-per-hour, us-gallons) but are far too generic as standalone triggers.
// Known tradeoff: generic time words (days/hours/years/seconds/light) stay in
// the set, adding mild recall noise for date-ish queries. Deliberate — the
// find suite locks the current behavior; trim later if it bites.
const UNIT_WORDS = new Set(
  [
    ...Object.values(UNIT_CATEGORIES).flatMap((cat) => Object.keys(cat.units).flatMap((id) => id.split("-"))),
    ...Object.keys(UNIT_ALIASES),
  ].filter((w) => w.length > 1 && !STOPWORDS.has(w) && w !== "per" && w !== "us")
);

// Delegated-purchase intent (see the synthetic "sor" term below). Both sets
// must hit for the term to be appended - "buy bitcoin price" stays a crypto
// query, and "pay an EXTERNAL api" becomes a router query.
const DELEGATION_VERBS = new Set(["buy", "purchase", "pay", "order", "hire", "rent", "outsource", "delegate", "call"]);
const THIRD_PARTY_MARKERS = new Set(["external", "another", "other", "others", "someone", "somebody", "seller", "sellers", "vendor", "third", "party", "third-party", "behalf", "elsewhere", "ecosystem", "marketplace"]);

/**
 * Rank catalog tools against a free-text task description.
 * @param {object} catalog  CATALOG map (route -> def)
 * @param {string} query    natural-language task / keywords
 * @param {object} [opts]
 * @param {number} [opts.k=5]        max results
 * @param {string} [opts.baseUrl=""] base for docs links
 * @param {Set<string>} [opts.powSlugs] compute-payable slugs (for the free flag)
 * @returns {{query:string, count:number, results:Array}}
 */
export function findTools(catalog, query, { k = 5, baseUrl = "", powSlugs } = {}) {
  // Cap the query length so a pathological input can't drive unbounded work.
  const q = String(query || "").slice(0, 500);
  // Strip stopwords + 1-char tokens — they match thousands of tools and add noise
  // without signal. Keep the cap tight so each scoring pass is bounded.
  const rawTerms = q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const terms = rawTerms.filter((t) => t.length > 1 && !STOPWORDS.has(t)).slice(0, 32);
  // Unit-word synonym: "convert miles to kilometers"-style tasks used to hit a
  // dedicated pairwise slug; now they must resolve to unit-convert. One
  // synthetic "units" term (a curated unit-convert tag) is enough to break the
  // score tie against the other *-convert tools without distorting queries
  // that never mention a unit.
  if (!terms.includes("units") && terms.some((t) => UNIT_WORDS.has(t))) terms.push("units");
  // Same mechanism for DELEGATED PURCHASE intent: "buy a tool from another
  // seller", "pay an external api on my behalf" are asking for the Smart Order
  // Router (it resolves a seller, pays them over x402, relays the result), but
  // lexically they lose to unrelated tools - "api" matches every openapi-*
  // slug and "pay" matches "payload" (audited 2026-07-28). Requires BOTH a
  // delegation verb AND a third-party marker, so ordinary "buy"/"pay" queries
  // are untouched; the synthetic "sor" term is a curated route-execute tag.
  if (!terms.includes("sor")
    && terms.some((t) => DELEGATION_VERBS.has(t))
    && terms.some((t) => THIRD_PARTY_MARKERS.has(t))) terms.push("sor");
  const limit = Math.min(Math.max(parseInt(k, 10) || 5, 1), 25);
  if (!terms.length) return { query: q, count: 0, results: [] };

  // Directional alignment: how many adjacent (q[i], q[i+1]) query-term pairs
  // appear in the slug *in the same order*. Historically this broke the tie
  // between the symmetric pairwise convert slugs (miles-to-km vs km-to-miles —
  // both retired in favor of unit-convert); it still helps any directional
  // slug family (html-to-markdown vs markdown-to-html). Cheap to compute
  // (O(terms) per tool) and contributes only to the tiebreak, so it never
  // overrides a stronger lexical match.
  const directionScore = (slug) => {
    let s = 0;
    for (let i = 0; i < terms.length - 1; i++) {
      const a = slug.indexOf(terms[i]);
      const b = slug.indexOf(terms[i + 1]);
      if (a !== -1 && b !== -1 && a < b) s++;
    }
    return s;
  };

  // How INFORMATIVE is each query term? A term that matches half the catalog
  // ("check", "data", "text") says almost nothing about which tool is wanted; a
  // term that matches three ("sessions", "website", "transcribe") says almost
  // everything. Scoring them equally is why "check if a website is up" resolved
  // to `spf-check` — three tools share the word "check", the one distinguishing
  // word "website" counted for one point, and the common word decided it.
  //
  // Standard inverse-document-frequency, computed live from the catalog itself
  // so it needs no tuning table and cannot go stale as tools are added. Fully
  // deterministic: same catalog and same query give the same ranking, which the
  // no-LLM contract requires.
  const all = toolList(catalog);
  const N = all.length || 1;
  const matchesTerm = (t, term) => {
    const slug = t.slug.toLowerCase();
    if (slug.includes(term)) return true;
    if ((t.name || "").toLowerCase().includes(term)) return true;
    return `${t.name} ${t.description} ${t.category} ${(t.tags || []).join(" ")}`.toLowerCase().includes(term);
  };
  const idf = new Map();
  for (const term of terms) {
    let df = 0;
    for (const t of all) if (matchesTerm(t, term)) df++;
    // log((N+1)/(df+1)): ~5.6 for a term unique to one tool, ~1.0 for one that
    // matches 200. Floored so a ubiquitous term still nudges rather than
    // flipping sign or vanishing entirely.
    idf.set(term, Math.max(0.25, Math.log((N + 1) / (df + 1))));
  }

  const scored = [];
  for (const t of all) {
    const slug = t.slug.toLowerCase();
    const name = (t.name || "").toLowerCase();
    const tagSet = new Set((t.tags || []).map((tg) => String(tg).toLowerCase()));
    const hay = `${t.name} ${t.description} ${t.category} ${(t.tags || []).join(" ")}`.toLowerCase();
    // Slugs are hyphenated words, so a WHOLE segment matching a query term is a
    // real signal while an incidental substring is usually an accident:
    // "check" sits inside "checksum", "data" inside "wikidata-entity", "detect"
    // inside "base-detect". Those accidents used to score the same +4 as a
    // genuine match, which is how "check if a website is up" resolved to
    // `checksum`/`spf-check` while `http-check` lost, and "store data between
    // sessions" resolved to `wikidata-entity` while the memory tools lost.
    //
    // A wrong top result is not a cosmetic problem here: /api/find is the entry
    // point we advertise everywhere, and an agent that trusts it pays for the
    // wrong tool and gets something useless on its first call.
    const segs = new Set(slug.split("-"));
    let score = 0;
    for (const term of terms) {
      let s = 0;
      if (slug === term) s += 10;
      else if (segs.has(term)) s += 6;      // a whole word of the slug
      else if (slug.includes(term)) s += 2; // incidental substring, kept but demoted
      if (name.includes(term)) s += 2;
      // A curated tag is a stronger signal than a stray hit in the description.
      if (tagSet.has(term)) s += 3;
      if (hay.includes(term)) s += 1;
      score += s * idf.get(term);           // weight by how much the term narrows things
    }
    if (score > 0) scored.push([score, t, directionScore(slug)]);
  }
  // Highest score first; then more in-order term pairs win (directional intent);
  // then shorter slug (more specific); then alpha for full determinism.
  scored.sort((a, b) =>
    b[0] - a[0] ||
    b[2] - a[2] ||
    a[1].slug.length - b[1].slug.length ||
    a[1].slug.localeCompare(b[1].slug)
  );

  const results = scored.slice(0, limit).map(([score, t]) => {
    const example = t.discovery?.input ?? t.discovery?.example;
    const required = Array.isArray(t.discovery?.inputSchema?.required) ? t.discovery.inputSchema.required : [];
    // Pre-assemble the call so an agent doesn't have to split the route string
    // and decide body-vs-query itself. Body for write methods, query for the rest.
    // Skipped when there's no example — `callExample` should always be runnable.
    let callExample;
    if (example && t.route) {
      const [method, path] = t.route.split(" ");
      callExample = ["POST", "PUT", "PATCH"].includes(method)
        ? { method, path, body: example }
        : { method, path, query: example };
    }
    return {
      slug: t.slug,
      name: t.name,
      route: t.route,
      price: t.price,
      // Discovery up top: the answer to "how do I call this" should be visible
      // before the verbose description/schema/score fields.
      callExample,
      example,
      required,
      inputSchema: t.discovery?.inputSchema,
      category: t.category,
      description: t.description,
      score,
      computePayable: powSlugs ? powSlugs.has(t.slug) : undefined,
      docs: baseUrl ? `${baseUrl}/tools/${t.slug}` : undefined,
    };
  });
  // Cross-surface: also recommend the matching skill pack(s) so an agent asking
  // about a multi-tool task (e.g. "audit a domain") sees the whole workflow,
  // not just the highest-scoring single tool. Empty array when nothing matches
  // strongly — packs only show up when the lexical signal is real.
  // Price each pack's steps from the SAME catalog we just ranked, so the
  // a la carte comparison is live rather than a second copy of the price list.
  const priceIndex = new Map();
  for (const t of toolList(catalog)) {
    const n = Number(String(t.price ?? "").replace(/[^0-9.]/g, ""));
    if (Number.isFinite(n)) priceIndex.set(String(t.slug).toLowerCase(), n);
  }
  const packs = rankSkillPacks(q, {
    k: 2, baseUrl,
    toolPriceUsd: (slug) => priceIndex.get(String(slug).toLowerCase()) ?? null,
  });
  return { query: String(query), count: results.length, results, packs };
}

/**
 * The find->seller bridge: does this query look like the NAME of an indexed
 * x402 seller rather than (or as well as) a task? Agents search /api/find for
 * sellers by name - 25 recorded "misses" for "minia2a" were hunts for the
 * indexed seller minia2a.uk (2026-07-28). Pure lexical matching over the
 * routable-seller summaries; returns AT MOST max sellers as {host, origin,
 * toolCount} - no third-party display text rides along, by construction.
 *
 * Match rules (tuned against false positives on task-shaped queries):
 *  - exact host-label match at >=4 chars ("minia2a" === label of minia2a.uk),
 *    excluding generic labels: "api" exactly matches api.example.com's label
 *    but an agent searching "api" wants tools, not that seller
 *  - substring either way at >=5 chars against the compacted host or the
 *    compacted query ("cloudworldmodel" vs www.cloudworldmodel.ai)
 * Exact label matches rank first, then higher toolCount.
 */
const GENERIC_HOST_LABELS = new Set([
  "api", "apis", "app", "apps", "web", "www", "tool", "tools", "agent",
  "agents", "x402", "mcp", "data", "test", "demo", "dev", "io", "ai", "server",
]);
export function findRelatedSellers(query, sellers, { max = 3 } = {}) {
  const qcompact = String(query || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (qcompact.length < 4 || !Array.isArray(sellers) || GENERIC_HOST_LABELS.has(qcompact)) return [];
  const scored = [];
  for (const s of sellers) {
    const host = String(s.host || "").toLowerCase();
    if (!host) continue;
    const labels = host.split(".").filter((l) => l && l !== "www");
    const hostcompact = labels.join("");
    const exact = labels.some((l) => l.replace(/[^a-z0-9]/g, "") === qcompact);
    const substr = qcompact.length >= 5 && (hostcompact.includes(qcompact) || (hostcompact.length >= 5 && qcompact.includes(hostcompact)));
    if (!exact && !substr) continue;
    scored.push([exact ? 1 : 0, s.toolCount || 0, { host: s.host, origin: s.origin, toolCount: s.toolCount || 0 }]);
  }
  scored.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  return scored.slice(0, max).map((x) => x[2]);
}
