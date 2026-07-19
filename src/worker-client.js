// Client for the secretless browser/media worker (audit F02/F04/F06).
//
// When RENDER_WORKER_URL is set, the render/screenshot/media handlers run in a
// SEPARATE service that holds no payment/DB/operator/provider secrets and no
// /data mount (see worker/server.js) — so a Chromium or ffmpeg/ffprobe RCE from
// hostile page/media content lands in a box with nothing worth stealing. Unset
// => everything runs in-process, exactly as before (this is the default; prod
// behavior is unchanged until the worker is deployed and the flag is set).
//
// Platform note: on Railway the worker still can't enable Chromium's own sandbox
// (no userns/seccomp) or a network egress firewall — those stay documented
// limitations. What this achieves is the big one: removing the secrets from
// blast range of a browser/parser compromise.
const workerUrl = () => (process.env.RENDER_WORKER_URL || "").trim().replace(/\/$/, "");
const workerToken = () => (process.env.RENDER_WORKER_TOKEN || "").trim();
const WORKER_TIMEOUT_MS = Number(process.env.RENDER_WORKER_TIMEOUT_MS) || 75_000;

export function workerEnabled() { return Boolean(workerUrl()); }

// Dispatch one browser/media job to the worker. Returns the tool's JSON result,
// or `{ __binary: Buffer, contentType }` for a binary result (screenshot PNG).
export async function runOnWorker(slug, input, { signal } = {}) {
  const base = workerUrl();
  if (!base) throw Object.assign(new Error("render worker not configured"), { statusCode: 503 });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), WORKER_TIMEOUT_MS);
  if (signal) signal.addEventListener("abort", () => ac.abort(), { once: true });
  const token = workerToken();
  let res;
  try {
    res = await fetch(`${base}/call`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ slug, input }),
      signal: ac.signal,
    });
  } catch (e) {
    throw Object.assign(new Error(`render worker unreachable: ${e.name === "AbortError" ? "timeout" : e.message}`), { statusCode: 503 });
  } finally { clearTimeout(timer); }
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-JSON */ }
  if (!res.ok) throw Object.assign(new Error(body?.error || `render worker HTTP ${res.status}`), { statusCode: res.status });
  if (body && body.__binary) return { __binary: Buffer.from(body.__binary, "base64"), contentType: body.contentType };
  return body;
}
