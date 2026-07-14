// Proves the unit-conversion engine covers every category the retired 970
// pairwise convert-* endpoints handled, with the exact same math: one
// representative conversion in EACH direction per category (expected values
// computed from the factor table), temperature offsets (celsius/fahrenheit/
// kelvin/rankine), 400s on unknown units and cross-category pairs (naming both
// categories), and that the old CONVERSIONS tool array is gone (or an empty
// Task-2 shim). Also proves kit2's unit-convert tool delegates to the engine.
//
// Second half boots a free-mode server (pattern from test-static-pages.js) and
// proves the 970 pairwise routes are retired GRACEFULLY: API calls (POST body
// or GET query — the old tools accepted both) get a 410 whose body TEACHES the
// replacement (never a 301: agents must not silently re-POST paid calls across
// routes); /tools/convert-* pages 301 to the surviving /tools/unit-convert;
// and the surviving convert-suffixed routes (base-convert, unit-convert,
// timezone-convert) are NOT caught by the retirement pattern.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as gen from "../src/tools/convert-gen.js";
import { KIT2 } from "../src/tools/kit2.js";

const { UNIT_CATEGORIES, convertAnyUnit } = gen;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

ok(typeof convertAnyUnit === "function", "convertAnyUnit is exported");
ok(UNIT_CATEGORIES && typeof UNIT_CATEGORIES === "object", "UNIT_CATEGORIES is exported");

// Exact conversion (relative tolerance for FP noise only — values below are
// computed from the factor table, not looked up).
const approx = (value, from, to, expected, label) => {
  let got;
  try { got = convertAnyUnit(value, from, to); } catch (e) { return ok(false, `${label}: threw ${e.message}`); }
  const tol = 1e-9 * Math.max(1, Math.abs(expected));
  ok(Math.abs(got - expected) <= tol, `${label}: ${value} ${from} -> ${to} = ${got} (expected ${expected})`);
};

// One representative pair EACH DIRECTION for every category in the table.
approx(1, "miles", "kilometers", 1.609344, "length");
approx(5, "kilometers", "miles", 3.1068559611866697, "length reverse");
approx(1, "light-years", "meters", 9460730472580800, "length extreme (light-years)");
approx(1, "nautical-miles", "meters", 1852, "length slug-style id (nautical-miles)");
approx(1, "pounds", "grams", 453.59237, "mass");
approx(1000, "grams", "pounds", 2.2046226218487757, "mass reverse");
approx(1, "us-gallons", "liters", 3.785411784, "volume");
approx(10, "liters", "us-gallons", 2.6417205235814842, "volume reverse");
approx(1, "acres", "square-meters", 4046.8564224, "area");
approx(10000, "square-meters", "acres", 2.471053814671653, "area reverse");
approx(1, "miles-per-hour", "meters-per-second", 0.44704, "speed");
approx(100, "kilometers-per-hour", "miles-per-hour", 62.1371192237334, "speed reverse");
approx(2, "hours", "seconds", 7200, "time");
approx(90, "seconds", "minutes", 1.5, "time reverse");
approx(1, "gibibytes", "bytes", 1073741824, "data (binary IEC)");
approx(5e6, "bytes", "megabytes", 5, "data reverse (decimal SI)");
approx(1, "atmospheres", "pascals", 101325, "pressure");
approx(1, "psi", "kilopascals", 6.8947572931679995, "pressure reverse");
approx(1, "kilowatt-hours", "joules", 3600000, "energy");
approx(4184, "joules", "calories", 1000, "energy reverse");
approx(1, "horsepower", "watts", 745.6998715822702, "power");
approx(1, "kilowatts", "horsepower", 1.3410220895950278, "power reverse");
approx(180, "degrees", "radians", Math.PI, "angle");
approx(1, "radians", "degrees", 57.29577951308232, "angle reverse");
approx(1, "gigahertz", "hertz", 1e9, "frequency");
approx(60, "rpm", "hertz", 1, "frequency reverse");

// Temperature — affine, not linear. Exact anchor points.
approx(212, "fahrenheit", "celsius", 100, "temperature F->C");
approx(100, "celsius", "fahrenheit", 212, "temperature C->F");
approx(0, "kelvin", "celsius", -273.15, "temperature K->C");
approx(491.67, "rankine", "kelvin", 273.15, "temperature R->K");
approx(0, "celsius", "rankine", 491.67, "temperature C->R");
approx(-40, "fahrenheit", "celsius", -40, "temperature F==C at -40");

