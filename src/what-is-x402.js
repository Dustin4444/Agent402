// /what-is-x402 — the plain-English explainer. Written for executives and
// people outside the crypto industry: no protocol jargon, no chain names in
// the narrative, an interactive step-through of one payment, and an honest
// executive FAQ. The technical audience gets routed to /guides instead.
import { ledgerShell, ledgerFooterCompact } from "./ledger-chrome.js";

export function whatIsX402Page(baseUrl) {
  const canonical = `${baseUrl}/what-is-x402`;
  const title = "What is x402? The internet's pay-per-use button, explained for humans";
  const description =
    "x402 lets software pay for what it uses the moment it uses it - pennies per request, no signups, no subscriptions, no invoices. The plain-English explainer: what it is, how a payment works (interactive), what 'agents paying agents' means, and why it matters for your business.";

  const extraCss = `
.wx-wrap{max-width:880px;margin:0 auto;padding:56px 30px}
.wx-eyebrow{font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:18px;text-transform:uppercase;letter-spacing:.08em}
.wx-title{font-family:var(--font-body);font-weight:800;font-size:56px;line-height:.98;letter-spacing:-.03em;margin:0 0 14px}
.wx-sub{font-size:17px;line-height:1.6;color:var(--muted);margin:0 0 44px;max-width:660px}
.wx-h2{font-family:var(--font-body);font-weight:800;font-size:30px;letter-spacing:-.02em;margin:52px 0 14px}
.wx-p{font-size:16px;line-height:1.65;color:var(--muted);margin:0 0 14px;max-width:680px}
.wx-p strong{color:var(--ink)}
.wx-callout{border:1.5px solid var(--ink);background:var(--card);padding:18px 22px;margin:20px 0;max-width:680px;font-size:15.5px;line-height:1.6;color:var(--muted)}
.wx-callout strong{color:var(--ink)}

/* simulator terminal */
.wx-sim{border:2px solid var(--ink);background:var(--surface);color:var(--on-dark);margin:26px 0 10px;font-family:var(--font-mono)}
.wx-sim-bar{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1.5px solid var(--dark-border2)}
.wx-dot{width:10px;height:10px;border-radius:50%}
.wx-sim-title{font-size:12px;color:var(--dk-muted2);margin-left:6px}
.wx-stage{display:flex;justify-content:space-between;gap:12px;padding:22px 18px 6px}
.wx-actor{flex:1;border:1.5px dashed var(--dark-border2);padding:10px 12px;text-align:center;font-size:12px;color:var(--dk-muted2)}
.wx-actor b{display:block;color:var(--on-dark);font-size:13px;margin-bottom:2px}
.wx-actor.lit{border-color:var(--accent-lit);border-style:solid}
.wx-actor.lit b{color:var(--accent-lit)}
.wx-wire{flex:0 0 34%;display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--dk-muted)}
.wx-log{padding:14px 18px 6px;min-height:150px}
.wx-line{font-size:13px;line-height:1.75;opacity:0;transform:translateY(4px);transition:opacity .35s ease,transform .35s ease}
.wx-line.show{opacity:1;transform:none}
.wx-line .who{color:var(--dk-muted)}
.wx-line .ok{color:#7ec98f}
.wx-line .price{color:var(--accent-lit);font-weight:700}
.wx-receipt{border-top:1.5px dashed var(--dark-border2);margin:8px 18px 0;padding:10px 0 14px;font-size:12px;color:var(--dk-muted2);display:none}
.wx-receipt.show{display:block}
.wx-receipt b{color:var(--on-dark)}
.wx-controls{display:flex;align-items:center;gap:10px;padding:0 18px 16px}
.wx-btn{background:transparent;border:1.5px solid var(--cream);color:var(--on-dark);font-family:var(--font-mono);font-size:13px;padding:7px 18px;cursor:pointer}
.wx-btn:hover{background:var(--cream);color:var(--ink)}
.wx-btn.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:700}
.wx-btn.primary:hover{filter:brightness(1.1)}
.wx-dots{display:flex;gap:6px;margin-left:auto}
.wx-sdot{width:8px;height:8px;border-radius:50%;background:var(--dark-border2)}
.wx-sdot.on{background:var(--accent-lit)}
.wx-simcap{font-size:13px;color:var(--faint);margin:0 0 8px}

/* story receipt */
.wx-real{border:1.5px solid var(--ink);background:var(--card);padding:20px 22px;margin:20px 0;max-width:680px}
.wx-real-h{font-family:var(--font-mono);font-size:12px;color:var(--accent);text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px}
.wx-real-row{display:flex;justify-content:space-between;gap:12px;font-family:var(--font-mono);font-size:13.5px;line-height:2;color:var(--muted);border-bottom:1px dashed var(--dash)}
.wx-real-row:last-child{border-bottom:none}
.wx-real-row b{color:var(--ink)}

/* why cards */
.wx-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:22px 0}
.wx-card{border:1.5px solid var(--ink);background:var(--card);padding:18px}
.wx-card h4{font-family:var(--font-body);font-weight:800;font-size:17px;margin:0 0 8px}
.wx-card p{font-size:14px;line-height:1.55;color:var(--muted);margin:0}
@media (max-width:760px){.wx-cards{grid-template-columns:1fr}.wx-title{font-size:40px}.wx-stage{flex-direction:column}.wx-wire{display:none}}

/* faq */
.wx-faq{max-width:680px}
.wx-faq details{border:1.5px solid var(--ink);background:var(--card);margin-bottom:10px}
.wx-faq summary{cursor:pointer;padding:14px 18px;font-weight:700;font-size:15.5px;list-style:none;display:flex;justify-content:space-between;align-items:center}
.wx-faq summary::after{content:"+";font-family:var(--font-mono);color:var(--accent);font-size:18px}
.wx-faq details[open] summary::after{content:"\\2212"}
.wx-faq .a{padding:0 18px 16px;font-size:15px;line-height:1.6;color:var(--muted)}

.wx-cta{display:flex;gap:12px;flex-wrap:wrap;margin:34px 0 10px}
.wx-cta a{font-family:var(--font-mono);font-size:14px;text-decoration:none;border:1.5px solid var(--ink);padding:11px 20px;color:var(--ink)}
.wx-cta a.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:700}
`;

  const faqs = [
    {
      q: "Is this a cryptocurrency investment thing?",
      a: "No. Payments settle in USDC, a “digital dollar”: one USDC is one dollar, in and out. Nothing here is bought in the hope it goes up. x402 uses that digital dollar the way the web uses email — as infrastructure. The blockchain underneath is simply the settlement network that lets a one-cent payment clear in about two seconds for a fraction of a cent in cost, which card networks cannot do.",
    },
    {
      q: "What does “agents paying agents” actually mean?",
      a: "An AI agent is software that does a multi-step job on its own — research a company, monitor a market, process documents. Mid-job it constantly needs things it doesn't have: a stock quote, a web search, a page rendered. Today that means a human pre-registering for every vendor API. With x402, the agent just buys each piece the moment it needs it, for pennies, from whichever service answers best — including services run by other companies' agents. Software hiring software, with real money, no humans in the loop.",
    },
    {
      q: "Who is behind x402? Is this a startup's proprietary thing?",
      a: "x402 is an open protocol, not a product. It was created at Coinbase in 2025, and builds on a part of the web's own standard that has been reserved since 1997: HTTP status code 402, “Payment Required.” Anyone can implement it — our implementation is open source — and an ecosystem of independent sellers, marketplaces, and infrastructure providers is growing around it.",
    },
    {
      q: "What does it cost to use?",
      a: "Whatever the thing you're buying costs — typically fractions of a cent to a few cents per request — plus essentially zero payment overhead. No subscriptions, no minimums, no invoices, no chargebacks. A buyer who makes one call pays for one call.",
    },
    {
      q: "What happens if a service takes the money and fails?",
      a: "Payment and delivery are tied together at the protocol level: settlement completes only when a successful response is returned. If the service errors, the buyer is not charged. That guarantee is enforced by the payment flow itself, not by a refund department.",
    },
  ];

  const faqLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };
  const articleLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: title,
    description,
    url: canonical,
    author: { "@type": "Organization", name: "Agent402.Tools", url: baseUrl },
    publisher: { "@type": "Organization", name: "Agent402.Tools", url: baseUrl },
  };

  const body = `<div class="wx-wrap">
  <div class="wx-eyebrow">Plain-English explainer</div>
  <h1 class="wx-title">What is x402?</h1>
  <p class="wx-sub">x402 gives the internet a <strong>pay-per-use button</strong>: software can buy exactly what it needs, the moment it needs it, for pennies &mdash; with no signups, no subscriptions, and no invoices. Here's the whole idea in three minutes, no crypto background required.</p>

  <h2 class="wx-h2">The 30-second version</h2>
  <p class="wx-p">Everything useful on the internet sits behind a gate. To use a data service today, someone has to create an account, verify an email, enter a credit card, agree to a monthly plan, and manage an API key &mdash; fine for a person, <strong>impossible for software acting on its own</strong>.</p>
  <p class="wx-p">That matters now because more and more work is done by <strong>AI agents</strong>: software that completes multi-step jobs without a human driving every click. An agent halfway through a task can't fill in a signup form or wait for procurement to approve a vendor.</p>
  <p class="wx-p">x402 removes the gate. When software asks a paid service for something, the service answers with a <strong>price tag</strong> instead of a login screen. The software pays it &mdash; usually a fraction of a cent &mdash; and gets the result. The whole exchange takes about two seconds.</p>
  <div class="wx-callout"><strong>The name:</strong> the web's rulebook has included status code <strong>402 &mdash; “Payment Required”</strong> since 1997, reserved for a future where the internet could handle payments natively. It sat unused for nearly three decades. x402 is that future, switched on.</div>

  <h2 class="wx-h2">Watch one payment happen</h2>
  <p class="wx-simcap">This is the entire protocol &mdash; four moves. Step through it:</p>
  <div class="wx-sim" id="wxsim">
    <div class="wx-sim-bar"><span class="wx-dot" style="background:#E0533D"></span><span class="wx-dot" style="background:#E0A33D"></span><span class="wx-dot" style="background:#8A857D"></span><span class="wx-sim-title">one x402 purchase &mdash; live sequence</span></div>
    <div class="wx-stage">
      <div class="wx-actor" id="wxa1"><b>YOUR AGENT</b>software with a wallet</div>
      <div class="wx-wire" id="wxwire">&nbsp;</div>
      <div class="wx-actor" id="wxa2"><b>A PAID SERVICE</b>data &middot; search &middot; anything</div>
    </div>
    <div class="wx-log" id="wxlog">
      <div class="wx-line"><span class="who">agent &rarr; service:</span> “What's the current price of NVDA?”</div>
      <div class="wx-line"><span class="who">service &rarr; agent:</span> <span class="price">402 Payment Required &middot; this answer costs $0.003</span></div>
      <div class="wx-line"><span class="who">agent &rarr; service:</span> same question + a signed 0.3&cent; payment <span class="who">(like tap-to-pay)</span></div>
      <div class="wx-line"><span class="who">service &rarr; agent:</span> <span class="ok">200 OK</span> &middot; “NVDA: $182.41” &middot; payment settled on-chain</div>
    </div>
    <div class="wx-receipt" id="wxrcpt">RECEIPT &middot; paid <b>$0.003</b> &middot; received <b>1 answer</b> &middot; time <b>~2 seconds</b> &middot; accounts created <b>0</b> &middot; invoices <b>0</b></div>
    <div class="wx-controls">
      <button class="wx-btn primary" id="wxnext">Next step</button>
      <button class="wx-btn" id="wxreplay">Replay</button>
      <div class="wx-dots"><span class="wx-sdot" id="wxd0"></span><span class="wx-sdot" id="wxd1"></span><span class="wx-sdot" id="wxd2"></span><span class="wx-sdot" id="wxd3"></span></div>
    </div>
  </div>
  <p class="wx-p" style="font-size:14px;color:var(--faint)">No account existed before this exchange and none exists after. The payment itself is the identity, the authorization, and the receipt.</p>

  <h2 class="wx-h2">“Agents paying agents” &mdash; the part that sounds like science fiction</h2>
  <p class="wx-p">Once software can buy things, software can <strong>hire</strong> things. An agent working on “research this company” can buy a stock quote from one vendor, a news search from another, and a document analysis from a third &mdash; three sellers, three payments of a few cents, zero business development.</p>
  <p class="wx-p">It goes one layer further: an agent can pay <em>another agent</em> to do the choosing. This is a real purchase that ran through our marketplace router:</p>
  <div class="wx-real">
    <div class="wx-real-h">An actual receipt &mdash; agents paying agents, on-chain</div>
    <div class="wx-real-row"><span>A buyer's agent asked our router for DeFi market data</span><b>paid us $0.55</b></div>
    <div class="wx-real-row"><span>Our router picked the best proven seller (a firm we've never spoken to) and bought it</span><b>we paid them $0.01</b></div>
    <div class="wx-real-row"><span>Data delivered back to the buyer, both payments settled in the same 3-second window</span><b>2 settlements</b></div>
    <div class="wx-real-row"><span>Humans involved at any step</span><b>0</b></div>
  </div>
  <p class="wx-p">Every hop was real money with a public, verifiable record. Nobody exchanged contracts, sales calls, or API keys. <strong>That</strong> is the agent economy: services discovering, vetting, and paying each other at machine speed.</p>

  <h2 class="wx-h2">Why this matters for your business</h2>
  <div class="wx-cards">
    <div class="wx-card"><h4>A new kind of customer</h4><p>Millions of AI agents are coming online that cannot fill in a signup form &mdash; but can pay. If your data or service is x402-enabled, they can become customers with no sales motion at all.</p></div>
    <div class="wx-card"><h4>Meter anything</h4><p>Anything you can serve over the web can be priced per use &mdash; a lookup for a tenth of a cent, a report for a dollar &mdash; without building billing, subscriptions, or collections.</p></div>
    <div class="wx-card"><h4>Radically less friction</h4><p>Settlement is final in seconds, refund-proof by design (no delivery, no charge), and global from day one. No chargebacks, no net-30, no dunning emails.</p></div>
  </div>

  <h2 class="wx-h2">Executive FAQ</h2>
  <div class="wx-faq">
    ${faqs.map((f) => `<details><summary>${f.q}</summary><div class="a">${f.a}</div></details>`).join("\n    ")}
  </div>

  <h2 class="wx-h2">See it for real</h2>
  <p class="wx-p">Everything above runs live on this site: 500+ services priced in pennies, a public marketplace of independent sellers, and revenue you can verify on-chain.</p>
  <div class="wx-cta">
    <a class="primary" href="/marketplace">Browse the live marketplace</a>
    <a href="/guides/x402-in-5-minutes">The 5-minute technical version</a>
    <a href="/guides/smart-order-router">How the router works</a>
    <a href="mailto:mike@agent402.tools">Talk to us</a>
  </div>
</div>
<script>
(function(){
  var lines=[].slice.call(document.querySelectorAll("#wxlog .wx-line"));
  var dots=[0,1,2,3].map(function(i){return document.getElementById("wxd"+i)});
  var a1=document.getElementById("wxa1"),a2=document.getElementById("wxa2");
  var rcpt=document.getElementById("wxrcpt"),next=document.getElementById("wxnext"),replay=document.getElementById("wxreplay");
  var step=-1;
  function render(){
    lines.forEach(function(l,i){l.classList.toggle("show",i<=step)});
    dots.forEach(function(d,i){d.classList.toggle("on",i<=step)});
    a1.classList.toggle("lit",step===0||step===2);
    a2.classList.toggle("lit",step===1||step===3);
    rcpt.classList.toggle("show",step>=3);
    next.textContent=step>=3?"Done — that's the whole protocol":"Next step";
    next.disabled=step>=3;
  }
  next.addEventListener("click",function(){if(step<3){step++;render();}});
  replay.addEventListener("click",function(){step=-1;render();var t=0,iv=setInterval(function(){if(step>=3){clearInterval(iv);return;}step++;render();},900);});
  render();
})();
</script>`;

  return ledgerShell({
    title,
    description,
    canonical,
    baseUrl,
    activePath: "/what-is-x402",
    jsonLd: [articleLd, faqLd],
    extraCss,
    body: body + ledgerFooterCompact(),
  });
}
