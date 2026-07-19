// F13: idempotent durable credit for capacity-refused paid renders.
//
// x402 settles BEFORE the handler runs. If a paid render/screenshot then hits the
// bounded Chromium pool and is refused (503, security audit A402-08), the buyer
// was charged but not served — and because each x402 authorization nonce is
// single-use, a naive retry pays AGAIN. On such a refusal we mint a one-time
// CREDIT TOKEN — a 256-bit bearer secret returned only in that buyer's own 503
// response — and record a credit bound to the exact request (route + body). A
// retry that presents the token (`X-Render-Credit`) for the SAME request skips
// the paywall and is served without a second charge; the credit is consumed only
// on successful delivery and survives a repeated 503 for another retry.
//
// Why a server-minted token, NOT the payer address: the token is unguessable and
// is handed only to the paying caller, so a third party who merely knows the
// (public) wallet cannot forge or steal the credit. Binding to route+body means a
// token can't be spent on a different or costlier render than the one paid for.
import { createHash, randomBytes } from "node:crypto";

export function bodyHashFor(body) {
  return body && typeof body === "object" && Object.keys(body).length
    ? createHash("sha256").update(JSON.stringify(body)).digest("hex")
    : "-";
}

// 256-bit URL-safe bearer secret. Only ever returned to the paying caller.
export function mintCreditToken() {
  return randomBytes(32).toString("base64url");
}

export function createRenderCreditLedger({ ttlMs = 10 * 60 * 1000, maxEntries = 5000 } = {}) {
  const store = new Map(); // token -> { route, bodyHash, at }
  const live = (e, now) => !!e && now - e.at < ttlMs;
  return {
    // Record a credit for a settled-but-refused render; returns the bearer token.
    // A caller-supplied token is only for deterministic tests.
    issue(meta, now = Date.now(), token = mintCreditToken()) {
      while (store.size >= maxEntries && store.size > 0) store.delete(store.keys().next().value);
      store.set(token, { route: meta.route, bodyHash: meta.bodyHash, at: now });
      return token;
    },
    // True iff there is a LIVE credit for this token AND it was issued for this
    // exact request (route + body). Lazily drops an expired token.
    valid(token, meta, now = Date.now()) {
      if (!token || typeof token !== "string") return false;
      const e = store.get(token);
      if (!live(e, now)) { if (e) store.delete(token); return false; }
      return e.route === meta.route && e.bodyHash === meta.bodyHash;
    },
    // Single-use: delete and report whether a LIVE credit was present.
    consume(token, now = Date.now()) {
      const e = store.get(token);
      store.delete(token);
      return live(e, now);
    },
    prune(now = Date.now()) {
      for (const [t, e] of store) if (!live(e, now)) store.delete(t);
    },
    size() { return store.size; },
  };
}
