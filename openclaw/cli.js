#!/usr/bin/env node
// agent402-openclaw <command>
//   setup [--credits-key a402_...] [--write]   store the key, print (or merge) the openclaw.json block
//   proxy [--port N] [--upstream URL]          run the local proxy on its own (no OpenClaw needed)
//   doctor                                     show what is configured and whether the gateway answers
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, statSync, realpathSync, renameSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";
import { STATE_DIR, CREDITS_KEY_FILE, resolveCreditsKey, resolvePayFetch } from "./index.js";
import { startProxy, loadRoutes, DEFAULT_UPSTREAM } from "./proxy.js";
import { providerModelsConfig, stripTrailingSlashes, defaultPrimary, AUTO_ID, OPENCLAW_MIN_INPUT_CHARS } from "./models.js";
import { DEFAULT_PORT, PROVIDER_ID } from "./provider.js";

const args = process.argv.slice(2);
const cmd = args[0] || "help";
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const has = (k) => args.includes(k);
const out = (s) => process.stdout.write(s + "\n");

/** The provider block for openclaw.json (JSON, so it can be merged; OpenClaw reads JSON5 which is a superset). */
export function configBlock({ port = DEFAULT_PORT, routes }) {
  const primary = defaultPrimary(routes);
  return {
    agents: { defaults: { model: { primary: `${PROVIDER_ID}/${primary ? primary.id : AUTO_ID}` } } },
    models: { providers: { [PROVIDER_ID]: { ...providerModelsConfig(`http://127.0.0.1:${port}`, routes), timeoutSeconds: 120 } } },
  };
}

function mergeInto(target, block, { port = DEFAULT_PORT } = {}) {
  const t = target && typeof target === "object" ? target : {};
  t.agents = t.agents || {}; t.agents.defaults = t.agents.defaults || {};
  t.agents.defaults.model = { ...(t.agents.defaults.model || {}), primary: block.agents.defaults.model.primary };
  t.models = t.models || {}; t.models.providers = t.models.providers || {};
  t.models.providers[PROVIDER_ID] = block.models.providers[PROVIDER_ID];
  // The plugin service reads ITS port from plugins.entries.<id>.config, not from
  // the provider baseUrl - a --port that only moved the baseUrl left the proxy
  // on 8412 and OpenClaw dialing a port nobody listened on (real-install test).
  if (port !== DEFAULT_PORT) {
    t.plugins = t.plugins || {}; t.plugins.entries = t.plugins.entries || {};
    t.plugins.entries[PROVIDER_ID] = { ...(t.plugins.entries[PROVIDER_ID] || {}), config: { ...(t.plugins.entries[PROVIDER_ID]?.config || {}), port } };
  }
  return t;
}

