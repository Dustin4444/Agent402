// scripts/test-prediction-market-kit.js
// Offline tests for src/tools/prediction-market-kit.js. No keys, no network
// by default. Live calls are opt-in via PREDICTION_LIVE_TEST=1.
//
// Pattern matches scripts/test-dex-kit.js:
//   • Catalog envelope + input validation always runs (no key, no network).
//   • Pure-CPU helpers (asNumber, parseJsonArray, shape*) covered with vectors.
//   • Live calls are opt-in (Polymarket Gamma + CLOB + Kalshi all keyless,
//     but live tests share the rate-limit pool so CI doesn't burn them).

import { PREDICTION_MARKET_TOOLS, __test } from "../src/tools/prediction-market-kit.js";

import { readFileSync } from "node:fs";
const { asNumber, parseJsonArray, shapeMarket, shapeKalshiMarket, shapeKalshiLiveData, shapeWeatherPoint, shapeWeatherCalibration, WEATHER_CITIES, polyList } = __test;

const h = (slug) => PREDICTION_MARKET_TOOLS.find((t) => t.slug === slug).handler;
let fail = 0, pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`ASSERT FAIL - ${m}`); } };

// ----------------------------------------------------------------------------
// Catalog envelope
// ----------------------------------------------------------------------------
ok(PREDICTION_MARKET_TOOLS.length === 8, `8 tools exported (got ${PREDICTION_MARKET_TOOLS.length})`);

const expectedSlugs = ["polymarket-search", "polymarket-market", "polymarket-orderbook", "polymarket-price-history", "kalshi-markets", "kalshi-event", "kalshi-live-data", "kalshi-weather-index"];
for (const slug of expectedSlugs) {
  ok(!!PREDICTION_MARKET_TOOLS.find((t) => t.slug === slug), `slug present: ${slug}`);
}

