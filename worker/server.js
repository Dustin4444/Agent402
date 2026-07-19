// Secretless browser + media worker (audit F02/F04/F06).
//
// Runs Chromium (render/screenshot) and ffmpeg/ffprobe (media) in a service that
// holds NO payment/DB/operator/provider secrets and no /data mount. A renderer
// or native-parser compromise from hostile page/media content therefore lands in
// a box with nothing worth stealing. The API calls POST /call over the private
// network with a shared bearer token.
//
// It imports ONLY the browser/media code subtree (render.js, media-kit.js and
// their pure deps), never payments/db/operator, so those modules never even load
// here. A boot guard also fails LOUD if a payment/DB/operator secret is present
// in this process's env — the worker must be secretless by construction.
import express from "express";
import { timingSafeEqual } from "node:crypto";
import { renderArticle, screenshotPage } from "../src/tools/render.js";
import { MEDIA_TOOLS } from "../src/tools/media-kit.js";
import { startEgressProxy } from "./egress-proxy.js";

const PORT = Number(process.env.PORT) || 3999;
const TOKEN = (process.env.RENDER_WORKER_TOKEN || "").trim();

// The tools this worker will run, reusing the exact in-process implementations.
const HANDLERS = {
  render: (input) => renderArticle(input?.url),
  screenshot: async (input) => {
    const png = await screenshotPage(input?.url, { fullPage: input?.fullPage === true || input?.fullPage === "true" });
    return { __binary: Buffer.from(png).toString("base64"), contentType: "image/png" };
  },
};
for (const t of MEDIA_TOOLS) HANDLERS[t.slug] = (input) => t.handler(input || {});

// Boot guard: this worker must be SECRETLESS by construction. It refuses to boot
// (see the isMain block) if any secret-bearing env var is present — a
// misconfigured deployment that would defeat the isolation. The check is
// PATTERN-based (KEY/SECRET/TOKEN/…) so it catches current AND future secrets by
// name, not a hand-kept denylist that drifts behind the app's 30+ secret env
// vars; plus a few secret vars whose names don't match the pattern. The worker's
// OWN inbound-auth token is the sole allowed pattern match. Enforced ONLY at boot
// (not at module import) so a test/CI process — which legitimately has its own
// GITHUB_TOKEN etc. — can import the exports without tripping it. Because Railway
// gates a deploy on the healthcheck, a false positive fails the new deploy
// visibly while the old worker keeps serving, rather than causing an outage.
// NB: no bare "PRIVATE" — Railway injects RAILWAY_PRIVATE_DOMAIN (the worker's
// own private-network hostname, not a secret), and a private KEY is already
// caught by "KEY". Matching "PRIVATE" alone would false-positive and refuse to
// boot on a benign infra var.
const SECRET_NAME_RE = /(KEY|SECRET|TOKEN|MNEMONIC|PASSWORD|CREDENTIAL)/i;
const SECRET_NAME_ALLOW = new Set(["RENDER_WORKER_TOKEN"]);
const FORBIDDEN_ENV = ["WALLET_ADDRESS", "WALLET_ENS", "DATABASE_URL", "ANALYTICS_DATABASE_URL"];
// Pure + exported for tests: the secret-bearing env var names present in `env`.
export function forbiddenSecretsIn(env) {
  return Object.keys(env).filter(
    (k) => (env[k] || "").trim() && !SECRET_NAME_ALLOW.has(k) && (SECRET_NAME_RE.test(k) || FORBIDDEN_ENV.includes(k))
  );
}
const secretsPresent = () => forbiddenSecretsIn(process.env);

// Fail CLOSED: a request is authorized only if it presents the exact configured
// token. An empty/unset TOKEN denies everything (and the boot guard below also
// refuses to start the listener without one), so /call can never be open on the
// private mesh via a missing-token misconfiguration.
const tokenOk = (got) => {
  if (!TOKEN) return false;
  const a = Buffer.from(String(got || ""));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
};

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true, tools: Object.keys(HANDLERS) }));

app.post("/call", async (req, res) => {
  const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!tokenOk(auth)) return res.status(401).json({ error: "unauthorized" });
  const { slug, input } = req.body || {};
  // Object.hasOwn so a slug like "constructor"/"toString" can't resolve to an
  // inherited Object.prototype function instead of an actual handler.
  const handler = typeof slug === "string" && Object.hasOwn(HANDLERS, slug) ? HANDLERS[slug] : null;
  if (!handler) return res.status(404).json({ error: `unknown worker tool: ${String(slug).slice(0, 40)}` });
  try {
    res.json(await handler(input || {}));
  } catch (err) {
    res.status(err?.statusCode || 502).json({ error: err?.message || "worker error" });
  }
});

// Start listening when run directly (`node worker/server.js`) OR when the shared
// image's start.js dispatcher selected worker mode via WORKER_MODE. Imports by a
// test (argv is the test file, WORKER_MODE unset) still just read the exports.
const isMain = (process.argv[1] && process.argv[1].endsWith("worker/server.js"))
  || /^(1|true|yes|on)$/i.test((process.env.WORKER_MODE || "").trim());
if (isMain) {
  // Enforce the secretless invariant and the auth requirement ONLY when actually
  // booting as the worker (not on import), and fail loud on either.
  const leaked = secretsPresent();
  if (leaked.length) {
    console.error(`[worker] FATAL: secret env present in the SECRETLESS worker: ${leaked.join(", ")}. Remove these from the worker service and redeploy.`);
    process.exit(1);
  }
  if (!TOKEN) {
    console.error("[worker] FATAL: RENDER_WORKER_TOKEN is not set — /call would be unauthenticated on the private mesh. Set it (same value on the main service) and redeploy.");
    process.exit(1);
  }
  // F04: start the validating + pinning egress proxy and point Chromium at it,
  // so the browser can't resolve/connect to a private/metadata/railway.internal
  // destination even under DNS rebinding. Set before the first render (Chromium
  // launches lazily and reads RENDER_EGRESS_PROXY_URL then).
  const proxy = await startEgressProxy();
  process.env.RENDER_EGRESS_PROXY_URL = proxy.url;
  console.log(`[worker] egress proxy (F04 validate+pin) on ${proxy.url}`);
  // Bind IPv6 `::` (dual-stack) so Railway PRIVATE networking can reach the
  // worker at <service>.railway.internal (its private mesh is IPv6-only).
  app.listen(PORT, "::", () => console.log(`[worker] secretless browser/media worker on :${PORT} — tools: ${Object.keys(HANDLERS).join(", ")}`));
}

export { app, HANDLERS, tokenOk, FORBIDDEN_ENV };
