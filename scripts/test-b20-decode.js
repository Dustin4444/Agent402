// Offline unit tests for the b20-kit log-decoding helpers. Synthetic logs in
// BOTH plausible indexed layouts (the official B20 ABI's indexed-ness is
// unpublished) — no network.
import { B20_INTERNALS } from "../src/tools/b20-kit.js";

const { TOPIC_TRANSFER, TOPIC_MEMO, TOPIC_B20_CREATED, findB20Address, decodeTransfer, memoWord, memoText, logIndexNum } = B20_INTERNALS;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

const pad = (hex) => "0x" + hex.replace(/^0x/, "").padStart(64, "0");
const B20_ADDR = "0xb200000000000000000000000000000000000abc";
const EOA = "0x1111111111111111111111111111111111111111";
const EOA2 = "0x2222222222222222222222222222222222222222";

// topic constants are 32-byte hashes
ok(/^0x[0-9a-f]{64}$/.test(TOPIC_TRANSFER), "TOPIC_TRANSFER is a 32-byte hash");
ok(/^0x[0-9a-f]{64}$/.test(TOPIC_MEMO), "TOPIC_MEMO is a 32-byte hash");
ok(/^0x[0-9a-f]{64}$/.test(TOPIC_B20_CREATED), "TOPIC_B20_CREATED is a 32-byte hash");
ok(TOPIC_TRANSFER === "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", "TOPIC_TRANSFER matches the canonical ERC-20 Transfer topic");

// findB20Address: layout A — token address indexed (topic 1)
ok(findB20Address({ topics: [TOPIC_B20_CREATED, pad(B20_ADDR)], data: "0x" }) === B20_ADDR,
  "findB20Address finds an indexed 0xb200 address");
// layout B — token address in data, after another word
ok(findB20Address({ topics: [TOPIC_B20_CREATED], data: "0x" + pad(EOA).slice(2) + pad(B20_ADDR).slice(2) }) === B20_ADDR,
  "findB20Address finds a data-word 0xb200 address (skipping non-B20 words)");
// no B20 address anywhere -> null
ok(findB20Address({ topics: [TOPIC_B20_CREATED, pad(EOA)], data: "0x" }) === null,
  "findB20Address returns null when no 0xb200 word exists");
// word that merely CONTAINS b200 mid-string but is not address-shaped -> null
ok(findB20Address({ topics: [TOPIC_B20_CREATED], data: pad("0xffb200000000000000000000000000000000000abc") }) === null,
  "findB20Address ignores non-address-shaped words");

// decodeTransfer: canonical (from/to indexed, value in data)
let t = decodeTransfer({ topics: [TOPIC_TRANSFER, pad(EOA), pad(EOA2)], data: pad("0x64") });
ok(t && t.from === EOA && t.to === EOA2 && t.value === "100", "decodeTransfer canonical layout");
// non-indexed fallback (all three in data)
t = decodeTransfer({ topics: [TOPIC_TRANSFER], data: "0x" + pad(EOA).slice(2) + pad(EOA2).slice(2) + pad("0x64").slice(2) });
ok(t && t.from === EOA && t.to === EOA2 && t.value === "100", "decodeTransfer non-indexed fallback");
ok(decodeTransfer({ topics: [TOPIC_TRANSFER], data: "0x" }) === null, "decodeTransfer returns null on undecodable log");

// memoWord: layout A — memo in data
const MEMO_HEX = "0x" + Buffer.from("invoice-42").toString("hex").padEnd(64, "0");
ok(memoWord({ topics: [TOPIC_MEMO, pad(EOA)], data: MEMO_HEX }) === MEMO_HEX, "memoWord takes the data word when present");
// layout B — memo indexed (last topic), empty data
ok(memoWord({ topics: [TOPIC_MEMO, pad(EOA), MEMO_HEX], data: "0x" }) === MEMO_HEX, "memoWord falls back to the last topic");
ok(memoWord({ topics: [TOPIC_MEMO], data: "0x" }) === null, "memoWord returns null when no candidate word");
// layout C — memo indexed, sender address in data (disambiguated by shape)
ok(memoWord({ topics: [TOPIC_MEMO, MEMO_HEX], data: pad(EOA) }) === MEMO_HEX, "memoWord prefers a non-address-shaped topic over an address-shaped data word");

// memoText: printable, binary, all-zero
ok(memoText(MEMO_HEX) === "invoice-42", "memoText decodes printable UTF-8 and trims NUL padding");
ok(memoText("0x" + "00".repeat(32)) === null, "memoText returns null for all-zero memo");
ok(memoText("0x" + "fe".repeat(32)) === null, "memoText returns null for non-UTF-8 bytes");

// logIndexNum
ok(logIndexNum("0x1f") === 31, "logIndexNum parses hex quantities");
ok(logIndexNum(undefined) === -1 && logIndexNum("junk") === -1, "logIndexNum returns -1 on malformed input instead of throwing");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