for (const t of PREDICTION_MARKET_TOOLS) {
  ok(typeof t.slug === "string" && t.slug.length > 0, `${t.slug}: has slug`);
  ok(t.route?.startsWith("POST /api/"), `${t.slug}: POST /api/ route`);
  ok(t.category === "crypto", `${t.slug}: category=crypto`);
  ok(typeof t.price === "string" && /^\$\d/.test(t.price), `${t.slug}: priced (${t.price})`);
  ok(typeof t.handler === "function", `${t.slug}: has handler`);
  const d = t.discovery;
  ok(d && d.input && d.inputSchema && d.output?.example, `${t.slug}: full discovery envelope`);
  ok(d.bodyType === "json", `${t.slug}: bodyType=json`);
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
ok(asNumber("0.45") === 0.45, "asNumber: '0.45' → 0.45");
ok(asNumber(0.6) === 0.6, "asNumber: 0.6 → 0.6");
ok(asNumber(null) === null, "asNumber: null → null");
ok(asNumber("not-a-number") === null, "asNumber: bad string → null");
ok(asNumber(undefined, 42) === 42, "asNumber: fallback honored");

ok(JSON.stringify(parseJsonArray('["a","b"]')) === '["a","b"]', "parseJsonArray: JSON string → array");
ok(JSON.stringify(parseJsonArray(["a", "b"])) === '["a","b"]', "parseJsonArray: already-array → passthrough");
ok(JSON.stringify(parseJsonArray("not json")) === "[]", "parseJsonArray: bad string → []");
ok(JSON.stringify(parseJsonArray(null)) === "[]", "parseJsonArray: null → []");

// Polymarket shape — the Gamma API quirk is that outcomes/prices/tokenIds
// arrive as JSON-encoded strings inside the payload. shapeMarket parses them.
const raw = {
  id: "12345",
  slug: "test-market",
  question: "Will X happen?",
  description: "Resolves YES if X.",
  endDate: "2026-12-31T23:59:00Z",
  active: true,
  closed: false,
  archived: false,
  volume: "98765.43",
  liquidity: "12345.67",
  outcomes: '["Yes","No"]',
  outcomePrices: '["0.62","0.38"]',
  clobTokenIds: '["7290","8390"]',
  events: [{ slug: "test-event" }],
};
const shaped = shapeMarket(raw);
ok(shaped.id === "12345", "shapeMarket: id passthrough");
ok(shaped.volume === 98765.43, "shapeMarket: volume parsed to number");
ok(shaped.liquidity === 12345.67, "shapeMarket: liquidity parsed to number");
ok(JSON.stringify(shaped.outcomes) === '["Yes","No"]', "shapeMarket: outcomes JSON-string → array");
ok(JSON.stringify(shaped.prices) === "[0.62,0.38]", "shapeMarket: prices JSON-string → number array");
ok(JSON.stringify(shaped.clobTokenIds) === '["7290","8390"]', "shapeMarket: clobTokenIds parsed");
ok(shaped.eventSlug === "test-event", "shapeMarket: eventSlug from events[0]");
ok(shaped.venue === "polymarket", "shapeMarket: venue tag");
ok(shaped.venueUrl === "https://polymarket.com/market/test-market", "shapeMarket: venueUrl built from slug");

// Kalshi shape
const kraw = {
  ticker: "TEST-25",
  event_ticker: "TEST",
  title: "Test market",
  subtitle: "Subtitle",
  status: "open",
  open_time: "2026-01-01T00:00:00Z",
  close_time: "2026-12-31T23:59:00Z",
  expiration_time: "2027-01-01T00:00:00Z",
  yes_bid: 45,
  yes_ask: 47,
  no_bid: 53,
  no_ask: 55,
  last_price: 46,
  volume: 12345,
  open_interest: 5678,
};
const kshaped = shapeKalshiMarket(kraw);
ok(kshaped.ticker === "TEST-25", "shapeKalshiMarket: ticker passthrough");
ok(kshaped.eventTicker === "TEST", "shapeKalshiMarket: event_ticker → eventTicker camelCase");
ok(kshaped.yesBid === 45, "shapeKalshiMarket: yes_bid → yesBid");
ok(kshaped.venue === "kalshi", "shapeKalshiMarket: venue tag");
ok(kshaped.venueUrl === "https://kalshi.com/markets/test-25", "shapeKalshiMarket: venueUrl lowercased");

// Kalshi removed the integer-cents fields (verified live 2026-08-28): the
// current API sends STRING DOLLARS and fixed-point volume. Both paid Kalshi
// tools were returning 200 with every one of these null. The shaper reads the
// new names, keeps the buyer-facing values in CENTS, and publishes the dollar
// figures alongside; the legacy fallback above must keep working so a rollback
// on their side cannot break us a second time.
const knew = {
  ticker: "NEW-26", event_ticker: "NEW", title: "t", status: "active",
  yes_bid_dollars: "0.4700", yes_ask_dollars: "0.4900",
  no_bid_dollars: "0.5100", no_ask_dollars: "0.5300",
  last_price_dollars: "0.4800", volume_fp: "12345.00",
  open_interest_fp: "5678.00", liquidity_dollars: "910.5000",
};
const kn = shapeKalshiMarket(knew);
ok(kn.yesBid === 47 && kn.yesAsk === 49 && kn.noBid === 51 && kn.noAsk === 53 && kn.lastPrice === 48,
  `dollar strings become cents (yesBid ${kn.yesBid}, lastPrice ${kn.lastPrice})`);
ok(kn.yesBidUsd === 0.47 && kn.lastPriceUsd === 0.48, "the dollar values ride alongside under their own names");
ok(kn.volume === 12345 && kn.openInterest === 5678 && kn.liquidityUsd === 910.5, "volume, open interest and liquidity come from the fixed-point fields");
ok(![kn.yesBid, kn.yesAsk, kn.noBid, kn.noAsk, kn.lastPrice, kn.volume, kn.openInterest].includes(null),
  "no field is null on a market the API describes fully (the failure this fixes was 200 with every value null)");
const kzero = shapeKalshiMarket({ ticker: "Z-26", yes_bid_dollars: "0.0000", volume_fp: "0.00" });
ok(kzero.yesBid === 0 && kzero.volume === 0, "a genuinely untraded market reads 0, never null");
const kmissing = shapeKalshiMarket({ ticker: "M-26" });
ok(kmissing.yesBid === null && kmissing.volume === null, "an absent field is still null, never a fabricated 0");

// Kalshi retires liquidity_dollars on 2026-10-01, and it already reads 0 on
// markets with a live book. liquidityUsd is Kalshi's own figure only when it
// carries one; otherwise null with a reason. Depth is the top-of-book size, in
// contracts, under its own names, never relabelled as "liquidity".
const kbook = shapeKalshiMarket({ ticker: "B-26", liquidity_dollars: "0.0000", yes_bid_size_fp: "471.53", yes_ask_size_fp: "323.10" });
ok(kbook.yesBidSize === 471.53 && kbook.yesAskSize === 323.1, "top-of-book sizes come from the *_size_fp fields");
ok(kbook.liquidityUsd === null && /yesBidSize/.test(kbook.liquidityUsdNote || ""),
  "a zero liquidity_dollars beside a live book is null with a note, not a false 0");
const kgone = shapeKalshiMarket({ ticker: "G-26", yes_bid_size_fp: "10.00" });
ok(kgone.liquidityUsd === null && typeof kgone.liquidityUsdNote === "string", "after removal the field reads null and says why");
const kempty = shapeKalshiMarket({ ticker: "E-26", liquidity_dollars: "0.0000", yes_bid_size_fp: "0.00", yes_ask_size_fp: "0.00" });
ok(kempty.liquidityUsd === 0 && kempty.yesBidSize === 0 && !("liquidityUsdNote" in kempty), "an empty book with a zero figure still reads 0");
ok(kn.liquidityUsdNote === undefined, "a nonzero legacy figure is kept with no note");
ok(kmissing.yesBidSize === null, "an absent size field is null");

// Polymarket's gamma list endpoints are past their own sunset (deprecation and
// sunset: Fri, 01 May 2026 in HTTP HEADERS ONLY, nothing in their docs). We
// call `/markets/keyset`, which returns an OBJECT with a markets array, and we
// still accept the legacy bare array so a rollback cannot empty these tools.
ok(polyList({ markets: [{ id: "1" }], next_cursor: "x" }).length === 1, "polyList reads the keyset object shape");
ok(polyList([{ id: "1" }, { id: "2" }]).length === 2, "polyList still reads the legacy bare array");
ok(polyList(null).length === 0 && polyList({}).length === 0 && polyList("nope").length === 0, "polyList never throws on an unexpected payload");
{
  const src = readFileSync(new URL("../src/tools/prediction-market-kit.js", import.meta.url), "utf8");
  ok(!/POLY_GAMMA\}\/markets\?/.test(src), "no list call still points at the deprecated /markets endpoint");
  ok((src.match(/markets\/keyset/g) || []).length >= 3, "every list call site uses /markets/keyset");
}

