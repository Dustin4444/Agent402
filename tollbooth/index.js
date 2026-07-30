#!/usr/bin/env node
// agent402-tollbooth — an open-source, self-hostable x402 "pay-per-crawl" gate.
//
// Put it in front of any site or API: human visitors pass through free, while
// AI crawlers / agents must pay per request — either in USDC over the x402
// protocol, or for free by solving a proof-of-work (no wallet, no signup, no
// Stripe, no Cloudflare). Use it two ways:
//
//   1. Express middleware:   app.use(createTollbooth({ ... }))
//   2. Reverse proxy (CLI):  TOLLBOOTH_UPSTREAM=https://your-site.com npx agent402-tollbooth
//
// The proof-of-work rail works out of the box with zero configuration. To also
// accept USDC, set `payTo` and supply `verifyX402` (wire it to the standard
// x402 server middleware / your facilitator — see README).
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { createPow } from "./pow.js";
import { makeBotMatcher, AI_BOTS } from "./bots.js";
import { memorySink } from "./sinks.js";

export { AI_BOTS, makeBotMatcher } from "./bots.js";
export { createPow, leadingZeroBits } from "./pow.js";
export { memorySink, kvStatsSink, httpStatsSink } from "./sinks.js";

const VERIFY_TIMEOUT_MS = Number(process.env.TOLLBOOTH_VERIFY_TIMEOUT_MS) || 10_000;

// P1.5 / FR4-10: a first-party `verifyX402` built from a standard @x402/express
// payment middleware, that OWNS timeout + cancellation. The gate calls
// verifyX402(req, opts) and puts an AbortSignal on `opts.signal` (aborted when
// the gate's own verify timeout fires); this wrapper honors it — once the signal
// aborts (or its own optional backstop timeout fires) it settles the verify
// promise immediately and reports NOT-verified, so a slow middleware can't leave
// the gate hanging or produce a charged-then-denied result after the gate has
// returned 402. Grants on next(); denies when the middleware writes a 402.
//
// LIMITATION (documented): @x402/express settles by BROADCASTING and exposes no
// cancel hook, so this wrapper cannot abort an on-chain settle already in flight.
// Keep TOLLBOOTH_VERIFY_TIMEOUT_MS comfortably above your settle latency so the
// abort is a backstop, not the normal path; or front it with a facilitator that
// supports cancellation.
export function x402VerifierFromExpress(paymentMiddleware, { timeoutMs } = {}) {
  if (typeof paymentMiddleware !== "function") {
    throw new TypeError("x402VerifierFromExpress: paymentMiddleware must be a function");
  }
  return (req, opts = {}) => new Promise((resolve, reject) => {
    const signal = opts?.signal;
    let done = false;
    let timer = null;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      fn(v);
    };
    const onAbort = () => finish(resolve, false); // gate timed out → treat as not verified
    if (signal?.aborted) return finish(resolve, false);
    signal?.addEventListener?.("abort", onAbort, { once: true });
    if (timeoutMs > 0) timer = setTimeout(() => finish(resolve, false), timeoutMs);
    // Minimal response shim: the middleware calls next() to GRANT, or writes a
    // 402 via status/json/send/end to DENY.
    const res = {
      setHeader() { return this; }, getHeader() {}, removeHeader() { return this; }, getHeaders() { return {}; },
      status() { return this; }, json() { finish(resolve, false); return this; },
      send() { finish(resolve, false); return this; }, end() { finish(resolve, false); return this; },
      writeHead() { return this; }, write() { return true; }, flushHeaders() {},
    };
    try {
      Promise.resolve(paymentMiddleware(req, res, () => finish(resolve, true))).catch((e) => finish(reject, e));
    } catch (e) { finish(reject, e); }
  });
}
// Headers a client must never be able to forge through the proxy: the gate's own
// trust signals and forwarding/hop-by-hop headers.
const STRIP_INBOUND = new Set([
  "host", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "content-length",
  "x-tollbooth-paid", "x-tollbooth-error", "x-pow-error", "x-forwarded-host", "forwarded",
]);

