// redactSecrets — scrub configured secret VALUES out of upstream-derived text
// before it can reach a buyer-facing error message.
//
// The paid kits deliberately relay an upstream 4xx error message (parsed
// error.message or a 200-char body slice) so agents can self-correct — but
// that text comes from the upstream, and an upstream CAN echo the credential
// we sent it (OpenAI's real invalid_api_key message quotes the key; a
// misbehaving or compromised upstream could echo it on any status). The route
// binder returns err.message verbatim, so anything a handler throws is
// buyer-visible AND logged. This helper makes the relay categorically safe:
// any occurrence of a configured secret value is replaced with "[redacted]",
// everything else passes through unchanged.
//
// Scope: every env var whose NAME looks secret-bearing (KEY/TOKEN/SECRET/
// PASSWORD/MNEMONIC/PRIVATE). Values shorter than 8 chars are skipped — real
// keys are longer, and redacting tiny values would mangle innocent substrings.
const SECRET_NAME_RE = /(KEY|TOKEN|SECRET|PASSWORD|MNEMONIC|PRIVATE)/i;
const MIN_SECRET_LEN = 8;

export function redactSecrets(text) {
  let out = String(text ?? "");
  if (!out) return out;
  for (const [name, raw] of Object.entries(process.env)) {
    if (!SECRET_NAME_RE.test(name)) continue;
    const value = typeof raw === "string" ? raw.trim() : "";
    if (value.length < MIN_SECRET_LEN) continue;
    if (out.includes(value)) out = out.split(value).join("[redacted]");
  }
  return out;
}
