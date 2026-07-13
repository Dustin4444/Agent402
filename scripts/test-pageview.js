// Verifies server-side $pageview capture (src/posthog.js capturePageview):
// correct pageview shape, a pseudonymous daily-rotating visitor key, session
// grouping, and — critically — that the raw IP/UA are NEVER sent (they're only
// hash input). Uses the POSTHOG_TEST_CAPTURE sink; no network.
process.env.POSTHOG_TEST_CAPTURE = "1";
process.env.POW_SECRET = "test-pageview-salt";
import assert from "node:assert";

const { capturePageview, _testEventsForTest } = await import("../src/posthog.js");

const RAW_IP = "203.0.113.7";
const RAW_UA = "Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537.36";
const mkReq = (path, ref) => ({
  ip: RAW_IP, protocol: "https", path, url: path, originalUrl: path,
  headers: { "user-agent": RAW_UA, host: "agent402.tools", ...(ref ? { referer: ref } : {}) },
});

capturePageview(mkReq("/marketplaces", "https://www.google.com/search?q=x402"));
let pv = _testEventsForTest().filter((e) => e.event === "$pageview");
assert.strictEqual(pv.length, 1, "one $pageview captured");
const e = pv[0];
assert.strictEqual(e.properties.$pathname, "/marketplaces", "pathname");
assert.strictEqual(e.properties.$host, "agent402.tools", "host");
assert.strictEqual(e.properties.$current_url, "https://agent402.tools/marketplaces", "current_url");
assert.strictEqual(e.properties.$referring_domain, "www.google.com", "referring domain parsed");
assert.match(e.distinctId, /^[0-9a-f]{32}$/, "distinctId is a 32-hex pseudonymous hash");
assert.strictEqual(e.properties.$session_id, e.distinctId, "session groups with the visitor key");

// Privacy invariant: the raw IP and UA must never appear anywhere in the event.
const serialized = JSON.stringify(e);
assert.ok(!serialized.includes(RAW_IP), "raw IP must never be sent");
assert.ok(!serialized.includes("Mozilla"), "raw user-agent must never be sent");

// Same ip+ua on the same day → same key (a day's views are one visitor/session).
capturePageview(mkReq("/base"));
pv = _testEventsForTest().filter((x) => x.event === "$pageview");
assert.strictEqual(pv[0].distinctId, pv[1].distinctId, "same visitor key within a day");
assert.strictEqual(pv[1].properties.$referrer, "$direct", "no referer → $direct");

// A different visitor (different ip) → a different key.
capturePageview({ ip: "198.51.100.9", protocol: "https", path: "/", url: "/", originalUrl: "/", headers: { "user-agent": RAW_UA, host: "agent402.tools" } });
pv = _testEventsForTest().filter((x) => x.event === "$pageview");
assert.notStrictEqual(pv[2].distinctId, pv[0].distinctId, "different visitor → different key");

console.log("pageview: all assertions passed");