async function main() {
  if (cmd === "help" || has("--help")) {
    out("agent402-openclaw setup [--credits-key a402_...|-] [--write] [--flat] | proxy [--port N] [--upstream URL] [--flat] | doctor");
    return 0;
  }
  const upstream = stripTrailingSlashes(opt("--upstream") || process.env.AGENT402_UPSTREAM || DEFAULT_UPSTREAM);
  const port = Number(opt("--port")) || DEFAULT_PORT;
  // Pricing: metered by default (explicit models pay a per-request quote, from
  // $0.001); --flat (or AGENT402_PRICING=flat) keeps every model on its flat tier.
  const pricing = has("--flat") || String(process.env.AGENT402_PRICING || "").toLowerCase() === "flat" ? "flat" : "metered";

  if (cmd === "setup") {
    // The key may arrive on argv (lands in shell history), via AGENT402_CREDITS_KEY,
    // or on stdin with `--credits-key -` (the form the docs recommend).
    let key = (opt("--credits-key") || "").trim();
    if (key === "-") key = readFileSync(0, "utf8").trim();
    if (!key && process.env.AGENT402_CREDITS_KEY && !has("--no-env")) key = process.env.AGENT402_CREDITS_KEY.trim();
    if (key) {
      if (!/^a402_[A-Za-z0-9_-]{16,80}$/.test(key)) { console.error("that does not look like an Agent402 credits key (a402_...)"); return 2; }
      mkdirSync(STATE_DIR(), { recursive: true });
      writeFileSync(CREDITS_KEY_FILE(), key + "\n", { mode: 0o600 });
      try { chmodSync(CREDITS_KEY_FILE(), 0o600); } catch { /* best effort */ }
      out(`stored credits key at ${CREDITS_KEY_FILE()} (0600)`);
    } else if (!resolveCreditsKey()) {
      out(`no credits key yet: buy a pack by card at ${upstream}/credits, then rerun with --credits-key a402_...`);
    }
    let routes;
    try { routes = await loadRoutes(upstream, fetch, { pricing }); } catch (e) { console.error(`could not read ${upstream}/v1/models: ${e?.message || e}`); return 2; }
    const block = configBlock({ port, routes });
    const primary = block.agents.defaults.model.primary;
    if (primary === `${PROVIDER_ID}/${AUTO_ID}`) {
      console.error(`WARNING: no model in this catalog (${pricing} pricing) accepts the ~${Math.round(OPENCLAW_MIN_INPUT_CHARS / 1000)}k chars OpenClaw sends before your first word; primary falls back to ${primary}, which will answer "Context overflow" on every turn. Rerun without --flat to use the metered route.`);
    }
    const cfgPath = join(process.env.AGENT402_OPENCLAW_HOME || join(homedir(), ".openclaw"), "openclaw.json");
    if (has("--write")) {
      let existing = {};
      if (existsSync(cfgPath)) {
        try { existing = JSON.parse(readFileSync(cfgPath, "utf8")); }
        catch { console.error(`${cfgPath} is not plain JSON (JSON5 comments?); not touching it. Merge this block by hand:`); out(JSON.stringify(block, null, 2)); return 2; }
      }
      mkdirSync(join(cfgPath, ".."), { recursive: true });
      // Preserve the file's mode (openclaw.json holds other providers' keys and
      // is often 0600); a fresh file is created 0600. Never loosen it.
      let mode = 0o600;
      try { if (existsSync(cfgPath)) mode = statSync(cfgPath).mode & 0o777; } catch { /* keep 0600 */ }
      const tmp = `${cfgPath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(mergeInto(existing, block, { port }), null, 2) + "\n", { mode });
      try { chmodSync(tmp, mode); } catch { /* best effort */ }
      renameSync(tmp, cfgPath);
      out(`wrote provider "${PROVIDER_ID}" + primary model ${primary} into ${cfgPath}; run: openclaw gateway restart`);
    } else {
      out(`add to ${cfgPath} (or rerun with --write):`);
      out(JSON.stringify(block, null, 2));
    }
    return 0;
  }

  if (cmd === "proxy") {
    const creditsKey = resolveCreditsKey();
    const payFetch = creditsKey ? null : await resolvePayFetch({}, (m) => console.error(m));
    const p = await startProxy({ upstream, creditsKey, payFetch, port, pricing, log: (m) => console.error(m) });
    out(`${p.baseUrl}/v1 (${p.mode}, ${p.pricing} pricing)`);
    await new Promise(() => {}); // run until killed
  }

  if (cmd === "doctor") {
    const key = resolveCreditsKey();
    out(`upstream: ${upstream}`);
    out(`credits key: ${key ? `present (${key.slice(0, 8)}…)` : "none"}`);
    out(`wallet key: ${/^0x[0-9a-fA-F]{64}$/.test(process.env.AGENT402_WALLET_KEY || "") ? "present" : "none"}`);
    try { const r = await loadRoutes(upstream, fetch, { pricing }); out(`gateway: ok, ${r.size} models (${pricing} pricing: ${[...r.values()].filter((x) => x.metered).length} metered)`); } catch (e) { out(`gateway: unreachable (${e?.message || e})`); return 1; }
    if (key) {
      try {
        const r = await fetch(`${upstream}/api/credits/balance`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
        const j = await r.json().catch(() => ({}));
        out(`balance: ${r.ok ? `$${j.balanceUsd ?? j.balance ?? "?"}` : `HTTP ${r.status} ${j.reason || j.error || ""}`}`);
      } catch (e) { out(`balance: unreadable (${e?.message || e})`); }
    }
    return 0;
  }

  console.error(`unknown command: ${cmd}`); return 2;
}

// Entry guard that survives npm's bin SYMLINK and paths with spaces: Node
// resolves import.meta.url to the real path but leaves process.argv[1] as the
// symlink, so a plain string compare is false for every `npx`/global install
// and the CLI silently did nothing (0.1.0 and 0.1.1 shipped that way).
function invokedDirectly() {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (invokedDirectly()) {
  main().then((c) => process.exit(c ?? 0), (e) => { console.error(e?.message || e); process.exit(1); });
}
