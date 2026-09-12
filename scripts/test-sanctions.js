#!/usr/bin/env node
// Sanctions screening, and the one property that matters more than accuracy:
// a MISS MUST NEVER READ AS A CLEARANCE.
//
// Everything else here is ordinary parsing. This part is not: a caller who
// reads "no match" as "cleared to transact" has been handed a decision this
// tool cannot support - lists change without notice, the same party appears
// under many spellings, and ownership rules put entities in scope who are
// named on no list at all. So the verdict vocabulary contains no word that
// reads as permission, the caveat travels IN the payload rather than in
// documentation, and a list we could not load REFUSES rather than reporting
// an empty list as a clean result. Each of those is asserted below, and the
// last one is the one that would be catastrophic to get wrong: an empty parse
// served as "no match" makes every query on earth come back clean.
import { strict as assert } from "node:assert";
import { parseSdnCryptoAddresses, parseSdnNames, screenName, foldName, normalizeAddress, SANCTIONS_VERDICTS } from "../src/tools/sanctions-core.js";

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); n++; };

// A miniature SDN export in the real format, including the shapes that matter:
// several addresses on one entry, mixed assets, and an entry with none.
const CSV = [
  '24003,"MESRI, Behzad",-0- ,"IRAN",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"Digital Currency Address - ETH 0x252a8Bd2319D8A555b872990601221b3A2053bCE; alt. Digital Currency Address - XBT 1LrxsRd7zNuxPJcL5rttnoeJFyfq5HTMe4"',
  '12345,"GAZPROMBANK JOINT STOCK COMPANY","entity","RUSSIA",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ',
  '999,"PLAIN ENTITY WITH NO ADDRESSES","entity","CUBA",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ',
].join("\n");

// --- parsing -----------------------------------------------------------------
{
  const addrs = parseSdnCryptoAddresses(CSV);
  eq(addrs.size, 2, "both addresses on ONE entry are parsed - OFAC packs many into a single remarks field, and stopping at the first would silently miss most of the list");
  const eth = addrs.get("0x252a8bd2319d8a555b872990601221b3a2053bce");
  ok(eth && eth.entity === "MESRI, Behzad" && eth.sdnId === "24003", "a hit names the entity and its SDN id, so the caller can check it against the published list themselves");
  eq(eth.asset, "ETH", "and the asset it was listed under");
  ok(addrs.has("1LrxsRd7zNuxPJcL5rttnoeJFyfq5HTMe4"), "a Bitcoin address is kept EXACTLY - base58 is case-sensitive and folding it would miss the match");

  const names = parseSdnNames(CSV);
  eq(names.length, 3, "every named entry is parsed, including one with no addresses");
  ok(names.some((x) => x.name === "GAZPROMBANK JOINT STOCK COMPANY"), "names come through verbatim");
}

// --- address normalisation ---------------------------------------------------
{
  eq(normalizeAddress("0xABCDEF0123456789012345678901234567890123"), "0xabcdef0123456789012345678901234567890123", "EVM is case-insensitive, so a checksummed address matches a lowercase listing");
  eq(normalizeAddress("1LrxsRd7zNuxPJcL5rttnoeJFyfq5HTMe4", "XBT"), "1LrxsRd7zNuxPJcL5rttnoeJFyfq5HTMe4", "a Bitcoin address is NEVER folded");
  eq(normalizeAddress("TNiq9AXBp9EjUqhDhrwrfvAA8U3GUQZH81", "TRX"), "TNiq9AXBp9EjUqhDhrwrfvAA8U3GUQZH81", "nor a Tron address");
  eq(normalizeAddress("  "), null, "blank is null, never an empty-string key that matches everything");
}

// --- name screening ----------------------------------------------------------
{
  const names = parseSdnNames(CSV);
  const r = screenName("Gazprombank", names);
  eq(r.matches.length, 1, "a substring of a listed name matches");
  eq(r.matches[0].matchType, "contains", "and says HOW it matched, so a reader can judge it");
  eq(screenName("Gazprombank Joint Stock", names).matches.length, 1, "corporate suffixes are folded, so a near-spelling of the same entity still lands");
  eq(screenName("zzzznotreal", names).matches, [], "an unrelated name matches nothing");
  eq(screenName("ab", names).matches, [], "a two-character query is refused rather than matching half the list");
  ok(screenName("ab", names).reason, "...and says why");
  // No fuzzy distance, on purpose.
  eq(screenName("Gazpromm", names).matches, [], "a MISSPELLING does not match: this is exact-and-substring only, because a confident near-miss on a sanctions list is a liability, not an answer. Callers who want fuzzy matching can do it on their own terms");
  eq(foldName("Gazprom Neft, PJSC"), "gazprom neft", "folding drops punctuation and corporate suffixes (PJSC/JSC/LLC/GmbH...) so a filer's own spelling still lands");
  eq(foldName("Gazprom"), "gazprom", "...and leaves an identity word alone");
  ok(foldName("Public Joint Stock Company Gazprom Neft").includes("gazprom neft"), "a long official style still contains the identity");
}

// --- THE PROPERTY THAT MATTERS ----------------------------------------------
{
  const v = JSON.stringify(SANCTIONS_VERDICTS).toLowerCase();
  for (const w of ["clean", "cleared", "clear of", "safe", "approved", "permitted", "ok to"])
    ok(!v.includes(w), `no verdict says "${w}" - a word that reads as permission is the one thing this tool must never say`);
  ok(!("clean" in SANCTIONS_VERDICTS) && !("clear" in SANCTIONS_VERDICTS), "and there is no such verdict to return");
  eq(Object.keys(SANCTIONS_VERDICTS).sort(), ["lists_unavailable", "match", "no_match_on_lists_checked"], "the vocabulary is closed and each name states its own limit");
  ok(/NOT a clearance/i.test(SANCTIONS_VERDICTS.no_match_on_lists_checked), "the miss verdict says in so many words that it is not a clearance");
  ok(/lists change|spellings|ownership/i.test(SANCTIONS_VERDICTS.no_match_on_lists_checked), "...and names the specific reasons it cannot be one, rather than hedging vaguely");
  ok(/refused rather than reported as no match/i.test(SANCTIONS_VERDICTS.lists_unavailable),
     "an unavailable list REFUSES: serving 'no match' off a list that failed to load makes every query on earth come back clean, which is the worst failure available here");
}

// --- an empty parse is a format change, never an empty list ------------------
{
  const src = (await import("node:fs")).readFileSync(new URL("../src/tools/sanctions-kit.js", import.meta.url), "utf8");
  ok(/if \(!names\.length\) throw new Error/.test(src),
     "a parse yielding zero entries THROWS and keeps the previous good load - OFAC changing their export format must not silently turn every screen into a pass");
  ok(/if \(!state\.fetchedAt\) throw bad\(SANCTIONS_VERDICTS\.lists_unavailable, 503\)/.test(src),
     "and with nothing cached the handler refuses 503 rather than answering from an empty map");
  ok(/notAClearance/.test(src), "the caveat rides in every response envelope, not in documentation nobody reads");
}

console.log(`test-sanctions: ${n} assertions OK`);
