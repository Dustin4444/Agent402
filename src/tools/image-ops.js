// Pure-CPU image primitives, split out of image-kit.js so the SAME code runs on
// the main thread (for the wallet-only tools) and inside src/tools/image-worker.js
// (for the three compute-payable tools that are free on the authless connector
// and via proof-of-work). Sharing one implementation is the point: the worker
// must produce byte-identical output and byte-identical error messages, and a
// second copy of the resize/convert/thumbnail logic would drift.
//
// Nothing here may touch the network or the filesystem: this module is loaded in
// a worker thread where safeFetch's SSRF guard is not the gate that ran.
import { Jimp, JimpMime } from "jimp";

export function bad(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

export const MAX_SRC_PIXELS = 40_000_000; // ~6300x6300 source cap
export const MAX_DIM = 4096; // output dimension cap
export const MIME = { png: JimpMime.png, jpeg: JimpMime.jpeg, jpg: JimpMime.jpeg, bmp: JimpMime.bmp };

// Source-pixel ceiling for the base64-only loader, which is used by exactly the
// three compute-payable image tools (resize/convert/thumbnail) - i.e. the ones
// reachable FREE on the authless connector and via proof-of-work. Jimp decodes
// in pure JS and synchronously, so source pixels translate directly into
// blocking milliseconds on whichever thread runs the decode. 16M (4000x4000)
// still covers a resize up to the 4096 output cap while refusing the small-file
// /huge-canvas shape (a ~100KB solid-colour PNG can declare 25M pixels). The
// URL-capable loader keeps the full MAX_SRC_PIXELS - those slugs are wallet-only.
// The cap survives the move off-thread because it is now what bounds a WORKER's
// memory: one 16M-pixel bitmap is a 64MB Buffer, and the pool size multiplies it.
export const FREE_MAX_SRC_PIXELS = 16_000_000;

export const posInt = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : null; };

export function sniffFormat(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return "png";
  if (buf.length >= 6 && buf.toString("ascii", 0, 3) === "GIF") return "gif";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (buf.length >= 2 && buf.toString("ascii", 0, 2) === "BM") return "bmp";
  if (buf.length >= 4 && (buf.toString("ascii", 0, 4) === "II*\0" || buf.toString("ascii", 0, 4) === "MM\0*")) return "tiff";
  return "unknown";
}

/** Declared pixel dimensions from the container HEADER, without decoding.
 *  Returns null when the format carries no cheap size field (Jimp then decodes
 *  and the post-decode cap still applies). PNG: IHDR is always the first chunk.
 *  JPEG: the first SOF marker. BMP: the DIB header. GIF: the logical screen
 *  descriptor. All are fixed offsets, so this is a few byte reads. */
export function declaredDimensions(buf) {
  try {
    const format = sniffFormat(buf);
    if (format === "png" && buf.length >= 24 && buf.toString("ascii", 12, 16) === "IHDR") {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (format === "bmp" && buf.length >= 26) {
      return { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) };
    }
    if (format === "gif" && buf.length >= 10) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (format === "jpeg") {
      // Walk the marker chain to the first Start-Of-Frame; bounded by length.
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const len = buf.readUInt16BE(i + 2);
        // SOF0/1/2/3/5/6/7/9/10/11/13/14/15: every non-differential and
        // differential frame header carries height then width at +5.
        if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        if (len < 2) break;
        i += 2 + len;
      }
    }
  } catch { /* malformed header, so fall through to the decoder's own error */ }
  return null;
}

/** Header pre-check for the source-pixel cap. Throws the same 400 the decoded
 *  check throws, so it does not matter which side of the worker boundary the
 *  refusal happens on. Cheap enough to run on the main thread BEFORE a worker is
 *  handed the job, which keeps a hostile small-file/huge-canvas request from
 *  even occupying a pool slot. */
export function assertDeclaredWithinPixelCap(buf, maxPixels) {
  const declared = declaredDimensions(buf);
  if (declared && declared.width > 0 && declared.height > 0 && declared.width * declared.height > maxPixels) {
    throw bad(`source image too large (${declared.width}x${declared.height}; max ${maxPixels} pixels)`);
  }
}

export async function readImage(buf, { maxPixels = MAX_SRC_PIXELS } = {}) {
  // The header check runs first because the post-decode check below arrives too
  // late to protect the thread doing the decoding: Jimp's decode is pure JS and
  // synchronous, so a small file declaring a huge canvas costs seconds of solid
  // CPU before any dimension is known.
  assertDeclaredWithinPixelCap(buf, maxPixels);
  let img;
  try { img = await Jimp.read(buf); }
  catch (e) { throw bad(`could not decode image: ${e.message}`); }
  if (img.width * img.height > maxPixels) throw bad(`source image too large (${img.width}x${img.height})`);
  return img;
}

export async function toBuffer(img, format, quality) {
  const fmt = String(format || "png").toLowerCase();
  const mime = MIME[fmt];
  if (!mime) throw bad('format must be "png", "jpeg", or "bmp"');
  const opts = mime === JimpMime.jpeg ? { quality: Math.min(Math.max(posInt(quality) || 80, 1), 100) } : undefined;
  const buffer = await img.getBuffer(mime, opts);
  return { __binary: buffer, contentType: mime };
}

/** Decode + transform + encode for the three compute-payable tools, as one unit
 *  of work. It is one function because the whole pipeline is synchronous CPU
 *  (decode, resize and encode alike), so splitting it across the worker boundary
 *  would leave part of the cost back on the event loop. Validation order matches
 *  what the handlers did inline before the move (decode errors surface before
 *  parameter errors), so caller-visible behaviour is unchanged. */
export async function runImageOp({ op, buffer, maxPixels = FREE_MAX_SRC_PIXELS, params = {} }) {
  const img = await readImage(buffer, { maxPixels });
  if (op === "resize") {
    let w = posInt(params.width), h = posInt(params.height);
    if (!w && !h) throw bad("provide width and/or height");
    if (w && w > MAX_DIM) w = MAX_DIM;
    if (h && h > MAX_DIM) h = MAX_DIM;
    // One dimension → scale proportionally from the source aspect ratio.
    if (w && !h) h = Math.max(1, Math.round(img.height * (w / img.width)));
    if (h && !w) w = Math.max(1, Math.round(img.width * (h / img.height)));
    img.resize({ w, h });
    return toBuffer(img, params.format, params.quality);
  }
  if (op === "convert") {
    return toBuffer(img, params.format, params.quality);
  }
  if (op === "thumbnail") {
    const size = Math.min(Math.max(posInt(params.size) || 128, 1), 1024);
    img.cover({ w: size, h: size });
    return toBuffer(img, params.format, params.quality);
  }
  throw bad(`unknown image operation: ${op}`);
}
