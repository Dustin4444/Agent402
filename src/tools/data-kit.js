// Data kit — live, keyless, commercial-use-OK public data agents can't get from
// a frozen training set. Sources chosen so charging is clean:
//   barcode-lookup    Open Food Facts (open data, ODbL) — UPC/EAN -> product
//   fx-rate           Frankfurter (European Central Bank reference rates)
//   weather-forecast  api.weather.gov (US gov, public domain) — US only
//   public-holidays   Nager.Date (open source, MIT) — holidays by country+year
//   country-info      world-countries dataset (ODbL, the open data behind the
//                     retired restcountries API) + IANA tz country map, both
//                     served version-pinned from jsDelivr and cached in-process
// All keyless. Network tools (wallet-only); covered by scripts/test-data-kit.js.
import { safeFetch } from "./fetch-guard.js";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

async function getJson(url, { allowEmpty = false } = {}) {
  let html;
  // Retry once on upstream 5xx/timeout — community-run upstreams (Nager.Date)
  // intermittently flap on the first attempt then succeed immediately. Same
  // convention as gov-kit/finance-kit getJson.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      ({ html } = await safeFetch(url, { maxBytes: 3 * 1024 * 1024 }));
      break;
    } catch (e) {
      if (attempt === 0 && (e.statusCode === 502 || e.statusCode === 504)) continue;
      throw e;
    }
  }
  if (allowEmpty && (!html || !html.trim())) return null;
  try {
    return JSON.parse(html);
  } catch {
    throw bad("Upstream returned non-JSON", 502);
  }
}

