// Self-hostable x402 facilitator for Stellar.
//
// Wires the official @x402/core orchestration (x402Facilitator) to the
// official @x402/stellar facilitator-side scheme (ExactStellarScheme), which
// already implements Soroban simulation/auth-entry validation and on-chain
// settlement confirmation internally - this file is glue, not a payment
// protocol reimplementation. Testnet by default; mainnet is an explicit
// opt-in via FACILITATOR_NETWORK=pubnet (see signer.js).
//
//   node index.js          (reads FACILITATOR_STELLAR_SECRET, PORT from env)
import express from "express";
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";
import { getHorizonClient } from "@x402/stellar";
import { loadSigner, NETWORK, RPC_CONFIG } from "./signer.js";
import { invalidVerify, invalidSettle, normalizeVerify, normalizeSettle } from "./shape.js";
import { createSerialQueue } from "./queue.js";

const PORT = Number(process.env.PORT) || 4021;
const AUTH_TOKEN = (process.env.FACILITATOR_AUTH_TOKEN || "").trim();
const ALLOWED_PAYTO = (process.env.FACILITATOR_ALLOWED_PAYTO || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const LOW_BALANCE_XLM = Number(process.env.FACILITATOR_LOW_BALANCE_XLM) || 5;

if (!AUTH_TOKEN) {
  console.warn("[startup] FACILITATOR_AUTH_TOKEN is not set - /verify, /settle, and /supported are UNAUTHENTICATED.");
}
if (!ALLOWED_PAYTO.length) {
  console.warn("[startup] FACILITATOR_ALLOWED_PAYTO is not set - this facilitator will settle to ANY payTo, which lets unrelated parties use it as a free gas sponsor.");
}

const signer = loadSigner();
const horizon = getHorizonClient(NETWORK);

// areFeesSponsored: true is not a preference - it's the only value the
// current x402 Stellar spec/client support (the scheme's own source comment
// says so directly), and the facilitator's signer account pays the
// transaction fee on every settlement regardless of this flag's value.
const stellarScheme = new ExactStellarScheme([signer], {
  areFeesSponsored: true,
  ...(RPC_CONFIG ? { rpcConfig: RPC_CONFIG } : {}),
});

const facilitator = new x402Facilitator().register(NETWORK, stellarScheme);

// Settlement is serialized through this queue - see queue.js. Only settle()
// touches the signer's Stellar sequence number; verify() is read-only
// simulation and stays fully concurrent.
const enqueueSettle = createSerialQueue();

const app = express();

function isPlausiblePaymentRequirements(r) {
  return !!r && typeof r === "object"
    && typeof r.scheme === "string"
    && typeof r.network === "string"
    && typeof r.asset === "string"
    && typeof r.amount === "string"
    && typeof r.payTo === "string";
}

function isPlausiblePaymentPayload(p) {
  return !!p && typeof p === "object"
    && typeof p.x402Version === "number"
    && !!p.accepted && typeof p.accepted === "object"
    && !!p.payload && typeof p.payload === "object";
}

function bestEffortNetwork(body) {
  return body?.paymentRequirements?.network || body?.paymentPayload?.accepted?.network || undefined;
}

function safeMessage(err) {
  return (err?.message || String(err)).slice(0, 300);
}

// Auth failure is an access-control rejection, not a business outcome, so it
// is NOT held to the "always 200" rule below - a 401 is exactly what
// @x402/core's HTTPFacilitatorClient already treats any non-2xx as (a
// rejection), so this reads correctly to any x402-compliant caller.
function requireAuth(req, res, next) {
  if (!AUTH_TOKEN) return next();
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token !== AUTH_TOKEN) return res.status(401).json({ error: "unauthorized" });
  next();
}

// Placed immediately after express.json() so a malformed body never even
// reaches a route handler - it's still answered in schema-shaped JSON with
// HTTP 200, matching every other "we could classify this as invalid" path.
app.use(express.json({ limit: "256kb" }));
app.use((err, req, res, next) => {
  if (err?.type !== "entity.parse.failed") return next(err);
  if (req.path === "/settle") {
    return res.status(200).json(invalidSettle("invalid_request_malformed_body"));
  }
  return res.status(200).json(invalidVerify("invalid_request_malformed_body"));
});

