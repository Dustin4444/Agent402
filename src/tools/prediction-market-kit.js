// Prediction-market kit — read-only access to the two largest prediction-market
// venues. Polymarket (Gamma metadata + CLOB orderbook/history) and Kalshi
// (CFTC-regulated US event contracts). Both venues expose public, keyless
// HTTP APIs we can proxy without holding user funds.
//
// Honest scoping: read-only. No order placement, no signed L2 actions.
// Order placement requires user-signed EIP-712 (Polymarket) or Kalshi API
// keys; both lie outside Agent402's deterministic, pay-per-call envelope.
//
// Why this matters for agents: prediction markets are the canonical
// "live probability of a future event" feed (sports, elections, macro,
// crypto, climate). Existing search/news kits report what *happened*;
// this kit reports what the market thinks will happen, with timestamped
// odds movements.
//
// All 8 tools are wallet-only — every handler hits an external API and
// shares a per-IP rate limit with the public endpoint pool.
//
// Covered by scripts/test-prediction-market-kit.js (offline + opt-in live).

const TIMEOUT_MS = 12_000;

// Endpoints. All keyless as of 2026-06; documented at:
// - https://docs.polymarket.com/developers/gamma-markets-api/overview
// - https://docs.polymarket.com/developers/CLOB/overview
// - https://trading-api.readme.io/reference/getmarkets (Kalshi)
const POLY_GAMMA = "https://gamma-api.polymarket.com";
// How far a keyword search looks. Gamma CAPS a keyset page at 100 rows however
// large a `limit` you ask for (measured 2026-08-29: asking 500 returns 100), so
// the real reach is 100 x 6 = 600 of the highest-volume active markets. The loop
// exits as soon as it has enough matches, so a common term still costs one
// request; only a rare or absent term pays the full budget, and the response
// says how deep it went so 0 results are never ambiguous.
const POLY_SEARCH_PAGE = Number(process.env.POLYMARKET_SEARCH_PAGE) || 100;
const POLY_SEARCH_MAX_PAGES = Number(process.env.POLYMARKET_SEARCH_MAX_PAGES) || 6;
// Events asked of Gamma's keyword index per search. Each carries its own
// markets (11 on a measured "bitcoin" query), so this is a market budget of
// roughly ten times its own value for one request.
const POLY_SEARCH_INDEX_EVENTS = Number(process.env.POLYMARKET_SEARCH_INDEX_EVENTS) || 20;
const POLY_CLOB = "https://clob.polymarket.com";
// Price history moved to the Data API on 2026-09-04 (docs.polymarket.com/changelog):
// `GET /v2/prices-history?tokenId=&interval=&bucketSeconds=&limit=&cursor=`
// answering `{data:[{timestamp, price, resolution_seconds}], pagination?}`.
// Probed live 2026-09-18: v2 refuses the legacy `market=` param outright
// ("'market' is not a query param on this API"), the legacy CLOB route still
// answers `{history:[{t, p}]}`. The tool asks v2 first and falls back to the
// CLOB (the polyList rule: a host that changes shape degrades the tool to
// yesterday, never empties it).
const POLY_DATA_API = "https://data-api.polymarket.com";
const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// Serve-stale safety net: neither venue has an alternative provider, so when
// an upstream is down/throttled we can serve the last good copy of the SAME
// request — but only briefly (markets move) and always marked. Handlers spread
// staleFields(meta) into their response so a degraded answer says so.
const STALE_MAX_MS = 10 * 60 * 1000; // never serve a copy older than this
const CACHE_MAX = 500;
const lastGood = new Map(); // url → { json, at } — last successful body per URL

function cachePut(url, json) {
  if (!lastGood.has(url) && lastGood.size >= CACHE_MAX) {
    let oldestKey = null, oldestAt = Infinity;
    for (const [k, v] of lastGood) if (v.at < oldestAt) { oldestKey = k; oldestAt = v.at; }
    lastGood.delete(oldestKey);
  }
  lastGood.set(url, { json, at: Date.now() });
}

// Returns the cached body (marking meta stale) or rethrows the original error.
function serveStale(url, label, meta, err) {
  const hit = lastGood.get(url);
  if (!hit || Date.now() - hit.at > STALE_MAX_MS) throw err;
  const asOf = new Date(hit.at).toISOString();
  console.warn(`[prediction] ${label} down (${String(err.message).slice(0, 120)}) - serving cached copy from ${asOf}`);
  if (meta) { meta.stale = true; meta.asOf = asOf; }
  return hit.json;
}

function staleFields(meta) {
  return meta?.stale ? { stale: true, asOf: meta.asOf } : {};
}

