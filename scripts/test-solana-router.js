// The Solana external-routing leg: accept pinning, the env gate, the pay-time
// proven-seller gate (fail closed), balance status buckets, the chain
// mapping, and an OFFLINE end-to-end buy - a stub seller answers a real
// solana/exact 402 (extra.feePayer + extra.recentBlockhash, as real
// facilitator challenges carry) and a stub Solana RPC serves the USDC mint
// account, so the REAL @x402/svm scheme signs a real transaction with an
// ephemeral keypair and no network leaves the process.
import { strict as assert } from "node:assert";
import { createServer } from "node:http";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

// ---- 1. accept pinning --------------------------------------------------
{
  const { pickPayableAccept } = await import("../src/x402-buyer.js");
  const good = { network: MAINNET, scheme: "exact", asset: USDC, amount: "5000", payTo: "J7aN3PLJnTCF5qpEnvJHJsnCjcGuqC2rYtEM8Gv3xwg" };
  ok(pickPayableAccept([good], "solana") === good, "mainnet solana/exact/USDC accept is pinned");
  ok(pickPayableAccept([{ ...good, network: "solana" }], "solana") !== null, "bare v1 'solana' network label matches");
  ok(pickPayableAccept([{ ...good, network: DEVNET }], "solana") === null, "DEVNET accept never matches - different genesis, unsettleable payment");
  ok(pickPayableAccept([{ ...good, asset: "So11111111111111111111111111111111111111112" }], "solana") === null, "wrong mint (wSOL) is refused - only mainnet USDC is payable");
  ok(pickPayableAccept([{ ...good, scheme: "upto" }], "solana") === null, "non-exact scheme is refused");
  const decoy = { network: MAINNET, scheme: "exact", asset: "FakeMint1111111111111111111111111111111111", amount: "1", payTo: "x" };
  ok(pickPayableAccept([decoy, good], "solana") === good, "a cheap decoy first does not shadow the real USDC accept (F2)");
}

// ---- 2. chain mapping ---------------------------------------------------
{
  const { EXTERNAL_CHAIN_BY_NETWORK, externalChainsFor } = await import("../src/tools/route-execute.js");
  ok(EXTERNAL_CHAIN_BY_NETWORK[MAINNET] === "solana", "mainnet CAIP-2 maps to the solana spending chain");
  ok(!Object.keys(EXTERNAL_CHAIN_BY_NETWORK).some((k) => k.startsWith("solana:") && k !== MAINNET), "no devnet/testnet network ever maps to a spending wallet");
  ok(externalChainsFor(MAINNET, ["base", "solana"]).join(",") === "solana", "a Solana buyer routes to Solana sellers (self-funding, chain-matched)");
  ok(externalChainsFor(MAINNET, ["base"]).length === 0, "with no SVM wallet configured, a Solana buyer gets no external chain (409 upstream, never a cross-chain spend)");
}

// ---- 3. env gate --------------------------------------------------------
{
  delete process.env.SOLANA_UPSTREAM_BUYER_KEY;
  const { svmBuyerConfigured, getUpstreamBuyerSvm, svmBuyerStatus } = await import("../src/solana-buyer.js");
  ok(svmBuyerConfigured() === false, "no key = not configured");
  ok((await svmBuyerStatus()).status === "unconfigured", "status reports unconfigured, never a fabricated balance");
  const err = await getUpstreamBuyerSvm().then(() => null, (e) => e);
  ok(err && err.statusCode === 503 && /SOLANA_UPSTREAM_BUYER_KEY/.test(err.message), "unconfigured spend path 503s naming the env var");
}

