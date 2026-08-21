// Minimal transactional email sender for the human front door - so a buyer who
// closes the tab still gets their report link. Provider-agnostic, dependency-
// free (plain fetch over each provider's HTTP API). Supports Zoho ZeptoMail
// (recommended - the domain is already on Zoho) and Resend. Gated on the
// provider's key + EMAIL_FROM - a no-op that returns false when unconfigured, so
// nothing breaks before email is set up. NEVER throws into the caller.
const RESEND_URL = "https://api.resend.com/emails";
// ZeptoMail region base (api.zeptomail.com default; .eu / .in for those regions).
const ZEPTO_URL = () => (process.env.ZEPTOMAIL_URL || "https://api.zeptomail.com/v1.1/email").trim();

const key = (n) => (process.env[n] || "").trim();

export function emailEnabled() {
  return Boolean(key("EMAIL_FROM") && (key("ZEPTOMAIL_TOKEN") || key("RESEND_API_KEY")));
}

/** Send one email via whichever provider is configured. 2xx -> true; never throws. */
export async function sendEmail({ to, subject, html, text }) {
  if (!emailEnabled() || !to) return false;
  const from = key("EMAIL_FROM");
  try {
    if (key("ZEPTOMAIL_TOKEN")) {
      // ZeptoMail: token is the FULL "Zoho-enczapikey <token>" value or just the
      // token; accept both. from must be a verified ZeptoMail sender address.
      const tok = key("ZEPTOMAIL_TOKEN");
      const auth = /^Zoho-enczapikey/i.test(tok) ? tok : `Zoho-enczapikey ${tok}`;
      const res = await fetch(ZEPTO_URL(), {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          from: { address: from, name: key("EMAIL_FROM_NAME") || "Agent402" },
          to: [{ email_address: { address: to } }],
          subject, htmlbody: html, textbody: text,
        }),
        signal: AbortSignal.timeout(12_000),
      });
      return res.ok;
    }
    // Resend
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key("RESEND_API_KEY")}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html, text }),
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