/**
 * Create the tollbooth Express middleware.
 * @param {object} [config]
 * @param {string} [config.price="$0.001"]     advertised price per request
 * @param {string|null} [config.payTo]         wallet for the x402 quote (enables USDC rail)
 * @param {string} [config.network="base"]     x402 network (e.g. base, or robinhood / eip155:4663 for USDG)
 * @param {string} [config.asset="USDC"]        stablecoin symbol in the quote (USDG on Robinhood Chain)
 * @param {boolean} [config.pow=true]          enable the free proof-of-work rail
 * @param {number} [config.powDifficulty]      PoW difficulty in leading zero bits
 * @param {string[]} [config.botUserAgents]    user-agents to charge (default: AI_BOTS)
 * @param {(req)=>boolean} [config.charge]     custom "should this client pay?" predicate
 * @param {(req)=>boolean} [config.free]       custom force-allow predicate (wins over charge)
 * @param {(req, requirements)=>boolean|Promise<boolean>} [config.verifyX402]  USDC settlement check
 * @param {string} [config.resourceBaseUrl]    absolute base for the x402 `resource`/PoW binding
 * @param {string} [config.message]            human-readable note included in the 402
 * @param {boolean} [config.observe]           observe-only: classify, count, never 402 (deploy a week before enforcing)
 * @param {object} [config.statsSink]          pluggable durable-stats sink (default: in-memory). See sinks.js.
 */
