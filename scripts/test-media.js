// Media-kit tests: generate a real 2s sine-wave WAV with ffmpeg (present on CI
// runners and in the production image), then exercise the pure transforms on
// buffers. Skips cleanly where ffmpeg is unavailable (e.g. local sandboxes).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeMedia, toMp3, normalizeAudio } from "../src/tools/media-kit.js";

const fail = (m) => { console.error("FAIL:", m); process.exit(1); };

try {
  execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
} catch {
  console.log("SKIP: ffmpeg not installed in this environment (CI and production have it)");
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), "a402-media-test-"));
const wavPath = join(dir, "tone.wav");
execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", wavPath], { stdio: "ignore" });
const wav = readFileSync(wavPath);
console.log(`generated test tone: ${wav.length} bytes`);

const info = await probeMedia(wav);
if (!info.durationSec || Math.abs(info.durationSec - 4) > 0.3) fail(`probe duration wrong: ${JSON.stringify(info)}`);
if (info.streams[0]?.type !== "audio") fail("probe missed the audio stream");
console.log(`media-info ✓ (duration ${info.durationSec}s, codec ${info.streams[0].codec})`);

const mp3 = await toMp3(wav, { bitrate: "128k" });
if (!mp3.mp3Base64 || mp3.bytes < 1000) fail(`toMp3 output too small: ${mp3.bytes}`);
const mp3buf = Buffer.from(mp3.mp3Base64, "base64");
const mp3info = await probeMedia(mp3buf);
if (!/mp3/.test(mp3info.formatName ?? "")) fail(`mp3 round-trip not mp3: ${mp3info.formatName}`);
console.log(`audio-convert ✓ (${mp3.bytes} bytes, probes back as ${mp3info.formatName})`);

// Measure a buffer's REAL integrated loudness (LUFS) with ffmpeg's ebur128 —
// this is what proves audio-normalize actually changed the loudness, not just
// "returned a valid mp3".
async function measureLufs(buffer) {
  const dir = mkdtempSync(join(tmpdir(), "a402-lufs-"));
  const p = join(dir, "m");
  writeFileSync(p, buffer);
  // execFileSync only exposes stderr via the thrown Error's .stderr field,
  // which only happens on a non-zero exit — but `-f null -` with the
  // ebur128 filter exits 0 on success (verified: consistently 0 on both
  // macOS/CI ffmpeg builds), so the old try/catch here silently discarded
  // the captured stderr on every successful run and this always returned
  // null. spawnSync returns {stdout, stderr, status} regardless of exit
  // code, so it actually captures the LUFS summary ffmpeg prints to stderr.
  const res = spawnSync("ffmpeg", ["-i", p, "-af", "ebur128=framelog=verbose", "-f", "null", "-"], { stdio: ["ignore", "ignore", "pipe"] });
  const stderr = (res.stderr || "").toString();
  rmSync(dir, { recursive: true, force: true });
  // ffmpeg prints a summary block ending with "I:  -23.0 LUFS"
  const matches = [...stderr.matchAll(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/g)];
  return matches.length ? Number(matches[matches.length - 1][1]) : null;
}

// ffmpeg's lavfi sine source has no amplitude knob (verified: -h filter=sine
// lists no such option) and its default output level is not a portable
// constant to assume a sign on - measured -21.8 LUFS on this build, which is
// QUIETER than the -16 target below, not louder. Assert the real, direction-
// independent claim instead: normalization moves loudness TOWARD the target,
// not "always gets quieter" (that assumption silently went untested for as
// long as measureLufs() itself was broken - see the fix note above).
const TARGET_LUFS = -16;
const beforeLufs = await measureLufs(wav);
if (beforeLufs === null) fail("could not measure input loudness");
const norm = await normalizeAudio(wav, { targetLufs: TARGET_LUFS });
if (!norm.mp3Base64 || norm.targetLufs !== TARGET_LUFS) fail(`normalize wrong: ${JSON.stringify({ ...norm, mp3Base64: "…" })}`);
const normBuf = Buffer.from(norm.mp3Base64, "base64");
const ninfo = await probeMedia(normBuf);
if (!ninfo.durationSec || ninfo.durationSec < 1.5) fail("normalized audio lost its duration");
const afterLufs = await measureLufs(normBuf);
if (afterLufs === null) fail("could not measure output loudness");
// The output must actually sit near the target (loudnorm one-pass tolerance
// is generous, so allow ±3 LU) AND be closer to it than the input was -
// proves normalization actually moved the level, not just re-encoded it.
if (Math.abs(afterLufs - TARGET_LUFS) > 3) fail(`audio-normalize did NOT hit target: asked ${TARGET_LUFS} LUFS, output measured ${afterLufs} LUFS (input was ${beforeLufs})`);
if (Math.abs(afterLufs - TARGET_LUFS) >= Math.abs(beforeLufs - TARGET_LUFS)) fail(`normalization did not move loudness toward the target: input ${beforeLufs} LUFS (${Math.abs(beforeLufs - TARGET_LUFS).toFixed(1)} LU from target) -> output ${afterLufs} LUFS (${Math.abs(afterLufs - TARGET_LUFS).toFixed(1)} LU from target)`);
console.log(`audio-normalize ✓ REALLY normalized: input ${beforeLufs} LUFS → output ${afterLufs} LUFS (target ${TARGET_LUFS})`);

// audio-convert must preserve the actual audio (duration within 0.1s), not
// just emit bytes.
const conv = await toMp3(wav, { bitrate: "192k" });
const convInfo = await probeMedia(Buffer.from(conv.mp3Base64, "base64"));
if (Math.abs((convInfo.durationSec ?? 0) - (info.durationSec ?? 0)) > 0.15) fail(`audio-convert changed duration: ${info.durationSec} -> ${convInfo.durationSec}`);
console.log(`audio-convert ✓ preserved audio (${info.durationSec}s in → ${convInfo.durationSec}s out)`);

// validation
let threw = false;
try { await toMp3(wav, { bitrate: "lots" }); } catch { threw = true; }
if (!threw) fail("bad bitrate should be rejected");
try { await normalizeAudio(wav, { targetLufs: 5 }); fail("LUFS +5 should be rejected"); } catch {}
try { await probeMedia(Buffer.from("not media")); fail("garbage should be rejected"); } catch {}
console.log("validation ✓ (bitrate, LUFS range, non-media rejected)");

rmSync(dir, { recursive: true, force: true });
console.log("\nmedia-kit: all assertions passed");
process.exit(0);
