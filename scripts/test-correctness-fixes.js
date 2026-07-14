// Regression lock for the tool correctness fixes found in the 2026-07 review.
// The "answers its own example" gate (test-all.js) only checks each tool's ONE
// example input; these bugs were wrong on OTHER inputs, so they need their own
// assertions or a future edit could silently revert them. Boots a free-mode
// server under TZ=UTC (the date tools assume a UTC host, as prod is).
import { spawn } from "node:child_process";

const PORT = 3099;
const B = `http://localhost:${PORT}`;
const proc = spawn("node", ["src/server.js"], {
  env: { ...process.env, FREE_MODE: "true", PORT: String(PORT), TZ: "UTC" },
  stdio: "ignore",
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const post = async (p, b) => (await fetch(`${B}/api/${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) })).json();
const postRaw = (p, b) => fetch(`${B}/api/${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
const get = async (p, q) => (await fetch(`${B}/api/${p}?${new URLSearchParams(q)}`)).json();

try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${B}/health`)).ok) break; } catch {} await sleep(500); }

  ok((await post("duration", { value: "500ms" })).seconds === 0.5, "duration: 500ms -> 0.5s (ms no longer dead regex branch)");
  ok((await post("mod-arithmetic", { op: "mod", a: "9007199254740993", m: "10" })).result === "3", "mod-arithmetic: big int via string is exact");
  ok((await post("gcd-lcm", { a: 999999937, b: 999999893 })).lcm === "999999830000006741", "gcd-lcm: exact past 2^53");
  ok((await get("timezone-convert", { datetime: "2026-01-15T09:00:00", from: "Europe/London", to: "America/New_York" })).utc === "2026-01-15T09:00:00.000Z", "timezone-convert: naive datetime read in the from-zone");
  const fh = await post("forecast-holt", { values: [10, 13, 12, 17, 19, 18, 24, 23, 29, 31], horizon: 3, alpha: 0.5, beta: 0.3 });
  const hw = fh.forecast[0].point - fh.forecast[0].lower95;
  ok(Math.abs(hw - 4.8) < 0.1, `forecast-holt: h=1 interval half-width ~= sigma (got ${hw.toFixed(3)}, not sigma*alpha)`);
  ok((await post("age", { birthdate: "2000-01-31", asOf: "2000-03-01" })).days >= 0, "age: never returns negative days");
  ok((await postRaw("roman", { value: "IIII" })).status === 400 && (await post("roman", { value: "XIV" })).result === 14, "roman: rejects malformed, accepts canonical");
  ok((await postRaw("ipv6-expand", { address: "1::2::3" })).status === 400, "ipv6-expand: rejects multiple '::'");
  ok((await post("token-count", { text: "\u{1F600}\u{1F600}" })).characters === 2, "token-count: counts code points, not UTF-16 units");
  ok((await post("char-frequency", { text: "\u{1F600}\u{1F600}" })).total === 2, "char-frequency: total is code points");
  const chk = await post("text-chunk", { text: "a\u{1F600}\u{1F600}\u{1F600}b", size: 2, unit: "chars" });
  ok(!chk.chunks.some((c) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(c)), "text-chunk: never splits a surrogate pair");
  ok((await post("text-chunk", { text: "0123456789", size: 8, overlap: 6, unit: "chars" })).count === 2, "text-chunk: no redundant tail chunks");
  ok((await get("calendar-diff", { from: "2024-03-01T12:00:00Z", to: "2024-04-01T06:00:00Z" })).diff.days === 30, "calendar-diff: real month length, not +30");
  ok((await get("workday-count", { start: "2026-07-03", end: "2026-07-03", holidays: "true" })).holidayDays === 1, "workday-count: observes weekend federal holidays");
  const enc = await post("binary-text", { text: "€" });
  ok((await post("binary-text", { text: enc.result, decode: true })).result === "€", "binary-text: round-trips multi-byte (UTF-8)");
  ok((await post("unit-convert", { value: 1, from: "mbit", to: "b" })).result === 125000, "unit-convert: 1 Mbit = 125000 bytes (decimal bits)");
  const br = await post("braille-convert", { text: "1a" });
  ok((await post("braille-convert", { text: br.result, decode: true })).result === "1a", "braille-convert: letter sign ends number mode (1a round-trips)");
  const wf = await post("word-frequency", { text: "the the the cat cat dog" });
  ok(wf.totalWords === 3 && wf.uniqueWords === 2, "word-frequency: consistent denominators (stop words excluded from both)");
  ok((await post("readability-score", { text: "100 200 300 400 500 600." })).fleschReadingEase <= 122, "readability: numeric tokens count as syllables (Flesch in range)");
  ok((await post("phone-format", { phone: "9188888888", country: "IN" })).valid === true, "phone-format: keeps a national number that starts with the country digits");

  console.log(`\n${failed ? "FAILED" : "OK"}: ${pass} passed, ${failed} failed`);
  proc.kill("SIGKILL");
  process.exit(failed ? 1 : 0);
} catch (e) {
  console.error("ERROR:", e.message);
  proc.kill("SIGKILL");
  process.exit(1);
}