async function fetchJson(url, label, meta = null) {
  async function attempt() {
    try {
      return await fetch(url, {
        headers: { accept: "application/json", "user-agent": "agent402/prediction-market-kit" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      if (e.name === "TimeoutError" || /aborted/i.test(e.message)) {
        throw bad(`${label} upstream timed out after ${TIMEOUT_MS}ms`, 504);
      }
      throw bad(`${label} upstream unreachable: ${e.message}`, 502);
    }
  }
  let res;
  try {
    res = await attempt();
  } catch (err) {
    return serveStale(url, label, meta, err);
  }
  // Retry once on 429/5xx — Kalshi burst-limits per IP (shared egress IPs
  // intermittently 429 a first call) and both venues can 5xx under load.
  // Honor the venue's Retry-After when sent (capped so the route budget
  // survives), and jitter so a shared-egress thundering herd doesn't re-collide.
  if (res.status === 429 || res.status >= 500) {
    const ra = Number(res.headers.get("retry-after"));
    const waitMs = Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2500, 5000) + Math.floor(Math.random() * 500);
    console.warn(`[prediction] ${label} HTTP ${res.status} - retrying once in ${waitMs}ms${Number.isFinite(ra) && ra > 0 ? " (Retry-After honored)" : ""}`);
    await new Promise((r) => setTimeout(r, waitMs));
    try {
      const retryRes = await attempt();
      if (retryRes.ok || retryRes.status !== res.status) res = retryRes;
    } catch { /* fall through with the original response */ }
  }
  const ct = res.headers.get("content-type") || "";
  if (!res.ok) {
    const body = ct.includes("json") ? JSON.stringify(await res.json().catch(() => null)).slice(0, 240) : (await res.text().catch(() => "")).slice(0, 240);
    const err = bad(`${label} upstream returned HTTP ${res.status}${body ? ": " + body : ""}`, res.status >= 500 ? 502 : res.status);
    // Only outage classes may serve stale — a 4xx is a real answer.
    if (res.status === 429 || res.status >= 500) return serveStale(url, label, meta, err);
    throw err;
  }
  if (!ct.includes("json")) {
    return serveStale(url, label, meta, bad(`${label} upstream returned non-JSON content-type: ${ct}`, 502));
  }
  const json = await res.json();
  cachePut(url, json);
  return json;
}

// Polymarket Gamma reports prices as strings ("0.45"); CLOB orderbook reports
// the same way. Normalize to numbers so agents don't have to parseFloat
// everywhere — but keep the raw string in case the agent wants the original.
function asNumber(value, fallback = null) {
  if (value == null) return fallback;
  const n = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

// Polymarket markets include outcomes + prices as JSON-encoded strings inside
// the response (a quirk of the Gamma API). Parse them; on failure return [].
function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const v = JSON.parse(value);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// Compact, agent-friendly Polymarket market envelope. We drop ~40 fields
// from Gamma's raw payload that aren't useful for an agent reading the
// market (graphic URLs, internal flags, denormalized series links).
function shapeMarket(m) {
  const outcomes = parseJsonArray(m.outcomes);
  const prices = parseJsonArray(m.outcomePrices).map((p) => asNumber(p));
  const tokenIds = parseJsonArray(m.clobTokenIds);
  return {
    id: m.id ?? null,
    slug: m.slug ?? null,
    question: m.question ?? null,
    description: m.description ?? null,
    endDate: m.endDate ?? null,
    active: !!m.active,
    closed: !!m.closed,
    archived: !!m.archived,
    volume: asNumber(m.volume),
    liquidity: asNumber(m.liquidity),
    outcomes,
    prices,
    clobTokenIds: tokenIds,
    eventSlug: m.events?.[0]?.slug ?? null,
    venue: "polymarket",
    venueUrl: m.slug ? `https://polymarket.com/market/${m.slug}` : null,
  };
}

// Kalshi REMOVED the integer-cents fields this shaper was built on
// (`yes_bid`, `yes_ask`, `no_bid`, `no_ask`, `last_price`, `volume`,
// `open_interest`). Verified 2026-08-28 against the live API: not one of them
// is present on any market, so both paid Kalshi tools were answering HTTP 200
// with every price, volume and open-interest field null - a charged empty
// answer that no guard could see, because 200 + nulls is not an error.
//
// The replacements are STRINGS in DOLLARS ("0.4700") and fixed-point
// ("volume_fp"). The buyer-facing shape stays in CENTS so an existing caller's
// arithmetic keeps working, and the dollar values ride alongside under their
// own names. `centsFrom` reads the new field first and falls back to the old
// one, so a Kalshi rollback cannot break us a second time.
const centsFrom = (dollars, legacyCents) => {
  const d = asNumber(dollars);
  if (d !== null) return Math.round(d * 100 * 1e6) / 1e6; // dollars -> cents, no float dust
  return asNumber(legacyCents);
};

/** Gamma list payload -> array. `/markets/keyset` returns {markets, next_cursor};
 *  the deprecated `/markets` returned a bare array. Accepts either, so a
 *  rollback on their side cannot empty these tools. */
function polyList(raw) {
  if (Array.isArray(raw)) return raw;
  return Array.isArray(raw?.markets) ? raw.markets : [];
}

// Kalshi retires `liquidity_dollars` on 2026-10-01 (docs.kalshi.com/changelog)
// and it already reads "0.0000" on markets with a live book (measured
// 2026-09-24: 0 of 1,721 open markets nonzero while 1,672 had resting size).
// So `liquidityUsd` is Kalshi's own figure only when it carries one; a zero
// beside a live book, or an absent field, is null with the reason in a field.
// The depth a buyer can use is the top-of-book size above, which is a
// different quantity (contracts at one price) and is never relabelled here.
const KALSHI_LIQUIDITY_NOTE =
  "Kalshi publishes no usable liquidity figure (it reads 0 on live books and is retired 2026-10-01); use yesBidSize/yesAskSize for resting contracts at the best price.";
function kalshiLiquidity(m) {
  const legacy = asNumber(m.liquidity_dollars);
  const book = [m.yes_bid_size_fp, m.yes_ask_size_fp].some((v) => (asNumber(v) || 0) > 0);
  if (legacy !== null && (legacy > 0 || !book)) return { liquidityUsd: legacy };
  return { liquidityUsd: null, liquidityUsdNote: KALSHI_LIQUIDITY_NOTE };
}

function shapeKalshiMarket(m) {
  const yesBid = centsFrom(m.yes_bid_dollars, m.yes_bid);
  const yesAsk = centsFrom(m.yes_ask_dollars, m.yes_ask);
  const noBid = centsFrom(m.no_bid_dollars, m.no_bid);
  const noAsk = centsFrom(m.no_ask_dollars, m.no_ask);
  const lastPrice = centsFrom(m.last_price_dollars, m.last_price);
  return {
    ticker: m.ticker ?? null,
    eventTicker: m.event_ticker ?? null,
    title: m.title ?? null,
    subtitle: m.subtitle ?? null,
    status: m.status ?? null,
    openTime: m.open_time ?? null,
    closeTime: m.close_time ?? null,
    expirationTime: m.expiration_time ?? null,
    yesBid, yesAsk, noBid, noAsk, lastPrice,
    // The same five in dollars (0 to 1), which is how Kalshi now publishes them.
    yesBidUsd: asNumber(m.yes_bid_dollars, yesBid === null ? null : yesBid / 100),
    yesAskUsd: asNumber(m.yes_ask_dollars, yesAsk === null ? null : yesAsk / 100),
    noBidUsd: asNumber(m.no_bid_dollars, noBid === null ? null : noBid / 100),
    noAskUsd: asNumber(m.no_ask_dollars, noAsk === null ? null : noAsk / 100),
    lastPriceUsd: asNumber(m.last_price_dollars, lastPrice === null ? null : lastPrice / 100),
    volume: asNumber(m.volume_fp, asNumber(m.volume)),
    openInterest: asNumber(m.open_interest_fp, asNumber(m.open_interest)),
    // Resting size at the best price, in CONTRACTS (Kalshi's `*_size_fp`).
    // A "no" bid is the other side of a "yes" ask, so Kalshi publishes only
    // the yes-side sizes; the no-side names are read too in case they appear.
    yesBidSize: asNumber(m.yes_bid_size_fp),
    yesAskSize: asNumber(m.yes_ask_size_fp),
    noBidSize: asNumber(m.no_bid_size_fp),
    noAskSize: asNumber(m.no_ask_size_fp),
    ...kalshiLiquidity(m),
    venue: "kalshi",
    venueUrl: m.ticker ? `https://kalshi.com/markets/${m.ticker.toLowerCase()}` : null,
  };
}

// ----------------------------------------------------------------------------
// 1. polymarket-search — keyword search across active Polymarket markets
// ----------------------------------------------------------------------------
async function polymarketSearch({ query, limit, activeOnly } = {}) {
  if (typeof query !== "string" || !query.trim()) {
    throw bad('"query" is required (non-empty string)');
  }
  const lim = Math.max(1, Math.min(50, Number.parseInt(limit, 10) || 10));
  // TWO SOURCES, ONE PREDICATE.
  //
  // The match has always been ours (a plain substring over the market's own
  // question, slug and description), and for a while the only way to FIND a
  // candidate was to page the volume-ordered list - which makes findability a
  // function of how deep we happen to look. On 2026-08-29 that answered 0 for
  // "election", "Trump", "bitcoin" and "2028" at 20 rows deep, and paging to
  // 600 fixed it for a fortnight: on 2026-09-12 "bitcoin" was 0 again, and a
  // hand sweep of the first 3,000 active markets by 24h volume found not one
  // (Fed and football own the top of that list, and Polymarket's bitcoin
  // markets are numerous but individually small). A search tool that cannot
  // find "bitcoin" on Polymarket is broken however honest its note is.
  //
  // Gamma DOES have a keyword index - `/public-search?q=` - and the comment
  // that used to sit here saying otherwise was simply wrong. It is not usable
  // on its own: it is FUZZY, and answers a gibberish query with a Copa America
  // event, so taking its rows as results would turn "no match" into a wrong
  // match. So it is used as a CANDIDATE SOURCE and our own exact predicate
  // still decides - the index supplies reach, the predicate keeps precision,
  // and an unmatchable query still returns the honest zero.
  //
  // The volume scan stays as the fallback and the top-up: if their search
  // endpoint changes shape or disappears, this tool degrades to what it did
  // yesterday instead of emptying (the same rule as polyList's dual shape).
  const params = new URLSearchParams({
    limit: String(POLY_SEARCH_PAGE),
    order: "volume24hr",
    ascending: "false",
  });
  if (activeOnly !== false) {
    params.set("active", "true");
    params.set("closed", "false");
  }
  const meta = {};
  // Polymarket's gamma LIST endpoints answer `deprecation: true` and
  // `sunset: Fri, 01 May 2026` in HTTP HEADERS ONLY - nothing in their docs or
  // OpenAPI spec says so (found 2026-08-28). `/markets/keyset` is the named
  // replacement: same filters and ordering, but it returns an OBJECT with a
  // `markets` array and a `next_cursor`, and it REFUSES `offset` with a 422.
  const q = query.trim().toLowerCase();
  const hits = [];
  const seenIds = new Set();
  let scanned = 0;
  const keep = (m) => {
    const id = String(m?.id ?? "");
    if (!id || seenIds.has(id)) return;
    if (activeOnly !== false && (!m.active || m.closed)) return;
    const hay = `${m.question || ""} ${m.slug || ""} ${m.description || ""}`.toLowerCase();
    if (!hay.includes(q) || hits.length >= lim) return;
    seenIds.add(id);
    hits.push(m);
  };

  let searchedIndex = false;
  try {
    const sr = await fetchJson(
      `${POLY_GAMMA}/public-search?q=${encodeURIComponent(query.trim())}&limit_per_type=${POLY_SEARCH_INDEX_EVENTS}`,
      "Polymarket Gamma",
      meta,
    );
    const events = Array.isArray(sr?.events) ? sr.events : [];
    searchedIndex = true;
    for (const ev of events) {
      for (const m of Array.isArray(ev?.markets) ? ev.markets : []) {
        scanned++;
        // The parent event carries the slug shapeMarket reports; a market
        // nested inside a search result has no `events` array of its own.
        keep(m.events ? m : { ...m, events: [{ slug: ev.slug }] });
      }
    }
  } catch {
    // Their index is a bonus, never a dependency: fall through to the scan.
  }

  let cursor = null;
  let pages = 0;
  // Only a scan that actually reached the end of the list may claim it. With
  // enough matches from the keyword index the scan never runs, and reporting
  // "exhausted" there would assert we read the whole active list when we read
  // none of it.
  let scanExhausted = false;
  // Bounded: at most POLY_SEARCH_MAX_PAGES requests, and it stops early as soon
  // as `lim` matches are in hand, so a common term still costs one page.
  for (; pages < POLY_SEARCH_MAX_PAGES && hits.length < lim; pages++) {
    if (cursor) params.set("cursor", cursor); else params.delete("cursor");
    const raw = await fetchJson(`${POLY_GAMMA}/markets/keyset?${params}`, "Polymarket Gamma", meta);
    const arr = polyList(raw);
    scanned += arr.length;
    for (const m of arr) keep(m);
    cursor = (raw && typeof raw === "object" && !Array.isArray(raw) && raw.next_cursor) || null;
    if (!cursor || arr.length === 0) { scanExhausted = true; break; } // end of the list, not of our budget
  }
  const matched = hits.map(shapeMarket);
  return {
    query: query.trim(),
    count: matched.length,
    markets: matched,
    // How deep the search actually went, because the match is client-side: a
    // caller seeing 0 should be able to tell "not listed" from "not reached".
    scannedMarkets: scanned,
    searchExhausted: scanExhausted,
    // Which sources were consulted, so a zero is readable: the keyword index
    // reaches markets the volume scan never gets to, and its absence is the
    // difference between "not listed" and "we only looked at the busy ones".
    searchedKeywordIndex: searchedIndex,
    ...(matched.length === 0
      ? { note: `No active Polymarket market matched ${JSON.stringify(query.trim())} in ${scanned} markets${searchedIndex ? " from Polymarket's own keyword index plus the highest-volume active list" : ` (the ${scanned} highest-volume active markets; their keyword index could not be read)`}${scanExhausted ? "" : "; more exist beyond the search depth"}.` }
      : {}),
    source: "polymarket-gamma",
    ...staleFields(meta),
  };
}

// ----------------------------------------------------------------------------
// 2. polymarket-market — get a single market by slug or id with full detail
// ----------------------------------------------------------------------------
async function polymarketMarket({ slug, id } = {}) {
  const s = typeof slug === "string" ? slug.trim() : "";
  const i = typeof id === "string" || typeof id === "number" ? String(id).trim() : "";
  if (!s && !i) throw bad('"slug" or "id" is required');
  const meta = {};
  let raw;
  if (i) {
    raw = await fetchJson(`${POLY_GAMMA}/markets/${encodeURIComponent(i)}`, "Polymarket Gamma", meta);
  } else {
    // Gamma doesn't take ?slug= directly — fetch by slug filter. The filter
    // excludes closed markets by default, so a resolved market "disappears"
    // from ?slug= even though it's still queryable — fall back to closed=true
    // before declaring not-found.
    let r = polyList(await fetchJson(`${POLY_GAMMA}/markets/keyset?slug=${encodeURIComponent(s)}`, "Polymarket Gamma", meta));
    if (!r.length) {
      r = polyList(await fetchJson(`${POLY_GAMMA}/markets/keyset?slug=${encodeURIComponent(s)}&closed=true`, "Polymarket Gamma", meta));
    }
    if (!r.length) throw bad(`Market not found for slug "${s}"`, 404);
    raw = r[0];
  }
  return { ...shapeMarket(raw), ...staleFields(meta) };
}

// ----------------------------------------------------------------------------
// 3. polymarket-orderbook — bids/asks for a specific outcome token (CLOB)
// ----------------------------------------------------------------------------
async function polymarketOrderbook({ tokenId, depth } = {}) {
  if (typeof tokenId !== "string" || !/^\d+$/.test(tokenId.trim())) {
    throw bad('"tokenId" is required (decimal-encoded CLOB token id string - see market.clobTokenIds)');
  }
  const d = Math.max(1, Math.min(50, Number.parseInt(depth, 10) || 10));
  const meta = {};
  const raw = await fetchJson(
    `${POLY_CLOB}/book?token_id=${encodeURIComponent(tokenId.trim())}`,
    "Polymarket CLOB",
    meta,
  );
  const bids = Array.isArray(raw.bids) ? raw.bids : [];
  const asks = Array.isArray(raw.asks) ? raw.asks : [];
  // CLOB returns bids low→high; flip so top of book is index 0 (highest bid first).
  // Asks come low→high which is already correct (lowest ask = top of book).
  const topBids = [...bids].reverse().slice(0, d).map((b) => ({ price: asNumber(b.price), size: asNumber(b.size) }));
  const topAsks = asks.slice(0, d).map((a) => ({ price: asNumber(a.price), size: asNumber(a.size) }));
  const bestBid = topBids[0]?.price ?? null;
  const bestAsk = topAsks[0]?.price ?? null;
  return {
    tokenId: tokenId.trim(),
    market: raw.market ?? null,
    asset: raw.asset_id ?? null,
    timestamp: raw.timestamp ?? null,
    bestBid,
    bestAsk,
    midPrice: bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null,
    spread: bestBid != null && bestAsk != null ? bestAsk - bestBid : null,
    bids: topBids,
    asks: topAsks,
    ...(topBids.length || topAsks.length ? {} : { note: RESOLVED_NOTE }),
    source: "polymarket-clob",
    ...staleFields(meta),
  };
}

/** An empty result on a prediction market usually means the market has stopped
 *  trading, not that the tool failed. A caller cannot tell those apart from an
 *  empty array, so the answer says which one it is: any saved token id or event
 *  ticker eventually points at something resolved, and a silent empty read is
 *  exactly how the Kalshi field rename hid for weeks. */
const RESOLVED_NOTE = "No open orders for this outcome token. A market that has resolved or been delisted still answers, with an empty book - check the market's status before reading this as an outage.";
const NO_HISTORY_NOTE = "No price samples in this window. The token id may belong to a market that never traded, or the interval may predate it.";
const NO_MARKETS_NOTE = "This event carries no markets. Kalshi removes the markets of settled events, so a saved event ticker can resolve to an event with none left.";

// ----------------------------------------------------------------------------
// 4. polymarket-price-history — historical odds for a market outcome
// ----------------------------------------------------------------------------
async function polymarketPriceHistory({ tokenId, interval, fidelity } = {}) {
  if (typeof tokenId !== "string" || !/^\d+$/.test(tokenId.trim())) {
    throw bad('"tokenId" is required (decimal-encoded CLOB token id string)');
  }
  const intervalAllowed = new Set(["1h", "6h", "1d", "1w", "1m", "max"]);
  const iv = typeof interval === "string" && intervalAllowed.has(interval) ? interval : "1d";
  const fi = Math.max(1, Math.min(720, Number.parseInt(fidelity, 10) || 60)); // minutes per sample
  const id = tokenId.trim();
  // v2 first (bucketSeconds is the fidelity in seconds), the legacy CLOB route
  // as the fallback when v2 is unreachable, refuses, or answers a shape the
  // reader does not recognise. Both shapes go through polyHistoryPoints.
  const v2Url = `${POLY_DATA_API}/v2/prices-history?tokenId=${encodeURIComponent(id)}&interval=${iv}&bucketSeconds=${fi * 60}`;
  const legacyUrl = `${POLY_CLOB}/prices-history?market=${encodeURIComponent(id)}&interval=${iv}&fidelity=${fi}`;
  let meta = {};
  let raw = null, source = "polymarket-data-api";
  try {
    raw = await fetchJson(v2Url, "Polymarket data API", meta);
    if (!polyHistoryPoints(raw)) throw bad("Polymarket data API answered an unrecognised shape", 502);
  } catch (e) {
    console.warn(`[prediction] price history v2 failed (${e?.message || e}); falling back to the CLOB route`);
    meta = {};
    raw = await fetchJson(legacyUrl, "Polymarket CLOB", meta);
    source = "polymarket-clob";
  }
  const points = polyHistoryPoints(raw) || [];
  const prices = points.map((p) => p.price).filter((p) => p != null);
  return {
    tokenId: id,
    interval: iv,
    fidelityMinutes: fi,
    count: points.length,
    min: prices.length ? Math.min(...prices) : null,
    max: prices.length ? Math.max(...prices) : null,
    first: points[0]?.price ?? null,
    last: points[points.length - 1]?.price ?? null,
    points,
    // v2 pages; the first page is what a fidelity-bounded window needs, and a
    // window it could not finish says so instead of reading as complete.
    truncated: raw?.pagination?.has_more === true,
    ...(points.length ? {} : { note: NO_HISTORY_NOTE }),
    source,
    ...staleFields(meta),
  };
}

/** Points from either price-history shape: the Data API v2 document
 *  (`{data:[{timestamp, price, resolution_seconds}]}`) or the legacy CLOB one
 *  (`{history:[{t, p}]}`). Null when the document is neither, so the caller
 *  can fall back rather than publish an empty series as an answer. */
function polyHistoryPoints(raw) {
  if (Array.isArray(raw?.data)) return raw.data.map((p) => ({ timestamp: p?.timestamp ?? p?.t ?? null, price: asNumber(p?.price ?? p?.p) }));
  if (Array.isArray(raw?.history)) return raw.history.map((p) => ({ timestamp: p?.t ?? p?.timestamp ?? null, price: asNumber(p?.p ?? p?.price) }));
  return null;
}

// ----------------------------------------------------------------------------
// 5. kalshi-markets — list Kalshi markets, filterable by status/event
// ----------------------------------------------------------------------------
async function kalshiMarkets({ status, eventTicker, limit } = {}) {
  const lim = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 20));
  const params = new URLSearchParams({ limit: String(lim) });
  if (typeof status === "string" && status.trim()) {
    const allowed = new Set(["open", "closed", "settled", "unopened"]);
    if (!allowed.has(status.trim().toLowerCase())) {
      throw bad(`"status" must be one of ${[...allowed].join(", ")}`);
    }
    params.set("status", status.trim().toLowerCase());
  }
  if (typeof eventTicker === "string" && eventTicker.trim()) {
    params.set("event_ticker", eventTicker.trim().toUpperCase());
  }
  const meta = {};
  const raw = await fetchJson(`${KALSHI}/markets?${params}`, "Kalshi", meta);
  const markets = Array.isArray(raw.markets) ? raw.markets.map(shapeKalshiMarket) : [];
  return {
    count: markets.length,
    cursor: raw.cursor ?? null,
    markets,
    source: "kalshi",
    ...staleFields(meta),
  };
}

// ----------------------------------------------------------------------------
// 6. kalshi-event — full detail for a Kalshi event (all its markets)
// ----------------------------------------------------------------------------
async function kalshiEvent({ eventTicker } = {}) {
  const t = typeof eventTicker === "string" ? eventTicker.trim().toUpperCase() : "";
  if (!t) throw bad('"eventTicker" is required (Kalshi event ticker, e.g. "PRES-24")');
  const meta = {};
  const raw = await fetchJson(
    `${KALSHI}/events/${encodeURIComponent(t)}?with_nested_markets=true`,
    "Kalshi",
    meta,
  );
  const event = raw.event ?? raw;
  const markets = Array.isArray(event.markets) ? event.markets.map(shapeKalshiMarket) : [];
  return {
    eventTicker: event.event_ticker ?? t,
    title: event.title ?? null,
    subTitle: event.sub_title ?? null,
    seriesTicker: event.series_ticker ?? null,
    category: event.category ?? null,
    mutuallyExclusive: !!event.mutually_exclusive,
    marketCount: markets.length,
    markets,
    ...(markets.length ? {} : { note: NO_MARKETS_NOTE }),
    source: "kalshi",
    ...staleFields(meta),
  };
}

// ----------------------------------------------------------------------------
// 7. kalshi-live-data - the live feed BEHIND an event (the settlement input)
// ----------------------------------------------------------------------------
// Kalshi's `live_data` tier (free, keyless; docs.kalshi.com/api-reference/
// live-data, read 2026-09-18) serves the underlying series a market settles
// on: a crypto event carries CF Benchmarks candlesticks + a minute series and
// its maturity time, an economic-data event carries the provider's series
// (BLS CPI, monthly) with the target period. The `type` names the schema of
// `details`, and the shaper keeps that rule: every numeric field is read with
// asNumber (absent = null, never 0), the two array shapes Kalshi actually
// serves (probed live: `timeseries` [{t, v}] and `candlesticks` {interval:
// [{open_ts_ms, open, high, low, close}]}) are normalised, and whatever else
// the type carries rides through under `details` untouched.
//
// An event ticker expires with its event (an hourly BTC event is gone by the
// next day), so the tool also takes a SERIES ticker and resolves the soonest
// open event itself - that is the form the documented example uses, so the
// example keeps answering.
const LIVE_RANGES = new Set(["15min", "1h", "3h", "1d", "1w", "1m", "1y", "5y", "all"]);
const LIVE_SERIES_MAX = 1000;
const TICKER_RE = /^[A-Z0-9][A-Z0-9-]{1,60}$/;

function liveSeries(points, limit) {
  if (!Array.isArray(points)) return null;
  const rows = points
    .filter((p) => p && typeof p === "object")
    .map((p) => ({
      time: p.t == null ? null : (typeof p.t === "number" ? new Date(p.t).toISOString() : String(p.t)),
      value: asNumber(p.v),
      ...(p.label != null ? { label: String(p.label) } : {}),
    }));
  return rows.slice(-limit);
}

function liveCandlesticks(obj, limit) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const out = [];
  for (const [interval, arr] of Object.entries(obj)) {
    if (!Array.isArray(arr)) continue;
    const candles = arr
      .filter((c) => c && typeof c === "object")
      .map((c) => ({
        time: c.open_ts_ms == null ? null : new Date(Number(c.open_ts_ms)).toISOString(),
        open: asNumber(c.open), high: asNumber(c.high), low: asNumber(c.low), close: asNumber(c.close),
      }))
      .slice(-limit);
    out.push({ interval, count: candles.length, candles });
  }
  return out;
}

