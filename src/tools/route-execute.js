// Route-and-execute — the Smart Order Router's first EXECUTING surface.
//
// /api/route and /api/find recommend a tool; this endpoint runs it. The buyer
// pays ONE flat x402 price and describes the task (or names a slug); the
// router resolves the best match from the live catalog and dispatches it
// internally, returning the tool result plus a receipt that itemizes the
// underlying price vs. what was paid.
//
// v1 scope (deliberately): INTERNAL dispatch only — the resolved tool must be
// in this host's own catalog, so there is no counterparty, no server-side
// wallet, and no float. The route/quote/guard/receipt plumbing this validates
// is the same shape a later cross-seller executor needs; only the dispatch
// step changes.
//
// Economics: flat $0.01 covers any underlying tool priced <= $0.005 — the
// spread is the routing fee. Tools above the cap return a self-correcting 409
// that names the tool and its direct route, so the buyer can call it at list
// price instead.
import { createHash } from "node:crypto";
import { findTools } from "../find.js";
import { isIdentityBoundRoute } from "../payments.js";

// Two execution tiers, both from buildRouteExecuteTool. The tier a buyer needs
// is quoted by /api/route (routeExecuteHint below), so there's no guessing:
//   route-execute      $0.01  — internal + external tools ≤ $0.005 (the cheap
//                               path; unchanged for existing callers).
//   route-execute-max  $0.55  — internal + external tools ≤ $0.50, the tier
//                               that reaches the valuable external catalog.
// External dispatch is the marketable half: run the task on OUR tool if we have
// one, else pay the best EXTERNAL seller over x402 and relay — one call either
// way. Spend is bounded (external only when we lack the tool) and gated on
// SOR_EXTERNAL_ENABLED until a real external buy proves it.
export const EXEC_TIERS = [
  { slug: "route-execute", execPriceUsd: 0.01, underlyingMaxUsd: 0.005 },
  { slug: "route-execute-max", execPriceUsd: 0.55, underlyingMaxUsd: 0.5 },
];
/** Which execution tier (if any) can run a tool at `underlyingUsd`, and the
 *  price to pay it. Used by /api/route to quote the buyer the exact tier. */
export function routeExecuteHint(underlyingUsd) {
  const tier = EXEC_TIERS.find((t) => underlyingUsd <= t.underlyingMaxUsd);
  return tier ? { tool: tier.slug, price: `$${tier.execPriceUsd}`, underlyingPriceUsd: underlyingUsd, routingFeeUsd: Number((tier.execPriceUsd - underlyingUsd).toFixed(6)) } : null;
}

// Optional recomputable call identity (issue #282): callRef = "sha256:" + hex
// digest over the canonical preimage JSON.stringify({nonce, slug, ts}) — keys
// in that (alphabetical) order, all values strings. The EIP-3009 authorization
// nonce is the high-entropy per-dispatch pseudonym: buyer and seller each hold
// it already (the buyer signed it, the seller read it from X-PAYMENT), so both
// re-derive the same reference offline from the receipt's slug + ts — while
// outsiders cannot brute-force the caller from the hash. Absent (null) when the
// call carried no EVM payment authorization (free mode, non-EIP-3009 rails).
// The CAIP-2 network the buyer signed their payment for (from the X-PAYMENT
// authorization), or null when unreadable (free/PoW mode, malformed header).
// Used to keep external routing Base-only. Never throws.
export function buyerPaymentNetwork(req) {
  try {
    const header = req?.header?.("x-payment") || req?.header?.("payment-signature");
    if (!header) return null;
    const p = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
    // v1 payloads carry `network` top-level; v2 payloads carry the CHOSEN
    // accept under `accepted` (shape: {x402Version:2, accepted, payload}) with
    // the network inside it. Reading only the v1 spot 409'd every v2 Base
    // buyer out of external routing (found by the first paid demo after the
    // fail-closed check shipped — the canary's route-exec leg is internal-only
    // and never walked this path).
    if (typeof p?.network === "string") return p.network;
    if (typeof p?.accepted?.network === "string") return p.accepted.network;
    return null;
  } catch { return null; }
}

