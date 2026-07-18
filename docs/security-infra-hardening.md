# Infra hardening — review + verification (audit A402-01/02/05/06)

This document accompanies the infra-hardening PR. The findings here change the
deployment shape (container user, base image, CI supply chain) and **cannot be
fully verified from the code sandbox** — they need a Railway build and hands-on
checks. Treat the PR as review-only until the checklist below passes on a
preview environment.

## What this PR changes (in-repo, reviewable)

| Finding | Change | Risk | Verifiable in CI? |
|---|---|---|---|
| A402-05 | Pin the floating `@x402/*` + `viem` + `@solana/kit` installs in secret-bearing CI jobs to exact versions | Low | Yes — CI runs the pinned installs |
| mutable-artifacts | Pin the base image by digest | Low | No (built by Railway) |
| A402-06 | Record `ffmpeg -version` + MagicYUV presence into the image; add `scripts/check-ffmpeg-cve.sh` | Low | No |
| A402-01 | Run the app as the non-root `node` user (UID 1000) via a root entrypoint that chowns `/data` then drops privileges with `gosu` | **Medium** | No |

### Live finding (2026-07-18) — why a `USER node` Dockerfile would have broken prod

Verified against the live Railway deployment: the persistent volume
`agent402-volume` mounts at **`/data` owned by `root:root`** and holds the
memory/stats SQLite (~1 GB). Railway mounts volumes as root at RUNTIME, and a
build-time `RUN chown` cannot touch a volume that does not exist at build. So a
plain Dockerfile `USER node` container could **not** write `/data`, and the
memory boot-fail-loud check would fire on the next deploy — taking down a *paid*
tool. The fix is `docker-entrypoint.sh`: it runs as root only long enough to
`chown /data` to `node`, then `exec gosu node …` so the server itself is
non-root. (Railway ref: volumes are root-owned; use an entrypoint to fix
permissions for non-root images.)

## What this PR deliberately does NOT do

- **It does not remove `--no-sandbox`.** Chromium's own sandbox needs a user
  namespace / seccomp profile the container doesn't currently provide; dropping
  the flag without that makes Chromium fail to launch, 503-ing every browser
  tool. Non-root (above) already removes the "renderer escape == root" impact
  that made A402-01 High. Removing `--no-sandbox` is a follow-up gated on the
  platform change below.
- **It does not isolate the browser/media workers.** They still share the
  container (and its payment/DB/operator env). Full A402-01/02/06 isolation is
  the worker-service design below — a larger change staged separately so it can
  be reviewed and rolled back on its own.

## Verification checklist (run on a Railway preview before merging)

1. **Build succeeds** with the pinned digest base and the non-root user.
2. **Container runs as non-root:** `id` inside the container shows `uid=1000(node)`.
3. **/data is writable by UID 1000:** the server boots without the memory/stats
   "cannot write /data" fatal (it fails loud if not — that is the safety net).
   If it fails, set the Railway volume's mount permissions for UID 1000.
4. **Chromium still launches:** `POST /api/render {"url":"https://example.com"}`
   returns markdown; `GET /api/screenshot?url=https://example.com` returns a PNG.
5. **ffmpeg still works:** an audio-convert/normalize call succeeds.
6. **Memory + stats persist** across a restart (the /data volume is writable).
7. **CVE check:** run `bash scripts/check-ffmpeg-cve.sh` in the container; record
   the version and MagicYUV status in the PR.
8. **Full paid-path canary** green after the preview looks healthy.

Only after all pass: land it on the deploy path (a `[deploy]`-marked commit).

## Rollback

The change is a single Dockerfile. If the preview fails any check, revert the
Dockerfile to the previous root/unpinned version (git revert this PR's Dockerfile
commit) and redeploy — no data migration is involved.

## Follow-ups that live OUTSIDE the repo (Railway / platform config)

These are the rest of A402-01/02/06 and can't be expressed in the Dockerfile:

- **Drop Linux capabilities** and add `no-new-privileges`, a restrictive seccomp
  profile, and a read-only root filesystem (with `/tmp` + `/data` as the only
  writable mounts). Configure on the Railway service.
- **Enable a user namespace / seccomp** for Chromium, then remove `--no-sandbox`
  in `src/tools/render.js` and confirm the sandbox initialises at runtime
  (`chrome://sandbox` / launch diagnostics). Verify with a controlled test.
- **Network egress policy:** deny the browser/media paths from reaching loopback,
  RFC1918, link-local, and the cloud metadata endpoint at the network layer, so
  the SSRF guard in `fetch-guard.js`/`render.js` is defence-in-depth, not the
  only control (A402-02).

## Recommended worker-isolation architecture (full A402-01/02/06)

The complete fix is to move caller-controlled Chromium and ffmpeg off the
API/secret-bearing container:

- **API process:** non-root; holds payment/DB/operator secrets; does NO direct
  untrusted browser or media parsing. Instead it calls the workers over an
  internal-only address.
- **Browser worker (separate service/container):** non-root; Chromium sandbox
  enabled; **no** payment/DB/operator/analytics secrets; no persistent app
  mounts; egress denied to private/metadata/control-plane ranges; short
  execution deadline (the bounded queue from A402-08 already lives in
  `render.js` and moves with it).
- **Media worker (separate service/container):** non-root; patched ffmpeg (or
  MagicYUV disabled); no secrets; no app mounts; minimal/no egress after the
  input is transferred; the STT/media duration + byte caps move with it.

A dedicated worker container or a job service satisfies the isolation
requirement — a full microservice rewrite is not required. The API↔worker call
should be a small, schema-validated HTTP contract over a private network, with
the worker returning only the rendered artifact (markdown / PNG / extracted
audio), never raw internal responses.
