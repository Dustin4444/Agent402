#!/usr/bin/env node
// A seller moving to a permanent domain keeps how long we have known them.
//
// Asked for by a seller on 2026-09-12: they had been listed for weeks on a
// *.workers.dev host, moved to their own domain, and found no way to do it
// except register fresh and become a second, brand-new identity. Nothing in
// the register flow offered a migration, and the thing the move actually costs
// is narrow - `first_seen` is origin-keyed, so a seller listed for months reset
// to "new today".
//
// What it does NOT do, deliberately:
//   - It never transfers settlement evidence (below).
//
// REVISED 2026-09-13. This file used to say it never retires the predecessor
// at all, because "a register call that could retire another seller's listing
// is a weapon whatever proof rides with it". The first seller to use the
// feature then reported the cost of that: they migrated correctly and ended up
// listed TWICE, same slugs, both routable - us carrying the duplicate-seller
// shape we collapse in other people's listings.
//
// So the predecessor IS retired now, but ONLY on the cross-served-marker
// proof, which requires serving a document on the OLD origin and is therefore
// control of it. The shared-payout-wallet proof retires nothing and never
// will: a manifest can advertise any address, so that path would let an origin
// that merely NAMES a wallet retire the listing of whoever actually earns on
// it - the inherited-evidence class the 2026-09-03 payTo binding exists for.
// The original warning was right about the weapon; it was wrong that the only
// safe answer was to do nothing.
//
// Retirement is also reversible and self-backing-out: the predecessor is
// hidden only while its successor is present and healthy in the cache, so a
// migration to an origin that dies restores the old listing on its own.
//   - It never transfers settlement evidence. Evidence is keyed by payTo and
//     follows the wallet already, and the shared-payTo guard that withholds
//     chain proof while two live origins claim one wallet stays exactly as it
//     is - a migration window is when a listing should be handled carefully,
//     not when the guard should be relaxed.
//   - It only ever moves the date BACKWARD, so no claim can make an origin
//     look newer, or younger, than it is.
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// stats.js opens a fixed path under its own DATA_DIR, so this drives the real
// store and uses run-unique origins rather than trying to redirect the file.
const dir = mkdtempSync(join(tmpdir(), "a402-succ-"));
process.env.SALES_LEDGER_DB = join(dir, "sales.db");
process.env.ALLOW_EPHEMERAL_STATS = "true";
const TAG = Math.random().toString(36).slice(2, 8);
const STATS_DB = existsSync("/data") ? "/data/agent402-stats.db" : "/tmp/agent402-stats.db";

const { recordSellerRegistrationSeen, sellerRegistrationFirstSeen, getSellerRegistrations } = await import("../src/stats.js");

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); n++; };

const OLD = `https://seller-${TAG}.workers.dev`;
const NEW = `https://api.seller-${TAG}.com`;

// --- the date moves, and only backward -------------------------------------
{
  recordSellerRegistrationSeen(OLD, {});
  const old0 = sellerRegistrationFirstSeen(OLD);
  ok(Number.isFinite(old0), "the predecessor has a first_seen");

  // Backdate it so "months ago" is a real gap rather than a same-millisecond tie.
  const { default: Database } = await import("better-sqlite3");
  const raw = new Database(STATS_DB);
  const MONTHS_AGO = Date.now() - 90 * 86_400_000;
  raw.prepare("UPDATE seller_registrations SET first_seen = ? WHERE origin = ?").run(MONTHS_AGO, OLD);
  raw.close();
  eq(sellerRegistrationFirstSeen(OLD), MONTHS_AGO, "the predecessor now reads as registered 90 days ago");

  recordSellerRegistrationSeen(NEW, { inheritFirstSeenFrom: OLD });
  eq(sellerRegistrationFirstSeen(NEW), MONTHS_AGO,
     "the successor INHERITS the date: a seller who has been listed for months does not read as new today because they bought a domain");
  eq(sellerRegistrationFirstSeen(OLD), MONTHS_AGO, "and the predecessor is untouched - succession copies, it never moves or retires anything");

  // Re-registering later must not push the date forward.
  recordSellerRegistrationSeen(NEW, {});
  eq(sellerRegistrationFirstSeen(NEW), MONTHS_AGO, "a later plain re-registration does not reset the inherited date");
}