export function callRefFrom(req, slug, ts) {
  try {
    const header = req?.header?.("x-payment") || req?.header?.("payment-signature");
    if (!header) return null;
    const payload = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
    const nonce = payload?.payload?.authorization?.nonce;
    if (typeof nonce !== "string" || !nonce) return null;
    return "sha256:" + createHash("sha256").update(JSON.stringify({ nonce, slug, ts })).digest("hex");
  } catch {
    return null;
  }
}

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

const toUsd = (price) => Number(String(price ?? "").replace(/[^0-9.]/g, "")) || 0;

// Tools the executor refuses to dispatch regardless of price:
// - identity-bound (memory* AND my-usage): wallet-keyed — the tool reads the
//   SIGNED payment identity off the Express request (payerFromRequest / the
//   memory namespace). The executor invokes handlers as `def.handler(params)`
//   with no request, so the identity is absent: memory would key the wrong
//   namespace and my-usage would 502 on `req.header` — AFTER the buyer already
//   paid for route-execute. Worse, route-execute advertises all eight rails
//   while identity-bound tools are EVM-only, so even threading the request
//   through would break the identity contract. These MUST be called directly.
//   Guarded by isIdentityBoundRoute (the single source of truth in payments.js)
//   so this holds on a raw catalog, independent of server.js's flag mutation.
// - route-execute itself (no recursion).
// - non-JSON bodies (binary/multipart uploads don't fit the {params} envelope).
function dispatchable(def) {
  if (!def || typeof def.handler !== "function") return { ok: false, why: "tool has no internal handler" };
  if (def.slug === "route-execute") return { ok: false, why: "cannot dispatch to itself" };
  if (def.identityBound || isIdentityBoundRoute(def)) {
    return { ok: false, why: "identity-bound tools are wallet-keyed — call them directly so the signed payment identity is preserved" };
  }
  const bodyType = def.discovery?.bodyType;
  if (bodyType && bodyType !== "json") return { ok: false, why: `bodyType "${bodyType}" is not dispatchable through the JSON params envelope` };
  return { ok: true };
}

