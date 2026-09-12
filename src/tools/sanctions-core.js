// Screening a name or a crypto address against the published sanctions lists.
//
// WHAT THIS IS AND IS NOT, because the difference is the whole product.
//
// A HIT is a fact: this exact string appears on a list we downloaded, and we
// can name the list, the entry and when we fetched it.
//
// A MISS IS NOT A CLEARANCE. It means "not found on the lists we checked, as
// of the date we fetched them". Sanctions lists change without notice, the
// same person appears under many spellings, and ownership rules (OFAC's 50%
// rule, for one) put entities on the hook that appear on no list by name. A
// tool that answers "clean" invites someone to rely on it for a decision it
// cannot support, and that is a worse failure than answering nothing at all.
// So there is no `clean`, no `safe` and no boolean that reads as permission:
// the answer is `match` / `no_match_on_lists_checked`, every response names
// the lists and their fetch dates, and the caveat rides in the payload rather
// than in documentation someone may not read.
//
// Pure: no network, no clock beyond what the caller passes. The loader fetches
// and caches; this decides what a match is, so the matching can be tested
// exhaustively without touching a government endpoint.

/** Assets whose addresses are case-sensitive. Folding these merges distinct
 *  addresses, the same rule src/payer.js follows for payers. */
const CASE_SENSITIVE = new Set(["XBT", "BTC", "BCH", "LTC", "XMR", "ZEC", "DASH", "SOL", "TRX", "XRP", "ADA", "DOT"]);

/** Normalise one address for comparison. EVM is case-insensitive (and often
 *  checksummed); base58/bech32 chains are NOT. */
export function normalizeAddress(addr, asset = null) {
  const a = String(addr || "").trim();
  if (!a) return null;
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) return a.toLowerCase();           // EVM
  if (asset && !CASE_SENSITIVE.has(String(asset).toUpperCase())) return a.toLowerCase();
  return a;                                                             // exact, never folded
}

/**
 * Every "Digital Currency Address - <ASSET> <address>" in an OFAC SDN export.
 *
 * Parsed from the remarks column rather than a dedicated field because that is
 * where OFAC publishes them; one SDN entry can carry dozens. Returns a Map of
 * normalized address -> { asset, addresses, entry } so a lookup is O(1) and a
 * hit can name who it belongs to.
 */
export function parseSdnCryptoAddresses(csv) {
  const out = new Map();
  const text = String(csv || "");
  // Row-anchored so an entry's name can be attached to its addresses: the SDN
  // csv is one entry per line, id first, name second.
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes("Digital Currency Address")) continue;
    const name = (line.match(/^\s*\d+\s*,\s*"([^"]*)"/) || [])[1] || null;
    const id = (line.match(/^\s*(\d+)\s*,/) || [])[1] || null;
    for (const m of line.matchAll(/Digital Currency Address - ([A-Z0-9]{2,6})\s+([a-zA-Z0-9]{20,100})/g)) {
      const [, asset, addr] = m;
      const key = normalizeAddress(addr, asset);
      if (!key) continue;
      if (!out.has(key)) out.set(key, { asset, address: addr, entity: name, sdnId: id });
    }
  }
  return out;
}

/** Names from an OFAC SDN export: primary name + the entry id. */
export function parseSdnNames(csv) {
  const out = [];
  for (const line of String(csv || "").split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s*,\s*"([^"]*)"\s*,\s*([^,]*)/);
    if (!m) continue;
    const [, id, name, type] = m;
    if (!name || name === "-0-") continue;
    out.push({ id, name, type: (type || "").replace(/"/g, "").trim() || null });
  }
  return out;
}

/** Fold a name for comparison: case, punctuation and corporate suffixes.
 *  Deliberately conservative - it never drops words that carry identity. */
export function foldName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[.,'"()]/g, " ")
    .replace(/\b(co|corp|corporation|inc|incorporated|ltd|limited|llc|llp|plc|gmbh|sa|nv|bv|ag|as|oyj|ab|pte|pty|jsc|pjsc|ojsc|ooo|oao|pao|zao)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Name screening. EXACT and CONTAINS only - never a fuzzy distance.
 *
 * A fuzzy matcher on sanctions data is a liability: it produces confident
 * near-misses on common surnames, and a caller acting on "87% similar to a
 * sanctioned person" is acting on a number we invented. Exact and substring
 * matches are facts a reader can check against the published list themselves.
 * Callers who want fuzzy matching have the entry list to do it on their own
 * terms, with their own tolerance, which is where that decision belongs.
 */
export function screenName(query, entries, { limit = 25 } = {}) {
  const q = foldName(query);
  if (!q || q.length < 3) return { query: String(query || ""), matches: [], reason: "a name needs at least three characters to screen" };
  const exact = [], contains = [];
  for (const e of entries || []) {
    const n = foldName(e.name);
    if (!n) continue;
    if (n === q) exact.push({ ...e, matchType: "exact" });
    else if (n.includes(q) || q.includes(n)) contains.push({ ...e, matchType: "contains" });
    if (exact.length + contains.length > 5000) break; // pathological query guard
  }
  return { query: String(query || ""), matches: [...exact, ...contains].slice(0, limit), exactCount: exact.length, containsCount: contains.length };
}

/**
 * The verdict vocabulary. There is no "clear", "clean", "safe" or "approved"
 * in it, and that is deliberate: a word like that is read as permission, and
 * nothing here can grant permission.
 */
export const SANCTIONS_VERDICTS = Object.freeze({
  match: "this exact value appears on at least one of the lists named in `listsChecked`",
  no_match_on_lists_checked: "this value does not appear on the lists named in `listsChecked`, as of the dates in `listsFetchedAt`. That is NOT a clearance: lists change without notice, entities appear under many spellings, and ownership rules put parties in scope who are named on no list. Use this as one input to your own screening, never as the decision",
  match_caveat: "a match is a string match against a published list, not a confirmed identification. Names repeat and addresses are reused; confirm the entry against the list itself (the SDN id is given) before acting on it",
  lists_unavailable: "we could not load one or more lists, so this answer would be incomplete and is refused rather than reported as no match",
});
