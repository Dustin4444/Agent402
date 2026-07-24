// Announcement demo card: MPP DUAL-STACK — the same catalog answering both
// payment dialects (x402 and MPP) from one URL, with the two real native-wire
// settlements (Base + Celo) from the paid canary. Standard 1200×630 terminal
// card. Real numbers only.
//
// Usage: node scripts/mpp-dual-stack-card.js --from data.json --out card.png
import { readFileSync, writeFileSync } from "node:fs";
import { rasterizeSvg } from "../src/tools/render.js";

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const FROM = arg("--from");
const OUT = arg("--out") || "mpp-dual-stack-card.png";
if (!FROM) { console.error("usage: node scripts/mpp-dual-stack-card.js --from <data.json> --out <png>"); process.exit(1); }

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
    `<text x="96" y="${y}" font-size="21" font-family=${mono}><tspan font-weight="700" fill="${B.green}">OK</tspan><tspan x="150" font-weight="700" fill="${B.text}">${esc(label)}</tspan><tspan x="310" fill="${B.muted}">${esc(detail)}</tspan><tspan x="826" font-weight="700" fill="${B.text}">→ ${esc(arrow)}</tspan></text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">${FONT_STYLE}
  <rect width="1200" height="630" fill="${B.paper}"/>
  <rect x="36" y="30" width="1128" height="570" rx="18" fill="${B.window}"/>
  <path d="M36 48 a18 18 0 0 1 18 -18 h1092 a18 18 0 0 1 18 18 v34 h-1128 z" fill="${B.titlebar}"/>
  <circle cx="72" cy="61" r="8" fill="${B.dotRed}"/><circle cx="98" cy="61" r="8" fill="${B.dotAmber}"/><circle cx="124" cy="61" r="8" fill="${B.dotGray}"/>
  <text x="152" y="68" font-size="20" font-weight="700" font-family=${mono} fill="${B.text}">one URL · two payment protocols · same on-chain settlement</text>
  <text x="96" y="130" font-size="22" font-family=${mono}><tspan font-weight="700" fill="${B.text}">agent402.tools now speaks MPP</tspan><tspan fill="${B.muted}"> · dual-stack with x402, every endpoint</tspan></text>
  ${okRow(180, "402", "one challenge, both dialects offered", "x402 + MPP")}
  ${okRow(214, "sign", "stock mppx client, EIP-3009 USDC", "Authorization: Payment")}
  ${okRow(248, "settle", `$${d.baseUsd} USDC on Base`, `tx ${shortTx(d.baseTx)}`)}
  ${okRow(282, "settle", `$${d.celoUsd} USDC on Celo`, `tx ${shortTx(d.celoTx)}`)}
  <rect x="96" y="312" width="1008" height="212" rx="12" fill="${B.inset}" stroke="${B.insetLine}" stroke-width="1"/>
  <text x="126" y="350" font-size="19" font-family=${mono}><tspan fill="${B.muted}">mpp client  ──Authorization: Payment──▶ </tspan><tspan font-weight="700" fill="${B.text}">agent402.tools</tspan><tspan fill="${B.muted}"> · signed Payment-Receipt back</tspan></text>
  <text x="126" y="384" font-size="19" font-family=${mono}><tspan fill="${B.muted}">x402 client ──PAYMENT-SIGNATURE──────▶ </tspan><tspan font-weight="700" fill="${B.text}">agent402.tools</tspan><tspan fill="${B.muted}"> · same price, same treasury</tspan></text>
  <text x="126" y="418" font-size="19" font-family=${mono}><tspan fill="${B.muted}">◀── both wires settle the identical EIP-3009 USDC authorization on-chain</tspan></text>
  <text x="126" y="452" font-size="19" font-family=${mono}><tspan fill="${B.muted}">${esc(d.endpoints)} endpoints registered on MPPScan · verifiable in any explorer</tspan></text>
  <text x="1074" y="500" font-size="16" font-family=${mono} text-anchor="end" fill="${B.muted}">real settlements from the daily paid canary · no staged demos</text>
  <text x="96" y="572" font-size="20" font-family=${mono}><tspan fill="${B.muted}">two dialects, </tspan><tspan font-weight="700" fill="${B.text}">one payment</tspan></text>
  <text x="1104" y="572" font-size="20" font-weight="700" font-family=${mono} text-anchor="end" fill="${B.red}">agent402.tools/what-is-x402</text>
</svg>`;
}

try {
  const d = JSON.parse(readFileSync(FROM, "utf8"));
  const png = await rasterizeSvg(cardSvg(d), { width: 1200, height: 630 });
  writeFileSync(OUT, png);
  console.log(`wrote ${OUT} (${png.length} bytes)`);
} catch (e) {
  console.error(`mpp-dual-stack-card: ${e?.message || e}`);
  process.exit(2);
}
