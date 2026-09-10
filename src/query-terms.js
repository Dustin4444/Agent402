// Query tokenization for the lexical routers (/api/route, /api/find, the
// /api/index search), Unicode-aware.
//
// Why (2026-09-10, reported from outside): every router split the query on
// `[^a-z0-9]+`, so a query in any script other than basic Latin produced ZERO
// terms and zero results - "中国供应商核验" returned nothing while "china
// supplier verification" ranked three sellers. Reproduced on prod the same
// day. The scorer is lexical and stays lexical: this does not translate, it
// only stops throwing the query away.
//
// Rules:
//   - a run of letters/digits is a term (Unicode letters count; case-folded);
//   - a run of CJK ideographs / kana / hangul carries no word boundaries, so it
//     is emitted as CHARACTER BIGRAMS (中国供应商 -> 中国, 国供, 供应, 应商) plus
//     the whole run, which is the usual n-gram treatment for unsegmented
//     scripts; a lone CJK character is a term on its own;
//   - the ASCII short-term rule stands: a Latin term under three characters
//     matches whole tokens only ("ip" must not substring-match gzip); a CJK
//     bigram is two characters by construction and matches by substring, which
//     is the only sensible match for an unsegmented script.
// Pure functions, no state, imported by three routers so they cannot drift.

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const NON_TOKEN_RE = /[^\p{L}\p{N}]+/u;

/** True when the term is made of CJK characters (bigram or whole run). */
export function isCjkTerm(term) {
  return typeof term === "string" && term.length > 0 && [...term].every((ch) => CJK_RE.test(ch));
}

/** Split a string into alphanumeric runs, Unicode-aware, lower-cased. */
export function splitTokens(str) {
  return String(str || "").toLowerCase().split(NON_TOKEN_RE).filter(Boolean);
}

/** Expand one alphanumeric run into terms: a Latin/other-script run is one
 *  term; a run containing CJK is split into CJK stretches (bigrams + whole
 *  stretch) and the non-CJK remainder. */
function expandRun(run) {
  if (!CJK_RE.test(run)) return [run];
  const out = [];
  let cjk = "", other = "";
  const flush = () => {
    if (cjk) {
      const chars = [...cjk];
      if (chars.length === 1) out.push(chars[0]);
      else {
        for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1]);
        out.push(cjk);
      }
      cjk = "";
    }
    if (other) { out.push(other); other = ""; }
  };
  for (const ch of run) {
    if (CJK_RE.test(ch)) { if (other) { out.push(other); other = ""; } cjk += ch; }
    else { if (cjk) flush(); other += ch; }
  }
  flush();
  return out;
}

/**
 * Query -> terms. Deduplicated, in order of first appearance, capped.
 * @param {string} q
 * @param {object} [o]
 * @param {number} [o.max=32]      cap on the number of terms
 */
export function queryTerms(q, { max = 32 } = {}) {
  const seen = new Set();
  const out = [];
  for (const run of splitTokens(q)) {
    for (const t of expandRun(run)) {
      if (seen.has(t)) continue;
      seen.add(t); out.push(t);
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** The match predicate for one term against a lower-cased haystack string:
 *  substring for terms of three or more characters and for every CJK term;
 *  whole-token for a short Latin term (the 2026-08-28 "ip" rule). */
export function termMatcher(term) {
  if (term.length >= 3 || isCjkTerm(term)) return (str) => str.includes(term);
  return (str) => splitTokens(str).includes(term);
}
