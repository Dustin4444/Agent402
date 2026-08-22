# Agent402.Tools — project memory for Claude Code

Agent402.Tools is an **open-source, self-hostable x402 + MCP server**: 500+ deterministic
web tools an AI agent can call and pay for per request (USDC on Base via the x402
protocol, or free via proof-of-work). It's two-sided — it also ships
`agent402-tollbooth` (pay-per-crawl for site owners) and `agent402-client` (a buyer SDK).
Hosted at https://agent402.tools. Maintained by Havok Holdings LLC (the operating entity — use it, never a personal name, anywhere a maintainer is credited).

> This file is technical project memory. Do **not** put conversation content,
> personal info, secrets, or marketing/strategy in any committed file. Private
> context goes in `CLAUDE.local.md` (gitignored).

## Repository map
- `src/server.js` — Express app. Builds `CATALOG` (route → tool def), mounts free
  routes, the x402 paywall + proof-of-work gate, the stats tally, and all tool routes.
- `src/tools/` — the tool kits (kit, kit2, convert-gen, search, pdf-kit, demand-kit,
  media-kit, gov-kit, agent-kit, barcode-kit, data-kit, image-kit, x402-kit, util-kit,
  memory). Add tools here.
- `src/payments.js` — x402 v2 middleware (USDC on Base/Polygon/Arbitrum, CDP facilitator, Bazaar discovery).
- `src/pow.js` — proof-of-work tier (signed, single-use, slug-scoped). `WALLET_ONLY_SLUGS` = non-PoW tools.
- `src/mcp-http.js` — hosted MCP connector (`/mcp`): tools are DOTTED since the Smithery-naming commit `8aefdd89`
  (`catalog.search`, `catalog.find`, `catalog.call`, `payment.info`, `server.describe`, `sellers.list`, `demand.request`,
  plus flagship aliases `web.search`/`web.answer`/`web.news`/`browser.render`/`market.quote`/`audio.transcribe`/
  `memory.read`/`memory.write`); the old snake names (`search_tools`, `find_tool`, `call_tool`, `about_agent402`,
  `describe_server`, `list_top_sellers`, `request_tool`) remain CallTool ALIASES only, not listed.
  **Native MPP on /mcp (2026-08-19, `src/mcp-mpp.js`):** a wallet-only tool called on the connector is payable
  there - mppx's MCP wire (JSON-RPC error `-32042` + `data.challenges`; credential in
  `_meta["org.paymentauth/credential"]`; receipt in `_meta["org.paymentauth/receipt"]`). Settlement authority is
  UNCHANGED: the call is replayed as a LOOPBACK HTTP request to our own paid route (127.0.0.1:PORT, buyer IP on
  X-Forwarded-For) with `Authorization: Payment <credential>`, the real gates verify+settle, and only the wire
  shapes are translated (402 -> -32042 with that 402's fresh challenges + its RFC 9457 body as `problem`; 200 +
  Payment-Receipt -> result + receipt meta; other statuses -> isError "not charged"). Rollout switch =
  MPP_SECRET_KEY (no gates, no challenges -> the old paid-access text). `scripts/test-mcp-mpp.js` (14, boots
  the real server, stock SDK client + `McpClient.wrap`, stub facilitator sees exactly one verify + one settle).
- `src/find.js` — `/api/find` tool resolver (lexical ranking; also used by the `find_tool` MCP tool).
- `src/discovery.js` — `/.well-known/x402` service manifest + `/api/reliability` report.
- `src/stats.js`, `src/seo.js`, `src/landing.js`, `src/pages.js`, `src/guides.js`, `src/privacy.js`, `src/terms.js`.
- `scripts/` — tests + ops (revenue-scan, paid-canary, demo-payment, etc.).
- `mcp/` — `agent402-mcp` npm package (stdio MCP server). `tollbooth/` — `agent402-tollbooth` package. `client/` — `agent402-client` SDK.
- `wiki/` — source for the GitHub wiki (CI-synced). `docs/` — ecosystem-listing copy.

## Conventions
- A tool is an object: `{ route, name, slug, category, price, description, tags, discovery:{inputSchema, input/example}, handler }`. `handler(input)` returns JSON or throws `Error` with `.statusCode`.
- **Deterministic only — no LLM in the serving path.** Every tool is covered by the
  "answers its own example" CI check (`scripts/test-all.js`).
- Pure-CPU tools are PoW-eligible (free tier) automatically unless in `WALLET_ONLY_SLUGS`.
- **Catalog floor: 400 entries, CI-checked by `sync-count.js --check`** (counts derive live from the booted server, never from a doc). No upper bound — additions must meet the bar: answers its own example, priced to market, live-verified.
- **Counts on marketing/static surfaces are evergreen — “500+ tools”, never an exact number** (README, wiki, docs, adapters, package descriptions, served-page copy). Adding tools requires NO doc sweep. `node scripts/sync-count.js` (and `--check` in CI) verifies, live from the booted server: the 400-entry floor, that the “500+” claim is honest (total ≥ 500), and that the README H1 still carries “500+ tools”. The old repo-wide numeric rewrite is RETIRED (it once corrupted HTTP 500s/font-weights/prices — see sync-count.js header); never reintroduce it. Runtime surfaces (`/api/pricing`, `/openapi.json`, `/health`, `docs.js`) derive the exact count — leave those exact.
- Memory tools (`/api/memory*`) are wallet-keyed (payment = identity), routed via `memHandler`, and must be in `WALLET_ONLY_SLUGS`. Per-namespace
  quotas: 10k keys (`MEMORY_MAX_NS_KEYS`, call-time read, default 10000) AND a 32MB
  total-value byte budget (`MEMORY_MAX_NS_BYTES`, call-time read); both return **413** when
  full — the byte budget is the disk-fill guard for the shared /data volume.

## Key machine-readable surfaces (free, unpaywalled)
`/health`, `/api/pricing`, `/openapi.json`, `/llms.txt`, `/.well-known/x402`,
`/api/reliability`, `/api/find?q=<task>`, `/api/stats`, `/robots.txt`, `/sitemap.xml`,
`/.well-known/glama.json` (maintainer email from `GLAMA_MAINTAINER_EMAIL` env),
`/api/gateway-status` (bucketed OpenRouter-balance status — "ok"/"low"/"unknown"/
"unconfigured", numbers never exposed, 5-min cache; heartbeat opens a "Gateway
credits LOW" issue on "low" — threshold `OPENROUTER_LOW_CREDITS_USD`, default $5,
because /v1 settles before the handler and an empty balance = charged-but-failed; response also carries `upstreamBuyer` — the x402 spending wallet's bucketed status, heartbeat opens "Upstream buyer wallet LOW (x402)" on low, threshold `UPSTREAM_BUYER_LOW_USD` default $0.50).

## Dev / CI / deploy workflow
- **Develop on branch `claude/sweet-brown-i99jl3`.** `main` is protected (PR required, no force-push).
- CI (`.github/workflows/deploy.yml`) triggers on push to the dev branch OR to `main`. Jobs gate
  on **commit-message markers** - no `.github/trigger-*` file needs touching (that path filter
  was removed 2026-08-11; it can't be scoped per-branch in one `push:` block, and it made `main`
  effectively un-triggerable since a PR merge commit never touches one):
  - `[test]` → full test job · `[deploy]` → Railway deploy · `[publish]` → npm + MCP Registry
  - `[probe]` → live prod probe · `[paytest]`/`[drain]`/`[purl]`
  - **A push to `main` tests + deploys unconditionally, no marker required.** A PR merge commit
    (usually just the PR title) never carries our marker convention, so `main` can't be
    marker-gated the way the dev branch is - merging to main already means "this should be
    live." Closes a real class of bug (found 2026-08-11): five PRs, one an external contributor's,
    three from throwaway Cursor branches, merged clean, passed CI, and sat undeployed for hours
    because nothing separately pushed the dev branch afterward. One was a duplicate-seller bug
    the same contributor found live in production after their own fix had already merged.
  - `.github/trigger-tool-alert`, `-charged-alert`, `-heartbeat`, `-announce`, `-b20check`,
    `-x-verify`, `-self-consistency-alert` are unrelated to deploy.yml - each still gates its
    own dedicated workflow's path filter, untouched by the above.
- **Flow:** commit to the dev branch (with markers) → push → open a **draft PR** → CI runs →
  merge to `main` (deploys on its own now, whether or not the dev branch was ever synced). The
  `create_pull_request` tool auto-appends a session-link footer; **strip it** via
  `update_pull_request` before/after creating (no session links in PR bodies/commits).
- **Heartbeat** (`heartbeat.yml`) probes prod every 15 min and opens a "production DOWN" issue on
  failure; a daily paid canary buys a $0.001 tool. No open issues = prod healthy. Also
  watches the **PayAI settlement quota** (PayAI is PRIMARY for Solana/Polygon/Arbitrum/
  Avalanche, free tier 10k settles/month): rolling 30-day on-chain count from
  `/api/revenue/daily`, opens "PayAI settlement quota HIGH" at `PAYAI_QUOTA_WARN`
  (repo var, default 8000). Unreadable data logs a loud warning, never a silent skip.

## Testing (run locally)
- Boot free mode: `FREE_MODE=true PORT=3000 node src/server.js` then `TARGET_URL=http://localhost:3000 node scripts/test-all.js` (every tool answers its example) and `scripts/test-mcp-all.js`.
- Paid-mode tests boot their own server (PoW path): `scripts/test-idempotency.js`, `client/test.js`.
- Unit/offline: `scripts/test-memory.js`, `test-find.js`, `test-revenue-scan.js`, `test-util-kit.js`, `test-discovery.js`, `tollbooth/test.js`+`edge.test.js`+`features.test.js`.
- Raise the MCP free-tier limit for sweeps: `AGENT402_MCP_MAX_PER_MIN=999999 AGENT402_MCP_MAX_PER_HOUR=9999999`.

## x402 settlement ordering (CRITICAL — get this right)
The installed **`@x402/express` v2.16 runs the handler FIRST, then settles**, and
ONLY settles a `<400` response — for any handler `statusCode >= 400` it CANCELS
settlement (`reason: "handler_failed"`) so the buyer is **NOT charged**; if
settlement of a `<400` response fails, it discards the buffered body and returns a
402. So: **a 4xx/5xx (incl. a capacity 503 or an upstream 502) is never charged**,
and a 200 is only charged if settlement then succeeds. Do NOT assume "settles
before the handler" (an earlier, wrong belief that produced the F13 free-render
bypass and the pre-settlement idempotency cache — both since fixed). Anything that
caches, credits, or bills based on handler status BEFORE settlement is unsafe;
key such logic off the FINAL (post-settlement) response, e.g. `res.on("finish")`
with `res.statusCode === 200`. (`node_modules/@x402/express/dist/esm/index.mjs`.)