export function createTollbooth(config = {}) {
  const {
    price = process.env.TOLLBOOTH_PRICE || "$0.001",
    payTo = process.env.TOLLBOOTH_PAYTO || null,
    network = process.env.TOLLBOOTH_NETWORK || "base",
    // Any stablecoin the operator's facilitator settles. USDC on the default
    // chains; set TOLLBOOTH_NETWORK=robinhood (or eip155:4663) with
    // TOLLBOOTH_ASSET=USDG to charge crawlers in USDG on Robinhood Chain.
    asset = process.env.TOLLBOOTH_ASSET || "USDC",
    pow = true,
    powDifficulty,
    powSecret,
    botUserAgents = AI_BOTS,
    // Who pays. Default "bots" = the original behavior (charge AI crawler UAs).
    //  "all"    — charge every client except a `free()` match (UA detection is
    //             not a security boundary; this stops relying on it).
    //  "strict" — charge anything that isn't a real-browser request (browser-like
    //             UA + an HTML Accept). Raises the bar on naive scrapers.
    // An explicit charge()/free() still wins over the mode.
    mode = process.env.TOLLBOOTH_MODE || "bots",
    charge,
    free,
    verifyX402,
    resourceBaseUrl = process.env.TOLLBOOTH_RESOURCE_BASE || "",
    // Adaptive proof-of-work: raise difficulty as charged-request load climbs, so
    // high-volume abuse pays escalating CPU regardless of how it disguises itself.
    // Off by default — behavior is unchanged unless explicitly enabled.
    adaptive = config.adaptive ?? (process.env.TOLLBOOTH_ADAPTIVE === "true"),
    adaptivePerBit = Number(process.env.TOLLBOOTH_ADAPTIVE_PER_BIT) || 300, // +1 bit per N charged req/min
    maxDifficulty,
    // Observe-only mode: classify every request as charge-vs-free and count it,
    // but always let it through (never return 402). Use it to measure a site's
    // bot traffic for a week before flipping the meter on. Off by default.
    observe = config.observe ?? (process.env.TOLLBOOTH_OBSERVE === "true"),
    // Pluggable durable-stats sink. Default = in-memory (current behavior).
    // See sinks.js for kvStatsSink (Cloudflare KV) and httpStatsSink.
    statsSink,
    message = "This resource charges automated / AI clients per request. Humans browse free; bots pay in USDC via x402 or by solving a proof-of-work.",
  } = config;

  const isBot = makeBotMatcher(botUserAgents);
  const powEngine = pow ? createPow({ difficulty: powDifficulty, secret: powSecret }) : null;

  // Passive analytics — never affects request handling, just counts what happens.
  // `mem` is an always-on in-process mirror so `.stats()` stays synchronous for
  // single-process Node deployments. A durable `statsSink` (KV/HTTP) is written
  // through alongside and is the source of truth for `.snapshot()`.
  const mem = memorySink();
  const sink = statsSink || mem;
  const writeThrough = statsSink && statsSink !== mem;
  // Never let a buggy custom sink throw inside the request path — stats are
  // non-critical and must not be able to break a payment decision.
  const incr = (k, n = 1) => {
    try { mem.incr(k, n); } catch { /* ignore */ }
    if (writeThrough) { try { sink.incr(k, n); } catch { /* ignore */ } }
  };

  const looksHuman = (req) => {
    const ua = req.headers["user-agent"] || "";
    const accept = req.headers["accept"] || "";
    return /mozilla\/5\.0/i.test(ua) && /text\/html/i.test(accept);
  };
  const shouldCharge = (req) => {
    try {
      if (typeof free === "function" && free(req)) return false;
      if (typeof charge === "function") return Boolean(charge(req));
    } catch { return true; /* fail closed: charge on predicate error */ }
    if (mode === "all") return true;
    if (mode === "strict") return !looksHuman(req);
    return isBot(req.headers["user-agent"] || ""); // "bots" (default)
  };

  // Sliding-window of recent charged requests → adaptive PoW difficulty.
  const baseDifficulty = powEngine?.difficulty ?? (Number(process.env.TOLLBOOTH_POW_BITS) || 18);
  const ceilDifficulty = Math.min(Number(maxDifficulty) || baseDifficulty + 6, 32);
  const ADAPT_WINDOW_MS = 60_000;
  let chargedWindow = [];
  const difficultyNow = () => {
    if (!adaptive) return baseDifficulty;
    const cut = Date.now() - ADAPT_WINDOW_MS;
    if (chargedWindow.length > 100_000) chargedWindow = chargedWindow.filter((t) => t > cut); // hard bound
    else while (chargedWindow.length && chargedWindow[0] < cut) chargedWindow.shift();
    return Math.min(baseDifficulty + Math.floor(chargedWindow.length / Math.max(1, adaptivePerBit)), ceilDifficulty);
  };
  const resourceOf = (req) => {
    // Canonicalize to path+search (matches the edge impl) so the PoW binding is
    // stable and not confusable via a raw/abnormal request target.
    const raw = req.originalUrl || req.url || "/";
    let pathAndSearch = raw;
    try { const u = new URL(raw, "http://internal.invalid"); pathAndSearch = u.pathname + u.search; } catch { /* keep raw */ }
    // F18: bind the canonical ORIGIN, not just path+query, so a proof minted for
    // /x on site A cannot be replayed on site B. Prefer a configured
    // resourceBaseUrl; otherwise derive the origin from the request host (same
    // site => same origin; a different host => a different resource). Reusing one
    // TOLLBOOTH_SECRET across sites should ALSO use a unique secret per site.
    const origin = resourceBaseUrl
      ? resourceBaseUrl.replace(/\/$/, "")
      : `${req.protocol || "https"}://${String(req.headers?.host || (req.get && req.get("host")) || "").toLowerCase()}`;
    return origin + pathAndSearch;
  };

  function tollbooth(req, res, next) {
    incr("requests");
    if (!shouldCharge(req)) { incr("freeAllowed"); return next(); }
    // Observe-only: classify as would-charge but let it through. Lets operators
    // measure bot traffic on a live site before turning on enforcement.
    if (observe) { incr("wouldCharge"); res.setHeader("X-Tollbooth-Observed", "would-charge"); return next(); }
    const resource = resourceOf(req);
    // F18: the PoW challenge additionally binds the HTTP METHOD, so a proof
    // solved for GET /x can't be replayed against POST /x. The x402 `resource`
    // stays a plain URL (below) for wire compatibility.
    const powResource = `${(req.method || "GET").toUpperCase()} ${resource}`;

    const send402 = (extra = {}) => {
      incr("charged");
      if (adaptive) chargedWindow.push(Date.now());
      const body = {
        error: "Payment Required",
        message,
        accepts: payTo
          ? [{ scheme: "exact", network, maxAmountRequired: String(price), asset, payTo, resource }]
          : [],
        ...extra,
      };
      if (powEngine) body.proofOfWork = powEngine.challenge(powResource, difficultyNow());
      res.status(402).json(body);
    };

    // Free rail: proof-of-work.
    const powHeader = req.headers["x-pow-solution"];
    if (powEngine && powHeader) {
      const r = powEngine.verify(powHeader, powResource);
      if (r.ok) { incr("powSolved"); res.setHeader("X-Tollbooth-Paid", "pow"); return next(); }
      res.setHeader("X-Pow-Error", r.reason);
    }

    // Paid rail: x402 (USDC). Settlement verification is operator-supplied so
    // we reuse the standard, audited x402 stack rather than reinvent it.
    const payHeader = req.headers["x-payment"] || req.headers["payment-signature"];
    if (payTo && typeof verifyX402 === "function" && payHeader) {
      // Bound verification time so a slow/hung verifier can't exhaust resources.
      // F19: pass an AbortSignal and ABORT it on timeout, so a slow verifier that
      // also SETTLES cannot move money after we have already returned 402 (a
      // charged denial). A pure-verification callback may ignore the signal; a
      // settling one MUST cancel/drain in-flight work on it before returning.
      const ac = new AbortController();
      const timeout = new Promise((resolve) => setTimeout(() => { ac.abort(); resolve(false); }, VERIFY_TIMEOUT_MS));
      return Promise.race([Promise.resolve(verifyX402(req, { price, network, asset, payTo, resource, signal: ac.signal })), timeout])
        .then((ok) => {
          ac.abort(); // verification resolved: cancel anything still in flight
          if (ok) { incr("x402Paid"); res.setHeader("X-Tollbooth-Paid", "x402"); return next(); }
          send402();
        })
        .catch(() => { ac.abort(); res.setHeader("X-Tollbooth-Error", "x402-verify-failed"); send402(); });
    }

    return send402();
  }

  tollbooth.shouldCharge = shouldCharge;
  tollbooth.pow = powEngine;
  tollbooth.observe = observe;
  // Live counters for operators: how much traffic, how much was charged, and how
  // it was settled. A point-in-time snapshot (never mutated by the caller).
  // .stats() is sync (in-process mirror). .snapshot() is async (durable sink).
  tollbooth.stats = () => ({ ...mem.snapshot(), difficultyNow: difficultyNow(), observe });
  tollbooth.snapshot = async () => ({ ...(await sink.snapshot()), difficultyNow: difficultyNow(), observe });
  // Swallow flush errors — flush() is typically wired to ctx.waitUntil on the
  // edge; an unhandled rejection there pollutes logs without affecting the
  // already-sent response.
  tollbooth.flush = async () => { try { if (sink.flush) await sink.flush(); } catch { /* ignore */ } };
  return tollbooth;
}

