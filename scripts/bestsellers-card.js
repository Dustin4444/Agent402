// Announcement demo card for the bestsellers tool — renders the tool's actual
// JSON response as a 1200×630 brand card (same ledger system as the served
// /card.png and /tools/:slug/card.png: paper, white card, ink border, 402
// badge, Archivo display + Space Mono, committed first-party fonts).
//
// The standing announcement flow wants REAL numbers: render the FINAL card
// from live prod output after the deploy, never from mocked data. A layout
// preview from fixture data must carry the on-card "preview data" tag
// (--preview) so it can never be mistaken for the real render.
//
// Usage:
//   node scripts/bestsellers-card.js --from response.json --out card.png
//   node scripts/bestsellers-card.js --from https://… --out card.png
//   node scripts/bestsellers-card.js --from fixture.json --out card.png --preview
//
// --from accepts a file path or URL returning the /api/bestsellers JSON
// (the endpoint is paid — capture the JSON once via the buyer SDK or canary,
// then render from the file). Exit 1 on usage errors, 2 on fetch/render.
import { readFileSync, writeFileSync } from "node:fs";
import { rasterizeSvg } from "../src/tools/render.js";

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const FROM = arg("--from");
const OUT = arg("--out") || "bestsellers-card.png";
const PREVIEW = args.includes("--preview");
if (!FROM) {
  console.error("usage: node scripts/bestsellers-card.js --from <file|url> --out <png> [--preview]");
  process.exit(1);
}

const fontB64 = (f) => readFileSync(new URL(`../assets/fonts/${f}`, import.meta.url)).toString("base64");
const FONT_STYLE = `<style>
@font-face{font-family:'Space Mono';font-weight:400;src:url(data:font/woff2;base64,${fontB64("spacemono-400.woff2")}) format('woff2')}
@font-face{font-family:'Space Mono';font-weight:700;src:url(data:font/woff2;base64,${fontB64("spacemono-700.woff2")}) format('woff2')}
@font-face{font-family:'Archivo';font-weight:800;src:url(data:font/woff2;base64,${fontB64("archivo-800.woff2")}) format('woff2')}
</style>`;
// Same tokens as server.js BRAND — the card must be indistinguishable from the
// served brand surfaces.
const B = { paper: "#F5F5F5", card: "#FFFFFF", ink: "#0b0b0b", muted: "#4A4A4A", hairline: "#E0E0DE", accent: "#D63C1A", mono: "'Space Mono',Consolas,monospace", display: "'Archivo',system-ui,sans-serif" };
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function loadJson(from) {
  if (/^https?:\/\//.test(from)) {
    const res = await fetch(from, { signal: AbortSignal.timeout(20000) });
    if (res.status === 402) throw new Error("endpoint is paid (402) — capture the JSON once via the buyer SDK or paid canary, then render with --from <file>");
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    return await res.json();
  }
  return JSON.parse(readFileSync(from, "utf8"));
}

function cardSvg(data) {
  const mono = JSON.stringify(B.mono);
  const display = JSON.stringify(B.display);
  const rows = (data.bestsellers || []).slice(0, 4);
  const trendColor = (t) => (t === "rising" || t === "new" ? B.accent : B.muted);
  const rowSvg = rows
    .map((r, i) => {
      const y = 340 + i * 36;
      const buyers = r.buyers === 1 ? "1 buyer" : `${r.buyers} buyers`;
      const sales = r.sales === 1 ? "1 sale" : `${r.sales} sales`;
      return `<text x="84" y="${y}" font-size="22" font-family=${mono} fill="${B.ink}"><tspan font-weight="700" fill="${B.accent}">#${r.rank}</tspan> ${esc(r.slug)} <tspan fill="${B.muted}">· ${sales} · ${buyers} ·</tspan> <tspan font-weight="700" fill="${trendColor(r.trend)}">${esc(r.trend)}</tspan></text>`;
    })
    .join("");
  const empty = rows.length
    ? ""
    : `<text x="84" y="340" font-size="22" font-family=${mono} fill="${B.muted}">ledger warming — every external paid call lands here by name</text>`;
  const windowLabel = `last ${data.days ?? 30} days · ranked by distinct paying wallets`;
  // Rides the windowLabel baseline, right-aligned — clear of the headline and
  // the footer block at every row count.
  const previewTag = PREVIEW
    ? `<text x="1116" y="${340 + Math.max(rows.length, 1) * 36}" font-size="16" font-family=${mono} text-anchor="end" fill="${B.muted}">preview data — final card renders from live output</text>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">${FONT_STYLE}
  <rect width="1200" height="630" fill="${B.paper}"/>
  <rect x="36" y="36" width="1128" height="558" fill="${B.card}" stroke="${B.ink}" stroke-width="3"/>
  <rect x="84" y="84" width="64" height="64" fill="none" stroke="${B.ink}" stroke-width="5"/>
  <text x="116" y="126" font-size="26" font-weight="700" font-family=${mono} text-anchor="middle" fill="${B.ink}">402</text>
  <text x="170" y="118" font-size="26" font-weight="800" font-family=${display} fill="${B.ink}">AGENT402<tspan fill="${B.accent}">.</tspan>TOOLS</text>
  <text x="170" y="146" font-size="20" font-family=${mono} fill="${B.muted}">new tool · market intelligence</text>
  <text x="1116" y="127" font-size="24" font-weight="700" font-family=${mono} text-anchor="end" fill="${B.accent}">agent402.tools</text>
  <line x1="84" y1="172" x2="1116" y2="172" stroke="${B.ink}" stroke-width="2.5"/>
  <text x="84" y="248" font-size="54" font-weight="800" font-family=${display} letter-spacing="-1" fill="${B.ink}">What agents actually buy<tspan fill="${B.accent}">.</tspan></text>
  <text x="84" y="296" font-size="24" font-weight="700" font-family=${mono} fill="${B.accent}">$ GET /api/bestsellers?sort=buyers</text>
  ${rowSvg}${empty}
  <text x="84" y="${340 + Math.max(rows.length, 1) * 36}" font-size="18" font-family=${mono} fill="${B.muted}">${esc(windowLabel)}</text>
  <line x1="84" y1="500" x2="1116" y2="500" stroke="${B.hairline}" stroke-width="2"/>
  <text x="84" y="546" font-size="27" font-weight="700" font-family=${mono} fill="${B.accent}">$0.005 per call · x402 · USDC on 8 chains</text>
  <text x="84" y="582" font-size="21" font-family=${mono} fill="${B.muted}">Which tool was bought never reaches the chain · raw feed free at /api/sales</text>
  ${previewTag}
</svg>`;
}

try {
  const data = await loadJson(FROM);
  const png = await rasterizeSvg(cardSvg(data), { width: 1200, height: 630 });
  writeFileSync(OUT, png);
  console.log(`wrote ${OUT} (${png.length} bytes)${PREVIEW ? " [preview tag rendered]" : ""}`);
  process.exit(0); // render.js keeps its shared browser alive — exit explicitly
} catch (e) {
  console.error(`card render failed: ${e.message}`);
  process.exit(2);
}