// polymarket-search reads TWO sources and keeps ONE predicate (2026-09-12).
// The volume-ordered scan alone could not find "bitcoin" in the first 3,000
// active markets (Fed and football own that list), so Gamma's own keyword index
// is consulted first - but it is FUZZY (a gibberish query comes back with a
// Copa America event), so our exact substring match still decides. These four
// properties are what keep that combination honest.
{
  const realFetch = globalThis.fetch;
  const json = (body) => ({ ok: true, status: 200, headers: { get: (k) => (k.toLowerCase() === "content-type" ? "application/json" : null) }, json: async () => body, text: async () => JSON.stringify(body) });
  const market = (id, question, extra = {}) => ({ id, question, slug: `m-${id}`, description: "", active: true, closed: false, outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]', clobTokenIds: "[]", ...extra });

  // 1. an index result our predicate does not match is DROPPED, and one it
  //    matches is served - their fuzziness must never become our wrong answer.
  let keysetCalls = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/public-search")) {
      return json({ events: [{ slug: "ev", markets: [market("1", "Will Bitcoin close above $90k?"), market("2", "Copa America winner?")] }] });
    }
    keysetCalls++;
    return json({ markets: [], next_cursor: null });
  };
  let r = await h("polymarket-search")({ query: "bitcoin", limit: 3 });
  ok(r.count === 1 && r.markets[0].id === "1", "a keyword-index row that matches our own predicate is served");
  ok(!JSON.stringify(r).includes("Copa America"), "a fuzzy index row that does NOT match the query is dropped, not returned as a result");
  ok(r.searchedKeywordIndex === true, "the answer says the keyword index was consulted");
  ok(r.markets[0].eventSlug === "ev", "a market nested in a search event still reports its event slug");

  // 2. enough matches from the index means the scan never runs - and an
  //    unrun scan may NOT claim it exhausted the active list.
  keysetCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/public-search")) {
      return json({ events: [{ slug: "ev", markets: [market("1", "Bitcoin A"), market("2", "Bitcoin B")] }] });
    }
    keysetCalls++;
    return json({ markets: [], next_cursor: null });
  };
  r = await h("polymarket-search")({ query: "bitcoin", limit: 2 });
  ok(r.count === 2 && keysetCalls === 0, "a common term costs one request: the index filled the page and the volume scan never ran");
  ok(r.searchExhausted === false, "a scan that never ran does NOT claim it read the whole active list");

  // 3. the index is a bonus, never a dependency: if it fails the tool degrades
  //    to yesterday's volume scan instead of emptying. A DIFFERENT query than
  //    the cases above on purpose: fetchJson serves a stale cached body when a
  //    call fails, so reusing a URL an earlier case primed would test the cache
  //    rather than the fallback.
  globalThis.fetch = async (url) => {
    if (String(url).includes("/public-search")) throw new Error("index down");
    return json({ markets: [market("9", "Dogecoin on the volume list")], next_cursor: null });
  };
  r = await h("polymarket-search")({ query: "dogecoin", limit: 3 });
  ok(r.count === 1 && r.markets[0].id === "9", "a failed keyword index falls through to the volume scan");
  ok(r.searchedKeywordIndex === false, "...and the answer says the index was not read");
  ok(r.searchExhausted === true, "a scan that reached the end of the list may say so");

  // 4. the same market from both sources is one result.
  globalThis.fetch = async (url) => {
    if (String(url).includes("/public-search")) return json({ events: [{ slug: "ev", markets: [market("7", "Bitcoin dupe")] }] });
    return json({ markets: [market("7", "Bitcoin dupe"), market("8", "Bitcoin other")], next_cursor: null });
  };
  r = await h("polymarket-search")({ query: "bitcoin", limit: 5 });
  ok(r.count === 2 && new Set(r.markets.map((m) => m.id)).size === 2, "a market returned by both sources is counted once");

  // 5. a closed market is never served under the default activeOnly.
  globalThis.fetch = async (url) => {
    if (String(url).includes("/public-search")) return json({ events: [{ slug: "ev", markets: [market("3", "Bitcoin settled", { active: false, closed: true })] }] });
    return json({ markets: [], next_cursor: null });
  };
  r = await h("polymarket-search")({ query: "bitcoin", limit: 3 });
  ok(r.count === 0 && /No active Polymarket market matched/.test(r.note), "a closed market from the index is filtered out, and the zero stays honest");

  globalThis.fetch = realFetch;
}

