#!/usr/bin/env node
// Shared-wallet evidence is BOUND to the wallet it belongs to (2026-09-03).
//
// The x402 leaderboard groups origins by payTo, so an origin whose registry
// listing merely NAMES a heavily paid third-party wallet sits in that wallet's
// row and inherited its settled count. provenPayToMatches could not catch it:
// that belt binds an origin's OWN observed address, and the attacker's own
// address had no history ("unknown", which does not refuse). So the attacker
// cleared the Base floor on someone else's money and its live 402 named its
// own wallet. Now inherited evidence counts only when the origin's live 402
// pays one of the wallets it was inherited from (src/evidence-binding.js +
// dispatch-eligibility.js evidencePayToVerdict), the resolver runs that check
// on the probe's 402 before anything is signed, and the public label reads
// settlement_required for such an origin instead of eligible.
//
// Offline: a fake leaderboard row, fake 402s, no server, nothing spent.
import { readFileSync } from "node:fs";
import { buildEvidenceBinding, baseLiveGate } from "../src/evidence-binding.js";
import { dispatchEligibility, evidencePayToVerdict, DISPATCH_DETAILS, dispatchLegend } from "../src/dispatch-eligibility.js";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const W = "0x" + "aa".repeat(20); // the heavily paid wallet
const X = "0x" + "bb".repeat(20); // the attacker's own wallet
const HONEST = "https://honest.example";
const ATTACKER = "https://attacker.example";
const FLOORS = { minSettled: 50, minPayers: 3 };
const hdr = (payTo) => Buffer.from(JSON.stringify({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", asset: USDC, amount: "1000", payTo, maxTimeoutSeconds: 60 }] })).toString("base64");

// One leaderboard row keyed by W, listing both origins (the attacker's
// registry item named W as its payTo).
const row = { wallet: W, wallets: [W], origins: [HONEST, ATTACKER], homepage: HONEST, callsSettled: 5000, uniqueBuyers: 40 };
const binding = buildEvidenceBinding({ leaderboardRows: [row] });
ok(binding.get(HONEST)?.payTos.has(W) && binding.get(ATTACKER)?.payTos.has(W), "both origins on the shared row carry the row's wallet as the binding of their inherited evidence");
ok(binding.get(ATTACKER).ownSettled === 0 && binding.get(ATTACKER).ownPayers === undefined, "neither has evidence of its OWN from that row");

// The resolver's post-probe gate, fed the same numbers the pre-probe filter
// cleared them on (5000 settled / 40 payers, both inherited from W's row).
const gateFor = (origin, payTo, extra = {}) => baseLiveGate({ networks: ["eip155:8453"], settled: 5000, payers: 40, priceUsd: 0.01, ...FLOORS, binding: binding.get(origin), header: hdr(payTo), body: "{}", ...extra });
ok(gateFor(HONEST, W).ok === true, "honest origin: its live 402 pays W, the wallet the history belongs to -> paid");
const att = gateFor(ATTACKER, X);
ok(att.ok === false && att.detail === "evidence_payto_mismatch" && att.livePayTo === X && att.payTos.includes(W), "attacker origin on the same row: its live 402 pays X -> refused, detail evidence_payto_mismatch, naming both wallets");
ok(gateFor(ATTACKER, W).ok === true, "the attacker origin passes only by asking to be paid at W itself - then the money goes to the proven wallet, not the attacker");
const unreadable = baseLiveGate({ networks: ["eip155:8453"], settled: 5000, payers: 40, priceUsd: 0.01, ...FLOORS, binding: binding.get(ATTACKER), header: "not-a-402", body: "" });
ok(unreadable.ok === false && unreadable.detail === "evidence_payto_unverified" && unreadable.livePayTo === null, "an unreadable live payTo is NOT a match: inherited evidence stays unproven until the 402 names the wallet");
ok(baseLiveGate({ networks: ["eip155:8453"], settled: 5000, payers: 40, priceUsd: 0.01, ...FLOORS, binding: binding.get(ATTACKER), livePayTo: W.toUpperCase().replace("0X", "0x") }).ok === true, "the wallet compare is case-insensitive (EVM), and a pre-decoded livePayTo is accepted");
ok(baseLiveGate({ networks: ["eip155:8453"], settled: 5000, payers: 40, priceUsd: 0.01, ...FLOORS, binding: null, header: hdr(X), body: "{}" }).ok === true, "no binding on record (an origin absent from every shared source) leaves the gate as it was");

// OWN evidence keeps today's behavior: the seed or the chain join clearing the
// floor by itself means nothing about this origin was inherited.
const seeded = buildEvidenceBinding({ seedOrigins: { [ATTACKER]: 500 }, leaderboardRows: [row] });
ok(seeded.get(ATTACKER).ownSettled === 500 && baseLiveGate({ networks: ["eip155:8453"], settled: 5000, payers: 40, priceUsd: 0.01, ...FLOORS, binding: seeded.get(ATTACKER), livePayTo: X }).ok === true, "an origin the committed seed proves above the floor is not bound (its evidence is its own)");
const seededLow = buildEvidenceBinding({ seedOrigins: { [ATTACKER]: 10 }, leaderboardRows: [row] });
ok(baseLiveGate({ networks: ["eip155:8453"], settled: 5000, payers: 40, priceUsd: 0.01, ...FLOORS, binding: seededLow.get(ATTACKER), livePayTo: X }).ok === false, "a seed BELOW the floor does not unbind: the gate was cleared by the inherited count, so the binding applies");
const chainJoined = buildEvidenceBinding({ leaderboardRows: [row], chainProven: new Map([[HONEST, { settled: 600, payers: 9, payTo: W, source: "chain" }]]) });
ok(chainJoined.get(HONEST).ownSettled === 600 && chainJoined.get(HONEST).ownPayers === 9 && evidencePayToVerdict({ evidence: chainJoined.get(HONEST), livePayTo: null, ...FLOORS }).bound === false, "an origin the chain join proves on its OWN advertised address is not bound here (provenPayToMatches already binds that address)");
ok(evidencePayToVerdict({ evidence: buildEvidenceBinding({ chainProven: new Map([[HONEST, { settled: 600, payers: 1, payTo: W }]]) }).get(HONEST), livePayTo: null, ...FLOORS }).bound === true, "own evidence that fails the breadth floor does not count as clearing the gate (a count one wallet made is not own proof)");

// Bazaar quality arrives with the payTo each resource declares - bound the same way.
const bazaar = buildEvidenceBinding({ bazaarQuality: [[ATTACKER, { calls30d: 900, payers30d: 12, payTos: [W] }], [HONEST, { calls30d: 0, payers30d: 0, payTos: [X] }]] });
ok(bazaar.get(ATTACKER).payTos.has(W) && !bazaar.has(HONEST), "Bazaar quality with calls binds to the listed payTo; a zero-count entry contributes nothing");
ok(baseLiveGate({ networks: ["eip155:8453"], settled: 900, payers: 12, priceUsd: 0.01, ...FLOORS, binding: bazaar.get(ATTACKER), livePayTo: X }).detail === "evidence_payto_mismatch", "an origin cleared on Bazaar counts measured at W is refused when its live 402 pays X");
const rowNoWallets = { wallet: W, origins: [ATTACKER], callsSettled: 5000 };
ok(buildEvidenceBinding({ leaderboardRows: [rowNoWallets] }).get(ATTACKER).payTos.has(W), "a row with no `wallets` list falls back to its primary `wallet`");
ok(buildEvidenceBinding({ leaderboardRows: [{ wallet: "not-an-address", origins: [ATTACKER], callsSettled: 5000 }] }).get(ATTACKER).payTos.size === 0
  && baseLiveGate({ networks: ["eip155:8453"], settled: 5000, payers: 40, priceUsd: 0.01, ...FLOORS, binding: buildEvidenceBinding({ leaderboardRows: [{ wallet: "not-an-address", origins: [ATTACKER], callsSettled: 5000 }] }).get(ATTACKER), livePayTo: X }).ok === false,
  "inherited evidence with no readable wallet to bind to never clears the gate on its own");

// The public label: same function, the crawled advertised address standing in
// for the live 402. The attacker reads settlement_required, never eligible.
const label = (livePayTo) => dispatchEligibility({ routable: true, networks: ["eip155:8453"], settled: 5000, payers: 40, spendChains: ["base", "solana"], ...FLOORS, evidence: binding.get(ATTACKER), livePayTo });
ok(label(X).eligible === false && label(X).reason === "settlement_required" && label(X).chains.base.detail === "evidence_payto_mismatch", "label: an origin advertising a wallet other than the one its history came from reads settlement_required (evidence_payto_mismatch)");
ok(label(null).eligible === false && label(null).chains.base.detail === "evidence_payto_unverified", "label: an origin with inherited history and no readable own address reads settlement_required (evidence_payto_unverified)");
ok(label(W).eligible === true && label(W).reason === "eligible", "label: the honest origin (advertises W) reads eligible");
const unbound = dispatchEligibility({ routable: true, networks: ["eip155:8453"], settled: 5000, payers: 40, spendChains: ["base"], ...FLOORS });
ok(unbound.eligible === true, "a caller that passes no evidence gets the pre-binding verdict (every other caller is unchanged)");
ok(typeof DISPATCH_DETAILS.evidence_payto_mismatch === "string" && dispatchLegend().routerDispatchDetail.evidence_payto_mismatch === DISPATCH_DETAILS.evidence_payto_mismatch && dispatchLegend().routerDispatchDetail.evidence_payto_unverified, "both detail values are in the published legend");

// The call sites, pinned from source: a correct primitive that nothing calls
// would pass every assertion above.
{
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const fn = server.slice(server.indexOf("async function resolveExternalSeller("), server.indexOf("async function diagnoseExternalSeller("));
  ok(/const bindingByOrigin = buildEvidenceBindingByOrigin\(\)/.test(fn) && /binding: bindingByOrigin\.get\(norm\(r\.seller\)\)/.test(fn), "the resolver's Base branch reads the binding map onto every candidate");
  ok(/baseLiveGate\(\{[^\n]*binding: r\.binding, livePayTo: await readLivePayTo\(\)/.test(fn) && fn.indexOf("baseLiveGate({") > fn.indexOf("live = probe.status === 402"), "the resolver re-runs the labelled gate AFTER the probe with the candidate's binding and the live 402's payTo");
  ok(/if \(!gate\.ok\) \{[\s\S]{0,400}live = false;/.test(fn), "a failed binding gate drops the candidate (live = false), it is never paid");
  ok(/evidence: ev\.binding\.get\(origin\)/.test(server) && /livePayTo: \(typeof row\.payToByNetwork\?\.\["eip155:8453"\]/.test(server), "withDispatchFields labels rows with the binding and the advertised Base payTo");
  const settledFn = server.slice(server.indexOf("function buildEvidenceBindingByOrigin()"), server.indexOf("function buildEvidenceBindingByOrigin()") + 1500);
  ok(/leaderboardRows: getLeaderboardSnapshot\(\)\?\.leaderboard/.test(settledFn) && /bazaarQuality: bazaarQualityEntries\(\)/.test(settledFn) && /seedOrigins: SOR_SEED_ORIGINS/.test(settledFn), "the binding is built from the SAME three sources the settled/payers maps fold (leaderboard, Bazaar, seed) plus the chain join");
  const index = readFileSync(new URL("../src/x402-index.js", import.meta.url), "utf8");
  ok(/foldBazaarQuality\(qualityByOrigin, origin, item\.quality, t\?\.payToByNetwork\?\.\["eip155:8453"\]/.test(index), "the Bazaar quality fold keeps each counted resource's Base payTo beside the counts");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
