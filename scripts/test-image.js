// Pure-CPU tests for the image kit: generate an image, then resize / convert /
// thumbnail / crop / palette it and verify the output decodes at the expected
// size and format. The EXIF parser is tested against a hand-crafted TIFF so no
// network is needed (the live URL path is covered by test-all's example check).
import { Jimp, JimpMime } from "jimp";
import { IMAGE_TOOLS, extractExifBuffer, parseTiff, sniffFormat } from "../src/tools/image-kit.js";

const tool = (slug) => IMAGE_TOOLS.find((t) => t.slug === slug).handler;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// Source: a 200x100 red PNG.
const src = new Jimp({ width: 200, height: 100, color: 0xff0000ff });
const srcB64 = (await src.getBuffer(JimpMime.png)).toString("base64");

// resize to width 50 → proportional height 25
let r = await tool("image-resize")({ image: srcB64, width: 50 });
let img = await Jimp.read(r.__binary);
ok(img.width === 50 && img.height === 25, `resize width=50 → 50x25 proportional (got ${img.width}x${img.height})`);
ok(r.contentType === JimpMime.png, `resize defaults to png (got ${r.contentType})`);

// resize to explicit 80x80
r = await tool("image-resize")({ image: srcB64, width: 80, height: 80 });
img = await Jimp.read(r.__binary);
ok(img.width === 80 && img.height === 80, `resize 80x80 (got ${img.width}x${img.height})`);

// convert to jpeg
r = await tool("image-convert")({ image: srcB64, format: "jpeg", quality: 70 });
ok(r.contentType === JimpMime.jpeg && r.__binary[0] === 0xff && r.__binary[1] === 0xd8, `convert to jpeg (magic ${r.__binary[0].toString(16)} ${r.__binary[1].toString(16)})`);

// thumbnail 64x64 square
r = await tool("image-thumbnail")({ image: srcB64, size: 64 });
img = await Jimp.read(r.__binary);
ok(img.width === 64 && img.height === 64, `thumbnail 64x64 square (got ${img.width}x${img.height})`);

// crop: 50x40 box at (10,10) from the 200x100 source (base64 path — no network)
r = await tool("image-crop")({ image: srcB64, left: 10, top: 10, width: 50, height: 40 });
img = await Jimp.read(r.__binary);
ok(img.width === 50 && img.height === 40, `crop 50x40 (got ${img.width}x${img.height})`);

// crop + rotate 90 → dimensions swap
r = await tool("image-crop")({ image: srcB64, left: 0, top: 0, width: 50, height: 40, rotate: 90 });
img = await Jimp.read(r.__binary);
ok(img.width === 40 && img.height === 50, `crop then rotate 90 swaps dims (got ${img.width}x${img.height})`);

// crop dataUri output
r = await tool("image-crop")({ image: srcB64, left: 0, top: 0, width: 20, height: 10, dataUri: true });
ok(typeof r.dataUri === "string" && r.dataUri.startsWith("data:image/png;base64,") && r.width === 20 && r.height === 10, "crop dataUri:true returns a JSON data URI");

// crop out-of-bounds box → 400
try { await tool("image-crop")({ image: srcB64, left: 190, top: 0, width: 50, height: 40 }); ok(false, "out-of-bounds crop should throw"); }
catch (e) { ok(e.statusCode === 400, "out-of-bounds crop throws 400"); }

// crop with nothing to do → 400
try { await tool("image-crop")({ image: srcB64 }); ok(false, "no-op crop should throw"); }
catch (e) { ok(e.statusCode === 400, "crop with no box/rotate/flip throws 400"); }

// dominant color of a solid red image → one bucket, pure red, ratio 1
r = await tool("image-dominant-color")({ image: srcB64, colors: 3 });
ok(r.colors.length === 1 && r.colors[0].hex === "#ff0000" && r.colors[0].ratio === 1, `dominant color of solid red is #ff0000 @ 1.0 (got ${JSON.stringify(r.colors)})`);
ok(r.width === 200 && r.height === 100, `dominant color reports source dims (got ${r.width}x${r.height})`);

// exif: jimp-generated PNG carries no EXIF → empty result, not an error
r = await tool("image-exif")({ image: srcB64 });
ok(r.format === "png" && r.hasExif === false && Object.keys(r.exif).length === 0, `stripped image → hasExif:false, empty exif (got ${JSON.stringify(r.exif)})`);
ok(r.width === 200 && r.height === 100, `exif reports dims for stripped image (got ${r.width}x${r.height})`);

// exif: hand-crafted little-endian TIFF with Make="Canon" + Orientation=1,
// wrapped in a JPEG APP1 segment — exercises both the extractor and the parser.
{
  const tiff = Buffer.alloc(44);
  tiff.write("II", 0, "ascii");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4); // IFD0 at offset 8
  tiff.writeUInt16LE(2, 8); // 2 entries
  // entry 1: Make (0x010f), ASCII, count 6, value at offset 38
  tiff.writeUInt16LE(0x010f, 10); tiff.writeUInt16LE(2, 12); tiff.writeUInt32LE(6, 14); tiff.writeUInt32LE(38, 18);
  // entry 2: Orientation (0x0112), SHORT, count 1, inline value 1
  tiff.writeUInt16LE(0x0112, 22); tiff.writeUInt16LE(3, 24); tiff.writeUInt32LE(1, 26); tiff.writeUInt16LE(1, 30);
  tiff.writeUInt32LE(0, 34); // next IFD: none
  tiff.write("Canon\0", 38, "ascii");
  const parsed = parseTiff(tiff);
  ok(parsed && parsed.exif.Make === "Canon" && parsed.exif.Orientation === 1, `parseTiff reads Make/Orientation (got ${JSON.stringify(parsed && parsed.exif)})`);
  // wrap in a minimal JPEG: SOI + APP1(Exif) + EOI
  const app1 = Buffer.concat([Buffer.from("Exif\0\0", "ascii"), tiff]);
  const seg = Buffer.alloc(4);
  seg[0] = 0xff; seg[1] = 0xe1; seg.writeUInt16BE(app1.length + 2, 2);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), seg, app1, Buffer.from([0xff, 0xd9])]);
  ok(sniffFormat(jpeg) === "jpeg", "sniffFormat detects the crafted JPEG");
  const extracted = extractExifBuffer(jpeg);
  ok(extracted && parseTiff(extracted).exif.Make === "Canon", "extractExifBuffer pulls the APP1 TIFF out of a JPEG");
}

// validation: missing image
try { await tool("image-resize")({ width: 50 }); ok(false, "missing image should throw"); }
catch (e) { ok(e.statusCode === 400, "missing image throws 400"); }
// validation: garbage base64
try { await tool("image-convert")({ image: "not!!an!!image", format: "png" }); ok(false, "garbage should throw"); }
catch (e) { ok(e.statusCode === 400, "garbage image throws 400"); }
// validation: neither url nor image on a URL-capable tool
try { await tool("image-exif")({}); ok(false, "missing url+image should throw"); }
catch (e) { ok(e.statusCode === 400, "image-exif without url/image throws 400"); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
