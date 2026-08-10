// Machine Ledger — Docs page (/docs)
// Two-column layout: sticky TOC (left) + content sections (right).
// Quickstart, payment flow, three ways in, free tier, reference endpoints.

import { ledgerShell, ledgerFooterCompact } from "./ledger-chrome.js";
import { RAILS_PAREN } from "./rails.js";
import { toolList } from "./pages.js";
import { isComputePayable } from "./pow.js";

const fmtNum = (n) => Number(n || 0).toLocaleString("en-US");

export function ledgerDocsPage(baseUrl, catalog) {
  const tools = toolList(catalog);
  const totalCount = tools.length;
  const freeCount = tools.filter(isComputePayable).length;
  const canonical = baseUrl + "/docs";
  const title = "Docs - Agent402 x402 + MCP server";
  const description = `Add ${fmtNum(totalCount)} deterministic x402 tools plus an OpenAI-compatible /v1 gateway to your agent in about a minute. No signup, no API key - start free with proof-of-work, settle ${RAILS_PAREN} when you scale.`;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    name: "Agent402.Tools Documentation",
    url: canonical,
    description,
    publisher: {
      "@type": "Organization",
      name: "Agent402.Tools",
      url: baseUrl,
    },
  };

  const extraCss = `
  .ml-docs-grid [id] { scroll-margin-top: 110px; }
  .ml-docs-toc a.active { color: var(--ink) !important; font-weight: 700; }
  @media (max-width: 900px) {
    /* minmax(0,1fr) (not bare 1fr, which floors at min-content) + min-width:0
       lets the stacked column shrink to the phone viewport instead of being
       widened by a grid item's intrinsic width. */
    .ml-docs-grid { grid-template-columns: minmax(0, 1fr) !important; }
    .ml-docs-grid > * { min-width: 0 !important; }
    .ml-docs-toc > div { position: static !important; }
    /* Nested content rows (endpoint/gateway tables: method · path · price) have
       flexible 1fr columns that floor at their child's min-content. min-width:0
       lets those columns actually shrink to the phone width; long tokens wrap. */
    .ml-docs-grid main [style*="grid-template-columns"] > * { min-width: 0; overflow-wrap: anywhere; }
  }`;

  const body = `
  <!-- DOCS LAYOUT -->
  <div class="ml-docs-grid" style="max-width:1180px;margin:0 auto;padding:50px 30px 64px;display:grid;grid-template-columns:220px 1fr;gap:44px;">

    <!-- TOC -->
    <aside class="ml-docs-toc" style="font-family:var(--font-mono);font-size:13px;">
      <div style="position:sticky;top:92px;">
        <div style="font-size:11px;color:var(--accent);letter-spacing:.1em;margin-bottom:14px;">$ GET /docs</div>
        <div style="display:flex;flex-direction:column;gap:11px;border-left:1.5px solid var(--ink);padding-left:16px;">
          <a href="#quickstart" style="color:var(--ink);text-decoration:none;font-weight:700;">quickstart</a>
          <a href="#how" style="color:var(--muted);text-decoration:none;">how payment works</a>
          <a href="#add" style="color:var(--muted);text-decoration:none;">three ways in</a>
          <a href="#free" style="color:var(--muted);text-decoration:none;">free tier &middot; PoW</a>
          <a href="#gateway" style="color:var(--muted);text-decoration:none;">/v1 LLM gateway</a>
          <a href="#endpoints" style="color:var(--muted);text-decoration:none;">endpoints</a>
          <a href="/docs/adapters" style="color:var(--muted);text-decoration:none;">framework adapters &rarr;</a>
        </div>
      </div>
    </aside>

    <!-- CONTENT -->
    <main>
      <h1 style="font-family:var(--font-body);font-weight:800;font-size:52px;line-height:.96;letter-spacing:-.03em;margin:0 0 14px;">Quickstart.</h1>
      <p style="font-size:17px;line-height:1.55;color:var(--muted);max-width:620px;margin:0 0 30px;">Add ${fmtNum(totalCount)} deterministic tools - plus an open cross-seller Index, Smart Order Router, and an OpenAI-compatible /v1 gateway - to your agent in about a minute. No signup, no API key - start free with proof-of-work, settle ${RAILS_PAREN} when you scale.</p>

      <div id="quickstart" style="border:1.5px solid var(--ink);background:var(--surface);margin-bottom:14px;">
        <div style="display:flex;align-items:center;gap:7px;padding:11px 15px;border-bottom:1px solid var(--dark-border2);font-family:var(--font-mono);font-size:11px;color:var(--dk-muted);">terminal</div>
        <pre style="margin:0;padding:18px;font-family:var(--font-mono);font-size:13px;line-height:1.85;color:var(--on-dark);white-space:pre-wrap;word-break:break-word;"><span style="color:var(--dk-muted3);"># one file, zero deps - pays with COMPUTE (no wallet)
</span>curl -s https://agent402.tools/demo.js -o demo.js
node demo.js

<span style="color:var(--dk-muted3);"># or settle ${RAILS_PAREN} with a funded key
</span>npm i @x402/core @x402/evm @x402/fetch viem
AGENT_KEY=0xYOUR_FUNDED_KEY node demo.js</pre>
      </div>
      <p style="font-family:var(--font-mono);font-size:12.5px;color:var(--faint);margin:0 0 44px;">// an autonomous buyer discovers the catalog, gets quoted over HTTP 402, settles, and uses the result - zero humans.</p>

      <!-- HOW -->
      <h2 id="how" style="font-family:var(--font-body);font-weight:800;font-size:32px;letter-spacing:-.02em;margin:0 0 18px;">How payment works.</h2>
      <div style="border:1.5px solid var(--ink);background:var(--card);margin-bottom:44px;">
        <div style="display:grid;grid-template-columns:44px 1fr;gap:16px;padding:18px 20px;border-bottom:1px solid var(--hairline);"><span style="font-family:var(--font-mono);font-weight:700;color:var(--accent);font-size:18px;">01</span><span style="font-size:15px;line-height:1.5;color:var(--muted);">Your agent calls a paid endpoint and receives <strong>HTTP 402 Payment Required</strong> with the price and payment details.</span></div>
        <div style="display:grid;grid-template-columns:44px 1fr;gap:16px;padding:18px 20px;border-bottom:1px solid var(--hairline);"><span style="font-family:var(--font-mono);font-weight:700;color:var(--accent);font-size:18px;">02</span><span style="font-size:15px;line-height:1.5;color:var(--muted);">An x402 client (<span style="font-family:var(--font-mono);font-size:13px;">@x402/fetch</span>, axios, or any framework adapter) signs a USDC payment from its wallet and retries.</span></div>
        <div style="display:grid;grid-template-columns:44px 1fr;gap:16px;padding:18px 20px;"><span style="font-family:var(--font-mono);font-weight:700;color:var(--accent);font-size:18px;">03</span><span style="font-size:15px;line-height:1.5;color:var(--muted);">Payment settles on Base in seconds and the response comes back. Total overhead: <strong>one round trip</strong>.</span></div>
      </div>

      <!-- THREE WAYS -->
      <h2 id="add" style="font-family:var(--font-body);font-weight:800;font-size:32px;letter-spacing:-.02em;margin:0 0 18px;">Three ways in.</h2>

      <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);margin-bottom:8px;">A / MCP - Claude &amp; any MCP client</div>
      <div style="border:1.5px solid var(--ink);background:var(--surface);margin-bottom:22px;"><pre style="margin:0;padding:16px;font-family:var(--font-mono);font-size:13px;line-height:1.8;color:var(--on-dark);white-space:pre-wrap;word-break:break-word;"><span style="color:var(--dk-muted3);"># Claude Code - hosted flagship MCP (search/answer first)
</span>claude mcp add --transport http agent402 https://agent402.tools/mcp

<span style="color:var(--dk-muted3);"># Claude Code - npm with wallet (paid tools settle via x402)
</span>claude mcp add agent402 -s user -- npx -y agent402-mcp@latest

<span style="color:var(--dk-muted3);"># Cursor - ~/.cursor/mcp.json
</span>{
  "mcpServers": {
    "agent402": { "url": "https://agent402.tools/mcp" }
  }
}

<span style="color:var(--dk-muted3);"># Smithery - paste at smithery.ai/new
</span>https://agent402.tools/mcp</pre></div>

      <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);margin-bottom:8px;">B / x402 client - pay in code</div>
      <div style="border:1.5px solid var(--ink);background:var(--surface);margin-bottom:22px;"><pre style="margin:0;padding:16px;font-family:var(--font-mono);font-size:12.5px;line-height:1.8;color:var(--on-dark);white-space:pre-wrap;word-break:break-word;">import { wrapFetchWithPayment } from "@x402/fetch";
const payFetch = wrapFetchWithPayment(fetch, client);
const res = await payFetch("https://agent402.tools/api/extract", {
  method: "POST", body: JSON.stringify({ url })
});</pre></div>

      <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);margin-bottom:8px;">C / SDK - resolves a task &amp; pays automatically</div>
      <div style="border:1.5px solid var(--ink);background:var(--surface);margin-bottom:44px;"><pre style="margin:0;padding:16px;font-family:var(--font-mono);font-size:12.5px;line-height:1.8;color:var(--on-dark);white-space:pre-wrap;word-break:break-word;">npm install agent402-client
import { Agent402 } from "agent402-client";
const a = new Agent402();           <span style="color:var(--dk-muted3);">// free tier (proof-of-work)</span>
const out = await a.call("hash", { text: "hello", algo: "sha256" });</pre></div>

      <!-- FREE -->
      <h2 id="free" style="font-family:var(--font-body);font-weight:800;font-size:32px;letter-spacing:-.02em;margin:0 0 14px;">Free tier - proof-of-work.</h2>
      <p style="font-size:15.5px;line-height:1.55;color:var(--muted);max-width:640px;margin:0 0 18px;">${fmtNum(freeCount)} of the ${fmtNum(totalCount)} pure-CPU tools work with no wallet. Instead of paying USDC, your machine solves a short sha256 puzzle - a fraction of a second of CPU - and the call goes through. Nothing here consumes AI tokens.</p>
      <div style="border:1.5px solid var(--ink);background:var(--card);padding:16px 20px;font-family:var(--font-mono);font-size:13px;margin-bottom:44px;"><span style="color:var(--green);font-weight:700;">GET</span> <span style="color:var(--ink);">/api/pow</span>  <span style="color:var(--faint);">&rarr; returns a challenge; solve and resubmit. Free, rate-limited.</span></div>

      <!-- GATEWAY -->
      <h2 id="gateway" style="font-family:var(--font-body);font-weight:800;font-size:32px;letter-spacing:-.02em;margin:0 0 14px;">/v1 - OpenAI-compatible LLM gateway.</h2>
      <p style="font-size:15.5px;line-height:1.55;color:var(--muted);max-width:640px;margin:0 0 18px;">Point any OpenAI SDK at <code>base_url https://agent402.tools/v1</code> and pay per call in USDC over x402 - no API key, no signup, same wallet-is-the-identity model as every other tool. Chat has five quality tiers ($0.003 nano to $0.50 premium) plus a $0.01 auto tier that routes on your prompt with no model required; embeddings are $0.002 with a default-on cache; image generation is $0.08 per image.</p>
      <div style="border:1.5px solid var(--ink);background:var(--card);font-family:var(--font-mono);font-size:13px;margin-bottom:44px;">
        <div style="display:grid;grid-template-columns:60px 1fr auto;gap:14px;padding:12px 18px;border-bottom:1px solid var(--hairline);"><span style="color:var(--accent);font-weight:700;">POST</span><span>/v1/chat/completions</span><span style="color:var(--faint);">$0.02 &middot; base tier ($0.003&ndash;$0.50 across the nano&hellip;premium paths)</span></div>
        <div style="display:grid;grid-template-columns:60px 1fr auto;gap:14px;padding:12px 18px;border-bottom:1px solid var(--hairline);"><span style="color:var(--accent);font-weight:700;">POST</span><span>/v1/auto/chat/completions</span><span style="color:var(--faint);">$0.01 &middot; model optional, auto-routed</span></div>
        <div style="display:grid;grid-template-columns:60px 1fr auto;gap:14px;padding:12px 18px;border-bottom:1px solid var(--hairline);"><span style="color:var(--accent);font-weight:700;">POST</span><span>/v1/embeddings</span><span style="color:var(--faint);">$0.002 &middot; free repeat within 10 min</span></div>
        <div style="display:grid;grid-template-columns:60px 1fr auto;gap:14px;padding:12px 18px;border-bottom:1px solid var(--hairline);"><span style="color:var(--accent);font-weight:700;">POST</span><span>/v1/images/generations</span><span style="color:var(--faint);">$0.08 per image</span></div>
        <div style="display:grid;grid-template-columns:60px 1fr auto;gap:14px;padding:12px 18px;"><span style="color:var(--accent);font-weight:700;">POST</span><span>/v1/audio/speech</span><span style="color:var(--faint);">$0.06 &middot; mp3/pcm bytes out</span></div>
      </div>

      <!-- ENDPOINTS -->
      <h2 id="endpoints" style="font-family:var(--font-body);font-weight:800;font-size:32px;letter-spacing:-.02em;margin:0 0 18px;">Reference endpoints.</h2>
      <div style="border:1.5px solid var(--ink);background:var(--card);font-family:var(--font-mono);font-size:13px;">
        <div style="display:grid;grid-template-columns:60px 1fr auto;gap:14px;padding:12px 18px;border-bottom:1px solid var(--hairline);"><span style="color:var(--green);font-weight:700;">GET</span><span>/api/pricing</span><span style="color:var(--faint);">machine-readable catalog</span></div>
        <div style="display:grid;grid-template-columns:60px 1fr auto;gap:14px;padding:12px 18px;border-bottom:1px solid var(--hairline);"><span style="color:var(--green);font-weight:700;">GET</span><span>/openapi.json</span><span style="color:var(--faint);">full OpenAPI 3.1 spec</span></div>
        <div style="display:grid;grid-template-columns:60px 1fr auto;gap:14px;padding:12px 18px;border-bottom:1px solid var(--hairline);"><span style="color:var(--green);font-weight:700;">GET</span><span>/api/stats</span><span style="color:var(--faint);">live counts &amp; receiving wallet</span></div>
        <div style="display:grid;grid-template-columns:60px 1fr auto;gap:14px;padding:12px 18px;border-bottom:1px solid var(--hairline);"><span style="color:var(--accent);font-weight:700;">POST</span><span>/api/extract</span><span style="color:var(--faint);">$0.010 &middot; url &rarr; clean markdown</span></div>
        <div style="display:grid;grid-template-columns:60px 1fr auto;gap:14px;padding:12px 18px;"><span style="color:var(--green);font-weight:700;">GET</span><span>/llms.txt</span><span style="color:var(--faint);">agent-readable site map</span></div>
      </div>
    </main>
  </div>

  ${ledgerFooterCompact()}
<script>
(function(){
  var links=document.querySelectorAll('.ml-docs-toc a[href^="#"]');
  var ids=[].map.call(links,function(a){return a.getAttribute('href').slice(1);});
  var sections=ids.map(function(id){return document.getElementById(id);}).filter(Boolean);
  function update(){
    var top=window.scrollY+130;
    var active='';
    sections.forEach(function(s){if(s.offsetTop<=top)active=s.id;});
    links.forEach(function(a){
      var h=a.getAttribute('href');
      if(h==='#'+active)a.classList.add('active');
      else a.classList.remove('active');
    });
  }
  window.addEventListener('scroll',update,{passive:true});
  update();
})();
</script>`;

  return ledgerShell({
    title,
    description,
    canonical,
    baseUrl,
    activePath: "/docs",
    jsonLd,
    extraCss,
    body,
  });
}