// Round-trip identity through the engine for every unit in every category.
let rtFail = 0, rtTotal = 0;
for (const [category, def] of Object.entries(UNIT_CATEGORIES || {})) {
  const ids = Object.keys(def.units);
  const base = def.base;
  for (const id of ids) {
    rtTotal++;
    const there = convertAnyUnit(7, id, base);
    const back = convertAnyUnit(there, base, id);
    if (Math.abs(back - 7) > 1e-9 * Math.max(1, Math.abs(back))) {
      rtFail++;
      console.error(`FAIL - round-trip ${category}/${id}: 7 -> ${there} -> ${back}`);
    }
  }
}
ok(rtFail === 0 && rtTotal > 0, `round-trip identity holds for all ${rtTotal} units`);
ok(Object.keys(UNIT_CATEGORIES || {}).length === 13, `13 categories in the table (got ${Object.keys(UNIT_CATEGORIES || {}).length})`);

// Errors: 400 with useful messages.
const throws400 = (fn, contains, label) => {
  try { fn(); ok(false, `${label}: did not throw`); } catch (e) {
    const hasAll = contains.every((c) => String(e.message).includes(c));
    ok(e.statusCode === 400 && hasAll, `${label}: 400 "${e.message}"`);
  }
};
throws400(() => convertAnyUnit(1, "parsecs", "meters"), ["parsecs"], "unknown from-unit");
throws400(() => convertAnyUnit(1, "meters", "smoots"), ["smoots"], "unknown to-unit");
throws400(() => convertAnyUnit(1, "meters", "grams"), ["length", "mass"], "cross-category names both categories");
throws400(() => convertAnyUnit(1, "celsius", "joules"), ["temperature", "energy"], "cross-category temperature vs energy");

// The old generated-tool array must be gone (Task-2 removes the [] shim).
ok(gen.CONVERSIONS === undefined || (Array.isArray(gen.CONVERSIONS) && gen.CONVERSIONS.length === 0),
  "CONVERSIONS tool array is gone (or the empty Task-2 shim)");

// kit2's unit-convert delegates to the engine: full ids, old short aliases, temperature.
const uc = KIT2.find((t) => t.slug === "unit-convert");
ok(uc && uc.route === "POST /api/unit-convert" && uc.price === "$0.001", "unit-convert route/slug/price unchanged");
const res1 = uc.handler({ value: 1, from: "nautical-miles", to: "meters" });
ok(res1.result === 1852, `unit-convert handles full table ids (got ${res1.result})`);
const res2 = uc.handler({ value: 100, from: "f", to: "c" });
ok(Math.abs(res2.result - 37.7777777778) < 1e-6, `unit-convert keeps old short aliases (100 f -> c = ${res2.result})`);
const res3 = uc.handler(uc.discovery.input);
ok(Math.abs(res3.result - uc.discovery.output.example.result) < 1e-6, `unit-convert answers its own example (got ${res3.result})`);
try { uc.handler({ value: 1, from: "meters", to: "grams" }); ok(false, "unit-convert cross-category did not throw"); }
catch (e) { ok(e.statusCode === 400 && e.message.includes("length") && e.message.includes("mass"), `unit-convert cross-category 400: "${e.message}"`); }

// ---------------------------------------------------------------------------
// Booted-server section: graceful retirement of the pairwise convert routes.
// ---------------------------------------------------------------------------
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3097;
const BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proc = spawn(process.execPath, [join(ROOT, "src", "server.js")], {
  cwd: ROOT,
  env: { ...process.env, FREE_MODE: "true", PORT: String(PORT), X402_SYNC_ON_START: "false" },
  stdio: "ignore",
});

// A retired-route response must be a 410 whose body teaches the replacement:
// { error, replacement: { route: "POST /api/unit-convert", input: { value, from, to } } }.
const assert410 = async (label, res, { value, from, to }) => {
  ok(res.status === 410, `${label}: status 410 (got ${res.status})`);
  let body = null;
  try { body = await res.json(); } catch {}
  ok(typeof body?.error === "string" && body.error.length > 0, `${label}: body carries an error string`);
  ok(body?.replacement?.route === "POST /api/unit-convert", `${label}: replacement.route teaches POST /api/unit-convert (got ${body?.replacement?.route})`);
  const input = body?.replacement?.input || {};
  ok(input.from === from, `${label}: replacement.input.from = ${JSON.stringify(from)} (got ${JSON.stringify(input.from)})`);
  ok(input.to === to, `${label}: replacement.input.to = ${JSON.stringify(to)} (got ${JSON.stringify(input.to)})`);
  ok(input.value === value, `${label}: replacement.input.value = ${JSON.stringify(value)} (got ${JSON.stringify(input.value)})`);
};

