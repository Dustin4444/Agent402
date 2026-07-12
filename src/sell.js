// /sell — the seller front door. Two paths to get paid per call: list an
// existing x402 API on the open index, or tollbooth an existing site so AI
// crawlers pay to fetch it. See design_handoff_x402_ia_redesign/Sell Hub.dc.html
// for the approved markup this recreates.
//
// Honesty rules (same discipline as market-page.js): every number on this page
// derives from a live snapshot passed in by the caller — never hardcoded, never
// a fabricated zero. A missing/failed snapshot renders the word "unavailable"
// (muted, no link) instead of a fake number. The register form reuses the
// exact id="list-api" markup + inline-script XSS posture from market-page.js
// (fetch → JSON → textContent only, never innerHTML).
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";
import { chainLogoStrip } from "./chain-logos.js";

const REPO = "https://github.com/MikeyPetrillo/Agent402";

const fmtNum = (n) => Number(n || 0).toLocaleString("en-US");
const fmtUsd = (n) =>
  `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Ecosystem-wide totals across every seller the leaderboard snapshot ranks —
// not just Agent402's own revenue. `uniqueBuyers` is summed per-operator (the
// snapshot doesn't retain the raw wallet sets needed to de-duplicate a buyer
// who bought from two different sellers), so a wallet that bought from two
// sellers is counted twice — this is a ceiling, not an exact dedupe — the
// same approximation the homepage already makes with this data
// shape.
function leaderboardTotals(snapshot) {
  const board = Array.isArray(snapshot?.leaderboard) ? snapshot.leaderboard : null;
  // warming (cache not filled yet) or scanSkipped (upstream failure) both mean
  // "we don't actually know" — never render a zero for either. An empty board
  // with neither flag set is a real (if unlikely) zero-revenue snapshot.
  if (!board || snapshot?.warming || snapshot?.scanSkipped) return null;
  return {
    calls: board.reduce((s, r) => s + (Number(r.callsSettled) || 0), 0),
    usd: board.reduce((s, r) => s + (Number(r.totalUsd) || 0), 0),
    buyers: board.reduce((s, r) => s + (Number(r.uniqueBuyers) || 0), 0),
  };
}

function receiptRow(label, value, href, { accent = false } = {}) {
  const valueHtml =
    value == null
      ? `<span style="font-weight:700;color:var(--faint);">unavailable</span>`
      : href
        ? `<a href="${esc(href)}" style="font-weight:700;color:${accent ? "var(--accent)" : "var(--ink)"};text-decoration:none;">${esc(value)}</a>`
        : `<span style="font-weight:700;${accent ? "color:var(--accent);" : ""}">${esc(value)}</span>`;
  return `<div style="display:flex;align-items:baseline;gap:8px;"><span style="color:var(--muted);">${esc(label)}</span><span style="flex:1;border-bottom:1.5px dotted var(--dash);transform:translateY(-4px);"></span>${valueHtml}</div>`;
}

export function sellPage(baseUrl, { leaderboardSnapshot, indexSnapshot } = {}) {
  const totals = leaderboardTotals(leaderboardSnapshot);
  const windowLabel = leaderboardSnapshot?.windowLabel || null;
  const sellersOnIndex = Number.isFinite(indexSnapshot?.totals?.sellers) ? indexSnapshot.totals.sellers : null;

  const demandRowsHtml = [
    receiptRow("calls settled, all sellers", totals ? fmtNum(totals.calls) : null, "/leaderboard"),
    receiptRow("USDC settled", totals ? fmtUsd(totals.usd) : null, "/leaderboard", { accent: true }),
    receiptRow("buyer wallets (per-seller sum)", totals ? fmtNum(totals.buyers) : null, "/leaderboard"),
    receiptRow("sellers on the index", sellersOnIndex != null ? fmtNum(sellersOnIndex) : null, "/index"),
    // "busiest category over 30 days" is intentionally omitted — stats.js has
    // no per-category call breakdown, and a made-up row would violate the
    // "never invented" rule. Add it back once that aggregate exists cheaply.
  ].join("");

  const ctaBuyerLine =
    totals && windowLabel
      ? `${fmtNum(totals.buyers)} wallets bought tools in the last ${esc(windowLabel)}.`
      : "Buyers are already here, settling in USDC right now.";

  const formHtml = `
  <div id="list-api" style="border:1.5px solid var(--ink);border-top:none;background:var(--card);padding:18px 20px;">
    <div style="font-weight:800;font-size:15px;margin-bottom:8px;">List your API</div>
    <div style="display:flex;gap:10px;">
      <input id="reg-origin" type="url" placeholder="https://api.yourdomain.com" style="flex:1;font-family:var(--font-mono);font-size:13px;padding:9px 12px;border:1.5px solid var(--ink);background:var(--paper);color:var(--ink);">
      <button id="reg-go" style="background:var(--surface);color:var(--on-dark);font-family:var(--font-mono);font-weight:700;font-size:13px;border:none;padding:9px 16px;cursor:pointer;">SUBMIT</button>
    </div>
    <div id="reg-out" style="font-family:var(--font-mono);font-size:12.5px;color:var(--muted);margin-top:8px;">Free, no account - we probe your origin's x402 surface and list you if it answers. Unreachable sellers drop out of routing (never off the roster) until they recover.</div>
  </div>
  <script>
  document.getElementById("reg-go").addEventListener("click", async () => {
    const out = document.getElementById("reg-out");
    out.textContent = "probing...";
    try {
      const r = await fetch("/api/index/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ origin: document.getElementById("reg-origin").value }) });
      const j = await r.json();
      out.textContent = j.listed ? ("Listed - " + (j.seller?.displayName || j.origin) + " (" + (j.seller?.toolCount || 0) + " tools). Appears on /index and any chain page it advertises.") : ("Not listed: " + (j.error || "unknown error"));
    } catch { out.textContent = "submission failed - try again"; }
  });
  </script>`;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Service",
    name: "List your API on the Agent402 x402 index",
    serviceType: "x402 API marketplace listing",
    description: "Free listing for x402-speaking APIs on the Agent402 index, plus an open-source tollbooth for gating AI crawlers on any site. Ranking is health-based; Agent402 never takes a cut of settled calls.",
    provider: { "@type": "Organization", name: "Agent402.Tools", url: baseUrl },
    areaServed: "Worldwide",
    audience: { "@type": "Audience", audienceType: "API sellers / developers" },
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: "Free listing on the x402 index, 0% take rate on settled calls" },
    url: `${baseUrl}/sell`,
  };

  const body = `
<!-- HERO -->
<header style="position:relative;overflow:hidden;border-bottom:1.5px solid var(--ink);background-image:repeating-linear-gradient(#0b0b0b0a 0,#0b0b0b0a 1px,transparent 1px,transparent 34px);">
  <div style="position:absolute;right:-20px;top:-40px;font-family:var(--font-body);font-weight:900;font-size:300px;line-height:1;letter-spacing:-.04em;color:transparent;-webkit-text-stroke:2px #0b0b0b12;pointer-events:none;user-select:none;">$</div>
  <div style="max-width:1180px;margin:0 auto;padding:64px 30px 50px;position:relative;">
    <div class="sl-hero" style="display:grid;grid-template-columns:1.1fr .9fr;gap:50px;align-items:start;">
      <div>
        <div style="font-family:var(--font-mono);font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin-bottom:20px;">for api sellers · <span style="color:var(--accent);">x402</span> · non-custodial · no signup</div>
        <h1 class="sl-h1" style="font-family:var(--font-body);font-weight:800;font-size:64px;line-height:.94;letter-spacing:-.035em;margin:0 0 20px;color:var(--ink);">Get paid<br>per call<span style="color:var(--accent);">.</span></h1>
        <p style="font-size:18px;line-height:1.5;color:var(--muted);max-width:520px;margin:0 0 26px;">Agents are spending real USDC on the open x402 web. Two ways to take the other side of the ledger: <strong style="color:var(--ink);font-weight:700;">list your API on the index</strong>, or <strong style="color:var(--ink);font-weight:700;">tollbooth the AI crawlers</strong> already hitting your site. Settlement lands in your wallet - we never touch funds.</p>
        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:11px;margin-bottom:18px;">
          <a href="#list" style="background:var(--accent);color:#fff;font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:13px 20px;box-shadow:4px 4px 0 #0b0b0b22;">LIST YOUR API →</a>
          <a href="#tollbooth" style="background:transparent;border:1.5px solid var(--ink);color:var(--ink);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:12px 20px;">TOLLBOOTH YOUR SITE</a>
        </div>
        <div style="font-family:var(--font-mono);font-size:12.5px;color:var(--faint);">listing is free · ranking is health-based · 0% take on your settlements</div>
      </div>
      <!-- DEMAND RECEIPT -->
      <div style="border:1.5px solid var(--ink);background:var(--card);padding:18px 20px;box-shadow:8px 8px 0 #0b0b0b1f;">
        <div style="display:flex;align-items:center;justify-content:space-between;font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;color:var(--muted);border-bottom:1px dashed var(--dash);padding-bottom:10px;margin-bottom:12px;"><span>·· DEMAND${windowLabel ? ` · LAST ${esc(windowLabel).toUpperCase()}` : ""} ··</span><span style="display:flex;align-items:center;gap:6px;color:var(--accent);"><span style="width:6px;height:6px;border-radius:50%;background:var(--accent);display:inline-block;"></span>LIVE</span></div>
        <div style="display:flex;flex-direction:column;gap:9px;font-family:var(--font-mono);font-size:14px;">
          ${demandRowsHtml}
        </div>
        <div style="margin-top:14px;padding-top:10px;border-top:1px dashed var(--dash);font-family:var(--font-mono);font-size:11px;color:var(--faint);line-height:1.6;">every figure derives from the hourly on-chain snapshot · <a href="/leaderboard" style="color:var(--muted);">verify on /leaderboard →</a></div>
      </div>
    </div>
  </div>
</header>

<!-- SETTLEMENT RAILS — chain logo strip -->
<div style="border-bottom:1.5px solid var(--ink);background:var(--paper);">
  <div style="max-width:1180px;margin:0 auto;padding:0 30px;">
    ${chainLogoStrip({ label: "List once - settle in your wallet on any of these eight networks" })}
  </div>
</div>

<!-- PATH A / LIST -->
<section id="list" style="max-width:1180px;margin:0 auto;padding:74px 30px 0;">
  <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">$ POST /api/index/register</div>
  <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:12px;">
    <h2 style="font-family:var(--font-body);font-weight:800;font-size:44px;line-height:1;letter-spacing:-.02em;margin:0;color:var(--ink);">Path A - list your API.</h2>
    <span style="font-family:var(--font-mono);font-size:12.5px;color:var(--faint);">already speaking x402? you're 60 seconds from listed</span>
  </div>
  <p style="font-size:16px;color:var(--muted);max-width:620px;margin:0 0 30px;">Serve 402 challenges and the crawler does the rest: your tools enter the Smart Order Router next to ours, and the on-chain leaderboard ranks you by real settled volume - not just a line in a directory.</p>
  <div class="ml-2col" style="display:grid;grid-template-columns:1.05fr .95fr;gap:18px;align-items:start;">
    <div>
      <div class="sl-steps" style="display:grid;grid-template-columns:repeat(4,1fr);gap:0;border:1.5px solid var(--ink);background:var(--card);">
        <div style="padding:16px 18px;border-right:1px solid var(--hairline);"><div style="font-family:var(--font-mono);font-size:11px;color:var(--accent);margin-bottom:8px;">01 · SPEAK 402</div><div style="font-size:13px;line-height:1.5;color:var(--muted);">Your API answers with an x402 quote - any chain, any framework.</div></div>
        <div style="padding:16px 18px;border-right:1px solid var(--hairline);"><div style="font-family:var(--font-mono);font-size:11px;color:var(--accent);margin-bottom:8px;">02 · GET CRAWLED</div><div style="font-size:13px;line-height:1.5;color:var(--muted);">Submit your origin (or wait - the Bazaar crawl is hourly).</div></div>
        <div style="padding:16px 18px;border-right:1px solid var(--hairline);"><div style="font-family:var(--font-mono);font-size:11px;color:var(--accent);margin-bottom:8px;">03 · GET ROUTED</div><div style="font-size:13px;line-height:1.5;color:var(--muted);">Healthy sellers enter /api/route results - match, health, price.</div></div>
        <div style="padding:16px 18px;"><div style="font-family:var(--font-mono);font-size:11px;color:var(--accent);margin-bottom:8px;">04 · GET RANKED</div><div style="font-size:13px;line-height:1.5;color:var(--muted);">The leaderboard counts your on-chain settlements. No self-reports.</div></div>
      </div>
      ${formHtml}
    </div>
    <div style="background:var(--surface);border:1.5px solid var(--ink);">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 15px;border-bottom:1px solid var(--dark-border2);font-family:var(--font-mono);font-size:11px;color:var(--dk-muted);letter-spacing:.06em;"><span>how buyers find you</span><span>SH</span></div>
      <pre style="margin:0;padding:18px;font-family:var(--font-mono);font-size:12px;line-height:1.85;color:var(--on-dark);white-space:pre-wrap;word-break:break-word;"><span style="color:var(--dk-muted3);"># a buyer routes a task across every seller
</span><span style="color:var(--accent);">$</span> curl -X POST …/api/route \\
    -d '{"query":"ocr image to text"}'

<span style="color:var(--dk-muted3);"># ranked: match · health · price
</span>{ "seller": <span style="color:var(--on-dark);">"api.yourdomain.com"</span>,
  "tool": "ocr", "price": "$0.004",
  "health": <span style="color:#7dbd97;">"ok"</span>, "rank": 1 }</pre>
      <div style="padding:10px 15px;border-top:1px solid var(--dark-border2);font-family:var(--font-mono);font-size:11px;color:var(--dk-muted3);">the router is free for buyers - discovery shouldn't cost money</div>
    </div>
  </div>
</section>

<!-- PATH B / TOLLBOOTH -->
<section id="tollbooth" style="max-width:1180px;margin:0 auto;padding:74px 30px 0;">
  <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">$ npm i agent402-tollbooth</div>
  <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:12px;">
    <h2 style="font-family:var(--font-body);font-weight:800;font-size:44px;line-height:1;letter-spacing:-.02em;margin:0;color:var(--ink);">Path B - tollbooth your site.</h2>
    <span style="font-family:var(--font-mono);font-size:12.5px;color:var(--faint);">MIT · no CDN lock-in · no Stripe · no merchant-of-record</span>
  </div>
  <p style="font-size:16px;color:var(--muted);max-width:620px;margin:0 0 30px;">Humans browse free. Known AI crawlers get <span style="font-family:var(--font-mono);font-size:14px;">402 Payment Required</span> and pay in USDC over x402 - or solve a free proof-of-work. The open, crypto-native answer to closed pay-per-crawl.</p>
  <div style="border:1.5px solid var(--ink);">
    <div style="padding:22px;background:var(--card);display:flex;flex-direction:column;">
      <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);margin-bottom:14px;">SELF-HOST · FREE FOREVER</div>
      <p style="font-size:14px;line-height:1.5;color:var(--muted);margin:0 0 16px;max-width:640px;">One Web-Crypto core, five deploy shapes: Express middleware, Next.js / Vercel Edge, Cloudflare Worker, reverse proxy, WordPress plugin (beta).</p>
      <pre style="margin:0 0 14px;background:var(--surface);color:var(--on-dark);padding:13px;font-family:var(--font-mono);font-size:11.5px;line-height:1.65;white-space:pre-wrap;word-break:break-word;max-width:640px;"><span style="color:var(--dk-muted3);">// humans pass, bots pay
