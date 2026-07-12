// Offline unit test for the ecosystem category classifier (x402-market-pulse
// supply mix). Asserts the closed taxonomy: known descriptions land in the
// right functional bucket, ordering resolves overlaps, and unmatched tools
// fall to "other" instead of spawning singleton buckets. No network.
import assert from "node:assert";
import { classifyEcosystemCategory } from "../src/x402-index.js";

const cases = [
  // [expected, tool]
  ["defi",     { description: "Hibra AI Swap — best route on Base network" }],
  ["defi",     { name: "Hyperliquid", description: "Perpetuals funding rates" }],
  ["crypto",   { description: "Real-time Bitcoin price in USD, aggregated from 9 exchanges" }],
  ["crypto",   { description: "ENS resolve - turn a .eth name into an address" }],
  ["finance",  { description: "Real-time forex / exchange rates from the European Central Bank" }],
  ["finance",  { name: "Financials", tags: ["Financials"], description: "SEC company financials" }],
  ["social",   { description: "Reddit hot posts from any subreddit — titles, scores, comments" }],
  ["social",   { description: "LinkedIn people, companies, posts, job listings" }],
  ["research", { description: "Search and synthesize scientific literature on longevity and aging" }],
  ["research", { description: "Last 30 days of arXiv preprints flagged as milestone candidates" }],
  ["ai",       { description: "AI image generation using Grok Imagine model" }],
  ["ai",       { description: "X.AI text-to-speech: convert text to speech (MP3)" }],
  ["weather",  { description: "Current weather conditions for any global location" }],
  ["search",   { description: "Private web search for AI agents — zero logging, no tracking" }],
  ["documents",{ description: "office-to-pdf conversion for agents" }],
  ["media",    { description: "face detection and object detection on an image" }],
  ["dev",      { description: "Run Python code in a secure sandbox environment using E2B" }],
  // ordering: defi wins over crypto for a token swap
  ["defi",     { description: "swap any ERC-20 token for the best onchain price" }],
  // ordering: research wins over ai for an arxiv+llm tool
  ["research", { description: "arXiv papers summarized by an LLM" }],
  // unmatched -> other (NOT its raw tag)
  ["other",    { description: "Buy a prepaid card for use inside the United States", tags: ["premium"] }],
  ["other",    { description: "GPU compute spot prices across Vast.ai, RunPod, AWS", tags: ["gpu"] }],
  // never key on ubiquitous payment words
  ["other",    { description: "Pay with x402 (Base USDC mainnet)", tags: ["x402"] }],
];

let pass = 0;
for (const [expected, tool] of cases) {
  const got = classifyEcosystemCategory(tool);
  assert.strictEqual(got, expected, `expected "${expected}" got "${got}" for: ${tool.description}`);
  pass++;
}
console.log(`ecosystem-category: ${pass}/${cases.length} passed`);
