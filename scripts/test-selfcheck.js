// Self-check unit test — offline, deterministic. Locks the behavior that makes
// the prod tool-failure alarm trustworthy: a tool is only reported failing if it
// fails TWICE (single transient blips are filtered), a tool that fails-then-
// recovers is flagged `flaky` but NOT reported failing, and a timeout counts as
// a failure. Uses a synthetic catalog of fake handlers — no network.
import { runSelfCheck } from "../src/selfcheck.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// A catalog is route->def; runSelfCheck maps by def.slug. Build fakes whose
// handlers behave as named. `attempts` counts calls so we can model flakiness.
const attempts = {};
const def = (slug, handler) => ({ [`GET /api/${slug}`]: { slug, discovery: { input: {} }, handler } });
const catalog = {
  ...def("always-ok", async () => ({ ok: 1 })),
  ...def("always-fail", async () => { throw Object.assign(new Error("boom"), { statusCode: 502 }); }),
  ...def("flaky", async () => { attempts.flaky = (attempts.flaky || 0) + 1; if (attempts.flaky === 1) throw Object.assign(new Error("blip"), { statusCode: 504 }); return { ok: 1 }; }),
  ...def("slow", async () => { await new Promise((r) => setTimeout(r, 5000)); return { ok: 1 }; }),
};

// timeoutMs small so the "slow" tool times out fast in the test.
const r = await runSelfCheck(catalog, ["always-ok", "always-fail", "flaky", "slow", "ghost"], { timeoutMs: 200 });
const bySlug = Object.fromEntries(r.results.map((x) => [x.slug, x]));

ok(bySlug["always-ok"].ok === true, "a healthy tool passes");
ok(bySlug["always-fail"].ok === false && bySlug["always-fail"].status === 502, "a tool that fails twice is reported failing (status preserved)");
ok(bySlug["flaky"].ok === true && bySlug["flaky"].flaky === true, "a fail-then-recover tool passes but is flagged flaky (transient filtered)");
ok(bySlug["slow"].ok === false && bySlug["slow"].status === 504, "a tool exceeding the timeout is a 504 failure");
ok(bySlug["ghost"].ok === false && /not in catalog/.test(bySlug["ghost"].error), "an unknown slug is reported, not silently skipped");
ok(r.ok === false && r.failing.sort().join(",") === "always-fail,ghost,slow", `top-level failing list is exactly the real failures (got ${JSON.stringify(r.failing)})`);
ok(r.checked === 5, "checked count matches requested slugs");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