function shapeKalshiLiveData(raw, { eventTicker, limit }) {
  const ld = raw?.live_data ?? raw ?? {};
  const details = ld.details && typeof ld.details === "object" ? ld.details : {};
  const { timeseries, candlesticks, ...rest } = details;
  const series = liveSeries(timeseries, limit);
  const candles = liveCandlesticks(candlesticks, limit);
  const latest = series?.length ? series[series.length - 1] : null;
  return {
    eventTicker: details.event_ticker ?? eventTicker ?? null,
    type: ld.type ?? null,
    // Present on crypto live data only (a frozen snapshot once the event has
    // matured); an absent flag reads null, never false.
    isHistorical: typeof ld.is_historical === "boolean" ? ld.is_historical : (typeof details.is_historical === "boolean" ? details.is_historical : null),
    defaultRange: ld.default_range ?? null,
    rangeOptions: Array.isArray(ld.range_options) ? ld.range_options : [],
    coin: details.coin ?? null,
    maturityTime: details.maturity_ts_ms == null ? null : new Date(Number(details.maturity_ts_ms)).toISOString(),
    latest,
    seriesCount: series ? series.length : 0,
    series: series ?? [],
    candlesticks: candles ?? [],
    details: rest,
  };
}

async function kalshiLiveData({ eventTicker, seriesTicker, range, limit } = {}) {
  const lim = Math.max(1, Math.min(LIVE_SERIES_MAX, Number.parseInt(limit, 10) || 200));
  let ticker = typeof eventTicker === "string" ? eventTicker.trim().toUpperCase() : "";
  const series = typeof seriesTicker === "string" ? seriesTicker.trim().toUpperCase() : "";
  if (!ticker && !series) throw bad('"eventTicker" (e.g. "KXBTC-26SEP1817") or "seriesTicker" (e.g. "KXBTC", resolves the soonest open event) is required');
  if (ticker && !TICKER_RE.test(ticker)) throw bad('"eventTicker" must be a Kalshi event ticker (letters, digits, hyphens)');
  if (series && !TICKER_RE.test(series)) throw bad('"seriesTicker" must be a Kalshi series ticker (letters, digits, hyphens)');
  let rng = null;
  if (range != null && range !== "") {
    rng = String(range).trim().toLowerCase();
    if (!LIVE_RANGES.has(rng)) throw bad(`"range" must be one of ${[...LIVE_RANGES].join(", ")}`);
  }
  const meta = {};
  let resolvedFrom = null;
  if (!ticker) {
    const ev = await fetchJson(`${KALSHI}/events?${new URLSearchParams({ series_ticker: series, status: "open", limit: "1" })}`, "Kalshi", meta);
    const first = Array.isArray(ev?.events) ? ev.events[0] : null;
    if (!first?.event_ticker) throw bad(`Kalshi has no open event in series "${series}" right now - pass an eventTicker instead`, 404);
    ticker = String(first.event_ticker).toUpperCase();
    resolvedFrom = { seriesTicker: series, title: first.title ?? null, strikeDate: first.strike_date ?? null };
  }
  const qs = rng ? `?${new URLSearchParams({ range: rng })}` : "";
  const raw = await fetchJson(`${KALSHI}/live_data/events/${encodeURIComponent(ticker)}${qs}`, "Kalshi", meta);
  return {
    ...shapeKalshiLiveData(raw, { eventTicker: ticker, limit: lim }),
    ...(resolvedFrom ? { resolvedFrom } : {}),
    range: rng,
    source: "kalshi",
    ...staleFields(meta),
  };
}

