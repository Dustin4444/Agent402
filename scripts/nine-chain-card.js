// Announcement demo card: ONE tool bought with real money on EVERY rail —
// renders a nine-settlement capture (chain, asset, tx from actual
// scripts/paid-demo.js runs) as the standard 1200×630 terminal-window card
// (reference: a2a-demo-card.js). Two-column receipt grid replaces the usual
// single-result inset. Real numbers only; --preview tags a fixture layout.
//
// Usage:
//   node scripts/nine-chain-card.js --from nine-chain-data.json --out card.png [--preview]
import { readFileSync, writeFileSync } from "node:fs";
import { rasterizeSvg } from "../src/tools/render.js";

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const FROM = arg("--from");
const OUT = arg("--out") || "nine-chain-card.png";
const PREVIEW = args.includes("--preview");
if (!FROM) {
  console.error("usage: node scripts/nine-chain-card.js --from <data.json> --out <png> [--preview]");
  process.exit(1);
}

const fontB64 = (f) => readFileSync(new URL(`../assets/fonts/${f}`, import.meta.url)).toString("base64");
const FONT_STYLE = `<style>
@font-face{font-family:'Space Mono';font-weight:400;src:url(data:font/woff2;base64,${fontB64("spacemono-400.woff2")}) format('woff2')}
@font-face{font-family:'Space Mono';font-weight:700;src:url(data:font/woff2;base64,${fontB64("spacemono-700.woff2")}) format('woff2')}
</style>`;
const B = {
  paper: "#EFE8DA",
  window: "#2B2722",
  titlebar: "#201D19",
  inset: "#34302A",
  insetLine: "#4A453D",
  text: "#EFE7D2",
  muted: "#9A917F",
  green: "#8FC46F",
  red: "#E8542F",
  dotRed: "#E0533D",
  dotAmber: "#E0A33D",
  dotGray: "#8A857D",
  mono: "'Space Mono',Consolas,monospace",
};
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const shortTx = (tx) => (tx.length > 14 ? `${tx.slice(0, 8)}…${tx.slice(-4)}` : tx);

function cardSvg(d) {
  const mono = JSON.stringify(B.mono);
  const settles = d.settles || [];
  const total = (settles.length * d.price).toFixed(3);
  const okRow = (y, label, detail, arrow) =>
    `<text x="96" y="${y}" font-size="21" font-family=${mono}><tspan font-weight="700" fill="${B.green}">OK</tspan><tspan x="150" font-weight="700" fill="${B.text}">${esc(label)}</tspan><tspan x="300" fill="${B.muted}">${esc(detail)}</tspan><tspan x="740" font-weight="700" fill="${B.text}">→ ${esc(arrow)}</tspan></text>`;
  // Two-column receipt grid: 5 rows left, 4 right, 30px pitch.
  const cell = (s, x, y) =>
    `<text x="${x}" y="${y}" font-size="18" font-family=${mono}><tspan font-weight="700" fill="${B.green}">OK</tspan><tspan x="${x + 42}" font-weight="700" fill="${B.text}">${esc(s.chain)}</tspan><tspan x="${x + 180}" fill="${B.muted}">${esc(s.asset)} · tx ${esc(shortTx(s.tx))}</tspan></text>`;
  const rows = settles.map((s, i) => {
    const col = i < 5 ? 0 : 1;
    const x = col === 0 ? 126 : 620;
    const y = 388 + (i % 5) * 30;
    return cell(s, x, y);
  }).join("");
  const insetNote = PREVIEW
    ? `<text x="126" y="546" font-size="16" font-family=${mono} fill="${B.muted}">preview data — final card renders from real buys</text>`
    : `<text x="1074" y="546" font-size="16" font-family=${mono} text-anchor="end" fill="${B.muted}">real output · ${settles.length} settlements · $${total} total · ${esc(d.date)}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">${FONT_STYLE}
  <rect width="1200" height="630" fill="${B.paper}"/>
  <rect x="36" y="30" width="1128" height="570" rx="18" fill="${B.window}"/>
  <path d="M36 48 a18 18 0 0 1 18 -18 h1092 a18 18 0 0 1 18 18 v34 h-1128 z" fill="${B.titlebar}"/>
  <circle cx="72" cy="61" r="8" fill="${B.dotRed}"/><circle cx="98" cy="61" r="8" fill="${B.dotAmber}"/><circle cx="124" cy="61" r="8" fill="${B.dotGray}"/>
  <text x="152" y="68" font-size="20" font-weight="700" font-family=${mono} fill="${B.text}">no API key · the wallet is the account</text>
  <text x="96" y="130" font-size="22" font-family=${mono}><tspan font-weight="700" fill="${B.text}">Agent402 ${esc(d.tool)}</tspan><tspan fill="${B.muted}"> · one tool, nine chains · ${esc(d.date)}</tspan></text>
  ${okRow(180, "tool", "A2A Agent Card discovery", `$${d.price} per call`)}
  ${okRow(214, "pay", "x402, chain of the buyer's choice", "gasless, no signup")}
  ${okRow(248, "proof", "one real buy per rail, same day", "receipts below")}
  <rect x="96" y="278" width="1008" height="290" rx="12" fill="${B.inset}" stroke="${B.insetLine}" stroke-width="1"/>
  <text x="126" y="314" font-size="19" font-family=${mono}><tspan fill="${B.muted}">$ </tspan><tspan fill="${B.text}">curl agent402.tools${esc(d.tool)} -d '{"url":"…"}'</tspan></text>
  <text x="126" y="344" font-size="19" font-family=${mono}><tspan fill="${B.text}">→ HTTP </tspan><tspan font-weight="700" fill="${B.green}">402</tspan><tspan fill="${B.muted}"> · pick any accept · pay + retry → </tspan><tspan font-weight="700" fill="${B.green}">200</tspan><tspan fill="${B.muted}"> · nine times over:</tspan></text>
  ${rows}
  ${insetNote}
  <text x="96" y="590" font-size="20" font-family=${mono}><tspan fill="${B.muted}">500+ tools, priced per call · </tspan><tspan font-weight="700" fill="${B.text}">agents buying from agents</tspan></text>
  <text x="1104" y="590" font-size="20" font-weight="700" font-family=${mono} text-anchor="end" fill="${B.red}">agent402.tools</text>
</svg>`;
}

try {
  const d = JSON.parse(readFileSync(FROM, "utf8"));
  const png = await rasterizeSvg(cardSvg(d), { width: 1200, height: 630 });
  writeFileSync(OUT, png);
  console.log(`wrote ${OUT} (${png.length} bytes)${PREVIEW ? " [preview tag rendered]" : ""}`);
} catch (e) {
  console.error(`nine-chain-card: ${e?.message || e}`);
  process.exit(2);
}
