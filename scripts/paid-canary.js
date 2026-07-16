// Paid-path canary — buys ONE tool from each live-data kit to prove that
// *buying* still settles end-to-end. Its pass/fail reflects whether PAYMENT
// works, NOT whether every third-party data API happened to respond:
//
//   • 200             → settled + delivered                       (success)
//   • 5xx / timeout   → payment SETTLED (x402 settles BEFORE the handler runs);
//                        the upstream data source errored          (WARNING, not a buying break)
//   • 402             → payment did NOT settle for that call       (settlement signal)
//   • 200 bad-shape   → delivered the wrong payload               (WARNING — tool/upstream quality)
//
// The canary PAGES (exit 1, opens the GitHub issue) only when *buying* is
// actually broken: the deterministic core tool (hash) didn't settle, nothing
// settled at all, or settlement failed on half-or-more of the tools. Isolated
// upstream throttles (CoinGecko / Pyth / Brave free-tier rate limits) are
// reported as warnings and do NOT page — that was the chronic false alarm
// ("PAID CANARY FAILED / buying may be broken" when a single data API blipped).
//
// Exit codes: 0 = buying works (warnings allowed) · 1 = buying broken · 2 = misconfig
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
// The x402 client + viem are imported dynamically inside main() so this module
// can be imported for unit tests (of the pure decision logic) without those
// packages installed — CI installs them just before the canary runs.

export const CORE_KIT = "core"; // deterministic baseline (hash): no upstream, so a failure = paywall/facilitator down

// Embeddings cache is DEFAULT-ON, so the llm-embed leg's input carries a
// per-run nonce — otherwise a canary re-run within the 10-min TTL would be
// served from cache for free and fake a "settled". The embed-cache follow-up
// reuses the SAME body to prove the free repeat.
export const EMBED_CANARY_INPUT = `agent402 canary embedding ${Date.now()}`;