</span>app.use(tollbooth({
  payTo: "0xYourWallet" }))</pre>
      <a href="/tollbooth" style="font-family:var(--font-mono);font-size:12.5px;color:var(--ink);text-decoration:none;border-bottom:1.5px solid var(--accent);align-self:flex-start;padding-bottom:1px;">tollbooth docs →</a>
    </div>
  </div>
</section>

<!-- SELLER TERMS RECEIPT -->
<section style="max-width:1180px;margin:0 auto;padding:74px 30px 0;">
  <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">$ GET /sell/terms</div>
  <h2 style="font-family:var(--font-body);font-weight:800;font-size:44px;line-height:1;letter-spacing:-.02em;margin:0 0 10px;color:var(--ink);">The deal, in full.</h2>
  <p style="font-size:16px;color:var(--muted);max-width:580px;margin:0 0 30px;">Short enough to read. Nothing is hidden in a PDF.</p>
  <div class="ml-2col" style="display:grid;grid-template-columns:1fr 1fr;gap:18px;">
    <div style="border:1.5px solid var(--ink);background:var(--card);padding:18px 20px;">
      <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;color:var(--muted);border-bottom:1px dashed var(--dash);padding-bottom:10px;margin-bottom:12px;">·· WHAT YOU GET ··</div>
      <div style="display:flex;flex-direction:column;gap:9px;font-family:var(--font-mono);font-size:13.5px;">
        <div style="display:flex;gap:8px;"><span style="color:var(--accent);font-weight:700;">✓</span> Listed on /index + your chain's market pages</div>
        <div style="display:flex;gap:8px;"><span style="color:var(--accent);font-weight:700;">✓</span> Routed by the Smart Order Router when healthy</div>
        <div style="display:flex;gap:8px;"><span style="color:var(--accent);font-weight:700;">✓</span> Ranked on /leaderboard by settled volume</div>
        <div style="display:flex;gap:8px;"><span style="color:var(--accent);font-weight:700;">✓</span> Settlement direct to your wallet, every chain you accept</div>
      </div>
    </div>
    <div style="border:1.5px solid var(--ink);background:var(--card);padding:18px 20px;">
      <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;color:var(--muted);border-bottom:1px dashed var(--dash);padding-bottom:10px;margin-bottom:12px;">·· WHAT WE TAKE ··</div>
      <div style="display:flex;flex-direction:column;gap:9px;font-family:var(--font-mono);font-size:13.5px;">
        <div style="display:flex;align-items:baseline;gap:8px;"><span style="color:var(--muted);">listing fee</span><span style="flex:1;border-bottom:1.5px dotted var(--dash);transform:translateY(-4px);"></span><span style="font-weight:700;">$0</span></div>
        <div style="display:flex;align-items:baseline;gap:8px;"><span style="color:var(--muted);">take rate on your settlements</span><span style="flex:1;border-bottom:1.5px dotted var(--dash);transform:translateY(-4px);"></span><span style="font-weight:700;">0%</span></div>
        <div style="display:flex;align-items:baseline;gap:8px;"><span style="color:var(--muted);">custody of your funds</span><span style="flex:1;border-bottom:1.5px dotted var(--dash);transform:translateY(-4px);"></span><span style="font-weight:700;">never</span></div>
        <div style="display:flex;align-items:baseline;gap:8px;"><span style="color:var(--muted);">ranking favors</span><span style="flex:1;border-bottom:1.5px dotted var(--dash);transform:translateY(-4px);"></span><span style="font-weight:700;">health, not us</span></div>
      </div>
    </div>
  </div>
  <p style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin:14px 0 0;">the router ranks by match, then health, then price - agent402's own tools get no boost; verify in <a href="${esc(REPO)}/blob/main/src/x402-index.js" rel="noopener" style="color:var(--muted);">src/x402-index.js →</a></p>
