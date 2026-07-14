// One-shot generator for src/data/countries.json — the committed dataset behind
// /api/country-info. Trims the full world-countries dataset (~1.4MB) down to
// exactly the fields the tool returns, pre-joined with the IANA timezone
// country map, so the tool is pure CPU at serve time (no network, PoW-eligible).
//
// Sources (both open data):
//   world-countries@5.1.0  (ODbL 1.0)  https://github.com/mledoze/countries
//   moment-timezone@0.6.2 meta map (MIT; tz data itself is public domain)
//
// Usage: node scripts/build-countries-data.js
// Re-run only when bumping the pinned upstream versions; commit the output.
import { writeFileSync, mkdirSync } from "node:fs";

const COUNTRIES_URL = "https://cdn.jsdelivr.net/npm/world-countries@5.1.0/countries.json";
const TZ_META_URL = "https://cdn.jsdelivr.net/npm/moment-timezone@0.6.2/data/meta/latest.json";

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

const [raw, tzMeta] = await Promise.all([getJson(COUNTRIES_URL), getJson(TZ_META_URL)]);
if (!Array.isArray(raw) || raw.length < 100) throw new Error("countries dataset: unexpected shape");
if (!tzMeta?.countries) throw new Error("tz meta map: unexpected shape");

const trimmed = raw.map((c) => {
  const idd = c.idd || {};
  // Calling code: root+suffix when there's exactly one suffix (247 countries). With
  // multiple suffixes, the bare root is only a complete dialing code for the shared
  // roots +1 (NANP: US/CA/DO/PR) and +7 (RU/KZ) — for anything else (EH/SH/VA) no
  // single prefix exists, so emit null plus the full `callingCodes` list instead.
  const suffixes = idd.suffixes || [];
  let callingCode = null;
  let callingCodes;
  if (idd.root) {
    if (suffixes.length === 1) callingCode = idd.root + suffixes[0];
    else if (idd.root === "+1" || idd.root === "+7") callingCode = idd.root;
    else if (suffixes.length > 1) callingCodes = suffixes.map((s) => idd.root + s);
  }
  // Record keys are exactly the country-info response's `country` object —
  // the handler filters on name/officialName/code2/code3 and returns the
  // matching record as-is.
  return {
    name: c.name?.common ?? null, officialName: c.name?.official ?? null,
    code2: c.cca2 ?? null, code3: c.cca3 ?? null,
    capital: Array.isArray(c.capital) ? c.capital[0] ?? null : c.capital ?? null,
    region: c.region ?? null, subregion: c.subregion ?? null,
    currencies: Object.entries(c.currencies || {}).map(([cc, v]) => ({ code: cc, name: v?.name ?? null, symbol: v?.symbol ?? null })),
    languages: Object.values(c.languages || {}),
    timezones: tzMeta.countries[c.cca2]?.zones ?? null,
    callingCode, ...(callingCodes ? { callingCodes } : {}),
    tld: Array.isArray(c.tld) ? c.tld[0] ?? null : c.tld ?? null,
    demonym: c.demonyms?.eng?.m ?? null, flag: c.flag ?? null,
    latlng: c.latlng ?? null, area: c.area ?? null,
    landlocked: c.landlocked === true, borders: c.borders ?? [], unMember: c.unMember === true,
  };
});

trimmed.sort((a, b) => (a.code2 || "").localeCompare(b.code2 || ""));
mkdirSync(new URL("../src/data/", import.meta.url), { recursive: true });
const out = "[\n" + trimmed.map((c) => JSON.stringify(c)).join(",\n") + "\n]\n";
writeFileSync(new URL("../src/data/countries.json", import.meta.url), out);
console.log(`wrote src/data/countries.json — ${trimmed.length} countries, ${(out.length / 1024).toFixed(1)} KB`);