// Per-tool spec: { kit, path, method, body?, priceUsd, check(body) → true | string }
export const TOOLS = [
  {
    kit: "core",
    path: "/api/hash",
    method: "POST",
    body: { text: "hello world" },
    priceUsd: 0.001,
    check: (r) => r.hex?.startsWith("b94d27b9") || `expected hex starting with b94d27b9, got ${JSON.stringify(r).slice(0, 80)}`,
  },
  {
    kit: "edgar",
    path: "/api/edgar-company-lookup?ticker=AAPL",
    method: "GET",
    priceUsd: 0.005,
    check: (r) => r.cik === "0000320193" || `expected cik 0000320193, got ${JSON.stringify(r).slice(0, 80)}`,
  },
  {
    kit: "search",
    path: "/api/search?q=bitcoin&count=1",
    method: "GET",
    priceUsd: 0.01,
    check: (r) => (Array.isArray(r.results) && r.results.length > 0) || `expected non-empty results array, got ${JSON.stringify(r).slice(0, 80)}`,
  },
  {
    kit: "macro",
    path: "/api/treasury-yield-curve",
    method: "GET",
    priceUsd: 0.005,
    check: (r) => (typeof r.yr10 === "number" && r.yr10 > 0 && r.yr10 < 25) || `expected yr10 in (0, 25), got ${JSON.stringify(r).slice(0, 80)}`,
  },
  {
    // Federal-data pack (NHTSA vPIC). Deterministic VIN -> fixed vehicle, the
    // same assertion src/selfcheck.js enforces. A real Base settlement also
    // seeds the new gov tools into settlement-driven indexes (x402scan surfaces
    // a tool once it has an on-chain paid buy, not from a catalog crawl).
    kit: "gov",
    path: "/api/vin-decode?vin=1HGCM82633A004352",
    method: "GET",
    priceUsd: 0.004,
    check: (r) => (r.vehicle?.make === "HONDA" && r.vehicle?.year === "2003") || `expected vehicle.make HONDA + year 2003, got ${JSON.stringify(r).slice(0, 100)}`,
  },
  {
    // Federal-data pack (FCC Area API). Fixed coordinates -> fixed county/state.
    kit: "gov",
    path: "/api/geo-lookup?lat=34.0522&lon=-118.2437",
    method: "GET",
    priceUsd: 0.003,
    check: (r) => (r.county === "Los Angeles County" && r.state === "CA") || `expected Los Angeles County/CA, got ${JSON.stringify(r).slice(0, 100)}`,
  },
  {
    kit: "finance",
    path: "/api/stock-quote?symbol=AAPL",
    method: "GET",
    priceUsd: 0.003,
    check: (r) => (r.symbol === "AAPL" && r.currency === "USD" && r.price > 1) || `expected AAPL/USD/price>1, got ${JSON.stringify(r).slice(0, 80)}`,
  },
  {
    // Options-chain rides the Yahoo relay's options endpoint (session-crumb
    // handshake handled server-side) — a different relay path than
    // stock-quote's chart endpoint, so this leg keeps the deployed options
    // route continuously proven. Input is the tool's own discovery example.
    kit: "finance",
    path: "/api/options-chain?symbol=AAPL",
    method: "GET",
    priceUsd: 0.005,
    check: (r) => (r.symbol === "AAPL" && Array.isArray(r.expirations) && r.expirations.length > 0 && Array.isArray(r.strikes) && Array.isArray(r.calls) && Array.isArray(r.puts)) || `expected AAPL chain with expirations/strikes/calls/puts, got ${JSON.stringify(r).slice(0, 100)}`,
  },
  {
    kit: "crypto",
    path: "/api/crypto-price?coins=BTC",
    method: "GET",
    priceUsd: 0.005,
    check: (r) => (r.coins?.bitcoin?.price > 1000) || `expected bitcoin.price > 1000, got ${JSON.stringify(r).slice(0, 80)}`,
  },
  {
    kit: "chain",
    path: "/api/gas-snapshot",
    method: "POST",
    body: { network: "base" },
    priceUsd: 0.005,
    check: (r) => (
      typeof r.baseFeeGwei === "number" && r.baseFeeGwei > 0 && r.baseFeeGwei < 1000 &&
      r.fast && typeof r.fast.totalGwei === "number" && r.fast.totalGwei >= r.baseFeeGwei &&
      r.chainId === 8453
    ) || `expected baseFeeGwei (0,1000) + fast.totalGwei>=baseFee + chainId=8453, got ${JSON.stringify(r).slice(0, 120)}`,
  },
  {
    kit: "price-feed",
    path: "/api/price-pyth",
    method: "POST",
    body: { ids: ["ETHUSD"] },
    priceUsd: 0.001,
    check: (r) => {
      const eth = Array.isArray(r.feeds) && r.feeds.find((f) => f.alias === "ETHUSD");
      return (eth && typeof eth.price === "number" && eth.price > 80 && eth.price < 50000)
        || `expected feeds[ETHUSD].price in (80, 50000), got ${JSON.stringify(r).slice(0, 120)}`;
    },
  },
  {
    kit: "answer",
    path: "/api/answer?q=what+is+the+speed+of+light",
    method: "GET",
    priceUsd: 0.03,
    check: (r) => (typeof r.answer === "string" && r.answer.length > 0 && r.citationCount > 0) || `expected non-empty answer + citationCount>0, got ${JSON.stringify(r).slice(0, 80)}`,
  },
  {
    kit: "llm-gateway",
    path: "/v1/chat/completions",
    method: "POST",
    body: { model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 5 },
    priceUsd: 0.02,
    check: (r) => (typeof r.choices?.[0]?.message?.content === "string" && r.choices[0].message.content.length > 0) || `expected choices[0].message.content, got ${JSON.stringify(r).slice(0, 100)}`,
  },
  {
    // Nano tier — the loop-priced gateway. Same upstream path as the base
    // tier; this leg proves the tier constants + model allowlist against a
    // REAL completion daily (gpt-4.1-nano already served via v1-chat before
    // the nano tier existed, so the model id itself is prod-proven).
    kit: "llm-nano",
    path: "/v1/nano/chat/completions",
    method: "POST",
    body: { model: "openai/gpt-4.1-nano", messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 5 },
    priceUsd: 0.003,
    check: (r) => (typeof r.choices?.[0]?.message?.content === "string" && r.choices[0].message.content.length > 0) || `expected choices[0].message.content, got ${JSON.stringify(r).slice(0, 100)}`,
  },
  {
    // Streaming leg — stream: true must settle AND deliver real SSE frames.
    // raw: the check reads the response as text and asserts OpenAI wire
    // framing (data: chunks ending in [DONE]). deepseek-chat is requested
    // directly (proven alive) so this leg tests the streaming path itself,
    // orthogonal to the nano leg above which exercises the failover chain.
    kit: "llm-stream",
    path: "/v1/nano/chat/completions",
    method: "POST",
    raw: true,
    body: { model: "deepseek/deepseek-chat", messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 5, stream: true },
    priceUsd: 0.003,
    check: (text) => (typeof text === "string" && text.includes("data:") && text.includes("[DONE]")) || `expected SSE frames ending in [DONE], got ${String(text).slice(0, 100)}`,
  },
  {
    // Auto tier — eval-ranked routing. NO model in the body: the gateway must
    // classify server-side, serve via the ranked chain, and disclose the
    // decision. "Reply with exactly: OK" classifies general → gpt-4o-mini
    // heads that ranking (canary-proven daily), so this leg proves the router
    // itself, orthogonal to the nano leg's failover-chain coverage.
    kit: "llm-auto",
    path: "/v1/auto/chat/completions",
    method: "POST",
    body: { messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 5 },
    priceUsd: 0.01,
    check: (r) =>
      (typeof r.choices?.[0]?.message?.content === "string" && r.choices[0].message.content.length > 0 &&
        r.agent402_router?.category === "general" && r.agent402_router?.quality === "balanced" &&
        typeof r.agent402_router?.served === "string") ||
      `expected routed completion + agent402_router {category, quality, served}, got ${JSON.stringify(r).slice(0, 120)}`,
  },
  {
    // Embeddings tier — OpenAI wire path, loop-priced. Asserts the untouched
    // OpenAI list shape with a real vector; the default-on cache behavior is
    // proven by the embed-cache follow-up below (pays here, repeats free).
    kit: "llm-embed",
    path: "/v1/embeddings",
    method: "POST",
    body: { input: EMBED_CANARY_INPUT, model: "text-embedding-3-small" },
    priceUsd: 0.002,
    check: (r) =>
      (r.object === "list" && Array.isArray(r.data) && Array.isArray(r.data[0]?.embedding) &&
        r.data[0].embedding.length >= 256 && typeof r.model === "string") ||
      `expected an OpenAI embeddings list with a real vector, got ${JSON.stringify(r).slice(0, 100)}`,
  },
  {
    // Image generation tier — OpenAI images wire over OpenRouter (Gemini
    // flash-image). A real base64 payload of plausible image size proves the
    // modalities translation, the price-capped provider call, and settlement.
    kit: "llm-image",
    path: "/v1/images/generations",
    method: "POST",
    body: { prompt: "A tiny pixel-art lighthouse at dusk" },
    priceUsd: 0.08,
    check: (r) =>
      (Array.isArray(r.data) && typeof r.data[0]?.b64_json === "string" && r.data[0].b64_json.length > 10_000 &&
        typeof r.created === "number") ||
      `expected OpenAI images shape with a real b64_json payload, got ${JSON.stringify(r).slice(0, 100)}`,
  },
  {
    // TTS — the response is mp3 BYTES, not JSON: a real audio-sized payload
    // proves the binary sentinel path, the five-model failover chain's head
    // (or a live fallback), and settlement. Re-added 2026-07-16 when the
    // tier moved off OpenRouter's phantom OpenAI TTS ids onto the
    // probe-proven chain (Voxtral → Grok → Kokoro → Zonos → MAI).
    kit: "llm-speech",
    path: "/v1/audio/speech",
    method: "POST",
    raw: true,
    body: { input: "Agent402 canary: text to speech is live.", voice: "alloy" },
    priceUsd: 0.06,
    check: (t) => (typeof t === "string" && t.length > 5_000) || `expected raw audio bytes, got ${String(t).length} chars`,
  },
  {
    // Route-and-execute — the SOR's executing surface. Dispatches internally
    // to /api/hash; a real digest in the receipt-bearing envelope proves the
    // resolve → guard → dispatch → receipt chain on prod.
    kit: "route-exec",
    path: "/api/route/execute",
    method: "POST",
    body: { slug: "hash", params: { text: "canary", algo: "sha256" } },
    priceUsd: 0.01,
    check: (r) => (r.receipt?.slug === "hash" && typeof r.result?.hex === "string" && r.result.hex.length === 64) || `expected receipt.slug=hash + 64-char hex, got ${JSON.stringify(r).slice(0, 120)}`,
  },
  {
    // Buyer usage report — payment IS the identity. By this point the run has
    // settled several Base buys from the burner, so the report must echo the
    // payer wallet and show real history: totals >= 1 and a non-empty slug
    // table. Proves the payerFromRequest → sales-ledger read path end to end.
    kit: "my-usage",
    path: "/api/my-usage",
    method: "POST",
    body: { days: 7 },
    priceUsd: 0.005,
    check: (r) =>
      (typeof r.wallet === "string" && /^0x[0-9a-f]{40}$/.test(r.wallet) &&
        r.totals?.calls >= 1 && Array.isArray(r.bySlug) && r.bySlug.length >= 1) ||
      `expected the payer's own usage report, got ${JSON.stringify(r).slice(0, 120)}`,
  },
  {
    kit: "edgar",
    path: "/api/company-financials?ticker=AAPL",
    method: "GET",
    priceUsd: 0.02,
    check: (r) => (Array.isArray(r.metrics) && r.metrics.length === 9 && r.metrics[0].label === "Revenue" && r.metrics[0].latestAnnual?.value > 1e9) || `expected 9 metrics with Revenue > $1B, got ${JSON.stringify(r).slice(0, 120)}`,
  },
  {
    kit: "search",
    path: "/api/multi-search",
    method: "POST",
    body: { queries: ["x402 protocol", "USDC micropayments"], count: 2 },
    priceUsd: 0.08,
    check: (r) => (Array.isArray(r.searches) && r.searches.length === 2 && r.totalResults > 0) || `expected 2 searches with totalResults>0, got ${JSON.stringify(r).slice(0, 120)}`,
  },
  {
    kit: "skill-pack",
    path: "/api/skill/financial-analysis",
    method: "POST",
    body: { ticker: "AAPL" },
    priceUsd: 0.04,
    check: (r) => (r.pack === "financial-analysis" && Array.isArray(r.steps) && r.steps.filter((s) => s.ok).length >= 2) || `expected pack=financial-analysis with >=2 ok steps, got ${JSON.stringify(r).slice(0, 120)}`,
  },
  {
    kit: "skill-pack",
    path: "/api/skill/market-brief",
    method: "POST",
    body: { coin: "bitcoin" },
    priceUsd: 0.025,
    check: (r) => (r.pack === "market-brief" && Array.isArray(r.steps) && r.steps.filter((s) => s.ok).length >= 2) || `expected pack=market-brief with >=2 ok steps, got ${JSON.stringify(r).slice(0, 120)}`,
  },
  // Stellar (USDC on Stellar) settlement is tested via a separate mechanism —
  // the TOOLS array pays exclusively through Base EVM (registerExactEvmScheme),
  // so adding a Stellar entry here would settle on Base, not prove the Stellar
  // rail. First Stellar settlement confirmed manually 2026-07-04 ($0.001).
  // A dedicated inline Stellar leg (like the Solana/Robinhood legs below) can
  // be added once @x402/stellar/exact/client is available in the SDK.
  {
    kit: "skill-pack",
    path: "/api/skill/domain-intel",
    method: "POST",
    body: { domain: "stripe.com" },
    priceUsd: 0.25,
    check: (r) => (r.pack === "domain-intel" && r.steps?.every(s => s.ok)) || `expected ALL steps ok, got ${r.steps?.map(s=>s.ok?'✓':'✗ '+s.slug).join(',')}`,
  },
  {
    kit: "skill-pack",
    path: "/api/skill/company-dossier",
    method: "POST",
    body: { ticker: "AAPL" },
    priceUsd: 0.50,
    check: (r) => (r.pack === "company-dossier" && r.steps?.every(s => s.ok)) || `expected ALL steps ok, got ${r.steps?.map(s=>s.ok?'✓':'✗ '+s.slug).join(',')}`,
  },
  {
    kit: "skill-pack",
    path: "/api/skill/crypto-dossier",
    method: "POST",
    body: { coin: "bitcoin" },
    priceUsd: 0.30,
    check: (r) => (r.pack === "crypto-dossier" && r.steps?.every(s => s.ok)) || `expected ALL steps ok, got ${r.steps?.map(s=>s.ok?'✓':'✗ '+s.slug).join(',')}`,
  },
];

