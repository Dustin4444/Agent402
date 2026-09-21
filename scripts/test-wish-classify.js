// The wish board's intent judgment: what it must and must not be able to do.
//
// The valuable assertions here are the NEGATIVE ones. This is the first paid
// third-party model wired into anything in this tree, and the board it reads
// feeds a qualification rule that decides which demand signals get acted on.
// So what is pinned is mostly the blast radius: no key means no feature, a
// failing upstream changes nothing, and no judgment can move a count or flip
// `qualified`.
//
//   node scripts/test-wish-classify.js
let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error("FAIL:", m); process.exit(1); } };

const KEY = "ts_test_key";
const mod = await import("../src/wish-classify.js");
const { classifyWishes, verdictOf, wishClassifyEnabled, __resetCache, CONFIDENT } = mod;

const stub = (answers, { status = 200, throws = false } = {}) => {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (throws) throw new Error("socket hang up");
    if (status !== 200) return { ok: false, status, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ answers }) };
  };
  f.calls = calls;
  return f;
};
// VERBATIM from a live api.typesafe.ai response, not invented. The first cut
// of this file guessed {probability: n}; the real wire is {type, noul: n}, so
// the parser returned null for every real answer while all 27 assertions here
// passed against the fixture built from the same guess. A stub can only ever
// prove the code agrees with the stub. Captured shape, 2026-09-21:
//   {"model":"jev-1.13.0","answers":{"advertises":{"type":"noul","noul":0.44}},...}
const noul = (n) => ({ type: "noul", noul: n });
const AD = { advertises: noul(0.97), requests: noul(0.10) };
const REQ = { advertises: noul(0.04), requests: noul(0.93) };

// --- no key, no feature -----------------------------------------------------
delete process.env.TYPESAFE_API_KEY;
__resetCache();
ok(wishClassifyEnabled() === false, "control: with no key the feature reports itself off");
{
  const f = stub(AD);
  const rows = [{ text: "buy my endpoint $1 usdc", count: 3, callers: 2, qualified: false }];
  const out = await classifyWishes(rows, { fetchImpl: f });
  ok(f.calls.length === 0, "no key means NOT ONE upstream call is made");
  ok(!("intent" in out[0]), "and rows come back exactly as they arrived");
}

process.env.TYPESAFE_API_KEY = KEY;
__resetCache();
ok(wishClassifyEnabled() === true, "control: with a key the feature is on");

// --- it annotates, and only annotates ---------------------------------------
{
  __resetCache();
  const f = stub(AD);
  const row = { text: "rigo falsifier micro: $1 usdc base x402 get https://example.com/api", count: 9, callers: 4, qualified: true };
  const before = JSON.stringify({ count: row.count, callers: row.callers, qualified: row.qualified });
  await classifyWishes([row], { fetchImpl: f });
  ok(row.intent?.kind === "advertisement", `an advert is judged as one (got ${row.intent?.kind})`);
  ok(JSON.stringify({ count: row.count, callers: row.callers, qualified: row.qualified }) === before,
    "count, callers and qualified are UNTOUCHED - a judgment can never promote or demote a cluster");
  ok(f.calls[0].url.includes("typesafe"), "it called the configured endpoint");
  ok(f.calls[0].body.model && f.calls[0].body.questions.advertises.type === "noul",
    "the request carries a model and asks a noul, per the API contract");
  ok(Object.keys(f.calls[0].body.questions).length === 2 &&
     f.calls[0].body.questions.requests, "both directions are asked as SEPARATE questions, not derived from each other");
}

// --- the unconfident band says so -------------------------------------------
ok(verdictOf({ advertises: 0.97, requests: 0.10 }).kind === "advertisement", "confident advert");
ok(verdictOf({ advertises: 0.04, requests: 0.93 }).kind === "request", "confident request");
ok(verdictOf({ advertises: 0.55, requests: 0.60 }).kind === "unclear",
  "a split judgment is 'unclear', never rounded to whichever side is higher");
ok(verdictOf({ advertises: 0.9, requests: 0.9 }).kind === "unclear",
  "confident on BOTH is also unclear: they are not mutually exclusive questions");
ok(verdictOf({ advertises: null, requests: 0.9 }) === null, "an unreadable probability yields no verdict at all");
ok(CONFIDENT > 0.5 && CONFIDENT <= 1, `the confidence bar is above a coin flip (${CONFIDENT})`);

// --- failure changes nothing ------------------------------------------------
for (const [label, opts] of [["a refused key (401)", { status: 401 }], ["a 500", { status: 500 }], ["a thrown socket error", { throws: true }]]) {
  __resetCache();
  const rows = [{ text: "something", count: 5, callers: 3, qualified: true }];
  const out = await classifyWishes(rows, { fetchImpl: stub(AD, opts) });
  ok(!("intent" in out[0]), `${label}: the row is returned unannotated, not broken`);
  ok(out[0].qualified === true && out[0].count === 5, `${label}: the board's own data survives untouched`);
}

// --- spend is bounded -------------------------------------------------------
{
  __resetCache();
  const f = stub(REQ);
  const rows = Array.from({ length: 40 }, (_, i) => ({ text: `wish number ${i}`, count: 1, callers: 1 }));
  await classifyWishes(rows, { fetchImpl: f, max: 5 });
  ok(f.calls.length === 5, `the per-run cap holds (${f.calls.length} calls for 40 rows)`);
  ok(rows.filter((r) => r.intent).length === 5, "and the rows past the cap are simply unannotated");
}
{
  __resetCache();
  const f = stub(REQ);
  const rows = [{ text: "same text", count: 1 }, { text: "same text", count: 1 }, { text: "same text", count: 1 }];
  await classifyWishes(rows, { fetchImpl: f });
  ok(f.calls.length === 1, "an identical wish is judged ONCE and served from cache after");
  ok(rows.every((r) => r.intent?.kind === "request"), "every duplicate still gets the verdict");
}
{
  // A failing row must not be retried for every row in the same run, or one
  // dead upstream costs a full run's budget in timeouts.
  __resetCache();
  const f = stub(AD, { throws: true });
  const rows = [{ text: "x" }, { text: "x" }, { text: "x" }];
  await classifyWishes(rows, { fetchImpl: f });
  ok(f.calls.length === 1, "a failure is remembered for the run rather than retried per row");
}

// --- the write path is not involved -----------------------------------------
{
  const src = (await import("node:fs")).readFileSync(new URL("../src/wish.js", import.meta.url), "utf8");
  ok(!/wish-classify/.test(src),
    "src/wish.js does NOT import the classifier: recording a wish stays deterministic, free and synchronous");
}

console.log(`\n${pass} passed`);