/** Minimal reverse proxy: forward to `upstream` with the host PINNED (no SSRF via
 *  the request target), client trust/forwarding headers stripped, and the
 *  response STREAMED (no unbounded buffering). */
export function createProxy(upstream, { maxBody = 10 * 1024 * 1024 } = {}) {
  const base = new URL(upstream);
  return async (req, res) => {
    try {
      // Take ONLY the path+query from the (possibly hostile) target; the
      // authority is always the operator's upstream — protocol-relative or
      // absolute-form targets cannot redirect us to another host.
      const reqUrl = new URL(req.originalUrl || req.url || "/", base);
      const target = new URL(reqUrl.pathname + reqUrl.search, base);
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (!STRIP_INBOUND.has(k.toLowerCase())) headers[k] = v;
      }
      headers["x-forwarded-for"] = req.socket?.remoteAddress || ""; // set by us, not the client
      const method = req.method;
      const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req, maxBody);
      const up = await fetch(target, { method, headers, body, redirect: "manual" });
      res.status(up.status);
      up.headers.forEach((val, key) => {
        const lk = key.toLowerCase();
        // fetch already decoded the body; drop hop-by-hop / length/encoding headers.
        if (["content-encoding", "content-length", "transfer-encoding", "connection"].includes(lk)) return;
        res.setHeader(key, val);
      });
      if (up.body) Readable.fromWeb(up.body).pipe(res);
      else res.end();
    } catch (e) {
      if (!res.headersSent) res.status(502).json({ error: `tollbooth proxy failed: ${e.message}` });
      else res.end();
    }
  };
}