// --- a claim can never push a date FORWARD ---------------------------------
// The rule is MIN, so inheriting from an origin registered AFTER us must be
// inert. Without it a succession claim could make a long-listed seller look
// newer than they are, which is the same lie in the other direction.
{
  const { default: Database } = await import("better-sqlite3");
  const ANCIENT = `https://ancient-${TAG}.example`;
  const RECENT = `https://recent-${TAG}.example`;
  recordSellerRegistrationSeen(ANCIENT, {});
  const LONG_AGO = Date.now() - 200 * 86_400_000;
  const raw2 = new Database(STATS_DB);
  raw2.prepare("UPDATE seller_registrations SET first_seen = ? WHERE origin = ?").run(LONG_AGO, ANCIENT);
  raw2.close();
  recordSellerRegistrationSeen(RECENT, {}); // registered today, i.e. NEWER than ANCIENT
  eq(sellerRegistrationFirstSeen(ANCIENT), LONG_AGO, "control: the ancient origin reads as 200 days old");
  recordSellerRegistrationSeen(ANCIENT, { inheritFirstSeenFrom: RECENT });
  eq(sellerRegistrationFirstSeen(ANCIENT), LONG_AGO,
     "inheriting from a NEWER origin is inert: the rule is MIN, so a claim can only ever pull a date earlier, never make a seller look newer than they are");
}

// --- an unknown or absent predecessor changes nothing -----------------------
{
  const A = `https://alone-${TAG}.example`;
  recordSellerRegistrationSeen(A, { inheritFirstSeenFrom: `https://never-${TAG}.example` });
  ok(Number.isFinite(sellerRegistrationFirstSeen(A)), "inheriting from an origin we have never seen is a no-op, not a crash or a null date");
  const B = `https://plain-${TAG}.example`;
  recordSellerRegistrationSeen(B, {});
  ok(Number.isFinite(sellerRegistrationFirstSeen(B)), "and the ordinary path is unchanged");
  eq(sellerRegistrationFirstSeen(`https://nothing-${TAG}.example`), null, "an origin that never registered reads null");
}

// --- the predecessor is never removed from the table ------------------------
{
  const rows = getSellerRegistrations();
  ok(rows.some((r) => r.origin === OLD), "the predecessor is STILL LISTED after a succession - nothing about this retires a seller");
  ok(rows.some((r) => r.origin === NEW), "and the successor is listed beside it");
}