app.get("/supported", requireAuth, (req, res) => {
  try {
    res.status(200).json(facilitator.getSupported());
  } catch (err) {
    console.error("[/supported] unexpected error:", err);
    res.status(200).json({ kinds: [], extensions: [], signers: {} });
  }
});

app.post("/verify", requireAuth, async (req, res) => {
  const { paymentPayload, paymentRequirements } = req.body ?? {};
  if (!isPlausiblePaymentPayload(paymentPayload) || !isPlausiblePaymentRequirements(paymentRequirements)) {
    return res.status(200).json(invalidVerify("invalid_request_malformed_body"));
  }
  if (ALLOWED_PAYTO.length && !ALLOWED_PAYTO.includes(paymentRequirements.payTo)) {
    return res.status(200).json(invalidVerify("payto_not_allowed"));
  }
  try {
    const result = await facilitator.verify(paymentPayload, paymentRequirements);
    res.status(200).json(normalizeVerify(result));
  } catch (err) {
    console.error("[/verify] dispatch error:", err);
    res.status(200).json(invalidVerify("facilitator_dispatch_error", undefined, safeMessage(err)));
  }
});

app.post("/settle", requireAuth, async (req, res) => {
  const { paymentPayload, paymentRequirements } = req.body ?? {};
  if (!isPlausiblePaymentPayload(paymentPayload) || !isPlausiblePaymentRequirements(paymentRequirements)) {
    return res.status(200).json(invalidSettle("invalid_request_malformed_body", bestEffortNetwork(req.body)));
  }
  if (ALLOWED_PAYTO.length && !ALLOWED_PAYTO.includes(paymentRequirements.payTo)) {
    return res.status(200).json(invalidSettle("payto_not_allowed", paymentRequirements.network));
  }
  try {
    const result = await enqueueSettle(() => facilitator.settle(paymentPayload, paymentRequirements));
    res.status(200).json(normalizeSettle(result, paymentRequirements.network));
  } catch (err) {
    console.error("[/settle] dispatch error:", err);
    res.status(200).json(invalidSettle("facilitator_dispatch_error", paymentRequirements.network, safeMessage(err)));
  }
});

// Unauthenticated by design - read-only, exposes no secret, just a public
// address and a balance number, so a future external monitor can poll it
// without needing the facilitator's own auth token.
app.get("/health", async (req, res) => {
  try {
    const account = await horizon.loadAccount(signer.address);
    const native = account.balances.find((b) => b.asset_type === "native");
    const xlmBalance = native ? Number(native.balance) : 0;
    res.status(200).json({
      signerAddress: signer.address,
      xlmBalance,
      low: xlmBalance < LOW_BALANCE_XLM,
    });
  } catch (err) {
    console.error("[/health] unexpected error:", err);
    res.status(200).json({ signerAddress: signer.address, xlmBalance: null, low: null, error: safeMessage(err) });
  }
});

// Only auto-start when run directly (`node index.js`) - test.js spawns this
// same file as a child process, which is exactly that case; importing this
// module for in-process testing would not be.
if (import.meta.url === `file://${process.argv[1]}`) {
  const httpServer = app.listen(PORT, () => {
    console.log(`agent402-facilitator (Stellar, ${NETWORK}) listening on :${PORT}`);
    console.log(`facilitator address: ${signer.address}`);
  });

  // Graceful shutdown: a Railway redeploy sends SIGTERM. Stop accepting new
  // connections but let an in-flight /verify or /settle finish - these are
  // money-moving requests, and a hard kill mid-settle is the same "took the
  // work, dropped the answer" failure src/server.js's own drain logic exists
  // to prevent. Only works if the platform grants a grace period (Railway
  // defaults to 0s between SIGTERM and SIGKILL - RAILWAY_DEPLOYMENT_DRAINING_SECONDS
  // must be set on this service, same as the main app's).
  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received - draining in-flight requests`);
    httpServer.close(() => process.exit(0));
    httpServer.closeIdleConnections();
    setInterval(() => httpServer.closeIdleConnections(), 5_000).unref();
    // A settle's worst case is ExactStellarScheme's own poll (15 attempts x
    // 1s default) - 30s stays comfortably above that without holding a
    // redeploy open indefinitely on a stuck request.
    setTimeout(() => process.exit(0), 30_000).unref();
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

export { app };
