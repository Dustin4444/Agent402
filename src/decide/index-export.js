// The unified tool index, streamed to the decide service as NDJSON.
//
// The main app owns the catalog and the crawl cache; the decide service owns
// embeddings and ranking. This is the one seam between them: an internal,
// token-gated GET that walks both sources and writes one row per line.
//
// It must never slow a paid call. So it yields to the event loop every
// YIELD_EVERY rows, writes through the socket's backpressure, and refuses a
// second export while one is running (the service pulls on a timer; two at
// once is a retry storm, not a need). Unset DECIDE_INTERNAL_TOKEN = not
// mounted (404), the same "key present = feature on" rule as every rollout.

import { timingSafeEqual } from "node:crypto";
import { localToolRow, remoteToolRow } from "./tool-rows.js";
import { routableRemoteEntries, looksLikeListingInjection, liveProofAt, mppDualStackOrigins } from "../x402-index.js";
import { unpackRequestContract } from "../request-contract.js";

const YIELD_EVERY = 500;
const yieldLoop = () => new Promise((r) => setImmediate(r));

export function decideTokenOk(req, token = process.env.DECIDE_INTERNAL_TOKEN) {
  const want = String(token || "");
  if (want.length < 24) return false;
  const got = String(req.headers?.authorization || "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(got), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Rows for every priced local tool, then every routable outside tool. */
export async function* unifiedRows({ catalog, baseUrl, networks = [], now = Date.now() } = {}) {
  let n = 0;
  for (const def of Object.values(catalog || {})) {
    // The decision tools never recommend themselves.
    if (/^decide(?:-|$)/.test(String(def?.slug || ""))) continue;
    const row = localToolRow(def, { baseUrl, networks, now });
    if (row) yield row;
    if (++n % YIELD_EVERY === 0) await yieldLoop();
  }
  const mppOrigins = new Set(mppDualStackOrigins().map((o) => String(o).replace(/\/+$/, "")));
  for (const [, tools] of routableRemoteEntries({ baseUrl })) {
    for (const t of tools) {
      const row = remoteToolRow(t, {
        requestContract: unpackRequestContract(t),
        injected: looksLikeListingInjection(`${t.name || ""} ${t.description || ""}`),
        lastLiveAt: liveProofAt(t),
        mppOrigins,
      });
      if (row) yield row;
      if (++n % YIELD_EVERY === 0) await yieldLoop();
    }
  }
}

let exporting = false;

/** Express handler for GET /__internal/decide/tools.ndjson */
export function decideIndexExportHandler({ getCatalog, baseUrl, getNetworks }) {
  return async (req, res) => {
    if (!decideTokenOk(req)) return res.status(404).json({ error: "Not found" });
    if (exporting) return res.status(429).set("Retry-After", "60").json({ error: "export already running" });
    exporting = true;
    let rows = 0;
    try {
      res.status(200).set({ "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
      for await (const row of unifiedRows({ catalog: getCatalog(), baseUrl, networks: getNetworks() })) {
        if (res.destroyed) break;
        if (!res.write(JSON.stringify(row) + "\n")) await new Promise((r) => res.once("drain", r));
        rows++;
      }
      res.end(JSON.stringify({ __end: true, rows }) + "\n");
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ error: "export failed" });
      else res.destroy(e);
    } finally {
      exporting = false;
    }
  };
}