// Why a paid request 402'd. On a settle FAILURE the middleware attaches the
// FAILED receipt to the 402's PAYMENT-RESPONSE header ({ success:false,
// errorReason, errorMessage }) — THAT is where the facilitator's actual
// rejection reason lives. The payment-required header on the same response is
// just a fresh challenge (its `error` names a verify failure, if any), which
// is why reading only it printed "facilitator reason: null" for the
// 2026-07-16 Robinhood rejection and discarded the only copy of the reason.
// Pure (takes anything with .get(name)) — unit-tested in test-paid-canary.js.
export function settleRejectReason(headers) {
  for (const name of ["payment-response", "x-payment-response"]) {
    const h = headers.get(name);
    if (!h) continue;
    try {
      const receipt = JSON.parse(Buffer.from(h, "base64").toString("utf8"));
      if (receipt?.success === false) return receipt.errorReason || receipt.errorMessage || null;
    } catch { /* malformed receipt — fall through to the challenge */ }
  }
  const h = headers.get("payment-required");
  if (h) {
    try { return JSON.parse(Buffer.from(h, "base64").toString("utf8"))?.error ?? null; } catch { /* ignore */ }
  }
  return null;
}

// Classify one tool result. Pure — unit-tested in scripts/test-paid-canary.js.
//   settled | bad-shape | unsettled | upstream | request-error | unreachable
export function classifyResult({ status, shapeOk, transportError } = {}) {
  if (transportError) return "unreachable";
  if (status === 200) return shapeOk === true ? "settled" : "bad-shape";
  if (status === 402) return "unsettled";   // x402 payment did not complete
  if (status >= 500) return "upstream";     // PAID (settles pre-handler); upstream data source errored
  return "request-error";                   // other 4xx — tool-specific, not a buying break
}

