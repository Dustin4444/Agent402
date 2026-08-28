// House style for everything a person reads: no em dashes, no en dashes.
//
// Every report body is model-written, and the models reach for "—" in
// headings and prose no matter what the prompt says. This is the one place
// the rule is enforced, applied to every report tier's output at the catalog
// (server.js wraps each REPORT_TIERS handler), so agents, card buyers,
// monitors and the sample pages all read the same style. A heading's dash
// becomes a colon ("NVIDIA CORP (NVDA): Company Due-Diligence Dossier"),
// prose gets a spaced hyphen, a bare range "2024–2026" a plain hyphen.
const DASH = /[—–]/;
const RANGE = /(\d)\s*[—–]\s*(\d)/g;

export function houseStyleText(s, { heading = false } = {}) {
  if (typeof s !== "string" || !DASH.test(s)) return s;
  let out = s.replace(RANGE, "$1-$2");
  out = out.replace(/\s*[—–]+\s*/g, heading ? ": " : " - ");
  return out.replace(/ {2,}/g, " ");
}

export function houseStyleMarkdown(md) {
  if (typeof md !== "string" || !DASH.test(md)) return md;
  return md.split("\n").map((line) => houseStyleText(line, { heading: /^#{1,6}\s/.test(line) })).join("\n");
}

const SKIP_KEYS = new Set(["url", "href", "b64", "hash", "tx", "id", "publicId", "sessionId", "accession", "raw"]);
const MARKDOWN_KEYS = new Set(["report", "article", "body", "markdown", "post", "post_caption", "summary"]);

/** Apply house style to every string in a report bundle (bounded depth). */
export function houseStyleBundle(v, depth = 0, key = "") {
  if (depth > 8 || v == null) return v;
  if (typeof v === "string") return MARKDOWN_KEYS.has(key) ? houseStyleMarkdown(v) : houseStyleText(v, { heading: key === "title" || key === "headline" });
  if (Array.isArray(v)) return v.map((x) => houseStyleBundle(x, depth + 1, key));
  if (typeof v === "object") {
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return v;
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = SKIP_KEYS.has(k) ? x : houseStyleBundle(x, depth + 1, k);
    // Non-enumerable sentinels (the metered upstream marker) must survive.
    for (const k of Object.getOwnPropertyNames(v)) if (!(k in out)) Object.defineProperty(out, k, Object.getOwnPropertyDescriptor(v, k));
    return out;
  }
  return v;
}

/** Wrap a catalog handler so its result obeys house style. */
export function withHouseStyle(handler) {
  const wrapped = async function (...args) { return houseStyleBundle(await handler.apply(this, args)); };
  return wrapped;
}
