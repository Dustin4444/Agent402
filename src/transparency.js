// Transparency — public disclosures around the project, with on-chain receipts.
// First entry: the community-launched $AGENT402 token on Robinhood Chain
// (launched by a community member, not the team). Every factual claim on this
// page links to an immutable on-chain record so readers verify, not trust.
import { ledgerShell, ledgerFooterCompact } from "./ledger-chrome.js";

const TOKEN_CA = "0x380344a48378df060EB24fF6B8Acb511E14B8BA3";
const LAUNCHER = "0x7cC76f7c351e341b50FA60012b4ABC886868A945";
const CLAIM_WALLET = "0x6bf262e27ac17e8fa4416bd5d01cc7fb7715775e";
const CREATION_TX = "0x6cf72dd5caf166c2a5c595b100b3a4ca51e0453489caa1636820bc2313e23c50";
const CLAIM_TX = "0xf843a85897343ba1888760ecf07398b99d73d4acb4aee84b4c35ef8411d43605";
const SCOUT = "https://robinhoodchain.blockscout.com";

// GitHub adoption numbers for the "who is taking the code" section. The
// traffic API needs push-level access, so this is env-gated on
// GITHUB_TRAFFIC_TOKEN (a fine-grained PAT with repository Administration
// read, or a classic repo-scope token); unset or under-scoped, the getter
// returns null and the section is simply omitted - never an error, never a
// fabricated zero. 1h cache; GitHub's window is a rolling 14 days.
let trafficCache = { at: 0, data: null };
export async function repoTraffic() {
  const token = (process.env.GITHUB_TRAFFIC_TOKEN || "").trim();
  if (!token) return null;
  const now = Date.now();
  if (now - trafficCache.at < 3600_000) return trafficCache.data;
  try {
    const hdrs = { Authorization: `Bearer ${token}`, "User-Agent": "agent402-transparency" };
    const [c, v] = await Promise.all([
      fetch("https://api.github.com/repos/MikeyPetrillo/Agent402/traffic/clones", { headers: hdrs, signal: AbortSignal.timeout(10000) }),
      fetch("https://api.github.com/repos/MikeyPetrillo/Agent402/traffic/views", { headers: hdrs, signal: AbortSignal.timeout(10000) }),
    ]);
    if (!c.ok || !v.ok) throw new Error(`traffic ${c.status}/${v.status}`);
    const cj = await c.json(); const vj = await v.json();
    trafficCache = { at: now, data: {
      clones: cj.count, uniqueCloners: cj.uniques,
      views: vj.count, uniqueVisitors: vj.uniques,
      asOf: new Date(now).toISOString().slice(0, 10),
    } };
  } catch (e) {
    console.warn(`[transparency] repo traffic unavailable: ${String(e?.message || e).slice(0, 80)}`);
    trafficCache = { at: now, data: trafficCache.data }; // keep stale rather than flap
  }
  return trafficCache.data;
}

