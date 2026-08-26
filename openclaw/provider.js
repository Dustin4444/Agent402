// The OpenClaw ProviderPlugin. Its `models` getter always points at the local
// proxy URL - the configured port before the proxy is up, the live one after -
// so OpenClaw persists a loopback baseUrl and never the remote gateway (which
// would 402 without the proxy's payment step in between).
import { providerModelsConfig, routesFromCatalog } from "./models.js";

export const PROVIDER_ID = "agent402";
export const DEFAULT_PORT = 8412;

let activeProxy = null;
let cachedRoutes = null;
export function setActiveProxy(p) { activeProxy = p; }
export function getActiveProxy() { return activeProxy; }
export function setCachedRoutes(r) { cachedRoutes = r; }

/** Minimal offline route table so the provider registers even before /v1/models is read. */
export const BOOTSTRAP_ROUTES = routesFromCatalog({ data: [
  { id: "auto", x402: { tier: "v1-chat-auto", endpoint: "/v1/auto/chat/completions", priceUsd: 0.01, maxTokens: 1024, maxInputChars: 32_000 } },
] });

export function buildProvider({ port = DEFAULT_PORT } = {}) {
  return {
    id: PROVIDER_ID,
    label: "Agent402",
    docsPath: "https://agent402.tools/guides/openclaw-model-provider",
    aliases: ["a402"],
    envVars: ["AGENT402_CREDITS_KEY", "AGENT402_WALLET_KEY"],
    get models() {
      const base = activeProxy ? activeProxy.baseUrl : `http://127.0.0.1:${port}`;
      return providerModelsConfig(base, cachedRoutes || BOOTSTRAP_ROUTES);
    },
    // No provider auth: the proxy carries the credits key or signs the payment.
    auth: [],
  };
}