function readBody(req, cap = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > cap) { reject(new Error("request body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function startCli() {
  const upstream = process.env.TOLLBOOTH_UPSTREAM;
  const port = Number(process.env.PORT) || 4021;
  const _secret = process.env.TOLLBOOTH_SECRET;
  if (!_secret) {
    console.warn("⚠ TOLLBOOTH_SECRET not set — proof-of-work tokens use a random per-process secret: they won't survive a restart and will be rejected across multiple workers/instances. Set a stable TOLLBOOTH_SECRET in production.");
  } else if (/^change-me/i.test(_secret) || _secret === "change-me-to-a-long-random-string") {
    // FATAL, not a warning. The placeholder is published in our own deploy
    // template, so anyone can read it, mint a token with difficulty 0 and walk
    // through the gate without doing any work - the operator believes they are
    // charging while everything is free. A warning scrolls past in a container
    // log; refusing to start cannot be missed, and it fails CLOSED.
    console.error("✖ TOLLBOOTH_SECRET is the public placeholder from the deploy template. It is readable by anyone, so proof-of-work tokens can be forged and your gate bypassed for free. Refusing to start. Generate a real secret: openssl rand -hex 32");
    process.exit(1);
  }
  const { default: express } = await import("express");
  const app = express();
  const gate = createTollbooth({ resourceBaseUrl: process.env.TOLLBOOTH_RESOURCE_BASE || upstream || "" });
  // Operator analytics — aggregate counts only (no per-request data), mounted
  // before the gate so they're always reachable and never themselves charged.
  // Two opt-in admin tokens (legacy `TOLLBOOTH_STATS_TOKEN` covers /stats only;
  // `TOLLBOOTH_ADMIN_TOKEN` covers both the HTML dashboard AND /stats). If
  // neither is set the surfaces remain public (aggregate counts only — current
  // behavior) so existing deploys don't break. Comparison is timing-safe.
  const { dashboardHtml } = await import("./dashboard.js");
  const { timingSafeEqual } = await import("node:crypto");
  const ADMIN_TOKEN = process.env.TOLLBOOTH_ADMIN_TOKEN || "";
  const STATS_TOKEN = process.env.TOLLBOOTH_STATS_TOKEN || "";
  if (!ADMIN_TOKEN) {
    console.warn("⚠ TOLLBOOTH_ADMIN_TOKEN not set — the /__tollbooth analytics dashboard is publicly reachable (aggregate counts only, no per-request/payer data). Set TOLLBOOTH_ADMIN_TOKEN to require a token.");
  }
  const presented = (req) => {
    const auth = req.headers["authorization"];
    if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7);
    const hdr = req.headers["x-admin-token"];
    if (typeof hdr === "string") return hdr;
    return "";
  };
  // tokenMatch returns true only on a real, timing-safe equal match. An empty
  // `expected` is treated as "no rule configured", NOT as a wildcard — callers
  // upstream decide whether to invoke this check at all.
  const tokenMatch = (expected, got) => {
    if (!expected || typeof got !== "string" || got.length !== expected.length) return false;
    try { return timingSafeEqual(Buffer.from(got), Buffer.from(expected)); }
    catch { return false; }
  };
  app.get("/__tollbooth", (req, res) => {
    if (ADMIN_TOKEN && !tokenMatch(ADMIN_TOKEN, presented(req))) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="tollbooth"');
      return res.status(401).type("text/plain").send("Unauthorized");
    }
    res.type("html").send(dashboardHtml());
  });
  app.get("/__tollbooth/stats", (req, res) => {
    // Either ADMIN_TOKEN or STATS_TOKEN unlocks /stats; either being set turns
    // the endpoint from public to gated, and the presented value must match
    // ONE of the configured tokens.
    const gated = Boolean(ADMIN_TOKEN || STATS_TOKEN);
    if (gated) {
      const got = presented(req);
      if (!tokenMatch(ADMIN_TOKEN, got) && !tokenMatch(STATS_TOKEN, got)) {
        res.setHeader("WWW-Authenticate", 'Bearer realm="tollbooth"');
        return res.status(401).type("text/plain").send("Unauthorized");
      }
    }
    res.json(gate.stats());
  });
  app.use(gate);
  if (upstream) {
    app.use(createProxy(upstream));
  } else {
    app.use((_req, res) => res.json({ ok: true, note: "Bare tollbooth gate (no TOLLBOOTH_UPSTREAM set). Clients that reach here paid or solved a proof-of-work." }));
  }
  app.listen(port, () => {
    const rails = `${gate.pow ? "proof-of-work" : ""}${process.env.TOLLBOOTH_PAYTO ? (gate.pow ? ` + x402(${process.env.TOLLBOOTH_ASSET || "USDC"})` : `x402(${process.env.TOLLBOOTH_ASSET || "USDC"})`) : ""}`;
    console.log(`agent402-tollbooth listening on :${port} — charging AI bots via ${rails || "proof-of-work"}`);
    if (upstream) console.log(`  proxying → ${upstream}`);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) startCli();