## Notable features (current)
- **Idempotency:** opt-in `Idempotency-Key` header; cache key = `sha256(METHOD /path + key + gate-credential)`. **x402 `payment-identifier` (2026-08-19):** declared on every route's 402 (`declarePaymentIdentifierExtension(false)`, payments.js) and honoured as an ALIAS of the header (`paymentIdentifierOf(req)` in payer.js, header wins) under the SAME binding rules - exact credential + route + body - never a cross-authorization dedupe (the id is client-chosen text on a payload unverified at that point in the chain). Pinned in test-mpp-shim (declared on the 402; exact retry replays with one settle; same id on a new credential settles again). **Settlement-aware (FR4-01):** the body is captured at `res.json` but COMMITTED to the cache only on `res.on("finish")` when the FINAL `statusCode === 200` — i.e. after `@x402/express` has settled — so an unsettled 200 (settlement-failure → 402) is never cached/replayed. No-op without the header; streamed responses are never replayable. `scripts/test-idempotency-settlement.js`.
- **Tollbooth:** charge modes (`bots`/`all`/`strict`), adaptive PoW, analytics (`gate.stats()` + `/__tollbooth/stats` + `/__tollbooth` dashboard), deploy templates (Cloudflare/Next.js/Docker). Defaults preserve original behavior.
  **0.9.0 (2026-08-19, build #13): native MPP on TEMPO + split payments.** `createTollbooth({ tempo: { apiKey,
  recipient, currency|currencies, splits:[{recipient, amount}], chainId, apiBaseUrl } })` (env
  `TOLLBOOTH_TEMPO_API_KEY`/`_RECIPIENT`/`_CURRENCY`/`_SPLITS`) - `tollbooth/tempo.js`, dependency-free like
  mpp.js: mints tempo/charge challenges with the same HMAC id binding (mppx Challenge.verify agrees), wire
  request byte-for-byte mppx's schema output (base-units amount, NO decimals, `methodDetails.chainId`,
  `methodDetails.splits` in base units, ≤10, total < price - a bad split never mints), speaks Tempo's relay
  over plain fetch (`/v1/mpp/validate` before the handler, `/v1/mpp/broadcast` after a <400 response with
  `idempotency-key`, `tempo-api-key` header), buffers the handler's response (writeHead/write/end/
  flushHeaders) exactly like the main app's tempo gate, replays with `Payment-Receipt` +
  `X-Tollbooth-Paid: mpp-tempo`, counts `tempoPaid`; refused credentials get the gate 402 + fresh
  challenges + RFC 9457 `problem`; single-use via the operator's `replayStore` (`tempo:<id>`) or an
  in-process map; works with NO x402 middleware (Tempo-only tollbooths). `tollbooth/tempo.test.js` (31,
  in CI). Published 2026-08-19 via `[publish]`. **LIVE-PROVEN 2026-08-19 (0.9.1):** `tollbooth-tempo-live.yml`
  (dispatch; `TEMPO_API_KEY` is an Actions secret since 2026-08-19) boots a tollbooth on the REAL relay and
  pays it $0.001 from the canary burner - run 32302253442: 200 + `X-Tollbooth-Paid: mpp-tempo` +
  Payment-Receipt, tx `0x9ec426902345790c3d07cbcf32831e702648907e43ebed5c21077677101c3728`, `tempoPaid:1`.
  The FIRST live run (0.9.0) failed and found what the stub relay could not: `relayInput` forwarded the
  wire challenge with `request` as the base64url STRING, while mppx hands the relay the DESERIALIZED
  credential (`request` = decoded object, Relay.js `toRelayInput`) - the real relay refused every
  credential. 0.9.1 decodes it and `tollbooth/tempo.test.js` pins the relay wire shape (34). Lesson
  (same as the main gate's two wire drifts): a stub relay that accepts anything proves nothing about the
  wire; the live dispatch is the proof, and it prints the 402 `problem` + `X-Tollbooth-Error` on failure.
  **0.9.2 (2026-08-20): chain-truth confirm on broadcast failure** — same fix as the main gate's
  `src/tempo-confirm.js` (relay reports failure for a SETTLED payment when a buyer's yParity-style v byte
  is normalized by the node), dependency-free: keccak-256 implemented in-package (BigInt lanes, pinned
  against standard vectors + the live incident tx), candidates = submitted bytes + v-swapped twin, receipt
  must succeed and pay the challenge currency/recipient/>=amount, fails closed to the 402. `confirm:false`
  disables; `confirmRpcUrl`/`TOLLBOOTH_TEMPO_RPC_URL` overrides the RPC; `confirmSettlement` injectable.
  `tollbooth/tempo.test.js` (55).
  **0.7.0 (2026-08-18): `x402:` middleware mode + MPP.** `createTollbooth({ x402: paymentMiddleware })` delegates paid requests to the operator's @x402/express middleware with the REAL response (verify -> handler -> settle in its own order), lifts its PAYMENT-REQUIRED onto the gate's 402 (stock x402 v2 clients can pay), and - default on - mints `WWW-Authenticate: Payment` evm/charge challenges from it and translates `Authorization: Payment` -> PAYMENT-SIGNATURE (`tollbooth/mpp.js`, dependency-free codec, HMAC id binding compatible with mppx's `Challenge.verify`), mirroring `Payment-Receipt` on settle. **`x402VerifierFromExpress` is deprecated: with @x402/express v2 (settle AFTER handler) it granted on verify and never settled - served, never charged - because it handed the middleware a stub response the real handler never ended; measured in `scripts/test-tollbooth-mpp.js` (32 assertions: real @x402/express + stub facilitator, real mppx client buys, real @x402/fetch buys, settle counted once each, tampered credential, PoW-first).** Edge gate: PoW + legacy verify only for now.
- **Buyer SDK (`agent402-client`):** `find()` + `call()` with auto-payment (PoW free / x402 paid), caching, idempotent retries, non-custodial.
- **LLM gateway (`src/tools/llm-gateway-kit.js`, OpenAI wire paths):** five tiers —
  nano `$0.003 /v1/nano/…`, **auto `$0.01 /v1/auto/…`** (model optional: deterministic
  eval-ranked routing via `AUTO_RANKINGS[quality][category]` + `classifyPrompt` —
  code/reasoning/long/general × quality bands fast/balanced/best (`quality` knob,
  price-neutral, 400s alongside an explicit model); ranking doubles as the failover chain;
  response adds `agent402_router {category, quality, served}`; tier listed LAST in `TIERS`
  so `tierFor()` ordering is stable), base `$0.02`, pro `$0.10`, premium `$0.50`,
  plus **`/v1/embeddings` `$0.002`** (OpenAI upstream, batch ≤64/16k chars, cache
  DEFAULT-ON — deterministic output; `cache:false` opts out; `embeddingsCacheKey`),
  plus **`/v1/rerank` `$0.002`** (`v1-rerank`, 2026-08-19 build #12 part 1 — Cohere wire
  `{query, documents[], top_n}` over OpenRouter `/rerank`, model locked `cohere/rerank-v3.5`;
  live: 1 search unit = $0.001; caps ≤50 docs × ≤1,600 chars, ≤40k total, query ≤500 chars keep
  every call at ONE search unit so $0.001 sits under the 70% bound with no token math; strings
  only (structured {text,image} docs bill differently → 400); cache DEFAULT-ON (`rerankCacheKey`,
  deterministic ranker); billing fields stripped, `search_units` kept; `gateway_usage` tier
  `v1-rerank`; paid-canary `llm-rerank` leg),
  plus the **Anthropic Messages wire on all five tiers** (`src/tools/llm-messages-kit.js`, build #12
  part 2 — `POST /v1/nano/messages` `$0.003`, `/v1/auto/messages` `$0.01`, `/v1/messages` `$0.02`,
  `/v1/pro/messages` `$0.10`, `/v1/premium/messages` `$0.50`; slugs `<tier>-messages`; same TIERS
  config = same allowlist/caps/max_price/flex/failover as the chat route; OpenRouter `/api/v1/messages`
  serves ANY model through this wire (live-verified gemini + claude); Anthropic body validated
  (system, content blocks text/image/tool_use/tool_result/thinking, client tools with input_schema
  only — server tools refused, thinking {enabled budget|adaptive|disabled}, stop_sequences, top_k);
  margin clamp runs on a PROBE copy with base64 images replaced by a marker (billed flat); usage
  cost/is_byok/cost_details stripped non-stream, SSE `message_delta` frame scrubbed by the shared
  scrubber; `stop_reason:max_tokens` + nothing said walks the chain (`isEmptyMaxTokens`);
  telemetry tier `<tier>:messages`; auto tier adds `agent402_router`; NOT on this wire: the opt-in
  prompt cache and reasoning-effort defaults (buyer sets `thinking` natively). Canary `llm-messages`
  leg. `scripts/test-llm-messages.js` (41)),
  plus the **OpenAI Responses wire on all five tiers** (`src/tools/llm-responses-kit.js`, build #12
  part 3 — `POST /v1/{nano,auto,pro,premium}/responses` + `/v1/responses`, slugs `<tier>-responses`,
  same TIERS config; OpenRouter `/api/v1/responses` (any model; live-verified gpt-4o-mini, gpt-5-nano,
  claude); `input` string or items (message with input_text/input_image parts, function_call,
  function_call_output, reasoning), `instructions`, `max_output_tokens` (default/clamp like the chat
  wire), function tools ONLY (web_search*/file_search/computer/mcp/code_interpreter/image_generation
  refused), `text.format` (json_schema/json_object → `provider.require_parameters`), buyer `reasoning`
  validated + the chat wire's default effort injection (`defaultReasoningFor`), `store` forced false,
  `previous_response_id`/`background` refused (no server state), `input_file` refused (metered parse);
  `status:incomplete` for max_output_tokens + nothing said walks the chain (`isEmptyIncomplete`);
  usage billing stripped non-stream, and the stream's NESTED `response.usage` scrubbed - the shared
  SSE scrubber now strips `obj.usage`, `obj.response.usage` and `obj.message.usage` (the top-level-only
  scrub would have leaked cost on every streamed Responses call). Telemetry `<tier>:responses`; canary
  `llm-responses` leg; `scripts/test-llm-responses.js` (26)),
  plus the **grounded tier** (build #12 part 4 — `POST /v1/grounded/chat/completions` `$0.03`,
  `v1-chat-grounded`: the auto router + OpenRouter's `web` plugin (Exa, `max_results` 5) on every
  call, answers carry OpenAI-wire `annotations` url_citation; search is billed per REQUEST on top of
  tokens (measured: Exa auto $0.007 in `usage.cost`, ~700 injected prompt tokens/result) so the
  tier carries `fixedUpstreamUsd: 0.007` + `extraInputTokens: 4500`, both folded into
  `worstCaseUpstreamCost`/`clampToMargin` (largest call on the priciest ranked model ≈ $0.015 vs the
  $0.021 bound); `noCache: true` (promptCacheKey null, no deferred write - the web moves); web +
  response-healing plugins merge; `:online` stays refused everywhere else (this tier is the
  sanctioned home); listed LAST in TIERS so tierFor() keeps resolving explicit models to their
  home tiers; canary `llm-grounded` leg. Build #12 is COMPLETE: rerank, Messages, Responses,
  grounded),
  plus **`/v1/images/generations` `$0.08`** (`v1-images` — OpenAI images wire translated
  to OpenRouter chat `modalities:["image","text"]`, model locked `google/gemini-2.5-flash-image`,
  n locked 1, `IMAGES_MAX_TOKENS` 1600 + `IMAGES_MAX_PRICE` provider bound, data-URI →
  `b64_json`, no cache/stream, imageless upstream → 502),
  plus **`/v1/audio/speech` `$0.06`** (`v1-audio-speech` — OpenAI TTS wire on
  OpenRouter's audio API. OpenRouter has NO OpenAI TTS models (their docs still say
  otherwise — burned us 2026-07-09); serves a FIVE-model failover chain instead
  (`SPEECH_MODELS`: Voxtral Mini TTS → Grok Voice → Kokoro-82M →
  MAI-Voice-2-Flash → MAI-Voice-2 (Zonos removed 2026-08-19: zero endpoints upstream), all proven by real buys via the dispatchable
  `.github/workflows/openrouter-tts-probe.yml`, which probes the live
  `?output_modalities=speech` list — never hardcoded ids; latest full sweep run
  30971572514, 2026-08-05, which also proved the -Flash link before it entered).
  Chain walks on ANY
  upstream failure incl. empty audio — payment settles pre-handler, so a provider
  outage must never be the buyer's 502. OpenAI voice names map per-model; native ids
  (e.g. `en_paul_cheerful`) accepted, listed per model on `/v1/models`. 2k-char cap;
  TTS bills per INPUT char so worst-case/link is deterministic ($0.032 Voxtral … $0.044
  MAI, all under price). `instructions` rejected (self-explaining 400 — no serving model
  supports it); `speed` 0.25–4 accepted (cost-neutral, ignored by most). Raw mp3/pcm
  bytes via the route binder's `{__binary, contentType}` sentinel — no cache/usage
  accounting on binary. Listing gated on `OPENROUTER_TTS_ENABLED=true`
  (server.js `GATEWAY_TOOLS_ENABLED`) as the rollout switch — ON in prod since
  2026-07-16; canary llm-speech leg settles green). Upstream OpenRouter (`OPENROUTER_API_KEY`, 503 when unset). Failover walks
  the chain on upstream 502/503/504 only — every chain ends in the canary-proven model.
  **Streaming** (`stream:true`): handler returns `{__sse}` sentinel, route binder pipes SSE
  after settlement. **Prompt cache** (`cache:true`, opt-in): byte-identical repeat served
  free pre-paywall within 10 min (`X-Cache: hit`); keys on the tier + normalized body
  (resolved model included). **Margin protection (two layers, both in `validateRequest`):**
  (1) per-tier `maxPrice` rides upstream as `provider.max_price` on every call — buyer-supplied
  `provider` can never loosen it; (2) margin clamp — exact-BPE (`gpt-tokenizer` o200k, static
  import: must stay sync for `promptCacheKey`) prices the FULL outbound body (incl. tools
  schemas, images flat 1600 tok, `n`≤4 multiplier) against `MODEL_COST` (longest-prefix,
  elementwise-min'd with `maxPrice`), then shrinks `max_tokens` so worst-case upstream ≤ 70%
  of tier price; input alone over budget → self-explaining 400. Deterministic → cache-key
  safe; cheap models never feel it. **Margin telemetry:** non-stream calls ride
  `usage:{include:true}` to OpenRouter (call-time inject, never in cache keys); exact
  upstream cost → PostHog `gateway_usage` event (price/upstream/margin/tokens), then
  `cost`/`cost_details`/`is_byok` are STRIPPED before the response is cached or returned
  (never leak the bill to buyers; posthog.js loaded lazily in the handler). **Streams
  too (2026-08-19):** OpenRouter now puts full usage incl. `cost` in the final SSE frame with NO
  opt-in (`usage.include` is a documented no-op), and the stream path piped raw bytes, so every
  streaming buyer saw our upstream bill - verified live with a nano stream. `createSseUsageScrubber`
  strips the billing fields in flight (line-aware, partial lines buffered across chunks) and hands
  the cost to the same PostHog event, so streams carry margin telemetry now. **`user` field:**
  every upstream call carries `user: a402:<sha256(payer or gate credential)>` (`upstreamUserId`) -
  OpenRouter scopes provider policy blocks to it; without it one abusive buyer could get the whole
  account blocked. Call-time injection, never in cache keys. **Variants:** `:online` (per-request
  web-search billing outside max_price) and `:batch` (async) are refused with self-explaining 400s;
  routing-only `:nitro`/`:floor` still pass. **Live-catalog guard:** `scripts/test-gateway-model-ids.js`
  (CI, network) fails on any advertised/ranked/fallback/TTS id missing upstream, any MODEL_COST
  entry under a live admitted price inside the tier's max_price, or a ranked model expiring within
  14 days - it found 5 dead advertised ids, the dead Zonos TTS link, and 9 underpriced MODEL_COST
  rows on its first run (all fixed the same day). **Balance alarm (`gatewayCreditsStatus`) reads
  TWO ceilings:** `/credits` (balance, low-water `OPENROUTER_LOW_CREDITS_USD` default $15) and
  `/key` `limit_remaining` (the prod key's own monthly USD limit, $250/month set 2026-08-19;
  low under `OPENROUTER_LOW_KEY_LIMIT_FRACTION` 0.25); either low → "low"; "ok" needs the balance
  leg readable; otherwise "unknown" with `unknownForMinutes`, and heartbeat opens "Gateway balance
  UNREADABLE (OpenRouter)" after 180 min of unknown (a balance we cannot read is its own alarm).
  **Flex-first (2026-08-19, `FLEX_MODELS` + `flexAttempts`):** every chain link in the live-verified
  flex table (gemini-2.5/3.x families, gpt-5-nano, gpt-5.6-*; `/v1/images/generations` too) is
  tried with `service_tier:"flex"` (OpenRouter's 50% tier, higher latency, never falls back on
  its own) and then the SAME model on the default tier before the chain advances; an empty
  refusal on flex skips the default retry (it would refuse too). Measured: the image model's
  flex endpoints are exactly half price on every unit, and images were ~99% of the upstream
  bill (68 of 528 calls, $2.63 of $2.67, 07-19..08-18; ~44% of that was the daily canary's
  own image leg, which now rides flex automatically). `gateway_usage.serviceTier` records which
  tier served. `OPENROUTER_FLEX=off` disables. The live guard fails CI if a FLEX_MODELS entry
  loses its `*/flex` endpoint (flex on a model without one 404s = a wasted attempt per call).
  **Prompt-cache levers (2026-08-19):** every chat call carries top-level `cache_control:{type:"ephemeral"}`
  (default on; buyer `cache_control:false` disables; `ttl:"1h"` refused - 2x Anthropic write cost) and
  `session_id` = the per-buyer `user` id (OpenRouter sticky provider routing, so implicit caches on
  OpenAI/Gemini/DeepSeek/Grok and Anthropic's explicit cache actually hit). Call-time only, never in the
  cache key. The margin clamp prices Anthropic input at 1.25x (`cacheWriteFactor`: a first-seen long
  prompt is a cache WRITE) so the bound stays honest; reads bill 0.1x. `usage.cache_discount` is stripped
  with the other billing fields (non-stream + SSE scrubber). `provider.sort:"price"` rides on the BUDGET
  tiers only (nano + auto, `priceSort: true`): on the same model sort-by-price can land on a quantized
  provider - a buyer-visible quality change pro/premium did not buy, and max_price already bounds them.
  `OPENROUTER_PROVIDER_SORT=off` disables. All four fields live-verified accepted by OpenRouter on
  Gemini/DeepSeek/OpenAI/Anthropic before shipping.
  **Reasoning defaults + wire compat (2026-08-19, build #5):** `REASONING_MODELS` (prefix ->
  supported efforts; live-guarded) + `defaultReasoningFor(model, tier)`: when the buyer sent no
  `reasoning`/`reasoning_effort`, a default-on/mandatory reasoning link gets `reasoning.effort` =
  lowest non-"none" effort on nano/auto/base (`reasoningDefault:"lowest"`), "low" on pro, the
  model default on premium. Measured: gpt-5-nano at max_tokens 64 AND 256 with default/low effort
  returned `finish_reason:length` + EMPTY content (paid empty answer); minimal answered. Buyer
  `reasoning` objects are validated (effort set, max_tokens <= tier cap, exclude/enabled bools)
  and live in the normalized body (cache key); `max_completion_tokens` is honoured as the cap
  alias. `isEmptyLength` (length + nothing said) walks the chain like an empty refusal (same
  model's default-tier retry skipped), end-to-end empty -> 502. `response_format` json_schema /
  json_object adds `provider.require_parameters:true` and, off-stream, `plugins:[{id:
  "response-healing"}]` (live-verified: accepted, no cost change; buyer `plugins` never pass).
  **zdr knob:** `zdr:true` (or
  `provider.zdr`) is the ONLY buyer-settable provider field — folds into the server-owned
  provider prefs next to `max_price`, lives in the normalized body (distinct cache entries),
  stripped from the top-level outbound body. All tiers in `WALLET_ONLY_SLUGS` and
  test-all's lenient NETWORK set.
- **Route-and-execute (`POST /api/route/execute`, $0.01, `src/tools/route-execute.js`):**
  resolves a task/slug via `findTools`, dispatches the underlying internal tool (underlying
  price cap $0.005), returns `{result, receipt}`; underlying errors pass through.
  **External settlement is CHAIN-MATCHED (2026-07-23):** the buyer's payment network picks
  the spending wallet — `eip155:8453` → Base (X402_UPSTREAM_BUYER_KEY, the proven path),
  Algorand mainnet CAIP-2 → the AVM spending wallet (`ALGORAND_UPSTREAM_BUYER_MNEMONIC`,
  env-gated: without it Algorand buyers get a 409 naming supported chains and are never
  charged). Algorand candidate discovery + proven-ness both come from the GoPlausible
  facilitator catalog (`src/algorand-sellers.js`: /discovery/merchants × /discovery/resources
  → origin-keyed verifications, 30-min stale-while-revalidate cache, https-only hygiene
  filter; same `SOR_MIN_SETTLED_TX` threshold, same live 402-probe + payX402 margin guard
  before any spend). AVM buys sign 1000-round validity (the image-gen-premium dead-txn
  lesson). `scripts/test-algorand-router.js` (offline, in CI).
  **MPP sellers on Tempo (2026-08-18, `src/tempo-sellers.js` + `src/tempo-buyer.js`):** a
  third external chain, `tempo`. Candidates = OUR live-verified MPP index (mpp.dev
  registry, probed) flattened to routable resources: tempo/charge in **USDC.e only**
  (`0x20C0…8b50` — 138/141 registry sellers and mppx's mainnet default; PathUSD is
  mppx's TESTNET default), static integer prices only, no path templates. Pay =
  `payTempo`: bare request → live 402 → asset pin + chain 4217 + live amount ≤ cap →
  **proven-seller gate** (recent inbound USDC.e transfers to the challenge's recipient
  via `rpc.tempo.xyz` eth_getLogs, 99k-block window ≈15h, `SOR_TEMPO_MIN_SETTLED_TX`
  default 20, fails CLOSED on RPC error; measured: Firecrawl 4,184 / Exa 2,129 vs 0
  for two others) → mppx `tempo.charge` credential from the DEDICATED Tempo spending
  wallet `TEMPO_UPSTREAM_BUYER_KEY` (EVM key; may be the same address as the Base
  spending wallet, funded separately with USDC on Tempo; NEVER treasury/canary) → retry
  with `Authorization: Payment` → relay result + `Payment-Receipt` reference (`wire:
  "mpp"` on the router receipt). Inbound mapping: an MPP/tempo buyer (the tempo gate
  sets `req.mppTempoCredential` before the handler; `buyerPaymentNetwork` reads it as
  `eip155:4217`) routes to Tempo sellers (chain-matched); Base buyers fall through to
  Tempo sellers only when `SOR_TEMPO_FROM_BASE=true` (Base revenue funding Tempo spend
  is a treasury-float decision). `/api/gateway-status.upstreamBuyerTempo` + heartbeat
  "Tempo upstream buyer wallet LOW (MPP)". `scripts/test-tempo-router.js` (32
  assertions, offline, in CI). Seller-side counterpart: `TEMPO_CURRENCY` is a CSV (one
  tempo challenge per currency, first = preferred; a stock mppx client pays the FIRST
  tempo challenge and does not auto-swap by default), code default still PathUSD; **PROD
  FLIPPED 2026-08-18: Railway `TEMPO_CURRENCY=usdc,pathusd`** (live 402 offers USDC.e then
  PathUSD) and PROVEN the same day: tempo-canary run 32167901691 paid from the PathUSD-funded
  burner via `autoSwap: true` - on-chain tx 0x28db1d76… swapped 1001 PathUSD → 1000 USDC.e
  and delivered 1000 USDC.e to our payTo, 200 + Payment-Receipt. Both canaries keep
  `autoSwap: true`.
- **SOR widened to dynamic-priced MPP sellers + Bazaar quality (2026-08-19, build #9):**
  `tempoCatalog` now admits `payment.dynamic` / non-integer-amount tempo/charge USDC.e endpoints
  (~185 registry endpoints) as candidates with `priceUsd:null, dynamic:true`; `rankTempoResources`
  ranks them AFTER in-cap fixed-price peers of equal score; `resolveExternalSeller` (server.js)
  prices a dynamic candidate from its LIVE 402 tempo/charge offer (`liveTempoPriceUsd`, mppx
  codec) and skips it when over the tier cap or unreadable - never "choose now, learn the price
  at pay time"; payTempo re-checks the same cap before signing. **Bazaar quality:** the Bazaar
  feed's per-resource `quality{l30DaysTotalCalls,l30DaysUniquePayers,lastCalledAt}` is folded per
  origin (calls summed, payers MAX - a seller-level unique count is unknowable from per-resource
  counts) into `bazaarQualityByOrigin` (x402-index.js; `bazaarQualityFor`/`bazaarQualityEntries`),
  exposed as `bazaar` on index-snapshot sellers and on `/api/route?include=external` EXTERNAL rows (routeQuery; `/api/find` returns local tools + `relatedSellers` without it), used as a routeQuery
  tiebreak after health (more distinct payers first), folded as MAX into the SOR gate's
  settled/payers evidence (buildSettledByOrigin/buildPayersByOrigin), and shown on the market
  seller card as "Coinbase Bazaar, last 30 days (their measurement, not ours)". `curated` is NOT
  ingested: it only appears on curated items in the Bazaar SEARCH endpoint (the bundles endpoint
  needs auth), so it cannot be bulk-enumerated keylessly. `scripts/test-bazaar-quality.js`,
  `test-tempo-router.js` (41). **Bazaar listing copy (2026-08-19):** the 402/Bazaar description was a
  hard 250-char slice (every flagship cut mid-sentence on the live listing); now `bazaarCapDescription`
  (500-char Bazaar cap, sentence/word boundary, never "...") for all routes, and `BAZAAR_DESCRIPTIONS`
  (payments.js, by slug) carries purpose-written what+when copy for the 15 flagships - Bazaar/402
  only, the catalog description (llms.txt/MCP/find) is untouched. `scripts/test-bazaar-descriptions.js`
  (95, in CI against the booted server).
- **Security + cost review of the 2026-08-19 builds (same day, four lenses: leaks / free upstream /
  spend bounds / live claims; fixes in PR #838):** HIGH `:online` was accepted on the NEW Messages +
  Responses wires (chat refused it) - `refuseCostVariants()` is now shared by every wire; HIGH a
  Tempo-settled request honoured an UNSIGNED `PAYMENT-SIGNATURE` riding alongside the tempo credential
  (dispatcher skips x402 verification once the tempo gate accepts; `payerFromRequest` read the forged
  `authorization.from` = memory/my-usage identity takeover for $0.001) - the gate now deletes
  `payment-signature`/`x-payment`/`payment-identifier` on acceptance AND identity-bound routes refuse
  Tempo at the binding check + get no tempo challenge (`priceFor` carries `identityBound`;
  test-mpp-tempo-shim cases J/K). MED: relay error BODIES were relayed verbatim into buyer-facing RFC
  9457 `detail` (our gate + tollbooth) - buyer gets mppx message + relay CODE only (`buyerReason`,
  tollbooth `relayFailure` vs `relayFailureDetail` for the log); the Tempo transfer feed's `lastError`
  (public on /api/mpp-leaderboard) is redacted + code-only (test-leaderboard-redaction covers the MPP
  board); Responses `function_call_output.output` arrays go through `probeParts` (input_file/images);
  per-block `cache_control.ttl:"1h"` refused on chat+Messages (`checkBlockCacheControl`, tools too);
  Responses/Messages `tool_choice` shape-checked; gpt-4o-mini images priced at ~48k tokens in the clamp
  (`imageTokensFor`: OpenAI bills 4o-mini image input ~33x 4o's token count). ACCOUNTING: a settled
  call paid by OUR wallets (heartbeat token on a USDC/Tempo request: canary, tempo-volume) used to bump
  viaUSDC/viaMPPWire/the chain split - now `viaUSDCInternal`/`viaMPPWireInternal` + heartbeat series
  (`recordServedCall(..., {internal})`, test-stats-internal-paid); `/api/revenue/mpp` derived
  "external" from the 30 NEWEST rows (all ours once volume ran) - now all-time GROUP BY network x
  internal, external hashes first (`qMppTotals`); MPP leaderboard totals exclude the self row
  (`selfTransfers`). BOUNDS: the transfer feed folds payer detail only for rankable recipients + self
  and keeps other addresses 48h counts-only (was every chain-wide address for 31 days, ~22MB JSON and
  linear in chain volume; `track` set, async persist); grounded tier `maxAttempts: 2` (each attempt
  re-bills the $0.007 search); rerank refuses past ONE Cohere search unit by an o200k chunk estimate
  (CJK at ~1 token/char reached 2 units under the char caps); tempo-volume: `if: always()` on the
  alert step, unreadable balance refuses (exit 2), count validated + capped 1000/run, bucketed
  balances in the public log/issue; Algorand rail sweep bare requests got the heartbeat single-retry
  (16 "tool failures" on run 32288638827 were the deploy switch 19:19-19:21; the other 3 were
  Blockscout upstream 500s, not charged). Images `usage.cache_discount` stripped; SSE scrubber matches
  `data:` with no space. Open/accepted: flex attempt that times out after generation may bill twice on
  that call (bounded 1.4x tier price, rare; shorter flex abort would cut legitimate slow flex answers).
- **Human front door + report products + recurring engine (2026-08-21):** `src/human-checkout.js`
  (Stripe Checkout for the premium report products, `/reports`, `POST /api/buy`, `/r/:sessionId`; no
  report without a Stripe-verified paid session, generate-once cross-replica, auto-refund on failure),
  `src/stripe-subscriptions.js` (Phase 2a: `MONITOR_PRODUCTS` domain-monitor + fund-monitor $5/mo,
  subscription-mode Checkout, durable subscriber store, signature-verified webhook, Customer Portal;
  `/monitors`, `POST /api/subscribe`, `/monitors/thanks`, `/monitors/manage`), and **Phase 2b
  `src/monitor-scheduler.js`** (fulfilment: 10-min tick, unref'd, first tick +90s; per active sub -
  domain: welcome report on first sight, FREE daily re-probe via `probeDomain()` (the SAME grade
  stage the paid handler uses, exported from domain-audit-kit, no LLM) with a security-facts
  fingerprint, full paid re-run on change / cert <= 14 days (once per cert) / every 30 days, 12h
  anti-flap gap (alert-only email inside it); fund: manager resolved once, daily `latest13fFiling()`
  (one EDGAR submissions read), full report only on a NEW accession which advances only after
  success; MAX 10 paid reports per tick, 1h-doubling-to-24h backoff per sub with no email on failure,
  a failed change-run restores the old baseline so the retry re-detects; shared-store lock in
  `/data/monitor-runs.json` so one replica ticks; reports served at `/m/:id` (the id is the bearer,
  same viewer as `/r/`) + `/api/m/:id`; `/monitors/manage?report=<id>` reaches the portal; email via
  `sendMonitorEmail` (ZeptoMail). Ops: `GET /__operator/monitors.json`, `POST /__operator/monitors/run`
  (`?sub=<id>` forces one; heavy-limited). `MONITOR_SCHEDULER=off` disarms the timer. Rollout switch
  for all of it = `STRIPE_SECRET_KEY`. `scripts/test-monitor-scheduler.js` (35, offline, in CI).
- **Security + cost review of the report products / human front door / recurring engine (2026-08-22,
  three adversarial lenses - leaks+auth, money-safety, spend-bounds+abuse - same recipe as 08-19):**
  HIGH a canceled subscriber re-activated themselves by reloading the thanks page (`recordFromSession`
  hardcoded `active`; the Checkout Session stays paid forever) - status now comes from the live
  Subscription object, a replayed `checkout.session.completed` never overwrites a terminal status, and
  the scheduler calls `refreshStatus` BEFORE every paid run. HIGH a deploy mid-generation stranded a
  paid one-shot as "generating" forever (charged, no report, no refund) - human-checkout is now one
  atomic file per session (legacy single-file store imported once), a claim older than 10 min with no
  local job is taken over ONCE (then refunded), a boot sweep re-drives abandoned claims, owed refunds
  (refund call failed) are persisted + retried + listed at `GET /__operator/human-checkout.json`, never
  reported as refunded. HIGH long-running composites (2-4 min, settle-after) were advertised on SVM
  (recent-blockhash ~60-90s), default AVM (~28s) and Tempo (client-bounded credential): work done, never
  charged - `def.longRunning` => EVM exact only (`acceptsForItem`), no Tempo challenge/binding, AVM
  SLOW_TOOL_SECONDS 300 (card/SPT unaffected). MED the monitor report id doubled as the Customer Portal
  bearer on a page we tell subscribers to share - the manage link is now `?report=<id>&k=<HMAC(report)>`
  derived from STRIPE_SECRET_KEY, carried only in the subscriber's email, and the report JSON carries no
  portal bearer. MED unlimited Stripe-API amplification on `/api/r/`, `/api/monitors/confirm`,
  `/monitors/manage` - per-IP `sessionReadLimiter` (90/min) + 60s/10s negative caches for unknown/unpaid
  ids. MED composite guard: key falls back to Tempo payer / client IP (nobody unkeyed), counts only 402
  and 5xx (4xx input errors no longer block a wallet), plus a GLOBAL breaker (12 unsettled runs /15 min
  => 503 pause on all composites, `COMPOSITE_GUARD_GLOBAL_*`). MED thin-evidence reports sold at full
  price - research needs >= 1/3 of its searches, token-risk needs token OR holders (source alone is not
  a risk report). MED monitor targets validated at checkout (`validateTarget`: domain parses, manager
  resolves on EDGAR) and a target failing 5x tells the subscriber ONCE (`problem` email) - no silent
  billing; per-sub cap 8 paid runs/30d (then alert-only); fingerprint excludes TLS issuer/valid-to (CDN
  rotation is not a security change; expiry alert still fires). Accounting: card sales + paid
  subscription invoices now land in the sales ledger (rail `card`, network `stripe`, wire
  `stripe-checkout`/`stripe-subscription`), every composite run emits PostHog `composite_usage`
  (upstream vs price; running totals in the operator JSON), and human/monitor runs carry a per-buyer
  upstream `user` id. LOW: Stripe error text no longer relayed to buyers (SDK errors carry their own
  statusCode - relay only our own 4xx), inputs >500 chars chunked across metadata keys (Stripe cap),
  email subjects control-char-stripped, report viewer escapes quotes + CSV formula-prefix, `Object.hasOwn`
  on product keys, `human-checkout`/`stripe-subscriptions` stores write tmp+rename (merge-on-save).
  Prod runs ONE replica (Railway `numReplicas: 1`), so the cross-replica lost-update class is theoretical;
  the file stores are now safe for it anyway. Tests: test-human-checkout (39), test-stripe-subscriptions
  (28), test-monitor-scheduler (41), test-composite-guard (16, incl. EVM-only accepts + global breaker).
- **Recall watch + IPO watch (2026-08-22):** `src/tools/recall-report-kit.js` (`recall-report` $3, POST
  `/v1/recall-report {query}`: free openFDA drug/food/device enforcement probes -> grounding-strict Opus
  synthesis, records appendix; `probeRecalls()` exported - the monitor's free daily probe, fingerprint =
  recall numbers; `allowEmpty:true` lets a welcome report find nothing yet; WALLET_ONLY, composite-guarded,
  METERED) and `src/tools/ipo-report-kit.js` (`ipo-report` $0.05, POST `/v1/ipo-report {days, keyword}`:
  DETERMINISTIC S-1 + 424B4 digest from EDGAR full-text search, no LLM; `probeIpos()`; WALLET_ONLY for
  egress, not composite-guarded). Monitor kinds in `monitor-scheduler.js`: `recall` (daily probe, paid
  re-run + "recall" email only on a NEW recall number, seen-set advances after success) and `ipo`
  (weekly "digest" run, no email on an empty week). Products: `recall-monitor` + `ipo-monitor` ($5/mo) in
  MONITOR_PRODUCTS, `recall-report` ($3) in HUMAN_PRODUCTS + `/reports` card. Adding a monitor kind =
  kit with a cheap `probeX()` + a `processX` branch + MONITOR_PRODUCTS entry + email reason.
- **Insider flow + market brief (2026-08-22):** `src/tools/insider-flow-kit.js` (`insider-report` $4, POST
  `/v1/insider-report {ticker|cik, days}`: Form 4 filings against the issuer via EDGAR full-text search,
  each filing's XML fetched (`fetchXmlText`, concurrency 4) and PARSED (`parseForm4`: owners/roles,
  non-derivative transactions with code/shares/price/owned-after, 10b5-1 footnote flag) -> open-market
  buys/sells vs awards/exercises/withholding, per-insider + net flow -> grounding-strict Opus synthesis,
  transactions + insiders appendix; `probeInsiderFilings()` = the monitor's cheap daily probe
  (fingerprint = accession set); `insider-monitor` $5/mo, kind `insider`, "filing" email on a new
  accession). `market-brief` ($7, POST `/v1/research/market-brief`) = the research-deep pipeline with a
  competitive-intelligence `planFrame` + fixed `synthFrame` (RESEARCH_TIERS supports both). Both in
  WALLET_ONLY, composite guard, METERED, test-all NETWORK, HUMAN_PRODUCTS + `/reports` cards. EDGAR
  primitives (`resolveCompany`, `eftsSearch`, `fetchXmlText`, `edgarGetJson`) are now exported from
  edgar-kit for the composite kits. **`PAYING_RAILS` now includes `card` + `credits`** - Stripe card
  sales/subscription invoices were recorded with rail `card` but not counted as paying, so the human
  front door was invisible to `/revenue` (caught 2026-08-22).
- **Prepaid card credits (2026-08-22, `src/credits.js`):** buy $20/$50/$100 by card
  (`/credits`, `POST /api/credits/checkout`), claim the key ONCE on `/credits/thanks` (`GET
  /api/credits/claim?session=`; a second claim returns `claimed`, never the key; emailed too), spend it on
  any priced catalog route with `Authorization: Bearer a402_…` - the GATE (mounted before x402mw next to
  the tempo/stripe gates; dispatcher bypasses x402 for `req.creditsSettling`) authorizes against the
  balance BEFORE the handler and DEBITS only on a final 200 (integer micro-dollars, sub-cent exact;
  `X-Credits-Balance` header; 402 `{reason, balanceUsd, topup}` on insufficient/unknown/disabled).
  Keys stored hashed (sha256) in per-key files under `/data/credits` (atomic), claim-once index.
  Accounting: pack purchase = row `credits:<pack>` on the NON-paying rail `card-prepaid` (cash received);
  each debit = sale on rail `credits` (PAYING_RAILS) with the key id as payer - counted once, when spent;
  the gate RESERVES the price at authorize (hold) and settles on a final 200 / releases otherwise, so
  concurrent calls can never overspend a key; debit fires on "finish" only (a client abort releases); stats `viaCredits`; the route binder skips its own recordSale
  for credits (onDebit books the exact charge). Ops: `GET /__operator/credits.json` (totals + key ids,
  never key material), `POST /__operator/credits/disable {keyId}`. `GET /api/credits/balance` (Bearer).
  Linked from footers, mobile menu, homepage people door, llms.txt, sitemap. `scripts/test-credits.js`
  (26, in CI). **Stripe Tax:** `STRIPE_AUTOMATIC_TAX=true` adds `automatic_tax` to every Checkout Session
  (one-shot, subscription, credits) - enable Stripe Tax in the dashboard FIRST or sessions 400.
- **Brand marks + packages on the new system (2026-08-22):** `/logo.svg|png`, `/favicon.svg|ico`, `/card.svg|png`
  (homepage OG card, letterboxes to GitHub's 1280x640), per-tool `/tools/:slug/card.png` and the AIFI card
  (`src/aifi-card.js`) all render in the obsidian + milled system with embedded Geist / Geist Mono (woff2 from
  `assets/fonts`); `BRAND` in server.js is the token set (`BRAND_DEFS` carries the milled/panel gradients).
  `agent402-mcp` 0.13.0 and `agent402-client` 0.7.0 accept a prepaid credits key (`AGENT402_CREDITS_KEY` env /
  `{ creditsKey }`) and pay wallet-only tools by card through it; `/reports` cards link each product's
  `/tools/<slug>` page as "Sample output + API docs".
- **Security + cost review of the 2026-08-22 builds (dark theme, new products, credits, brand; three lenses + PMF):**
  HIGH credits gate bypassed x402 but left unsigned `payment-signature`/`x-payment` in place - a $0.001
  credits call could forge `authorization.from` on identity-bound routes (memory/my-usage takeover) - now
  the gate REFUSES identity-bound routes (`priceFor` carries `identityBound`, 402 `identity-bound`) and
  STRIPS the three payment headers on acceptance (same as Tempo/Stripe gates; pinned in test-credits).
  HIGH authorize-then-charge had no reservation (N concurrent calls on one key all passed; only
  floor(balance/price) debits landed) - authorize now HOLDS the price, settle() converts the hold on a
  final 200, release() returns it otherwise; the debit fires on "finish" only (Node's default statusCode
  is 200 before any write, so a client abort was being charged). HIGH `/revenue` double-counted credits
  (pack purchase on rail `card` AND debits on rail `credits`) - packs are now `card-prepaid` (non-paying,
  cash received), debits stay `credits`. MED the 30-day paid cap applied to domain only - every kind now
  caps (alert-only + seen-set advance past it); a prompt-cache hit releases the hold (x402 buyers get
  hits free); `charge.refunded` / `charge.dispute.created` disable the key (`disableByPaymentIntent`);
  `allowEmpty` honoured only for the scheduler's own calls; insider needs >= 50% of Form 4 filings read,
  recall >= 2 of 3 feeds; openFDA `OPENFDA_API_KEY` support (keyless is 1k/day/IP); credit packs also
  mint from `checkout.session.completed`. Leak scan: a public example attributed invented figures to a
  real Form 4 filer - anonymized; "roadmap/phase" framing dropped from public text. PMF/moat assessment
  is the "Agent402 Fit and Moat" artifact (dossier-led card sales are the signal; programmatic SEC landing
  pages + retention are the lever; stop adding rails/micro-tools). Prod is one replica, so the credits
  in-memory cache is single-writer; revisit (sqlite/redis) before scaling replicas.
- **Payer attribution (`src/payer.js`):** `payerFromRequest` reads only the signed EIP-3009
  `authorization.from` — memory identity depends on it, never weaken. `payerFromPaymentResponse`
  (facilitator settle-receipt `payer`) is the fallback for SVM/Stellar, telemetry/sales only.
  Never lowercase base58/Stellar addresses (EVM only).
- **Deploy safety (live-buyer protection):** deploy job runs `scripts/deploy-quiet-gate.js`
  BEFORE the Railway variable upsert (the upsert itself can trigger a redeploy) — polls
  `/api/stats` `recentCalls`, waits for 180s with no external USDC call (heartbeat/PoW never
  block); fail-open on stats-down, sustained traffic past `QUIET_GATE_MAX_WAIT` (repo var,
  default 1200s), or repo var `QUIET_GATE=off`. **Var-upsert race (measured 2026-08-05):**
  an upsert that introduces NEW variables makes Railway auto-redeploy the PREVIOUS build,
  which races the workflow's SHA-pinned deploy (lost by 56ms; the pinned deployment ended
  REMOVED and prod served stale code with the new vars — healthy, wrong version).
  Unchanged-value upserts are no-ops and never race. When adding deploy-injected
  variables: expect the first [deploy] run to fail at "deployment ended REMOVED", verify
  prod health, then push a second [deploy] (vars now pre-exist, cannot race) — or
  pre-create the variables before the code ships. Deploy also sets
  `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=90` — Railway's default SIGTERM→SIGKILL grace is **0s**,
  so without it the server's graceful drain never runs. Drain (`src/server.js` shutdown):
  `closeIdleConnections()` sweep every 5s + 75s hard deadline (covers transcribe's 60s
  upstream timeout).
- **AVM validity guard (`src/avm-validity.js`):** Algorand payments are rejected 422
  BEFORE the handler when the signed txn's validity window can't outlive the tool
  (settlement is post-handler, so a dead txn = buyer refunded but our upstream spend
  burned — proven by image-gen-premium vs algokit's 10-round/~28s default window).
  Default requirement 20s (under the default window, normal tools unaffected);
  `SLOW_TOOL_SECONDS` maps the slow slugs (image-gen-premium 90). Round anchor from
  `ALGORAND_ALGOD_BASES` (5-min cache), fail-open on any decode/algod failure.
  `scripts/test-avm-validity.js` (offline, in CI).
- **STT margin cap (`src/tools/stt-kit.js`):** per-tier `maxMinutes` (5/10) is enforced
  locally via a `music-metadata` duration probe BEFORE any OpenAI spend — upstream bills
  per audio minute (~$0.003 mini / ~$0.0045 gpt-transcribe), so the cap is the margin
  bound, not a UX nicety. transcribe-pro rides `gpt-transcribe` since 2026-08-04
  (OpenAI's 2026-07-28 release, 25% under the old gpt-4o-transcribe rate). Unreadable
  duration → 422 (an unreadable container would be an unbounded upstream bill).
  `assertWithinDurationCap` / `probeDurationSeconds` exported for `scripts/test-stt-cap.js`.
- **2026-08-04 upstream-model sweep** (verify against live sources before repeating —
  model catalogs move): image-gen + image-gen-hd migrated `gpt-image-1-mini` →
  `gpt-image-2` (OpenAI retires 1-mini **2026-12-01**; hd and premium now differ in
  prompt cap only — premium differentiation is an open pricing decision). Gateway
  `AUTO_RANKINGS` refreshed: `google/gemini-2.0-flash-001`/-lite VANISHED from
  OpenRouter (the old fast band led every category with the dead id, burning a failed
  round-trip per routed call — live-verify ranked ids when touching the table);
  `openai/gpt-5.6-luna` ($0.10/$0.60) + `gemini-2.5-flash-lite` entered; new tier
  prefixes gpt-5.6 terra/sol, gemini-3.x, laguna; `MODEL_COST` prices
  `claude-sonnet-5` at STANDARD $3/$15 (intro $2/$10 dies 2026-08-31 — never enter
  intro rates). Two gateway guards added in the same sweep: buyer `tools` entries must
  be `type:"function"` (OpenRouter's `openrouter:subagent`/`advisor` server tools
  create spend bounded by neither `max_tokens` nor `max_price`), and an EMPTY
  safety-refusal 200 (finish_reason `content_filter` / native `refusal`, no content —
  Claude-5-class models) walks the failover chain instead of reaching the buyer as a
  paid empty answer; a chain refusing end-to-end surfaces 502 (settlement cancelled).
- **Offsite /data backup (`src/backup.js`, 2026-08-05):** nightly gzip'd copies of
  the volume's SQLite/state files to a Railway Bucket (Tigris S3, path-style,
  hand-rolled SigV4 — no SDK dep; bucket `agent402-backups`, creds ride the
  DEPLOY JOB's quiet-gated upsert as `BACKUP_S3_*`, all-four-or-nothing). Cost
  is BOUNDED BY DESIGN: date-keyed objects (same-day rerun overwrites),
  `BACKUP_KEEP_DAYS` (14) prunes old date prefixes every run,
  `BACKUP_MAX_RUN_MB` (512, compressed) holds over-budget files VISIBLY in
  status, and `BACKUP_MAX_TOTAL_GB` (20) is a bill guard that refuses uploads
  outright when the bucket exceeds it. Cache-like files (*cache*, wal/shm,
  tmp) excluded — they rebuild. SQLite staged via better-sqlite3's online
  backup API (consistent under live writers), scratch space in container tmp
  (never /data). Ops: `GET /__operator/backup.json` (status + inventory,
  works pre-creds), `POST /__operator/backup/run` (heavy-limited). Scheduler
  fires once per UTC day at `BACKUP_UTC_HOUR` (4), timer unref'd, no-op
  without creds. Restore = download object, gunzip, replace file, restart.
  `scripts/test-backup.js` (28 assertions, stub S3 + real sqlite, in CI);
  signer proven live against the real bucket 2026-08-05 before first deploy.
- **Facilitator support report (`GET /__operator/facilitators.json`, 2026-08-19, fix #9):** operator-
  authed dump of what each configured facilitator client ADVERTISES (`getSupported` kinds → exact
  networks, extensions) plus `firstTriedFor` (the first client advertising each network = the one
  @x402 tries first). Built because CDP's facilitator table grew (Polygon, Arbitrum, Solana, World)
  and CDP is first in `facilitatorClients`, so it may settle chains the boot-log LABELS attribute to
  PayAI; `/supported` needs a JWT so only the live clients can answer. **Read on prod 2026-08-19:
  CDP (first in the list) now advertises exact on `eip155:137` (Polygon), `eip155:42161` (Arbitrum),
  Solana mainnet AND World Chain (`eip155:480`) - so CDP is the FIRST-TRIED facilitator for Polygon,
  Arbitrum and Solana payments, not PayAI as the boot-log labels imply; PayAI is first only for
  Avalanche/Sei/XLayer/SKALE, Naven for Robinhood, molandak for Monad, Celo/Solvador/our Stellar/
  GoPlausible as labelled.** This is BY DESIGN (Mike, 2026-08-19): CDP is first-order for every chain
  it advertises - CDP-settled payments count toward Bazaar quality and that outranks PayAI's free
  tier; do NOT reorder `facilitatorClients`. Only the boot-log labels/comments that still say "PayAI
  handles Polygon/Arbitrum/Solana" are stale. World Chain (480) is offered by CDP but not in our
  `PAYMENT_NETWORKS` - a 13th rail is one env change away if wanted.
- **Well-known store (`src/well-known-store.js`, 2026-08-05):** operator-published
  domain-verification documents served at `/.well-known/<path>` without a redeploy
  (built for Talkshi's 15-minute domain challenge; covers any serve-a-file-to-prove-
  control flow). `POST /__operator/well-known` `{path, body}` publishes (`remove:true`
  deletes); memory-only, 24h TTL, 16-entry/16KB caps, traversal structurally
  impossible (segment allowlist), reserved names (x402, security.txt, glama.json)
  refused at write AND never shadowed at serve (catch-all `next()`s on miss).
  Never put a challenge's `claim_secret` in the published doc — it stays with the
  operator. `scripts/test-well-known-store.js` (28 assertions, boots the server, in CI).
- **MPP dual-stack shim (`src/mpp-shim.js`, 2026-07-23):** serves MPP (Machine
  Payments Protocol, tempoxyz/mpp — IETF-track "Payment" HTTP auth scheme,
  paymentauth.org) clients from the same routes, with @x402/express keeping SOLE
  settlement authority. Pure header translation: 402s gain `WWW-Authenticate:
  Payment` (one HMAC-bound evm/charge challenge per allowed EVM rail, the
  verbatim x402 accepts entry riding in challenge meta/opaque so inbound is
  stateless + byte-exact); inbound `Authorization: Payment` credentials that
  HMAC-verify are re-encoded as `PAYMENT-SIGNATURE` and fall through — every
  paywall invariant (replay guard, payer attribution, settlement ordering,
  idempotency) reads the same header it always has. The shim mounts BEFORE the
  idempotency middleware so the translated header is the gate credential the
  Idempotency-Key cache binds to — MPP buyers get the same paid-retry replay
  as x402 buyers (proven: one settle across original + keyed replay). Wire
  attribution: `/api/stats` `toolCallsServed.viaMPPWire` (subset of viaUSDC) +
  PostHog `payment_settled.wire` ("mpp"/"x402") — the MPP-adoption signal.
  Settled 200s for MPP buyers
  mirror `PAYMENT-RESPONSE` as `Payment-Receipt`. mppx is used for codec
  primitives ONLY — its request-guard/settle path is never mounted
  (double-settle risk). Rollout switch = `MPP_SECRET_KEY` presence (unset → not
  mounted, pure-x402). `MPP_CHALLENGE_NETWORKS` widens which chains get MPP
  challenges (default Base+Celo — the mainnets in stock mppx clients' asset
  registry; every extra challenge costs ~800 bytes on every 402).
  `scripts/test-mpp-shim.js` (offline, in CI): real mppx client buys over the
  native wire vs a stub facilitator, single verify+settle, EIP-712 sig checked
  against Base USDC's real domain, x402 pass-through untouched, HMAC
  tamper/expiry rejected. **RFC 9457 failures (2026-08-19, `src/mpp-problem.js`):** a REJECTED MPP
  credential (evm: malformed / not ours / expired / bad payload; tempo: binding, validate, replay,
  post-handler settle failure) answers the spec shape - 402 + FRESH challenges + `application/problem+json`
  `{type: https://paymentauth.org/problems/<kind>, title, status, detail, hint?}` using mppx's own type
  vocabulary (invalid-challenge, malformed-credential, verification-failed, payment-insufficient,
  invalid-payload). Fall-through rejections mark the request (`markMppProblem`, patches `res.send` so the
  paywall's `{}` 402 body becomes the problem doc; non-402 responses untouched); direct ones (tempo replay -
  was a 409 - and settle failure) use `sendMppProblem`. A bare unpaid 402 stays body-less - only rejections
  are problems. Pinned on the wire in test-mpp-shim (through the real server) and test-mpp-tempo-shim.
- **Tempo MPP settlement (`src/mpp-tempo.js`, 2026-08-17):** a SECOND, independent
  MPP path — Tempo (chain 4217, PathUSD `0x20c0…0000`) is MPP's native method, built
  on TIP-20 primitives that are NOT EIP-3009, so it cannot be translated into x402
  like "evm" is and no x402 facilitator supports it. It rides Tempo's hosted relay
  (`api.tempo.xyz` `/v1/mpp/validate` + `/v1/mpp/broadcast` via mppx `tempo.charge({relay})`):
  validate before the handler, broadcast ONLY after a <400 response (the same
  settlement-ordering discipline as x402); we hold no Tempo signing key. Rollout
  switch = `TEMPO_API_KEY` + a recipient (`TEMPO_RECIPIENT_ADDRESS`, else
  `WALLET_ADDRESS`); the key needs the `mpp:write` scope. **Wire shape is mppx's own,
  never hand-assembled** (`Challenge.fromMethod` through the tempo/charge schema:
  base-units `amount` "1000" for $0.001, NO `decimals` key on the wire,
  `methodDetails.chainId` 4217). Both drifts bit us live: a decimal amount made the
  client throw before signing (2026-08-17), and `decimals` ON the wire made the
  relay re-parse the request and expect 1,000,000,000 base units for a 1000-unit
  transfer — every live buy rejected "no matching payment call found" (2026-08-18).
  **INBOUND BINDING (2026-08-18 security review, HIGH, fixed):** the gate handed the
  CLIENT-ECHOED challenge straight to mppx validate/broadcast, and with the relay configured
  those forward `{challenge, payload}` verbatim - the relay checks the signed tx against the
  challenge's OWN amount/recipient, never that WE minted it. A forged 1-base-unit challenge to
  any recipient bought any paid route (and a genuine $0.001 challenge bought a $0.50 route:
  challenges are not path-bound). Now `checkTempoCredentialBinding` runs BEFORE any relay call:
  `Challenge.verify` against MPP_SECRET_KEY, realm, expiry, currency ∈ TEMPO_CURRENCY,
  recipient = our payTo, chainId 4217, and `amount >= this route's price`; `createTempoGate`
  refuses to mount without `secretKey`+`priceFor`, `mintTempoChallenge` mints nothing without
  a secret. Same day: the gate now buffers `flushHeaders` (a streaming /v1 handler settled and
  then hung on the buffered-writeHead replay). While the fix rode CI, prod's Tempo gate was
  disabled by parking `TEMPO_API_KEY` (rollout switch) and restored after the fixed build.
  `scripts/test-mpp-tempo-shim.js` cases H + I.
  **Chain-truth confirm on broadcast failure (`src/tempo-confirm.js`, 2026-08-20):** the relay's
  broadcast verdict can be WRONG in the charged-but-failed direction — measured live: an AgentCore/Privy
  buyer's credential carries a yParity-style v byte (0x00/0x01) in the packed signature; the Tempo node
  ACCEPTS the tx and stores the canonical 27/28 form, so canonical txid != keccak(submitted bytes) and the
  relay's post-broadcast hash check reports `invalid_payment: "Broadcast transaction hash does not match
  the signed transaction"` for a payment that SETTLED (txs 0xbb2e11e3…/0x753f5655…, buyer told 402, retried
  = double charge). So on ANY broadcast failure the gate now asks the CHAIN before answering 402
  (`confirmSettlement` param, wired in server.js): the credential's own signed bytes determine the only
  txids it could have landed under (submitted + v-swapped twin — exact binding, no window heuristics, no
  payer matching, the Stellar same-buyer-window lesson structurally avoided); a receipt that exists,
  succeeded (0x1), and carries the challenge's transfer (currency + recipient + >= amount) is honoured —
  200 + constructed Payment-Receipt, verification never a re-broadcast, cannot double-charge. Fails closed
  on everything else (the 402 stands). `scripts/test-tempo-confirm.js` (26, in CI) pins the derivation
  against the REAL incident tx's on-chain bytes. Tollbooth's tempo gate does NOT have this yet (same
  exposure, smaller blast radius — operator gates). Whose bug upstream (Privy signer vs relay verify) is
  deliberately unresolved here; the fix is correct under every theory.
  **The relay's verdict is invisible through mppx** (Relay.js drops non-2xx bodies
  AND the `message` of a 2xx `success:false` when the code is outside its allowlist —
  the live shape was `code:"unknown"`); `relayFetch` (injected `fetch`, per-request
  AsyncLocalStorage) keeps status+body in the rejection log; guard
  `scripts/test-mpp-tempo-relay-errors.js`. Live proof = `tempo-canary.yml`
  (dispatch, `scripts/tempo-canary-verify.js`, EVM canary burner funded with 2
  PathUSD on Tempo mainnet — checked on-chain 2026-08-18, never trust the comment) plus a
  daily `mpp-tempo` leg in paid-canary (one GRADED settle = the rail proof; `TEMPO_CANARY_TX_COUNT`
  can add volume ad hoc, default 1). **Tempo VOLUME (2026-08-19; lowered to ~200 tx/day 2026-08-20,
  Mike's call - was ~1,000):** `tempo-volume.yml` (cron every 2h, dispatchable with `count`) runs
  `scripts/tempo-volume.js`: 17 buys of `/api/uuid` (pure-CPU - no upstream spend; the $0.001 lands in
  OUR payTo, only Tempo's buyer-side fee is real cost) over tempo/charge from the canary burner,
  sequential (one wallet, nonces) with a 250ms pace, heartbeat token so stats file it as internal;
  refuses to start under $2 on the wallet (exit 2) or with no tempo challenge on the live 402; exit 1
  under 80% settled; opens/closes "Tempo MPP volume FAILING" heartbeat-style. 12 × 17 ≈ 204/day ≈
  $0.20/day. The per-chain funding sweep gained `tempo-usdce` (low-water **$5** ≈ 25 days at that
  rate) + `tempo-pathusd` rows (per-entry `lowWater` override in `chainLowWaterReport`). Burner
  0x902d…8256: Mike funded **25 USDC.e** on 2026-08-19 (months at 200/day; USDC.e challenges paid
  natively, no swap) + 1.99 PathUSD
  reserve. Top up USDC.e when "CANARY BURNER LOW" names Tempo or the volume issue opens with exit 2. `scripts/test-mpp-tempo-shim.js` (offline, in
  CI) proves challenge wiring + settlement ordering with injected stubs.
- **MPP index seeds (2026-08-19):** two discovery sources - the mpp.dev registry (141 rows, 99
  bare-origin) and **MPPScan's tRPC `servers.list`** (`timeframeDays:0` = all-time, 200/page,
  314 rows at launch with name/description/url/logo → `parseMppScanList`, metadata used for
  sellers the registry does not describe; the rendered page's `originUrls` list is the fallback
  via `parseMppScanOrigins`; `discoveryMppScan` on the snapshot reports source/total/error). Probe target resolution: registry
  endpoints > submitted hint > the seller's OWN `/openapi.json` `x-payment-info` operation
  (the MPP discovery format; `probeTargetFromDiscovery`, cached 1h) > bare root. Measured
  live at launch: verified sellers 33 → 167 in one crawl (133 MPPScan-only), 166 with a Tempo
  recipient. Third seed source: **our own x402 crawl** - `mppDualStackOrigins()` (x402-index.js,
  origins whose probed 402 carried `WWW-Authenticate: Payment`) folds into the MPP seeds every
  cycle (`discoverFromX402Crawl`), so dual-stack sellers are detected with no registry and no
  submission. Verification is still ours: nothing lists without a real MPP challenge.
- **Tempo transfer feed = leaderboard source A (`src/tempo-transfers.js`, 2026-08-19, build #4):** with
  `TEMPO_DATA_API_KEY` (Tempo data:read key, on Railway since 2026-08-19) the MPP leaderboard reads
  `api.tempo.xyz GET /v1/transfers` instead of `eth_getLogs`: ONE token-wide INCREMENTAL sweep per
  rebuild (USDC.e, `timestamp.from` = cursor − 5-min overlap, `order=asc`, cursor paging, ids dedupe,
  ≤240 pages/sync), folded into hour buckets per recipient {transfers, volume, payers}, persisted at
  `/data/tempo-transfers.json`, pruned past 31 days. Measured: ~2,000 USDC.e transfers/HOUR chain-wide
  (≈1,000 pages/day; `limit` 5-50; RateLimit-Limit 10000), top recipient ~875/day. Window = 24h
  (`MPP_LB_FEED_WINDOW_MS`, `window.source:"tempo-api"`), history days merged feed-over-RPC per date (no
  double count). **Coverage gating:** the feed only serves once `feedCovers()` - a COMPLETE sync from a
  start ≥ window ago with a fresh head (≤90 min) - else the RPC scan keeps serving (a cold 24h backfill
  takes several syncs; never under-count meanwhile). Feed unreadable → RPC fallback, loudly.
  `MPP_LB_SOURCE=rpc` forces the old path. NOT available from this feed (probed): `attribution` is not
  an accepted `include` on this key and `memo` is empty on every sampled transfer incl. our own canary
  settlements - so MPP-tag filtering / realm fingerprints (the report's ask) are not possible here; counts
  stay "inbound USDC.e transfers". `scripts/test-tempo-transfers.js` (24, in CI).
- **MPP index + leaderboard (`src/mpp-index.js`, `src/mpp-leaderboard.js`, 2026-08-18):** the
  MPP counterpart of the x402 index/leaderboard. The index probe now parses each verified
  seller's LIVE challenge with mppx's codec (`parseOffers`: method/intent, recipient,
  currency, chainId, amount - kept from the last successful probe) - the recipient is where
  the seller is actually PAID, read from a real 402, never the registry. The leaderboard
  ranks verified sellers by inbound USDC.e transfers on Tempo to that recipient over the last
  99k blocks (rpc.tempo.xyz caps eth_getLogs at 100k; ~15h; a WINDOW, said on the page):
  ONE batched `eth_getLogs` per 33k-block chunk with every recipient in `topics[2]` (not one
  call per seller), chunks split on RPC error down to 2k blocks, a failure that survives
  keeps the previous board up marked stale + lastError; warm-start from
  `/data/mpp-leaderboard-cache.json`; rebuild 30 min (first at +120s, again at +10 min).
  Rows are keyed by recipient (a shared gateway recipient sits behind 15 registry names -
  page shows 4 + "N more"), `tempo/session` sellers rank too, `proven` = transfers ≥
  `SOR_TEMPO_MIN_SETTLED_TX`, `routable` = proven AND a tempo/charge offer (the router pays
  charge only); our own Tempo payTo is a self-flagged row. Counts prime tempo-buyer's
  proven-seller cache (`primeTempoInboundCount`) so a routed buy does not re-scan. Surfaces:
  `/mpp-marketplace` (leaderboard section + `routable · #rank` roster badges),
  `/api/mpp-index`, `/api/mpp-leaderboard`. Escape hatch `MPP_LEADERBOARD=off` (rides
  `MPP_INDEX_CRAWL=off` too). Measured live 2026-08-18: 16 recipients, 8 active, 9,392
  transfers / $62 in the window, whole build 2.5s. `scripts/test-mpp-leaderboard.js` (41
  assertions, offline, in CI). **Router Tempo leg gates UP FRONT on the board** when it is
  fresh (`rankTempoResources(..., { provenByRecipient })`: only `routable` recipients are
  candidates, ties break on settled - before this the first lexical hit could be an unproven
  seller, payTempo 409'd, and the proven one ranked second was never tried); a stale/empty
  board gates nothing there and the pay-time gate alone decides (`test-tempo-router.js`).
- **Boot /supported guard (`src/payments.js`, 2026-08-01 Celo facilitator outage):** a
  facilitator that is CONFIGURED but FAILING /supported never delivers its kinds to
  @x402's initialize() (which only warns), and route validation then 500s EVERY paid
  route per request — every catalog route advertises every offered network, so one dead
  facilitator zeroes ALL paid revenue while free surfaces stay green (measured live:
  api.x402.celo.org 500ing → `RouteConfigurationError … exact on eip155:42220` on all
  paid routes for ~4h; heartbeat saw it as `paywall(500)`, issue #649). The existing
  drop-don't-break guards only cover MISCONFIGURATION (missing key/URL), not outage. Now
  every facilitator client is probed at boot (6s timeout, one retry after 2s — the
  heartbeat's single-retry doctrine) and networks no REACHABLE facilitator advertises
  `exact` on are dropped with the same loud warning shape; a dropped rail returns on the
  next boot where its facilitator answers. FAIL-OPEN when EVERY probe fails —
  indistinguishable from our own egress being down, so the guard refuses to wipe the
  offer and keeps prior behavior (paid 500s, free tier fine), loudly. `getSupported` is
  memoized per client (60s, failures never cached), so probe + upto gate + @x402's own
  initialize cost ONE fetch per facilitator per boot (also kills a keep-alive reuse race
  the double-fetch had). `X402_SUPPORTED_GUARD=off` is the operator escape hatch; the
  probe is skipped under `X402_SYNC_ON_START=false` (offline tests).
  **Failure-mode map (no facilitator is load-bearing for the whole paywall):** dead at
  boot → its rail is dropped, 11 serve (the guard); dead MID-RUN after a healthy boot →
  only its own verify/settle fails (buyer never charged, picks another chain off the same
  402) because @x402/express latches isInitialized on first success and never re-fetches
  /supported — that latch is VENDOR behavior, pinned by the test's runtime leg, so a
  future @x402 bump to TTL re-init fails CI instead of quietly re-opening the class; ALL
  dead at boot → deliberate fail-open (paid 500s, free tier fine, per-request init retry
  self-heals). Residual: a boot-dropped rail returns only on the next restart; a mid-run-
  dead rail stays advertised until then (isolated, self-healing on recovery).
  `scripts/test-supported-guard.js` (16 assertions, stub facilitators, mutation-checked,
  in CI). **Ops note: RESOLVED 2026-08-03.** `celo` was removed from prod's Railway
  `PAYMENT_NETWORKS` 2026-08-01 during the facilitator outage; it is back in the offer
  and verified working. Measured 2026-08-03: api.x402.celo.org/supported answers 200
  on 3/3 probes advertising `exact/eip155:42220`, and a live 402 on a paid route lists
  `eip155:42220` among 12 rails in the base64 `payment-required` header. Lifetime Celo
  settlement 51 inbound / $0.083, `caughtUp: true`. `/settle` still 401s without
  `CELO_FACILITATOR_KEY` (unchanged by the outage) — that key is what keeps the rail in
  the offer at all. Note the accepts live in the `payment-required` HEADER, not the 402
  body (which is `{}`); reading the body is how you conclude "no rails offered" on a
  perfectly healthy paywall.
- **HEAD paywall bypass CLOSED (2026-07-23, found via MPPScan's prober):**
  Express serves HEAD through app.get() but every gate keyed on
  "METHOD /path" — an unpaid HEAD skipped funnel/PoW/replay/x402 and executed
  GET handlers FREE (upstream-metered tools burned quota with no revenue).
  server.js now rewrites HEAD on catalog GET routes to GET for the gate chain
  and suppresses the body at res.end (RFC 9110 semantics: 402 + identical
  headers, empty body). `scripts/test-head-paywall.js` (offline, in CI).
- **Surface self-consistency (`scripts/test-mcp-self-consistency.js`, 2026-08-07, in CI):**
  every functional test drives the connector the way WE intend it to be used — they
  call the tools whose names they already know — so nothing tested whether our own
  published text names things that EXIST. Three times a tool had a working CallTool
  handler and was absent from `tools/list` (about_agent402, top_x402_sellers, then
  `request_tool`); the first two were fixed by hand with a comment and no test, so the
  class stayed open and the third shipped. The third was the worst: about_agent402's
  `missingATool` field tells agents to "Call request_tool", i.e. our orientation tool
  instructed agents to do something our capabilities made impossible, and the whole
  demand board only ever heard from callers who already knew the name. Found from
  OUTSIDE (issue #705), not by us. The guard reads five agent-facing surfaces
  (`tools/list` text, about_agent402, get_payment_info, `/llms.txt`,
  `/.well-known/x402`) and asserts every tool name in a call-this position is
  advertised, every named catalog slug exists, and every referenced route is
  registered — plus both parity directions (a CallTool branch no advertised name can
  reach; a listed tool with no handler or slug). **Route existence uses TWO oracles
  and reports missing only when BOTH say no:** a source scan of `app.<verb>("…")`
  (the only oracle that can see a POST-only route — a live GET 404 cannot
  distinguish "no such route" from "wrong method", the ambiguity the #705 reporter
  correctly refused to resolve) and a live GET (the only oracle that can see the
  template-literal chain pages `app.get(\`/${chainKey}\`)`). The live probe never
  touches `/api` or `/v1` — in FREE_MODE those handlers execute, and a consistency
  check must not call a tool that spends money. Path matching is SEGMENT-aware so
  `/api/wish` is never satisfied by `/api/wishes`. Extractors are proven against a
  planted control before any clean run is believed (same doctrine as the free-tier
  egress probe). **The first draft had a "does this look like one of our tools?"
  filter that skipped any unknown snake_case name — which is exactly the defect
  being hunted; a planted `Call submit_wish` passed a green run.** It is gone; the
  only escape hatch is the explicit `NOT_A_TOOL` set (one entry: `route_and_execute`,
  which is real but lives on the stdio npm package). Mutation-tested: removing
  `request_tool` from the listing fails 2 assertions, a fake tool name fails 1, a
  fake route fails 1.
- **Canary gate + settlement freshness alarm (2026-08-07):** the daily paid canary
  stopped buying on **2026-08-02** and reported success every run for five days. Its
  gate asked GitHub for the last SUCCESSFUL RUN, but a run whose gate SKIPS the buy
  also concludes green, so every skip refreshed the window the next gate read and it
  ratcheted permanently shut (measured across 40 runs: not one scheduled run bought
  after the gate shipped; every real purchase came from a manual dispatch, which
  bypasses the gate via `if: github.event_name == 'schedule'`). Nothing paged, because
  skipping is not a failure — the ONLY surface that noticed was `/status`, reporting
  the settlement component stale. **The gate now asks PRODUCTION when a canary last
  BOUGHT** (`/api/status` settlement observation, written only by a canary that ran),
  requiring fresh AND operational; unreachable status or a missing observation proceeds
  with the buy, and every `jq` read carries a fallback because jq exits non-zero on a
  non-JSON body and `set -e` would fail the gate. The canary job's `if` gained
  `!cancelled()`: a job-level `if` with no status function still carries the implicit
  `success()` on `needs`, so a FAILED gate would have SKIPPED the buy — the opposite of
  what the comment beside it claimed, and never verified. **`heartbeat.yml` now pages on
  a stale settlement observation** and self-heals once per episode by dispatching the
  canary on FIRST detection only (a dispatch always buys; page rather than loop if
  buying is genuinely broken). Proven end-to-end 2026-08-07: alarm fired → dispatched →
  found a real failure → opened issues; then the 14:17 UTC SCHEDULED run bought (first
  since 08-02) and the recovery branch closed its own issue. `scripts/test-canary-coverage.js`
  locks the class: the gate must read `/api/status` and must NOT read `gh run list`,
  every jq read must have a fallback, and the `if` must carry a status function.
- **Facilitator failure diagnostics (`src/facilitator-diagnostics.js`, 2026-08-07):**
  15 settle failures across Base/Solana/Polygon/Arbitrum all logged 200 characters of
  `<html><head><title>Coinbase</title>…` — `@x402/core`'s `responseExcerpt` truncates an
  error body at 200 chars, and on an HTML page that budget is spent entirely on markup.
  A facilitator outage and an edge REFUSING OUR EGRESS were indistinguishable, and those
  need opposite responses (wait vs build the fifth relay — Yahoo/Nasdaq/Sei/Nodely are
  the existing four, and Nodely 403s Railway's IP outright). A global-fetch wrapper,
  scoped to registered facilitator hosts and non-2xx non-JSON responses only, reads the
  body BEFORE the vendor truncates it, strips markup, and classifies: cloudflare
  challenge/block, access denied, rate limited, origin error behind the edge, gateway
  timeout — keeping `cf-ray`/`server`/`retry-after`. It **clones** before reading
  (consuming the body would break settlement), swallows every internal failure, and logs
  once at boot so a silent failure to install is visible immediately. **Errors are also
  LABELLED with the facilitator that threw them** (`labelFacilitatorErrors`): the failure
  hooks log the chain and never the client, so Solana/Polygon/Arbitrum failures read as
  Coinbase's words though the boot log routes those to PayAI and only Base to CDP —
  clients are tried in order, so the surfacing error is the FIRST tried, not the chain's
  owner. The label is **PREFIXED, never substituted**: `isPreBroadcastSettleRejection`
  matches `settle failed (402)` as a substring, so replacing the message would silently
  break the fallback's safety classification. `scripts/test-facilitator-diagnostics.js`
  (30 assertions, offline, in CI).
- **Redis has REAL coverage in CI (2026-08-07):** nothing had ever connected to a redis.
  `test-shared-limit.js` injects a fake store on purpose (it proves "two callers share
  one counter", and a fake proves that exactly), which left the CLIENT path untested —
  so a redis 4→6 bump arrived with a green CI that could not have caught a client
  regression, the same worthless green as the tesseract 5→7 trap. Prod is **NOT**
  in-memory (verified against Railway: `REDIS_URL` and `RATE_LIMIT_REPLICAS` are set,
  and the shared limiter FAILS CLOSED). The test job now runs a `redis:7-alpine` service
  container and `scripts/test-redis-integration.js` drives the real client (cap-of-1,
  over-limit decrement, refund flooring, cache round trip). It asserts `degraded === false`
  so it cannot pass via the fail-closed path with no server, and it **exits 1 rather than
  skipping** when `REDIS_URL` is absent — a skipped integration test is why this went
  untested at all.
- **Marketplace latency / snapshot caching (`src/x402-economy.js`):** `GET /marketplace`
  (and `/api/x402-economy`) render from `x402EconomySnapshot()` — a ~500ms on-chain read
  (EIP-3009 USDC settlements on Base via CDP SQL). It is **stale-while-revalidate**: a fresh
  cache (30 min, `ECONOMY_FRESH_MS`) returns as-is; a stale-but-present cache is served
  immediately while a single **deduped** background rebuild (`startEconomyRefresh`, one
  in-flight query for a concurrent burst) runs; only a cold cache (first request after boot)
  awaits the build. Errored reads back-date `cachedAt` so they expire in ~5 min, not 30.
  No visitor request ever blocks on the rebuild — before this, the first visitor after each
  30-min expiry ate the full ~500ms. `getIndexSnapshot()` is a separate 30s in-memory cache
  (`INDEX_SNAPSHOT_TTL_MS`). The **crawl cache itself warm-starts from `/data`**
  (`INDEX_CACHE_FILE`, default `/data/x402-index-cache.json`; persisted after each
  crawl, loaded in `startCrawler`, never clobbers a live-refreshed entry) — it used to
  be memory-only, so every redeploy served a half-crawled ecosystem for the minutes a
  ~2,200-origin re-crawl takes (a visitor saw 569 sellers against a real 2,169). Same
  fix and same reasoning as the leaderboard's own snapshot warm-start.
  `scripts/test-index-warmstart.js` (offline, in CI). Note the two seller counts on
  `/marketplace` are deliberately different populations: the stat card counts **distinct
  payees** (rows after collapsing origins sharing a leaderboard payTo gid) and the chain
  nav counts **raw origins** — the card names both so they reconcile. Measured live 2026-07-18: `/marketplace` p50 135ms / max 224ms,
  `/api/x402-economy` p50 93ms, zero requests >500ms across 26 samples. NB: there is **no CDN**
  in front (no `age`/`cf-cache` header) — the server-side snapshot caches are the origin
  protection; the `max-age=120` on the response is a browser-only hint. Contract pinned by
  `scripts/test-x402-economy.js` (dedup + warm-cache identity, never-throws).
- **Site redesign 2026-08-22 ("milled + obsidian", approved from the Agent402 Site Directions canvas):**
  TWO themes, DARK IS THE DEFAULT (same day, Mike): the dark palette sits on bare `:root` (first paint
  dark, no script, no flash); the light "milled" palette is `:root[data-theme="light"]`, applied by
  `assets/js/site-chrome.js` (synchronous in `<head>`, reads `localStorage a402-theme` pre-paint) and
  flipped by the nav `.ml-theme-toggle`; no OS media query. Theme-specific surfaces ride tokens
  (`--btn-bg/--btn-fg`, `--nav-bg`, `--brand-mark`, `--milled-bg`, `--obsidian-bg`, `--chip-bg`,
  `--card-inset`, `--on-accent`) - never a hardcoded hex in a page class; `test-theme.js` pins all of
  it (dark default tokens, complete light override, toggle present + CSP-clean, no server-stamped
  data-theme). Mobile menu: CTA first, groups people/buy/index/sell/more, chains as a 2-col chip grid.
  (Earlier the same day it shipped as ONE light theme on `:root` (`--paper #F3F4F5`, `--card #FFF`, `--ink #111315`, obsidian panels keep
  `--surface #0C0D0F` / `--on-dark`; `--accent #0F5E43` deep green for text/kickers on light,
  `--accent-lit #9EF0B0` phosphor ONLY on dark; `color-scheme: light`, no toggle, no OS media query -
  `test-theme.js` pins the new palette + the no-toggle rules). Fonts self-hosted Geist + Geist Mono
  (`assets/fonts/geist-*-latin{,-ext}.woff2`, weights 300-700 / 400-700, metric-matched `Geist Fallback`
  faces computed from the TTF metrics; `FONT_FILE_RE` in server.js admits them). `ledger-chrome.js`: status
  band removed; nav = Reports · Monitors · Tools▾ | Market▾ · MPP▾ · Leaderboard | Sell▾ · Docs + llms.txt
  pill + "Get a report" CTA (→ /reports, suppressed there) + burger; dropdown/mobile mechanics, chain rows
  (`test-nav-chains`) and `site-chrome.js` unchanged; footers carry a "for people" column. Homepage
  (`ledger-home.js`): hero = headline + obsidian 402-handshake terminal carrying the live counter
  (`#hm-counter` etc. preserved), two doors (people / agents), proof strip, PoW demo, sell, leaderboard +
  rails (obsidian band), demand lanes, rails chips, FAQ, closing CTA; the d3 dot-map + marquee are gone
  (homepage loads NO third-party script - `test-home-page` pins that now). `/reports`, `/r/:id`, `/m/:id`,
  `/monitors*` render through `ledgerShell` with shared `REPORTS_CSS` (class names unchanged for
  reports.js / report-view.js / monitors.js). Error page + a new catch-all 404 render through the shell.
  Sitewide `1.5px solid var(--ink)` borders softened to `1px solid var(--hairline)` (49 modules). Machine
  surfaces (`/llms.txt`, `/openapi.json`, `/.well-known/x402`, `/api/*`, MCP, sitemap/robots, JSON-LD)
  untouched; every page gate (`test-single-main-landmark`, reveal suite, `test-static-pages`,
  `test-css-tokens-resolve`, `test-faint-contrast`, `test-home-page`, `test-surface-copy`, ...) green.
  Booted page tests default to `TARGET_URL=http://localhost:3000` - if another app holds :3000 locally
  they read its HTML and fail confusingly; boot ours on a free port and export TARGET_URL.
- **Homepage = `src/ledger-home.js`** (`ledgerHomePage`; the old `src/landing.js` is unused
  but still unit-tested). Its `faqs` array renders BOTH the visible FAQ and the FAQPage
  JSON-LD, and the WebApplication offer is an AggregateOffer — deploy.yml's SEO gate greps
  prod for `"FAQPage"` / `GET /faq` / `AggregateOffer`. That gate runs BEFORE the deploy job,
  so a fix to those surfaces goes green on the run AFTER the one shipping it.
- **/revenue layout = two wires + a throughput band (2026-08-20, Mike):** `revenuePage` renders a
  wire overview (one card each for x402 and MPP — **headlines are EXTERNAL-only**: the MPP card
  headlining its combined count read as traction when 553 of 554 were our own volume runs, the
  registry-inflation move we call out in others), then **`railThroughputSection`** — a PROMINENT
  full-width band carrying the big COMBINED numbers (`allTimeInboundCount/Usd` on ledgerSummary +
  `mppSales().count`) with provenance in the same breath ("every settled on-chain transaction, ours
  included · throughput proves the rails, revenue counts only money from others"). Being paid proves
  demand; ~200 settlements/day through the same gates buyers use proves the plumbing — both are
  first-class, neither wears the other's clothes. Then the chart, `x402 rails · by chain` (EXTERNAL
  rows only) and `MPP wire · by rail` (big number = "through the rail (ours incl.)", external called
  out beside it; intro says "throughput, not revenue"). **Payer classification:** tempo settles
  record the credential's did:pkh `source` as CLASSIFICATION-GRADE payer (`req.mppTempoPayer`,
  never identity — same tier as the facilitator-receipt fallback); Mike's AgentCore/Privy test
  wallet 0x24e6a249… is in OUR_EVM_WALLETS (its 2026-08-20 buy classified external for a day);
  sales-ledger boots with an idempotent reclassification sweep (payer ∈ BURNERS → internal, plus
  the one payer-less AgentCore row by tx hash).
- **Buyer counts on /revenue (`ledgerBuyersDaily` + `ledgerBuyerConcentration`):** a
  **Buyers** metric answering "more buyers, or the same handful paying more?", which
  tx counts cannot (200 calls is one whale or fifty customers; the revenue line is
  identical). Served on `/api/revenue/daily` as `buyers[]` + `concentration`. Distinct
  counts fail flatteringly, so four invariants are pinned by
  `scripts/test-revenue-buyers.js` (8 assertions) + `test-revenue-chart.js`: **cumulative
  is a running UNION, never a sum** of daily counts (summing double-counts every
  returning buyer and draws a rising line over a flat reality); a buyer paying on **two
  chains in one day is one buyer** (rows are keyed day+chain, so counting there reports
  two); **`newBuyers` is measured against ALL history**, not the charted window, so nobody
  is relabelled new when the epoch moves; and **base58/Stellar addresses are never
  case-folded** (that merges distinct buyers — same rule as `src/payer.js`). Buyers is
  external-only and count-only, so selecting it forces scope=ext/wire=all/traffic=paid.
  `unattributed` surfaces payments whose payer could not be read (measured 0 of 3,945).
  **Counts only, never addresses** — a per-day roster of who pays us is a customer list.
  Baseline 2026-07-27: 200 distinct buyers, ~1-6 new/day, majority returning.
- **Revenue chart free-tier lane (`/revenue`, `src/revenue-live.js` `revenueChartSection`):**
  the chart is built from the settlement ledger, so free (proof-of-work) calls are
  invisible to it — they settle nowhere. A **Paid / Free (PoW) / Both** control merges a
  second series from `GET /api/calls/daily`, backed by the `daily_calls (day, method, n)`
  table in `src/stats.js` (bumped inside the SAME transaction as the lifetime counters, so
  the two can never drift; never pruned — `recent_calls` is capped at 200 rows and can
  never source a time series). A free call earns **$0**, so the lane is mutually exclusive
  with the `Revenue $` metric: each control corrects the other (`setSeg`), and `build()`
  additionally refuses the lane unless `metric === "tx"`. Free tier is **not a chain** — it
  takes a neutral `--sfree` grey, never one of the 8 validated chain slots, and never folds
  into "Other". Per-day recording began when the table shipped; earlier days have **no
  record**, which the note distinguishes from "no free traffic" (heartbeat probes are
  excluded — external PoW only). Chart epoch is `REVENUE_DAILY_START`, default **2026-06-15**.
  `scripts/test-revenue-chart.js` (jsdom, in CI) pins the interaction invariants.
- **Status page (`/status`, `/api/status`, `src/status.js` + `src/status-store.js`):**
  availability measured from OUTSIDE production. The heartbeat (GitHub Actions, every
  15 min) POSTs what it observed to `POST /api/status/probe` (operator-authed — an open
  endpoint would let anyone forge our uptime), and the page only renders those rows.
  Three invariants, pinned by `scripts/test-status-store.js` (33 assertions, in CI):
  a day with **no observation is "no data", never uptime**; a component whose newest
  observation is **stale reads "unknown", not "operational"**; every percentage carries
  its **observation count**. When prod is down the probe can't report either, so an
  outage is a GAP — hence gaps never count as uptime. `latestByComponent` keys on
  **MAX(ts), never MAX(id)** (backfill inserts old rows after new ones). Incidents are
  computed from failed probes, not authored. Backfill via `status-backfill.yml` →
  `scripts/backfill-status-history.js`, judged **per PROBE STEP, never per run
  conclusion**: heartbeat runs fail for unrelated reasons (runner "Set up job", the
  issue step), and using conclusions invented 17 outages / 97.899% where the probe step
  gives **784 observations, 0 failures, 100.000%** (43 days). The OLD page hardcoded an
  "All systems operational" pill and headlined `process.uptime()` (resets every deploy) —
  never reintroduce either.
- **Independent status observer (`workers/status-probe`, Cloudflare cron, live 2026-07-27):**
  a second observer OUTSIDE production on separate infra, because /status is only as
  trustworthy as its observer and that was a single GitHub schedule. Probes every 5 min
  (`agent402-status-probe.mikepetrillo1775.workers.dev`; `OPERATOR_TOKEN` secret = Railway's
  `AGENT402_OPERATOR_TOKEN`), records `source: "cloudflare-cron"` on `POST /api/status/probe`,
  and covers `api`/`catalog`/`mcp`/`paywall`/`rails`. It deliberately **skips paid-call**:
  that needs a 16-bit PoW solve plus an `X-Heartbeat-Token` from `POW_SECRET`, and copying
  that secret to a second platform widens its blast radius while omitting it would count
  every probe as real external free-tier demand (288/day synthetic vs ~130/day genuine),
  corrupting the free-tier series on /revenue. So `paid-call`'s `staleAfterMs` is sized to
  ITS observer (`HOURLY_OBSERVER`, 3h = ~3 missed hourly GitHub runs), not the 45-min
  default. `POST /run` on the worker is token-gated for manual verification.
  **Single-retry semantics (2026-07-29):** a failed check is re-probed once after
  20s and only a failure that survives is recorded — one probe landing inside a
  deploy restart was ambering the whole day's bar on /status (6 of 7 amber days
  traced to deploy blips), which reads as "currently degraded" on a healthy
  service. A real outage fails both attempts and records exactly as before; the
  first attempt's blip still goes to the worker log. Paired fix: the Railway
  service now has `healthcheckPath=/health` (timeout 120s), so traffic only
  switches to a new container after it actually serves — deploys should no
  longer produce the blip at all (drain side was already covered by
  `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`). The GitHub heartbeat prober has the
  SAME single-retry semantics (`scripts/heartbeat-probe.sh` probe() wraps
  probe_once(), `PROBE_RETRY_DELAY` default 20s) — added later the same day
  after a sub-minute incident recorded at 03:40Z proved the worker-only fix
  left this observer blipping.
  `scripts/test-status-probe-worker.js` (11 assertions, stubbed fetch, in CI) pins the
  quiet regressions: a 200 where a 402 is required, a collapsed catalog, a rail silently
  missing from the offer, and "one dead endpoint must not abort the other checks".
- **Heartbeat cadence (why /status went amber on a healthy prod):** the workflow's
  cron says `*/15` but GitHub delivers it **about once an hour** (measured 2026-07-27:
  60-72 min gaps plus a 3.3h stall), while `COMPONENTS.staleAfterMs` marks these
  components stale at 45 min — so the page reported "degraded" with production
  perfectly healthy, the exact threshold-vs-cadence mismatch `src/status.js` warns
  about. Fixed by observing MORE, never by loosening the alarm: the probe moved to
  `scripts/heartbeat-probe.sh` (sourced, defines `probe()` + `record_observation()`)
  and a final `if: always()` step re-probes 4x at 12-min spacing, so freshness tracks
  the 45-min threshold again. That step runs LAST so nothing that can page is delayed;
  `timeout-minutes` is 75 to cover it. `scripts/test-heartbeat-probe.sh` (22 assertions,
  offline, stubbed curl, in CI) pins the FAILS -> per-component mapping — a mismap would
  silently report the wrong component down, or a broken one as operational.
- **Refund pipeline (`src/refund-ledger.js` + `scripts/refund-run.js` + `refund.yml`, 2026-08-04):**
  charged-but-failed is now a DEBT, not only an alarm. The moment a settle receipt with
  `success:true` goes out on a non-200 (the existing detection at the charged-failure
  tally in server.js), a row lands in `/data/agent402-refunds.db`: payer, network,
  priceUsd, settle tx as evidence, synthetic flag. Idempotent on the settle tx.
  Operator surface: `GET /__operator/refunds.json` (+ `POST /__operator/refunds/update`
  — `paid` REQUIRES the outbound tx, `void` REQUIRES a note; a silent write-off is the
  failure mode the ledger exists to prevent; resolved rows never re-resolve).
  Execution is the dispatch-only `refund.yml` → `scripts/refund-run.js`: DRY RUN by
  default (`live=true` to send), refunds the exact priceUsd to the recorded payer on
  the chain they paid on, asset read from OUR OWN live 402 accepts (never a
  hand-maintained token table; EVM decimals read from the contract). Caps: $0.25/refund,
  $2/run, and **$0.50/payer/run** (`REFUND_MAX_PER_PAYER_USD`); optional dust floor
  `REFUND_MIN_USD` (default 0 = off). Over-cap, unsupported and dust rows are HELD and
  listed, never dropped.
  **PRE-SEND ON-CHAIN PROOF (`src/payment-verify.js`) — no refund leaves on a
  facilitator's word.** A debt is recorded on the settle receipt's `success:true`,
  which is unforgeable by a buyer but NOT guaranteed true — a facilitator can be
  wrong, and one demonstrably was this week in the opposite direction (Stellar
  reported failure for transfers that confirmed). The mirror (success reported for a
  reverted or never-landed transfer) would refund money we never received, with no
  attacker involved. So before each send the executor re-derives the payment from the
  chain: the SAME payer → OUR payTo (from the live 402 accepts), for AT LEAST the
  amount (>= because premium chains quote above list), in a transaction whose receipt
  status is success, with the token address matched and `decimals()` READ not assumed.
  Fails closed on every uncertainty — RPC error, missing receipt, junk tx, no verifier
  for that family — and the row is HELD, still owed, never paid and never written off.
  **All twelve rails verify** (2026-08-04): every EVM chain via receipt logs;
  Solana via pre/post token balances compared per OWNER (a payer may use a
  non-default token account, so matching derived addresses would miss it) with
  `meta.err` rejecting failed transactions — the exact shape our own whale produced
  when it ran dry; Algorand via the indexer, checking sender, receiver, **ASA id**
  (anyone can mint a token called USDC on Algorand) and amount; Stellar via the shared
  same-transaction confirmer. Monad and Robinhood RPCs were missing entirely, so their
  rows had been holding as "no RPC configured" — safe, but never repaid. 36 assertions
  in `scripts/test-payment-verify.js`; 15 mutations killed (accept a revert, ignore who
  paid, ignore who was credited, accept an underpayment, accept any token, assume 6
  decimals, proceed without a receipt).
  **Deep review 2026-08-04 — two MORE findings, both fixed.** (a) **Double-refund
  window.** The executor sent, then marked paid; a failure in between (a blip on the
  mark call) left the row `owed` while the money was gone — and the next run
  re-verifies the INBOUND payment, which is true forever, and pays again.
  Verification proves we were PAID; it can never prove we have not already REFUNDED.
  Rows are now CLAIMED (`owed → sending`) before any broadcast, only from `owed`, so
  a crash leaves a stuck `sending` row for a human instead of a silent second
  payment. `refund.yml` also has a `concurrency: refund-run` group so two dispatches
  cannot race at all. (b) **Stellar could vouch for the wrong debt.** Its confirmer
  answers "did this payer pay us near this time" — weaker than the other rails, which
  resolve a specific hash — so one genuine payment could verify a DIFFERENT debt from
  the same buyer in the same window, refunding it twice. When a row recorded a
  transaction, the confirmed one must now BE it.
  **Abuse review 2026-08-04 — two guards exist because of it.** (1) A debt requires
  POSITIVE PROOF: `receiptProvesCharge()` demands an explicit `success === true`. The
  charged-failure ALARM still fires on an unreadable/legacy receipt (loud on ambiguity
  is right for a warning), but a DEBT is money, so ambiguity must not mint one —
  otherwise a middleware change making the receipt unparseable would create a
  refundable row per failing call, one per slug per minute (no tx to key on). The
  receipt is unforgeable — a RESPONSE header written only by `@x402/express`, never
  echoed from a request — so `success:true` is trustworthy; the gap was trusting the
  ABSENCE of a field. (2) The per-payer cap bounds the sponsored-gas griefing loop:
  gas is sponsored for buyers on EVM, so a wallet can pay $0.001, force a
  charged-failure, take the $0.001 back and lose nothing while WE pay refund gas. Each
  debt is real, so the answer is a per-wallet bound (rows pile up visibly, held), never
  a refusal. Also verified: `isSyntheticRequest` needs a signed heartbeat token (a buyer
  cannot flag themselves), and refunds pay `def.price` (list) — on premium chains the
  buyer paid slightly MORE, so we under-refund by the premium: safe direction, known gap. Canary/synthetic rows are recorded but held unless
  `include_synthetic`. Spending keys are Actions secrets ONLY and refunds ride
  the CI CANARY BURNERS by default (Mike's decision 2026-08-04 — refund volume is
  minimal, the burners already hold USDC on the paying chains, and the canary
  low-water alarms watch their balances, so refund spend pages for a top-up like
  canary spend does). Dedicated `REFUND_EVM_KEY` / `REFUND_STELLAR_SECRET` /
  `REFUND_ALGORAND_MNEMONIC` take precedence whenever set. NEVER the treasury;
  the server records debts but can never send money. Solana is detection-only until
  the SVM spending wallet lands (rare there anyway: a failed Solana txn moves no
  tokens, measured 2026-08-03). A failed send leaves the row owed and exits 1.
  `scripts/test-refund-ledger.js` (27 assertions, 7 mutations killed, in CI).
- **Charged-failure alarm — READ THIS BEFORE TRUSTING IT.** `charged-failure-alert.yml`
  polled PUBLIC `/api/stats` for `.chargedFailures`, a field that only exists on
  `getOperatorBreakdown()` behind `/__operator/stats`. `jq -e` failed every run, it took
  the "unreadable → skip" path, and reported success — so the alarm for our worst failure
  mode (buyer paid, got nothing) had **never once fired** before 2026-07-25. Now reads
  `/__operator/stats` with `AGENT402_OPERATOR_TOKEN`, and a MISSING field is no longer
  treated as unreadable (that's what hid it). **`chargedButFailed` on `/api/stats` is a
  LIFETIME counter (~1726) polluted by a since-fixed miscount that logged Robinhood
  settlement *rejections* — where the buyer kept their money — as charged failures. Never
  quote it as current quality; use a recent window from the operator endpoint.**
- **Paid canary (`scripts/paid-canary.js`):** 32 legs — tools across all twelve rails
  (Base/Solana/Polygon/Arbitrum/Monad/Celo/Avalanche/Sei/Optimism/Stellar/Algorand/Robinhood).
  **Rail legs are graded separately from tool legs and now FAIL the run** (fixed
  2026-08-03). They live outside `results`, so `decideCanary()` never saw them and every
  rail branch was `console.warn` + `continue`: a rail could fail on every run for weeks
  while the script exited 0. Measured on run 30835380742 — "30/30 settled", exit green,
  Stellar broken on that run and the nine before it. All eleven rail failure paths now
  go through `railFail()`, and `main()` exits 1 if any fired. Silent skips are gone too:
  a rail missing from the live 402 accepts (the Celo-outage shape) is a failure, not a
  `continue`.
  **STELLAR SETTLES LATE — FIXED 2026-08-03, and the rail was never broken.** Stellar
  closes a ledger about every 5s. The OpenZeppelin channel service gives up before that
  and returns `settle_channel_service_failed`, so we returned 402 while the transfer
  confirmed anyway: measured 402 at 17:10:48.044, transfer confirmed 17:10:52, on-chain
  effects `account_debited CANARY BURNER 0.001 USDC` → `account_credited OUR PAYTO`. It
  reproduced on EVERY run because it is a race nobody can win, not a fault. The handler
  had already run, so we did the work, took the money, and discarded the answer — the
  buyer was charged and told they were not. Do NOT pull `stellar` from
  `PAYMENT_NETWORKS`: payments always succeeded, delivery did not.
  Fixed by `StellarConfirmingFacilitatorClient` in `src/payments.js` + `src/stellar-confirm.js`:
  on a settle failure we poll Horizon and, if a confirmed transfer from that payer to our
  payTo exists, honour the settlement that actually happened. **Verification, never a
  re-settle** — nothing is broadcast, so it cannot double-charge. A transfer counts only
  when the payer was debited AND our payTo credited in the SAME successful transaction
  after the attempt began; native XLM (fee) debits are excluded; any error returns null
  and leaves the original failure standing. Proven in production: canary
  `OK stellar → settled $0.001 USDC` on run 30845721207, all rail legs green.
  **The payer comes from the FACILITATOR (`SettleError.payer` / settle response), never
  from the payload** — the first version read `paymentPayload.payload.payer`, which does
  not exist (a Stellar payload carries `transaction`, a base64 XDR envelope), so the fix
  shipped DEAD and the canary caught it in one run. Parsing the XDR would not help
  either: the transaction source is the facilitator's channel account, not the buyer
  (measured GBA2DD…NY6O4 vs GDR2UY…KGE3T). `scripts/test-stellar-confirm.js` (18
  assertions, in CI) pins both halves — the original 13 all passed against the dead
  version because every one supplied a payer as an argument and none asked where a
  caller obtains one. Still worth reporting upstream: OpenZeppelin should not report
  failure for transfers that subsequently confirm.
  incl. two federal-data legs
  (vin-decode / geo-lookup) whose Base settlements also seed the gov tools into
  settlement-driven indexes like x402scan, plus llm-nano (failover), llm-stream
  (`raw:true`, asserts SSE `data:`…`[DONE]`), llm-auto (model-less request must carry the
  `agent402_router` disclosure), llm-embed + embed-cache (default-on free repeat,
  per-run nonce input), llm-image (real b64_json payload >10k chars), my-usage
  (self-referential history), supply-chain (address-profile: the daily two-settlement proof — canary pays us, prod's spending wallet pays Blockscout upstream), route-exec (receipt + digest), prompt-cache (pays once,
  identical unpaid repeat must be 200 + `X-Cache: hit`), and **render** (the only leg
  that exercises the secretless browser/media worker — a paid `example.com` render must
  return `rendered:true` + a stable "Example Domain" title, proving the live main→worker
  hop + Chromium + F04 egress proxy end-to-end; new-leg coverage locked by
  `scripts/test-canary-coverage.js`). Trigger via workflow_dispatch on
  `paid-canary.yml` (ref main) after a deploy; verdict is the job log tail.
  **Funding classification:** exit 3 = proven underfunded (all failed legs clean 402s,
  ≥1 real settle, live Base balance < cheapest failed leg — files a "burner EMPTY"
  issue, not an outage); exit 4 = green run but balance < `CANARY_LOW_WATER_USD`
  (default $2, ~2 runs) — "burner LOW" issue pages for a top-up BEFORE starvation.
  The balance read walks a 3-RPC fallback chain (mainnet.base.org rejected the read
  2026-07-27 while the wallet sat at $0.00, so an empty wallet paged as "buying looks
  broken"); an unreadable balance is logged loudly and never demotes a green run.
- **Algorand rail canary (`scripts/algorand-rail-canary.js`, `algorand-rail-canary.yml`,
  weekly Mon ~06:41 UTC + dispatch):** buys EVERY catalog tool on Algorand and asserts
  402 → sign → settle → 200 → non-empty payload. Fills the gap between paid-canary (ONE
  Algorand leg) and challenge-sweep (skips already-registered, so it re-verifies nothing).
  **Every non-clean buy gets ONE fresh-signed retry before it is classified (2026-08-19):**
  a >=400 cancels settlement so a retry costs nothing unless it succeeds, and this sweep
  makes ~500 sequential paid buys over ~55 min, so three NON-defects otherwise fail the whole
  weekly gate on first sight — an edge `502 "upstream error"` (Railway swapping a container
  mid-sweep; it hits pure-CPU tools like `xml-validate` too), a THIRD-PARTY upstream 5xx/timeout
  (Blockscout/GLEIF/OpenRouter, or a router `"Seller rejected the paid retry"`), and a
  `409 "authorization already used"` (two equal-priced AVM buys inside one ~50-min validity
  window can sign to the same txid; a fresh signature in a later round is a new txid). Only what
  SURVIVES the retry is classified: **rail** (paid, still a slow 402 = settlement refused), **tool**
  (settled path fine, our own handler didn't deliver; a ≥400 cancels settlement so nobody was
  charged), **unexpected-missing-accept** (a non-identity-bound tool stopped advertising
  `algorand:*`) — these three FAIL the run — plus **upstream** (a persistent third-party/edge
  outage: reported prominently, buyer never charged, **does NOT fail the run**, same doctrine as
  the external buyer) and **throttle**/**rate-limited** (our own burst). The pure classifiers
  (`outcomeOf`, `isUpstreamOutage`, `isThrottle`) live in `scripts/avm-canary-classify.js`
  (side-effect-free so they unit-test without booting the sweep) and are pinned by
  `scripts/test-algorand-canary-classify.js` (21, in CI). One issue, heartbeat style; a passing
  run auto-closes it. Before this, ANY blip over 500 buys kept the issue permanently open
  (#806). Identity-bound routes are
  excluded via `isIdentityBoundRoute` **imported from `src/payments.js`**, never a local
  pattern, so it can't drift from the server (a `^memory` heuristic missed `my-usage`).
  Self-buys recycle to our payTo; true cost = txn fees + per-tool upstream spend, hence
  weekly not daily. Baseline 2026-07-25: 490 buyable, 12 identity-bound, 14 over the
  $0.25/tool cap, ~$10.78 in flight.
- **External Algorand buying (`scripts/algorand-external-buy.js`, `algorand-external-buy.yml`,
  dispatch-only, **dry by default**):** pays OTHER Algorand sellers from the GoPlausible
  catalog (`src/algorand-sellers.js`) so we're a buyer on the rail, not only a seller.
  This money does NOT come back, so: hard total cap checked before every buy, per-buy cap,
  live 402 re-quote (catalog price is a hint only), USDC ASA pinned, and a self-buy guard
  that learns our own payTo from a live 402. Budget spreads one buy per seller per round,
  most-verified sellers first. First real run 2026-07-25: **$0.992 across 51 settled buys
  from 7 distinct sellers**. Expect a high non-200 rate (54 + 18 HTTP 400s, ZERO charged —
  no settle receipt) because external sellers publish no example inputs the way our bazaar
  extension does; `algo.netintel.dev` alone accounted for 42. A failed third-party buy
  never pages (their outage, not our defect).
- **Free-tier egress is a TESTED invariant, not a list
  (`scripts/test-free-tier-egress.js` + `egress-probe-preload.js`):** the free
  tier's safety rests on `WALLET_ONLY_SLUGS`, which is hand-maintained - a kit
  whose author forgets to list an egressing slug is permanently free, and the
  Brave and E2B CI-spend leaks are the evidence that hand-maintenance fails. The
  probe boots the server under a preload that enters an AsyncLocalStorage
  context per inbound request and records every fetch/http/socket/DNS/
  child_process call inside one, so background work (which has no request
  context) is ignored rather than blamed on a tool. It then drives all 222
  compute-payable tools with their own documented examples and requires ZERO
  attributed egress; a failure names the tool and the target. It self-checks
  first with a fetch-based control tool and REFUSES to report a clean run if the
  probe is blind - the first version reported nothing while working perfectly,
  because the control used node:dns and never called fetch. Verified by planting
  a real leak (removing a fetching slug from WALLET_ONLY_SLUGS), which it caught.
  `X402_INDEX_CRAWL=off` skips the index crawler: it exists for this test's
  attribution, and it also stops CI crawling thousands of third-party origins on
  every boot for nothing.
- **Image transforms run OFF the main thread (`src/tools/image-pool.js`,
  `image-worker.js`, `image-ops.js`):** Jimp decodes in pure JS and
  SYNCHRONOUSLY, and the three compute-payable image tools (resize/convert/
  thumbnail) are reachable free on the authless connector and via PoW - so a
  free caller could occupy the only thread. Measured before the fix: eight
  concurrent 16M-pixel resizes put `/health` at a 363ms median with only 7-8
  probes landing in 3.2s; after, 2ms median with ~60 probes. A 2-worker pool
  (the memory ceiling, not a throughput knob: 16M px is a 64MB RGBA bitmap per
  in-flight job), a 32-deep queue, and a 5s per-job timeout that
  `terminate()`s - the only lever that works on a thread stuck inside a
  synchronous decode. Overflow and timeout answer **503, not 400**: the input
  was fine, and a >=400 cancels settlement so nobody is charged. Primitives
  live in `image-ops.js` and are imported by BOTH sides, so output bytes and
  error strings cannot drift; `statusCode` rides back on the worker message so
  a 400 stays a 400. URL-taking image tools (exif/dominant-color/crop) stay
  inline: they are wallet-only, so payment already bounds them. Guarded by an
  offline event-loop probe in `scripts/test-image.js` and end-to-end by
  `scripts/test-image-concurrency.js`. NB the naive lag metric scored total
  starvation as a perfect 0ms because the probe callback never ran - the test
  reads the outstanding timer's lateness instead.
- **X ops (post + read, all via Actions — keys never local):** `scripts/tweet.js` is a
  dependency-free OAuth 1.0a CLI (`--text/--file/--quote/--reply-to/--media/--delete/
  --verify/--force`, `DRY_RUN=1`; secrets `X_API_KEY/X_API_SECRET/X_ACCESS_TOKEN/
  X_ACCESS_SECRET`, Actions-only). The X App is on a **PAID API plan** — we pay for
  usage. **`--reply-to` and `--quote` are RESTRICTED to posts we authored or that
  mention us.** Measured 2026-08-03, replying to a third party's announcement:
  `X API 403 {"detail":"You can only reply to or quote posts where you are
  mentioned or are the author.","title":"Authorization Error"}`. So the
  **trailing-URL trick is a real workaround, not merely a formatting choice**:
  append a status URL as the LAST line of an ordinary post and X renders a true
  quote embed, because it is plain text and never touches the restricted params
  (verified working the same day, post 2084308190158536735). To respond to
  someone else, that is the only route — there is no reply equivalent, and a
  trailing-URL post is a BROADCAST rather than a threaded reply, which is a
  different social act and needs Mike's OK on those terms.
  This entry has now been wrong in BOTH directions: it once said "Free tier:
  POST /2/tweets + GET /2/users/me only", and was then over-corrected to
  "`--reply-to` works against ANY public post … verified live 2026-07-31" on the
  strength of a single reply that must have been to a post mentioning us. Both
  claims were acted on and both failed. Do not infer the tier or the permitted
  targets from this file — a paid plan does NOT imply unrestricted replies, and
  the only reliable check is a dispatch that either posts or 403s. Reading posts: `x-read.yml` (credential-free, fxtwitter →
  vxtwitter from the runner) remains the easiest path and needs no API quota;
  the mirrors are also reachable from a local terminal. Char counting: X weighs EVERY URL at 23 chars (incl. bare
  `agent402.tools`); tweet.js's guard counts raw length, so copy that's ≤280 weighted but
  >280 raw needs `force`. **`announce.yml` dispatch (ref main) posts with NO repo
  commit** — inputs: `text` (inline copy) | `file` | `media` | `card` = `bestsellers`
  (burner buy) or `robinhood` (free /api/revenue → `scripts/robinhood-card.js`) |
  `quote`/`reply_to` (own posts only) | `delete_id` (replace flow: delete runs first) |
  `force`; every input rides an env var (N-03), never shell interpolation; a dispatch
  with neither `text` nor `file` is refused (the trigger-announce fallback is for the
  push path only, else a bare dispatch reposts stale copy). Cards render LIVE at post
  time (real-numbers doctrine; `--preview` fixture tag for layout checks only). The
  **/tweet skill** (`.claude/skills/tweet/SKILL.md`, committed via the `.gitignore`
  carve-out `!.claude/skills/`) carries the playbook + house style: no em dashes,
  evergreen counts, ALWAYS explicit user OK before any post. **Tweet copy is never
  committed** - it rides the dispatch `text` input only (docs/announcements files
  are the legacy push-trigger path; card PNGs under docs/announcements/media are
  fine to commit). No posted-tweet log or conversation state in this file.

- **Second seller-landscape wave (2026-08-22, Mike: "build everything we can serve right away and profitably; existing keys
  are fair game"):** seven more kits, all wallet-only, offline tests in CI. KEYLESS: `crawl-kit.js` (`CRAWL_TOOLS`: site-map
  $0.005 robots+sitemap+homepage links <= 6 fetches; site-crawl $0.02 BFS <= 20 pages/depth 2, robots honoured, SSRF guard on
  every hop incl. redirects, 200+truncated once a page succeeded else 504), `crypto-signals-kit.js` (`CRYPTO_SIGNALS_TOOLS`:
  crypto-news $0.004 from 8 public RSS/Atom feeds with a dependency-free parser + 5-min per-source cache; crypto-indicators
  $0.005 RSI/MACD/EMA/SMA/Bollinger/ATR/VWAP on Hyperliquid candles; crypto-market-pulse $0.004 breadth/OI/funding snapshot),
  `defi-kit.js` (`DEFI_TOOLS`, 10 tools $0.002-$0.003 on DefiLlama's FREE endpoints - yields, yield history, protocols,
  protocol, chains, chain TVL history, stablecoins, stablecoin supply history, fees, dex volume; bulk docs (pools 11MB,
  protocols 8.6MB) fetched once per 5 min and trimmed; `/bridges` and `/overview/derivatives` are 402-paywalled, not built).
  EXISTING KEYS: `crypto-markets-kit.js` (`CRYPTO_MARKETS_TOOLS`, 12 CoinGecko Demo-plan gaps at $0.005-$0.008 vs a reseller's
  $0.06 - token price by contract, coin profile/history/ohlc/range, categories, global-defi, exchanges/tickers/rates, search,
  coins-list; `top_gainers_losers` is Pro-only, skipped; 60s-10min caches), `alchemy-data-kit.js` (`ALCHEMY_DATA_TOOLS`, 6 tools
  $0.002-$0.005 on `ALCHEMY_API_KEY`: asset-transfers, token-balances (named list + capped metadata fan-out), token-allowance,
  tx-receipt (one batched RPC, transfer events decoded locally), block-receipts, token-price-history; one request per call,
  CU-bounded), `farcaster-social-kit.js` (`FARCASTER_SOCIAL_TOOLS` + `farcasterSocialEnabled()` on NEYNAR_API_KEY |
  WARPCAST_API_KEY - prod has WARPCAST only, the alias is load-bearing; listed only with a key: fc-cast-search, fc-channel-feed,
  fc-trending (trending CHANNELS - Neynar's /feed/trending no longer exists), fc-user-casts, fc-cast, fc-cast-replies,
  fc-channel, fc-user-search, fc-cast-metrics, $0.003-$0.005), and `llm-images-fast-kit.js` (`IMAGES_FAST_TOOLS` on
  OpenRouter's dedicated Image + Video APIs, flat per-image pricing, all-or-nothing billing: `/v1/images/fast` $0.02
  (flux.2-klein-4b $0.014 -> gpt-image-1-mini medium), `/v1/images/pro` $0.05 (flux.2-pro $0.03 -> qwen-image-3 1K),
  `/v1/videos/generations` $0.20 (veo-3.1-lite, 4 s locked, 720p, no audio, $0.12; submit -> poll <= 240 s -> authed
  download -> inline b64 mp4); each link re-checks the model's LIVE listed price against the bound it was priced from and is
  skipped when repriced, chain repriced end to end -> 503 with nothing spent; `v1-videos` is in `LONG_RUNNING_SLUGS`
  (server.js: EVM exact only like the composites, since it runs 40 s+ settle-after). Live measured before pricing: klein
  $0.014 / 2 s, flux.2-pro $0.030, veo-lite 4 s $0.12 / 40 s. Registration helper pattern for a new kit: import + spread in
  ALL_KIT, slugs in WALLET_ONLY_SLUGS, routes in test-all NETWORK, test step in deploy.yml; a `slug:` regex over a kit file also
  matches example INPUTS named slug (defi-kit) - derive slugs from routes.
  A key-gated tool ALSO needs its slug in `METERED_SLUGS` (`scripts/test-non-metered-examples.js`): that sweep treats a 503 as a
  HARD failure (the lenient-NETWORK hole that once hid gov-data), so a tool whose key CI deliberately lacks fails the run until it
  is excluded there like every other keyed tool. Nine such failures (alchemy-data x6, images/video x3) blocked the 2026-08-22
  wave-2 deploy.
- **Seller-landscape builds (2026-08-22, from the x402scan/MPPScan top-seller research):** four kits. KEYLESS and listed:
  `src/tools/derivatives-kit.js` (`DERIVATIVES_TOOLS`, 11 tools $0.002-$0.005: perp-markets/funding/funding-screener/
  open-interest/klines/orderbook/basis on Hyperliquid's public info API, options-summary / crypto-options-chain / options-ticker on Deribit public (finance-kit already owns `options-chain` for equities),
  options-volume on DefiLlama - its `/overview/derivatives` is paywalled 402, so only options volume ships) and
  `src/tools/solana-intel-kit.js` (`SOLANA_INTEL_TOOLS`, 9 tools $0.002-$0.01: sol-token-safety/report/holders on RugCheck
  + Jupiter audit, sol-token-pairs/search/trending on DexScreener, sol-price/swap-quote/token-lookup on lite-api.jup.ag;
  public Solana RPC getTokenLargestAccounts 429s persistently, so holders come from RugCheck). ENV-GATED (listed only with
  the key, like TTS): `src/tools/x-data-kit.js` (`X_DATA_TOOLS` + `xDataEnabled()` on `X_BEARER_TOKEN`; X API v2 app-only:
  x-search-recent $0.006, x-user $0.005, x-user-tweets $0.01, x-tweet $0.005, x-users-lookup $0.01; 429 -> 503 with the
  reset hint) and `src/tools/b2b-enrich-kit.js` (`b2bEnrichEnabled()` returns the subset whose key is present:
  hunter-domain-search/email-finder/email-verify/company on `HUNTER_API_KEY`, apollo-people-search/org-enrich/person-match
  on `APOLLO_API_KEY`; PII-stripped; $0.02-$0.05). All 32 slugs in WALLET_ONLY_SLUGS + test-all NETWORK; offline tests
  `test-derivatives-kit` (327), `test-solana-intel-kit` (169), `test-x-data-kit` (102), `test-b2b-enrich-kit` (164) in CI.
  The env keys are Mike's call (X paid plan bearer exists only in Actions secrets today; Hunter/Apollo need signups).
- **Report re-pricing (2026-08-22, Mike: "too high, be competitive"):** research $3 / pro $7 / max $12, market-brief $7,
  dossier $9 / max $19, fund $4 / max $9, domain-audit $3 / pro $5, recall $3, insider $4, token-risk $3 / pro $6, every
  monitor $5/mo. Cost basis measured in PostHog `$ai_generation` (OpenRouter): Opus synthesis p50 $0.075 / p95 $0.195 /
  max $0.31 per call, Gemini planning $0.01, so a full report costs well under $1 upstream; the kits' `maxUpstreamUsd`
  caps (1-9) are circuit breakers, all still below price. Prices live in THREE places that must move together: kit
  `*_TIERS[...].price` (x402/MPP list), `HUMAN_PRODUCTS[...].price` cents (card), `MONITOR_PRODUCTS[...].price`; docs are
  checked by `test-docs-truth` (price per slug vs live catalog). Card floor comment/test now >= $3 (Stripe min is $0.50).
- **Machine-surface sync for products + credits (2026-08-22, batch A):** `/api/pricing` carries `credits`
  (packs) + `humanProducts` (reports/monitors) next to the catalog; `/openapi.json` is 2.1.0 with
  `securitySchemes` x402 / mpp / creditsKey (bearer `a402_…`) + `x-guidance`; `/llms.txt` has credits + reports
  paragraphs (FULL paths only - `test-mcp-self-consistency` extracts every `/path` token, so shorthand like
  "/pro, /max" or a path followed by ":" reads as a route); receipts (`/r/`, `/m/`, thanks pages) send
  `X-Robots-Tag: noindex` + `<meta name="robots">` via `ledgerShell({robots})`; robots.txt Disallows them;
  sitemap lists /reports /monitors /credits; homepage FAQ is 6 Q&As (visible == JSON-LD, pinned by
  test-home-page + test-index-page); hosted (`src/mcp-flagship.js`) and stdio (`mcp/output-schemas.js`)
  initialize instructions are separate copies that `test-surface-copy` requires byte-identical - edit both.

## Environment / ops (set on Railway, not in repo)
`WALLET_ADDRESS`, `WALLET_ENS`, `NETWORK`, `CDP_API_KEY_ID/SECRET`, `FACILITATOR_URL`,
`GLAMA_MAINTAINER_EMAIL`, `POW_SECRET`, `MPP_SECRET_KEY` (MPP dual-stack shim — HMAC secret binding MPP challenge ids; presence is the rollout switch, unset = shim not mounted; also in GitHub Actions secrets, injected by the deploy job), `MPP_CHALLENGE_NETWORKS` (optional — "all" or CSV of chain ids that get MPP challenges on 402s; default Base+Celo), `TEMPO_API_KEY` (Tempo MPP relay key from Tempo's dashboard — MUST carry the `mpp:write` scope; presence + a recipient is the Tempo rollout switch, unset = no tempo challenges), `TEMPO_DATA_API_KEY` (Tempo data:read key — the MPP leaderboard's transfer-feed source; unset = RPC scan), `MPP_LB_SOURCE` (`rpc` forces the RPC scan even with the key), `TEMPO_TRANSFERS_CACHE_FILE` (default `/data/tempo-transfers.json`), `TEMPO_RECIPIENT_ADDRESS` (Tempo payTo, defaults to `WALLET_ADDRESS`), `TEMPO_CURRENCY` (TIP-20 token address, default PathUSD `0x20c0…0000`), `TEMPO_DECIMALS` (default 6), `TEMPO_API_BASE_URL` (relay override, default `https://api.tempo.xyz`; the stub seam the relay-errors test uses), `TEMPO_UPSTREAM_BUYER_KEY` (route-execute external on Tempo/MPP — the DEDICATED Tempo spending wallet's EVM private key, funded with USDC.e on Tempo (0x20C0…8b50); NEVER the treasury or the CI burner; MPP external routing is simply not offered without it), `TEMPO_UPSTREAM_BUYER_LOW_USD` (low-water for that wallet, default $0.50 → heartbeat issue), `TEMPO_RPC_URL` (default `https://rpc.tempo.xyz`; used for the proven-seller gate + balance), `SOR_TEMPO_MIN_SETTLED_TX` (proven-seller floor: inbound USDC.e transfers to the seller's recipient in the last ~15h, default 20), `SOR_TEMPO_FROM_BASE` (`true` lets Base-paying buyers fall through to Tempo/MPP sellers when no Base seller matches — spends the Tempo wallet against Base revenue, default off), `STRIPE_SECRET_KEY`+`STRIPE_PROFILE_ID` (Stripe cards-over-MPP `stripe/charge` via SPT — `src/mpp-stripe.js`, sell-side, the first non-crypto buyer path. BOTH present = rollout switch (unset → gate not mounted, no stripe challenge on any 402). The challenge-signing secret is DERIVED from `STRIPE_SECRET_KEY` (`HMAC(key,"mpp-challenge-signing")` base64) per Stripe's docs, NOT `MPP_SECRET_KEY`; profile id is the mppx `networkId`. Offered ONLY on routes ≥ $0.50 (SPT card minimum); settles a PaymentIntent to our Stripe balance post-handler on a <400 (same buffer-then-settle discipline as tempo, no relay so no confirm-fallback). Sandbox-validated end to end 2026-08-20 (`npx mppx validate --yes`). LIVE flip needs a live profile + a RESTRICTED key (PaymentIntents+Refunds write) via the deploy-job upsert, then a live $0.50 canary; `stripe` npm dep added. `scripts/test-mpp-stripe.js` (18, in CI)), `X_BEARER_TOKEN` (x-data-kit - X API v2 app-only bearer; unset = the five X tools are not listed), `HUNTER_API_KEY` / `APOLLO_API_KEY` (b2b-enrich-kit - each provider's tools list only with its key), `BRAVE_API_KEY` (search-kit Web/News/Images — **CI SPENDS THIS**: the test job boots the server with the real key and FREE_MODE, so any sweep reaching a Brave-backed handler buys a live query, and the CI server has no PostHog, making those calls invisible to every inbound accounting surface. `scripts/test-all.js` BRAVE_ROUTES skips the direct routes AND every skill pack whose steps invoke one; `scripts/test-brave-leak.js` fails CI if a Brave-reaching pack is missing from that set. Measured cost of the gap: ~11.4 Brave requests per CI run before the 2026-07-23 audit, ~2.3 after it (three packs added later), and 0 since 2026-08-02 - the "~0" claimed here in between was never measured and was really 2, leaking via `research-company` (a research-kit tool that calls the search-news HANDLER in-process) and the `financial-research` pack composing it; neither names a Brave slug, so both slug-based guards cleared them. `test-brave-leak.js` now resolves reach through KITS, not slug names, and 0 is measured with an outbound counter whose sight is proven by a control call before any zero is believed — about 4,500 of July's 5,106 billed Search requests were CI, not customers), `BRAVE_ANSWERS_API_KEY` (search-kit `answer` — distinct subscription token from Brave; falls back to `BRAVE_API_KEY` if unset), `BRAVE_SUGGEST_API_KEY` (search-kit `search-suggest` — distinct suggest subscription; falls back to `BRAVE_API_KEY` if unset), `NEYNAR_API_KEY` (onchain-identity-kit Farcaster tools — Neynar API; falls back to `WARPCAST_API_KEY`), `FRED_API_KEY` (macro-kit v1), `FRED_API_KEY_V2` (macro-kit v2 bulk release/observations — distinct key from v1), `DATA_GOV_API_KEY` (gov-kit `gov-data` — data.gov Catalog API v4 via api.gsa.gov/technology/datagov/v4/search; also College Scorecard + FEC; falls back to the rate-limited public `DEMO_KEY` if unset), `COINGECKO_API_KEY` (crypto-kit — CoinGecko Demo key sent as `x-cg-demo-api-key`; keyless fallback works but shares the per-IP rate limit with other Railway tenants), `YAHOO_RELAY_URL`+`YAHOO_RELAY_TOKEN` (finance-kit — optional CF Worker relay for Yahoo's chart endpoint; bypasses Railway egress null-route. See `workers/yfinance-relay/`. Both must be set; falls back to direct Yahoo if unset), `NASDAQ_RELAY_URL`+`NASDAQ_RELAY_TOKEN` (finance-kit — optional CF Worker relay for Nasdaq's calendar endpoint; bypasses Railway egress null-route. See `workers/nasdaq-relay/`. Both must be set; falls back to direct Nasdaq if unset), `SEI_RELAY_URL`+`SEI_RELAY_TOKEN` (revenue surfaces — CF Worker relay for Sei's EVM JSON-RPC; evm-rpc.sei-apis.com errors every eth_getLogs from Railway's egress IPs while the only public alternative archive-gates getLogs. See `workers/sei-rpc-relay/` (POST-only, read-method allowlist, Bearer-gated). Both must be set; falls back to direct Sei RPCs if unset), `ALGORAND_RELAY_URL`+`ALGORAND_RELAY_TOKEN` (revenue surfaces — CF Worker relay for Nodely's Algorand algod/indexer; Nodely 403s Railway's egress IP outright and both direct fallbacks are Nodely-operated. See `workers/algorand-relay/`. Both must be set; falls back to direct Nodely if unset), `OPENAI_API_KEY` (llm-kit + image-gen-kit — OpenAI proxy), `OPENROUTER_API_KEY` (LLM gateway `/v1/*` tiers — OpenRouter upstream; routes 503 without it), `OPENROUTER_MANAGEMENT_KEY` (OpenRouter management/provisioning key — set on Railway 2026-08-19; the documented credential for `/credits`, so `gatewayCreditsStatus` reads the balance leg with it when set and falls back to the API key otherwise; NEVER used for `/key`, which must describe the prod key's own $250/month limit; it can list/limit/disable API keys via `/api/v1/keys`, which is how the prod key's limit was set — raising that limit stays a human act, never automated), `E2B_API_KEY` (code-run-kit — E2B sandbox. **CI SPENDS THIS** — same class as Brave: the key sits at test-job scope, so until 2026-07-29 test-all's sweep spun two real sandboxes per run; now `E2B_ROUTES` skips them (opt-in `E2B_LIVE_TEST=1`), live coverage stays in the dedicated test-code-run-kit step, and `scripts/test-brave-leak.js` guards both Brave and E2B structurally), `X402_UPSTREAM_BUYER_KEY` (blockscout-kit `contract-inspect`/`address-profile` — the server's DEDICATED x402 SPENDING wallet (0x7706…4121, fund with ~\$5 USDC on Base), pays Blockscout's Pro API \$0.002/call upstream; NEVER the treasury or the CI burner; tools 503 without it; margin guard refuses upstream quotes over \$0.005), `ALGORAND_UPSTREAM_BUYER_MNEMONIC` (route-execute external on Algorand — a DEDICATED AVM spending hot wallet's 25-word mnemonic; must be opted in to USDC ASA 31566704 and hold a little ALGO for fees; NEVER the treasury or the CI burner; Algorand external routing 409s without it; rides the Algorand relay for algod when `ALGORAND_RELAY_URL/TOKEN` are set), `ALGORAND_UPSTREAM_BUYER_ADDRESS` (the AVM spending wallet's PUBLIC address — a repo VARIABLE injected by the deploy job, same pattern as `X402_UPSTREAM_BUYER_ADDRESS`. Set: route-execute's Algorand legs settle to the AVM spending wallet, chain-matched self-funding closing the loop like Base — router tiers ONLY, Blockscout keeps the treasury because its upstream spend is Base-pinned. Unset = Algorand revenue keeps the treasury payTo. Inbound to it is scanned as revenue via `algorandExtraWallets`; never case-fold it), `BASE_BUILDER_CODE` (Base Builder Code for onchain attribution — from dashboard.base.org; env-gated no-op if unset), `BASE_NOTIFICATIONS_API_KEY` (Base Notifications API — from Base Dashboard; enables push notifications to users who pinned the app; env-gated no-op if unset), `GOOGLE_SITE_VERIFICATION` (Search Console HTML-tag verification token — rendered as a meta tag in the shared ledger head; env-gated no-op if unset), `INDEXNOW_KEY` (IndexNow ownership key — serves /{key}.txt and enables scripts/indexnow-submit.js instant-indexing pings to Bing/Copilot/DDG/Yahoo; env-gated no-op if unset), `SOLANA_WALLET_ADDRESS` (Solana payTo address for USDC on Solana), `ALGORAND_WALLET_ADDRESS` (Algorand payTo address for USDC on Algorand — must be opted in to ASA 31566704 or settlement fails on-chain), `ALGORAND_FACILITATOR_URL` (optional override for the GoPlausible-hosted AVM facilitator; default `https://facilitator.goplausible.xyz`), `CELO_FACILITATOR_URL` (optional override for the Celo-operated x402 facilitator; default `https://api.x402.celo.org` — advertises `exact/eip155:42220`. Celo USDC `0xcebA9300f2b948710d2653dD7B07f33A8B32118C` has on-chain EIP-712 name "USDC" (not "USD Coin"), handled by the money parser in `src/payments.js`), `CELO_FACILITATOR_KEY` (REQUIRED to offer the Celo rail — the facilitator's /supported+/verify are keyless but /settle 401s without an X-API-Key, so payments.js drops Celo from the offer when unset. Free self-service: sign a no-gas SIWE-style message at x402.celo.org → POST /api/keys mints an `x402_…` key, shown once, rotatable on the same page; NOT payTo-bound — the current key was minted 2026-07-20 with a throwaway signer), `ROBINHOOD_FACILITATOR_URL` (required to enable the Robinhood/USDG rail — no default baked in; set to `https://facilitator.naven.network` (Naven, the first x402 facilitator on Robinhood Crypto — keyless, advertises `exact/eip155:4663` + Base at `/supported`, verified settling USDG 2026-07-17). Swapped from the prior `mpp.hyreagent.fun/r402`, which began rejecting settles 2026-07-16), `OUR_ALGORAND_WALLETS` (optional comma-separated override of the internal/canary Algorand burner set used to classify revenue), `ALGORAND_BURNER_MNEMONIC` (GitHub Actions secret only — 25-word mnemonic for the Algorand leg of `scripts/paid-canary.js`; never set on Railway), `AGENT402_OPERATOR_TOKEN` (operator auth for `/__operator/*` and `POST /api/status/probe`. Set on Railway. **Must ALSO be a GitHub Actions secret** — `charged-failure-alert.yml` (reads the charged-failure log), `status-backfill.yml`, and the heartbeat's status-probe step all need it; without it the charged-failure alarm fails loudly by design, because silently skipping is exactly what hid it being dead for months. `wish-issues.yml` also references it but is gated off by the `WISH_ISSUES_ENABLED` repo variable, which is why the gap went unnoticed), `PAYAI_API_KEY_ID`+`PAYAI_API_KEY_SECRET` (PayAI facilitator auth — optional, free tier 10k settlements/month needs no keys; get at merchant.payai.network), `PAYAI_FACILITATOR_URL` (optional PayAI URL override — parity with every other `*_FACILITATOR_URL`; the stub seam `scripts/test-supported-guard.js` boots against, never set in prod), `X402_SUPPORTED_GUARD` (`off` disables the boot /supported guard that drops networks no reachable facilitator advertises — escape hatch only, default on), `PAYMENT_NETWORKS` (comma-separated chains to accept — default is the primary network only; e.g. `base,solana,polygon,arbitrum,stellar,algorand,monad,celo,avalanche,sei,optimism,robinhood`; CDP facilitator handles Base, PayAI handles Solana/Polygon/Arbitrum/Avalanche/Sei, Solvador handles Optimism (keyed, network-filtered primary), and Monad/Celo/Robinhood ride their dedicated facilitators), `WALLET_BLOCKLIST` (comma-separated wallet addresses refused service — enforced by a beforeSettle abort in `src/payments.js`, so a blocked wallet is never charged; the 402's receipt carries errorReason `wallet_blocked` and the tally records a `settle_failed` event. Call-time read; the /terms enforcement section is the policy this implements), `NETWORK_PRICE_PREMIUMS` (per-chain price premiums, CAIP-2 keyed CSV e.g. `eip155:10=0.001` — adds the facilitator fee to that chain's 402 accepts quote so fee-charging rails are priced in structurally while fee-free rails stay at list; unset = byte-identical accepts, negative/malformed entries refused loudly; integer micro-dollar arithmetic; `scripts/test-price-premium.js`), `SQL_CERT_SIGNING_KEY` (sql-guard's Ed25519 signing identity, PKCS8 PEM with literal \n escapes — the key that certifies a SQL statement passed policy. Env-gated no-op: unset, sql-guard still returns full verdicts and says plainly it cannot certify, never an unsigned object shaped like a certificate. Rotating it invalidates outstanding certificates, which live 5 minutes by default), `SOLVADOR_KEY` (Solvador facilitator API key — dashboard.solvador.com, pay-as-you-go: first 1,000 settlements/month free then $0.001. Enables Solvador as the LAST settle-fallback candidate; fallback-only, never a primary route. The only second facilitator covering Celo/Monad/Robinhood. Anything routed through a fee-charging facilitator as a PRIMARY must be priced to cover the fee — see the per-chain accepts pricing rule; fallback settles of existing quotes are fine, the free tier covers them), `SOLVADOR_FACILITATOR_URL` (optional override, default `https://api.solvador.com`), `PAYMENT_SETTLE_FALLBACK` (`true` to re-settle via the fallback chain — PayAI, then Solvador when `SOLVADOR_KEY` is set; PayAI is skipped on networks it cannot settle, so Celo/Monad/Robinhood go straight to Solvador — when the primary facilitator rejects settlement BEFORE broadcasting — an HTTP 402 such as CDP's `payment-method-required` billing gate; never on timeout/5xx, so it can't double-settle. Default off: Base stays purely on CDP for Bazaar + fee-free settlement. Turn on for never-miss-a-sale insurance against a CDP billing lapse. Facilitator verify/settle failures are always logged loudly regardless via `onVerifyFailure`/`onSettleFailure` hooks). Never commit secrets or wallet keys.

## This sandbox vs. prod
The Claude Code **web** environment has an egress allowlist (npm + GitHub reachable;
`agent402.tools`, `basescan.org`, `glama.ai` are **blocked**). Verify prod via CI
(`[probe]`, heartbeat, canary) or a local terminal (full network). npm registry is reachable for `npm view`.