// ---- 4. proven-seller gate (fail closed) --------------------------------
{
  const { solanaInboundCount, assertProvenSolanaSeller } = await import("../src/solana-buyer.js");
  const payTo = "J7aN3PLJnTCF5qpEnvJHJsnCjcGuqC2rYtEM8Gv3xwg";
  const now = Math.floor(Date.now() / 1000);
  // A stub that also serves getTransaction: `txs` maps signature -> a
  // {credit, funder} intent, from which we synthesize pre/postTokenBalances.
  // A credit raises the seller's ATA balance; the funder's USDC account is
  // debited. funder === payTo models a SELF-transfer (must NOT count).
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const rpcStub = (answers, txs = {}) => async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    if (method === "getTransaction") {
      const t = txs[params[0]];
      if (!t) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }), { status: 200 });
      const pre = [{ accountIndex: 0, mint: USDC, owner: payTo, uiTokenAmount: { amount: String(t.credit ? 0 : 100) } },
                   { accountIndex: 1, mint: USDC, owner: t.funder, uiTokenAmount: { amount: "1000" } }];
      const post = [{ accountIndex: 0, mint: USDC, owner: payTo, uiTokenAmount: { amount: String(t.credit ? 50 : 100) } },
                    { accountIndex: 1, mint: USDC, owner: t.funder, uiTokenAmount: { amount: t.credit ? "950" : "1000" } }];
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { meta: { err: null, preTokenBalances: pre, postTokenBalances: post } } }), { status: 200 });
    }
    const result = answers[method];
    if (result instanceof Error) return new Response("boom", { status: 500 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const noAccount = await solanaInboundCount(payTo, { fetchImpl: rpcStub({ getTokenAccountsByOwner: { value: [] } }) });
  ok(noAccount === 0, "a payTo with NO USDC account scores 0 - nobody has ever paid it");
  const sigs = [
    { signature: "a", blockTime: now - 60, err: null },   // credit from funder-1
    { signature: "b", blockTime: now - 120, err: null },  // credit from funder-2
    { signature: "self", blockTime: now - 90, err: null },// SELF-transfer - must not count
    { signature: "out", blockTime: now - 90, err: null }, // outbound (debit) - must not count
    { signature: "c", blockTime: now - 60, err: { InstructionError: [] } }, // failed tx - filtered before read
    { signature: "d", blockTime: now - 40 * 3600, err: null },              // 40h ago: INSIDE the 7d window now (was outside at 15h)
    { signature: "old", blockTime: now - 8 * 24 * 3600, err: null },        // 8 days ago: OUTSIDE the 7d window - a credit here must NOT count
  ];
  const txs = {
    a: { credit: true, funder: "FACILITATORshared1111111111111111111111111" },
    b: { credit: true, funder: "FACILITATORshared1111111111111111111111111" }, // SAME facilitator - must STILL count (2, not 1)
    d: { credit: true, funder: "FUNDERddddddddddddddddddddddddddddddddddd1" }, // 40h ago, inside 7d -> counts (window widened from 15h)
    old: { credit: true, funder: "FUNDERoooooooooooooooooooooooooooooooooo1" }, // 8d ago, outside 7d -> excluded by the window filter
    self: { credit: true, funder: payTo },   // seller funding itself
    out: { credit: false, funder: "FUNDERaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1" }, // debit
  };
  const counted = await solanaInboundCount(payTo, {
    fetchImpl: rpcStub({ getTokenAccountsByOwner: { value: [{ pubkey: "ATA111" }] }, getSignaturesForAddress: sigs }, txs),
  });
  ok(counted === 3, "counts direction-verified CREDITS inside the 7d window (a, b, d) - self-transfer/outbound excluded, a shared facilitator sender still counts, and the 8-day-old credit is outside the window");
  // 20 self-transfers = the cheap spoof the review flagged; they all have funder === payTo.
  const spoofSigs = Array.from({ length: 20 }, (_, i) => ({ signature: `s${i}`, blockTime: now - 60, err: null }));
  const spoofTxs = Object.fromEntries(spoofSigs.map((x) => [x.signature, { credit: true, funder: payTo }]));
  const spoof = await solanaInboundCount(payTo, {
    fetchImpl: rpcStub({ getTokenAccountsByOwner: { value: [{ pubkey: "ATA111" }] }, getSignaturesForAddress: spoofSigs }, spoofTxs),
  });
  ok(spoof === 0, "20 self-transfers do NOT prove a seller - the seller funding its own payTo is excluded, so the cheap spoof scores 0");
  const rpcDead = await solanaInboundCount(payTo, { fetchImpl: rpcStub({}) }).then(() => null, (e) => e);
  ok(rpcDead === null || rpcDead instanceof Error, "an unreadable chain THROWS from the counter");
  const gateDead = await assertProvenSolanaSeller(payTo, { inboundFn: async () => { throw new Error("rpc down"); } }).then(() => null, (e) => e);
  ok(gateDead && gateDead.statusCode === 503 && /refusing to spend/.test(gateDead.message), "gate FAILS CLOSED on an unreadable chain (503, nothing signed)");
  const below = await assertProvenSolanaSeller(payTo, { inboundFn: async () => 3, minCount: 20 }).then(() => null, (e) => e);
  ok(below && below.statusCode === 409 && /floor 20/.test(below.message), "a seller under the credit floor is refused 409 with the floor named");
  ok((await assertProvenSolanaSeller(payTo, { inboundFn: async () => 25, minCount: 20 })) === 25, "a seller at/over the credit floor passes and the count is returned");
  const junk = await solanaInboundCount("not-an-address!!", { fetchImpl: rpcStub({}) }).then(() => null, (e) => e);
  ok(junk instanceof Error, "a junk payTo is refused before any RPC call");
}

// ---- 5. configured wallet: status buckets + OFFLINE e2e buy --------------
{
  const kit = await import("@solana/kit");
  const keypairBytes = new Uint8Array(64);
  const gen = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", gen.privateKey));
  const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", gen.publicKey));
  keypairBytes.set(pkcs8.slice(pkcs8.length - 32), 0); // seed
  keypairBytes.set(rawPub, 32);
  process.env.SOLANA_UPSTREAM_BUYER_KEY = JSON.stringify([...keypairBytes]);

  // Stub Solana RPC: serves the USDC mint account (SPL mint layout, decimals
  // 6, owned by the token program) so the real scheme's fetchMint works with
  // zero real network. getLatestBlockhash is deliberately ABSENT: the accept
  // carries extra.recentBlockhash, so signing must not need it.
  const mintData = Buffer.alloc(82);
  mintData.writeUInt8(6, 44); // decimals
  mintData.writeUInt8(1, 45); // isInitialized
  const rpcSrv = createServer((req, res) => {
    let buf = "";
    req.on("data", (d) => (buf += d));
    req.on("end", () => {
      const { method, id } = JSON.parse(buf);
      const reply = (result) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id, result })); };
      if (method === "getAccountInfo") {
        reply({ context: { slot: 1 }, value: { data: [mintData.toString("base64"), "base64"], executable: false, lamports: 1000000, owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", rentEpoch: 0, space: 82 } });
      } else if (method === "getTokenAccountsByOwner") {
        reply({ value: [{ pubkey: "ATA111", account: { data: { parsed: { info: { tokenAmount: { uiAmount: 4.2 } } } } } }] });
      } else {
        res.statusCode = 500; res.end("{}");
      }
    });
  });
  await new Promise((r) => rpcSrv.listen(0, "127.0.0.1", r));
  process.env.SOLANA_RPC_URL = `http://127.0.0.1:${rpcSrv.address().port}`;

  const { svmBuyerStatus, getUpstreamBuyerSvm } = await import("../src/solana-buyer.js");
  const { address } = await getUpstreamBuyerSvm();
  ok(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address), `spending wallet derives a plausible address (${address.slice(0, 8)}…)`);
  ok((await svmBuyerStatus()).status === "ok", "status 'ok' when the USDC balance clears the low-water mark");
  process.env.SOLANA_UPSTREAM_BUYER_LOW_USD = "10";
  ok((await svmBuyerStatus()).status === "low", "status 'low' under the low-water mark");
  delete process.env.SOLANA_UPSTREAM_BUYER_LOW_USD;

  // Stub seller: bare request -> 402 with a real solana/exact accept; a
  // request carrying a payment header -> 200 + the header captured.
  const sellerPayTo = "J7aN3PLJnTCF5qpEnvJHJsnCjcGuqC2rYtEM8Gv3xwg";
  let seenPayment = null;
  const seller = createServer((req, res) => {
    const pay = req.headers["payment-signature"] || req.headers["x-payment"];
    if (!pay) {
      const accepts = [{
        scheme: "exact", network: MAINNET, asset: USDC, amount: "5000",
        payTo: sellerPayTo, maxTimeoutSeconds: 60, resource: "http://stub/thing",
        description: "stub", mimeType: "application/json",
        extra: { feePayer: "8Y9wxHqJt3mfMUv7pQnBRZUKGdCwjrLBGWtaeu6AGFfe", recentBlockhash: "GfVcyD4kkTrj4bKc7WA9sZCin9JDbdT4Zkd3EittNR1W", lastValidBlockHeight: "250000000" },
      }];
      res.statusCode = 402;
      // v2 wire shape: the challenge rides the PAYMENT-REQUIRED header
      // (base64 JSON), body {} - the same shape our own paywall serves.
      res.setHeader("payment-required", Buffer.from(JSON.stringify({ x402Version: 2, error: "payment required", accepts })).toString("base64"));
      res.setHeader("content-type", "application/json");
      res.end("{}");
      return;
    }
    seenPayment = String(pay);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ okFromSeller: true }));
  });
  await new Promise((r) => seller.listen(0, "127.0.0.1", r));
  const sellerUrl = `http://127.0.0.1:${seller.address().port}/thing`;

  const { payX402 } = await import("../src/x402-buyer.js");
  let proofChecked = null;
  const out = await payX402(sellerUrl, {
    maxAtomic: "10000", chain: "solana", trusted: true,
    sellerProof: async (payTo) => { proofChecked = payTo; return 25; },
  });
  ok(out?.result?.okFromSeller === true, "OFFLINE e2e: the real @x402/svm scheme signed and the seller served the paid request");
  ok(proofChecked === sellerPayTo, "the proven-seller gate ran against the accept's OWN payTo before signing");
  ok(out.quote?.usd === 0.005 && out.quote?.network === MAINNET, "receipt quote carries the atomic amount and mainnet network");
  {
    const decoded = JSON.parse(Buffer.from(seenPayment, "base64").toString("utf8"));
    const txB64 = decoded?.payload?.transaction;
    ok(typeof txB64 === "string" && Buffer.from(txB64, "base64").length > 200, "payment header carries a real signed wire transaction");
  }

  // A seller failing the proof gate gets NOTHING signed.
  seenPayment = null;
  const refused = await payX402(sellerUrl, {
    maxAtomic: "10000", chain: "solana", trusted: true,
    sellerProof: async () => { const e = new Error("Seller payTo has 0 recent inbound USDC transfers on Solana (floor 20) - not routable yet"); e.statusCode = 409; throw e; },
  }).then(() => null, (e) => e);
  ok(refused && refused.statusCode === 409 && seenPayment === null, "an unproven seller is refused BEFORE signing - no payment header ever leaves");

  seller.close(); rpcSrv.close();
}