// Decide whether BUYING is broken from all tool results. Pure — unit-tested.
export function decideCanary(results, { coreKit = CORE_KIT } = {}) {
  const rows = results.map((r) => ({ ...r, cls: classifyResult(r) }));
  const core = rows.find((r) => r.kit === coreKit);
  const coreSettled = !!core && core.status === 200; // payment went through on the deterministic baseline
  const settled = rows.filter((r) => r.cls === "settled").length;
  const unsettled = rows.filter((r) => r.cls === "unsettled").length;
  const unreachable = rows.filter((r) => r.cls === "unreachable").length;
  const half = Math.ceil(rows.length / 2);

  const reasons = [];
  if (!coreSettled) reasons.push(`core tool "${coreKit}" did not settle — paywall / facilitator / settlement is down`);
  if (settled === 0) reasons.push("no tool settled — buying is down");
  if ((unsettled + unreachable) >= half) reasons.push(`${unsettled + unreachable}/${rows.length} calls failed to settle — systemic settlement failure`);

  const warnings = rows
    .filter((r) => r.cls !== "settled")
    .map((r) => `${r.kit}:${r.path} [${r.cls}]${r.status ? ` HTTP ${r.status}` : ""}${typeof r.shapeOk === "string" ? ` — ${r.shapeOk}` : ""}`);

  return { broken: reasons.length > 0, coreSettled, settled, unsettled, unreachable, rows, warnings, reasons };
}

