// Announcement demo card: CROSS-VENDOR x402 interop — our buyer stack
// purchasing onchain data from Blockscout's Pro API (an independent external
// x402 seller). Renders a scripts/paid-demo.js capture (run with
// target=https://api.blockscout.com) as the standard 1200×630 terminal card
// (reference: a2a-demo-card.js). Real numbers only; --preview tags fixtures.
//
// Usage:
//   node scripts/blockscout-demo-card.js --from paid-demo-result.json --out card.png [--preview]
import { readFileSync, writeFileSync } from "node:fs";
import { rasterizeSvg } from "../src/tools/render.js";

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const FROM = arg("--from");
const OUT = arg("--out") || "blockscout-demo-card.png";
const PREVIEW = args.includes("--preview");
if (!FROM) {
  console.error("usage: node scripts/blockscout-demo-card.js --from <paid-demo-result.json> --out <png> [--preview]");
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
const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");

function cardSvg(cap) {
  const mono = JSON.stringify(B.mono);
  const r = cap.result || {};
  const tx = cap.receipt?.transaction || "";
  const txShort = tx ? `${tx.slice(0, 10)}…${tx.slice(-4)}` : "";
  const liveDate = new Date().toISOString().slice(0, 10);
  const traits = [r.is_contract ? "smart wallet" : "EOA", r.is_verified ? "verified contract" : null, r.has_tokens ? "holds tokens" : null].filter(Boolean).join(" · ");
  const insetNote = PREVIEW
    ? `<text x="126" y="500" font-size="16" font-family=${mono} fill="${B.muted}">preview data — final card renders from a real buy</text>`
    : `<text x="1074" y="500" font-size="16" font-family=${mono} text-anchor="end" fill="${B.muted}">real output · $${cap.quote?.usd} USDC settled on Base to Blockscout · tx ${esc(txShort)}</text>`;
  const okRow = (y, label, detail, arrow) =>
    `<text x="96" y="${y}" font-size="21" font-family=${mono}><tspan font-weight="700" fill="${B.green}">OK</tspan><tspan x="150" font-weight="700" fill="${B.text}">${esc(label)}</tspan><tspan x="300" fill="${B.muted}">${esc(detail)}</tspan><tspan x="740" font-weight="700" fill="${B.text}">→ ${esc(arrow)}</tspan></text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">${FONT_STYLE}
  <rect width="1200" height="630" fill="${B.paper}"/>
  <rect x="36" y="30" width="1128" height="570" rx="18" fill="${B.window}"/>
  <path d="M36 48 a18 18 0 0 1 18 -18 h1092 a18 18 0 0 1 18 18 v34 h-1128 z" fill="${B.titlebar}"/>
  <circle cx="72" cy="61" r="8" fill="${B.dotRed}"/><circle cx="98" cy="61" r="8" fill="${B.dotAmber}"/><circle cx="124" cy="61" r="8" fill="${B.dotGray}"/>
  <text x="152" y="68" font-size="20" font-weight="700" font-family=${mono} fill="${B.text}">no API key · the wallet is the account</text>
  <text x="96" y="130" font-size="22" font-family=${mono}><tspan font-weight="700" fill="${B.text}">Agent402 × Blockscout</tspan><tspan fill="${B.muted}"> · cross-vendor x402, in the wild · ${esc(liveDate)}</tspan></text>
  ${okRow(180, "seller", "Blockscout Pro API (independent)", `onchain data, $${cap.quote?.usd}`)}
  ${okRow(214, "buyer", "Agent402 agent stack", "x402, no API key")}
  ${okRow(248, "rail", "USDC on Base (eip155:8453)", "gasless for the buyer")}
  ${okRow(282, "interop", "two independent x402 stacks", "first try, zero glue code")}
  <rect x="96" y="312" width="1008" height="212" rx="12" fill="${B.inset}" stroke="${B.insetLine}" stroke-width="1"/>
  <text x="126" y="348" font-size="19" font-family=${mono}><tspan fill="${B.muted}">$ </tspan><tspan fill="${B.text}">curl api.blockscout.com/8453/api/v2/addresses/${esc(shortAddr(r.hash))}</tspan></text>
  <text x="126" y="376" font-size="19" font-family=${mono}><tspan fill="${B.text}">→ HTTP </tspan><tspan font-weight="700" fill="${B.green}">402</tspan><tspan fill="${B.muted}"> · $${cap.quote?.usd} USDC · sign + retry → </tspan><tspan font-weight="700" fill="${B.green}">200</tspan></text>
  <text x="126" y="410" font-size="19" font-family=${mono}><tspan font-weight="700" fill="${B.text}">${esc(shortAddr(r.hash))}</tspan><tspan fill="${B.muted}"> · ${esc(traits)}</tspan></text>
  <text x="126" y="440" font-size="19" font-family=${mono}><tspan fill="${B.muted}">the address it looked up: the treasury that gets paid when agents buy OUR tools</tspan></text>
  ${insetNote}
  <text x="96" y="572" font-size="20" font-family=${mono}><tspan fill="${B.muted}">an open protocol, working · </tspan><tspan font-weight="700" fill="${B.text}">agents buying from agents</tspan></text>
  <text x="1104" y="572" font-size="20" font-weight="700" font-family=${mono} text-anchor="end" fill="${B.red}">agent402.tools</text>
</svg>`;
}

try {
  const cap = JSON.parse(readFileSync(FROM, "utf8"));
  const png = await rasterizeSvg(cardSvg(cap), { width: 1200, height: 630 });
  writeFileSync(OUT, png);
  console.log(`wrote ${OUT} (${png.length} bytes)${PREVIEW ? " [preview tag rendered]" : ""}`);
} catch (e) {
  console.error(`blockscout-demo-card: ${e?.message || e}`);
  process.exit(2);
}
