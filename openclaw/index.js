// OpenClaw plugin entry (listed in package.json "openclaw.extensions").
// register() is what OpenClaw's loader calls - several times per gateway start
// (discovery, activation, per session), so registration is idempotent and the
// proxy is started once as a plugin service.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildProvider, setActiveProxy, setCachedRoutes, DEFAULT_PORT, PROVIDER_ID } from "./provider.js";
import { startProxy, loadRoutes, DEFAULT_UPSTREAM } from "./proxy.js";
import { stripTrailingSlashes } from "./models.js";

export const STATE_DIR = () => join(process.env.AGENT402_OPENCLAW_HOME || join(homedir(), ".openclaw"), "agent402");
export const CREDITS_KEY_FILE = () => join(STATE_DIR(), "credits.key");

/** Credits key precedence: plugin config > env > ~/.openclaw/agent402/credits.key. */
export function resolveCreditsKey(pluginConfig = {}) {
  const fromCfg = typeof pluginConfig.creditsKey === "string" ? pluginConfig.creditsKey.trim() : "";
  if (fromCfg) return fromCfg;
  const fromEnv = (process.env.AGENT402_CREDITS_KEY || "").trim();
  if (fromEnv) return fromEnv;
  try { if (existsSync(CREDITS_KEY_FILE())) return readFileSync(CREDITS_KEY_FILE(), "utf8").trim(); } catch { /* unreadable */ }
  return null;
}

/** Optional x402 wallet payment: only when the peer deps are installed and a key is present. */
export async function resolvePayFetch(pluginConfig = {}, log = () => {}) {
  const pk = (pluginConfig.walletKey || process.env.AGENT402_WALLET_KEY || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) return null;
  try {
    const [{ wrapFetchWithPayment }, { privateKeyToAccount }] = await Promise.all([import("@x402/fetch"), import("viem/accounts")]);
    const { toClientEvmSigner } = await import("@x402/evm");
    const { registerExactEvmScheme } = await import("@x402/evm/exact/client");
    const { x402Client } = await import("@x402/fetch");
    const client = new x402Client();
    registerExactEvmScheme(client, { signer: toClientEvmSigner(privateKeyToAccount(pk)) });
    return wrapFetchWithPayment(fetch, client);
  } catch (e) {
    log(`[agent402-openclaw] x402 wallet payment unavailable (${e?.message || e}); install @x402/fetch @x402/evm viem, or use a credits key`);
    return null;
  }
}

let started = null;
let registeredOnce = false;

const plugin = {
  id: PROVIDER_ID,
  name: "Agent402",
  description: "Agent402 model provider: routed + explicit models at a flat per-call price, paid by card or USDC.",
  register(api) {
    const cfg = api.pluginConfig || {};
    const port = Number(cfg.port) || DEFAULT_PORT;
    const upstream = stripTrailingSlashes(cfg.upstream || process.env.AGENT402_UPSTREAM || DEFAULT_UPSTREAM);
    const log = (m) => api.logger?.info?.(m);
    api.registerProvider(buildProvider({ port }));
    if (!registeredOnce) {
      registeredOnce = true;
      api.registerService({
        id: "agent402-proxy",
        start: async () => {
          if (started) return;
          const creditsKey = resolveCreditsKey(cfg);
          const payFetch = creditsKey ? null : await resolvePayFetch(cfg, log);
          try { setCachedRoutes(await loadRoutes(upstream)); } catch (e) { log(`[agent402-openclaw] could not read ${upstream}/v1/models yet: ${e?.message || e}`); }
          started = await startProxy({ upstream, creditsKey, payFetch, port, log });
          setActiveProxy(started);
          if (started.mode === "unpaid") log("[agent402-openclaw] no payment configured: run `agent402-openclaw setup` (card credits key) - paid calls will answer 402 until then");
        },
        stop: async () => { if (started) { await started.close(); started = null; setActiveProxy(null); } },
      });
    }
  },
};

export default plugin;
export { plugin, buildProvider, startProxy };
