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

// Boot guard: this worker must never be given a high-value secret. If one is
// present in env, refuse to start — that is a misconfigured deployment that
// would defeat the whole point of the isolation.
const FORBIDDEN_ENV = [
  "WALLET_ADDRESS", "CDP_API_KEY_SECRET", "CDP_API_KEY_ID", "OPENROUTER_API_KEY",
  "OPENAI_API_KEY", "AGENT402_OPERATOR_TOKEN", "DATABASE_URL", "ANALYTICS_DATABASE_URL",
  "POW_SECRET", "BURNER_KEY", "SOLANA_BURNER_KEY", "STELLAR_BURNER_SECRET",
];
const present = FORBIDDEN_ENV.filter((k) => (process.env[k] || "").trim());
if (present.length) {
  console.error(`[worker] FATAL: secret env present in the SECRETLESS worker: ${present.join(", ")}. Remove these from the worker service and redeploy.`);
  process.exit(1);
}

const tokenOk = (got) => {
  if (!TOKEN) return true; // no token configured (dev) — allow
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
  const handler = HANDLERS[slug];
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
