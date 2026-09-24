// Databento client for the equities tools.
//
// Replaces Yahoo Finance, which we had no licence to resell: their developer
// terms forbid deriving income from the API without written permission, the
// endpoint we used was an undocumented internal one, and reaching it meant
// fetching an anti-bot "crumb" and routing around an IP block through a
// relay. Databento is a paid commercial account with a real licence to the
// access itself, so the remaining question is redistribution scope rather
// than whether we may read the data at all.
//
// DBEQ.BASIC is a four-venue consolidation (NYSE Chicago, NYSE National,
// IEX, MIAX Pearl), not the consolidated tape. Prices track the wider market
// closely; VOLUME DOES NOT, because it counts only those venues. Every tool
// here says so in its own output rather than letting a partial figure read as
// a total.
import { assertPublicUrl } from "./fetch-guard.js";

const HOST = "https://hist.databento.com/v0";
export const DATASET = "DBEQ.BASIC";
export const VENUES = "NYSE Chicago, NYSE National, IEX, MIAX Pearl";
// Databento prices are fixed-point integers scaled by 1e9.
const PX = 1e-9;
// A query is priced by uncompressed bytes. Nothing we issue should cost more
// than a fraction of the call's price, so a malformed or over-wide range is
// refused BEFORE it is run rather than discovered on the invoice.
const DEFAULT_MAX_QUERY_USD = Number(process.env.DATABENTO_MAX_QUERY_USD || 0.0002);

const bad = (msg, code = 400) => { const e = new Error(msg); e.statusCode = code; return e; };
const keyOf = () => (process.env.DATABENTO_API_KEY || "").trim();
export const databentoEnabled = () => !!keyOf();

function auth() {
  const k = keyOf();
  if (!k) throw bad("Market data is not configured on this server (DATABENTO_API_KEY unset).", 503);
  return "Basic " + Buffer.from(k + ":").toString("base64");
}

async function post(path, params) {
  const url = `${HOST}/${path}`;
  await assertPublicUrl(url);
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: auth(), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) {
    // Their 4xx bodies name the cause (unknown symbol, range past the data).
    // Relay the CLASS, never the raw body: it can carry query details.
    if (res.status === 422 && /symbol/i.test(text)) throw bad("No market data for that symbol. US equities only - indices, FX and crypto are not covered.");
    if (res.status === 422) throw bad("That date range is outside the available data.");
    if (res.status === 401 || res.status === 403) throw bad("Market data upstream rejected our credentials.", 503);
    throw bad(`Market data upstream returned ${res.status}.`, 502);
  }
  return text;
}

async function get(path, params) {
  const url = `${HOST}/${path}?${new URLSearchParams(params)}`;
  await assertPublicUrl(url);
  const res = await fetch(url, { headers: { authorization: auth() }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw bad(`Market data upstream returned ${res.status}.`, 502);
  return res.json();
}

/** Last session the dataset actually holds. Asking for "today" 422s on a
 *  weekend or whenever the feed lags, so every range is bounded by this. */
let rangeCache = { at: 0, end: null };
export async function availableEnd() {
  if (Date.now() - rangeCache.at < 15 * 60_000 && rangeCache.end) return rangeCache.end;
  const r = await get("metadata.get_dataset_range", { dataset: DATASET });
  const end = String(r.end ?? r.end_date ?? "").slice(0, 10);
  if (!end) throw bad("Market data upstream did not report its available range.", 502);
  rangeCache = { at: Date.now(), end };
  return end;
}

/** Price the query first and refuse anything unexpectedly large. */
async function assertAffordable(params, maxUsd = DEFAULT_MAX_QUERY_USD) {
  try {
    const usd = Number(await post("metadata.get_cost", { ...params, mode: "historical" }));
    if (Number.isFinite(usd) && usd > maxUsd) {
      throw bad(`That request is wider than this endpoint serves. Narrow the range.`);
    }
  } catch (e) {
    if (e?.statusCode === 400) throw e;      // our own refusal, keep it
    /* pricing unavailable is not a reason to fail the call */
  }
}

export async function dailyBars({ symbol, start, end, maxUsd }) {
  const params = { dataset: DATASET, symbols: String(symbol).toUpperCase(), schema: "ohlcv-1d", start, end };
  await assertAffordable(params, maxUsd);
  const text = await post("timeseries.get_range", { ...params, encoding: "json" });
  const rows = text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  if (!rows.length) throw bad("No market data for that symbol in that range. US equities only.");
  return consolidate(rows);
}

/** DBEQ.BASIC returns ONE BAR PER VENUE. A quote consolidates them: the day's
 *  high/low are the extremes across venues, volume is their sum (and is
 *  therefore venue-partial), and open/close come from the venue that traded
 *  the most that session - a thin venue's print is not the day's close. */
export function consolidate(rows) {
  const byDay = new Map();
  for (const r of rows) {
    const day = new Date(Number(r.hd.ts_event) / 1e6).toISOString().slice(0, 10);
    const g = byDay.get(day) || { day, high: -Infinity, low: Infinity, venueVolume: 0, best: null };
    g.high = Math.max(g.high, Number(r.high) * PX);
    g.low = Math.min(g.low, Number(r.low) * PX);
    g.venueVolume += Number(r.volume);
    if (!g.best || Number(r.volume) > Number(g.best.volume)) g.best = r;
    byDay.set(day, g);
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)).map((g) => ({
    day: g.day,
    open: round(Number(g.best.open) * PX), high: round(g.high),
    low: round(g.low), close: round(Number(g.best.close) * PX),
    venueVolume: g.venueVolume,
  }));
}
const round = (n) => Number(n.toFixed(4));