// ---- 6. resolve-time gate: skip, never abort --------------------------
{
  const { passesSolanaResolveGate } = await import("../src/solana-buyer.js");
  const mk = (accepts) => Buffer.from(JSON.stringify({ x402Version: 2, accepts })).toString("base64");
  const payTo = "J7aN3PLJnTCF5qpEnvJHJsnCjcGuqC2rYtEM8Gv3xwg";
  const solAccept = { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", payTo };
  const proven = await passesSolanaResolveGate({ header: mk([solAccept]), inboundFn: async () => 50 });
  ok(proven.ok === true && proven.payTo === payTo, "a proven candidate passes the resolve-time gate with its payTo named");
  const thin = await passesSolanaResolveGate({ header: mk([solAccept]), inboundFn: async () => 2, minCount: 20 });
  ok(thin.ok === false && /floor 20/.test(thin.reason), "an unproven candidate is SKIPPED with the count in the reason - never an abort");
  const dead = await passesSolanaResolveGate({ header: mk([solAccept]), inboundFn: async () => { throw new Error("rpc down"); } });
  ok(dead.ok === false && /chain unreadable/.test(dead.reason), "an unreadable chain skips the candidate (fail closed at resolve time too)");
  const noSol = await passesSolanaResolveGate({ header: mk([{ network: "eip155:8453", payTo: "0xabc" }]), inboundFn: async () => 99 });
  ok(noSol.ok === false && /no readable solana accept/.test(noSol.reason), "a 402 with no solana accept is not a candidate");
  const junkHdr = await passesSolanaResolveGate({ header: "!!!not-base64!!!", inboundFn: async () => 99 });
  ok(junkHdr.ok === false, "an unreadable challenge is skipped, never thrown");
  const v1Body = await passesSolanaResolveGate({ header: null, body: JSON.stringify({ accepts: [solAccept] }), inboundFn: async () => 50 });
  ok(v1Body.ok === true, "a v1 body-carried challenge parses too");
}

// --- the payload carries `accepted` (2026-09-01) ---------------------------
// A hand-built SVM payload MUST echo back the requirement it satisfies as
// `accepted`; without it the seller's facilitator throws `unexpected_verify_error`
// (the scheme client always includes it). Verify-critical, so pin it. No RPC:
// the builder reads extra.recentBlockhash and signs offline.
{
  const { createSvmPaymentPayload } = await import("../src/solana-buyer.js");
  const kit = await import("@solana/kit");
  const signer = await kit.generateKeyPairSigner();
  const req = {
    scheme: "exact",
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    amount: 1000,
    payTo: "AQqnMFBwGZEoti85aTVRy8XYpKrho7GaMDx9ZB3CEeKA",
    maxTimeoutSeconds: 300,
    asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    extra: { feePayer: "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4", recentBlockhash: "EeS7HKiDAu8hmSDrcNXa3nnCVEgDG9hygkFByy1E6Aon", lastValidBlockHeight: "421572519" },
  };
  const p = await createSvmPaymentPayload(signer, { x402Version: 2, accepts: [req] });
  ok(p.accepted && p.accepted.network === req.network && String(p.accepted.amount) === "1000" && p.accepted.payTo === req.payTo && p.accepted.asset === req.asset,
    "the payload echoes `accepted` (network/amount/payTo/asset) - the field the facilitator matches against");
  ok(p.accepted.extra && p.accepted.extra.feePayer === req.extra.feePayer,
    "`accepted.extra` carries the feePayer/blockhash the facilitator needs");
  ok(p.payload && typeof p.payload.transaction === "string" && p.payload.transaction.length > 0,
    "the payload still carries the signed base64 wire transaction");
}

console.log(fail ? `FAILED: ${pass} passed, ${fail} failed` : `OK: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
