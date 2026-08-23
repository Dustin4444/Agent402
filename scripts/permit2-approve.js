// One-time Permit2 approval so the canary burner can pay over `upto`.
//
// WHY THIS IS NOT AUTOMATIC. Every Base payment this wallet has ever made was
// `exact` over EIP-3009 transferWithAuthorization: the buyer signs, the
// FACILITATOR broadcasts, and the buyer never needs native gas. That is why the
// burner holds USDC and zero ETH.
//
// `upto` settles through Permit2 instead, and Permit2 needs a normal ERC-20
// approval from the OWNER - a real transaction, sent by this wallet, paid for
// in ETH. So a wallet that has happily bought on Base for months still cannot
// make its first metered payment until it holds a little ETH.
//
// DRY RUN unless LIVE=true.
import { createPublicClient, createWalletClient, http, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { createPermit2ApprovalTx, getPermit2AllowanceReadParams } from "@x402/evm/upto/client";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RPC = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const live = String(process.env.LIVE || "").toLowerCase() === "true";
const die = (m) => { console.error(`permit2-approve: ${m}`); process.exit(2); };

const pk = (process.env.BURNER_KEY || "").trim();
if (!pk) die("no BURNER_KEY");
const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);

const pub = createPublicClient({ chain: base, transport: http(RPC) });
console.log(`owner: ${account.address}`);

const allowance = await pub.readContract(getPermit2AllowanceReadParams({ tokenAddress: USDC, ownerAddress: account.address }));
console.log(`current Permit2 allowance: ${allowance}`);
if (BigInt(allowance) > 0n) {
  console.log("PASS - already approved, nothing to do (this script is idempotent by design).");
  process.exit(0);
}

const eth = await pub.getBalance({ address: account.address });
const gasPrice = await pub.getGasPrice();
console.log(`ETH on Base: ${formatEther(eth)}   gas price: ${gasPrice} wei`);

const tx = createPermit2ApprovalTx({ tokenAddress: USDC });
let gas;
try {
  gas = await pub.estimateGas({ account: account.address, to: tx.to, data: tx.data });
} catch (e) {
  die(`could not estimate the approval (${String(e?.message || e).slice(0, 160)})`);
}
const cost = gas * gasPrice;
console.log(`approval gas: ${gas}  cost: ${formatEther(cost)} ETH`);

if (eth < cost * 2n) {
  die(`the wallet holds ${formatEther(eth)} ETH and the approval costs about ${formatEther(cost)} ETH. ` +
      `Send it a little ETH on Base (0.0005 covers this hundreds of times over). ` +
      `It has none because every Base payment it has made was gasless EIP-3009, where the facilitator pays.`);
}

if (!live) {
  console.log("DRY RUN (set LIVE=true to send the approval).");
  process.exit(0);
}

const wallet = createWalletClient({ account, chain: base, transport: http(RPC) });
const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data });
console.log(`sent ${hash}`);
const receipt = await pub.waitForTransactionReceipt({ hash });
console.log(`status: ${receipt.status}  gasUsed: ${receipt.gasUsed}`);
if (receipt.status !== "success") die("the approval reverted");

const after = await pub.readContract(getPermit2AllowanceReadParams({ tokenAddress: USDC, ownerAddress: account.address }));
console.log(`allowance now: ${after}`);
if (BigInt(after) <= 0n) die("the approval landed but the allowance is still zero");
console.log("PASS - Permit2 approved; the burner can now sign upto payments.");
