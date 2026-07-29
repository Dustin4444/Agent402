// /what-is-mpp — the Machine Payments Protocol explainer. The search target is
// the full phrase "machine payments protocol" (the bare acronym is owned by
// Medicare and public-policy degrees), so the page leads with an extractable
// entity-first definition — the 2-3 sentence shape answer engines lift — and
// stays factual about the protocol's draft status. The x402 comparison links
// back to /what-is-x402, which stays the broader executive explainer.
import { ledgerShell, ledgerFooterCompact } from "./ledger-chrome.js";

export function whatIsMppPage(baseUrl) {
  const canonical = `${baseUrl}/what-is-mpp`;
  const title = "What is MPP? The Machine Payments Protocol, explained";
  const description =
    "MPP (Machine Payments Protocol) is an IETF-track standard that carries pay-per-request payments through HTTP's native authentication headers: a 402 response challenges with WWW-Authenticate: Payment, the client pays via Authorization: Payment, and a signed Payment-Receipt confirms settlement. What it is, how a payment works, how it compares to x402, and where it is live today.";

  const faqs = [
    {
      q: "What is the Machine Payments Protocol (MPP)?",
      a: "MPP is an open, IETF-track protocol that lets software pay for web services per request using HTTP's standard authentication mechanism. A paid endpoint answers an unpaid request with status 402 and a WWW-Authenticate: Payment challenge naming a price; the client answers with a signed stablecoin payment in an Authorization: Payment header; the server verifies it, settles on-chain, and returns the result with a signed Payment-Receipt header. No account, API key, or subscription is involved.",
    },
    {
      q: "How is MPP different from x402?",
      a: "They are two dialects of the same idea - pay-per-request over HTTP 402, settled in stablecoins. x402 (from Coinbase) carries payment terms in a PAYMENT-REQUIRED header and the payment in an X-PAYMENT header; MPP carries the same handshake through the web's standard auth headers (WWW-Authenticate / Authorization, the mechanism defined in RFC 9110), which makes it a natural fit for the IETF standards track. A server can speak both from the same URL at the same price, and dual-stack servers exist today.",
    },
    {
      q: "Is MPP a finished standard?",
      a: "It is IETF-track and in active development - the 'Payment' HTTP authentication scheme is documented at paymentauth.org with the reference implementation in the tempoxyz/mpp repository. Live services accept MPP payments on mainnet today, so the wire format is real and settling, but as with any draft-stage protocol, details can still evolve.",
    },
    {
      q: "Where can I see MPP working right now?",
      a: "Every paid endpoint on Agent402.Tools is dual-stack: the same 402 response carries both an x402 offer and a WWW-Authenticate: Payment challenge, a stock mppx client works unmodified, and settled responses return a signed Payment-Receipt. A real purchase settles over the native MPP wire daily as part of the service's paid canary, so the claim is continuously re-proven, not a demo that worked once.",
    },
    {
      q: "How do I accept MPP payments on my own API?",
      a: "If you already speak x402, a translation layer can add MPP without touching settlement: answer 402s with an additional WWW-Authenticate: Payment challenge derived from your existing offer, and re-encode inbound Authorization: Payment credentials into your existing verification path. Agent402's implementation of exactly that pattern is open source (AGPL) in its server repository, and the mppx tooling in tempoxyz/mpp provides the client and codec primitives.",
    },
  ];

  const articleLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: title,
    description,
    author: { "@type": "Organization", name: "Agent402.Tools", url: baseUrl },
    mainEntityOfPage: canonical,
  };
  const faqLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };

  const extraCss = `
.wm-wrap{max-width:880px;margin:0 auto;padding:56px 30px}
.wm-eyebrow{font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:18px;text-transform:uppercase;letter-spacing:.08em}
.wm-title{font-family:var(--font-body);font-weight:800;font-size:50px;line-height:.98;letter-spacing:-.03em;margin:0 0 14px}
.wm-sub{font-size:17px;line-height:1.6;color:var(--muted);margin:0 0 30px;max-width:680px}
.wm-def{border:1.5px solid var(--ink);background:var(--card);padding:20px 24px;margin:0 0 40px;max-width:720px;font-size:16.5px;line-height:1.65}
.wm-def strong{color:var(--ink)}
.wm-h2{font-family:var(--font-body);font-weight:800;font-size:28px;letter-spacing:-.02em;margin:48px 0 14px}
.wm-p{font-size:16px;line-height:1.65;color:var(--muted);margin:0 0 14px;max-width:680px}
.wm-p strong{color:var(--ink)}
.wm-p code{font-family:var(--font-mono);font-size:14px;background:var(--card);border:1px solid var(--hairline);padding:1px 5px}
.wm-steps{counter-reset:s;margin:18px 0;padding:0;list-style:none;max-width:680px}
.wm-steps li{position:relative;padding:0 0 16px 44px;font-size:15.5px;line-height:1.6;color:var(--muted)}
.wm-steps li::before{counter-increment:s;content:counter(s);position:absolute;left:0;top:0;width:28px;height:28px;border:1.5px solid var(--ink);display:flex;align-items:center;justify-content:center;font-family:var(--font-mono);font-weight:700;font-size:13px;color:var(--ink);background:var(--card)}
.wm-steps code{font-family:var(--font-mono);font-size:13.5px;background:var(--card);border:1px solid var(--hairline);padding:1px 5px}
.wm-table{border-collapse:collapse;margin:18px 0;font-size:14.5px;max-width:720px;width:100%}
.wm-table th,.wm-table td{border:1px solid var(--hairline);padding:9px 12px;text-align:left;vertical-align:top;line-height:1.5}
.wm-table th{font-family:var(--font-mono);font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--faint);background:var(--card)}
.wm-table code{font-family:var(--font-mono);font-size:13px}
.wm-faq{max-width:720px}
.wm-faq details{border:1px solid var(--hairline);background:var(--card);margin:0 0 10px;padding:14px 18px}
.wm-faq summary{cursor:pointer;font-weight:700;font-size:15.5px}
.wm-faq p{font-size:15px;line-height:1.6;color:var(--muted);margin:10px 0 0}
@media(max-width:640px){.wm-title{font-size:36px}.wm-wrap{padding:36px 18px}.wm-table{display:block;overflow-x:auto}}
`;

  const body = `
<div class="wm-wrap">
  <div class="wm-eyebrow">Plain-English explainer</div>
  <h1 class="wm-title">What is MPP?</h1>
  <p class="wm-sub">The Machine Payments Protocol, explained: what it is, how one payment works, how it relates to x402, and where it is settling real money today.</p>

  <div class="wm-def"><strong>MPP (Machine Payments Protocol)</strong> is an open, IETF-track standard that lets software pay for web services per request through HTTP's native authentication headers. A paid endpoint answers an unpaid request with status <strong>402 Payment Required</strong> and a <strong>WWW-Authenticate: Payment</strong> challenge naming a price; the client responds with a signed stablecoin payment in an <strong>Authorization: Payment</strong> header; the server verifies it, settles it on-chain, and returns the result with a signed <strong>Payment-Receipt</strong>. No accounts, API keys, or subscriptions.</div>

  <h2 class="wm-h2">How one MPP payment works</h2>
  <ol class="wm-steps">
    <li>The client requests a paid resource. The server answers <code>402 Payment Required</code> with a <code>WWW-Authenticate: Payment</code> challenge - the price, the asset (a stablecoin such as USDC), the chain, and a one-time challenge id.</li>
    <li>The client signs a payment authorization for exactly that amount with its own wallet key and retries the request with an <code>Authorization: Payment</code> header carrying the signed credential. The key never leaves the client.</li>
    <li>The server verifies the credential against the challenge, settles the payment on-chain, and only then runs the request.</li>
    <li>The response arrives with a signed <code>Payment-Receipt</code> header - a verifiable record that this exact payment bought this exact answer.</li>
  </ol>
  <p class="wm-p">The whole exchange is two HTTP round trips, typically a couple of seconds. Because it rides the <strong>standard HTTP authentication mechanism</strong> (the same <code>WWW-Authenticate</code> / <code>Authorization</code> machinery defined in RFC 9110 that powers every login prompt on the web), payment becomes just another auth scheme - which is what makes it a natural candidate for the IETF standards track.</p>

  <h2 class="wm-h2">MPP vs x402</h2>
  <p class="wm-p">MPP and <a href="/what-is-x402">x402</a> are two dialects of the same idea: pay-per-request over HTTP 402, settled in stablecoins, with no accounts. They differ in which headers carry the handshake:</p>
  <table class="wm-table">
    <tr><th></th><th>x402</th><th>MPP</th></tr>
    <tr><td><b>Payment terms ride in</b></td><td><code>PAYMENT-REQUIRED</code> header (base64 JSON offer)</td><td><code>WWW-Authenticate: Payment</code> challenge</td></tr>
    <tr><td><b>Payment rides in</b></td><td><code>X-PAYMENT</code> header</td><td><code>Authorization: Payment</code> header</td></tr>
    <tr><td><b>Proof of settlement</b></td><td><code>PAYMENT-RESPONSE</code> header</td><td>Signed <code>Payment-Receipt</code> header</td></tr>
    <tr><td><b>Origin</b></td><td>Coinbase (x402.org)</td><td>Tempo (paymentauth.org, IETF-track)</td></tr>
  </table>
  <p class="wm-p">The two are not rivals in practice: a server can speak both from the <strong>same URL at the same price</strong>, letting the buyer's client pick its dialect. That is how Agent402 runs today - one paywall, two wire formats, one settlement path.</p>

  <h2 class="wm-h2">Is it real? Where MPP settles today</h2>
  <p class="wm-p">Every paid endpoint on <a href="/">Agent402.Tools</a> is dual-stack: the same 402 carries an x402 offer <em>and</em> an MPP challenge, a stock <code>mppx</code> client works unmodified, and a real purchase settles over the native MPP wire every day as part of the service's paid canary - so "MPP works here" is continuously re-proven on mainnet, not demonstrated once. Other x402 sellers have begun advertising MPP as an alternate rail as well. The reference tooling lives in the <a href="https://github.com/tempoxyz/mpp" rel="noopener">tempoxyz/mpp</a> repository, and the 'Payment' auth scheme is documented at <a href="https://paymentauth.org" rel="noopener">paymentauth.org</a>.</p>
  <p class="wm-p">For the broader story - why machine payments exist, what "agents paying agents" means, and an interactive walk-through of one payment - see <a href="/what-is-x402">What is x402?</a>. To accept either protocol on your own API, start at <a href="/sell">/sell</a>.</p>

  <h2 class="wm-h2">FAQ</h2>
  <div class="wm-faq">
    ${faqs.map((f) => `<details><summary>${f.q}</summary><p>${f.a}</p></details>`).join("\n    ")}
  </div>
</div>
${ledgerFooterCompact()}`;

  return ledgerShell({
    title,
    description,
    canonical,
    baseUrl,
    activePath: "/what-is-x402",
    extraCss,
    jsonLd: [articleLd, faqLd],
    body,
  });
}
