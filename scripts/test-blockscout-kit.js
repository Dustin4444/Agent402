// Blockscout kit — offline unit tests. No network, no spend: pins the chain
// resolver, input validation, the margin-guard ceiling, and the keyless-503
// behavior (a fresh clone must refuse to sell what it can't source).
//   node scripts/test-blockscout-kit.js
import { BLOCKSCOUT_TOOLS, BLOCKSCOUT_CHAINS, blockscoutChainId, upstreamQuoteAcceptable, UPSTREAM_MAX_ATOMIC } from "../src/tools/blockscout-kit.js";

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`ok - ${msg}`); }
  else { failed++; console.error(`FAIL - ${msg}`); }
};

// --- chain resolver --------------------------------------------------------
ok(blockscoutChainId("base") === "8453", "base → 8453");
ok(blockscoutChainId("ETHEREUM") === "1", "case-insensitive name → 1");
ok(blockscoutChainId("42220") === "42220", "numeric id passes through");
ok(blockscoutChainId(undefined) === "8453", "default chain is base");
ok(Object.values(BLOCKSCOUT_CHAINS).every((v) => Number.isInteger(v)), "chain map values are integers");
for (const badChain of ["dogecoin", "8453; DROP", "-5", "1e9", ""]) {
  let threw = null;
  try { blockscoutChainId(badChain); } catch (e) { threw = e; }
  // "" falls back to default; the rest must 400
  if (badChain === "") ok(threw === null, 'empty chain falls back to default');
  else ok(threw?.statusCode === 400, `chain "${badChain}" → 400`);
}

// --- margin guard ----------------------------------------------------------
ok(upstreamQuoteAcceptable("2000"), "$0.002 quote accepted");
ok(upstreamQuoteAcceptable(String(UPSTREAM_MAX_ATOMIC)), "exact ceiling accepted");
ok(!upstreamQuoteAcceptable("5001"), "one atomic over ceiling refused");
ok(!upstreamQuoteAcceptable("999999999"), "huge repricing refused");
ok(!upstreamQuoteAcceptable("not-a-number"), "garbage quote refused");
ok(!upstreamQuoteAcceptable(""), "empty quote refused");

// --- tool shape + keyless refusal -----------------------------------------
ok(BLOCKSCOUT_TOOLS.length === 5, "five tools exported");
for (const t of BLOCKSCOUT_TOOLS) {
  ok(!!t.discovery?.input && !!t.discovery?.inputSchema, `${t.slug}: discovery example present`);
  ok(/untrustedContent/.test(t.description), `${t.slug}: description carries the provenance warning`);
  ok(/x402/.test(t.description), `${t.slug}: description discloses the paid upstream`);
}
const profile = BLOCKSCOUT_TOOLS.find((t) => t.slug === "address-profile");
const source = BLOCKSCOUT_TOOLS.find((t) => t.slug === "contract-inspect");

// invalid address → 400 before any network/spend
for (const t of [profile, source]) {
  let threw = null;
  try { await t.handler({ chain: "base", address: "nope" }); } catch (e) { threw = e; }
  ok(threw?.statusCode === 400, `${t.slug}: invalid address → 400 (no spend attempted)`);
}

// keyless boot → 503 self-explaining (CI has no X402_UPSTREAM_BUYER_KEY)
delete process.env.X402_UPSTREAM_BUYER_KEY;
let threw = null;
try { await profile.handler({ chain: "base", address: "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0" }); } catch (e) { threw = e; }
ok(threw?.statusCode === 503 && /X402_UPSTREAM_BUYER_KEY/.test(threw?.message || ""), "keyless → 503 naming the missing config");

// --- upstream buyer status (keyless → unconfigured, never throws) ----------
const { upstreamBuyerStatus } = await import("../src/tools/blockscout-kit.js");
const st = await upstreamBuyerStatus();
ok(st.configured === false && st.status === "unconfigured", "keyless upstreamBuyerStatus → unconfigured");

// --- new Blockscout tools (token-info / token-holders / tx-inspect) ---------
{
  const bySlug = (s) => BLOCKSCOUT_TOOLS.find((t) => t.slug === s);
  for (const slug of ["token-info", "token-holders", "tx-inspect"]) {
    const t = bySlug(slug);
    ok(!!t, `${slug} exists`);
    ok(/x402/.test(t.description) && /untrustedContent/.test(t.description), `${slug}: discloses paid upstream + provenance`);
    ok(!!t.discovery?.input && !!t.discovery?.inputSchema, `${slug}: has discovery example`);
  }
  ok(BLOCKSCOUT_TOOLS.length === 5, `five blockscout tools now (got ${BLOCKSCOUT_TOOLS.length})`);
  // invalid inputs 400 before any spend
  const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
  ok((await threw(() => bySlug("token-info").handler({ chain: "base", address: "nope" })))?.statusCode === 400, "token-info: bad address → 400");
  ok((await threw(() => bySlug("token-holders").handler({ chain: "base", address: "0x" })))?.statusCode === 400, "token-holders: bad address → 400");
  ok((await threw(() => bySlug("tx-inspect").handler({ chain: "base", hash: "0xshort" })))?.statusCode === 400, "tx-inspect: bad hash → 400");
}

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);