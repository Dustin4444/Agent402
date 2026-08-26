// Model list for OpenClaw, built from the gateway's own GET /v1/models so the
// plugin never carries a hand-typed catalog (a stale id would be a paid 502
// for the user). "auto" is always first: it is the routed tier and the
// recommended primary. Every other entry is an explicit model id with the
// tier's flat per-call price in its display name, because OpenClaw's cost
// fields are per token and Agent402 bills per call - those stay at zero so
// the UI never shows a made-up per-token figure.

export const AUTO_ID = "auto";

/** Linear trailing-slash strip (a regex like /\/+$/ is polynomial on long runs of "/"). */
export function stripTrailingSlashes(s) {
  let str = String(s ?? ""); let end = str.length;
  while (end > 0 && str.charCodeAt(end - 1) === 47) end--;
  return str.slice(0, end);
}


/** The raw catalog entry -> { id, endpoint, tier, priceUsd, maxTokens, maxInputChars }. */
export function routesFromCatalog(catalog) {
  const data = Array.isArray(catalog?.data) ? catalog.data : [];
  const routes = new Map();
  for (const m of data) {
    const x = m?.x402;
    if (!m?.id || !x?.endpoint || typeof x.priceUsd !== "number") continue;
    if (String(m.id).endsWith("*")) continue; // family wildcard, not an id
    routes.set(m.id, {
      id: m.id,
      endpoint: x.endpoint,
      tier: x.tier || null,
      priceUsd: x.priceUsd,
      maxTokens: Number(x.maxTokens) || 1024,
      maxInputChars: Number(x.maxInputChars) || 32_000,
      stealth: !!x.stealth,
    });
  }
  // The routed tier accepts a bare "auto" (model optional); expose it under
  // that id whatever the catalog lists for the tier's own prefixes.
  const autoRow = data.find((m) => m?.x402?.tier === "v1-chat-auto");
  if (autoRow) {
    routes.set(AUTO_ID, {
      id: AUTO_ID, endpoint: autoRow.x402.endpoint, tier: "v1-chat-auto",
      priceUsd: autoRow.x402.priceUsd, maxTokens: Number(autoRow.x402.maxTokens) || 1024,
      maxInputChars: Number(autoRow.x402.maxInputChars) || 32_000, stealth: false,
    });
  }
  return routes;
}

const priceLabel = (usd) => (usd < 0.01 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`);

/** OpenClaw `models[]` entries for a provider block. `auto` first. */
export function openclawModels(routes) {
  const rows = [...routes.values()].filter((r) => !r.stealth);
  rows.sort((a, b) => (a.id === AUTO_ID ? -1 : b.id === AUTO_ID ? 1 : a.priceUsd - b.priceUsd || a.id.localeCompare(b.id)));
  return rows.map((r) => ({
    id: r.id,
    name: r.id === AUTO_ID ? `Agent402 auto (routed, ${priceLabel(r.priceUsd)}/call)` : `${r.id} (${priceLabel(r.priceUsd)}/call)`,
    reasoning: false,
    input: ["text"],
    // Flat per-call billing: OpenClaw's per-token cost display does not apply.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: Math.min(Math.floor(r.maxInputChars / 4), 128_000),
    maxTokens: r.maxTokens,
  }));
}

/** OpenClaw ModelProviderConfig pointing at the local proxy. */
export function providerModelsConfig(baseUrl, routes) {
  return { baseUrl: `${stripTrailingSlashes(baseUrl)}/v1`, api: "openai-completions", models: openclawModels(routes) };
}
