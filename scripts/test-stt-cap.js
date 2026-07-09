// Margin-cap tests for the STT kit. The per-tier duration cap is what keeps
// transcribe/transcribe-pro profitable (OpenAI bills per audio minute, the
// tool charges per call) — these tests prove the cap is enforced locally,
// before any upstream spend. Offline: synthetic WAV buffers, no network.
import { probeDurationSeconds, assertWithinDurationCap } from "../src/tools/stt-kit.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

// Minimal valid PCM WAV of the given length: 8 kHz, mono, 8-bit.
function makeWav(seconds) {
  const sr = 8000;
  const dataLen = Math.round(sr * seconds);
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + dataLen, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr, 28); buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34);
  buf.write("data", 36); buf.writeUInt32LE(dataLen, 40);
  return buf;
}

const short = makeWav(10);          // 10 s — fine on both tiers
const mid = makeWav(6.5 * 60);      // 6.5 min — over the 5-min mini cap, under the 10-min pro cap
const long = makeWav(11 * 60);      // 11 min — over both caps
const junk = Buffer.from("definitely not an audio container ".repeat(200));

const d = await probeDurationSeconds(short, "audio.wav");
ok(d !== null && Math.abs(d - 10) < 0.5, `probe reads WAV duration from the header (got ${d}s)`);
ok((await probeDurationSeconds(junk, "audio.mp3")) === null, "unreadable bytes probe to null, never throw");

ok((await assertWithinDurationCap(short, "audio.wav", "transcribe")) > 0, "short clip passes the mini tier");
ok((await assertWithinDurationCap(mid, "audio.wav", "transcribe-pro")) > 0, "6.5-min clip passes the pro tier");

await assertWithinDurationCap(mid, "audio.wav", "transcribe").then(
  () => ok(false, "6.5-min clip must be rejected by the 5-min mini cap"),
  (e) => {
    ok(e.statusCode === 422, `mini cap rejects with 422 (got ${e.statusCode})`);
    ok(/transcribe-pro/.test(e.message), "mini-tier rejection points at the pro tier");
  }
);

await assertWithinDurationCap(long, "audio.wav", "transcribe-pro").then(
  () => ok(false, "11-min clip must be rejected by the 10-min pro cap"),
  (e) => ok(e.statusCode === 422 && /10 minutes/.test(e.message), "pro cap rejects with 422 and states its limit")
);

await assertWithinDurationCap(junk, "audio.mp3", "transcribe").then(
  () => ok(false, "unreadable duration must be rejected (unbounded upstream bill otherwise)"),
  (e) => ok(e.statusCode === 422 && /duration/i.test(e.message), "unreadable container → self-explaining 422")
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