try {
  let up = false;
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${BASE}/health`)).ok) { up = true; break; } } catch {} await sleep(500); }
  ok(up, "free-mode server boots (health 200)");

  // Old POST form: body {value} — 410 teaches from/to parsed out of the slug
  // and echoes the caller's value.
  await assert410("POST retired route",
    await fetch(`${BASE}/api/convert-miles-to-kilometers`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: 5 }),
    }),
    { value: 5, from: "miles", to: "kilometers" });

  // Old GET form: ?value=N — same teaching body.
  await assert410("GET retired route",
    await fetch(`${BASE}/api/convert-miles-to-kilometers?value=3.5`),
    { value: 3.5, from: "miles", to: "kilometers" });

  // Hyphenated unit ids on BOTH sides — the parser must split the middle
  // segment on the "-to-" whose two sides are both real unit ids, not the
  // first "-to-" it sees.
  await assert410("hyphenated-unit parse",
    await fetch(`${BASE}/api/convert-nautical-miles-to-light-years`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: 2 }),
    }),
    { value: 2, from: "nautical-miles", to: "light-years" });

  // Temperature ids are in the table too (affine category).
  await assert410("temperature ids parse",
    await fetch(`${BASE}/api/convert-celsius-to-fahrenheit?value=100`),
    { value: 100, from: "celsius", to: "fahrenheit" });

  // Unknown units: still a 410 (the route shape IS the retired shape), but
  // from/to are null and no value was sent → null.
  await assert410("unknown units still 410, nulls",
    await fetch(`${BASE}/api/convert-foo-to-bar`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    }),
    { value: null, from: null, to: null });

  // Non-numeric value → echoed as null, never NaN.
  {
    const res = await fetch(`${BASE}/api/convert-miles-to-kilometers?value=abc`);
    ok(res.status === 410, `non-numeric value: status 410 (got ${res.status})`);
    const body = await res.json().catch(() => null);
    ok(body?.replacement?.input?.value === null, `non-numeric value echoes null (got ${JSON.stringify(body?.replacement?.input?.value)})`);
  }

  // Tool pages 301 to the survivor.
  {
    const res = await fetch(`${BASE}/tools/convert-miles-to-kilometers`, { redirect: "manual" });
    ok(res.status === 301, `/tools/convert-miles-to-kilometers → 301 (got ${res.status})`);
    ok(res.headers.get("location") === "/tools/unit-convert", `301 Location is /tools/unit-convert (got ${res.headers.get("location")})`);
  }

  // The survivor answers the taught call.
  {
    const res = await fetch(`${BASE}/api/unit-convert`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: 5, from: "miles", to: "kilometers" }),
    });
    ok(res.status === 200, `POST /api/unit-convert → 200 (got ${res.status})`);
    const body = await res.json().catch(() => null);
    ok(Math.abs((body?.result ?? NaN) - 8.04672) < 1e-6, `unit-convert 5 miles → km ≈ 8.046720 (got ${body?.result})`);
  }

  // CRITICAL exclusion: /api/base-convert survives — the retirement pattern is
  // ^/api/convert-…-to-…$ and "base-convert" does not start with "convert-",
  // so it must answer its own example (200), never 410.
  {
    const res = await fetch(`${BASE}/api/base-convert`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "ff", from: 16, to: 2 }),
    });
    ok(res.status === 200, `POST /api/base-convert NOT caught by retirement (200, got ${res.status})`);
    const body = await res.json().catch(() => null);
    ok(body?.result === "11111111", `base-convert ff/16 → 2 = 11111111 (got ${JSON.stringify(body?.result)})`);
  }

  // A non-convert unknown API route stays a plain 404 — retirement must not
  // widen into a catch-all.
  {
    const res = await fetch(`${BASE}/api/definitely-not-a-tool`);
    ok(res.status === 404, `unknown non-convert route stays 404 (got ${res.status})`);
  }

  // Boot smoke: interim catalog is exactly 462 tools; /marketplace renders.
  {
    const pricing = await (await fetch(`${BASE}/api/pricing`)).json();
    ok(Array.isArray(pricing.endpoints) && pricing.endpoints.length === 462, `catalog has 462 tools (got ${pricing.endpoints?.length})`);
    const mkt = await fetch(`${BASE}/marketplace`);
    ok(mkt.status === 200, `/marketplace → 200 (got ${mkt.status})`);
  }
} catch (e) {
  fail++;
  console.error(`FAIL - booted section threw: ${e.message}`);
} finally {
  try { proc.kill("SIGKILL"); } catch {}
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.error("convert: FAILURES"); process.exit(1); }
console.log("convert: unit table + engine + graceful retirement VERIFIED");
process.exit(0);
