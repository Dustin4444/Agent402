#!/usr/bin/env node
// USDC EIP-712 domain truth (src/evm-usdc-domain.js): a seller whose Base
// accept advertises extra.name "USDC" publishes a challenge no stock x402
// buyer can pay - Base USDC signs under "USD Coin" (HumanMirror 2026-09-10,
// proven with the external seller probe; an earlier seller's 39-route catalog
// in test-x402-live-quote carries the same accept). Offline.
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { USDC_DOMAIN_BY_NETWORK, usdcDomainVerdict, evmDomainsOfAccepts, usdcDomainMismatchDetail } from "../src/evm-usdc-domain.js";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const accept = (over = {}) => ({ scheme: "exact", network: "eip155:8453", asset: BASE_USDC, amount: "1000", payTo: "0x" + "11".repeat(20), extra: { name: "USD Coin", version: "2" }, ...over });

// --- the table cannot drift from what the paywall itself signs under -------------
{
  const payments = readFileSync(new URL("../src/payments.js", import.meta.url), "utf8");
  // Tier 1 (Avalanche / Sei / Optimism): one row each in TIER1_USDC, name beside the address.
  for (const net of ["eip155:43114", "eip155:1329", "eip155:10"]) {
    const row = payments.match(new RegExp(`"${net}": \\{ asset: "(0x[0-9a-fA-F]{40})", decimals: 6, name: "([^"]+)"`));
    ok(row && row[1].toLowerCase() === USDC_DOMAIN_BY_NETWORK[net].asset && row[2] === USDC_DOMAIN_BY_NETWORK[net].name, `${net}: table matches payments.js TIER1_USDC (${row?.[2]})`);
  }
  const monad = payments.match(/MONAD_USDC_ADDRESS \|\| "(0x[0-9a-fA-F]{40})"/), monadName = payments.match(/MONAD_USDC_EIP712_NAME \|\| "([^"]+)"/);
  ok(monad && monad[1].toLowerCase() === USDC_DOMAIN_BY_NETWORK["eip155:143"].asset && monadName?.[1] === USDC_DOMAIN_BY_NETWORK["eip155:143"].name, "eip155:143: table matches payments.js MONAD_USDC (USDC)");
  const celo = payments.match(/CELO_USDC_ADDRESS \|\| "(0x[0-9a-fA-F]{40})"/), celoName = payments.match(/CELO_USDC_EIP712_NAME \|\| "([^"]+)"/);
  ok(celo && celo[1].toLowerCase() === USDC_DOMAIN_BY_NETWORK["eip155:42220"].asset && celoName?.[1] === USDC_DOMAIN_BY_NETWORK["eip155:42220"].name, "eip155:42220: table matches payments.js CELO_USDC (USDC)");
  // Base / Polygon / Arbitrum ride @x402/evm's own registry (the scheme's default when a seller names nothing).
  const dir = new URL("../node_modules/@x402/evm/dist/esm/", import.meta.url);
  const chunk = readdirSync(dir).filter((f) => f.endsWith(".mjs")).map((f) => readFileSync(new URL(f, dir), "utf8")).find((t) => t.includes('"eip155:8453"') && t.includes("USD Coin"));
  ok(!!chunk, "@x402/evm's asset registry chunk was found by content (never by chunk filename)");
  for (const net of ["eip155:8453", "eip155:137", "eip155:42161"]) {
    const m = chunk && chunk.match(new RegExp(`"${net}": \\{\\s*address: "(0x[0-9a-fA-F]{40})",[^}]*?name: "([^"]+)"`));
    ok(m && m[1].toLowerCase() === USDC_DOMAIN_BY_NETWORK[net].asset && m[2] === USDC_DOMAIN_BY_NETWORK[net].name, `${net}: table matches @x402/evm's registry (${m?.[2]})`);
  }
  ok(Object.values(USDC_DOMAIN_BY_NETWORK).every((r) => r.asset === r.asset.toLowerCase() && /^0x[0-9a-f]{40}$/.test(r.asset)), "every table asset is a lower-cased 20-byte address");
}

