// Single-image entrypoint dispatcher (worker isolation — audit F02/F04/F06).
//
// The API server and the secretless browser/media worker ship in ONE image. The
// root railway.toml pins EVERY service to `Dockerfile`, so a per-service
// "config file path" pointer (railway.worker.json) isn't needed — and that
// pointer proved fragile in practice (a service that doesn't have it set silently
// falls back to railway.toml and builds the main server). Instead the worker
// service is distinguished ONLY by `WORKER_MODE=true` in its own env.
//
// We `import` the chosen server (never spawn a child process), so the gosu
// privilege-drop entrypoint (A402-01) still owns PID 1 and the server still
// receives SIGTERM directly for the graceful drain. WORKER_MODE unset →
// byte-identical main-server boot.
const workerMode = /^(1|true|yes|on)$/i.test((process.env.WORKER_MODE || "").trim());
await import(workerMode ? "./worker/server.js" : "./src/server.js");
