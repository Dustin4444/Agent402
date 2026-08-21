// Minimal transactional email sender for the human front door - so a buyer who
// closes the tab still gets their report link. Provider-agnostic, dependency-
// free (plain fetch). Currently wired for Resend (simplest; free tier). Gated on
// RESEND_API_KEY + EMAIL_FROM - a no-op that returns false when unconfigured, so
// nothing breaks before email is set up. NEVER throws into the caller.
const RESEND_URL = "https://api.resend.com/emails";

export function emailEnabled() {
  return Boolean((process.env.RESEND_API_KEY || "").trim() && (process.env.EMAIL_FROM || "").trim());
}

/** Send one email. Returns true on a 2xx, false otherwise (never throws). */
export async function sendEmail({ to, subject, html, text }) {
  if (!emailEnabled() || !to) return false;
  try {
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY.trim()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: process.env.EMAIL_FROM.trim(), to: [to], subject, html, text }),
      signal: AbortSignal.timeout(12_000),
    });
    return res.ok;
  } catch { return false; }
}

/** "Here's your report" email with the durable link. Best-effort. */
export async function sendReportReadyEmail({ to, reportUrl, productLabel, subjectOf }) {
  const subj = `Your ${productLabel || "report"} is ready`;
  const on = subjectOf ? ` on “${String(subjectOf).slice(0, 100)}”` : "";
  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;color:#14201b">
    <h2 style="font-weight:500;color:#14201b">Your ${escapeHtml(productLabel || "report")} is ready</h2>
    <p style="color:#35443c">Your report${escapeHtml(on)} is finished and waiting for you. It's yours to keep — open it any time with the link below.</p>
    <p style="margin:26px 0"><a href="${escapeAttr(reportUrl)}" style="background:#15654a;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">Open your report →</a></p>
    <p style="color:#8a948c;font-size:13px">Or paste this link into your browser:<br>${escapeHtml(reportUrl)}</p>
    <p style="color:#8a948c;font-size:12px;margin-top:28px">Agent402 · cited reports · pay per report</p>
  </div>`;
  const text = `Your ${productLabel || "report"}${on} is ready.\n\nOpen it here (yours to keep): ${reportUrl}\n\nAgent402`;
  return sendEmail({ to, subject: subj, html, text });
}

function escapeHtml(s) { return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
function escapeAttr(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