// --- verdicts --------------------------------------------------------------------
{
  ok(usdcDomainVerdict(accept()).verdict === "matches", "Base accept naming \"USD Coin\" matches");
  const w = usdcDomainVerdict(accept({ extra: { name: "USDC", version: "2" } }));
  ok(w.verdict === "wrong_domain" && w.expectedName === "USD Coin" && w.advertisedName === "USDC" && w.chain === "Base", "Base accept naming \"USDC\" is wrong_domain, naming both names (HumanMirror's 402)");
  ok(usdcDomainVerdict(accept({ extra: { name: " usd coin ", version: "2" } })).verdict === "matches", "name comparison trims and ignores case");
  ok(usdcDomainVerdict(accept({ asset: BASE_USDC.toLowerCase(), extra: { name: "USDC" } })).verdict === "wrong_domain", "asset comparison ignores case");
  ok(usdcDomainVerdict(accept({ network: "eip155:42220", asset: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", extra: { name: "USDC" } })).verdict === "matches", "Celo USDC really is \"USDC\" - the name sellers copy to Base");
  ok(usdcDomainVerdict(accept({ network: "eip155:42220", asset: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", extra: { name: "USD Coin" } })).verdict === "wrong_domain", "and \"USD Coin\" on Celo is the mirror-image mistake");
  ok(usdcDomainVerdict(accept({ asset: "0x" + "ab".repeat(20), extra: { name: "USDC" } })).verdict === "unknown", "a different asset on Base (a seller's own token, a bridged USDC) is unknown, never refused");
  ok(usdcDomainVerdict(accept({ extra: { version: "2" } })).verdict === "unknown", "no extra.name is unknown (the client's registry supplies the default, which is right on every listed chain)");
  ok(usdcDomainVerdict(accept({ extra: { name: "" } })).verdict === "unknown", "an empty name is unknown");
  ok(usdcDomainVerdict(accept({ network: "eip155:1", asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", extra: { name: "USDC" } })).verdict === "unknown", "a chain not in the table is unknown (we never guess a domain)");
  ok(usdcDomainVerdict(null).verdict === "unknown" && usdcDomainVerdict({}).verdict === "unknown", "null / empty input is unknown, never a throw");
  // The index's stored observation shape ({asset, name}) is accepted with the network passed separately.
  ok(usdcDomainVerdict({ asset: BASE_USDC, name: "USDC" }, "eip155:8453").verdict === "wrong_domain", "the index's {asset, name} observation shape is read with the network passed beside it");
  ok(usdcDomainVerdict({ asset: BASE_USDC, name: "USD Coin" }, "eip155:8453").verdict === "matches", "...and a matching observation matches");
  const detail = usdcDomainMismatchDetail(w);
  ok(/"USDC"/.test(detail) && /"USD Coin"/.test(detail) && /nothing settles/.test(detail) && /this router included/.test(detail), "the detail sentence names both names and says the router itself cannot pay it");
}

// --- what the index stores from a 402 ---------------------------------------------
{
  const obs = evmDomainsOfAccepts([
    accept({ extra: { name: "USDC", version: "2" } }),
    accept({ network: "eip155:8453", extra: { name: "USD Coin" } }), // second Base entry: first wins
    accept({ network: "eip155:137", asset: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", extra: { name: "USD Coin" } }),
    { scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", extra: { feePayer: "x" } },
    accept({ network: "eip155:10", asset: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", extra: {} }),
    accept({ network: "eip155:42161", asset: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", extra: { name: "x".repeat(200) } }),
  ]);
  ok(obs["eip155:8453"]?.name === "USDC" && obs["eip155:8453"].asset === BASE_USDC, "the first Base accept's asset + name are recorded");
  ok(obs["eip155:137"]?.name === "USD Coin", "every EVM network with a named accept is recorded");
  ok(!("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" in obs), "non-EVM accepts are not recorded (no EIP-712 domain to speak of)");
  ok(!("eip155:10" in obs), "an accept with no name records nothing (unknown is not an observation)");
  ok(obs["eip155:42161"].name.length === 40, "a hostile name is bounded to 40 chars before it is stored");
  ok(Object.keys(evmDomainsOfAccepts(null)).length === 0 && Object.keys(evmDomainsOfAccepts([])).length === 0, "no accepts -> empty observation");
  ok(usdcDomainVerdict(obs["eip155:8453"], "eip155:8453").verdict === "wrong_domain", "the stored observation round-trips into the same verdict the live accept gave");
}

// --- the observation reaches the index rows and survives a crawl ---------------------
{
  const { bazaarItemToTool, carryForwardLearnedQuotes } = await import("../src/x402-index.js");
  const { quoteFromAccepts } = await import("../src/x402-live-quote.js");
  const t = bazaarItemToTool({ resource: "https://seller.example/api/x", accepts: [accept({ extra: { name: "USDC", version: "2" } })] }, "https://seller.example");
  ok(t?.evmDomainByNetwork?.["eip155:8453"]?.name === "USDC", "bazaarItemToTool (Bazaar + single-resource manifest path) records evmDomainByNetwork");
  ok(!("evmDomainByNetwork" in bazaarItemToTool({ resource: "https://seller.example/api/y", accepts: [{ scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", amount: "1000", payTo: "abc" }] }, "https://seller.example")), "a Solana-only row carries no evmDomainByNetwork key at all");
  ok(quoteFromAccepts([accept({ extra: { name: "USDC" } })])?.evmDomainByNetwork?.["eip155:8453"]?.name === "USDC", "quoteFromAccepts (the live-402 reader) carries evmDomainByNetwork");
  // A manifest-shaped rebuild has no accepts; the live read's observation rides the carry-forward.
  const prev = { tools: [{ method: "POST", route: "/api/x", price: 0.001, networks: ["eip155:8453"], networksVerifiedAt: Date.now() - 1000, quoteSource: "live-402", evmDomainByNetwork: { "eip155:8453": { asset: BASE_USDC, name: "USDC" } } }] };
  const cur = carryForwardLearnedQuotes([{ method: "POST", route: "/api/x", slug: "x", networks: ["eip155:8453"] }], prev)[0];
  ok(cur.evmDomainByNetwork?.["eip155:8453"]?.name === "USDC", "carry-forward keeps the live read's domain observation on the rebuilt row (the label would otherwise forget the seller every crawl)");
  const fresh = carryForwardLearnedQuotes([{ method: "POST", route: "/api/x", slug: "x", networks: ["eip155:8453"], evmDomainByNetwork: { "eip155:8453": { asset: BASE_USDC, name: "USD Coin" } } }], prev)[0];
  ok(fresh.evmDomainByNetwork["eip155:8453"].name === "USD Coin", "...but never overrides an observation this crawl made itself (a seller who fixed the accept is admitted on the next crawl)");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
