# agent402-tollbooth

**Open-source, self-hostable x402 "pay-per-crawl". Put it in front of any site or
API: humans browse free, AI crawlers and agents pay per request** - either in
USDC over the [x402 protocol](https://x402.org), or for free by solving a
proof-of-work. No Cloudflare, no Stripe, no Merchant-of-Record, no signup.

The big platforms are converging on the same model: Cloudflare's
[pay-per-crawl](https://stackoverflow.blog/2026/02/26/how-pay-per-crawl-is-reshaping-data-monetization/)
and now its [Monetization Gateway](https://blog.cloudflare.com/monetization-gateway/)
(launched July 2026 - x402 charging in USDC on Base for anything behind Cloudflare:
pages, APIs, datasets, MCP tools) confirm that pay-per-request is the business model
of the agentic web. Tollbooth is the **open-source monetization gateway**: the same
idea, but MIT-licensed and live today, running in
front of *any* origin (even a Cloudflare Worker), non-custodial (you hold the wallet,
no signup or Merchant-of-Record), and - the wedge the platform gateways don't offer -
with a **proof-of-work free tier** so a walletless agent still has a path through.
Built on the same hardened 402 + proof-of-work machinery as
[Agent402](https://github.com/MikeyPetrillo/Agent402).

## See it work (one command)

```bash
npx agent402-tollbooth   # then, in the repo:  npm run --prefix tollbooth demo
```

```text
agent402-tollbooth - live pay-per-crawl demo

① A human opens the page (normal browser)
   → HTTP 200 FREE  "📄 The Future of Machine Payments - full article text…"
   Humans are never charged.

② An AI crawler hits the same page (ClaudeBot)
   → HTTP 402 Payment Required
   pay with USDC: $0.002 USDC on base → 0x…
   …or free with proof-of-work: a 18-bit sha256 puzzle

③ The crawler has no wallet, so it spends CPU instead
   solved in 0.32s (nonce=100208)
   → HTTP 200 OK (paid via pow)  "📄 The Future of Machine Payments - full article text…"

✓ Pay-per-crawl, end to end - humans free, bots pay (USDC or compute).
```

## Install

```bash
npm install agent402-tollbooth
```

## Use it as Express middleware

```js
import express from "express";
import { createTollbooth } from "agent402-tollbooth";

const app = express();

// Humans pass through; known AI crawlers get 402 and must pay or solve a PoW.
app.use(createTollbooth({ price: "$0.002" }));

app.get("/article", (_req, res) => res.send("…your content…"));
app.listen(3000);
```

```bash
curl -A "Mozilla/5.0" localhost:3000/article     # human  -> 200, free
curl -A "ClaudeBot/1.0" localhost:3000/article   # bot    -> 402 Payment Required
```

The 402 body advertises both rails:

```jsonc
{
  "error": "Payment Required",
  "message": "…humans browse free; bots pay in USDC via x402 or by solving a proof-of-work.",
  "accepts": [{ "scheme": "exact", "network": "base", "maxAmountRequired": "$0.002", "asset": "USDC", "payTo": "0x…", "resource": "/article" }],
  "proofOfWork": { "algorithm": "sha256", "challenge": "…", "difficulty": 18, "token": "…", "rule": "Find a nonce so sha256(challenge+\":\"+nonce) has >= 18 leading zero bits; resend with header X-Pow-Solution: <token>:<nonce>" }
}
```

A crawler that can't (or won't) pay USDC solves the puzzle and retries with
`X-Pow-Solution: <token>:<nonce>` - sub-second of CPU, single-use, bound to that
exact URL.

## Use it as a reverse proxy (any language/framework)

Point it at your existing site - no code changes there:

```bash
TOLLBOOTH_UPSTREAM=https://your-site.com \
TOLLBOOTH_PAYTO=0xYourWallet \
npx agent402-tollbooth          # listens on :4021, proxies humans free, charges bots
```

## Run on the edge (Cloudflare Workers, Next.js, Deno, Bun)

The same gate is also built on the Web Crypto + Fetch APIs (`edge.js`), so it runs
anywhere - no Node required. The gate returns a `402 Response` when the client
must pay, or `null` to let it through.

**Ready-to-deploy templates** (copy a folder, don't assemble from docs):

- **Cloudflare Workers** → [`deploy/cloudflare/`](deploy/cloudflare/) - a ready
  `wrangler.toml` + a 3-step deploy guide (the open pay-per-crawl, on the
  incumbent's own platform).
- **Next.js / Vercel** → [`deploy/nextjs/`](deploy/nextjs/) - a drop-in
  `middleware.js` + a 3-step deploy guide.
- **Docker** → [`deploy/docker/`](deploy/docker/) - a `Dockerfile` +
  `docker-compose.yml` to run the reverse proxy in front of any site with
  `docker compose up -d` (includes the live `/__tollbooth` dashboard).

The short version of each:

```toml
# wrangler.toml  (full template: deploy/cloudflare/wrangler.toml)
name = "tollbooth"
main = "node_modules/agent402-tollbooth/worker.js"
compatibility_date = "2026-01-01"
[vars]
TOLLBOOTH_UPSTREAM = "https://your-origin.example.com"
TOLLBOOTH_PAYTO    = "0xYourWallet"   # optional: advertise a USDC x402 quote
# npx wrangler secret put TOLLBOOTH_SECRET
# optional single-use replay store:  [[kv_namespaces]] binding = "TOLLBOOTH_KV"
```

```js
// middleware.js  (full template: deploy/nextjs/middleware.js)
import { NextResponse } from "next/server";
import { createEdgeTollbooth } from "agent402-tollbooth/edge";
const gate = createEdgeTollbooth({ secret: process.env.TOLLBOOTH_SECRET });

export async function middleware(req) {
  return (await gate(req)) ?? NextResponse.next();
}
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
```

**Any Fetch-API runtime** (Deno, Bun, custom): `const gate = createEdgeTollbooth({ secret }); const blocked = await gate(request); return blocked ?? fetch(request);`

> On the edge, pass a stable `secret` (PoW tokens are HMAC-signed). For
> single-use replay protection across stateless invocations, supply a `store`
> (e.g. a Cloudflare KV wrapper - the Worker entry wires this for you).

## Accepting USDC (x402)

The proof-of-work rail works with **zero config**. To also settle real USDC,
set `payTo` and supply `verifyX402` - wire it to the standard, audited x402
server stack (`@x402/express` / your facilitator) rather than reinventing
settlement:

```js
import { createTollbooth, x402VerifierFromExpress } from "agent402-tollbooth";
import { paymentMiddleware } from "x402-express"; // or @x402/express
const x402 = paymentMiddleware(/* your wallet + facilitator config */);

app.use(createTollbooth({
  payTo: "0xYourWallet",
  network: "base",
  // First-party verifier that OWNS timeout + cancellation: it honors the
  // AbortSignal the gate passes on the SECOND argument (opts.signal), so a slow
  // middleware can't hang the gate or settle after the gate already returned 402.
  verifyX402: x402VerifierFromExpress(x402, { timeoutMs: 9000 }),
}));
```

The gate calls `verifyX402(req, opts)` and puts an `AbortSignal` on `opts.signal`
(aborted when its `TOLLBOOTH_VERIFY_TIMEOUT_MS` fires). `x402VerifierFromExpress`
honors it and stops treating a late result as valid. Note @x402/express settles
by broadcasting and has no cancel hook, so keep the timeout above your settle
latency (the abort is a backstop); a verifier that ignores the signal entirely
can still charge a buyer who already received a 402. If you write your own
verifier instead of using the helper, destructure `opts.signal` and reject/stop
on abort. (PoW is checked first, so an agent without a wallet always has a free path.)

## Configuration

| Option | Default | What |
|---|---|---|
| `price` | `"$0.001"` | Advertised price per request (x402 quote) |
| `payTo` | – | Wallet address; set to advertise a USDC x402 quote |
| `network` | `"base"` | x402 network |
| `pow` | `true` | Enable the free proof-of-work rail |
| `powDifficulty` | `18` | PoW difficulty in leading zero bits (~0.1–0.5s of CPU) |
| `mode` | `"bots"` | Who pays: `"bots"` (AI-crawler UAs) · `"all"` (everyone but `free()`) · `"strict"` (anything that isn't a real-browser request) |
| `adaptive` | `false` | Raise PoW difficulty as charged-request load climbs (anti-abuse under traffic spikes) |
| `maxDifficulty` | `base+6` | Ceiling for adaptive difficulty |
| `adaptivePerBit` | `300` | +1 difficulty bit per N charged requests/min |
| `botUserAgents` | `AI_BOTS` | User-agents to charge in `"bots"` mode |
| `charge(req)` | mode | Custom "should this client pay?" predicate (wins over `mode`) |
| `free(req)` | – | Custom force-allow predicate (wins over everything) |
| `verifyX402(req, reqs)` | – | Async USDC settlement check (return `true` to allow) |
| `resourceBaseUrl` | `""` | Absolute base used for the `resource` field / PoW binding |
| `observe` | `false` | Observe-only: classify and count, but never 402. For pre-launch traffic measurement. |
| `statsSink` | in-memory | Durable stats backend. Built-ins: `memorySink`, `kvStatsSink(kv)`, `httpStatsSink(url)`. |
| `replayStore` | **this process's memory** | Shared single-use record for solved proof-of-work tokens. Required for multi-worker / multi-instance / serverless. Built-ins: `sqliteReplayStore(db)`, `redisReplayStore(client)`. See below. |

### Environment variables

Read by the bundled proxy / Express entry point (`index.js`):

| env | default | meaning |
|---|---|---|
| `TOLLBOOTH_UPSTREAM` | – | Origin the built-in reverse proxy forwards to |
| `TOLLBOOTH_PAYTO` | – | Wallet address; set to advertise a USDC x402 quote |
| `TOLLBOOTH_PRICE` | `"$0.001"` | Advertised price per request |
| `TOLLBOOTH_NETWORK` | `"base"` | x402 network |
| `TOLLBOOTH_ASSET` | `"USDC"` | Asset symbol in the quote (`USDG` charges in USDG on Robinhood Chain) |
| `TOLLBOOTH_POW_BITS` | `18` | Proof-of-work difficulty in leading zero bits |
| `TOLLBOOTH_MODE` | `"bots"` | Who pays: `bots` · `all` · `strict` |
| `TOLLBOOTH_ADAPTIVE` | `false` | Raise PoW difficulty as charged-request load climbs |
| `TOLLBOOTH_ADAPTIVE_PER_BIT` | `300` | +1 difficulty bit per N charged requests/min |
| `TOLLBOOTH_SECRET` | random | HMAC secret binding PoW challenges (set it to survive restarts / run multiple instances) |
| `TOLLBOOTH_REPLAY_SQLITE` | – | Path to a SQLite file every process shares as the single-use PoW record. Set it whenever more than one process serves the same `TOLLBOOTH_SECRET`. Needs Node 22.5+ (built-in `node:sqlite`) or an installed `better-sqlite3`; refuses to start if neither can open the file |
| `TOLLBOOTH_RESOURCE_BASE` | `TOLLBOOTH_UPSTREAM` | Absolute base used for the `resource` field / PoW binding |
| `TOLLBOOTH_VERIFY_TIMEOUT_MS` | `10000` | Abort an x402 settlement check after this long |
| `TOLLBOOTH_OBSERVE` | `false` | Observe-only: classify and count, never 402 |
| `TOLLBOOTH_ADMIN_TOKEN` | – | Token gating the `/__tollbooth` dashboard **and** `/__tollbooth/stats`. Unset logs a warning and leaves the dashboard publicly reachable (aggregate counts only) |
| `TOLLBOOTH_STATS_TOKEN` | – | Legacy token gating `/__tollbooth/stats` only |
| `PORT` | `4021` | Listen port |

Cloudflare Worker only (`worker.js`, bound in `wrangler.toml`):

| binding / env | meaning |
|---|---|
| `TOLLBOOTH_REPLAY` | Durable Object binding giving **atomic**, strict single-use PoW replay protection across isolates. Required in enforcing mode |
| `TOLLBOOTH_ALLOW_NON_ATOMIC_REPLAY` | `"true"` explicitly accepts non-atomic (KV or per-isolate) replay protection instead of a Durable Object. Without it, enforcing mode refuses to start |
| `TOLLBOOTH_KV` | KV namespace for durable stats |
| `TOLLBOOTH_STATS_BUCKET` | Stats bucket name within `TOLLBOOTH_KV` (default `"default"`) |

## How it decides who pays

By default (`mode: "bots"`) it charges requests whose `User-Agent` matches a known
**AI/LLM crawler** (GPTBot, ClaudeBot, CCBot, PerplexityBot, Bytespider,
Google-Extended, Amazonbot, …). Classic search indexers (Googlebot, Bingbot) are
intentionally **not** charged so your SEO indexing stays free.

**Don't want to play whack-a-mole with bot detection?** That's the point of the
other modes - you stop trying to *identify* bots and instead make access *cost
something*:
- `mode: "all"` charges every client (except a `free()` match). A "more
  sophisticated" bot gains nothing by disguising itself - everyone pays or solves
  a proof-of-work.
- `mode: "strict"` charges anything that isn't a real-browser request (browser-like
  UA **and** an HTML `Accept`), letting genuine human page-loads through free.
  Heads-up: that's a heuristic, not a security boundary - a bot that sets
  `User-Agent: Mozilla/5.0 …` + `Accept: text/html` gets the same free pass a
  human gets. Use `mode: "all"` (or your own `charge:` predicate) for hard
  guarantees.
- `adaptive: true` makes proof-of-work **harder as load climbs**, so a high-volume
  scraper pays escalating CPU per request regardless of how it looks - detection is
  cat-and-mouse, economics isn't.

## Observe before charging

Don't want to flip a meter on cold? **Run the gate in observe-only mode for a
week first** - every request is still classified (bot vs. human) and counted,
but nothing ever gets a 402:

```js
app.use(createTollbooth({ observe: true })); // or: TOLLBOOTH_OBSERVE=true
```

On the edge / Cloudflare Worker / Next.js: set `TOLLBOOTH_OBSERVE=true` in env.

The dashboard grows a **"Would charge"** counter so you can show your team -
or your client - exactly how much of their traffic is AI bots **before** you
start returning 402s. Removing the flag flips on enforcement with no other
changes. Bots see a `X-Tollbooth-Observed: would-charge` header in observe mode
(handy for log filtering); humans see nothing.

## Analytics

The middleware keeps aggregate counters (no per-request data):
- `gate.stats()` → sync, in-process mirror: `{ requests, freeAllowed, wouldCharge, charged, powSolved, x402Paid, difficultyNow, observe }`.
- `gate.snapshot()` → async, reads from the configured durable sink (defaults to memory).
- `gate.flush()` → flush any buffered deltas to the durable sink (call inside `ctx.waitUntil` on edge runtimes).

The reverse-proxy CLI exposes them as JSON at **`/__tollbooth/stats`** and as a
live **dashboard at `/__tollbooth`** - requests, how many were charged,
proof-of-work solves, USDC collected, and what share of your traffic is bots.

## Durable stats (survive restart, aggregate across instances)

By default, stats live in process memory - fine for single-instance Node,
useless across multiple replicas or on the edge. Pass a `statsSink` to make
them survive:

```js
// Cloudflare Workers: aggregate across all isolates using the same KV namespace
// that holds the PoW single-use store.
import { createEdgeTollbooth, kvStatsSink } from "agent402-tollbooth/edge";
const gate = createEdgeTollbooth({
  secret: env.TOLLBOOTH_SECRET,
  statsSink: kvStatsSink(env.TOLLBOOTH_KV, { bucket: "default" }),
});
// inside fetch():
ctx.waitUntil(gate.flush()); // make sure deltas land in KV after the response
```

```js
// Any Node deploy: POST batched deltas to a tiny collector (Vercel KV /
// Upstash / your own API).
import { createTollbooth, httpStatsSink } from "agent402-tollbooth";
app.use(createTollbooth({
  statsSink: httpStatsSink(process.env.TOLLBOOTH_STATS_URL, {
    token: process.env.TOLLBOOTH_STATS_TOKEN,
  }),
}));
```

Sink interface (build your own - e.g. a Cloudflare Durable Object for strict
consistency):

```ts
type StatsSink = {
  incr(field: string, n?: number): void;        // fire-and-forget
  flush?(): Promise<void>;                       // optional explicit flush
  snapshot(): Promise<Record<string, number>>;   // aggregated view
};
```

## Single-use proof-of-work across workers and instances (`replayStore`)

**The default single-use record lives in ONE PROCESS'S MEMORY.** Read that
sentence twice if you run more than one process, because the two settings
interact:

- A stable `TOLLBOOTH_SECRET` is what makes a token minted by worker 1 verify on
  worker 2. Without it, multi-process deploys reject every solution.
- With it, and with no shared replay store, each process keeps its own
  "already used" list. One 18-bit solve is then redeemable **once per process**
  inside the token's 5-minute TTL, and again after a worker recycles. Four
  workers means four requests for one solve.

Pass a `replayStore` and every process claims against the same record:

```js
// Several Node workers on one host (cluster, pm2, one container with N processes).
import Database from "better-sqlite3";                 // or node:sqlite on Node 22.5+
import { createTollbooth, sqliteReplayStore } from "agent402-tollbooth";

const db = new Database("/var/lib/tollbooth/replay.db");
db.pragma("journal_mode = WAL");     // concurrent writers
db.pragma("busy_timeout = 5000");    // wait for the write lock instead of throwing

app.use(createTollbooth({ replayStore: sqliteReplayStore(db) }));
```

```js
// Instances across hosts, or a serverless runtime that can reach Redis.
import { createClient } from "redis";
import { createTollbooth, redisReplayStore } from "agent402-tollbooth";

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();
app.use(createTollbooth({ replayStore: redisReplayStore(redis) }));
```

`redisReplayStore` also accepts an ioredis client (their `SET` signatures differ;
the factory detects which one it was handed). Neither driver is a dependency of
this package: you pass a client you already opened, so the tollbooth still
installs with nothing but Express.

The bundled reverse proxy takes the SQLite path from the environment, so the CLI
needs no code:

```bash
TOLLBOOTH_SECRET=$(openssl rand -hex 32) \
TOLLBOOTH_REPLAY_SQLITE=/var/lib/tollbooth/replay.db \
TOLLBOOTH_UPSTREAM=https://your-origin.example \
npx agent402-tollbooth
```

Store interface (build your own against Postgres, DynamoDB, a Durable Object -
this is the same contract the edge gate's `store` option uses, so an
implementation ports between the two unchanged):

```ts
type ReplayStore = {
  // MUST be atomic: true only the first time this token is seen, false after.
  claim(token: string, expiresAtMs: number): boolean | Promise<boolean>;
};
```

Three things worth knowing before you write one:

- **It may be async.** `claim` can return a promise; `verify()` then returns a
  promise too, and the gate awaits it. A synchronous store keeps the gate
  synchronous, so existing single-process deploys are unaffected.
- **A throw is a refusal, not a pass.** If `claim` throws or rejects, the gate
  answers `402` with `X-Pow-Error: replay store unavailable`. Let your store
  throw when its backend is unreachable - guessing "probably unused" would hand
  out exactly the free passes the store exists to stop.
- **Non-atomic is not enough.** A separate "read, then write" pair lets two
  concurrent redemptions of one token both see "unseen" and both pass. SQLite's
  `INSERT OR IGNORE` on a primary key and Redis `SET NX` are atomic; a plain
  eventually-consistent key/value `get` + `put` is not.

Scope note: the SQLite store's guarantee is per **database file**, which covers
many processes sharing a disk. It does not cover hosts sharing a network
filesystem (SQLite locking is not reliable there) - use Redis or Postgres for
that shape.

## Edge analytics (Cloudflare Worker / Next.js)

The Cloudflare Worker entry (`worker.js`) auto-mounts both the dashboard and
JSON endpoint, BEFORE the gate so they're never paywalled:

- **`/__tollbooth`** → live dashboard
- **`/__tollbooth/stats`** → JSON snapshot (gate with `TOLLBOOTH_STATS_TOKEN` for bearer-auth)

With a `TOLLBOOTH_KV` namespace bound, the stats aggregate across all isolates
of all Cloudflare colos serving the Worker - one consistent view.

On Next.js / Vercel Edge, middleware can't mount dashboards itself (it'd gate
them), so a companion **route handler** at `app/__tollbooth/stats/route.js`
serves the JSON; a static **page** at `app/__tollbooth/page.jsx` renders the
dashboard HTML. Both are in [`deploy/nextjs/middleware.js`](deploy/nextjs/middleware.js)
as drop-in copyable snippets.

## Production checklist (read this)

- **Set a stable `TOLLBOOTH_SECRET`.** Required for any multi-process/clustered
  Node deploy and for all edge deploys - without it, proof-of-work tokens use a
  random per-process secret and are rejected across restarts/workers/isolates.
- **If more than one process shares that secret, supply a `replayStore`.** The
  default single-use record is per process, so a stable secret plus no shared
  store means one solve buys one free request per worker within its TTL. Node:
  `replayStore: sqliteReplayStore(db)` / `redisReplayStore(client)`, or
  `TOLLBOOTH_REPLAY_SQLITE=<path>` for the bundled proxy
  ([details](#single-use-proof-of-work-across-workers-and-instances-replaystore)).
- **For serverless/edge, supply a durable replay `store`** (bind a Durable Object
  as `TOLLBOOTH_REPLAY` for atomic claims; KV is eventually consistent and the
  Worker entry refuses to enforce on it without an explicit override). The
  in-memory default is per-isolate, so a solved token could otherwise be reused
  across isolates within its TTL.
- **The reverse proxy pins the host** to your configured upstream (a client can't
  redirect it elsewhere) and **strips client-forged trust/forwarding headers**
  (`X-Tollbooth-Paid`, `X-Forwarded-Host`, etc.) before forwarding.
- **UA matching is the default, not a security boundary** - a bot can forge a
  human UA to get the *same free access a human gets* (it gains nothing more). To
  stop relying on detection entirely, use `mode: "all"` / `mode: "strict"`, and
  turn on `adaptive` so high-volume abuse pays escalating proof-of-work.

## Notes

- Proof-of-work tokens are HMAC-signed, expiry-checked, single-use, and bound to
  the exact resource (path + query, dots and all) - a solution for one URL can't
  be replayed or reused on another. Single-use is recorded **per process** unless
  you pass a `replayStore`.
- MIT licensed. Part of [Agent402](https://github.com/MikeyPetrillo/Agent402).

## Charge in USDG on Robinhood Chain

The quote's network and asset are operator-configured, so the gate can charge
crawlers in **USDG (Global Dollar) on Robinhood Chain** (chain id 4663)
instead of USDC:

```bash
TOLLBOOTH_PAYTO=0xYourWallet \
TOLLBOOTH_NETWORK=eip155:4663 \
TOLLBOOTH_ASSET=USDG \
npx agent402-tollbooth
```

or in code: `createTollbooth({ payTo, network: "eip155:4663", asset: "USDG", verifyX402 })`.
Wire `verifyX402` to an x402 facilitator that settles chain 4663. Defaults
are unchanged (USDC on Base).

## Legal

Use of the hosted instance at agent402.tools is subject to its [Terms of Service](https://agent402.tools/terms) (acceptable-use policy included) and [Privacy Policy](https://agent402.tools/privacy). This package is MIT-licensed; the hosted server is AGPL-3.0. Both are provided as-is without warranty, and self-hosted deployments are their operator's responsibility.
