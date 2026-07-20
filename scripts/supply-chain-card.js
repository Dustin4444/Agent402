// Announcement demo card: the x402 SUPPLY CHAIN — one buyer purchase, two
// on-chain settlements (buyer → Agent402, Agent402 → Blockscout), data flowing
// back through both hops. Renders a hand-assembled capture JSON (both real tx
// hashes + the returned data summary) as the standard 1200×630 terminal card.
// Real numbers only; --preview tags fixtures.
//
// Usage:
//   node scripts/supply-chain-card.js --from supply-chain-data.json --out card.png [--preview]
import { readFileSync, writeFileSync } from "node:fs";
import { rasterizeSvg } from "../src/tools/render.js";

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const FROM = arg("--from");
const OUT = arg("--out") || "supply-chain-card.png";
const PREVIEW = args.includes("--preview");
if (!FROM) {
  console.error("usage: node scripts/supply-chain-card.js --from <data.json> --out <png> [--preview]");
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
const shortTx = (tx) => (tx ? `${tx.slice(0, 10)}…${tx.slice(-4)}` : "");

function cardSvg(d) {
  const mono = JSON.stringify(B.mono);
  const liveDate = new Date().toISOString().slice(0, 10);
  const insetNote = PREVIEW
    ? `<text x="126" y="500" font-size="16" font-family=${mono} fill="${B.muted}">preview data — final card renders from real settlements</text>`
    : `<text x="1074" y="500" font-size="16" font-family=${mono} text-anchor="end" fill="${B.muted}">real output · two settlements on Base · margin \$${d.marginUsd} per call</text>`;
  const okRow = (y, label, detail, arrow) =>
    `<text x="96" y="${y}" font-size="21" font-family=${mono}><tspan font-weight="700" fill="${B.green}">OK</tspan><tspan x="150" font-weight="700" fill="${B.text}">${esc(label)}</tspan><tspan x="300" fill="${B.muted}">${esc(detail)}</tspan><tspan x="740" font-weight="700" fill="${B.text}">→ ${esc(arrow)}</tspan></text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">${FONT_STYLE}
  <rect width="1200" height="630" fill="${B.paper}"/>
  <rect x="36" y="30" width="1128" height="570" rx="18" fill="${B.window}"/>
  <path d="M36 48 a18 18 0 0 1 18 -18 h1092 a18 18 0 0 1 18 18 v34 h-1128 z" fill="${B.titlebar}"/>
  <circle cx="72" cy="61" r="8" fill="${B.dotRed}"/><circle cx="98" cy="61" r="8" fill="${B.dotAmber}"/><circle cx="124" cy="61" r="8" fill="${B.dotGray}"/>
  <text x="152" y="68" font-size="20" font-weight="700" font-family=${mono} fill="${B.text}">no API key · the wallet is the account</text>
  <text x="96" y="130" font-size="22" font-family=${mono}><tspan font-weight="700" fill="${B.text}">Agent402 /api/address-profile</tspan><tspan fill="${B.muted}"> · an x402 supply chain · ${esc(liveDate)}</tspan></text>
  ${okRow(180, "hop 1", "agent buys from Agent402", `$${d.buyerUsd}, any of 9 chains`)}
  ${okRow(214, "hop 2", "Agent402 buys from Blockscout", `$${d.upstreamUsd}, x402 upstream`)}
  ${okRow(248, "data", `${esc(d.dataLabel)}`, "flows back through both hops")}
  ${okRow(282, "keys", "zero API keys, two vendors", "wallets are the accounts")}
  <rect x="96" y="312" width="1008" height="212" rx="12" fill="${B.inset}" stroke="${B.insetLine}" stroke-width="1"/>
  <text x="126" y="348" font-size="19" font-family=${mono}><tspan fill="${B.muted}">buyer ──$${d.buyerUsd} USDC──▶ </tspan><tspan font-weight="700" fill="${B.text}">agent402.tools</tspan><tspan fill="${B.muted}">  · tx ${esc(shortTx(d.buyerTx))}</tspan></text>
  <text x="126" y="380" font-size="19" font-family=${mono}><tspan fill="${B.muted}">agent402 ──$${d.upstreamUsd} USDC──▶ </tspan><tspan font-weight="700" fill="${B.text}">blockscout</tspan><tspan fill="${B.muted}">  · tx ${esc(shortTx(d.upstreamTx))}</tspan></text>
  <text x="126" y="412" font-size="19" font-family=${mono}><tspan fill="${B.muted}">◀── </tspan><tspan font-weight="700" fill="${B.text}">${esc(d.resultLine)}</tspan></text>
  <text x="126" y="444" font-size="19" font-family=${mono}><tspan fill="${B.muted}">paid on Base · data from Ethereum · marked untrustedContent</tspan></text>
  ${insetNote}
  <text x="96" y="572" font-size="20" font-family=${mono}><tspan fill="${B.muted}">one buy, two settlements · </tspan><tspan font-weight="700" fill="${B.text}">agents buying from agents</tspan></text>
  <text x="1104" y="572" font-size="20" font-weight="700" font-family=${mono} text-anchor="end" fill="${B.red}">agent402.tools</text>
</svg>`;
}

try {
  const d = JSON.parse(readFileSync(FROM, "utf8"));
  const png = await rasterizeSvg(cardSvg(d), { width: 1200, height: 630 });
  writeFileSync(OUT, png);
  console.log(`wrote ${OUT} (${png.length} bytes)${PREVIEW ? " [preview tag rendered]" : ""}`);
} catch (e) {
  console.error(`supply-chain-card: ${e?.message || e}`);
  process.exit(2);
}
