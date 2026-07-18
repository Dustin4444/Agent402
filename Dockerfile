# SECURITY REVIEW / VERIFY-BEFORE-DEPLOY — infra hardening PR (audit A402-01/06
# + mutable-artifacts). Still needs a Railway PREVIEW build before the deploy
# path (the image isn't built in CI), but the /data volume behaviour this design
# hinges on was VERIFIED against the live Railway deployment on 2026-07-18:
# agent402-volume mounts at /data owned by root:root, so the non-root switch is
# done via a root entrypoint that chowns /data then drops to node (below), NOT a
# Dockerfile USER. See docs/security-infra-hardening.md for the full checklist.
#
# Base image pinned by DIGEST for reproducible builds and CVE traceability
# (audit: "mutable deployment artifacts"). node:22-slim as of 2026-07-18. Re-pin
# after a deliberate base bump with:
#   docker pull node:22-slim
#   docker inspect --format='{{index .RepoDigests 0}}' node:22-slim
FROM node:22-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3

WORKDIR /app
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json ./
# ffmpeg powers the audio tools (normalize/convert/info); gosu drops privileges
# at startup (see the entrypoint). Installed alongside Chromium's deps.
RUN npm ci --omit=dev && npx playwright install --with-deps chromium \
  && apt-get update && apt-get install -y --no-install-recommends ffmpeg gosu \
  && rm -rf /var/lib/apt/lists/* \
  # sanity-check gosu works (it silently no-ops on a broken install)
  && gosu node true \
  # A402-06 / CVE-2026-8461 (FFmpeg MagicYUV): record the exact ffmpeg build and
  # whether the vulnerable decoder is even present, so the live image is
  # auditable without guessing. scripts/check-ffmpeg-cve.sh reads this.
  && (ffmpeg -version | head -1 > /app/.ffmpeg-version || true) \
  && (ffmpeg -hide_banner -decoders 2>/dev/null | grep -i magicyuv >> /app/.ffmpeg-version || echo "magicyuv-decoder: absent" >> /app/.ffmpeg-version)

COPY src ./src
# scripts/demo-payment.js is served at /demo.js (the runnable buyer demo)
COPY scripts ./scripts
# wiki/ is the source of truth for /docs (server-rendered) and is CI-synced
# to the GitHub wiki. Must be in the image or /docs is empty.
COPY wiki ./wiki
# assets/fonts is embedded into the brand images at boot — a missing file is
# a boot crash, not a degraded render.
COPY assets ./assets

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# A402-01: run the server as the unprivileged `node` user, NOT root. A renderer
# or media-parser compromise then lands as UID 1000 — unable to touch root-owned
# files or escalate — instead of as root in the container.
#
# We do NOT use a Dockerfile `USER node`, on purpose: VERIFIED on the live
# Railway deployment (2026-07-18) that the persistent volume `agent402-volume`
# mounts at /data owned by root:root at RUNTIME, and it holds the memory/stats
# SQLite (~1GB). A `USER node` container could not write it and the memory
# boot-fail-loud would fire on deploy. Instead docker-entrypoint.sh runs as root
# JUST long enough to chown /data to node, then execs the server via gosu so the
# process itself is non-root. `exec` keeps node as PID 1 so it receives SIGTERM
# for the graceful drain.
#
# NOTE (--no-sandbox stays): src/tools/render.js still launches Chromium with
# --no-sandbox because this container has no user-namespace / seccomp profile
# for Chromium's own sandbox. Removing it REQUIRES enabling that at the platform
# level first (see docs/security-infra-hardening.md) — dropping it here blindly
# 503s every browser tool. Non-root already removes the "escape == root" impact.
#
# NOTE (full isolation is a follow-up): the browser and media parsers still
# share this container with the payment/DB/operator env. True A402-01/02/06
# isolation is a separate browser/media worker service with no secrets — see
# the design doc. This PR does not implement it.
ENTRYPOINT ["docker-entrypoint.sh"]
EXPOSE 3000
CMD ["node", "src/server.js"]