// ----------------------------------------------------------------------------
// 8. kalshi-weather-index - the city temperature index hourly markets settle on
// ----------------------------------------------------------------------------
// `GET /live_data/weather/{city}`: Kalshi's own minute-resolution Fahrenheit
// index, city-keyed and independent of any event, computed from weighted
// member stations under a published, append-only calibration timeline
// (`/calibrations`). Minutes where the quorum failed are never returned, so
// a gap in the series is a real gap and the shaper does not fill one.
// Probed live 2026-09-18: the API names the supported cities in its own 400
// for an unknown one; that list is copied here for the 422 so a buyer learns
// it without a second call, and it is a hint, never a gate - a city the API
// adds tomorrow still answers.
const WEATHER_CITIES = ["miami", "dfw", "houston", "phl-delaware-valley", "puget-sound", "sf-bay", "greater-boston", "southeast-michigan", "kansas-city", "minneapolis-st-paul", "nyc", "chicago", "la-coastal"];
const WEATHER_MAX_WINDOW_SEC = 7 * 24 * 3600;
const CITY_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

function shapeWeatherPoint(p, detailed) {
  const row = {
    time: p?.t == null ? null : new Date(Number(p.t)).toISOString(),
    valueF: asNumber(p?.v),
    contributors: asNumber(p?.contributors),
    status: p?.status ?? null,
  };
  // Per-station audit rows (probed live 2026-09-18 with detailed=true):
  // {station_id, temp_f, code, source, received_at_ms}. `code` is the
  // quality-control disposition ("ok" when the reading was incorporated).
  if (detailed && Array.isArray(p?.stations)) {
    row.stations = p.stations.map((s) => ({
      stationId: s?.station_id ?? null,
      tempF: asNumber(s?.temp_f),
      code: s?.code ?? null,
      source: s?.source ?? null,
      receivedAt: s?.received_at_ms == null ? null : new Date(Number(s.received_at_ms)).toISOString(),
    }));
  }
  return row;
}

