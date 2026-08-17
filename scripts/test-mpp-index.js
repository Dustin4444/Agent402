// Offline unit tests for the MPP index: origin validation (reused from the
// x402 side - protocol-agnostic) + the registerMppOrigin flow with an
// injected fake verifier + the snapshot honesty invariant. No network, no /data.
import {
  validateOriginInput, registerMppOrigin, mppIndexSnapshot,
  __testResetSubmitted, __testSetSubmittedCap, __testReset,
} from "../src/mpp-index.js";
import { isMppChallenge } from "../src/x402-index.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

// --- validation (same rules as the x402 side - shared, not duplicated) ---
ok(validateOriginInput("https://example.com").origin === "https://example.com", "plain https origin accepted");
ok(validateOriginInput("http://example.com").error != null, "http rejected");
ok(validateOriginInput("https://example.com/api").error != null, "path rejected (the mpp.orthogonal.com gateway-tenant gap)");
ok(validateOriginInput("not a url").error != null, "garbage rejected");

// --- isMppChallenge (reused, not reimplemented - pin the contract this module depends on) ---
ok(isMppChallenge("Payment realm=\"api.example.com\"") === true, "isMppChallenge: leading Payment token accepted");
ok(isMppChallenge("Bearer token") === false, "isMppChallenge: non-Payment scheme rejected");
ok(isMppChallenge(null) === false, "isMppChallenge: null header rejected");
ok(isMppChallenge("") === false, "isMppChallenge: empty header rejected");

// --- registerMppOrigin with an injected verifier ---
__testReset();
let verified = [];
const goodVerify = async (o) => {
  verified.push(o);
  return { origin: o, name: "Ext", description: "test", categories: ["data"], verified: true, verifiedAt: Date.now(), lastProbeError: null };
};
const badVerify = async (o) => {
  verified.push(o);
  return { origin: o, verified: false, lastProbeError: "no WWW-Authenticate: Payment challenge on the probed endpoint" };
};

let r = await registerMppOrigin("https://newseller.example", { verify: goodVerify });
ok(r.listed === true && r.origin === "https://newseller.example", "successful probe lists the origin");
ok(r.seller && r.seller.verified === true, "response carries a verified seller summary");
ok(verified.length === 1, "verifier invoked once for unknown origin");

r = await registerMppOrigin("https://deadseller.example", { verify: badVerify });
ok(r.listed === false && typeof r.error === "string", "failed probe returns an honest error, not listed");
ok(/WWW-Authenticate/.test(r.error), "error names the actual missing signal, not a generic failure");

// --- submission cap (same shape as the x402 side) ---
__testResetSubmitted();
__testSetSubmittedCap(1);
const capVerify = async (o) => { verified.push(o); return { origin: o, name: "Cap", verified: true, verifiedAt: Date.now() }; };

r = await registerMppOrigin("https://cap-first.example", { verify: capVerify });
ok(r.listed === true, "cap: first submission fills the cap and still lists");

const verifiedBefore = verified.length;
r = await registerMppOrigin("https://cap-second.example", { verify: capVerify });
ok(r.listed === false, "cap: new origin at cap is not listed");
ok(typeof r.error === "string" && /full/i.test(r.error), "cap: error is an honest capacity message");
ok(verified.length === verifiedBefore, "cap: rejected origin is never verified");

__testSetSubmittedCap();
__testResetSubmitted();

// --- snapshot honesty: unverified origins never count toward the shown total ---
__testReset();
await registerMppOrigin("https://real-one.example", { verify: goodVerify });
await registerMppOrigin("https://fake-one.example", { verify: badVerify });
const snap = mppIndexSnapshot();
ok(snap.verifiedSellers === 1, "snapshot counts only the verified seller, never the failed probe");
ok(snap.sellers.length === 1 && snap.sellers[0].origin === "https://real-one.example", "snapshot's seller list excludes the unverified origin entirely");

__testReset();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
