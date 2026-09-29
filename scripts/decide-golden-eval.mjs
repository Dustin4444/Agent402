// Golden-set evaluation for /api/decide. NOT in CI: it makes real model calls.
//
// For each task it buys a decision (FREE_MODE boot: no payment) and checks the
// plan is EXECUTABLE: every step's tool is in the catalog (or a live row in the
// index), runnable in a plan, its params validate against its schema and carry
// no unfilled placeholder, and the plan fits its budget. Reports pass rate,
// average decision price and average latency.
//
//   TARGET_URL=http://127.0.0.1:PORT node scripts/decide-golden-eval.mjs [--depth plan] [--out file.json]

import { writeFileSync } from "node:fs";
import { validateParams } from "../services/decide/params.js";

const TARGET = (process.env.TARGET_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const DEPTH = arg("--depth", "plan");
const OUT = arg("--out", null);

export const GOLDEN = [
  { task: "Research the current state of EU AI Act obligations for general-purpose AI models and cite sources", budget: 1 },
  { task: "Build a company dossier on Nvidia from SEC filings", budget: 2 },
  { task: "Audit wallet 0x28C6c06298d514Db089934071355E5743bf21d60 on Base: token balances and recent transfers", budget: 0.1 },
  { task: "Extract the text from the PDF at https://bitcoin.org/bitcoin.pdf and count the words", budget: 0.1 },
  { task: "Convert this CSV to JSON: name,age\\nada,36", budget: 0.05 },
  { task: "Get the current price of bitcoin and ethereum in USD", budget: 0.05 },
  { task: "Check whether example.com has valid SPF and DMARC records", budget: 0.05 },
  { task: "Find the TLS certificate expiry date for github.com", budget: 0.05 },
  { task: "Summarize the latest news about stablecoin regulation", budget: 0.5 },
  { task: "Get the 7-day weather forecast for Denver", budget: 0.05 },
  { task: "Look up insider trading activity for Apple in the last 90 days", budget: 2 },
  { task: "What are Berkshire Hathaway's largest 13F holdings this quarter", budget: 2 },
  { task: "Render https://example.com in a browser and return the page title", budget: 0.1 },
  { task: "Check if an Ethereum address is on the OFAC sanctions list", budget: 0.05 },
  { task: "Generate a QR code for https://agent402.tools", budget: 0.05 },
  { task: "Hash the string hello world with sha256", budget: 0.01 },
  { task: "Transcribe an audio file from a URL to text", budget: 0.2 },
  { task: "Get perpetual futures funding rates for BTC", budget: 0.05 },
  { task: "Find the US unemployment rate trend from FRED", budget: 0.05 },
  { task: "Decode this JWT and show its claims", budget: 0.01 },
  { task: "Look up the ASN and country for IP 8.8.8.8", budget: 0.05 },
  { task: "Get DeFi TVL for Uniswap and Aave", budget: 0.05 },
  { task: "Translate a paragraph of English text to Spanish", budget: 0.1 },
  { task: "Check recalls for losartan", budget: 2 },
  { task: "Get the gas price on Base and Ethereum mainnet", budget: 0.05 },
  { task: "Resolve the ENS name vitalik.eth to an address and list its token balances", budget: 0.1 },
  { task: "Scrape the article at a URL and return clean markdown", budget: 0.1 },
  { task: "Compute the Black-Scholes price of a call option", budget: 0.05 },
  { task: "List trending tokens on Solana and check the top one for rug risk", budget: 0.2 },
  { task: "Find the domain registration (WHOIS) details for agent402.tools", budget: 0.05 },
];

async function main() {
  const pricing = await (await fetch(`${TARGET}/api/pricing`)).json();
  const bySlug = new Map((pricing.tools || pricing.endpoints || []).map((t) => [t.slug, t]));
  const rows = [];
  for (const g of GOLDEN) {
    const t0 = Date.now();
    let d = null, error = null;
    try {
      const r = await fetch(`${TARGET}/api/decide`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task: g.task, depth: DEPTH, constraints: { maxBudgetUsd: g.budget } }) });
      d = await r.json();
      if (!r.ok) error = `HTTP ${r.status} ${d?.error || ""}`;
    } catch (e) { error = String(e?.message || e); }
    const ms = Date.now() - t0;
    const problems = [];
    if (!error) {
      if (!d.plan?.length) problems.push("empty plan");
      for (const p of d.plan || []) {
        if (p.tool.firstParty && !bySlug.has(p.tool.slug)) problems.push(`step ${p.step}: ${p.tool.slug} not in catalog`);
        const v = validateParams(p.tool.inputSchema, p.tool.exampleParams);
        if (!v.ok) problems.push(`step ${p.step}: params invalid (${v.errors.join("; ")})`);
        if (Object.values(p.tool.exampleParams || {}).some((x) => typeof x === "string" && /^<[^>]+>$/.test(x))) problems.push(`step ${p.step}: unfilled placeholder`);
        if (p.tool.priceUsd > g.budget) problems.push(`step ${p.step}: over budget`);
      }
      if (d.estimatedCostUsd > g.budget) problems.push("plan over budget");
    }
    const pass = !error && problems.length === 0;
    rows.push({ task: g.task, pass, ms, priceUsd: d?.priceUsd ?? null, confidence: d?.confidence ?? null, partial: d?.partial ?? null, steps: (d?.plan || []).map((p) => `${p.tool.slug}${p.tool.firstParty ? "" : `@${p.tool.seller}`}`), gaps: d?.gaps || [], error, problems });
    console.log(`${pass ? "PASS" : "FAIL"} ${ms}ms conf=${d?.confidence ?? "-"} ${g.task.slice(0, 60)} -> ${rows.at(-1).steps.join(" > ") || "-"}${problems.length ? `  [${problems.join(" | ")}]` : ""}${error ? `  [${error}]` : ""}`);
  }
  const n = rows.length, passed = rows.filter((r) => r.pass).length;
  const avg = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  const lat = rows.map((r) => r.ms).sort((a, b) => a - b);
  const summary = { depth: DEPTH, tasks: n, passed, passRate: Math.round((passed / n) * 1000) / 10, avgDecisionPriceUsd: Math.round(avg(rows.map((r) => r.priceUsd || 0)) * 1e6) / 1e6, avgLatencyMs: Math.round(avg(lat)), p95LatencyMs: lat[Math.floor(lat.length * 0.95)] || 0, avgConfidence: Math.round(avg(rows.map((r) => r.confidence || 0)) * 1000) / 1000, partial: rows.filter((r) => r.partial).length, withGaps: rows.filter((r) => r.gaps.length).length };
  console.log(JSON.stringify(summary, null, 2));
  if (OUT) writeFileSync(OUT, JSON.stringify({ summary, rows }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