// ----------------------------------------------------------------------------
// Input validation — all 6 tools
// ----------------------------------------------------------------------------
async function throws(promise, status, label) {
  try { await promise; fail++; console.error(`ASSERT FAIL - ${label} (did not throw)`); }
  catch (e) {
    if (e.statusCode === status) { pass++; console.log(`ok - ${label} → ${status}`); }
    else { fail++; console.error(`ASSERT FAIL - ${label}: expected ${status}, got ${e.statusCode} (${e.message})`); }
  }
}

// polymarket-search
await throws(h("polymarket-search")({}), 400, "polymarket-search: missing query");
await throws(h("polymarket-search")({ query: "" }), 400, "polymarket-search: empty query");
await throws(h("polymarket-search")({ query: "   " }), 400, "polymarket-search: whitespace query");
await throws(h("polymarket-search")({ query: 123 }), 400, "polymarket-search: non-string query");

// polymarket-market
await throws(h("polymarket-market")({}), 400, "polymarket-market: missing both slug+id");
await throws(h("polymarket-market")({ slug: "", id: "" }), 400, "polymarket-market: empty slug+id");

// polymarket-orderbook
await throws(h("polymarket-orderbook")({}), 400, "polymarket-orderbook: missing tokenId");
await throws(h("polymarket-orderbook")({ tokenId: "" }), 400, "polymarket-orderbook: empty tokenId");
await throws(h("polymarket-orderbook")({ tokenId: "0xabc" }), 400, "polymarket-orderbook: non-decimal tokenId");
await throws(h("polymarket-orderbook")({ tokenId: "not-a-number" }), 400, "polymarket-orderbook: word tokenId");

// polymarket-price-history
await throws(h("polymarket-price-history")({}), 400, "polymarket-price-history: missing tokenId");
await throws(h("polymarket-price-history")({ tokenId: "abc" }), 400, "polymarket-price-history: bad tokenId");

// kalshi-markets
await throws(h("kalshi-markets")({ status: "invalid-status" }), 400, "kalshi-markets: bad status");

// kalshi-event
await throws(h("kalshi-event")({}), 400, "kalshi-event: missing eventTicker");
await throws(h("kalshi-event")({ eventTicker: "" }), 400, "kalshi-event: empty eventTicker");
await throws(h("kalshi-event")({ eventTicker: "   " }), 400, "kalshi-event: whitespace eventTicker");

// ----------------------------------------------------------------------------
// Live tests (opt-in)
// ----------------------------------------------------------------------------
if (process.env.PREDICTION_LIVE_TEST === "1") {
  console.log("\n--- live tests ---");
  try {
    const search = await h("polymarket-search")({ query: "election", limit: 3 });
    ok(typeof search.count === "number", `live polymarket-search: count returned (${search.count})`);
    ok(Array.isArray(search.markets), `live polymarket-search: markets array (len=${search.markets.length})`);
    if (search.markets.length) {
      const first = search.markets[0];
      ok(typeof first.question === "string", `live polymarket-search: first.question is string`);
      ok(Array.isArray(first.clobTokenIds), `live polymarket-search: clobTokenIds array`);
      // Try orderbook on the first market's first token
      if (first.clobTokenIds[0]) {
        const ob = await h("polymarket-orderbook")({ tokenId: first.clobTokenIds[0], depth: 3 });
        ok(typeof ob.tokenId === "string", `live polymarket-orderbook: tokenId returned`);
        ok(Array.isArray(ob.bids) && Array.isArray(ob.asks), `live polymarket-orderbook: bids+asks arrays`);
      }
    }

    const km = await h("kalshi-markets")({ status: "open", limit: 3 });
    ok(typeof km.count === "number", `live kalshi-markets: count returned (${km.count})`);
    ok(Array.isArray(km.markets), `live kalshi-markets: markets array`);
  } catch (e) {
    console.error(`LIVE ERR: ${e.message}`);
    fail++;
  }
}

