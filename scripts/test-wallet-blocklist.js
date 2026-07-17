// Unit tests for the WALLET_BLOCKLIST payer matcher — the pure function behind
// the beforeSettle abort that refuses service to blocked wallets WITHOUT
// charging them. Env is read at call time, so each case just sets the var.
import { blockedPayerFromPayload } from "../src/payments.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

const EVM = "0xFedA7403aabe9A492eD70e810B396D8548A4A022";
const SOL = "9EMAayAfBR32J5d3ApEAG3NdKArRBtAqN7LA8c2WRM5o";
const ALGO = "ZKFACAZATPUUYUXVVVE7QWMMZTSMLGQVA4G4QKW7D2UI7FCIFE3QB2SHRE";
const evmPayload = { payload: { authorization: { from: EVM } } };

// Unset / empty → never blocks.
delete process.env.WALLET_BLOCKLIST;
ok(blockedPayerFromPayload(evmPayload) === null, "no env → null");
process.env.WALLET_BLOCKLIST = " , ,";
ok(blockedPayerFromPayload(evmPayload) === null, "whitespace/junk-only list → null");

// EVM: case-insensitive both directions (normalized to lowercase).
process.env.WALLET_BLOCKLIST = EVM; // checksum case in env
ok(blockedPayerFromPayload({ payload: { authorization: { from: EVM.toLowerCase() } } }) === EVM.toLowerCase(), "EVM blocked: lowercase payload vs checksum env");
ok(blockedPayerFromPayload(evmPayload) === EVM.toLowerCase(), "EVM blocked: checksum payload vs checksum env");
ok(blockedPayerFromPayload({ payload: { authorization: { from: "0x" + "1".repeat(40) } } }) === null, "different EVM wallet → null");

// Non-EVM payers match from the payload's payer field, case preserved.
process.env.WALLET_BLOCKLIST = `${SOL},${ALGO}`;
ok(blockedPayerFromPayload({ payload: { payer: SOL } }) === SOL, "Solana base58 payer blocked (payload.payload.payer)");
ok(blockedPayerFromPayload({ payer: ALGO }) === ALGO, "Algorand base32 payer blocked (payload.payer)");
ok(blockedPayerFromPayload(evmPayload) === null, "EVM wallet not in the non-EVM list → null");

// Defensive: shapes that carry no payer never match, never throw.
process.env.WALLET_BLOCKLIST = EVM;
ok(blockedPayerFromPayload({}) === null, "empty payload → null");
ok(blockedPayerFromPayload(undefined) === null, "missing payload → null");
ok(blockedPayerFromPayload({ payload: { authorization: { from: 42 } } }) === null, "non-string from → null");

delete process.env.WALLET_BLOCKLIST;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