function shapeWeatherCalibration(c) {
  return {
    configVersion: c?.config_version ?? null,
    effectiveAt: c?.effective_at_ms == null ? null : new Date(Number(c.effective_at_ms)).toISOString(),
    publishedAt: c?.published_at_ms == null ? null : new Date(Number(c.published_at_ms)).toISOString(),
    changeReason: c?.change_reason ?? null,
    cityReferenceC: asNumber(c?.city_reference_c),
    calibrationWindow: c?.calibration_window_start_ms == null ? null : {
      start: new Date(Number(c.calibration_window_start_ms)).toISOString(),
      end: c?.calibration_window_end_ms == null ? null : new Date(Number(c.calibration_window_end_ms)).toISOString(),
    },
    stations: Array.isArray(c?.stations) ? c.stations.map((s) => ({
      stationId: s?.station_id ?? null, weight: asNumber(s?.weight), offsetC: asNumber(s?.offset_c), updateNote: s?.update_note ?? null,
    })) : [],
  };
}

async function kalshiWeatherIndex({ city, lastSec, from, to, detailed, includeCalibrations, limit } = {}) {
  const c = typeof city === "string" ? city.trim().toLowerCase() : "";
  if (!c) throw bad(`"city" is required - a Kalshi weather index city id, one of ${WEATHER_CITIES.join(", ")}`);
  if (!CITY_RE.test(c)) throw bad('"city" must be a Kalshi city id such as "miami" or "sf-bay"');
  const lim = Math.max(1, Math.min(LIVE_SERIES_MAX * 10, Number.parseInt(limit, 10) || 1440));
  const params = new URLSearchParams();
  const hasFrom = from != null && from !== "", hasTo = to != null && to !== "";
  if (hasFrom !== hasTo) throw bad('"from" and "to" (unix milliseconds) must be given together, or use "lastSec"');
  if (hasFrom) {
    const f = Number(from), t = Number(to);
    if (!Number.isFinite(f) || !Number.isFinite(t) || f <= 0 || t <= f) throw bad('"from"/"to" must be unix milliseconds with from < to');
    if (t - f > WEATHER_MAX_WINDOW_SEC * 1000) throw bad(`"from"/"to" window must be at most ${WEATHER_MAX_WINDOW_SEC / 86400} days`);
    params.set("from", String(Math.floor(f)));
    params.set("to", String(Math.floor(t)));
  } else {
    const secs = lastSec == null || lastSec === "" ? 3600 : Number(lastSec);
    if (!Number.isFinite(secs) || secs <= 0 || secs > WEATHER_MAX_WINDOW_SEC) throw bad(`"lastSec" must be between 1 and ${WEATHER_MAX_WINDOW_SEC} seconds (7 days)`);
    params.set("last_sec", String(Math.floor(secs)));
  }
  const det = detailed === true || detailed === "true";
  if (det) params.set("detailed", "true");
  const meta = {};
  let raw;
  try {
    raw = await fetchJson(`${KALSHI}/live_data/weather/${encodeURIComponent(c)}?${params}`, "Kalshi", meta);
  } catch (e) {
    // Kalshi answers 400 for a city it does not index; that is the caller's
    // input, so it is a 422 naming the cities it does index.
    if (e?.statusCode === 400 && /unknown_weather_index_city|unknown weather index city/i.test(e.message)) {
      throw bad(`Kalshi has no weather index for city "${c}" - supported cities: ${WEATHER_CITIES.join(", ")}`, 422);
    }
    throw e;
  }
  const all = Array.isArray(raw?.timeseries) ? raw.timeseries.map((p) => shapeWeatherPoint(p, det)) : [];
  const points = all.slice(-lim);
  const values = points.map((p) => p.valueF).filter((v) => v !== null);
  const out = {
    city: raw?.city ?? c,
    units: raw?.units ?? "fahrenheit",
    configVersion: raw?.config_version || null,
    count: points.length,
    totalInWindow: all.length,
    latest: points.length ? points[points.length - 1] : null,
    minF: values.length ? Math.min(...values) : null,
    maxF: values.length ? Math.max(...values) : null,
    points,
    ...(points.length ? {} : { note: "No index points in this window. Minutes where the station quorum failed carry no value and are never returned, so an empty window is a real gap, not an outage." }),
    source: "kalshi",
    ...staleFields(meta),
  };
  if (includeCalibrations === true || includeCalibrations === "true") {
    const cal = await fetchJson(`${KALSHI}/live_data/weather/${encodeURIComponent(c)}/calibrations`, "Kalshi", meta);
    out.calibrations = Array.isArray(cal?.calibrations) ? cal.calibrations.map(shapeWeatherCalibration) : [];
    out.calibrationUnits = cal?.units ?? "celsius";
  }
  return out;
}