// ----------------------------------------------------------------------------
// polymarket-price-history moved to the Data API v2 (2026-09-04 upstream;
// 2026-09-18 here). Probed live: v2 answers `{data:[{timestamp, price,
// resolution_seconds}]}` and REFUSES the legacy `market=` param; the CLOB
// route still answers `{history:[{t, p}]}`. The tool asks v2 with `tokenId`
// + `bucketSeconds`, and falls back to the CLOB when v2 fails or answers a
// shape the reader does not know (the polyList rule). Distinct token ids per
// case: fetchJson serves a stale cached body when a call fails, so reusing a
// URL an earlier case primed would test the cache, not the fallback.
// Mutation check: remove the `data` branch of polyHistoryPoints and case 1
// falls back to the CLOB (source flips) instead of reading v2; remove the
// fallback and cases 2 and 3 throw.
{
  const { polyHistoryPoints } = __test;
  const realFetch = globalThis.fetch;
  const json = (body, status = 200) => ({ ok: status < 400, status, headers: { get: (k) => (k.toLowerCase() === "content-type" ? "application/json" : null) }, json: async () => body, text: async () => JSON.stringify(body) });
  const v2Doc = { data: [{ timestamp: 1789653600, price: 0.745, resolution_seconds: 3600 }, { timestamp: 1789657200, price: 0.755, resolution_seconds: 3600 }], pagination: { limit: 2, offset: 0, has_more: true } };
  const legacyDoc = { history: [{ t: 1789653613, p: 0.745 }, { t: 1789657213, p: 0.765 }] };
  // Pure reader: both shapes, one output.
  ok(JSON.stringify(polyHistoryPoints(v2Doc)) === JSON.stringify([{ timestamp: 1789653600, price: 0.745 }, { timestamp: 1789657200, price: 0.755 }]), "polyHistoryPoints reads the v2 {data:[{timestamp, price}]} shape");
  ok(JSON.stringify(polyHistoryPoints(legacyDoc)) === JSON.stringify([{ timestamp: 1789653613, price: 0.745 }, { timestamp: 1789657213, price: 0.765 }]), "polyHistoryPoints reads the legacy {history:[{t, p}]} shape");
  ok(polyHistoryPoints({ result: [] }) === null && polyHistoryPoints(null) === null, "an unrecognised document reads as null, never as an empty series");

  // 1. v2 answers: served from v2, the wire carries tokenId + bucketSeconds and never `market=`.
  let urls = [];
  globalThis.fetch = async (url) => { urls.push(String(url)); return json(v2Doc); };
  let r = await h("polymarket-price-history")({ tokenId: "1000000000000000000001", interval: "1d", fidelity: 60 });
  ok(urls.length === 1 && urls[0].startsWith("https://data-api.polymarket.com/v2/prices-history?") && urls[0].includes("tokenId=1000000000000000000001") && urls[0].includes("bucketSeconds=3600") && !urls[0].includes("market="), `v2 is asked first with tokenId + bucketSeconds (${urls[0]})`);
  ok(r.source === "polymarket-data-api" && r.count === 2 && r.first === 0.745 && r.last === 0.755 && r.max === 0.755, "the v2 document is shaped into the same points/min/max/first/last contract");
  ok(r.truncated === true, "a v2 page with has_more says truncated");

  // 2. v2 down (5xx twice - fetchJson retries once) -> the CLOB route serves.
  urls = [];
  globalThis.fetch = async (url) => { urls.push(String(url)); return new URL(String(url)).hostname === "data-api.polymarket.com" ? json({ error: "down" }, 500) : json(legacyDoc); };
  r = await h("polymarket-price-history")({ tokenId: "1000000000000000000002", interval: "1d" });
  ok(r.source === "polymarket-clob" && r.count === 2 && r.last === 0.765, "a failing v2 falls back to the legacy CLOB route (source says so)");
  ok(urls.some((u) => u.startsWith("https://clob.polymarket.com/prices-history?market=1000000000000000000002")), "the legacy route is asked in its own dialect (market=)");
  ok(r.truncated === false, "the legacy document never claims a next page");

  // 3. v2 answers 200 with a shape the reader does not know -> fallback, not an empty answer.
  globalThis.fetch = async (url) => (new URL(String(url)).hostname === "data-api.polymarket.com" ? json({ prices: [[1, 0.5]] }) : json(legacyDoc));
  r = await h("polymarket-price-history")({ tokenId: "1000000000000000000003", interval: "1h" });
  ok(r.source === "polymarket-clob" && r.count === 2, "a v2 document of an unknown shape degrades to the CLOB route instead of emptying the tool");

  // 4. both empty: the honest note, no throw.
  globalThis.fetch = async () => json({ data: [] });
  r = await h("polymarket-price-history")({ tokenId: "1000000000000000000004" });
  ok(r.count === 0 && typeof r.note === "string" && r.source === "polymarket-data-api", "an empty v2 series is an answer with the no-history note");
  globalThis.fetch = realFetch;
}

