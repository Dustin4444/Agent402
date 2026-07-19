// Sanitize attacker-controlled text before it is interpolated into a log line
// (audit F24). Strips ANSI/CSI escape sequences and all C0/C1 control
// characters (including CR and LF), so an attacker cannot forge log lines,
// split a line to hide context, or emit terminal control sequences that
// confuse a human or a log parser. Length-capped defensively.
export function logSafe(value, max = 200) {
  return String(value == null ? "" : value)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // ANSI/CSI escape sequences
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "")      // C0 controls (incl. CR/LF/TAB), DEL, C1 controls
    .slice(0, max);
}
