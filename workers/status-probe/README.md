# status-probe

Cloudflare Worker that observes `agent402.tools` from outside production every
5 minutes and records the result on `POST /api/status/probe`, which is what
`/status` renders.

## Why

`/status` is only as trustworthy as its observer, and the observer used to be a
single GitHub Actions schedule. GitHub delivers a `*/15` cron **roughly once an
hour** (measured 2026-07-27: 60-72 minute gaps, plus one 3.3 hour stall). The
staleness threshold for these components is 45 minutes, so a completely healthy
production kept reporting "degraded" simply because nobody was looking.

The heartbeat now re-probes several times within each run, which handles routine
throttling. This Worker handles the case that cannot fix: GitHub not running at
all. Cloudflare cron is a separate scheduler on separate infrastructure, so a
GitHub incident and a Cloudflare incident are not the same event.

## What it checks

`api` (health), `catalog` (route count above the floor), `mcp` (connector
handshake), `paywall` (an unpaid call still 402s), `rails` (Base still in the
402 offer).

It deliberately does **not** run the paid-call probe. That needs a 16-bit
proof-of-work solve plus an `X-Heartbeat-Token` minted from `POW_SECRET`.
Copying that secret to a second platform widens its blast radius, and without it
every probe would count as real external free-tier demand: 288 synthetic calls a
day against roughly 130 genuine ones, which would corrupt the free-tier series
on `/revenue`. `paid-call` therefore stays the GitHub heartbeat's job, and
`src/status.js` sizes that component's staleness against *its* observer.

## Deploy

```sh
cd workers/status-probe
wrangler secret put OPERATOR_TOKEN   # same value as AGENT402_OPERATOR_TOKEN on Railway
wrangler deploy
```

Verify it end to end (should return `"recorded": true`):

```sh
curl -s -X POST https://agent402-status-probe.<your-subdomain>.workers.dev/run \
  -H "X-Operator-Token: $AGENT402_OPERATOR_TOKEN" | jq
```

Then confirm the observation landed with a `cloudflare-cron` source:

```sh
curl -s https://agent402.tools/api/status | jq '.overall, .measurement'
```

## Rotating the token

`OPERATOR_TOKEN` here and `AGENT402_OPERATOR_TOKEN` on Railway are the same
secret. Rotate Railway first, then `wrangler secret put OPERATOR_TOKEN`. Between
those two steps this Worker's observations are rejected and `/status` shows a
gap rather than wrong data, which is the intended failure direction.

## Kicking the GitHub heartbeat

`heartbeat.yml` carries **eighteen alarm checks** - every wallet balance, Postgres
reachability, settlement freshness, the PayAI and CDP quota watches - and is the
only observer for them. GitHub does not deliver its schedule: measured
2026-08-30, `*/15` produced gaps of **2-12 hours**, and moving to a gentler
`9,39` produced **one run in 9.8 hours**. Tuning the cron is a dead end; GitHub
throttles scheduled events on a busy repo whatever you ask for.

This Worker's 5-minute cron *is* honoured, so it dispatches the workflow when
GitHub has not run it lately.

Bounded and idempotent:

- reads the last run first, and only dispatches past `HEARTBEAT_MAX_AGE_MIN`
  (default 20)
- a run that is queued or in progress counts as recent, so a slow run is never
  piled onto
- no token, no kicking - an env-gated no-op, and it says so in the log

### Setup

```
wrangler secret put GITHUB_DISPATCH_TOKEN
```

Use a **fine-grained PAT scoped to this repository only**, with
`Repository permissions -> Actions: Read and write` and nothing else. It cannot
read code, secrets, or any other repository. Verify with:

```
curl -s -X POST https://<worker>/run -H "X-Operator-Token: $AGENT402_OPERATOR_TOKEN" | jq .heartbeat
```