// ----------------------------------------------------------------------------
// Catalog
// ----------------------------------------------------------------------------
export const PREDICTION_MARKET_TOOLS = [
  {
    route: "POST /api/polymarket-search",
    name: "Polymarket search",
    slug: "polymarket-search",
    category: "crypto",
    price: "$0.001",
    description:
      "Search active Polymarket markets by keyword. Candidates come from Polymarket's own keyword index and from the highest-volume active list, and an exact substring match on the market's question, slug and description decides - so a term that matches nothing returns nothing rather than a loose neighbour. Returns question, current outcome prices (implied probabilities), volume, liquidity, end date, and CLOB token ids for orderbook lookups, plus scannedMarkets and searchExhausted so a zero can be read as \"not listed\" rather than \"not reached\".",
    tags: ["polymarket", "prediction-market", "odds", "search", "betting"],
    discovery: {
      bodyType: "json",
      input: { query: "election", limit: 5 },
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", description: "Keyword to search market questions, slugs, and descriptions." },
          limit: { type: "number", description: "Max markets to return (1-50, default 10)." },
          activeOnly: { type: "boolean", description: "Filter to active+open markets only (default true)." },
        },
      },
      output: {
        example: {
          query: "election",
          count: 1,
          markets: [{
            id: "12345",
            slug: "will-x-win-election",
            question: "Will X win the election?",
            endDate: "2026-11-03T23:59:00Z",
            active: true,
            closed: false,
            volume: 1234567.89,
            outcomes: ["Yes", "No"],
            prices: [0.62, 0.38],
            clobTokenIds: ["7290..."],
            venue: "polymarket",
            venueUrl: "https://polymarket.com/market/will-x-win-election",
          }],
          scannedMarkets: 57,
          searchExhausted: false,
          searchedKeywordIndex: true,
          source: "polymarket-gamma",
        },
      },
    },
    handler: polymarketSearch,
  },
  {
    route: "POST /api/polymarket-market",
    name: "Polymarket market detail",
    slug: "polymarket-market",
    category: "crypto",
    price: "$0.002",
    description:
      "Get full detail for a single Polymarket market by slug or id. Returns question, description, outcome prices (implied probabilities), volume, liquidity, end date, resolution status, and CLOB token ids needed for orderbook + history lookups.",
    tags: ["polymarket", "prediction-market", "market-detail", "odds"],
    discovery: {
      bodyType: "json",
      input: { slug: "will-donald-trump-win-the-2024-us-presidential-election" },
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Market slug (one of slug/id required)." },
          id: { type: "string", description: "Numeric market id (one of slug/id required)." },
        },
      },
      output: {
        example: {
          id: "12345",
          slug: "will-x-win-election",
          question: "Will X win the election?",
          description: "Resolves YES if X is declared the winner by AP.",
          endDate: "2026-11-03T23:59:00Z",
          active: true,
          closed: false,
          archived: false,
          volume: 1234567.89,
          liquidity: 56789.01,
          outcomes: ["Yes", "No"],
          prices: [0.62, 0.38],
          clobTokenIds: ["7290...", "8390..."],
          eventSlug: "us-election-2026",
          venue: "polymarket",
          venueUrl: "https://polymarket.com/market/will-x-win-election",
        },
      },
    },
    handler: polymarketMarket,
  },
  {
    route: "POST /api/polymarket-orderbook",
    name: "Polymarket orderbook",
    slug: "polymarket-orderbook",
    category: "crypto",
    price: "$0.001",
    description:
      "Live CLOB orderbook for a Polymarket outcome token. Returns top N bids (highest first), top N asks (lowest first), best bid/ask, mid-price, and spread. Use a clobTokenId from polymarket-market or polymarket-search.",
    tags: ["polymarket", "orderbook", "bids-asks", "spread", "liquidity"],
    discovery: {
      bodyType: "json",
      input: { tokenId: "73572420636299743863462231021719080735797435555188685901000528926122020595832", depth: 5 },
      inputSchema: {
        type: "object",
        required: ["tokenId"],
        properties: {
          tokenId: { type: "string", description: "CLOB token id (decimal string) from market.clobTokenIds." },
          depth: { type: "number", description: "Levels each side to return (1-50, default 10)." },
        },
      },
      output: {
        example: {
          tokenId: "72909...",
          market: "0xabc...",
          asset: "72909...",
          timestamp: "1751234567",
          bestBid: 0.61,
          bestAsk: 0.63,
          midPrice: 0.62,
          spread: 0.02,
          bids: [{ price: 0.61, size: 1000 }, { price: 0.60, size: 500 }],
          asks: [{ price: 0.63, size: 800 }, { price: 0.64, size: 1200 }],
          source: "polymarket-clob",
        },
      },
    },
    handler: polymarketOrderbook,
  },
  {
    route: "POST /api/polymarket-price-history",
    name: "Polymarket price history",
    slug: "polymarket-price-history",
    category: "crypto",
    price: "$0.002",
    description:
      "Historical odds (implied probabilities) for a Polymarket outcome token. Returns timestamped price samples with first/last/min/max summary. Useful for: tracking probability shifts around events, computing realized volatility, backtesting prediction strategies.",
    tags: ["polymarket", "history", "odds-history", "time-series", "probability"],
    discovery: {
      bodyType: "json",
      input: { tokenId: "73572420636299743863462231021719080735797435555188685901000528926122020595832", interval: "1d" },
      inputSchema: {
        type: "object",
        required: ["tokenId"],
        properties: {
          tokenId: { type: "string", description: "CLOB token id (decimal string) from market.clobTokenIds." },
          interval: { type: "string", description: "Lookback window: 1h, 6h, 1d, 1w, 1m, max (default 1d)." },
          fidelity: { type: "number", description: "Sample granularity in minutes (1-720, default 60)." },
        },
      },
      output: {
        example: {
          tokenId: "72909...",
          interval: "1d",
          fidelityMinutes: 60,
          count: 24,
          min: 0.55,
          max: 0.67,
          first: 0.58,
          last: 0.62,
          points: [
            { timestamp: 1751200000, price: 0.58 },
            { timestamp: 1751203600, price: 0.59 },
          ],
          truncated: false,
          source: "polymarket-data-api",
        },
      },
    },
    handler: polymarketPriceHistory,
  },
  {
    route: "POST /api/kalshi-markets",
    name: "Kalshi markets list",
    slug: "kalshi-markets",
    category: "crypto",
    price: "$0.002",
    description:
      "List Kalshi markets (CFTC-regulated US event contracts). Filter by status (open/closed/settled/unopened) or by event ticker. Returns yes/no bid/ask, last price, volume, open interest, and the resting contract size at the best yes bid and ask (yesBidSize/yesAskSize). Complement to Polymarket for US-regulated markets and Kalshi-only categories (weather, economic data).",
    tags: ["kalshi", "prediction-market", "regulated", "event-contracts", "cftc"],
    discovery: {
      bodyType: "json",
      input: { status: "open", limit: 5 },
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", description: "Filter by status: open, closed, settled, unopened." },
          eventTicker: { type: "string", description: "Filter to a specific event ticker." },
          limit: { type: "number", description: "Max markets (1-100, default 20)." },
        },
      },
      output: {
        example: {
          count: 1,
          cursor: "next-page-token",
          markets: [{
            ticker: "PRES-24-DEM",
            eventTicker: "PRES-24",
            title: "Will the Democratic nominee win?",
            subtitle: "2026 US Presidential election",
            status: "open",
            openTime: "2026-01-01T00:00:00Z",
            closeTime: "2026-11-03T23:59:00Z",
            yesBid: 0.45,
            yesAsk: 0.47,
            noBid: 0.53,
            noAsk: 0.55,
            lastPrice: 0.46,
            volume: 12345,
            openInterest: 5678,
            yesBidSize: 471.53,
            yesAskSize: 323.1,
            venue: "kalshi",
            venueUrl: "https://kalshi.com/markets/pres-24-dem",
          }],
          source: "kalshi",
        },
      },
    },
    handler: kalshiMarkets,
  },
  {
    route: "POST /api/kalshi-event",
    name: "Kalshi event detail",
    slug: "kalshi-event",
    category: "crypto",
    price: "$0.002",
    description:
      "Get full detail for a single Kalshi event with all its nested markets. Mutually-exclusive flag tells you whether the markets partition outcome space (e.g. one winner). Useful for: viewing all candidates in an election, all CPI ranges, all weather buckets.",
    tags: ["kalshi", "event", "prediction-market", "regulated"],
    discovery: {
      bodyType: "json",
      input: { eventTicker: "KXELONMARS-99" },
      inputSchema: {
        type: "object",
        required: ["eventTicker"],
        properties: {
          eventTicker: { type: "string", description: "Kalshi event ticker, e.g. PRES-24, CPI-25APR." },
        },
      },
      output: {
        example: {
          eventTicker: "PRES-24",
          title: "2026 US Presidential election",
          subTitle: "Who will win?",
          seriesTicker: "PRES",
          category: "Politics",
          mutuallyExclusive: true,
          marketCount: 2,
          markets: [{
            ticker: "PRES-24-DEM",
            eventTicker: "PRES-24",
            title: "Will the Democratic nominee win?",
            status: "open",
            yesBid: 0.45,
            yesAsk: 0.47,
            noBid: 0.53,
            noAsk: 0.55,
            lastPrice: 0.46,
            volume: 12345,
            openInterest: 5678,
            yesBidSize: 471.53,
            yesAskSize: 323.1,
            venue: "kalshi",
            venueUrl: "https://kalshi.com/markets/pres-24-dem",
          }],
          source: "kalshi",
        },
      },
    },
    handler: kalshiEvent,
  },
  {
    route: "POST /api/kalshi-live-data",
    name: "Kalshi live data behind an event",
    slug: "kalshi-live-data",
    category: "crypto",
    price: "$0.002",
    description:
      "The live feed a Kalshi event settles on, from Kalshi's free live_data tier: a crypto event returns the CF Benchmarks price series, candlesticks (15M, 1M) and the maturity time; an economic-data event (CPI, jobs) returns the provider's series with the target period. Pass an eventTicker, or a seriesTicker (e.g. KXBTC) and the soonest open event is resolved for you. The type field names the schema of details.",
    tags: ["kalshi", "live-data", "prediction-market", "settlement", "price-feed"],
    discovery: {
      bodyType: "json",
      input: { seriesTicker: "KXBTC", limit: 5 },
      inputSchema: {
        type: "object",
        properties: {
          eventTicker: { type: "string", description: "Kalshi event ticker, e.g. KXBTC-26SEP1817. Either this or seriesTicker." },
          seriesTicker: { type: "string", description: "Kalshi series ticker, e.g. KXBTC or KXCPI - the soonest open event of the series is resolved." },
          range: { type: "string", description: "Chart range hint for types that support it: 15min, 1h, 3h, 1d, 1w, 1m, 1y, 5y, all." },
          limit: { type: "number", description: "Newest points to keep per series and per candlestick interval (default 200, max 1000)." },
        },
      },
      output: {
        example: {
          eventTicker: "KXBTC-26SEP1817",
          type: "crypto",
          isHistorical: false,
          defaultRange: "1h",
          rangeOptions: ["15min", "1h", "3h"],
          coin: "BTC",
          maturityTime: "2026-09-18T21:00:00.000Z",
          latest: { time: "2026-09-18T16:22:00.000Z", value: 80867.31 },
          seriesCount: 5,
          series: [{ time: "2026-09-18T16:22:00.000Z", value: 80867.31 }],
          candlesticks: [{ interval: "15M", count: 5, candles: [{ time: "2026-09-18T16:15:00.000Z", open: 80703.13, high: 80868.42, low: 80664.65, close: 80867.31 }] }],
          details: { event_ticker: "KXBTC-26SEP1817", coin: "BTC", maturity_ts_ms: 1789765200000 },
          resolvedFrom: { seriesTicker: "KXBTC", title: "BTC price range on Sep 18, 2026 at 5pm EDT?", strikeDate: "2026-09-18T21:00:00Z" },
          range: null,
          source: "kalshi",
        },
      },
    },
    handler: kalshiLiveData,
  },
  {
    route: "POST /api/kalshi-weather-index",
    name: "Kalshi city temperature index",
    slug: "kalshi-weather-index",
    category: "crypto",
    price: "$0.002",
    description:
      "Kalshi's own minute-resolution city temperature index (Fahrenheit), the series its hourly temperature markets settle on, computed from weighted member stations. Ask for a trailing window (lastSec, default one hour, max 7 days) or a from/to window; detailed adds every station's reading per minute; includeCalibrations adds the published station-weight and offset timeline. Cities: miami, dfw, houston, phl-delaware-valley, puget-sound, sf-bay, greater-boston, southeast-michigan, kansas-city, minneapolis-st-paul, nyc, chicago, la-coastal. Free keyless Kalshi live_data.",
    tags: ["kalshi", "weather", "temperature", "live-data", "prediction-market"],
    discovery: {
      bodyType: "json",
      input: { city: "miami", lastSec: 3600, limit: 5 },
      inputSchema: {
        type: "object",
        required: ["city"],
        properties: {
          city: { type: "string", description: "Kalshi index city id, e.g. miami, nyc, chicago, sf-bay." },
          lastSec: { type: "number", description: "Trailing window in seconds (default 3600, max 604800). Ignored when from/to are given." },
          from: { type: "number", description: "Window start, unix milliseconds (pair with to)." },
          to: { type: "number", description: "Window end, unix milliseconds (pair with from)." },
          detailed: { type: "boolean", description: "Include every member station's reading and QC code on each point." },
          includeCalibrations: { type: "boolean", description: "Also return the city's published calibration timeline (station weights and offsets)." },
          limit: { type: "number", description: "Newest points to return (default 1440, max 10000)." },
        },
      },
      output: {
        example: {
          city: "miami",
          units: "fahrenheit",
          configVersion: "miami-temperature-v1.0-cal-20260914",
          count: 5,
          totalInWindow: 60,
          latest: { time: "2026-09-18T16:22:00.000Z", valueF: 84.2, contributors: 5, status: "normal" },
          minF: 84.2,
          maxF: 85.28,
          points: [{ time: "2026-09-18T16:18:00.000Z", valueF: 85.28, contributors: 5, status: "normal" }],
          source: "kalshi",
        },
      },
    },
    handler: kalshiWeatherIndex,
  },
];

// Test-only exports
export const __test = {
  polyHistoryPoints,
  asNumber,
  polyList,
  parseJsonArray,
  shapeMarket,
  shapeKalshiMarket,
  shapeKalshiLiveData,
  shapeWeatherPoint,
  shapeWeatherCalibration,
  WEATHER_CITIES,
  POLY_GAMMA,
  POLY_CLOB,
  KALSHI,
};
