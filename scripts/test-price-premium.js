#!/usr/bin/env node
// Offline test for the per-chain price premium engine in src/payments.js.
//
// The rule it implements: anything settled through a fee-charging facilitator
// must be priced to cover the fee. The failure modes worth pinning are all
// silent-money bugs: a premium leaking onto fee-free rails (overcharging every
// buyer), float arithmetic inventing dust ($0.0020000000000000005 breaks
// byte-exact quote matching), a malformed config quoting below cost, and the
// dormant default not being byte-identical to the pre-engine behavior.
import { strict as assert } from "node:assert";
import { parseNetworkPremiums, priceWithPremium, acceptsForItem } from "../src/payments.js";

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

console.log("per-chain price premiums");

check("unset config -> empty map -> every price passes through untouched", () => {
  const p = parseNetworkPremiums("");
  assert.equal(p.size, 0);
  assert.equal(priceWithPremium("$0.001", "eip155:10", p), "$0.001");
});

check("configured chain gets exactly the premium, others do not", () => {
  const p = parseNetworkPremiums("eip155:10=0.001,eip155:130=0.002");
  assert.equal(priceWithPremium("$0.001", "eip155:10", p), "$0.002");
  assert.equal(priceWithPremium("$0.001", "eip155:130", p), "$0.003");
  assert.equal(priceWithPremium("$0.001", "eip155:8453", p), "$0.001", "fee-free Base must never carry a premium");
});

check("money arithmetic is exact — no float dust", () => {
  const p = parseNetworkPremiums("eip155:10=0.001");
  assert.equal(priceWithPremium("$0.002", "eip155:10", p), "$0.003");
  assert.equal(priceWithPremium("$0.1", "eip155:10", p), "$0.101");
  assert.equal(priceWithPremium("$0.50", "eip155:10", p), "$0.501");
  // the classic: 0.1 + 0.2 style dust must not appear
  assert.ok(!/000000|999999/.test(priceWithPremium("$0.29", "eip155:10", p)));
});

check("negative and malformed entries are refused, never quoted below cost", () => {
  const p = parseNetworkPremiums("eip155:10=-0.001,garbage,eip155:130=abc,eip155:480=0.001");
  assert.equal(p.has("eip155:10"), false, "negative premium must be refused");
  assert.equal(p.has("eip155:130"), false, "non-numeric premium must be refused");
  assert.equal(p.get("eip155:480"), 1000, "the valid entry still parses");
});

check("an unparseable price passes through unchanged rather than quoting NaN", () => {
  const p = parseNetworkPremiums("eip155:10=0.001");
  assert.equal(priceWithPremium("weird", "eip155:10", p), "weird");
  assert.equal(priceWithPremium(undefined, "eip155:10", p), undefined);
});

check("dormant default: acceptsForItem output is byte-identical to pre-engine", () => {
  // No NETWORK_PRICE_PREMIUMS in the environment -> the engine must be
  // invisible. This is the guard that today's deploy changes nothing.
  assert.equal(process.env.NETWORK_PRICE_PREMIUMS || "", "", "test assumes a clean env");
  const rails = {
    evmCaip2: ["eip155:8453", "eip155:42220"], svmCaip2: ["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"],
    stellarCaip2: [], avmCaip2: [], walletAddress: "0xw", solanaWallet: "So1",
  };
  const a = acceptsForItem({ slug: "x", price: "$0.001" }, rails);
  assert.deepEqual(a, [
    { scheme: "exact", payTo: "0xw", price: "$0.001", network: "eip155:8453" },
    { scheme: "exact", payTo: "0xw", price: "$0.001", network: "eip155:42220" },
    { scheme: "exact", payTo: "So1", price: "$0.001", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" },
  ]);
});

console.log(failures ? `\nFAILED (${failures})` : "\nall passed");
process.exit(failures ? 1 : 0);