// ----------------------------------------------------------------------------
// Kalshi live_data (2026-09-18): the feed BEHIND an event and the city
// temperature index. Fixtures are trimmed copies of the live responses read
// that day (docs.kalshi.com/api-reference/live-data). The shaper rule under
// test is the shapeKalshiMarket rule: an absent field reads null, never 0,
// and the two array shapes Kalshi actually serves are normalised while
// whatever else the type carries rides through under `details`.
// ----------------------------------------------------------------------------
{
  // GET /live_data/events/KXBTC-26SEP1813?range=15min (crypto type)
  const btcLive = { live_data: { default_range: "1h", details: {
    candlesticks: {
      "15M": [{ open_ts_ms: 1789747466000, open: 80695.74, high: 81009.59, low: 80695.74, close: 81009.59 }, { open_ts_ms: 1789748366000, open: 81009.82, high: 81210.11, low: 80877.87, close: 81210.11 }],
      "1M": [{ open_ts_ms: 1789749180000, open: 81108.81, high: 81198.23, low: 81108.81, close: 81198.23 }],
    },
    coin: "BTC", event_ticker: "KXBTC-26SEP1813", maturity_ts_ms: 1789750800000,
    timeseries: [{ t: 1789749264000, v: 81209.399 }, { t: 1789749265000, v: 81210.119 }, { t: 1789749266000, v: 81210.682 }],
  }, is_historical: false, range_options: ["15min", "1h", "3h"], type: "crypto" } };
  const s = shapeKalshiLiveData(btcLive, { eventTicker: "KXBTC-26SEP1813", limit: 200 });
  ok(s.type === "crypto" && s.coin === "BTC" && s.isHistorical === false && s.defaultRange === "1h", "live-data crypto: type, coin, is_historical and default_range ride through");
  ok(s.maturityTime === "2026-09-18T17:00:00.000Z", "live-data crypto: maturity_ts_ms becomes an ISO time");
  ok(s.seriesCount === 3 && s.series[2].value === 81210.682 && s.series[0].time === "2026-09-18T16:34:24.000Z", "live-data crypto: the {t, v} series is normalised to {time, value}");
  ok(s.latest && s.latest.value === 81210.682, "live-data crypto: latest is the newest series point");
  ok(s.candlesticks.length === 2 && s.candlesticks[0].interval === "15M" && s.candlesticks[0].count === 2 && s.candlesticks[0].candles[1].close === 81210.11 && s.candlesticks[0].candles[0].time === "2026-09-18T16:04:26.000Z", "live-data crypto: candlesticks become [{interval, count, candles:[{time, open, high, low, close}]}]");
  ok(!("timeseries" in s.details) && !("candlesticks" in s.details) && s.details.coin === "BTC" && s.details.maturity_ts_ms === 1789750800000, "live-data crypto: details carries the rest of the type's fields and not the two shaped arrays");
  const s2 = shapeKalshiLiveData(btcLive, { eventTicker: "KXBTC-26SEP1813", limit: 1 });
  ok(s2.seriesCount === 1 && s2.series[0].value === 81210.682 && s2.candlesticks[0].count === 1 && s2.candlesticks[0].candles[0].close === 81210.11, "live-data: limit keeps the NEWEST points per series and per interval");

  // GET /live_data/events/KXCPI-26SEP (timeseries type: BLS CPI, monthly, labelled points, no range fields)
  const cpiLive = { live_data: { details: {
    default_period: "1y", event_ticker: "KXCPI-26SEP", frequency: "monthly", graph_type: "bar", is_historical: false,
    last_refreshed: "2026-09-18T16:33:45Z", latest_period: "2026-08-01", latest_value: 0.4, measure: "pct_change_1",
    period_end: "2026-09-30", period_pending: true, provider: "bls", selectable_periods: ["1y", "5y", "all"],
    series_id: "CUSR0000SA0", target_label: "September 2026", target_period: "2026-09-01",
    timeseries: [{ label: "June 2026", t: "2026-06-01", v: -0.4 }, { label: "July 2026", t: "2026-07-01", v: 0.1 }, { label: "August 2026", t: "2026-08-01", v: 0.4 }],
    unit: "%", y_axis_max: 1.03, y_axis_min: -0.53,
  }, type: "timeseries" } };
  const c = shapeKalshiLiveData(cpiLive, { eventTicker: "KXCPI-26SEP", limit: 200 });
  ok(c.type === "timeseries" && c.coin === null && c.maturityTime === null && c.defaultRange === null && c.rangeOptions.length === 0, "live-data timeseries: fields the type does not carry read null (or an empty list), never a fabricated value");
  ok(c.isHistorical === false, "live-data timeseries: is_historical is read from details when the top level lacks it");
  ok(c.seriesCount === 3 && c.series[0].time === "2026-06-01" && c.series[0].label === "June 2026" && c.series[2].value === 0.4, "live-data timeseries: string dates and labels ride through the series unchanged");
  ok(c.candlesticks.length === 0 && c.details.provider === "bls" && c.details.series_id === "CUSR0000SA0" && c.details.target_period === "2026-09-01", "live-data timeseries: no candlesticks, and the provider/series/target fields stay in details");
  const empty = shapeKalshiLiveData({ live_data: { type: "weather", details: {} } }, { eventTicker: "X", limit: 10 });
  ok(empty.seriesCount === 0 && empty.latest === null && empty.series.length === 0 && empty.candlesticks.length === 0 && empty.isHistorical === null, "live-data: a type with no arrays is an empty series with a null latest and a null is_historical");

  // GET /live_data/weather/miami?last_sec=...&detailed=true (one point) + /calibrations (one record)
  const wp = shapeWeatherPoint({ contributors: 5, status: "normal", t: 1789742040000, v: 86.36, stations: [{ code: "ok", received_at_ms: 1789742183062, source: "hf_asos", station_id: "KFLL1M", temp_f: 86 }] }, true);
  ok(wp.time === "2026-09-18T14:34:00.000Z" && wp.valueF === 86.36 && wp.contributors === 5 && wp.status === "normal", "weather point: t/v/contributors/status are shaped");
  ok(wp.stations.length === 1 && wp.stations[0].stationId === "KFLL1M" && wp.stations[0].tempF === 86 && wp.stations[0].code === "ok" && wp.stations[0].receivedAt === "2026-09-18T14:36:23.062Z", "weather point: detailed station rows carry station id, reading, QC code and receipt time");
  ok(!("stations" in shapeWeatherPoint({ t: 1, v: 2, stations: [{ station_id: "X" }] }, false)), "weather point: stations are dropped unless detailed was asked for");
  ok(shapeWeatherPoint({ t: 1789742040000 }, false).valueF === null && shapeWeatherPoint({ t: 1789742040000 }, false).contributors === null, "weather point: an absent value reads null, never 0");
  const cal = shapeWeatherCalibration({ calibration_window_end_ms: 1786924800000, calibration_window_start_ms: 1786320000000, change_reason: "weekly offset calibration", city_reference_c: -0.1, config_version: "miami-temperature-v1.0-cal-20260817", effective_at_ms: 1786925160000, published_at_ms: 1786925119661, stations: [{ offset_c: -0.5, station_id: "KOPF1M", update_note: "insufficient residuals", weight: 0.2 }] });
  ok(cal.configVersion === "miami-temperature-v1.0-cal-20260817" && cal.cityReferenceC === -0.1 && cal.effectiveAt === "2026-08-17T00:06:00.000Z" && cal.calibrationWindow.start === "2026-08-10T00:00:00.000Z", "weather calibration: version, reference, effective time and window are shaped");
  ok(cal.stations[0].stationId === "KOPF1M" && cal.stations[0].offsetC === -0.5 && cal.stations[0].weight === 0.2 && cal.stations[0].updateNote === "insufficient residuals", "weather calibration: station weights and offsets ride through");
  ok(Array.isArray(WEATHER_CITIES) && WEATHER_CITIES.includes("miami") && WEATHER_CITIES.includes("nyc") && WEATHER_CITIES.length === 13, "the supported-cities hint matches the 13 cities Kalshi named on 2026-09-18");

  // Validation: every refusal happens before any egress.
  const realFetch = globalThis.fetch;
  let egress = 0;
  globalThis.fetch = async () => { egress++; throw new Error("no egress expected"); };
  await throws(h("kalshi-live-data")({}), 400, "kalshi-live-data: neither eventTicker nor seriesTicker");
  await throws(h("kalshi-live-data")({ eventTicker: "bad ticker!" }), 400, "kalshi-live-data: malformed eventTicker");
  await throws(h("kalshi-live-data")({ seriesTicker: "KXBTC", range: "2h" }), 400, "kalshi-live-data: unknown range");
  await throws(h("kalshi-weather-index")({}), 400, "kalshi-weather-index: missing city");
  await throws(h("kalshi-weather-index")({ city: "Mia mi" }), 400, "kalshi-weather-index: malformed city");
  await throws(h("kalshi-weather-index")({ city: "miami", from: 1 }), 400, "kalshi-weather-index: from without to");
  await throws(h("kalshi-weather-index")({ city: "miami", lastSec: 99999999 }), 400, "kalshi-weather-index: window over 7 days");
  ok(egress === 0, "every live_data refusal above happened before any egress");

  // Handler wiring against a stubbed Kalshi: series resolution, the query
  // string, the unknown-city 422 and the calibrations option.
  const json = (body, status = 200) => ({ ok: status < 400, status, headers: { get: (k) => (k.toLowerCase() === "content-type" ? "application/json" : null) }, json: async () => body, text: async () => JSON.stringify(body) });
  let urls = [];
  globalThis.fetch = async (url) => {
    const u = String(url); urls.push(u);
    if (u.includes("/events?")) return json({ events: [{ event_ticker: "KXBTC-26SEP1817", title: "BTC price range on Sep 18, 2026 at 5pm EDT?", strike_date: "2026-09-18T21:00:00Z" }] });
    if (u.includes("/live_data/events/KXBTC-26SEP1817")) return json(btcLive);
    if (u.includes("/live_data/weather/nowhere")) return json({ error: { code: "invalid_parameter:_unknown_weather_index_city_\"nowhere\"", message: "invalid parameter: unknown weather index city \"nowhere\"; supported cities: [miami]" } }, 400);
    if (u.includes("/live_data/weather/miami/calibrations")) return json({ city: "miami", units: "celsius", calibrations: [{ config_version: "miami-temperature-v1.0", effective_at_ms: 1786665600000, city_reference_c: -0.1, stations: [] }] });
    if (u.includes("/live_data/weather/miami")) return json({ city: "miami", config_version: "miami-temperature-v1.0-cal-20260914", units: "fahrenheit", timeseries: [{ contributors: 5, status: "normal", t: 1789748280000, v: 85.28 }, { contributors: 5, status: "normal", t: 1789748340000, v: 84.92 }] });
    return json({ error: "unexpected" }, 404);
  };
  let r = await h("kalshi-live-data")({ seriesTicker: "kxbtc", range: "15min", limit: 2 });
  ok(urls[0].includes("/events?series_ticker=KXBTC&status=open&limit=1"), "kalshi-live-data: a series ticker resolves the soonest open event with one events call");
  ok(urls[1].endsWith("/live_data/events/KXBTC-26SEP1817?range=15min"), `kalshi-live-data: the live_data call carries the resolved ticker and the range (${urls[1]})`);
  ok(r.eventTicker === "KXBTC-26SEP1813" && r.resolvedFrom.seriesTicker === "KXBTC" && r.resolvedFrom.title.includes("BTC price") && r.range === "15min" && r.source === "kalshi", "kalshi-live-data: the answer names what it resolved from");
  ok(r.seriesCount === 2 && r.candlesticks[0].count === 2, "kalshi-live-data: limit applies through the handler");
  urls = [];
  r = await h("kalshi-weather-index")({ city: "MIAMI", lastSec: 120, includeCalibrations: true });
  ok(urls[0].endsWith("/live_data/weather/miami?last_sec=120") && urls[1].endsWith("/live_data/weather/miami/calibrations"), `kalshi-weather-index: city is lowercased, last_sec is sent, calibrations are a second call only when asked (${urls.join(" ")})`);
  ok(r.city === "miami" && r.units === "fahrenheit" && r.count === 2 && r.totalInWindow === 2 && r.latest.valueF === 84.92 && r.minF === 84.92 && r.maxF === 85.28 && r.configVersion === "miami-temperature-v1.0-cal-20260914", "kalshi-weather-index: count, latest, min and max come from the window");
  ok(r.calibrations.length === 1 && r.calibrations[0].configVersion === "miami-temperature-v1.0" && r.calibrationUnits === "celsius", "kalshi-weather-index: includeCalibrations appends the shaped timeline");
  urls = [];
  r = await h("kalshi-weather-index")({ city: "miami", from: 1789748280000, to: 1789748340000, detailed: true });
  ok(urls[0].includes("from=1789748280000&to=1789748340000&detailed=true") && urls.length === 1 && !("calibrations" in r), "kalshi-weather-index: from/to/detailed ride the query and no calibrations call is made unless asked");
  try { await h("kalshi-weather-index")({ city: "nowhere" }); ok(false, "kalshi-weather-index: unknown city did not throw"); }
  catch (e) { ok(e.statusCode === 422 && /supported cities: miami/.test(e.message), `kalshi-weather-index: a city Kalshi does not index is a 422 naming the supported cities (${e.statusCode}: ${e.message.slice(0, 60)})`); }
  globalThis.fetch = realFetch;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
