// Tempo/MPP seller catalog for the Smart Order Router's external leg - the
// MPP counterpart of algorand-sellers.js. Candidates come from OUR OWN MPP
// index (src/mpp-index.js): sellers we have live-verified with an unpaid
// probe that returned a genuine WWW-Authenticate: Payment challenge, carrying
// the mpp.dev registry's per-endpoint payment metadata (method, currency,
// amount in base units). Same shape out as the other legs: url/method/price/
// networks, ranked lexically against the task, cap-filtered.
//
// What is deliberately NOT routable here:
//   - endpoints with dynamic pricing (`payment.dynamic` / no integer amount) -
//     the router's cap must be checkable BEFORE we sign; payTempo re-checks
//     the live 402 anyway, but a task should not resolve to an endpoint whose
//     price we cannot state up front;
//   - path templates (`/:network/v2`) - nothing to fill them with;
//   - anything not tempo/charge in USDC.e - the spending wallet's asset pin.
// Proven-ness (recent inbound USDC.e transfers to the challenge's recipient)
// is checked at PAY time in tempo-buyer.js, because the recipient is only
// known from the live 402, not from the registry.
import { mppIndexSnapshot } from "./mpp-index.js";
import { TEMPO_USDC, TEMPO_CAIP2 } from "./tempo-buyer.js";

const USDC_LC = TEMPO_USDC.toLowerCase();
const tokenize = (s) => String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);

/** Flatten the verified MPP index into routable resources. Pure; injectable
 *  snapshot for tests. */
export function tempoCatalog(snapshot = mppIndexSnapshot()) {
  const out = [];
  for (const s of snapshot?.sellers || []) {
    if (!s?.verified) continue;
    const origin = String(s.serviceUrl || s.origin || "").replace(/\/$/, "");
    if (!/^https:\/\//.test(origin)) continue;
    for (const e of s.endpoints || []) {
      const p = e?.payment;
      if (!p || p.method !== "tempo" || (p.intent && p.intent !== "charge")) continue;
      if (String(p.currency || "").toLowerCase() !== USDC_LC) continue;
      if (p.dynamic) continue;
      if (typeof e.path !== "string" || !e.path.startsWith("/") || /[:{*]/.test(e.path)) continue;
      const amount = String(p.amount || "");
      if (!/^\d+$/.test(amount) || amount === "0") continue;
      const decimals = Number.isInteger(p.decimals) ? p.decimals : 6;
      const priceUsd = Number(amount) / 10 ** decimals;
      out.push({
        origin, seller: s.name || origin.replace(/^https:\/\//, ""),
        path: e.path, method: String(e.method || "GET").toUpperCase(),
        url: origin + e.path,
        description: [e.description, s.description].filter(Boolean).join(" - "),
        tags: [...(s.tags || []), ...(s.categories || [])],
        priceUsd, priceAtomic: amount,
        networks: [TEMPO_CAIP2],
        wire: "mpp",
      });
    }
  }
  return out;
}

/** Rank routable resources against a task - same lexical scoring as the
 *  Algorand leg (task tokens vs description/path/tags), cap-filtered. */
export function rankTempoResources(resources, task, { capUsd, excludeOrigin = "" } = {}) {
  const want = [...new Set(tokenize(task))];
  if (!want.length) return [];
  const scored = [];
  for (const r of resources) {
    if (!(r.priceUsd > 0 && r.priceUsd <= capUsd)) continue;
    if (excludeOrigin && r.origin === excludeOrigin) continue;
    const have = new Set([...tokenize(r.description), ...tokenize((r.tags || []).join(" ")), ...tokenize(r.seller)]);
    const pathTokens = tokenize(r.path);
    let score = 0;
    for (const t of want) {
      if (have.has(t) || pathTokens.includes(t)) score += 1;
      else if (t.length > 3 && pathTokens.some((p) => p.includes(t))) score += 1;
    }
    if (score > 0) scored.push({ ...r, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.priceUsd - b.priceUsd);
}
