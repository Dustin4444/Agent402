// Guards for CALLER-SUPPLIED regexes that run on the main event loop.
//
// All ~1,400 tools share one Node event loop, and a synchronous regex with
// catastrophic backtracking (ReDoS) freezes it for everyone — an unauthenticated,
// free-tier DoS. The dedicated `regex` tool sandboxes arbitrary patterns in a
// worker thread with a hard timeout; convenience tools that accept a user regex
// (json-validate's schema.pattern, html-links' filter) use this lightweight guard
// instead: it rejects the common backtracking forms and over-long patterns before
// compiling. Not a full sandbox — a length + shape guard sized to the risk.

export function compileUserRegex(pattern, flags = "") {
  const p = String(pattern ?? "");
  const fail = (msg) => { const e = new Error(msg); e.statusCode = 400; throw e; };
  if (p.length > 200) fail("regex pattern too long (max 200 chars)");
  // Classic ReDoS signature: a quantifier, a group close, another quantifier —
  // (a+)+, (a*)*, (.+)*, ([a-z]+)+ … These blow up exponentially and are the
  // exact shape the DoS review demonstrated. Reject them.
  if (/[+*]\)[+*]/.test(p) || /[+*]\)\{/.test(p) || /\}\)[+*]/.test(p)) {
    fail("regex rejected: nested quantifiers risk catastrophic backtracking — simplify the pattern");
  }
  try {
    return new RegExp(p, flags);
  } catch (e) {
    return fail(`invalid regex: ${e.message}`);
  }
}

// Escape a value so it can be inserted into a regex as a LITERAL (no injection).
export function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
