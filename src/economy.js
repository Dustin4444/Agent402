// x402 ecosystem summary metrics — derived from the same leaderboard
// snapshot the on-chain crawler already maintains. Zero new infra: the
// hourly Bazaar+Base USDC scan in src/leaderboard.js feeds this.
//
// The standalone /economy page this module once rendered folded into
// /index's "The economy, over time" section (id="economy") — /economy now
// 301s there. What remains here is the derivation (`summarize`) and the
// formatting helpers the moved section reuses; the state-of-the-ecosystem
// angle (concentration, network split) lives on inside that section.
//
// We deliberately do not name competing sellers anywhere in user-facing
// copy. Rank is enough.

export const fmtUsd = (n) => {
  const v = Number(n) || 0;
  if (v >= 1000) return `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  if (v >= 0.01) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(4)}`;
};

export const fmtPct = (n) => `${(Number(n) || 0).toFixed(1)}%`;

// Compute summary metrics off the ranked leaderboard array. Pure data
// transformation; no side effects.
// `sortMode` controls the lens — "usd" measures concentration of revenue,
// "calls" measures concentration of activity. Totals are sort-agnostic.
export function summarize(rows, sortMode = "usd") {
  const total = rows.reduce((s, r) => s + (r.totalUsd || 0), 0);
  const totalCalls = rows.reduce((s, r) => s + (r.callsSettled || 0), 0);
  const activeSellers = rows.filter((r) => r.callsSettled > 0).length;
  const avgCallUsd = totalCalls > 0 ? total / totalCalls : 0;

  // HHI-style concentration in the *chosen* metric: when the page is showing
  // "top-10 sellers by calls", the top-N share answers "what % of all calls
  // do those top sellers serve?" — coherent with the displayed ranking. Same
  // when sortMode === "usd" (the original behaviour).
  const metric = sortMode === "calls" ? "callsSettled" : "totalUsd";
  const denom = sortMode === "calls" ? totalCalls : total;
  const sorted = [...rows].sort((a, b) => (b[metric] || 0) - (a[metric] || 0));
  const sumTop = (n) => sorted.slice(0, n).reduce((s, r) => s + (r[metric] || 0), 0);
  const top1Share = denom > 0 ? (sumTop(1) / denom) * 100 : 0;
  const top5Share = denom > 0 ? (sumTop(5) / denom) * 100 : 0;
  const top10Share = denom > 0 ? (sumTop(10) / denom) * 100 : 0;

  // Network split — how much of the volume settles on each chain.
  const byNet = new Map();
  for (const r of rows) {
    const net = r.network || "unknown";
    byNet.set(net, (byNet.get(net) || 0) + (r.totalUsd || 0));
  }
  const networks = [...byNet.entries()]
    .map(([net, usd]) => ({ net, usd, share: total > 0 ? (usd / total) * 100 : 0 }))
    .sort((a, b) => b.usd - a.usd);

  // Find Agent402's row by canonical host so we can show "our share"
  // without naming anyone else. If we're not yet on the board (cold start)
  // this is null and the section just hides.
  const ourRow = rows.find(
    (r) => /agent402/i.test(r.homepage || "") || /agent402/i.test(r.name || "")
  );

  return {
    total,
    totalCalls,
    activeSellers,
    avgCallUsd,
    top1Share,
    top5Share,
    top10Share,
    networks,
    ourRow,
    top10: sorted.slice(0, 10),
  };
}
