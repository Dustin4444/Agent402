#!/usr/bin/env node
// Offline pins for the meta trims in src/seo-meta.js, then (with TARGET_URL)
// a booted sweep over the hand-written pages: every served page must carry a
// title <= 70 and a description <= 165 characters, exactly one H1, and a
// canonical. The reader pass of 2026-09-08 found 66 of 96 descriptions past
// Google's cut and nine titles past 70; this is the ratchet that keeps them
// from drifting back.
//
//   node scripts/test-seo-meta.js                      # offline unit
//   TARGET_URL=http://127.0.0.1:3000 node scripts/test-seo-meta.js   # + booted sweep
import { metaDescription, metaTitle, META_DESCRIPTION_MAX, META_TITLE_MAX } from "../src/seo-meta.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// --- descriptions -------------------------------------------------------------
ok(metaDescription("Short and sweet.") === "Short and sweet.", "a description under the limit is returned unchanged");
const long = "Agent402 is the applied layer of Agentic Finance: the open index, Smart Order Router and on-chain ranking for agents that pay and get paid over x402 and MPP. Sell your API for USDC per call, or give your AI agent 585 pay-per-call tools. No signup, no API keys - the wallet is the identity.";
const d = metaDescription(long);
ok(d.length <= META_DESCRIPTION_MAX, `a long description is cut to <= ${META_DESCRIPTION_MAX} (got ${d.length})`);
ok(!d.endsWith(".") && /\w$/.test(d), "when the first sentence end sits past the limit the cut lands on a word, never mid-word");
const twoSentences = "Every paid call returns a receipt and a failed call is never charged. The metered gateway quotes each request from its own body and settles the actual usage under that ceiling with a receipt on every response.";
const d1 = metaDescription(twoSentences);
ok(d1 === "Every paid call returns a receipt and a failed call is never charged.", "the cut lands on a sentence end when one fits");
ok(!/\.\.\.$|…$/.test(d), "no ellipsis is added (search engines add their own)");
const noSentence = "word ".repeat(60).trim();
const d2 = metaDescription(noSentence);
ok(d2.length <= META_DESCRIPTION_MAX && !d2.endsWith(" ") && /word$/.test(d2), "with no sentence end the cut lands on a word boundary");
ok(metaDescription("  spaced   out\n\ntext  ") === "spaced out text", "whitespace is normalised");
const priced = "Cited reports, $2 to $5 by card and $0.60 to $1.10 for an agent paying per call: deep research, company dossier, fund 13F, insider flow, market brief, SEC filings, domain security, Solana token safety, FDA recalls.";
ok(/\$2 to \$5/.test(metaDescription(priced)), "the reports description keeps its prices after the cut (test-price-prose depends on it)");

// --- titles -------------------------------------------------------------------
ok(metaTitle("Pricing - Agent402") === "Pricing - Agent402", "a short title is unchanged");
const t = metaTitle("Agent hosts: Claude Code, Cursor, Continue, ElizaOS, any OpenAI SDK and Bedrock AgentCore - copy-paste blocks for models over /v1/metered and tools over MCP | Agent402");
ok(t.length <= META_TITLE_MAX, `a long title is cut to <= ${META_TITLE_MAX} (got ${t.length}: "${t}")`);
ok(!/[-:|·]\s*$/.test(t), "a cut title never ends on a dangling separator");
ok(metaTitle("x".repeat(90)).length <= META_TITLE_MAX, "a title with no separator or space is hard-cut");

// --- booted sweep ---------------------------------------------------------------
const TARGET = (process.env.TARGET_URL || "").replace(/\/$/, "");
if (TARGET) {
  const PAGES = ["/", "/101", "/agentic-finance", "/base", "/solana", "/company", "/faq", "/glossary", "/integrations", "/leaderboard",
    "/marketplace", "/marketplace/tools", "/markets", "/monitors", "/mpp-marketplace", "/pricing", "/proof", "/reports", "/revenue",
    "/security", "/sell", "/shop", "/skills", "/status", "/tollbooth", "/tollbooth/cloud", "/tools", "/what-is-mpp", "/what-is-x402", "/why",
    "/docs", "/guides", "/guides/agent-hosts", "/blog", "/credits", "/digest", "/community", "/changelog", "/quickstart", "/playground"];
  for (const p of PAGES) {
    let html;
    try { const r = await fetch(TARGET + p, { redirect: "follow" }); if (r.status !== 200) { ok(false, `${p}: HTTP ${r.status}`); continue; } html = await r.text(); }
    catch (e) { ok(false, `${p}: ${e.message}`); continue; }
    // Measure the TEXT a search engine shows, not the escaped source: "&amp;"
    // is one character on the page (tollbooth/cloud's title read 74 escaped, 70 real).
    const unesc = (s) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    const title = unesc((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
    const desc = unesc((html.match(/<meta name="description" content="([^"]*)"/i) || [])[1] || "");
    const h1 = (html.match(/<h1\b/gi) || []).length;
    const canon = /<link rel="canonical"/i.test(html);
    ok(title.length > 0 && title.length <= META_TITLE_MAX, `${p}: title ${title.length} chars (<= ${META_TITLE_MAX})`);
    ok(desc.length > 0 && desc.length <= 165, `${p}: description ${desc.length} chars (1..165)`);
    ok(h1 === 1, `${p}: exactly one H1 (got ${h1})`);
    ok(canon, `${p}: canonical present`);
  }
} else {
  console.log("(no TARGET_URL: offline unit only; the booted sweep runs in CI against the test server)");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
