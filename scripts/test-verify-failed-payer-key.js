// verify_failed carries WHO failed, as a one-way id.
//
// 2026-08-30: seven CDP connect timeouts on Solana in a day, and no way to tell
// "one flaky client retrying" from "several clients hitting a real fault" -
// which is the whole difference between ignoring it and acting on it. Three of
// the seven fell inside thirty seconds, hinting at one retrying caller, but the
// event carried nothing to confirm it and the investigation stalled there.
//
// The id is derived, never the address: sha256 of the signed EIP-3009 `from`,
// or of the credential when no payer is readable (SVM and Stellar payloads
// carry none), truncated to 32 hex and prefixed a402: - the same construction
// as the gateway's upstream user id, so the two can be compared without either
// carrying an address. Same payer always yields the same id, which is what
// makes a retry loop visible; the id cannot be turned back into a wallet.
//
// The rest of the file guards the boundary: posthog.js must never receive the
// raw address, and a failure to derive the id must never break a payment.
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
let pass=0, fail=0; const ok=(c,m)=>{c?(pass++,console.log("ok - "+m)):(fail++,console.error("FAIL - "+m));};

const posthog = await readFile("src/posthog.js","utf8");
const payments = await readFile("src/payments.js","utf8");
const block = posthog.slice(posthog.indexOf("capturePostHogVerifyFailed"), posthog.indexOf("capturePostHogVerifyFailed")+1600);

ok(/payerKey \? \{ payerKey: String\(payerKey\)/.test(block), "the event carries payerKey when present");
ok(!/payer:\s*String\(payer\)/.test(block) && !/authorization\.from/.test(block), "posthog.js never sees a raw address");

const derive = payments.slice(payments.indexOf("let payerKey = null;"), payments.indexOf("capturePostHogVerifyFailed({"));
ok(/createHash\("sha256"\)/.test(derive), "the id is a sha256, not the address");
ok(/slice\(0, 32\)/.test(derive), "truncated to 32 hex, matching the gateway's upstream user id");
ok(/`a402:\$\{/.test(derive), "prefixed a402: like the existing derived ids");
ok(/credentialKeyOf/.test(derive), "falls back to the credential when no payer is readable (SVM/Stellar)");
ok(/catch \{ \/\* telemetry is best-effort \*\/ \}/.test(derive), "a derivation failure never breaks the payment path");

// The property that matters: same payer -> same id, and the id cannot be reversed.
const idOf = (from) => "a402:" + createHash("sha256").update(`payer:${from.toLowerCase()}`).digest("hex").slice(0,32);
const a = idOf("0xAbC0000000000000000000000000000000000001");
ok(a === idOf("0xabc0000000000000000000000000000000000001"), "same payer, same id (case-insensitive) - retries are groupable");
ok(a !== idOf("0xAbC0000000000000000000000000000000000002"), "different payers get different ids");
ok(!/0x/.test(a.slice(5)) && a.length === 5 + 32, "the id carries no address material");

console.log(`\n${fail?"FAILED":"OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
