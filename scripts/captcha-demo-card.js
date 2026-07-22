// Announcement demo card for the captcha tools — renders the two real paid
// buys (captcha-generate + captcha-verify) as the standard 1200×630 terminal
// card. Data file assembled from the paid-demo captures. Real output only;
// --preview tags a fixture.
//
// Usage: node scripts/captcha-demo-card.js --from captcha-data.json --out card.png [--preview]
import { readFileSync, writeFileSync } from "node:fs";
import { rasterizeSvg } from "../src/tools/render.js";

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const FROM = arg("--from"), OUT = arg("--out") || "captcha-demo-card.png", PREVIEW = args.includes("--preview");
if (!FROM) { console.error("usage: --from <data.json> --out <png> [--preview]"); process.exit(1); }

const fontB64 = (f) => readFileSync(new URL(`../assets/fonts/${f}`, import.meta.url)).toString("base64");
const FONT_STYLE = `<style>
@font-face{font-family:'Space Mono';font-weight:400;src:url(data:font/woff2;base64,${fontB64("spacemono-400.woff2")}) format('woff2')}
@font-face{font-family:'Space Mono';font-weight:700;src:url(data:font/woff2;base64,${fontB64("spacemono-700.woff2")}) format('woff2')}
</style>`;
const B = { paper:"#EFE8DA", window:"#2B2722", titlebar:"#201D19", inset:"#34302A", insetLine:"#4A453D", text:"#EFE7D2", muted:"#9A917F", green:"#8FC46F", red:"#E8542F", dotRed:"#E0533D", dotAmber:"#E0A33D", dotGray:"#8A857D", mono:"'Space Mono',Consolas,monospace" };
const esc = (s) => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const shortTx = (t) => (t ? `${t.slice(0,10)}…${t.slice(-4)}` : "");

function cardSvg(d) {
  const mono = JSON.stringify(B.mono);
  const okRow = (y, label, detail, arrow) =>
    `<text x="96" y="${y}" font-size="21" font-family=${mono}><tspan font-weight="700" fill="${B.green}">OK</tspan><tspan x="150" font-weight="700" fill="${B.text}">${esc(label)}</tspan><tspan x="300" fill="${B.muted}">${esc(detail)}</tspan><tspan x="740" font-weight="700" fill="${B.text}">→ ${esc(arrow)}</tspan></text>`;
  const insetNote = PREVIEW
    ? `<text x="126" y="500" font-size="16" font-family=${mono} fill="${B.muted}">preview data — final card renders from real buys</text>`
    : `<text x="1074" y="500" font-size="16" font-family=${mono} text-anchor="end" fill="${B.muted}">real output · two paid buys on Base · ${esc(d.date)}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">${FONT_STYLE}
  <rect width="1200" height="630" fill="${B.paper}"/>
  <rect x="36" y="30" width="1128" height="570" rx="18" fill="${B.window}"/>
  <path d="M36 48 a18 18 0 0 1 18 -18 h1092 a18 18 0 0 1 18 18 v34 h-1128 z" fill="${B.titlebar}"/>
  <circle cx="72" cy="61" r="8" fill="${B.dotRed}"/><circle cx="98" cy="61" r="8" fill="${B.dotAmber}"/><circle cx="124" cy="61" r="8" fill="${B.dotGray}"/>
  <text x="152" y="68" font-size="20" font-weight="700" font-family=${mono} fill="${B.text}">no API key · the wallet is the account</text>
  <text x="96" y="130" font-size="22" font-family=${mono}><tspan font-weight="700" fill="${B.text}">Agent402 captcha tools</tspan><tspan fill="${B.muted}"> · run bot protection over x402 · ${esc(d.date)}</tspan></text>
  ${okRow(180, "generate", "mint a challenge for YOUR gate", `$${d.gen.price}, free via PoW`)}
  ${okRow(214, "verify", "Turnstile / reCAPTCHA / hCaptcha", `$${d.ver.price}, no API key`)}
  ${okRow(248, "safety", "secret relayed, never logged", "help protect, never solve")}
  <rect x="96" y="290" width="1008" height="234" rx="12" fill="${B.inset}" stroke="${B.insetLine}" stroke-width="1"/>
  <text x="126" y="326" font-size="19" font-family=${mono}><tspan fill="${B.muted}">$ </tspan><tspan fill="${B.text}">curl agent402.tools/api/captcha-generate</tspan></text>
  <text x="126" y="356" font-size="19" font-family=${mono}><tspan fill="${B.text}">→ </tspan><tspan font-weight="700" fill="${B.text}">"${esc(d.gen.prompt)}"</tspan><tspan fill="${B.muted}"> + salted sha256 answer hash · tx ${esc(shortTx(d.gen.tx))}</tspan></text>
  <text x="126" y="398" font-size="19" font-family=${mono}><tspan fill="${B.muted}">$ </tspan><tspan fill="${B.text}">curl agent402.tools/api/captcha-verify</tspan></text>
  <text x="126" y="428" font-size="19" font-family=${mono}><tspan fill="${B.text}">→ Cloudflare Turnstile · success: </tspan><tspan font-weight="700" fill="${B.green}">${d.ver.success}</tspan><tspan fill="${B.muted}"> · ${esc(d.ver.hostname)} · tx ${esc(shortTx(d.ver.tx))}</tspan></text>
  ${insetNote}
  <text x="96" y="572" font-size="20" font-family=${mono}><tspan fill="${B.muted}">agents asked 5 times · </tspan><tspan font-weight="700" fill="${B.text}">built the honest half, declined the solver</tspan></text>
  <text x="1104" y="572" font-size="20" font-weight="700" font-family=${mono} text-anchor="end" fill="${B.red}">agent402.tools</text>
</svg>`;
}

try {
  const png = await rasterizeSvg(cardSvg(JSON.parse(readFileSync(FROM, "utf8"))), { width: 1200, height: 630 });
  writeFileSync(OUT, png);
  console.log(`wrote ${OUT} (${png.length} bytes)${PREVIEW ? " [preview]" : ""}`);
} catch (e) { console.error(`captcha-demo-card: ${e?.message || e}`); process.exit(2); }