export function transparencyPage(baseUrl, traffic = null) {
  const title = "Transparency - Agent402";
  const description =
    "Public disclosures with on-chain receipts: the community-launched $AGENT402 token on Robinhood Chain, the contract address, the claiming wallet, and our commitments.";
  const canonical = `${baseUrl}/transparency`;

  const extraCss = `
.tp-wrap{max-width:760px;margin:0 auto;padding:56px 30px}
.tp-eyebrow{font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:18px}
.tp-h1{font-family:var(--font-body);font-weight:800;font-size:58px;line-height:.96;letter-spacing:-.03em;margin:0 0 14px}
.tp-updated{font-family:var(--font-mono);font-size:13px;color:var(--faint);margin:0 0 32px}
.tp-body p,.tp-body li{font-size:15px;line-height:1.55;color:var(--muted)}
.tp-body p{margin:0 0 14px}
.tp-body ul{margin:0 0 18px;padding:0 0 0 22px}
.tp-body li{margin-bottom:8px}
.tp-body h2{font-family:var(--font-body);font-weight:800;font-size:34px;line-height:1;letter-spacing:-.02em;margin:36px 0 14px;color:var(--ink)}
.tp-body h3{font-family:var(--font-body);font-weight:800;font-size:22px;letter-spacing:-.01em;margin:28px 0 10px;color:var(--ink)}
.tp-body a{color:var(--accent);text-decoration:none}
.tp-body a:hover{text-decoration:underline}
.tp-body b,.tp-body strong{color:var(--ink);font-weight:600}
.tp-body code{font-family:var(--font-mono);font-size:13px;background:var(--surface);color:var(--on-dark);padding:2px 7px;border:1.5px solid var(--ink)}
.tp-ca{font-family:var(--font-mono);font-size:14px;word-break:break-all;background:var(--surface);color:var(--on-dark);border:1.5px solid var(--ink);padding:14px 16px;margin:0 0 8px}
.tp-ca-label{font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin:18px 0 6px}
.tp-receipts{width:100%;border-collapse:collapse;margin:14px 0 22px;font-family:var(--font-mono);font-size:12.5px}
.tp-receipts th{text-align:left;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);font-weight:600;padding:6px 10px 6px 0;border-bottom:1.5px solid var(--ink)}
.tp-receipts td{padding:8px 10px 8px 0;border-bottom:1px solid var(--hairline);color:var(--muted);vertical-align:top}
.tp-receipts td a{word-break:break-all}
.tp-note{border:1.5px solid var(--ink);background:var(--card-bg,transparent);padding:16px 18px;margin:22px 0}
.tp-note p{margin:0}
.tp-fold{border:1.5px solid var(--hairline);background:var(--card);padding:14px 18px;margin:0 0 26px}
.tp-fold summary{cursor:pointer;font-weight:700;font-size:15px;color:var(--ink)}
.tp-fold[open]{padding-bottom:20px}
.tp-fold h3{font-size:19px !important;margin:22px 0 8px !important}
@media(max-width:600px){.tp-h1{font-size:36px !important}}
`;

  const body = `
<div class="tp-wrap">
<div class="tp-eyebrow">$ GET /transparency</div>
<h1 class="tp-h1">Transparency</h1>
<p class="tp-updated">Agent402 (agent402.tools) · last updated 2026-07-29.</p>

<div class="tp-body">
<p>Agent402.Tools is an <a href="https://github.com/MikeyPetrillo/Agent402" rel="noopener">open-source</a> x402 + MCP
tool server. When something material happens around the project, on-chain or off, it gets documented
here, with receipts a reader can verify independently. Nothing on this page asks for trust; every factual
claim links to an immutable on-chain record.</p>

${traffic ? `<h2>GitHub adoption</h2>
<p>The code is AGPL and anyone may clone it without forking - and they do. From GitHub's traffic API
(rolling 14-day window, refreshed hourly, as of ${traffic.asOf}):</p>
<ul>
<li><b>${Number(traffic.uniqueCloners).toLocaleString()} unique cloners</b> made ${Number(traffic.clones).toLocaleString()} clones of the repository.</li>
<li>${Number(traffic.uniqueVisitors).toLocaleString()} unique visitors viewed the repository ${Number(traffic.views).toLocaleString()} times.</li>
</ul>
<p>Honest caveat: clone counts include CI systems and crawlers, so the unique-cloner figure is the
steadier signal, and none of these numbers identify anyone - GitHub reports counts only. The license
terms that travel with every clone are in the
<a href="https://github.com/MikeyPetrillo/Agent402/blob/main/LICENSE" rel="noopener">AGPL-3.0 license</a>:
run a modified copy as a network service and you must publish your source.</p>` : ""}

<details class="tp-fold">
<summary><strong>A community member independently launched a token using the project's name ($AGENT402, on Robinhood Chain). It was not created, issued, endorsed, or controlled by Agent402.</strong> Full record and on-chain receipts - click to expand.</summary>
<h3>The community-launched $AGENT402 token (Robinhood Chain)</h3>

<p>On <strong>2026-07-07</strong>, a community member with <strong>no relation to the Agent402.Tools team</strong>
launched an ERC-20 token named <code>AGENT402</code> on Robinhood Chain using
<a href="https://bankr.bot" rel="noopener">Bankr</a>'s token-launch infrastructure, in the spirit of this project.
The Agent402.Tools team did not create, commission, request, or endorse this token. We did not discover
that it existed, or that this launch capability existed on Bankr at all, until <strong>2026-07-14</strong>.</p>

<div class="tp-ca-label">Contract address (created by the community, not by the Agent402.Tools team)</div>
<div class="tp-ca">${TOKEN_CA}</div>
<p style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin:0 0 18px">Verify, don't trust:
<a href="${SCOUT}/token/${TOKEN_CA}" rel="noopener">token on Blockscout</a> ·
<a href="${SCOUT}/tx/${CREATION_TX}" rel="noopener">creation transaction</a> ·
launched by <a href="${SCOUT}/address/${LAUNCHER}" rel="noopener">${LAUNCHER.slice(0, 10)}…${LAUNCHER.slice(-4)}</a></p>

<h3>The fee claim (one-time viability test)</h3>

<p>Bankr's launch mechanics designate a fee recipient, and because the token was pointed at this project,
accrued trading fees became claimable by a project wallet. At the time we reviewed it, the token had
accrued roughly <strong>$17 in trading fees (0.0101 WETH)</strong> plus a token allocation of about
81.48M AGENT402.</p>

<p>On <strong>2026-07-15</strong>, as a one-time test to determine whether the claim mechanism was viable,
we executed the claim function. It worked: both amounts moved into the claiming wallet in a single
transaction, linked below.</p>

<h3>Full-transparency wallet view</h3>

<p>Every movement of these funds, past and future, is publicly auditable. This is the claiming wallet,
and these are the receipts:</p>

<table class="tp-receipts">
<tr><th>What</th><th>Record</th></tr>
<tr><td>Claiming wallet</td><td><a href="${SCOUT}/address/${CLAIM_WALLET}" rel="noopener">${CLAIM_WALLET}</a></td></tr>
<tr><td>All token movements</td><td><a href="${SCOUT}/address/${CLAIM_WALLET}?tab=token_transfers" rel="noopener">Blockscout token-transfer history</a></td></tr>
<tr><td>Claim transaction (2026-07-15)</td><td><a href="${SCOUT}/tx/${CLAIM_TX}" rel="noopener">${CLAIM_TX.slice(0, 18)}…</a></td></tr>
<tr><td>Token creation (2026-07-07)</td><td><a href="${SCOUT}/tx/${CREATION_TX}" rel="noopener">${CREATION_TX.slice(0, 18)}…</a></td></tr>
</table>

<h3>Where we stand</h3>

<ul>
  <li><strong>A personal side project.</strong> Agent402.Tools is a fun, personal side project, built and
  operated on the maintainer's own time with his own resources. It has <strong>no relation to, and is not
  affiliated with, sponsored by, or endorsed by, the maintainer's employer</strong> or any place of employment.
  Nothing about this project, including the token described here, represents anyone but the project itself.</li>
  <li><strong>Not an official token.</strong> $AGENT402 is not a product of Agent402.Tools or Havok Holdings LLC.
  We have <strong>no roadmap, no expectations, and no commitments</strong> regarding the token or any use of it.</li>
  <li><strong>Our role: equal member, not owner.</strong> We support this community initiative and participate
  in it as <strong>an equal member of the community, nothing more</strong>. We do not own, operate, or control
  the token, its liquidity, or its market, and we claim no authority over what the community does with it.</li>
  <li><strong>No expectation of growth.</strong> There should be <strong>no expectation of token growth</strong>,
  in price, liquidity, adoption, or anything else. The token's market activity is entirely community-driven
  and outside our control.</li>
  <li><strong>Not investment advice.</strong> Nothing on this page is an offer, endorsement, or recommendation.
  Do not purchase the token with any expectation of profit, utility, or effort from the Agent402.Tools team.</li>
  <li><strong>Why we acknowledged it publicly.</strong> We spoke about the token
  <a href="https://x.com/Agent402Tools/status/2077408766652195025" rel="noopener">on X</a> for two reasons:
  we want to support other builders experimenting with agentic-commerce infrastructure, and we did not want
  a confusing or negative narrative to form if people found a token profile resembling agent402.tools that
  carried the wrong logo, the wrong description, or the wrong idea of what this product is about.
  Acknowledging it and publishing this page keeps the record straight.</li>
  <li><strong>Why this page exists.</strong> We publish this to support and protect our users: to make what
  happened independently verifiable, and to leave no room for impersonation or misinformation.</li>
  <li><strong>Our focus is unchanged.</strong> The project remains about the x402 payment protocol and building
  curated, deterministic tools that serve agents.</li>
</ul>

<div class="tp-note">
<p><strong>Fee-proceeds commitment.</strong> If at any time we claim fees arising from trading of this token,
<strong>all proceeds will be used to accelerate and continue advancing x402 and this project's original
mission</strong>. The claiming wallet above makes that commitment auditable: anyone can watch where every
claimed unit goes.</p>
</div>

<h3>Possible future experiments</h3>

<p>We leave this deliberately open-ended: as a member of the community, we may at any given time help
explore utilities around the token. One example: testing whether a portion of x402 tool purchases could
automatically flow into it. Anything of that kind would be an <strong>experiment</strong>: tested first,
subject to change, and possibly discontinued at any time without notice. This is <strong>not the project's
main purpose</strong>, and nothing we try, announce, or ship should create any expectation of further
development, token growth, or value. If an experiment does move funds, it will be visible from the claiming
wallet above.</p>
</details>

<h2>Questions</h2>
<p>Contact <a href="https://x.com/Agent402Tools" rel="noopener">@Agent402Tools on X</a> for further details.</p>
</div>
</div>
${ledgerFooterCompact()}`;

  return ledgerShell({ title, description, canonical, baseUrl, activePath: "/transparency", extraCss, body });
}