</section>

<!-- CTA -->
<section style="max-width:1180px;margin:0 auto;padding:64px 30px 64px;">
  <div style="background:var(--surface);padding:52px 44px;position:relative;overflow:hidden;">
    <div style="position:absolute;right:24px;top:-30px;font-family:var(--font-body);font-weight:900;font-size:220px;line-height:1;color:transparent;-webkit-text-stroke:2px #ffffff12;pointer-events:none;">402</div>
    <div style="position:relative;">
      <h2 style="font-family:var(--font-body);font-weight:800;font-size:42px;line-height:1;letter-spacing:-.02em;margin:0 0 14px;color:var(--on-dark2);">The buyers are already here.<br>Take the other side.</h2>
      <p style="font-size:16px;color:var(--dk-muted2);margin:0 0 26px;max-width:480px;">${esc(ctaBuyerLine)} List free, or gate your crawlers - settlement is yours either way.</p>
      <div style="display:flex;gap:11px;flex-wrap:wrap;">
        <a href="#list" style="background:var(--accent);color:#fff;font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:13px 22px;">LIST YOUR API →</a>
        <a href="#tollbooth" style="background:transparent;border:1.5px solid var(--dark-border2);color:var(--on-dark);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:12px 22px;">INSTALL TOLLBOOTH</a>
      </div>
    </div>
  </div>
</section>
${ledgerFooterCompact()}`;

  return ledgerShell({
    title: "Sell on Agent402 - list your x402 API or tollbooth your site",
    description: "List your x402 API on the open index for $0 and 0% take, or install agent402-tollbooth to charge AI crawlers per request. Settlement lands directly in your wallet - non-custodial, no signup.",
    canonical: `${baseUrl}/sell`,
    baseUrl,
    activePath: "/sell",
    jsonLd,
    body,
  });
}