export function buildRouteExecuteTool({ getCatalog, baseUrl = "", tier = EXEC_TIERS[0], resolveExternal = null, payExternal = null, externalEnabled = () => false }) {
  const EXEC_PRICE_USD = tier.execPriceUsd;
  const UNDERLYING_MAX_USD = tier.underlyingMaxUsd;
  const routeSuffix = tier.slug === "route-execute" ? "" : "-max";
  return {
    route: `POST /api/route/execute${routeSuffix}`,
    name: tier.slug === "route-execute" ? "Route and execute" : "Route and execute (max tier)",
    slug: tier.slug,
    category: "agent",
    price: `$${EXEC_PRICE_USD}`,
    description:
      `Describe a task (or name a slug) and the Smart Order Router resolves the best-matching tool and RUNS it in the same call — flat $${EXEC_PRICE_USD} covering any tool listed at $${UNDERLYING_MAX_USD} or less, from THIS host's catalog or any external x402 seller in the open index (paid over x402 on your behalf, result relayed). One payment, one request, result + receipt. /api/route quotes which tier a task needs; pricier tools return a self-correcting 409 with their direct route.`,
    tags: ["router", "sor", "execute", "dispatch", "meta", "agent", "x402", ...(routeSuffix ? ["max-tier"] : [])],
    discovery: {
      bodyType: "json",
      input: { slug: "hash", params: { text: "agent402", algo: "sha256" } },
      inputSchema: {
        properties: {
          task: { type: "string", description: "Plain-language task, e.g. \"sha256 hash of a string\" — resolved via the same ranker as /api/find. Provide task OR slug." },
          slug: { type: "string", description: "Exact tool slug to execute (skips ranking). Provide task OR slug." },
          params: { type: "object", description: "Input for the resolved tool, matching its inputSchema (default {})" },
          include: { type: "string", description: 'Where to route: default runs a tool from THIS host\'s catalog; "external" routes to the best-matching x402 seller in the OPEN index and pays it on your behalf (result relayed, marked untrustedContent). Requires task (not slug).' },
          maxUsd: { type: "number", description: `Refuse tools listed above this underlying price (default and ceiling: $${UNDERLYING_MAX_USD})` },
        },
      },
      output: {
        example: {
          receipt: { slug: "hash", route: "POST /api/hash", underlyingPriceUsd: 0.001, paidUsd: EXEC_PRICE_USD, routingFeeUsd: 0.009, seller: "internal", resolvedBy: "slug", ts: "2026-07-10T00:00:00.000Z", callRef: "sha256:…  (recomputable: sha256 of {\"nonce\":<payment authorization nonce>,\"slug\":…,\"ts\":…} — null on nonce-less calls)" },
          result: { algo: "sha256", hex: "…", base64: "…" },
        },
      },
    },
    handler: async (input, req) => {
      if (input == null || typeof input !== "object") throw bad("Request body must be a JSON object");
      const catalog = getCatalog();
      const params = input.params != null ? input.params : {};
      if (typeof params !== "object" || Array.isArray(params)) throw bad('"params" must be an object matching the resolved tool\'s inputSchema');
      const cap = Math.min(Number(input.maxUsd) > 0 ? Number(input.maxUsd) : UNDERLYING_MAX_USD, UNDERLYING_MAX_USD);

      // Resolve: explicit slug wins; otherwise rank the task with the same
      // lexical ranker behind /api/find and walk down until a dispatchable,
      // in-budget tool is found (the top hit may be excluded or over-cap).
      let def = null;
      let resolvedBy;
      const bySlug = new Map(Object.values(catalog).map((d) => [d.slug, d]));
      if (input.slug != null) {
        resolvedBy = "slug";
        def = bySlug.get(String(input.slug)) || null;
        if (!def) throw bad(`Unknown slug "${String(input.slug).slice(0, 80)}" — resolve one with /api/find?q=<task>`, 404);
        const d = dispatchable(def);
        if (!d.ok) throw bad(`Tool "${def.slug}" is not dispatchable here: ${d.why}`, 409);
        if (toUsd(def.price) > cap) {
          throw bad(`Tool "${def.slug}" is listed at $${toUsd(def.price)} — above this endpoint's $${cap} underlying cap. Call it directly: ${def.route}${baseUrl ? ` on ${baseUrl}` : ""}`, 409);
        }
      } else if (typeof input.task === "string" && input.task.trim()) {
        resolvedBy = "task";

        // EXPLICIT external routing (include:"external") — the marketable path:
        // "run this on a tool from the OPEN x402 ecosystem, not our catalog."
        // First-class, not a fallback: with 500+ internal tools a loose ranker
        // always matches SOMETHING, so external must be a deliberate buyer
        // choice to fire reliably. We resolve the best external Base-payable
        // seller, pay it on the buyer's behalf via x402, and relay the result.
        // Spend stays bounded to when the buyer asked for it. Gated on
        // SOR_EXTERNAL_ENABLED until a real external buy proves it live.
        if (input.include === "external") {
          if (!externalEnabled() || !resolveExternal) throw bad("External routing is not enabled on this host", 409);
          // Base-only: external settlement is Base-only (we pay sellers from the
          // Base spending wallet), and route-execute's Base leg is settled TO that
          // wallet so external routing pays for itself. A buyer paying on another
          // chain can't fund the Base float, so refuse external for non-Base
          // payments (a 4xx cancels their settlement — they are not charged).
          // Internal routing stays available on every chain. Fail-open only when
          // the network can't be read (Base is the default payTo either way).
          // Fail CLOSED for a PAID request: if a payment header is present but
          // its network isn't provably Base, refuse (a genuine Base buyer always
          // has a readable eip155:8453 network; an unreadable one on a paying
          // request is the only residual bypass of the Base-only rule). No
          // payment header at all (free/PoW mode) stays allowed — external can't
          // run there without a wallet anyway.
          const payNet = buyerPaymentNetwork(req);
          const hasPayment = !!(req?.header?.("x-payment") || req?.header?.("payment-signature"));
          if (hasPayment && payNet !== "eip155:8453") throw bad(`External routing settles on Base (eip155:8453) — this request paid on ${payNet || "an unreadable network"}. Pay on Base for include:"external", or use internal routing (works on every chain).`, 409);
          const ext = await resolveExternal(input.task, { cap, baseUrl });
          if (!ext) throw bad(`No external x402 seller matched that task. Explore /api/route?q=<task>&include=external.`, 404);
          const extUsd = toUsd(ext.price);
          if (!(extUsd > 0 && extUsd <= cap)) throw bad(`Best external match "${ext.slug}" is ${ext.price} — over this tier's $${cap} cap. Use route-execute-max or raise the tier.`, 409);
          if (!(ext.url && Array.isArray(ext.networks) && ext.networks.includes("eip155:8453"))) throw bad(`External seller "${ext.seller}" does not offer Base settlement — cannot pay it from the Base spending wallet.`, 409);
          let paid;
          try {
            paid = await payExternal(ext.url, { method: (ext.method || "POST").toUpperCase(), body: params, maxAtomic: BigInt(Math.round(cap * 1e6)) });
          } catch (e) {
            const sc = e?.statusCode && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 502;
            throw bad(`External seller "${ext.seller}" failed: ${String(e?.message || e).slice(0, 200)}`, sc);
          }
          const ts = new Date().toISOString();
          const underlyingUsd = paid.quote ? paid.quote.usd : extUsd;
          return {
            receipt: {
              slug: ext.slug,
              route: `${ext.method || "POST"} ${ext.url}`,
              underlyingPriceUsd: underlyingUsd,
              paidUsd: EXEC_PRICE_USD,
              routingFeeUsd: Number((EXEC_PRICE_USD - underlyingUsd).toFixed(6)),
              seller: ext.seller,
              external: true,
              settleTx: paid.receipt?.transaction || null,
              resolvedBy: "task-external",
              ts,
              ...(callRefFrom(req, ext.slug, ts) ? { callRef: callRefFrom(req, ext.slug, ts) } : {}),
            },
            // External result is attacker-influenceable content — mark it.
            result: (paid.result && typeof paid.result === "object" && !Array.isArray(paid.result)) ? { ...paid.result, untrustedContent: true } : paid.result,
          };
        }

        // Default: resolve the best in-budget tool from THIS host's catalog.
        const { results } = findTools(catalog, input.task, { k: 10, baseUrl });
        for (const r of results) {
          const candidate = bySlug.get(r.slug);
          if (!candidate) continue;
          if (!dispatchable(candidate).ok) continue;
          if (toUsd(candidate.price) > cap) continue;
          def = candidate;
          break;
        }
        if (!def) {
          const hasExternal = externalEnabled() && !!resolveExternal;
          throw bad(
            results.length
              ? `No dispatchable match under $${cap} for that task (top hit: "${results[0].slug}" at ${results[0].price}).${hasExternal ? ' Retry with include:"external" to route to an outside x402 seller,' : ""} or call it directly / raise maxUsd.`
              : `No internal tool matched that task.${hasExternal ? ' Retry with include:"external" to route to the open x402 ecosystem, or' : ""} try /api/find?q=<task>.`,
            404
          );
        }
      } else {
        throw bad('Provide "task" (plain language) or "slug" (exact tool)');
      }

      const underlying = toUsd(def.price);
      let result;
      try {
        result = await def.handler(params);
      } catch (e) {
        // Surface the underlying tool's own error semantics — the buyer paid
        // for a routed execution, and the tool's 4xx is the honest answer.
        const sc = e?.statusCode && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 502;
        throw bad(`Routed tool "${def.slug}" failed: ${String(e?.message || e).slice(0, 200)}`, sc);
      }
      const ts = new Date().toISOString();
      const callRef = callRefFrom(req, def.slug, ts);
      return {
        receipt: {
          slug: def.slug,
          route: def.route,
          underlyingPriceUsd: underlying,
          paidUsd: EXEC_PRICE_USD,
          routingFeeUsd: Number((EXEC_PRICE_USD - underlying).toFixed(6)),
          seller: "internal",
          resolvedBy,
          ts,
          ...(callRef ? { callRef } : {}),
        },
        result,
      };
    },
  };
}