// --- CLI (network). Importing this module for tests does NOT run any of this. ---
async function main() {
  const TARGET = process.env.TARGET_URL || "https://agent402.tools";
  const KEY_FILE = process.env.KEY_FILE || "/tmp/agent-key";
  const pk = (process.env.BURNER_KEY || "").trim() || (existsSync(KEY_FILE) ? readFileSync(KEY_FILE, "utf8").trim() : "");
  if (!pk) { console.error("paid-canary: no BURNER_KEY / KEY_FILE — cannot run the paid check"); process.exit(2); }

  const [{ privateKeyToAccount }, { x402Client }, { registerExactEvmScheme }, { wrapFetchWithPayment }] = await Promise.all([
    import("viem/accounts"), import("@x402/core/client"), import("@x402/evm/exact/client"), import("@x402/fetch"),
  ]);
  const account = privateKeyToAccount(pk);
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: account });

  // Mark every canary request as internal traffic: X-Heartbeat-Token =
  // HMAC(POW_SECRET, UTC minute) — the same unspoofable marker the heartbeat
  // probe sends (verified in src/pow.js; rail attribution is unaffected, the
  // buy still settles as usdc). Without it the canary's daily REAL purchases
  // are indistinguishable from external demand in the sales ledger and the
  // PostHog settlement stream. Minted per request (minute-scoped token).
  const secret = (process.env.POW_SECRET || "").trim();
  if (!secret) console.warn("WARN  POW_SECRET not set — canary buys will record as EXTERNAL demand in the sales ledger");
  // @x402/fetch passes a Request object (with the X-PAYMENT header) for the
  // paid retry — build via `new Request` so method/body/payment header are
  // preserved, then ADD the heartbeat header. Rebuilding with
  // fetch(url, {...init, headers}) drops X-PAYMENT and no payment is sent
  // (see test-client-paid-live.js, which hit exactly this).
  const synthFetch = !secret ? fetch : (input, init) => {
    const minute = Math.floor(Date.now() / 60_000);
    const token = createHmac("sha256", secret).update(`heartbeat:${minute}`).digest("base64url").slice(0, 32);
    const req = new Request(input, init);
    req.headers.set("X-Heartbeat-Token", token);
    return fetch(req);
  };
  const payFetch = wrapFetchWithPayment(synthFetch, client);

  // One-shot retry on 5xx — absorbs a true one-off upstream throttle before we
  // even classify. A persistent upstream issue fails the retry too and is then
  // recorded as an "upstream" warning (payment still settled), not a buying break.
  async function payOnceWithRetryOn5xx(url, init) {
    const first = await payFetch(url, init);
    if (first.status < 500 || first.status > 599) return first;
    await first.text().catch(() => "");
    console.warn(`  retry ${init.method} ${url} after HTTP ${first.status} (10s backoff)`);
    await new Promise((r) => setTimeout(r, 10000));
    return payFetch(url, init);
  }

  // Preflight (config) — a WARNING only; it indicates a missing env var, not a
  // payments outage, so it must not page.
  try {
    const health = await (await fetch(`${TARGET}/health`)).json();
    if (health?.flags?.yahooRelay !== true) console.warn(`WARN  preflight: /health.flags.yahooRelay=${health?.flags?.yahooRelay} (set YAHOO_RELAY_URL/TOKEN) — finance tool may warn`);
    else console.log("OK    preflight /health.flags.yahooRelay=true");
  } catch (e) {
    console.warn(`WARN  preflight: GET ${TARGET}/health failed: ${(e?.message || String(e)).slice(0, 120)}`);
  }

  const results = [];
  for (const t of TOOLS) {
    const url = `${TARGET}${t.path}`;
    const init = { method: t.method };
    if (t.body) { init.headers = { "Content-Type": "application/json" }; init.body = JSON.stringify(t.body); }
    try {
      const res = await payOnceWithRetryOn5xx(url, init);
      const body = t.raw ? await res.text().catch(() => "") : await res.json().catch(() => ({}));
      const shapeOk = res.status === 200 ? t.check(body) : false;
      const row = { kit: t.kit, path: t.path, status: res.status, shapeOk, priceUsd: t.priceUsd };
      results.push(row);
      const cls = classifyResult(row);
      if (cls === "settled") console.log(`OK    ${t.kit.padEnd(10)} ${t.path}  → settled $${t.priceUsd.toFixed(3)}`);
      else console.warn(`WARN  ${t.kit}:${t.path} [${cls}] HTTP ${res.status}${typeof shapeOk === "string" ? ` — ${shapeOk}` : ` ${JSON.stringify(body).slice(0, 100)}`}`);
    } catch (e) {
      results.push({ kit: t.kit, path: t.path, status: null, shapeOk: false, transportError: true, priceUsd: t.priceUsd });
      console.warn(`WARN  ${t.kit}:${t.path} [unreachable] ${(e?.message || String(e)).slice(0, 140)}`);
    }
  }

  // Optional Solana leg — gated on SOLANA_BURNER_KEY (base58 64-byte secret
  // or JSON byte array; fund it with USDC on Solana). Buys the $0.05
  // skill-decode-blob pack (seven pure-CPU tools, deterministic, no upstream
  // cost) with an SVM-ONLY client, so the payment can only settle on a Solana
  // accept — a true Solana-path proof with no silent EVM fallback. $0.05
  // instead of the $0.001 hash so the transfer clears explorer dust filters;
  // the printed tx signature is still the authoritative proof either way.
  // Informational: failures WARN, never page (the EVM verdict above decides
  // paging), so an unset or unfunded burner cannot open an issue.
  await (async () => {
    const raw = (process.env.SOLANA_BURNER_KEY || "").trim();
    if (!raw) { console.log("\nsolana leg: skipped (no SOLANA_BURNER_KEY)"); return; }
    try {
      const [{ x402Client: SvmClient }, { registerExactSvmScheme }, { wrapFetchWithPayment: wrapSvm }, kit, { createHash }] = await Promise.all([
        import("@x402/core/client"), import("@x402/svm/exact/client"), import("@x402/fetch"), import("@solana/kit"), import("node:crypto"),
      ]);
      const bytes = raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : new Uint8Array(kit.getBase58Encoder().encode(raw));
      const signer = await kit.createKeyPairSignerFromBytes(bytes);
      const svmPay = wrapSvm(synthFetch, registerExactSvmScheme(new SvmClient(), { signer }));
      const res = await svmPay(`${TARGET}/api/skill/decode-blob`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        // The pack's own documented example blob (a JWT) — deterministic steps.
        body: JSON.stringify({ blob: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ" }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 200 && body.pack === "decode-blob" && Array.isArray(body.steps) && body.steps.length >= 5) {
        // Print the on-chain proof, not just the claim: the settle receipt
        // (PAYMENT-RESPONSE header, v2; X-PAYMENT-RESPONSE, v1) carries the
        // transaction signature — a clickable solscan link beats "trust the
        // facilitator" (and dust-sized transfers are hidden by default in
        // explorer transfer views, so the signature is the reliable check).
        let tx = null;
        const receiptHdr = res.headers.get("payment-response") || res.headers.get("x-payment-response");
        if (receiptHdr) {
          try { tx = JSON.parse(Buffer.from(receiptHdr, "base64").toString("utf8"))?.transaction || null; } catch { /* best-effort */ }
        }
        console.log(`\nOK    solana     /api/skill/decode-blob  → settled $0.05 USDC on Solana (payer ${signer.address})${tx ? `\n      tx: https://solscan.io/tx/${tx}` : "\n      (no settle receipt header found — settlement claimed by 200 only)"}`);
      } else if (res.status === 402) {
        console.warn(`\nWARN  solana leg did NOT settle (HTTP 402, payer ${signer.address}) — decoding diagnostics:`);
        // A settle rejection's reason rides the PAYMENT-RESPONSE header
        // (settleRejectReason reads it); the PAYMENT-REQUIRED header on the
        // same response is the re-issued challenge whose `error` names a
        // VERIFY failure (wrong mint, missing feePayer, insufficient funds,
        // version skew). Decode both so the log names the actual failure
        // instead of guessing.
        const decode402 = (r) => {
          const h = r.headers.get("payment-required");
          if (!h) return null;
          try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
        };
        const failReq = decode402(res);
        console.warn(`      settle rejection reason: ${JSON.stringify(settleRejectReason(res.headers))}`);
        console.warn(`      post-payment challenge: error=${JSON.stringify(failReq?.error ?? null)} x402Version=${failReq?.x402Version ?? "?"}`);
        try {
          // Fresh unpaid request → what a Solana buyer is actually offered.
          const bare = await fetch(`${TARGET}/api/skill/decode-blob`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blob: "canary" }) });
          const req = decode402(bare) ?? (await bare.json().catch(() => null));
          const sol = (req?.accepts || []).filter((a) => String(a.network || "").startsWith("solana:"));
          console.warn(`      solana accepts offered: ${sol.length ? JSON.stringify(sol).slice(0, 600) : "NONE — Solana missing from the live 402"}`);
        } catch (e2) {
          console.warn(`      (could not re-fetch challenge for diagnostics: ${(e2?.message || String(e2)).slice(0, 100)})`);
        }
      } else {
        console.warn(`\nWARN  solana leg: HTTP ${res.status} ${JSON.stringify(body).slice(0, 120)}`);
      }
    } catch (e) {
      console.warn(`\nWARN  solana leg errored: ${(e?.message || String(e)).slice(0, 160)}`);
    }
  })();

  // Optional Robinhood Chain leg — same burner key as the EVM canary above
  // (one 0x address, funded with USDG on chain 4663). wrapFetchWithPayment
  // lets the client pick ANY eip155 accept (it would settle on Base), so this
  // leg negotiates manually: take the live 402, filter the accepts down to
  // eip155:4663, and pay THAT — settlement can only happen in USDG on
  // Robinhood Chain, a true rail proof with no silent Base fallback. The
  // accept carries the USDG asset + EIP-712 domain (extra.name/version), so
  // the standard EVM scheme signs it as-is. $0.001/call; a funded burner
  // covers years of daily proof. Informational: failures WARN, never page
  // (the EVM verdict above decides paging) — but a WARN here that robinhood
  // is missing from the accepts is the early signal the rail was dropped.
  await (async () => {
    try {
      const { x402HTTPClient } = await import("@x402/core/client");
      const http = new x402HTTPClient(client);
      const reqInit = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "usdg-canary" }) };
      const bare = await synthFetch(`${TARGET}/api/hash`, reqInit);
      if (bare.status !== 402) {
        console.warn(`\nWARN  robinhood leg: expected a 402 challenge from /api/hash, got HTTP ${bare.status}`);
        return;
      }
      let paymentRequired;
      try {
        const bareBody = await bare.json().catch(() => undefined);
        paymentRequired = http.getPaymentRequiredResponse((n) => bare.headers.get(n), bareBody);
      } catch (e) {
        console.warn(`\nWARN  robinhood leg: could not parse the 402 challenge: ${(e?.message || String(e)).slice(0, 120)}`);
        return;
      }
      const rh = (paymentRequired.accepts || []).filter((a) => String(a.network || "") === "eip155:4663");
      if (!rh.length) {
        console.warn(`\nWARN  robinhood leg: eip155:4663 NOT among the live 402 accepts — the Robinhood/USDG rail has dropped out of the offer (PAYMENT_NETWORKS or ROBINHOOD_FACILITATOR_URL changed on prod?)`);
        return;
      }
      const payload = await client.createPaymentPayload({ ...paymentRequired, accepts: rh });
      const payHeaders = http.encodePaymentSignatureHeader(payload);
      const paid = await synthFetch(`${TARGET}/api/hash`, {
        ...reqInit,
        headers: { ...reqInit.headers, ...payHeaders, "Access-Control-Expose-Headers": "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE" },
      });
      const body = await paid.json().catch(() => ({}));
      if (paid.status === 200 && typeof body.hex === "string") {
        let tx = null, net = null;
        const receiptHdr = paid.headers.get("payment-response") || paid.headers.get("x-payment-response");
        if (receiptHdr) {
          try {
            const receipt = JSON.parse(Buffer.from(receiptHdr, "base64").toString("utf8"));
            tx = receipt?.transaction || null;
            net = receipt?.network || null;
          } catch { /* best-effort */ }
        }
        console.log(`\nOK    robinhood  /api/hash  → settled $0.001 USDG on Robinhood Chain (payer ${account.address}${net ? `, network ${net}` : ""})${tx ? `\n      tx: https://robinhoodchain.blockscout.com/tx/${tx}` : "\n      (no settle receipt header found — settlement claimed by 200 only)"}`);
      } else if (paid.status === 402) {
        const reason = settleRejectReason(paid.headers);
        console.warn(`\nWARN  robinhood leg did NOT settle (HTTP 402, payer ${account.address}) — facilitator reason: ${JSON.stringify(reason)} (unfunded USDG burner, facilitator outage, or EIP-712 domain drift)`);
      } else {
        console.warn(`\nWARN  robinhood leg: HTTP ${paid.status} ${JSON.stringify(body).slice(0, 120)}`);
      }
    } catch (e) {
      console.warn(`\nWARN  robinhood leg errored: ${(e?.message || String(e)).slice(0, 160)}`);
    }
  })();

  // Pinned EVM legs — Polygon + Arbitrum, same negotiation as the Robinhood
  // leg above (filter the live 402's accepts down to ONE CAIP-2 chain and pay
  // that, so settlement cannot silently fall back to Base). Same burner
  // address, funded with USDC on each chain. $0.001/day per rail keeps a
  // visible internal settle on /revenue for every offered rail. Informational:
  // failures WARN, never page (the Base verdict above decides paging).
  for (const leg of [
    { key: "polygon", caip2: "eip155:137", sym: "USDC", chainLabel: "Polygon", tx: (h) => `https://polygonscan.com/tx/${h}` },
    { key: "arbitrum", caip2: "eip155:42161", sym: "USDC", chainLabel: "Arbitrum", tx: (h) => `https://arbiscan.io/tx/${h}` },
    { key: "monad", caip2: "eip155:143", sym: "USDC", chainLabel: "Monad", tx: (h) => `https://monadscan.com/tx/${h}` },
  ]) {
    try {
      const { x402HTTPClient } = await import("@x402/core/client");
      const http = new x402HTTPClient(client);
      const reqInit = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: `${leg.key}-canary` }) };
      const bare = await synthFetch(`${TARGET}/api/hash`, reqInit);
      if (bare.status !== 402) {
        console.warn(`\nWARN  ${leg.key} leg: expected a 402 challenge from /api/hash, got HTTP ${bare.status}`);
        continue;
      }
      let paymentRequired;
      try {
        const bareBody = await bare.json().catch(() => undefined);
        paymentRequired = http.getPaymentRequiredResponse((n) => bare.headers.get(n), bareBody);
      } catch (e) {
        console.warn(`\nWARN  ${leg.key} leg: could not parse the 402 challenge: ${(e?.message || String(e)).slice(0, 120)}`);
        continue;
      }
      const accepts = (paymentRequired.accepts || []).filter((a) => String(a.network || "") === leg.caip2);
      if (!accepts.length) {
        console.warn(`\nWARN  ${leg.key} leg: ${leg.caip2} NOT among the live 402 accepts — the ${leg.chainLabel} rail has dropped out of the offer (PAYMENT_NETWORKS changed on prod?)`);
        continue;
      }
      const payload = await client.createPaymentPayload({ ...paymentRequired, accepts });
      const payHeaders = http.encodePaymentSignatureHeader(payload);
      const paid = await synthFetch(`${TARGET}/api/hash`, {
        ...reqInit,
        headers: { ...reqInit.headers, ...payHeaders, "Access-Control-Expose-Headers": "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE" },
      });
      const body = await paid.json().catch(() => ({}));
      if (paid.status === 200 && typeof body.hex === "string") {
        let tx = null, net = null;
        const receiptHdr = paid.headers.get("payment-response") || paid.headers.get("x-payment-response");
        if (receiptHdr) {
          try {
            const receipt = JSON.parse(Buffer.from(receiptHdr, "base64").toString("utf8"));
            tx = receipt?.transaction || null;
            net = receipt?.network || null;
          } catch { /* best-effort */ }
        }
        console.log(`\nOK    ${leg.key.padEnd(9)} /api/hash  → settled $0.001 ${leg.sym} on ${leg.chainLabel} (payer ${account.address}${net ? `, network ${net}` : ""})${tx ? `\n      tx: ${leg.tx(tx)}` : "\n      (no settle receipt header found — settlement claimed by 200 only)"}`);
      } else if (paid.status === 402) {
        const reason = settleRejectReason(paid.headers);
        console.warn(`\nWARN  ${leg.key} leg did NOT settle (HTTP 402, payer ${account.address}) — facilitator reason: ${JSON.stringify(reason)} (unfunded ${leg.sym} burner on ${leg.chainLabel}, facilitator outage, or EIP-712 domain drift)`);
      } else {
        console.warn(`\nWARN  ${leg.key} leg: HTTP ${paid.status} ${JSON.stringify(body).slice(0, 120)}`);
      }
    } catch (e) {
      console.warn(`\nWARN  ${leg.key} leg errored: ${(e?.message || String(e)).slice(0, 160)}`);
    }
  }

  // Optional Stellar leg — gated on STELLAR_BURNER_SECRET (an S… Stellar
  // secret key; fund the account with USDC — Circle trustline — plus a little
  // XLM). A dedicated client registers ONLY the Stellar scheme, so the payment
  // can only settle on a stellar:* accept — a true Stellar-rail proof with no
  // silent EVM fallback (same isolation trick as the Solana leg). Fees are
  // facilitator-sponsored per the exact-scheme spec, so the burner spends
  // USDC, not XLM. Informational: failures WARN, never page.
  await (async () => {
    const secret = (process.env.STELLAR_BURNER_SECRET || "").trim();
    if (!secret) { console.log("\nstellar leg: skipped (no STELLAR_BURNER_SECRET)"); return; }
    try {
      const [{ x402Client: StellarX402Client }, { ExactStellarScheme }, { wrapFetchWithPayment: wrapStellar }, sdk] = await Promise.all([
        import("@x402/core/client"), import("@x402/stellar/exact/client"), import("@x402/fetch"), import("@stellar/stellar-sdk"),
      ]);
      const keypair = sdk.Keypair.fromSecret(secret);
      // ExactStellarScheme wants { address, signAuthEntry } — basicNodeSigner
      // supplies the signing half, the public key is added alongside.
      const signer = { address: keypair.publicKey(), ...sdk.contract.basicNodeSigner(keypair, sdk.Networks.PUBLIC) };
      // The client-side scheme builds the Soroban transfer itself, so it needs
      // a Soroban RPC — mainnet has no default (the SDK throws without one).
      // Override with STELLAR_RPC_URL; the fallback is the free public endpoint
      // from the providers list at developers.stellar.org/docs/data/apis/rpc.
      const rpcUrl = (process.env.STELLAR_RPC_URL || "https://mainnet.sorobanrpc.com").trim();
      const stellarClient = new StellarX402Client();
      stellarClient.register("stellar:*", new ExactStellarScheme(signer, { url: rpcUrl }));
      const stellarPay = wrapStellar(synthFetch, stellarClient);
      const res = await stellarPay(`${TARGET}/api/hash`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "stellar-canary" }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 200 && typeof body.hex === "string") {
        let tx = null;
        const receiptHdr = res.headers.get("payment-response") || res.headers.get("x-payment-response");
        if (receiptHdr) {
          try { tx = JSON.parse(Buffer.from(receiptHdr, "base64").toString("utf8"))?.transaction || null; } catch { /* best-effort */ }
        }
        console.log(`\nOK    stellar    /api/hash  → settled $0.001 USDC on Stellar (payer ${keypair.publicKey()})${tx ? `\n      tx: https://stellar.expert/explorer/public/tx/${tx}` : "\n      (no settle receipt header found — settlement claimed by 200 only)"}`);
      } else if (res.status === 402) {
        const reason = settleRejectReason(res.headers);
        console.warn(`\nWARN  stellar leg did NOT settle (HTTP 402, payer ${keypair.publicKey()}) — facilitator reason: ${JSON.stringify(reason)} (missing USDC trustline/funds, facilitator outage, or stellar missing from the live accepts)`);
      } else {
        console.warn(`\nWARN  stellar leg: HTTP ${res.status} ${JSON.stringify(body).slice(0, 120)}`);
      }
    } catch (e) {
      console.warn(`\nWARN  stellar leg errored: ${(e?.message || String(e)).slice(0, 160)}`);
    }
  })();

  // Optional Algorand leg — gated on ALGORAND_BURNER_MNEMONIC (a 25-word
  // Algorand mnemonic; fund the account with USDC — ASA 31566704 — and make
  // sure it has OPTED IN to that asset, or every buy 402s even though it's
  // funded). A dedicated client registers ONLY the Algorand scheme, so the
  // payment can only settle on an algorand:* accept — a true Algorand-rail
  // proof with no silent EVM fallback (same isolation trick as the
  // Solana/Stellar legs). Fees are facilitator-sponsored per the exact-scheme
  // spec, so the burner spends USDC, not ALGO. Informational: failures WARN,
  // never page.
  await (async () => {
    const mnemonic = (process.env.ALGORAND_BURNER_MNEMONIC || "").trim();
    if (!mnemonic) { console.log("\nalgorand leg: skipped (no ALGORAND_BURNER_MNEMONIC)"); return; }
    try {
      const [{ x402Client: AvmX402Client }, { ExactAvmScheme }, { wrapFetchWithPayment: wrapAvm }, { toClientAvmSigner }, algosdk] = await Promise.all([
        import("@x402/core/client"), import("@x402/avm/exact/client"), import("@x402/fetch"), import("@x402/avm"), import("algosdk"),
      ]);
      const account = algosdk.mnemonicToSecretKey(mnemonic);
      const address = account.addr.toString();
      // toClientAvmSigner wants the base64-encoded 64-byte secret key
      // (32-byte seed + 32-byte public key) — exactly algosdk's `sk` format.
      const signer = toClientAvmSigner(Buffer.from(account.sk).toString("base64"));
      // The client-side scheme builds the transaction group itself, so it
      // needs an algod URL — mainnet AlgoNode is free and keyless.
      const algodUrl = (process.env.ALGORAND_ALGOD_URL || "https://mainnet-api.algonode.cloud").trim();
      const avmClient = new AvmX402Client();
      avmClient.register("algorand:*", new ExactAvmScheme(signer, { algodUrl }));
      const avmPay = wrapAvm(synthFetch, avmClient);
      const res = await avmPay(`${TARGET}/api/hash`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "algorand-canary" }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 200 && typeof body.hex === "string") {
        let tx = null;
        const receiptHdr = res.headers.get("payment-response") || res.headers.get("x-payment-response");
        if (receiptHdr) {
          try { tx = JSON.parse(Buffer.from(receiptHdr, "base64").toString("utf8"))?.transaction || null; } catch { /* best-effort */ }
        }
        console.log(`\nOK    algorand   /api/hash  → settled $0.001 USDC on Algorand (payer ${address})${tx ? `\n      tx: https://allo.info/tx/${tx}` : "\n      (no settle receipt header found — settlement claimed by 200 only)"}`);
      } else if (res.status === 402) {
        const reason = settleRejectReason(res.headers);
        console.warn(`\nWARN  algorand leg did NOT settle (HTTP 402, payer ${address}) — facilitator reason: ${JSON.stringify(reason)} (unfunded or not-opted-in USDC burner, facilitator outage, or algorand missing from the live accepts)`);
      } else {
        console.warn(`\nWARN  algorand leg: HTTP ${res.status} ${JSON.stringify(body).slice(0, 120)}`);
      }
    } catch (e) {
      console.warn(`\nWARN  algorand leg errored: ${(e?.message || String(e)).slice(0, 160)}`);
    }
  })();

  // Prompt-cache leg — pays once with cache:true, then repeats the IDENTICAL
  // request unpaid: the pre-paywall cache must answer 200 + X-Cache: hit with
  // the same response object. Real-money proof that opted-in repeats are
  // free. Informational: failures WARN, never page.
  await (async () => {
    try {
      const init = {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "deepseek/deepseek-chat", messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 5, cache: true }),
      };
      const paid = await payOnceWithRetryOn5xx(`${TARGET}/v1/nano/chat/completions`, init);
      const paidBody = await paid.json().catch(() => ({}));
      if (paid.status !== 200 || typeof paidBody.choices?.[0]?.message?.content !== "string") {
        console.warn(`\nWARN  prompt-cache leg: priming buy failed — HTTP ${paid.status} ${JSON.stringify(paidBody).slice(0, 100)}`);
        return;
      }
      const free = await synthFetch(`${TARGET}/v1/nano/chat/completions`, init); // NO payment wrapper — must not need one
      const freeBody = await free.json().catch(() => ({}));
      if (free.status === 200 && free.headers.get("x-cache") === "hit" && freeBody.id === paidBody.id) {
        console.log(`\nOK    prompt-cache /v1/nano/chat/completions  → paid once ($0.003), identical repeat served FREE (X-Cache: hit)`);
      } else {
        console.warn(`\nWARN  prompt-cache leg: repeat was NOT a free hit — HTTP ${free.status}, X-Cache=${free.headers.get("x-cache")}, sameId=${freeBody.id === paidBody.id}`);
      }
    } catch (e) {
      console.warn(`\nWARN  prompt-cache leg errored: ${(e?.message || String(e)).slice(0, 140)}`);
    }
  })();

  // Embeddings cache — DEFAULT-ON (no cache flag anywhere): the llm-embed leg
  // above already paid for this exact body, so an unpaid identical repeat must
  // come back 200 + X-Cache: hit with the same response object. This is the
  // billing-relevant promise in the tool description — prove it daily.
  await (async () => {
    try {
      const init = {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: EMBED_CANARY_INPUT, model: "text-embedding-3-small" }),
      };
      const free = await synthFetch(`${TARGET}/v1/embeddings`, init); // NO payment wrapper — must not need one
      const freeBody = await free.json().catch(() => ({}));
      if (free.status === 200 && free.headers.get("x-cache") === "hit" && Array.isArray(freeBody.data?.[0]?.embedding)) {
        console.log(`\nOK    embed-cache /v1/embeddings  → paid once ($0.002), identical repeat served FREE (X-Cache: hit, default-on)`);
      } else {
        console.warn(`\nWARN  embed-cache leg: repeat was NOT a free hit — HTTP ${free.status}, X-Cache=${free.headers.get("x-cache")}`);
      }
    } catch (e) {
      console.warn(`\nWARN  embed-cache leg errored: ${(e?.message || String(e)).slice(0, 140)}`);
    }
  })();

  const decision = decideCanary(results);
  const spentUsd = decision.rows.filter((r) => r.cls === "settled").reduce((s, r) => s + (r.priceUsd || 0), 0);
  console.log(`\npayer ${account.address}`);
  console.log(`tools: ${decision.settled} settled, ${results.length - decision.settled} not | spent ~$${spentUsd.toFixed(3)} USDC on Base`);
  if (decision.warnings.length) console.warn(`\nwarnings (non-blocking — upstream/data, not payments):\n  ${decision.warnings.join("\n  ")}`);

  if (decision.broken) {
    console.error(`\nPAID CANARY FAILED — buying looks broken:\n  ${decision.reasons.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`\npaid-canary OK — buying works (${decision.settled}/${results.length} settled${decision.warnings.length ? `; ${decision.warnings.length} upstream warning(s)` : ""}).`);
  process.exit(0);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
