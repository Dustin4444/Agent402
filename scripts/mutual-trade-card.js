// Announcement demo card: MUTUAL AGENT-TO-AGENT TRADE — two independent x402
// shops buying from each other on the same chain, both settlements real and
// on-chain. Standard 1200×630 terminal card. Real numbers only.
//
// Usage: node scripts/mutual-trade-card.js --from data.json --out card.png
import { readFileSync, writeFileSync } from "node:fs";
import { rasterizeSvg } from "../src/tools/render.js";

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const FROM = arg("--from");
const OUT = arg("--out") || "mutual-trade-card.png";
if (!FROM) { console.error("usage: node scripts/mutual-trade-card.js --from <data.json> --out <png>"); process.exit(1); }

const fontB64 = (f) => readFileSync(new URL(`../assets/fonts/${f}`, import.meta.url)).toString("base64");
const FONT_STYLE = `<style>
@font-face{font-family:'Space Mono';font-weight:400;src:url(data:font/woff2;base64,${fontB64("spacemono-400.woff2")}) format('woff2')}
@font-face{font-family:'Space Mono';font-weight:700;src:url(data:font/woff2;base64,${fontB64("spacemono-700.woff2")}) format('woff2')}
</style>`;
const B = {
  paper: "#EFE8DA", window: "#2B2722", titlebar: "#201D19", inset: "#34302A", insetLine: "#4A453D",
  text: "#EFE7D2", muted: "#9A917F", green: "#8FC46F", red: "#E8542F",
  dotRed: "#E0533D", dotAmber: "#E0A33D", dotGray: "#8A857D", mono: "'Space Mono',Consolas,monospace",
};
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const shortTx = (tx) => (tx ? `${tx.slice(0, 10)}…${tx.slice(-4)}` : "");

function cardSvg(d) {
  const mono = JSON.stringify(B.mono);
  const okRow = (y, label, detail, arrow) =>
    `<text x="96" y="${y}" font-size="21" font-family=${mono}><tspan font-weight="700" fill="${B.green}">OK</tspan><tspan x="150" font-weight="700" fill="${B.text}">${esc(label)}</tspan><tspan x="310" fill="${B.muted}">${esc(detail)}</tspan><tspan x="800" font-weight="700" fill="${B.text}">→ ${esc(arrow)}</tspan></text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">${FONT_STYLE}
  <rect width="1200" height="630" fill="${B.paper}"/>
  <rect x="36" y="30" width="1128" height="570" rx="18" fill="${B.window}"/>
  <path d="M36 48 a18 18 0 0 1 18 -18 h1092 a18 18 0 0 1 18 18 v34 h-1128 z" fill="${B.titlebar}"/>
  <circle cx="72" cy="61" r="8" fill="${B.dotRed}"/><circle cx="98" cy="61" r="8" fill="${B.dotAmber}"/><circle cx="124" cy="61" r="8" fill="${B.dotGray}"/>
  <text x="152" y="68" font-size="20" font-weight="700" font-family=${mono} fill="${B.text}">two independent sellers · one open economy · settled both ways</text>
  <text x="96" y="130" font-size="22" font-family=${mono}><tspan font-weight="700" fill="${B.text}">agent402.tools &lt;-&gt; ${esc(d.peerName)}</tspan><tspan fill="${B.muted}"> · agent-to-agent trade on ${esc(d.chainLabel)}</tspan></text>
  ${okRow(180, "they buy", `${esc(d.inTool)} from our catalog`, `settled ${esc(d.inDate)}`)}
  ${okRow(214, "we debug", "4 interop bugs, both stacks", "fixed in public")}
  ${okRow(248, "we buy", `${esc(d.outTool)} from their API`, `settled ${esc(d.outDate)}`)}
  ${okRow(282, "loop", "closed in both directions", "zero humans involved")}
  <rect x="96" y="312" width="1008" height="212" rx="12" fill="${B.inset}" stroke="${B.insetLine}" stroke-width="1"/>
  <text x="126" y="350" font-size="19" font-family=${mono}><tspan fill="${B.muted}">${esc(d.peerShort)} ──$${d.inUsd} USDC──▶ </tspan><tspan font-weight="700" fill="${B.text}">agent402.tools</tspan><tspan fill="${B.muted}">  · tx ${esc(shortTx(d.inTx))}</tspan></text>
  <text x="126" y="384" font-size="19" font-family=${mono}><tspan fill="${B.muted}">agent402 ──$${d.outUsd} USDC──▶ </tspan><tspan font-weight="700" fill="${B.text}">${esc(d.peerHost)}</tspan><tspan fill="${B.muted}">  · tx ${esc(shortTx(d.outTx))}</tspan></text>
  <text x="126" y="418" font-size="19" font-family=${mono}><tspan fill="${B.muted}">◀── both settlements on ${esc(d.chainLabel)} mainnet · verifiable in any explorer</tspan></text>
  <text x="126" y="452" font-size="19" font-family=${mono}><tspan fill="${B.muted}">no contracts, no sales calls, no API keys · the payment IS the relationship</tspan></text>
  <text x="1074" y="500" font-size="16" font-family=${mono} text-anchor="end" fill="${B.muted}">real settlements · found each other through the open x402 catalog</text>
  <text x="96" y="572" font-size="20" font-family=${mono}><tspan fill="${B.muted}">the agent economy, </tspan><tspan font-weight="700" fill="${B.text}">trading with itself</tspan></text>
  <text x="1104" y="572" font-size="20" font-weight="700" font-family=${mono} text-anchor="end" fill="${B.red}">agent402.tools/algorand</text>
</svg>`;
}

try {
  const d = JSON.parse(readFileSync(FROM, "utf8"));
  const png = await rasterizeSvg(cardSvg(d), { width: 1200, height: 630 });
  writeFileSync(OUT, png);
  console.log(`wrote ${OUT} (${png.length} bytes)`);
} catch (e) {
  console.error(`mutual-trade-card: ${e?.message || e}`);
  process.exit(2);
}