export const DATA_TOOLS = [
  {
    route: "GET /api/barcode-lookup", name: "Barcode product lookup", slug: "barcode-lookup", category: "data", price: "$0.005",
    description:
      "Look up a product by its UPC/EAN barcode number via Open Food Facts (open data): name, brand, category, quantity, and nutrition grade. Pairs with /api/barcode-decode (image → number → product). ?code=737628064502",
    tags: ["barcode", "upc", "ean", "product", "lookup", "open-food-facts"],
    discovery: {
      input: { code: "737628064502" },
      inputSchema: {
        properties: { code: { type: "string", description: "UPC/EAN barcode digits (8-14)" } },
        required: ["code"],
      },
      output: {
        example: {
          code: "737628064502", found: true,
          product: { name: "Thai peanut noodle kit", brands: "Simply Asia", categories: "Meals", quantity: "155 g", nutritionGrade: "d", countries: "United States" },
        },
      },
    },
    handler: async (i) => {
      const code = String(i.code ?? "").trim();
      if (!/^\d{8,14}$/.test(code)) throw bad("code must be 8-14 digits (a UPC/EAN barcode)");
      const url = `https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name,brands,categories,quantity,nutrition_grades,countries,image_url`;
      const j = await getJson(url);
      if (j.status !== 1 || !j.product) return { code, found: false };
      const p = j.product;
      return {
        code, found: true,
        product: {
          name: p.product_name || null, brands: p.brands || null, categories: p.categories || null,
          quantity: p.quantity || null, nutritionGrade: p.nutrition_grades || null,
          countries: p.countries || null, imageUrl: p.image_url || null,
        },
      };
    },
  },
  {
    route: "GET /api/fx-rate", name: "Currency exchange rate", slug: "fx-rate", category: "data", price: "$0.003",
    description:
      "Live currency conversion using European Central Bank reference rates (via Frankfurter). Converts an amount between two currencies and returns the rate and date. ?from=USD&to=EUR&amount=100",
    tags: ["currency", "forex", "fx", "exchange-rate", "convert", "ecb"],
    discovery: {
      input: { from: "USD", to: "EUR", amount: 100 },
      inputSchema: {
        properties: {
          from: { type: "string", description: "3-letter currency code, e.g. USD" },
          to: { type: "string", description: "3-letter currency code, e.g. EUR" },
          amount: { type: "number", description: "amount to convert (default 1)" },
        },
        required: ["from", "to"],
      },
      output: { example: { from: "USD", to: "EUR", amount: 100, rate: 0.923, result: 92.3, date: "2026-06-13" } },
    },
    handler: async (i) => {
      const from = String(i.from ?? "").trim().toUpperCase();
      const to = String(i.to ?? "").trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) throw bad("from and to must be 3-letter currency codes (e.g. USD, EUR)");
      const amount = Number(i.amount ?? 1);
      if (!Number.isFinite(amount) || amount <= 0) throw bad('"amount" must be a positive number');
      // Hit the upstream even on the identity branch so the `date` field is
      // always sourced from Frankfurter (the authoritative trading day),
      // never `new Date()`. Keeps the tool deterministic w.r.t. its inputs +
      // upstream state, which the catalog contract requires.
      if (from === to) {
        const jId = await getJson(`https://api.frankfurter.app/latest?from=USD&to=EUR`);
        return { from, to, amount, rate: 1, result: amount, date: jId.date };
      }
      const j = await getJson(`https://api.frankfurter.app/latest?from=${from}&to=${to}&amount=${amount}`);
      const result = j.rates?.[to];
      if (result == null) throw bad(`unsupported currency pair ${from}/${to}`, 502);
      return { from, to, amount, rate: Number((result / amount).toFixed(6)), result, date: j.date };
    },
  },
  {
    route: "GET /api/weather-forecast", name: "Weather forecast (US)", slug: "weather-forecast", category: "data", price: "$0.003",
    description:
      "Multi-period weather forecast for a US location from api.weather.gov (NWS, public domain). Give latitude and longitude; returns the place plus upcoming forecast periods (temp, wind, conditions). US coverage only. ?lat=40.71&lon=-74.01",
    tags: ["weather", "forecast", "nws", "noaa", "us"],
    discovery: {
      input: { lat: 40.71, lon: -74.01 },
      inputSchema: {
        properties: {
          lat: { type: "number", description: "latitude (US)" },
          lon: { type: "number", description: "longitude (US)" },
        },
        required: ["lat", "lon"],
      },
      output: {
        example: {
          location: { city: "New York", state: "NY" }, lat: 40.71, lon: -74.01,
          periods: [{ name: "Today", temperature: 72, unit: "F", wind: "10 mph", shortForecast: "Sunny" }],
        },
      },
    },
    handler: async (i) => {
      const lat = Number(i.lat), lon = Number(i.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw bad("lat and lon must be valid coordinates");
      let point;
      try {
        point = await getJson(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`);
      } catch {
        throw bad("location not covered — weather.gov serves US locations only", 400);
      }
      const forecastUrl = point.properties?.forecast;
      if (!forecastUrl) throw bad("no forecast available for this location (US only)", 400);
      const loc = point.properties?.relativeLocation?.properties || {};
      const fc = await getJson(forecastUrl);
      const periods = (fc.properties?.periods || []).slice(0, 6).map((p) => ({
        name: p.name, temperature: p.temperature, unit: p.temperatureUnit,
        wind: [p.windSpeed, p.windDirection].filter(Boolean).join(" "), shortForecast: p.shortForecast,
      }));
      return { location: { city: loc.city || null, state: loc.state || null }, lat, lon, periods };
    },
  },
  {
    route: "GET /api/public-holidays", name: "Public holidays", slug: "public-holidays", category: "time", price: "$0.002",
    description:
      "Public holidays for a country and year via Nager.Date (keyless, 100+ countries): date, local name, English name, nationwide flag, and holiday types. Pairs with /api/business-days and /api/country-info. ?country=US&year=2026",
    tags: ["holidays", "public-holidays", "calendar", "country", "time", "nager"],
    discovery: {
      input: { country: "US", year: 2026 },
      inputSchema: {
        properties: {
          country: { type: "string", description: "ISO 3166-1 alpha-2 country code, e.g. US, DE, JP" },
          year: { type: "integer", description: "calendar year (1975-2099)" },
        },
        required: ["country", "year"],
      },
      output: {
        example: {
          country: "US", year: 2026, count: 17,
          holidays: [{ date: "2026-01-01", localName: "New Year's Day", name: "New Year's Day", global: true, counties: null, types: ["Public", "Bank"] }],
        },
      },
    },
    handler: async (i) => {
      const country = String(i.country ?? "").trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(country)) throw bad("country must be a 2-letter ISO 3166-1 code (e.g. US, DE, JP)");
      const year = Number(i.year);
      if (!Number.isInteger(year) || year < 1975 || year > 2099) throw bad("year must be an integer between 1975 and 2099");
      let j;
      try {
        // Nager returns 204 (empty body) for a known country with no data for
        // that year, and 404 for an unknown country code.
        j = await getJson(`https://date.nager.at/api/v3/PublicHolidays/${year}/${country}`, { allowEmpty: true });
      } catch (e) {
        if (e.statusCode === 422) throw bad(`no holiday data for country "${country}" — Nager.Date covers ~110 countries by ISO alpha-2 code`);
        throw e;
      }
      if (j === null) return { country, year, count: 0, holidays: [] };
      if (!Array.isArray(j)) throw bad("Upstream returned an unexpected shape", 502);
      const holidays = j.slice(0, 100).map((h) => ({
        date: h.date, localName: h.localName ?? null, name: h.name ?? null,
        global: h.global === true, counties: h.counties ?? null, types: h.types ?? [],
      }));
      return { country, year, count: holidays.length, holidays };
    },
  },
  {
    route: "GET /api/country-info", name: "Country info", slug: "country-info", category: "data", price: "$0.002",
    description:
      "Country facts by name or ISO code: official name, capital, region, currencies, languages, timezones, dialing code, TLD, and more. Open data (the world-countries dataset behind the retired restcountries API, plus the IANA timezone country map), version-pinned and cached. ?name=Japan or ?code=JP",
    tags: ["country", "geography", "currency", "language", "timezone", "dialing-code", "iso-3166"],
    discovery: {
      input: { name: "Japan" },
      inputSchema: {
        properties: {
          name: { type: "string", description: "country name (common or official), e.g. Japan" },
          code: { type: "string", description: "alternative: ISO 3166-1 alpha-2 or alpha-3 code, e.g. JP or JPN" },
        },
      },
      output: {
        example: {
          query: "Japan", found: true, matches: 1,
          country: {
            name: "Japan", officialName: "Japan", code2: "JP", code3: "JPN", capital: "Tokyo",
            region: "Asia", subregion: "Eastern Asia",
            currencies: [{ code: "JPY", name: "Japanese yen", symbol: "¥" }],
            languages: ["Japanese"], timezones: ["Asia/Tokyo"], callingCode: "+81",
            tld: ".jp", demonym: "Japanese", flag: "🇯🇵", latlng: [36, 138], area: 377930,
            landlocked: false, borders: [], unMember: true,
          },
        },
      },
    },
    handler: async (i) => {
      const code = i.code === undefined || i.code === null ? "" : String(i.code).trim().toUpperCase();
      const name = i.name === undefined || i.name === null ? "" : String(i.name).trim();
      if (!code && !name) throw bad('provide "name" (e.g. Japan) or "code" (ISO 3166-1 alpha-2/3, e.g. JP)');
      if (code && !/^[A-Z]{2,3}$/.test(code)) throw bad("code must be a 2- or 3-letter ISO 3166-1 code (e.g. JP or JPN)");
      if (!code && (name.length < 2 || name.length > 80)) throw bad("name must be 2-80 characters");
      const countries = await loadCountriesDataset();
      let matches;
      if (code) {
        matches = countries.filter((c) => c.cca2 === code || c.cca3 === code);
      } else {
        const q = name.toLowerCase();
        const exact = countries.filter((c) => c.name?.common?.toLowerCase() === q || c.name?.official?.toLowerCase() === q);
        matches = exact.length ? exact : countries.filter(
          (c) => c.name?.common?.toLowerCase().includes(q) || c.name?.official?.toLowerCase().includes(q)
        );
      }
      const query = code || name;
      if (!matches.length) return { query, found: false, matches: 0, country: null };
      const c = matches[0];
      let timezones = null;
      try {
        const tz = await loadTimezoneMap();
        timezones = tz?.countries?.[c.cca2]?.zones ?? null;
      } catch { /* tz map unavailable — return the rest of the facts */ }
      const idd = c.idd || {};
      const callingCode = idd.root ? idd.root + ((idd.suffixes || []).length === 1 ? idd.suffixes[0] : "") : null;
      return {
        query, found: true, matches: matches.length,
        country: {
          name: c.name?.common ?? null, officialName: c.name?.official ?? null,
          code2: c.cca2 ?? null, code3: c.cca3 ?? null,
          capital: Array.isArray(c.capital) ? c.capital[0] ?? null : c.capital ?? null,
          region: c.region ?? null, subregion: c.subregion ?? null,
          currencies: Object.entries(c.currencies || {}).map(([cc, v]) => ({ code: cc, name: v?.name ?? null, symbol: v?.symbol ?? null })),
          languages: Object.values(c.languages || {}),
          timezones, callingCode,
          tld: Array.isArray(c.tld) ? c.tld[0] ?? null : c.tld ?? null,
          demonym: c.demonyms?.eng?.m ?? null, flag: c.flag ?? null,
          latlng: c.latlng ?? null, area: c.area ?? null,
          landlocked: c.landlocked === true, borders: c.borders ?? [], unMember: c.unMember === true,
        },
      };
    },
  },
];

// --- country-info dataset loaders -------------------------------------------
// Version-pinned jsDelivr URLs are immutable, so a successful fetch is cached
// for the process lifetime (~1.4MB once, then pure lookups). A failed fetch
// clears the slot so the next call retries. Promise-cached to keep concurrent
// first calls from double-fetching.
const COUNTRIES_DATASET_URL = "https://cdn.jsdelivr.net/npm/world-countries@5.1.0/countries.json";
const TZ_COUNTRY_MAP_URL = "https://cdn.jsdelivr.net/npm/moment-timezone@0.6.2/data/meta/latest.json";
let countriesPromise = null;
let tzPromise = null;

function loadCountriesDataset() {
  if (!countriesPromise) {
    countriesPromise = getJson(COUNTRIES_DATASET_URL).then((j) => {
      if (!Array.isArray(j) || j.length < 100) throw bad("country dataset unavailable (unexpected shape)", 502);
      return j;
    }).catch((e) => { countriesPromise = null; throw e; });
  }
  return countriesPromise;
}

function loadTimezoneMap() {
  if (!tzPromise) {
    tzPromise = getJson(TZ_COUNTRY_MAP_URL).catch((e) => { tzPromise = null; throw e; });
  }
  return tzPromise;
}