// --- the binding: two proofs, because one excludes the people who need it ----
// The first cut required a shared BASE payTo. Measured against the live index
// that refused a third of all origins - and the seller who asked for the
// feature was in that third, with no payTo on any chain. A binding unavailable
// to its own use case is not a binding, it is a wall.
{
  const { sharesPayTo, verifySuccessionMarkers, SUCCESSION_PATH } = await import("../src/x402-index.js");
  const { loadPersistedIndexCache } = await import("../src/x402-index.js");
  const { writeFileSync: wf } = await import("node:fs");
  // REAL public hostnames: the SSRF guard is unconditional (CodeQL flagged the
  // injectable version as critical request-forgery, correctly - an indirection
  // it cannot follow is indistinguishable from no guard). The FETCH is still
  // injected, so the guard runs and no request leaves the machine.
  const OLD_O = "https://example.com", NEW_O = "https://example.org", THIRD = "https://iana.org";
  const tool = (o, pay) => ({ slug: "t", price: 0.002, method: "GET", seller: o, route: "/api/t", networks: ["eip155:8453"], ...(pay ? { payToByNetwork: pay } : {}) });
  const f = join(dir, "cache.json");
  wf(f, JSON.stringify({ entries: [
    [OLD_O, { origin: OLD_O, fetchedAt: Date.now(), history: [1], tools: [tool(OLD_O, { "eip155:137": "0xAAA" })] }],
    [NEW_O, { origin: NEW_O, fetchedAt: Date.now(), history: [1], tools: [tool(NEW_O, { "eip155:137": "0xaaa" })] }],
    [THIRD, { origin: THIRD, fetchedAt: Date.now(), history: [1], tools: [tool(THIRD, { "eip155:137": "0xBBB" })] }],
    ["https://example.net", { origin: "https://example.net", fetchedAt: Date.now(), history: [1], tools: [tool("https://example.net")] }],
  ] }));
  loadPersistedIndexCache(f);

  const m = sharesPayTo(NEW_O, OLD_O);
  ok(m && m.network === "eip155:137", "a shared payTo on ANY chain proves it, not Base alone - a Base-only rule refused a third of the index");
  ok(m.payTo === "0xaaa", "and the comparison is case-insensitive for EVM, so a checksummed address matches a lowercase one");
  eq(sharesPayTo(NEW_O, THIRD), null, "two DIFFERENT payout wallets prove nothing");
  eq(sharesPayTo(NEW_O, "https://example.net"), null, "and an origin advertising no payTo cannot be matched on one");

  // Proof two: cross-served markers, for the ~1,000 origins with no payTo.
  const served = {};
  const stubFetch = async (url) => {
    const body = served[String(url)];
    return body === undefined ? { ok: false, status: 404, text: async () => "" } : { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const N = `https://example.net${SUCCESSION_PATH}`, O = `${OLD_O}${SUCCESSION_PATH}`;
  eq((await verifySuccessionMarkers("https://example.net", OLD_O, { fetchImpl: stubFetch })).ok, false, "with no markers served, nothing is proved");
  ok(/BOTH origins/.test((await verifySuccessionMarkers("https://example.net", OLD_O, { fetchImpl: stubFetch })).reason),
     "...and the refusal tells the seller exactly what to serve, on both hosts");

  served[N] = { succeeds: OLD_O };
  eq((await verifySuccessionMarkers("https://example.net", OLD_O, { fetchImpl: stubFetch })).ok, false,
     "ONE direction is not enough: a claimant serving a marker alone could annex an origin they do not run");
  served[O] = { succeededBy: "https://example.net" };
  eq((await verifySuccessionMarkers("https://example.net", OLD_O, { fetchImpl: stubFetch })).ok, true,
     "both directions served, and each naming the other, is proof of control over both");

  served[O] = { succeededBy: THIRD };
  eq((await verifySuccessionMarkers("https://example.net", OLD_O, { fetchImpl: stubFetch })).ok, false,
     "the old origin naming somebody ELSE refuses - the predecessor decides who succeeds it");
  // The guard is UNCONDITIONAL and the hosts above are real, so it actually
  // ran on every call in this block. Pinned from source as well, because the
  // shape of the call is what the static analyzer reads.
  {
    const src = readFileSync(new URL("../src/x402-index.js", import.meta.url), "utf8");
    // Sized to the whole function rather than a byte count: the window was 900
    // and the comment explaining the fix pushed the guard out of it, which would
    // have read as "the guard is gone".
    const fn = src.slice(src.indexOf("async function readMarker"), src.indexOf("const sameOrigin"));
    ok(/await safeFetch\(url,/.test(fn),
       "readMarker fetches through safeFetch - the STATICALLY imported guarded fetcher. Two earlier versions were flagged CRITICAL js/request-forgery: one made the guard injectable, the other reached it through a dynamic import, and CodeQL could follow neither. A control the tooling cannot see is not meaningfully a control");
    // Comments stripped first: the comment explaining this fix NAMES the old
    // injectable parameter, so a bare word search matched the explanation
    // rather than the code and failed on a correct tree.
    const code = fn.replace(/\/\/[^\n]*/g, "");
    ok(!/assertUrl/.test(code), "and there is no way to switch it off, which is what made CodeQL call the first version critical request-forgery");
    const guard = readFileSync(new URL("../src/tools/fetch-guard.js", import.meta.url), "utf8");
    ok(/export async function safeFetch[\s\S]{0,200}await assertPublicUrl\(rawUrl\)/.test(guard),
       "...and safeFetch itself asserts the URL is public before it fetches, so the guarantee is one hop away and statically visible");
    ok(/dispatcher: ssrfDispatcher/.test(guard), "and pins the connection to the validated IP, re-validating every redirect hop");
    ok(/^import \{ safeFetch \} from "\.\/tools\/fetch-guard\.js";/m.test(src),
       "the import is STATIC at the top of the file - a dynamic import is what defeated the analyzer on the second attempt");
  }

  served[O] = { succeededBy: "https://example.net/" };
  eq((await verifySuccessionMarkers("https://example.net", OLD_O, { fetchImpl: stubFetch })).ok, true,
     "a trailing slash is the same origin, compared as origins rather than as strings");
}

// --- retiring the predecessor, and the two proofs that are not equal --------
{
  const { recordSuccession, succeededBy, supersededOrigins, computeAliasOrigins, __testResetSubmitted } =
    await import("../src/x402-index.js");
  __testResetSubmitted();

  const A = "https://old-origin.example";
  const B = "https://new-origin.example";
  const live = (o) => new Map(o);

  ok(recordSuccession(A, B) === true, "a verified succession is recorded");
  eq(succeededBy(A), B, "the predecessor names its successor, so an old link can still say where the seller went");
  eq(succeededBy(B), null, "the successor is not itself superseded");

  // The two shapes that would hide a seller rather than deduplicate one.
  ok(recordSuccession(A, A) === false, "an origin cannot succeed itself");
  ok(recordSuccession(B, A) === false, "a cycle is refused: recording the reverse would hide BOTH origins and the seller would vanish");

  // Retirement is conditional on the successor actually being there.
  const both = live([[A, { tools: [] }], [B, { tools: [] }]]);
  eq([...supersededOrigins(both)], [A], "with a healthy successor the predecessor is retired");
  eq([...supersededOrigins(live([[A, { tools: [] }], [B, { error: "unreachable" }]]))], [],
     "a successor that is ERRORING retires nothing: hiding the old origin would remove the seller entirely, which is worse than the duplicate this fixes");
  eq([...supersededOrigins(live([[A, { tools: [] }]]))], [],
     "a successor that is GONE retires nothing either, so a migration that fails backs itself out");

  // The one line that makes it take effect everywhere: superseded origins join
  // the set that already hides redirect and deployment-hostname duplicates, so
  // the index listing, the remote pool and route queries all honour it.
  ok(computeAliasOrigins(both).has(A), "a superseded origin joins the alias set every listing consumer already honours");
  ok(!computeAliasOrigins(both).has(B), "and the successor does not");
}

// --- the proof that may NOT retire ------------------------------------------
// Pinned from source, because the difference is one string and getting it
// wrong turns a register call into a way to delist a seller you do not own.
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/x402-index.js", import.meta.url), "utf8");
  const call = /if \(r\?\.ok && r\.via === "cross-served markers"\) r\.predecessorRetired = recordSuccession\(/.test(src);
  ok(call, "retirement is gated on the cross-served-marker proof, which requires control of the OLD origin");
  ok(/via: "shared payout wallet"/.test(src), "the shared-wallet proof still exists (it carries the first-seen date)");
  ok(!/via === "shared payout wallet"[^\n]*recordSuccession/.test(src),
     "...and it never retires: a manifest can advertise any address, so that path would let an origin that merely NAMES a wallet delist whoever actually earns on it");
}

rmSync(dir, { recursive: true, force: true });
console.log(`test-seller-succession: ${n} assertions OK`);
