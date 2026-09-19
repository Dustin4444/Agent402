// One multipart/form-data body, parsed for ONE file plus its text fields.
//
// Why by hand. OpenAI's transcription wire is multipart - a Whisper-shaped SDK
// sends `file` as binary and `model` as a field - and Express 5 parses no
// multipart at all. We served /v1/audio/speech, /v1/rerank and /v1/embeddings
// on OpenAI's own paths while /v1/audio/transcriptions answered 404, so an SDK
// pointed at this gateway spoke to three routes and then looked broken on the
// fourth. Adding a parser dependency for one endpoint is a supply-chain cost
// for a well-bounded problem, and this repo already does byte-level work where
// it is the smaller risk (keccak in the tollbooth, base58 in the SVM payer).
//
// Deliberately NOT a general parser: exactly one file part is returned, every
// other part must be a small text field, and the whole thing is bounded before
// a byte is scanned. A general multipart parser is where the CVEs live.
const CRLF2 = Buffer.from("\r\n\r\n");

/** The boundary token from a Content-Type header, or null. */
export function boundaryOf(contentType) {
  const m = /^multipart\/form-data\s*;(?:.*;)?\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(String(contentType || ""));
  const b = m ? (m[1] || m[2]) : null;
  // RFC 2046 caps a boundary at 70 characters; anything longer is not one.
  return b && b.length <= 70 ? b : null;
}

/**
 * @returns {{ fields: Record<string,string>, file: { buf: Buffer, filename: string, field: string } | null }}
 * @throws  {Error} with .statusCode on a malformed or over-bound body
 */
export function parseMultipartFile(body, contentType, { maxParts = 12, maxFieldBytes = 4096 } = {}) {
  const boundary = boundaryOf(contentType);
  if (!boundary) { const e = new Error('Content-Type must be multipart/form-data with a boundary'); e.statusCode = 400; throw e; }
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body || "");
  const sep = Buffer.from(`--${boundary}`);
  const fields = {};
  let file = null;
  let parts = 0;
  let i = buf.indexOf(sep);
  if (i < 0) { const e = new Error("multipart body carries no boundary marker"); e.statusCode = 400; throw e; }
  while (i >= 0) {
    let start = i + sep.length;
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break; // closing "--"
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;
    const next = buf.indexOf(sep, start);
    if (next < 0) break;
    if (++parts > maxParts) { const e = new Error(`multipart body has more than ${maxParts} parts`); e.statusCode = 400; throw e; }
    // The part's own trailing CRLF belongs to the delimiter, not the content.
    const end = next - 2 >= start ? next - 2 : start;
    const hdrEnd = buf.indexOf(CRLF2, start);
    if (hdrEnd < 0 || hdrEnd > end) { i = next; continue; }
    const headers = buf.slice(start, hdrEnd).toString("latin1");
    const name = /name="([^"]*)"/i.exec(headers)?.[1] || "";
    const filename = /filename="([^"]*)"/i.exec(headers)?.[1];
    const content = buf.slice(hdrEnd + 4, end);
    if (filename !== undefined) {
      // First file part wins; a second is refused rather than silently dropped.
      if (file) { const e = new Error("send exactly one file part"); e.statusCode = 400; throw e; }
      file = { buf: content, filename: filename || "audio", field: name };
    } else if (name) {
      if (content.length > maxFieldBytes) { const e = new Error(`field "${name}" is too large`); e.statusCode = 400; throw e; }
      fields[name] = content.toString("utf8");
    }
    i = next;
  }
  return { fields, file };
}
