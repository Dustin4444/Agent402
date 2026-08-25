// Validation kit — phone formatting, XML well-formedness, CSV linting,
// cron-next scheduling, IPv6 expansion. Pure-CPU format validators that
// agents reach for when sanitising input or verifying identifiers.
// No network, no npm deps — proof-of-work eligible (free tier).

function bad(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

// ---- phone country configs --------------------------------------------------
const PHONE_COUNTRIES = {
  US: { code: "1",  len: [10],     fmt: (d) => `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}` },
  UK: { code: "44", len: [10, 11], fmt: (d) => `${d.slice(0,4)} ${d.slice(4)}` },
  DE: { code: "49", len: [10, 11], fmt: (d) => `${d.slice(0,4)} ${d.slice(4)}` },
  FR: { code: "33", len: [9],      fmt: (d) => `${d.slice(0,1)} ${d.slice(1,3)} ${d.slice(3,5)} ${d.slice(5,7)} ${d.slice(7)}` },
  AU: { code: "61", len: [9],      fmt: (d) => `${d.slice(0,4)} ${d.slice(4)}` },
  IN: { code: "91", len: [10],     fmt: (d) => `${d.slice(0,5)} ${d.slice(5)}` },
};

function detectCountry(digits) {
  if (digits.startsWith("1") && digits.length === 11) return { country: "US", national: digits.slice(1) };
  if (digits.startsWith("44")) return { country: "UK", national: digits.slice(2) };
  if (digits.startsWith("49")) return { country: "DE", national: digits.slice(2) };
  if (digits.startsWith("33")) return { country: "FR", national: digits.slice(2) };
  if (digits.startsWith("61")) return { country: "AU", national: digits.slice(2) };
  if (digits.startsWith("91")) return { country: "IN", national: digits.slice(2) };
  if (digits.startsWith("1")) return { country: "US", national: digits.slice(1) };
  return null;
}

// ---- XML well-formedness checker (pure regex + stack) -----------------------
function xmlValidate(xml) {
  const errors = [];
  const stack = [];
  const stripped = xml.replace(/<\?[\s\S]*?\?>/g, "").replace(/<!--[\s\S]*?-->/g, "");
  const tagRe = /<\/?([a-zA-Z_][\w.:_-]*)([\s\S]*?)(\/?)>/g;
  let match;
  while ((match = tagRe.exec(stripped))) {
    const [full, name, , selfClose] = match;
    if (full.startsWith("</")) {
      if (stack.length === 0) { errors.push(`Closing tag </${name}> without matching open tag`); }
      else if (stack[stack.length - 1] !== name) { errors.push(`Expected </${stack[stack.length - 1]}> but found </${name}>`); }
      else { stack.pop(); }
    } else if (!selfClose) {
      stack.push(name);
    }
  }
  for (const tag of stack) errors.push(`Unclosed tag <${tag}>`);
  const noTags = stripped.replace(/<[^>]*>/g, "");
  if (noTags.includes("<")) errors.push("Unexpected '<' character in content");
  const cleaned = noTags.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/g, "");
  if (cleaned.includes("&")) errors.push("Unescaped '&' character in content");
  return errors;
}

// ---- CSV structure checker --------------------------------------------------
function csvLint(text, delimiter) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { valid: true, rows: 0, columns: 0, errors: [], delimiter };
  const errors = [];
  const columnCounts = [];
  for (let i = 0; i < lines.length; i++) {
    let cols = 0, inQuote = false;
    for (let j = 0; j < lines[i].length; j++) {
      const ch = lines[i][j];
      if (ch === '"') { inQuote = !inQuote; }
      else if (ch === delimiter && !inQuote) { cols++; }
    }
    if (inQuote) errors.push(`Row ${i + 1}: unclosed quote`);
    columnCounts.push(cols + 1);
  }
  const expected = columnCounts[0];
  for (let i = 1; i < columnCounts.length; i++) {
    if (columnCounts[i] !== expected) {
      errors.push(`Row ${i + 1}: expected ${expected} columns, found ${columnCounts[i]}`);
    }
  }
  return { valid: errors.length === 0, rows: lines.length, columns: expected, errors, delimiter };
}


// ---- IPv6 expand/compress ---------------------------------------------------
function ipv6Expand(addr) {
  let full = addr.toLowerCase().trim();
  if (full.includes("::")) {
    // "::" may appear at most once; "1::2::3" is invalid. split("::") on multiple
    // occurrences silently dropped groups and returned a bogus "valid" result.
    if (full.indexOf("::") !== full.lastIndexOf("::")) throw bad("invalid IPv6 address: '::' may appear only once");
    const [left, right] = full.split("::");
    const lGroups = left ? left.split(":") : [];
    const rGroups = right ? right.split(":") : [];
    const missing = 8 - lGroups.length - rGroups.length;
    if (missing < 0) throw bad("too many groups in IPv6 address");
    const mid = Array(missing).fill("0000");
    full = [...lGroups, ...mid, ...rGroups].join(":");
  }
  const groups = full.split(":");
  if (groups.length !== 8) throw bad(`IPv6 address must have 8 groups (got ${groups.length})`);
  const expanded = groups.map((g) => {
    if (!/^[0-9a-f]{1,4}$/.test(g)) throw bad(`invalid IPv6 group "${g}"`);
    return g.padStart(4, "0");
  });
  return expanded.join(":");
}

function ipv6Compress(expanded) {
  const groups = expanded.split(":").map((g) => g.replace(/^0+/, "") || "0");
  let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
  for (let i = 0; i < groups.length; i++) {
    if (groups[i] === "0") {
      if (curStart === -1) curStart = i;
      curLen++;
      if (curLen > bestLen) { bestStart = curStart; bestLen = curLen; }
    } else { curStart = -1; curLen = 0; }
  }
  if (bestLen >= 2) {
    const before = groups.slice(0, bestStart).join(":");
    const after = groups.slice(bestStart + bestLen).join(":");
    return (before ? before : "") + "::" + (after ? after : "");
  }
  return groups.join(":");
}

export const VALIDATION_TOOLS = [


  // ---- 3. csv-lint ---------------------------------------------------------
  {
    route: "POST /api/csv-lint", name: "CSV lint", slug: "csv-lint", category: "validation", price: "$0.001",
    description:
      "Validate CSV structure: consistent column counts across rows, properly closed quotes, delimiter detection. Returns row/column counts and any structural errors. Pure CPU.",
    tags: ["csv", "validation", "lint"],
    discovery: {
      bodyType: "json",
      input: { text: "name,age,city\nAlice,30,NYC\nBob,25,LA" },
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "CSV text to validate" },
          delimiter: { type: "string", description: "column delimiter (default \",\")" },
        },
        required: ["text"],
      },
      output: { example: { valid: true, rows: 3, columns: 3, errors: [], delimiter: "," } },
    },
    handler(input) {
      if (!input.text || typeof input.text !== "string") throw bad('Missing or invalid "text"');
      const delimiter = (input.delimiter || ",").charAt(0);
      return csvLint(input.text, delimiter);
    },
  },


];
